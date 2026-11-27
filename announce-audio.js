const { existsSync } = require("node:fs");
const path = require("node:path");
const { OfflineTts } = require("sherpa-onnx-node");

const voicePath = path.join(__dirname, ".voice", "vits-piper-en_US-lessac-medium");
let voiceReady;
let queue = Promise.resolve();
let pending = 0;

function getVoice() {
  const model = path.join(voicePath, "en_US-lessac-medium.onnx");
  if (!existsSync(model)) throw new Error("Run npm run setup-voice to install the Piper model.");
  return voiceReady ??= OfflineTts.createAsync({
    model: {
      vits: { model, tokens: path.join(voicePath, "tokens.txt"), dataDir: path.join(voicePath, "espeak-ng-data") },
      numThreads: 1,
      provider: "cpu",
    },
    maxNumSentences: 2,
  });
}

function encodeWave({ samples, sampleRate }) {
  if (!samples?.length) throw new Error("Piper returned no speech samples.");
  const bytes = samples.length * 2;
  const wave = Buffer.alloc(44 + bytes);
  wave.write("RIFF", 0);
  wave.writeUInt32LE(wave.length - 8, 4);
  wave.write("WAVEfmt ", 8);
  wave.writeUInt32LE(16, 16);
  wave.writeUInt16LE(1, 20);
  wave.writeUInt16LE(1, 22);
  wave.writeUInt32LE(sampleRate, 24);
  wave.writeUInt32LE(sampleRate * 2, 28);
  wave.writeUInt16LE(2, 32);
  wave.writeUInt16LE(16, 34);
  wave.write("data", 36);
  wave.writeUInt32LE(bytes, 40);
  for (let index = 0; index < samples.length; index++) {
    const pcm = Math.round(Math.max(-1, Math.min(1, samples[index])) * 32767);
    wave.writeInt16LE(pcm, 44 + index * 2);
  }
  return wave;
}

function renderAnnouncement(text) {
  if (pending >= 8) return Promise.reject(new Error("The announcer is busy."));
  pending += 1;
  const request = queue.then(async () => {
    const plainText = text.replace(/[<>&\[\]\x00-\x1f]/g, " ").slice(0, 240);
    const voice = await getVoice();
    return encodeWave(await voice.generateAsync({ text: plainText, sid: 0, speed: 1.04 }));
  }).finally(() => { pending -= 1; });
  queue = request.catch(() => {});
  return request;
}

module.exports = { renderAnnouncement };
