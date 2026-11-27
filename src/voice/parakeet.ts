import { execFile } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { TranscribeModel } from 'transcribe-cpp';

const execFileAsync = promisify(execFile);

/** Finds an already-downloaded local Parakeet GGUF model (env override, ~/.rufus-v2/models, or ~/.t3/userdata/speech/models). */
export function findParakeetModel(home = os.homedir()): string | undefined {
  const env = process.env.RUFUS_PARAKEET_MODEL || process.env.RUFUS_STT_MODEL;
  if (env && existsSync(env)) return env;
  const dirs = [
    path.join(home, '.rufus-v2', 'models'),
    path.join(home, '.t3', 'userdata', 'speech', 'models'),
  ];
  for (const dir of dirs) {
    if (!existsSync(dir)) continue;
    const match = readdirSync(dir)
      .filter((f) => /^parakeet.*\.gguf$/i.test(f))
      .sort()[0];
    if (match) return path.join(dir, match);
  }
  return undefined;
}

/** Decodes any audio file (.ogg, .m4a, .webm, .wav, .mp3) to 16 kHz mono Float32 PCM using ffmpeg. */
export async function decodeToFloat32Pcm(audioPath: string, ffmpegPath = process.env.RUFUS_FFMPEG || 'ffmpeg'): Promise<Float32Array> {
  const bin = existsSync('/opt/homebrew/bin/ffmpeg') && ffmpegPath === 'ffmpeg' ? '/opt/homebrew/bin/ffmpeg' : ffmpegPath;
  const { stdout } = await execFileAsync(
    bin,
    ['-nostdin', '-hide_banner', '-loglevel', 'error', '-i', audioPath, '-ar', '16000', '-ac', '1', '-f', 'f32le', '-acodec', 'pcm_f32le', 'pipe:1'],
    { encoding: 'buffer', maxBuffer: 64 * 1024 * 1024, timeout: 60_000 },
  );
  const aligned = new Uint8Array(stdout.byteLength);
  aligned.set(stdout);
  return new Float32Array(aligned.buffer, aligned.byteOffset, Math.floor(aligned.byteLength / 4));
}

/** Chunk size (45s at 16 kHz) so long voice memos transcribe cleanly without overflowing Parakeet's encoder window. */
const CHUNK_SAMPLES = 45 * 16_000;

/** Transcribes one audio file locally with Parakeet via transcribe.cpp (Metal on Apple Silicon), auto-chunking long audio. */
export async function transcribeWithParakeet(audioPath: string, modelPath = findParakeetModel()): Promise<{ text: string; durationMs: number; modelPath: string }> {
  if (!modelPath) throw new Error('No local Parakeet .gguf model found (set RUFUS_PARAKEET_MODEL or download to ~/.t3/userdata/speech/models/)');
  const started = Date.now();
  const pcm = await decodeToFloat32Pcm(audioPath);
  if (!pcm.length) return { text: '', durationMs: Date.now() - started, modelPath };
  const model = await TranscribeModel.load(modelPath);
  try {
    const parts: string[] = [];
    for (let offset = 0; offset < pcm.length; offset += CHUNK_SAMPLES) {
      const slice = offset === 0 && pcm.length <= CHUNK_SAMPLES ? pcm : pcm.subarray(offset, Math.min(pcm.length, offset + CHUNK_SAMPLES));
      const res = await model.transcribe(slice);
      const chunk = (res.text ?? '').replace(/\s+/g, ' ').trim();
      if (chunk) parts.push(chunk);
    }
    const text = parts.join(' ').replace(/\s+/g, ' ').trim();
    return { text, durationMs: Date.now() - started, modelPath };
  } finally {
    model.dispose();
  }
}

// CLI entrypoint: `tsx src/voice/parakeet.ts <audio-file>` prints plain transcript to stdout.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const audioFile = process.argv[2];
  if (!audioFile) {
    console.error('Usage: parakeet.ts <audio-file>');
    process.exit(2);
  }
  transcribeWithParakeet(audioFile)
    .then(({ text }) => {
      process.stdout.write(`${text}\n`);
    })
    .catch((err: unknown) => {
      console.error(`parakeet transcribe failed: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    });
}
