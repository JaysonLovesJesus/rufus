import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { promisify } from 'node:util';
import type { SynthesizeResult } from './kokoro';

const execFileAsync = promisify(execFile);

export interface VoiceNote {
  ok: boolean;
  /** An OGG/Opus file, the format Telegram plays as a voice note. The caller removes it once sent. */
  path?: string;
  seconds?: number;
  error?: string;
}

/** Light markdown reads badly aloud: emphasis marks, code ticks and link syntax go; the words stay. */
export function speakable(text: string): string {
  return text
    .replace(/\[([^\]]+)\]\((?:[^)]+)\)/g, '$1')
    .replace(/[*_`#>]+/g, '')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

/**
 * Speaks `text` with the local Kokoro voice and converts it to OGG/Opus for a Telegram voice note.
 * `convert` is ffmpeg by default (wav in, mono 32 kbps Opus out).
 */
export async function makeVoiceNote(
  tts: { synthesize(text: string): Promise<SynthesizeResult> },
  text: string,
  opts: { convert?: (wav: string, ogg: string) => Promise<void> } = {},
): Promise<VoiceNote> {
  const spoken = speakable(text);
  if (!spoken) return { ok: false, error: 'nothing to say' };
  const clip = await tts.synthesize(spoken);
  if (!clip.ok || !clip.outPath) return { ok: false, error: clip.error ?? 'speech synthesis failed' };
  const ogg = clip.outPath.replace(/\.wav$/i, '') + '.ogg';
  const convert =
    opts.convert ??
    (async (wav: string, out: string) => {
      await execFileAsync('ffmpeg', ['-y', '-loglevel', 'error', '-i', wav, '-c:a', 'libopus', '-b:a', '32k', '-ac', '1', '-application', 'voip', out], { timeout: 60_000 });
    });
  try {
    await convert(clip.outPath, ogg);
    return { ok: true, path: ogg, ...(clip.audioSeconds !== undefined ? { seconds: clip.audioSeconds } : {}) };
  } catch (err) {
    await fs.rm(ogg, { force: true }).catch(() => undefined);
    return { ok: false, error: `could not convert to a voice note: ${(err as Error).message.slice(0, 200)}` };
  } finally {
    await fs.rm(clip.outPath, { force: true }).catch(() => undefined);
  }
}
