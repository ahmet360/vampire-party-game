const sampleRate = 22050;
let voiceReady;

async function renderAnnouncement(text) {
  voiceReady ??= import("@echogarden/espeak-ng-emscripten").then(async ({ default: createModule }) => {
    const module = await createModule();
    const voice = new module.eSpeakNGWorker();
    voice.set_voice("en-us");
    return voice;
  });

  const voice = await voiceReady;
  const chunks = [];
  const plainText = text.replace(/[<>&\[\]\x00-\x1f]/g, " ").slice(0, 240);
  voice.synthesize(plainText, (samples) => {
    if (!samples?.byteLength) return;
    const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
    chunks.push(Buffer.from(bytes));
  });

  const pcm = Buffer.concat(chunks);
  if (pcm.length === 0) throw new Error("Announcement did not produce audio.");
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(pcm.length + 36, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

module.exports = { renderAnnouncement };
