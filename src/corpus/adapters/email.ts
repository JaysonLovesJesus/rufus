// Email adapter: `.mbox` archives, `.eml` messages (or a folder of them), and normalized JSONL / JSON
// `{ id, from, to, subject, snippet, date, isFromMe }`. Only a short snippet of each message is kept, never the full body.
import { promises as fs } from 'node:fs';
import { inputFiles } from '../fsutil';
import { cleanDomain, clip, limitNewest, parseJsonRecords, stableId, type CollectOptions, type CorpusItem, type SourceAdapter } from '../types';

export interface EmailOptions extends CollectOptions {
  /** Your own addresses. Lets `.mbox` / `.eml` messages be marked sent vs. received (normalized JSONL carries `isFromMe`). */
  me?: string[];
}

export interface Address {
  name?: string;
  address: string;
}

const SNIPPET = 240;

/** `Sam Rivera <sam@example.org>`, `"Rivera, Sam" <sam@example.org>` or `sam@example.org` -> parts. */
export function parseAddress(raw: string): Address | undefined {
  const s = raw.trim();
  const angle = /^(.*?)<([^<>@\s]+@[^<>\s]+)>\s*$/.exec(s);
  if (angle) {
    const name = angle[1]!.trim().replace(/^"|"$/g, '').trim();
    return { ...(name ? { name } : {}), address: angle[2]!.trim().toLowerCase() };
  }
  const bare = /([^\s<>"',;]+@[^\s<>"',;]+)/.exec(s);
  return bare ? { address: bare[1]!.toLowerCase() } : undefined;
}

/** A comma-separated address list, splitting only on commas outside quotes and angle brackets. */
export function parseAddressList(raw: string): Address[] {
  const out: string[] = [];
  let cur = '';
  let quote = false;
  let angle = false;
  for (const c of raw) {
    if (c === '"') quote = !quote;
    else if (!quote && c === '<') angle = true;
    else if (!quote && c === '>') angle = false;
    if (c === ',' && !quote && !angle) {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out.flatMap((a) => parseAddress(a) ?? []);
}

const label = (a: Address): string => a.name ?? a.address;
const domainOf = (a: Address | undefined): string | undefined => cleanDomain(a?.address.split('@')[1]);

// ---------- MIME ----------

function decodeBytes(bytes: Buffer, charset?: string): string {
  try {
    return new TextDecoder(charset?.trim().replace(/^"|"$/g, '') || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** RFC 2047 encoded words in a header (`=?UTF-8?B?...?=`, `=?utf-8?Q?...?=`). */
export function decodeMimeWords(v: string): string {
  return v
    .replace(/(\?=)\s+(=\?)/g, '$1$2')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_m, cs: string, enc: string, data: string) => {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(data, 'base64') : decodeQuoted(data.replace(/_/g, ' '));
      return decodeBytes(bytes, cs);
    });
}

function decodeQuoted(s: string): Buffer {
  const soft = s.replace(/=\r?\n/g, '');
  const bytes: number[] = [];
  for (let i = 0; i < soft.length; i++) {
    const hex = soft[i] === '=' ? soft.slice(i + 1, i + 3) : '';
    if (/^[0-9a-fA-F]{2}$/.test(hex)) {
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else bytes.push(...Buffer.from(soft[i]!, 'utf8'));
  }
  return Buffer.from(bytes);
}

interface Headers {
  get(name: string): string | undefined;
}

function splitMessage(raw: string): { headers: Headers; body: string } {
  const m = /\r?\n\r?\n/.exec(raw);
  const head = m ? raw.slice(0, m.index) : raw;
  const body = m ? raw.slice(m.index + m[0].length) : '';
  const map = new Map<string, string>();
  for (const line of head.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const i = line.indexOf(':');
    if (i < 1) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    if (!map.has(k)) map.set(k, line.slice(i + 1).trim());
  }
  return { headers: { get: (n) => map.get(n.toLowerCase()) }, body };
}

const param = (header: string | undefined, name: string): string | undefined => new RegExp(`${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, 'i').exec(header ?? '')?.slice(1, 3).find(Boolean);

/** The readable text of a message body: first `text/plain` part, else tag-stripped `text/html`. */
export function bodyText(headers: Headers, body: string): string {
  const type = (headers.get('content-type') ?? 'text/plain').toLowerCase();
  if (type.startsWith('multipart/')) {
    const boundary = param(headers.get('content-type'), 'boundary');
    if (!boundary) return '';
    const parts = body.split(new RegExp(`^--${boundary.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:--)?[ \\t]*$`, 'm')).slice(1);
    const texts = parts.map((p) => {
      const sub = splitMessage(p.replace(/^\r?\n/, ''));
      return { type: (sub.headers.get('content-type') ?? 'text/plain').toLowerCase(), text: bodyText(sub.headers, sub.body) };
    });
    return texts.find((t) => t.type.startsWith('text/plain') && t.text)?.text ?? texts.find((t) => t.text)?.text ?? '';
  }
  if (!type.startsWith('text/')) return '';
  const enc = (headers.get('content-transfer-encoding') ?? '').trim().toLowerCase();
  const bytes = enc === 'base64' ? Buffer.from(body.replace(/\s+/g, ''), 'base64') : enc === 'quoted-printable' ? decodeQuoted(body) : Buffer.from(body, 'utf8');
  const text = decodeBytes(bytes, param(headers.get('content-type'), 'charset'));
  return type.startsWith('text/html') ? text.replace(/<(style|script)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&') : text;
}

/** A short plain snippet: no quoted replies, no signature, no "On ... wrote:" line. */
export function snippetOf(text: string): string {
  const keep: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^--\s*$/.test(line)) break; // signature
    if (/^On .{5,120} wrote:\s*$/i.test(line) || /^-{2,}\s*(?:original|forwarded) message/i.test(line)) break;
    if (/^\s*>/.test(line)) continue;
    keep.push(line);
  }
  return clip(keep.join(' '), SNIPPET);
}

// ---------- Messages -> items ----------

interface Mail {
  externalId?: string;
  from?: Address;
  to: Address[];
  subject: string;
  snippet: string;
  at: number;
  isFromMe?: boolean;
}

export function mailToItem(m: Mail): CorpusItem {
  const counterpart = m.isFromMe ? m.to[0] : m.from;
  const domain = domainOf(counterpart);
  const kind = m.isFromMe === undefined ? 'message' : m.isFromMe ? 'sent' : 'received';
  const subject = m.subject || '(no subject)';
  return {
    id: stableId('email', m.externalId ?? [m.from?.address ?? '', String(m.at), subject].join('\u0000')),
    source: 'email',
    kind,
    title: clip(subject, 200),
    summary: clip(m.snippet || subject, 500),
    ...(counterpart ? { actor: label(counterpart) } : {}),
    ...(domain ? { domain } : {}),
    timestamp: new Date(m.at).toISOString(),
    tags: m.isFromMe === undefined ? [] : [kind],
    metadata: { ...(m.from ? { from: m.from.address } : {}), to: m.to.slice(0, 10).map((a) => a.address), ...(m.isFromMe !== undefined ? { isFromMe: m.isFromMe } : {}) },
  };
}

function mailFromRfc822(raw: string, me: Set<string>): Mail | undefined {
  const { headers, body } = splitMessage(raw);
  const at = Date.parse(headers.get('date') ?? '');
  if (!Number.isFinite(at)) return undefined;
  const from = parseAddress(decodeMimeWords(headers.get('from') ?? ''));
  const to = parseAddressList(decodeMimeWords(headers.get('to') ?? ''));
  const id = headers.get('message-id')?.replace(/^<|>$/g, '').trim();
  return {
    ...(id ? { externalId: id } : {}),
    ...(from ? { from } : {}),
    to,
    subject: decodeMimeWords(headers.get('subject') ?? '').trim(),
    snippet: snippetOf(bodyText(headers, body)),
    at,
    ...(me.size && from ? { isFromMe: me.has(from.address) } : {}),
  };
}

/** Split an mbox archive into raw messages: a line starting `From ` after a blank line (or at the top) begins one. */
export function splitMbox(text: string): string[] {
  const lines = text.split(/\r?\n/);
  const msgs: string[][] = [];
  lines.forEach((line, i) => {
    if (line.startsWith('From ') && (i === 0 || lines[i - 1] === '')) msgs.push([]);
    else if (msgs.length) msgs.at(-1)!.push(line.replace(/^>(>*From )/, '$1'));
  });
  return msgs.map((m) => m.join('\n'));
}

function mailFromRecord(raw: unknown): Mail | undefined {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined;
  const r = raw as Record<string, unknown>;
  const addrs = (v: unknown): Address[] => (Array.isArray(v) ? v.flatMap((x) => (typeof x === 'string' ? parseAddressList(x) : [])) : typeof v === 'string' ? parseAddressList(v) : []);
  const at = Date.parse(String(r.date ?? r.sentAt ?? r.timestamp ?? ''));
  if (!Number.isFinite(at)) return undefined;
  const from = typeof r.from === 'string' ? parseAddress(r.from) : undefined;
  const subject = typeof r.subject === 'string' ? r.subject.trim() : '';
  const snippet = typeof r.snippet === 'string' ? snippetOf(r.snippet) : '';
  const id = typeof r.id === 'string' || typeof r.id === 'number' ? String(r.id) : undefined;
  return { ...(id ? { externalId: id } : {}), ...(from ? { from } : {}), to: addrs(r.to), subject, snippet, at, ...(typeof r.isFromMe === 'boolean' ? { isFromMe: r.isFromMe } : {}) };
}

export const emailAdapter: SourceAdapter<EmailOptions> = {
  id: 'email',
  source: 'email',
  async collect(options: EmailOptions): Promise<CorpusItem[]> {
    const me = new Set((options.me ?? []).map((a) => a.trim().toLowerCase()).filter(Boolean));
    const mails: Mail[] = [];
    for (const file of await inputFiles(options.path, ['.mbox', '.mbx', '.eml', '.jsonl', '.json'])) {
      const text = await fs.readFile(file, 'utf8');
      const lower = file.toLowerCase();
      if (lower.endsWith('.json') || lower.endsWith('.jsonl') || /^\s*[[{]/.test(text)) mails.push(...parseJsonRecords(text).records.flatMap((r) => mailFromRecord(r) ?? []));
      else if (lower.endsWith('.eml')) mails.push(...[mailFromRfc822(text, me)].flatMap((m) => m ?? []));
      else mails.push(...splitMbox(text).flatMap((m) => mailFromRfc822(m, me) ?? []));
    }
    return limitNewest(mails.map(mailToItem), options.limit);
  },
};
