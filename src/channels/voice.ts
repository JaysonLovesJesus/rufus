import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { TtsCommandConfig, VoiceConfig, VoiceReplyMode } from '../types';

export type { TtsCommandConfig, VoiceConfig, VoiceReplyMode } from '../types';

/**
 * v20: local text-to-speech, $0. Rufus runs a command you choose (piper, macOS `say`, espeak, anything) and reads the
 * audio back. No shell, no network, no keys. The text is first rewritten for the ear (`toSpeakableText`).
 */

/** Spoken audio, ready to send or play. */
export interface SpeechAudio {
  audio: Buffer;
  mimeType: string;
  /** File extension without the dot (`ogg`, `wav`, `mp3`). */
  ext: string;
}

/** Turns text into audio. `synthesizeSpeech` bound to a config, or a fake in tests. */
export type Synthesizer = (text: string) => Promise<SpeechAudio>;

export const DEFAULT_TTS_TIMEOUT_MS = 60_000;
export const DEFAULT_TTS_MAX_CHARS = 1200;
/** Audio bigger than this is refused (a runaway command, not a reply). */
const MAX_AUDIO_BYTES = 20 * 1024 * 1024;

const FORMATS: Record<'ogg' | 'wav' | 'mp3', string> = { ogg: 'audio/ogg', wav: 'audio/wav', mp3: 'audio/mpeg' };

/** `ogg` -> `audio/ogg`. */
export function speechMimeType(format: 'ogg' | 'wav' | 'mp3' = 'ogg'): string {
  return FORMATS[format] ?? 'audio/ogg';
}

/** A short readable name for a URL when spoken: `https://www.example.com/a/b?c` -> `example.com`. */
function spokenHost(url: string): string {
  try {
    return new URL(url.startsWith('www.') ? `https://${url}` : url).hostname.replace(/^www\./, '');
  } catch {
    return 'a link';
  }
}

/**
 * Rewrites chat text for the ear: no markdown symbols, code blocks, raw URLs, bullet glyphs or `---` bubble breaks;
 * whitespace collapsed; cut at a sentence when longer than `maxChars`. What is left reads like something a person says.
 */
export function toSpeakableText(text: string, maxChars = DEFAULT_TTS_MAX_CHARS): string {
  let t = String(text ?? '');
  t = t.replace(/```[\s\S]*?(```|$)/g, ' (code in the chat) ');
  t = t.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1'); // images: the alt text
  t = t.replace(/\[([^\]]+)\]\((?:[^)]*)\)/g, '$1'); // [label](url): the label
  t = t.replace(/<(https?:\/\/[^>\s]+)>/g, '$1');
  t = t.replace(/\b(?:https?:\/\/|www\.)[^\s<>()]+[^\s<>().,!?;:'"]/gi, (u) => `a link on ${spokenHost(u)}`);
  t = t.replace(/`([^`]*)`/g, '$1');
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, ''); // headings
  t = t.replace(/^\s*>\s?/gm, ''); // quotes
  t = t.replace(/^\s*(?:[-*+•▪◦]|\d+[.)])\s+/gm, ''); // list bullets and numbers
  t = t.replace(/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/gm, '\n'); // rules and bubble breaks
  t = t.replace(/\|/g, ', '); // table cells
  t = t.replace(/(\*\*|__)(.+?)\1/g, '$2').replace(/(\*|_)(\S(?:.*?\S)?)\1/g, '$2').replace(/~~(.+?)~~/g, '$1');
  t = t.replace(/[*_~#]+/g, ' ');
  t = t.replace(/\s*\n+\s*/g, (m) => (/\n\s*\n/.test(m) ? '. ' : ' '));
  t = t.replace(/\s+/g, ' ').replace(/\s+([,.!?;:])/g, '$1').replace(/([.!?])\s*\.(?=\s|$)/g, '$1').replace(/,\s*,/g, ',');
  t = t.replace(/^[\s.,;:]+/, '').trim();
  if (t.length <= maxChars) return t;
  const window = t.slice(0, maxChars);
  const cut = Math.max(window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '));
  return cut > maxChars / 3 ? window.slice(0, cut + 1) : `${window.slice(0, window.lastIndexOf(' ') > 0 ? window.lastIndexOf(' ') : maxChars).trimEnd()}…`;
}

/** Fills `{text}` and `{out}` in each arg (also inside a longer arg like `--out={out}`). */
export function ttsArgs(args: string[], text: string, outFile: string): string[] {
  return args.map((a) => a.split('{text}').join(text).split('{out}').join(outFile));
}

/**
 * Speaks `text` with a local command and returns the audio. Throws a short, readable error when the command is
 * missing, fails, times out, or produces nothing. The text is cleaned with `toSpeakableText` first.
 */
export async function synthesizeSpeech(text: string, config: TtsCommandConfig): Promise<SpeechAudio> {
  if (!config?.command?.trim()) throw new Error('TTS is not configured (voice.tts.command).');
  const spoken = toSpeakableText(text, config.maxChars ?? DEFAULT_TTS_MAX_CHARS);
  if (!spoken) throw new Error('nothing to say');
  const format = config.outputFormat ?? 'ogg';
  const args = config.args ?? [];
  const usesText = args.some((a) => a.includes('{text}'));
  const usesOut = args.some((a) => a.includes('{out}'));
  const dir = await mkdtemp(path.join(os.tmpdir(), 'rufus-tts-'));
  const out = path.join(dir, `speech.${format}`);
  try {
    // As an argument, text must never read as an option ("--rate 900"): leading dashes are dropped.
    const asArg = spoken.replace(/^[-\s]+/, '') || spoken;
    const stdout = await run(config.command, ttsArgs(args, asArg, out), usesText ? undefined : spoken, config.timeoutMs ?? DEFAULT_TTS_TIMEOUT_MS);
    const audio = usesOut ? await readFile(out).catch(() => Buffer.alloc(0)) : stdout;
    if (!audio.length) throw new Error(usesOut ? 'the command wrote no audio to {out}' : 'the command printed no audio');
    return { audio, mimeType: speechMimeType(format), ext: format };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** A Synthesizer for a config (or the function itself, for tests). */
export function commandSynthesizer(tts: TtsCommandConfig | Synthesizer): Synthesizer {
  return typeof tts === 'function' ? tts : (text) => synthesizeSpeech(text, tts);
}

/** The reply mode in effect: the configured one, else `match` when TTS is set, else `never`. */
export function resolveVoiceReplyMode(voice?: Pick<VoiceConfig, 'replyMode'> & { tts?: unknown }): VoiceReplyMode {
  if (!voice?.tts) return 'never';
  return voice.replyMode === 'never' || voice.replyMode === 'always' || voice.replyMode === 'match' ? voice.replyMode : 'match';
}

/** Should this chat reply be spoken? */
export function shouldSpeakReply(mode: VoiceReplyMode, cameAsVoice: boolean): boolean {
  return mode === 'always' || (mode === 'match' && cameAsVoice);
}

function run(command: string, args: string[], stdin: string | undefined, timeoutMs: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    } catch (err) {
      return reject(new Error(`TTS command could not start: ${err instanceof Error ? err.message : String(err)}`));
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve(Buffer.concat(chunks));
    };
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      finish(new Error(`TTS timed out after ${Math.round(timeoutMs / 1000)}s`));
    }, timeoutMs);
    child.stdout.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_AUDIO_BYTES) {
        child.kill('SIGKILL');
        finish(new Error('TTS produced too much audio'));
      } else chunks.push(c);
    });
    child.stderr.on('data', (c: Buffer) => {
      if (stderr.length < 4000) stderr += c.toString('utf8');
    });
    child.on('error', (err: NodeJS.ErrnoException) => finish(new Error(err.code === 'ENOENT' ? `TTS command not found: ${command}` : `TTS failed: ${err.message}`)));
    child.on('close', (code) => {
      if (code === 0) return finish();
      const detail = stderr.trim().split('\n').pop() || 'failed';
      finish(new Error(`TTS exit ${code ?? '?'}: ${detail.slice(0, 200)}`));
    });
    child.stdin.on('error', () => undefined); // a command that ignores stdin closes it early: not an error
    child.stdin.end(stdin ?? '');
  });
}
