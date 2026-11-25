import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Short-term conversation memory: `<workspace>/chat-history.jsonl`, one turn per line. The Chief of Staff reads the last
 * few turns before every reply, so it remembers what you said ten seconds ago (a correction, a follow-up, "no, the
 * other one"). The file is trimmed to the newest `KEEP_CHAT_TURNS` lines now and then; it is never a long-term store.
 */

export const CHAT_HISTORY_FILE = 'chat-history.jsonl';
/** Turns shown to the model before a reply. */
export const DEFAULT_CHAT_TURNS = 12;
/** Lines kept on disk. */
export const KEEP_CHAT_TURNS = 200;
const MAX_TURN_CHARS = 2000;

export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
  /** ISO time. */
  at: string;
  /** v18: Rufus spoke up on its own (a heads-up, a think-beat, the evening note), not in answer to the human. */
  proactive?: boolean;
}

export const chatHistoryFile = (dir: string): string => path.join(dir, CHAT_HISTORY_FILE);

function parseTurn(line: string): ChatTurn | undefined {
  try {
    const t = JSON.parse(line) as Partial<ChatTurn>;
    if ((t.role === 'user' || t.role === 'assistant') && typeof t.text === 'string' && typeof t.at === 'string') return { role: t.role, text: t.text, at: t.at, ...(t.proactive === true ? { proactive: true } : {}) };
  } catch {
    /* a broken line is skipped */
  }
  return undefined;
}

async function readLines(dir: string): Promise<string[]> {
  try {
    return (await fs.readFile(chatHistoryFile(dir), 'utf8')).split('\n').filter((l) => l.trim());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
}

/** The newest `limit` turns, oldest first. */
export async function loadChatHistory(dir: string, limit = DEFAULT_CHAT_TURNS): Promise<ChatTurn[]> {
  if (limit <= 0) return [];
  return (await readLines(dir))
    .slice(-limit * 2)
    .map(parseTurn)
    .filter((t): t is ChatTurn => !!t)
    .slice(-limit);
}

/** Appends turns (blank ones are skipped) and trims the file once it grows well past `KEEP_CHAT_TURNS`. */
export async function appendChatTurns(dir: string, turns: ChatTurn[]): Promise<void> {
  const clean = turns.filter((t) => t.text.trim()).map((t) => ({ role: t.role, text: t.text.trim().slice(0, MAX_TURN_CHARS), at: t.at, ...(t.proactive ? { proactive: true } : {}) }));
  if (!clean.length) return;
  await fs.mkdir(dir, { recursive: true });
  await fs.appendFile(chatHistoryFile(dir), clean.map((t) => JSON.stringify(t)).join('\n') + '\n', 'utf8');
  const lines = await readLines(dir);
  if (lines.length > KEEP_CHAT_TURNS * 1.5) await fs.writeFile(chatHistoryFile(dir), lines.slice(-KEEP_CHAT_TURNS).join('\n') + '\n', 'utf8');
}

/** "[08:01] You: ..." lines for a prompt. Times are local `HH:MM` (with the date when it is not today). */
export function formatChatHistory(turns: ChatTurn[], now: Date = new Date()): string {
  const p = (n: number): string => String(n).padStart(2, '0');
  const day = (d: Date): string => `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
  return turns
    .map((t) => {
      const d = new Date(t.at);
      const when = Number.isNaN(d.getTime()) ? '' : `${day(d) === day(now) ? '' : `${day(d)} `}${p(d.getHours())}:${p(d.getMinutes())}`;
      return `[${when}] ${t.role === 'user' ? 'Them' : 'You (Rufus)'}: ${t.text.replace(/\s+/g, ' ').slice(0, 400)}`;
    })
    .join('\n');
}
