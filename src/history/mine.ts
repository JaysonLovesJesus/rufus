import type { Engine } from '../engine/engine';
import { runAiStep } from '../engine/ai';
import type { LessonLayer } from '../learning/layers';
import type { AiProvider, MineConfig, RufusConfig } from '../types';
import { loadPairs } from './seed';
import type { HistoryPair } from './types';

// ---------- Deterministic analysis (no AI, $0.00) ----------

export interface IntentBucket {
  id: string;
  label: string;
  /** Matched against the incoming message. First bucket that matches wins, so counts add up to the total. */
  pattern: RegExp;
}

/** Lightweight keyword buckets, first match wins. Pass your own `buckets` (or put them in `config.mine.buckets`). */
export const DEFAULT_BUCKETS: IntentBucket[] = [
  { id: 'confirmation', label: 'Confirmations', pattern: /\b(?:confirm(?:ed|ing|ation)?|still (?:on|good|works|happening)|does (?:that|this) work|rsvp|are you (?:coming|joining)|see you (?:there|then))\b/i },
  { id: 'follow-up', label: 'Follow-ups', pattern: /\b(?:following up|follow(?:ing)? up|checking in|check(?:ing)? in|any (?:update|news)|circling back|reminder|haven'?t heard|just wondering|bump(?:ing)?)\b/i },
  {
    id: 'scheduling',
    label: 'Scheduling',
    pattern: /\b(?:schedul\w*|reschedul\w*|meet(?:ing)?|call|calendar|available|availability|free (?:at|on|tomorrow|today|this)|what time|book(?:ing)?|appointment|slot|tomorrow|tonight|monday|tuesday|wednesday|thursday|friday|saturday|sunday|\d{1,2}(?::\d{2})?\s?(?:am|pm))\b/i,
  },
  { id: 'logistics', label: 'Logistics', pattern: /\b(?:address|directions?|parking|where|location|pick ?up|drop ?off|arriv\w*|eta|invoice|receipt|payment|pay|link|file|document|attach\w*|forward|send (?:me )?(?:the|a|over))\b/i },
  { id: 'question', label: 'Questions', pattern: /\?/ },
];

export const OTHER_BUCKET: Pick<IntentBucket, 'id' | 'label'> = { id: 'other', label: 'Everything else' };

/** Compile `config.mine.buckets` (string patterns) into buckets. */
export function bucketsFromConfig(cfg?: MineConfig): IntentBucket[] | undefined {
  if (!cfg?.buckets?.length) return undefined;
  return cfg.buckets.map((b) => {
    if (!b.id || !b.pattern) throw new Error('Each mine bucket needs an "id" and a "pattern".');
    try {
      return { id: b.id, label: b.label ?? b.id, pattern: new RegExp(b.pattern, 'i') };
    } catch {
      throw new Error(`Mine bucket "${b.id}" has an invalid pattern.`);
    }
  });
}

export function classify(pair: Pick<HistoryPair, 'incoming'>, buckets: IntentBucket[] = DEFAULT_BUCKETS): string {
  for (const b of buckets) if (new RegExp(b.pattern.source, b.pattern.flags.replace('g', '')).test(pair.incoming)) return b.id;
  return OTHER_BUCKET.id;
}

export interface Rate {
  count: number;
  /** 0-100, one decimal. */
  pct: number;
}

export interface VoiceFingerprint {
  replies: number;
  words: { median: number; p90: number; max: number };
  /** Replies under `SHORT_WORDS` words. */
  shortReplies: Rate;
  /** First letter is lowercase (of replies that contain a letter). */
  lowercaseStart: Rate;
  trailingPeriod: Rate;
  exclamation: Rate;
  question: Rate;
  emoji: Rate;
  emDashes: { total: number; repliesWith: Rate };
  greetings: { rate: Rate; top: Array<{ text: string; count: number }> };
  signOffs: { rate: Rate; top: Array<{ text: string; count: number }> };
  /** Minutes from incoming to reply, for pairs that carry both timestamps. */
  replyDelayMinutes?: { median: number; pairs: number };
}

export interface CandidateRule {
  id: string;
  /** Where it belongs: `code` = enforce in `verify`; `principle` = a short line in the prompt. */
  layer: LessonLayer;
  rule: string;
  /** Exact: `count` of `of` replies behave this way. */
  support: { count: number; of: number };
  evidence: string;
}

export interface PairSample {
  id: string;
  incoming: string;
  reply: string;
}

export interface IntentCluster {
  bucket: string;
  label: string;
  channel: string;
  count: number;
  /** Share of all pairs, 0-100, one decimal. */
  pct: number;
  medianReplyWords: number;
  samples: PairSample[];
}

export interface HistoryAnalysis {
  total: number;
  span?: { from: string; to: string };
  byChannel: Array<{ channel: string; count: number; pct: number }>;
  topContacts: Array<{ sender: string; count: number; channels: string[] }>;
  topThreads: Array<{ threadId: string; channel: string; count: number }>;
  voice: VoiceFingerprint;
  rules: CandidateRule[];
  intents: Array<{ bucket: string; label: string; count: number; pct: number }>;
  clusters: IntentCluster[];
  notes: string[];
}

export interface AnalyzeOptions {
  buckets?: IntentBucket[];
  /** Below this many pairs no rule is proposed (too little evidence). Default 10. */
  minPairs?: number;
  /** A rule needs at least this share of replies (0-1). Default 0.9. */
  minShare?: number;
  /** Samples kept per cluster. Default 3. */
  samplesPerCluster?: number;
  topN?: number;
}

export const SHORT_WORDS = 20;
const SNIPPET = 160;

const round1 = (n: number): number => Math.round(n * 10) / 10;
const words = (s: string): number => (s.trim() ? s.trim().split(/\s+/).length : 0);
const snippet = (s: string, max = SNIPPET): string => {
  const t = s.replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};
/** Nearest-rank percentile of a sorted list. */
const percentile = (sorted: number[], p: number): number => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]! : 0);
const median = (xs: number[]): number => {
  if (!xs.length) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const tally = <T>(items: T[], key: (t: T) => string): Map<string, number> => {
  const m = new Map<string, number>();
  for (const i of items) m.set(key(i), (m.get(key(i)) ?? 0) + 1);
  return m;
};
const top = (m: Map<string, number>, n: number): Array<[string, number]> => [...m.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, n);

const GREETING = /^\W*(hi+|hey+|hello|hiya|yo|howdy|good (?:morning|afternoon|evening)|morning|evening)\b/i;
const SIGN_OFF = /\b(thanks(?: again| so much| a lot)?|thank you(?: so much)?|cheers|best|best regards|regards|talk soon|see you(?: soon| then)?|take care|ttyl|appreciate it)\W*$/i;
const EMOJI = /\p{Extended_Pictographic}/u;

function voiceOf(pairs: HistoryPair[]): VoiceFingerprint {
  const replies = pairs.map((p) => p.reply.trim());
  const n = replies.length;
  const rate = (count: number): Rate => ({ count, pct: n ? round1((count / n) * 100) : 0 });
  const counts = replies.map(words).sort((a, b) => a - b);
  const withLetter = replies.filter((r) => /\p{L}/u.test(r));
  const lower = withLetter.filter((r) => {
    const first = /\p{L}/u.exec(r)![0];
    return first === first.toLowerCase() && first !== first.toUpperCase();
  }).length;
  const greetings = tally(replies.filter((r) => GREETING.test(r)), (r) => GREETING.exec(r)![1]!.toLowerCase());
  const signOffs = tally(replies.filter((r) => SIGN_OFF.test(r)), (r) => SIGN_OFF.exec(r)![1]!.toLowerCase());
  const delays = pairs
    .map((p) => (p.incomingAt && p.replyAt ? (Date.parse(p.replyAt) - Date.parse(p.incomingAt)) / 60000 : NaN))
    .filter((m) => Number.isFinite(m) && m >= 0);

  return {
    replies: n,
    words: { median: median(counts), p90: percentile(counts, 0.9), max: counts.at(-1) ?? 0 },
    shortReplies: rate(counts.filter((w) => w < SHORT_WORDS).length),
    lowercaseStart: { count: lower, pct: withLetter.length ? round1((lower / withLetter.length) * 100) : 0 },
    trailingPeriod: rate(replies.filter((r) => /\.$/.test(r) && !/\.\.$/.test(r)).length),
    exclamation: rate(replies.filter((r) => r.includes('!')).length),
    question: rate(replies.filter((r) => r.includes('?')).length),
    emoji: rate(replies.filter((r) => EMOJI.test(r)).length),
    emDashes: { total: replies.reduce((s, r) => s + (r.match(/—/g)?.length ?? 0), 0), repliesWith: rate(replies.filter((r) => r.includes('—')).length) },
    greetings: { rate: rate([...greetings.values()].reduce((a, b) => a + b, 0)), top: top(greetings, 3).map(([text, count]) => ({ text, count })) },
    signOffs: { rate: rate([...signOffs.values()].reduce((a, b) => a + b, 0)), top: top(signOffs, 3).map(([text, count]) => ({ text, count })) },
    ...(delays.length ? { replyDelayMinutes: { median: round1(median(delays)), pairs: delays.length } } : {}),
  };
}

/** Rules that are exactly true of at least `minShare` of the human's own replies. Pure arithmetic. */
function rulesFrom(pairs: HistoryPair[], v: VoiceFingerprint, minShare: number): CandidateRule[] {
  const n = v.replies;
  const replies = pairs.map((p) => p.reply.trim());
  const out: CandidateRule[] = [];
  const add = (id: string, layer: LessonLayer, rule: string, count: number, evidence: string): void => {
    if (count / n >= minShare) out.push({ id, layer, rule, support: { count, of: n }, evidence: `${count} of ${n} replies (${round1((count / n) * 100)}%): ${evidence}` });
  };

  add('short-replies', 'principle', `Keep replies short and direct (the median reply is ${v.words.median} words).`, v.shortReplies.count, `under ${SHORT_WORDS} words`);
  const cap = Math.ceil(Math.max(v.words.p90, 1) / 5) * 5;
  if (cap <= 100) {
    const within = replies.filter((r) => words(r) <= cap).length;
    add('word-cap', 'code', `Keep replies to at most ${cap} words.`, within, `at most ${cap} words`);
  }
  add('no-em-dash', 'code', 'Do not use em dashes.', n - v.emDashes.repliesWith.count, 'no em dash');
  add('no-trailing-period', 'code', 'Do not end a reply with a period.', n - v.trailingPeriod.count, 'no trailing period');
  add('no-exclamation', 'code', 'Do not use exclamation marks.', n - v.exclamation.count, 'no exclamation mark');
  add('no-emoji', 'code', 'Do not use emoji.', n - v.emoji.count, 'no emoji');
  const letters = replies.filter((r) => /\p{L}/u.test(r)).length;
  if (letters) add('lowercase-start', 'code', 'Start replies with a lowercase letter.', v.lowercaseStart.count, 'starts lowercase');
  add('no-greeting', 'principle', 'Skip the greeting and answer straight away.', n - v.greetings.rate.count, 'no greeting');
  add('no-sign-off', 'principle', 'Do not add a sign-off.', n - v.signOffs.rate.count, 'no sign-off');
  return out;
}

/**
 * Exact, verifiable statistics about your real history: volume, voice, candidate rules and recurring intents.
 * Pure and offline. Every number can be recomputed by hand from `pairs`.
 */
export function analyzeHistory(pairs: HistoryPair[], opts: AnalyzeOptions = {}): HistoryAnalysis {
  const buckets = opts.buckets ?? DEFAULT_BUCKETS;
  const minPairs = opts.minPairs ?? 10;
  const minShare = opts.minShare ?? 0.9;
  const per = opts.samplesPerCluster ?? 3;
  const topN = opts.topN ?? 10;
  const total = pairs.length;
  const pct = (n: number): number => (total ? round1((n / total) * 100) : 0);
  const notes: string[] = [];

  const byChannel = top(tally(pairs, (p) => p.channel), 50).map(([channel, count]) => ({ channel, count, pct: pct(count) }));
  const senders = new Map<string, { count: number; channels: Set<string> }>();
  for (const p of pairs) {
    const e = senders.get(p.sender) ?? { count: 0, channels: new Set<string>() };
    e.count++;
    e.channels.add(p.channel);
    senders.set(p.sender, e);
  }
  const topContacts = [...senders.entries()]
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .slice(0, topN)
    .map(([sender, e]) => ({ sender, count: e.count, channels: [...e.channels].sort() }));
  const threads = tally(pairs.filter((p) => p.threadId), (p) => `${p.channel}\u0000${p.threadId}`);
  const topThreads = top(threads, topN).map(([k, count]) => {
    const [channel, threadId] = k.split('\u0000');
    return { threadId: threadId!, channel: channel!, count };
  });
  const dated = pairs.map((p) => p.incomingAt ?? p.replyAt).filter((d): d is string => !!d && Number.isFinite(Date.parse(d))).sort();

  const voice = voiceOf(pairs);
  let rules: CandidateRule[] = [];
  if (total < minPairs) notes.push(`Only ${total} pair(s): at least ${minPairs} are needed before proposing rules from your style.`);
  else rules = rulesFrom(pairs, voice, minShare);

  const cell = new Map<string, HistoryPair[]>();
  const labels = new Map<string, string>([...buckets.map((b) => [b.id, b.label] as [string, string]), [OTHER_BUCKET.id, OTHER_BUCKET.label]]);
  for (const p of pairs) {
    const k = `${p.channel}\u0000${classify(p, buckets)}`;
    cell.set(k, [...(cell.get(k) ?? []), p]);
  }
  const clusters: IntentCluster[] = [...cell.entries()]
    .map(([k, group]) => {
      const [channel, bucket] = k.split('\u0000') as [string, string];
      const picks = evenly(group, per);
      return {
        bucket,
        label: labels.get(bucket) ?? bucket,
        channel,
        count: group.length,
        pct: pct(group.length),
        medianReplyWords: median(group.map((p) => words(p.reply))),
        samples: picks.map((p) => ({ id: p.id, incoming: snippet(p.incoming), reply: snippet(p.reply) })),
      };
    })
    .sort((a, b) => b.count - a.count || a.channel.localeCompare(b.channel) || a.bucket.localeCompare(b.bucket));
  const intentCounts = tally(pairs, (p) => classify(p, buckets));
  const intents = top(intentCounts, 50).map(([bucket, count]) => ({ bucket, label: labels.get(bucket) ?? bucket, count, pct: pct(count) }));

  return {
    total,
    ...(dated.length ? { span: { from: dated[0]!, to: dated.at(-1)! } } : {}),
    byChannel,
    topContacts,
    topThreads,
    voice,
    rules,
    intents,
    clusters,
    notes,
  };
}

/** `n` items spread evenly through a list (deterministic). */
function evenly<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  return Array.from({ length: n }, (_, i) => items[Math.floor((i * items.length) / n)]!);
}

/** Plain-English report for the CLI. */
export function formatAnalysis(a: HistoryAnalysis): string[] {
  if (!a.total) return ['No history yet. Run: rufus seed <file> --flow <flowId>'];
  const v = a.voice;
  const lines = [
    `${a.total} real reply pair(s)${a.span ? ` from ${a.span.from.slice(0, 10)} to ${a.span.to.slice(0, 10)}` : ''}.`,
    `Channels: ${a.byChannel.map((c) => `${c.channel} ${c.count} (${c.pct}%)`).join(', ')}`,
    `Most frequent senders: ${a.topContacts.slice(0, 5).map((c) => `${c.sender} (${c.count})`).join(', ')}`,
    '',
    'How you write:',
    `  Reply length: median ${v.words.median} words, 90th percentile ${v.words.p90}, longest ${v.words.max}. ${v.shortReplies.count} of ${v.replies} are under ${SHORT_WORDS} words.`,
    `  Starts lowercase ${v.lowercaseStart.count}x (${v.lowercaseStart.pct}%), ends with a period ${v.trailingPeriod.count}x (${v.trailingPeriod.pct}%).`,
    `  Em dashes: ${v.emDashes.total} in ${v.emDashes.repliesWith.count} reply(ies). Exclamations ${v.exclamation.count}x (${v.exclamation.pct}%), questions ${v.question.count}x (${v.question.pct}%), emoji ${v.emoji.count}x.`,
    `  Greeting in ${v.greetings.rate.count} (${v.greetings.rate.pct}%)${v.greetings.top.length ? `, most often "${v.greetings.top[0]!.text}"` : ''}. Sign-off in ${v.signOffs.rate.count} (${v.signOffs.rate.pct}%)${v.signOffs.top.length ? `, most often "${v.signOffs.top[0]!.text}"` : ''}.`,
  ];
  if (v.replyDelayMinutes) lines.push(`  Typical reply time: ${v.replyDelayMinutes.median} minutes (${v.replyDelayMinutes.pairs} timed pairs).`);
  lines.push('', 'What people write to you about:');
  for (const i of a.intents) lines.push(`  ${i.label}: ${i.count} (${i.pct}%)`);
  const shown = a.clusters.filter((c) => c.bucket !== OTHER_BUCKET.id).slice(0, 6);
  if (shown.length) {
    lines.push('', 'Biggest recurring patterns (channel + intent):');
    for (const c of shown) lines.push(`  ${c.channel} / ${c.label}: ${c.count} (${c.pct}%), you reply in ~${c.medianReplyWords} words. e.g. "${c.samples[0]!.incoming}" -> "${c.samples[0]!.reply}"`);
  }
  lines.push('');
  if (a.rules.length) {
    lines.push('Candidate rules from your own replies (exact support):');
    for (const r of a.rules) lines.push(`  [${r.layer}] ${r.rule}  (${r.support.count}/${r.support.of})`);
  } else {
    lines.push('No candidate rules: nothing was true of enough replies.');
  }
  for (const note of a.notes) lines.push(note);
  return lines;
}

// ---------- Optional AI synthesis ----------

export interface WorkflowBlueprint {
  name: string;
  /** How often it happens, in words that quote the counts from the stats. */
  frequency: string;
  trigger: string;
  /** What exact code should do (lookups, parsing, checks). */
  code: string;
  /** What the AI should do (drafting, judging). */
  ai: string;
  /** Where the human approves. */
  human: string;
}

export interface CandidateLesson {
  rule: string;
  layer: LessonLayer;
  support?: string;
}

export interface Synthesis {
  provider: string;
  attempts: number;
  blueprints: WorkflowBlueprint[];
  lessons: CandidateLesson[];
}

export const DEFAULT_AI_SAMPLE = 24;
const MAX_BLUEPRINTS = 5;
const MAX_LESSONS = 8;

/**
 * A small, code-picked sample: round-robin over the biggest intent buckets so every recurring pattern is
 * represented, evenly spaced inside each. Message text is trimmed; names are left out.
 */
export function representativeSample(pairs: HistoryPair[], buckets: IntentBucket[], n: number): Array<PairSample & { intent: string }> {
  const groups = new Map<string, HistoryPair[]>();
  for (const p of pairs) {
    const id = classify(p, buckets);
    groups.set(id, [...(groups.get(id) ?? []), p]);
  }
  const ordered = [...groups.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  const picks = new Map(ordered.map(([id, g]) => [id, evenly(g, Math.min(g.length, n))]));
  const out: Array<PairSample & { intent: string }> = [];
  for (let round = 0; out.length < n; round++) {
    let any = false;
    for (const [id] of ordered) {
      const p = picks.get(id)![round];
      if (!p) continue;
      any = true;
      if (out.length < n) out.push({ id: p.id, intent: id, incoming: snippet(p.incoming, 240), reply: snippet(p.reply, 240) });
    }
    if (!any) break;
  }
  return out;
}

function extractJson(raw: string): unknown {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(raw);
  const text = (fenced ? fenced[1]! : raw).trim();
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object found');
  return JSON.parse(text.slice(start, end + 1));
}

const LAYERS: LessonLayer[] = ['code', 'context', 'principle'];

function parseSynthesis(raw: string): { blueprints: WorkflowBlueprint[]; lessons: CandidateLesson[] } {
  const j = extractJson(raw) as { blueprints?: unknown; lessons?: unknown };
  const str = (v: unknown, field: string): string => {
    if (typeof v !== 'string' || !v.trim()) throw new Error(`"${field}" must be a non-empty string`);
    return v.trim();
  };
  if (!Array.isArray(j.blueprints)) throw new Error('"blueprints" must be an array');
  if (!Array.isArray(j.lessons)) throw new Error('"lessons" must be an array');
  const blueprints = j.blueprints.slice(0, MAX_BLUEPRINTS).map((b: Record<string, unknown>, i) => ({
    name: str(b?.name, `blueprints[${i}].name`),
    frequency: str(b?.frequency, `blueprints[${i}].frequency`),
    trigger: str(b?.trigger, `blueprints[${i}].trigger`),
    code: str(b?.code, `blueprints[${i}].code`),
    ai: str(b?.ai, `blueprints[${i}].ai`),
    human: str(b?.human, `blueprints[${i}].human`),
  }));
  const lessons = j.lessons.slice(0, MAX_LESSONS).map((l: Record<string, unknown>, i) => {
    if (!LAYERS.includes(l?.layer as LessonLayer)) throw new Error(`lessons[${i}].layer must be one of: ${LAYERS.join(', ')}`);
    return { rule: str(l.rule, `lessons[${i}].rule`), layer: l.layer as LessonLayer, ...(typeof l.support === 'string' && l.support.trim() ? { support: l.support.trim() } : {}) };
  });
  return { blueprints, lessons };
}

const SYSTEM = [
  "You help someone turn their real message history into durable AI + Code + Human workflows.",
  'You are given exact statistics computed by code and a small sample of real exchanges. Trust the statistics; the sample only illustrates them.',
  'Never invent counts. Quote the counts you are given. Do not repeat private details from the sample.',
  'Answer with one JSON object and nothing else.',
].join('\n');

/**
 * Ask a provider to name the recurring workflows and propose lessons, from code-assembled stats plus a compact
 * sample. Raw history is never sent: contact names are withheld, texts are trimmed, the sample is capped.
 */
export async function synthesizeHistory(
  provider: AiProvider,
  analysis: HistoryAnalysis,
  pairs: HistoryPair[],
  opts: { providerName?: string; sampleSize?: number; buckets?: IntentBucket[] } = {},
): Promise<Synthesis> {
  const sample = representativeSample(pairs, opts.buckets ?? DEFAULT_BUCKETS, opts.sampleSize ?? DEFAULT_AI_SAMPLE);
  const stats = {
    totalPairs: analysis.total,
    span: analysis.span,
    channels: analysis.byChannel,
    topContactShares: analysis.topContacts.slice(0, 5).map((c, i) => ({ contact: `contact ${i + 1}`, count: c.count })),
    voice: analysis.voice,
    candidateRules: analysis.rules.map(({ id, layer, rule, support }) => ({ id, layer, rule, support })),
    intents: analysis.intents,
    clusters: analysis.clusters.slice(0, 12).map(({ bucket, channel, count, pct, medianReplyWords }) => ({ bucket, channel, count, pct, medianReplyWords })),
  };
  const prompt = [
    'Propose how to automate the recurring parts of this person\'s replies.',
    `Return JSON: {"blueprints":[{"name","frequency","trigger","code","ai","human"}],"lessons":[{"rule","layer","support"}]}.`,
    `- At most ${MAX_BLUEPRINTS} blueprints, the most frequent first. "frequency" quotes counts from the stats. "trigger" says what starts it. "code" is what exact code does (lookups, parsing, checks). "ai" is what the model does (drafting or judging only). "human" is where the person approves.`,
    `- At most ${MAX_LESSONS} lessons. Each is one short imperative rule about how to reply. "layer" is "code" (exactly checkable, belongs in a verify function), "context" (the model needs a fact that code should fetch), or "principle" (taste or tone). Prefer the candidate rules in the stats; "support" quotes their counts.`,
  ].join('\n');

  const providerName = opts.providerName ?? 'default';
  const { value, attempts } = await runAiStep({
    provider,
    system: SYSTEM,
    step: 'mine',
    opts: { prompt, context: { stats, sample }, parse: parseSynthesis, maxRetries: 2 },
    meta: { runId: 'mine', flowId: 'mine' },
  });
  return { provider: providerName, attempts, ...value };
}

// ---------- Orchestration ----------

export interface MineOptions extends AnalyzeOptions {
  /** Also ask a provider for blueprints and lessons. */
  ai?: boolean;
  /** Named provider for the AI pass (e.g. `smart`). */
  provider?: string;
  /** Analyze only the most recent N pairs. */
  limit?: number;
  sampleSize?: number;
}

export interface MineReport {
  generatedAt: string;
  pairsAnalyzed: number;
  analysis: HistoryAnalysis;
  ai?: Synthesis;
}

/** The provider `rufus mine --ai` uses when none is named: `config.mine.provider`, else `smart` if you configured one. */
export function defaultMineProvider(config: Pick<RufusConfig, 'providers' | 'mine'>): string | undefined {
  return config.mine?.provider ?? (config.providers?.smart ? 'smart' : undefined);
}

export async function mineHistory(engine: Engine, opts: MineOptions = {}): Promise<MineReport> {
  if (opts.limit !== undefined && !(opts.limit > 0)) throw new Error('limit must be a positive number.');
  let pairs = await loadPairs(engine.store);
  if (opts.limit !== undefined) pairs = pairs.slice(-Math.floor(opts.limit));
  const analysis = analyzeHistory(pairs, opts);
  const report: MineReport = { generatedAt: new Date().toISOString(), pairsAnalyzed: pairs.length, analysis };
  if (opts.ai && pairs.length) {
    // Resolve the provider first so an unknown name fails before any work.
    const provider = engine.providerFor(opts.provider);
    report.ai = await synthesizeHistory(provider, analysis, pairs, { providerName: opts.provider, sampleSize: opts.sampleSize, buckets: opts.buckets });
  }
  return report;
}

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** `rufus propose ...` line for a lesson, ready to paste. */
export function proposeCommand(l: Pick<CandidateLesson, 'rule' | 'layer'>, scope: string): string {
  return `rufus propose ${shellQuote(scope)} ${shellQuote(l.rule)} --layer ${l.layer}`;
}

export function formatMine(r: MineReport, opts: { scope?: string } = {}): string[] {
  const lines = formatAnalysis(r.analysis);
  if (!r.ai) return lines;
  const scope = opts.scope ?? 'global';
  lines.push('', `Workflow blueprints (AI, ${r.ai.provider} provider):`);
  if (!r.ai.blueprints.length) lines.push('  none proposed.');
  r.ai.blueprints.forEach((b, i) => {
    lines.push(`  ${i + 1}. ${b.name} (${b.frequency})`, `     starts when: ${b.trigger}`, `     code: ${b.code}`, `     ai: ${b.ai}`, `     you approve: ${b.human}`);
  });
  lines.push('', 'Candidate lessons (try each with the command; replay saves it only if nothing regresses):');
  if (!r.ai.lessons.length) lines.push('  none proposed.');
  for (const l of r.ai.lessons) lines.push(`  [${l.layer}] ${l.rule}${l.support ? `  (${l.support})` : ''}`, `    ${proposeCommand(l, scope)}`);
  return lines;
}
