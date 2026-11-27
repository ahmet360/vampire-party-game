const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const { execFileSync } = require("node:child_process");
const { existsSync } = require("node:fs");
const { mkdir, readFile, unlink, writeFile } = require("node:fs/promises");
const path = require("node:path");

const model = "vits-piper-en_US-lessac-medium";
const checksum = "9e3febfacf0abf4270172d2958bcec246032b7e88efc2720840cc80c93de334e";
const archiveUrl = `https://github.com/k2-fsa/sherpa-onnx/releases/download/tts-models/${model}.tar.bz2`;
const directory = path.join(__dirname, "..", ".voice");
const localArchive = process.argv[2] && path.resolve(process.argv[2]);

async function setup() {
  if (existsSync(path.join(directory, model, "en_US-lessac-medium.onnx"))) return;
  await mkdir(directory, { recursive: true });
  const archive = localArchive || path.join(directory, "lessac-voice.tar.bz2");
  if (!localArchive) {
    const response = await fetch(archiveUrl, { signal: AbortSignal.timeout(90000) });
    if (!response.ok) throw new Error(`Piper model download failed (${response.status})`);
    await writeFile(archive, Buffer.from(await response.arrayBuffer()));
  }
  assert.equal(createHash("sha256").update(await readFile(archive)).digest("hex"), checksum, "Piper model archive checksum changed");
  execFileSync("tar", ["-xf", archive, "-C", directory], { stdio: "inherit" });
  if (!localArchive) await unlink(archive);
  console.log("Piper Lessac voice is ready.");
}

setup().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
