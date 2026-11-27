import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { ModelProvider } from '../types';

const execFileAsync = promisify(execFile);

/**
 * Turns media in messages into text events: voice notes through the same local speech-to-text the Telegram channel uses,
 * images through a model that can see. Each reader is optional; without one the event keeps its plain `[voice note]` tag.
 */
export interface MediaReader {
  transcribe?(file: string): Promise<string>;
  describe?(file: string, mimeType: string): Promise<string>;
}

/** The local transcriber command (`{file}` in its args is replaced by the audio path), e.g. whisper-cli behind a script. */
export function commandTranscriber(cmd: { command: string; args: string[] }, timeoutMs = 120_000): (file: string) => Promise<string> {
  return async (file) => {
    const args = cmd.args.map((a) => a.replace(/\{file\}/g, file));
    const { stdout } = await execFileAsync(cmd.command, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 });
    return stdout.trim();
  };
}

export const IMAGE_SYSTEM = [
  "You describe an image someone sent in a chat, for the owner's personal assistant who cannot see it.",
  'In one or two plain sentences say what it shows. Copy any readable text that matters (names, dates, prices, addresses, codes) exactly.',
  'No preamble, no guessing about feelings.',
].join('\n');

/** Images larger than this on their longest side are scaled down first: enough to read text, cheap to send. */
const MAX_SIDE = 1280;

/** Scales an image down with macOS `sips` into a temp JPEG; returns the original when it cannot. */
async function shrink(file: string, dir: string): Promise<{ file: string; mimeType: string } | undefined> {
  const out = path.join(dir, 'image.jpg');
  try {
    await execFileAsync('sips', ['-s', 'format', 'jpeg', '-Z', String(MAX_SIDE), file, '--out', out], { timeout: 30_000 });
    return { file: out, mimeType: 'image/jpeg' };
  } catch {
    return undefined;
  }
}

/** Describes an image through a provider that accepts images (the Claude CLI provider does). */
export function imageDescriber(provider: ModelProvider, model?: string): (file: string, mimeType: string) => Promise<string> {
  return async (file, mimeType) => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rufus-img-'));
    try {
      const small = await shrink(file, dir);
      const use = small ?? { file, mimeType };
      if (!/^image\/(jpeg|png|gif|webp)$/.test(use.mimeType)) throw new Error(`cannot send ${use.mimeType}`);
      const data = (await fs.readFile(use.file)).toString('base64');
      const text = await provider.complete({ system: IMAGE_SYSTEM, prompt: 'Describe this image.', images: [{ mediaType: use.mimeType, data }], ...(model ? { model } : {}) });
      return text.replace(/\s+/g, ' ').trim();
    } finally {
      await fs.rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  };
}

export interface BeeperAttachment {
  id?: string;
  type?: string;
  mimeType?: string;
  fileName?: string;
  srcURL?: string;
  isVoiceNote?: boolean;
  isSticker?: boolean;
  isGif?: boolean;
}

/**
 * A local file for a Beeper attachment: `file://` URLs are already on disk; `mxc://` ones are fetched by Beeper Desktop
 * (`POST /v1/assets/download`), which answers with a local `file://` URL.
 */
export async function beeperAssetFile(att: BeeperAttachment, download: (mxc: string) => Promise<string | undefined>): Promise<string | undefined> {
  let url = att.srcURL ?? att.id;
  if (!url) return undefined;
  if (url.startsWith('mxc://')) url = (await download(url)) ?? '';
  if (!url.startsWith('file://')) return undefined;
  const file = fileURLToPath(url);
  return (await fs.stat(file).then((s) => s.isFile()).catch(() => false)) ? file : undefined;
}

/** What one message's media says, as text to put in the event (empty when there is nothing to read or no reader). */
export async function readMedia(
  messageType: string | undefined,
  attachments: readonly BeeperAttachment[],
  reader: MediaReader | undefined,
  download: (mxc: string) => Promise<string | undefined>,
): Promise<{ text: string; failed: boolean }> {
  if (!reader || !attachments.length) return { text: '', failed: false };
  const parts: string[] = [];
  let failed = false;
  for (const att of attachments.slice(0, 4)) {
    const audio = att.isVoiceNote || att.type === 'audio' || /^audio\//.test(att.mimeType ?? '') || messageType === 'VOICE';
    const image = !att.isSticker && (att.type === 'img' || /^image\//.test(att.mimeType ?? '')) && messageType !== 'STICKER';
    if (!(audio && reader.transcribe) && !(image && reader.describe)) continue;
    try {
      const file = await beeperAssetFile(att, download);
      if (!file) throw new Error('attachment not on disk');
      if (audio) {
        const said = (await reader.transcribe!(file)).trim();
        parts.push(said ? `"${said}"` : '(no speech)');
      } else {
        const seen = (await reader.describe!(file, att.mimeType ?? 'image/jpeg')).trim();
        if (seen) parts.push(`(shows: ${seen})`);
      }
    } catch {
      failed = true;
    }
  }
  return { text: parts.join(' '), failed };
}
