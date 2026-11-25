import { execFile } from 'node:child_process';
import type { TranscribeCommand } from '../types';

/** Turns an audio file into text. Throws if nothing usable came back. */
export type Transcriber = (filePath: string) => Promise<string>;

const DEFAULT_TIMEOUT_MS = 120_000;

/** `"{file}"` in args becomes the audio path; without it the path is appended last. */
export function transcribeArgs(args: string[] = [], filePath: string): string[] {
  return args.includes('{file}') ? args.map((a) => (a === '{file}' ? filePath : a)) : [...args, filePath];
}

/** A Transcriber that runs a local command (no shell) and reads the transcript from its trimmed stdout. */
export function commandTranscriber(cmd: TranscribeCommand): Transcriber {
  return (filePath) =>
    new Promise((resolve, reject) => {
      execFile(
        cmd.command,
        transcribeArgs(cmd.args, filePath),
        { timeout: cmd.timeoutMs ?? DEFAULT_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
        (err, stdout, stderr) => {
          if (err) {
            const detail = (stderr || err.message).trim().split('\n').pop() || 'failed';
            reject(new Error(err.killed ? `timed out` : `exit ${err.code ?? '?'}: ${detail}`));
            return;
          }
          resolve(stdout.trim());
        },
      );
    });
}
