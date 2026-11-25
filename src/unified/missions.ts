import { randomBytes } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { loadAnchor } from '../anchor/anchor';
import { clip } from '../corpus/types';
import type { Engine } from '../engine/engine';
import { loadSoul } from '../soul/soul';
import { ToolRegistry, type ToolDefinition } from '../tools/tools';
import type { AiMessage, AiProvider } from '../types';
import { buildDecisionCard, chatSafe, formatDecisionCard, type DecisionOption, type ResearchSource } from './research';

/**
 * Durable Background Missions (v22): "research X and get back to me", "prep a brief for tomorrow's meeting". A mission is
 * a bounded, multi-step tool loop that runs in the background of `rufus start` and pings you when it has something.
 *
 *   - Each mission is one JSON file, `<workspace>/missions/<id>.json`, saved after every step: a crash or restart never
 *     loses progress, and a `running` mission left behind by a crash is picked up again.
 *   - Ironclad: a mission only ever sees READ-ONLY tools (`web.search`, `web.fetch`, `calendar.read`, `gmail.read`, ...).
 *     The registry it calls is rebuilt from `readOnly: true` tools alone, and every call also runs in the `execute`
 *     stage, where the registry itself refuses anything with a side effect. A mission can never send, write or run.
 *   - Cancellation is checked on disk before every step, so `cancel mission <id>` stops it before the next tool call.
 */

export type MissionStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface MissionStep {
  at: string;
  tool: string;
  args: unknown;
  ok: boolean;
  /** A short, one-line look at the result (or why it failed or was blocked). */
  preview: string;
}

export interface MissionRecord {
  id: string;
  goal: string;
  context?: string;
  status: MissionStatus;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  steps: MissionStep[];
  maxSteps: number;
  /** Final human/Beeper-safe summary or Decision Card. */
  resultText?: string;
  /** True once announced to the user in chat. */
  delivered?: boolean;
  /** Deliver even in quiet hours. */
  urgent?: boolean;
  error?: string;
}

export const MISSIONS_DIR = 'missions';
export const DEFAULT_MISSION_STEPS = 6;
export const MAX_MISSION_STEPS = 12;
export const MAX_MISSION_RESULT_CHARS = 900;
const MAX_GOAL_CHARS = 500;
const MAX_CONTEXT_CHARS = 2000;
const PREVIEW_CHARS = 240;
const TOOL_RESULT_CHARS = 3000;
const ID = /^m-[a-z0-9]{4,16}$/;

const TERMINAL: readonly MissionStatus[] = ['completed', 'failed', 'cancelled'];
export const isActiveMission = (m: Pick<MissionRecord, 'status'>): boolean => m.status === 'queued' || m.status === 'running';

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const missionsDir = (dir: string): string => path.join(dir, MISSIONS_DIR);
const missionFile = (dir: string, id: string): string => path.join(missionsDir(dir), `${id}.json`);

function checkId(id: string): string {
  const t = String(id ?? '').trim().toLowerCase();
  if (!ID.test(t)) throw new Error(`Not a mission id: "${id}".`);
  return t;
}

const clampSteps = (n: unknown): number => {
  const v = typeof n === 'number' && Number.isFinite(n) ? Math.floor(n) : DEFAULT_MISSION_STEPS;
  return Math.max(1, Math.min(MAX_MISSION_STEPS, v));
};

// ---------- the store ----------

/** Writes one mission atomically (temp file, then rename): a crash mid-write never leaves half a file. */
export async function saveMission(dir: string, record: MissionRecord): Promise<MissionRecord> {
  const id = checkId(record.id);
  await fs.mkdir(missionsDir(dir), { recursive: true });
  const file = missionFile(dir, id);
  const tmp = `${file}.${process.pid}.${randomBytes(3).toString('hex')}.tmp`;
  await fs.writeFile(tmp, `${JSON.stringify(record, null, 2)}\n`, 'utf8');
  await fs.rename(tmp, file);
  return record;
}

/** One mission by id, or undefined when there is none. */
export async function loadMission(dir: string, id: string): Promise<MissionRecord | undefined> {
  let raw: string;
  try {
    raw = await fs.readFile(missionFile(dir, checkId(id)), 'utf8');
  } catch {
    return undefined;
  }
  try {
    const m = JSON.parse(raw) as MissionRecord;
    return m && typeof m === 'object' && typeof m.id === 'string' ? { ...m, steps: Array.isArray(m.steps) ? m.steps : [] } : undefined;
  } catch {
    return undefined;
  }
}

export interface ListMissionsOptions {
  status?: MissionStatus | MissionStatus[];
  /** Newest first; at most this many. */
  limit?: number;
}

/** Every mission, newest first (optionally only some statuses). Unreadable files are skipped. */
export async function listMissions(dir: string, opts: ListMissionsOptions = {}): Promise<MissionRecord[]> {
  let files: string[];
  try {
    files = await fs.readdir(missionsDir(dir));
  } catch {
    return [];
  }
  const wanted = opts.status === undefined ? undefined : new Set(Array.isArray(opts.status) ? opts.status : [opts.status]);
  const all = await Promise.all(files.filter((f) => f.endsWith('.json')).map((f) => loadMission(dir, f.slice(0, -5)).catch(() => undefined)));
  const out = all
    .filter((m): m is MissionRecord => !!m && (!wanted || wanted.has(m.status)))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id));
  return opts.limit !== undefined && opts.limit >= 0 ? out.slice(0, opts.limit) : out;
}

export interface CreateMissionInput {
  goal: string;
  context?: string;
  maxSteps?: number;
  urgent?: boolean;
}

/** Queues a new mission. A running `rufus start` picks it up on its next pass. */
export async function createMission(dir: string, input: CreateMissionInput, now: Date = new Date()): Promise<MissionRecord> {
  const goal = typeof input?.goal === 'string' ? input.goal.replace(/\s+/g, ' ').trim() : '';
  if (!goal) throw new Error('A mission needs a goal.');
  const context = typeof input.context === 'string' && input.context.trim() ? input.context.trim().slice(0, MAX_CONTEXT_CHARS) : undefined;
  let id: string;
  do id = `m-${randomBytes(3).toString('hex')}`;
  while (await loadMission(dir, id));
  const record: MissionRecord = {
    id,
    goal: goal.slice(0, MAX_GOAL_CHARS),
    ...(context ? { context } : {}),
    status: 'queued',
    createdAt: now.toISOString(),
    steps: [],
    maxSteps: clampSteps(input.maxSteps),
    ...(input.urgent ? { urgent: true } : {}),
  };
  return saveMission(dir, record);
}

/**
 * Finds a mission by its id, with or without the `m-` prefix, or by a unique prefix ("3fa9"). Throws with the open
 * missions when nothing (or more than one) matches.
 */
export async function resolveMission(dir: string, ref: string): Promise<MissionRecord> {
  const r = String(ref ?? '').trim().toLowerCase().replace(/^#/, '');
  if (!r) throw new Error('Which mission? Say its id, like m-3fa9c1.');
  const want = r.startsWith('m-') ? r : `m-${r}`;
  const all = await listMissions(dir);
  const exact = all.find((m) => m.id === want);
  if (exact) return exact;
  const hits = all.filter((m) => m.id.startsWith(want));
  if (hits.length === 1) return hits[0]!;
  const open = all.filter(isActiveMission).map((m) => m.id);
  if (!hits.length) throw new Error(`No mission "${ref}".${open.length ? ` Open: ${open.join(', ')}.` : ' Nothing is running.'}`);
  throw new Error(`"${ref}" matches more than one mission: ${hits.map((m) => m.id).join(', ')}.`);
}

/**
 * Cancels a queued or running mission (a running one stops before its next step). A mission that already finished is
 * returned unchanged, with `cancelled: false`.
 */
export async function cancelMission(dir: string, id: string, now: Date = new Date()): Promise<{ record: MissionRecord; cancelled: boolean }> {
  const m = await resolveMission(dir, id);
  if (!isActiveMission(m)) return { record: m, cancelled: false };
  const record: MissionRecord = { ...m, status: 'cancelled', finishedAt: now.toISOString() };
  await saveMission(dir, record);
  return { record, cancelled: true };
}

/** "flights to Denver (m-3fa9c1, running, 2 steps)" */
export function describeMission(m: MissionRecord): string {
  const steps = m.steps.length ? `, ${m.steps.length} step${m.steps.length === 1 ? '' : 's'}` : '';
  return `${clip(m.goal, 80)} (${m.id}, ${m.status}${steps})`;
}

/** The plain-text answer to "missions" / "what are you working on?". */
export async function formatMissionList(dir: string, opts: { recent?: number } = {}): Promise<string> {
  const all = await listMissions(dir);
  const active = all.filter(isActiveMission);
  const recent = all.filter((m) => !isActiveMission(m)).slice(0, opts.recent ?? 3);
  if (!active.length && !recent.length) return "Nothing in the works right now. Ask me to research something and I'll dig in in the background.";
  const lines: string[] = [];
  if (active.length) {
    lines.push(active.length === 1 ? 'Working on 1 thing:' : `Working on ${active.length} things:`);
    for (const m of active) lines.push(`- ${describeMission(m)}`);
  } else lines.push('Nothing running right now.');
  if (recent.length) {
    lines.push('Recently:');
    for (const m of recent) lines.push(`- ${describeMission(m)}`);
  }
  if (active.length) lines.push(`Say "cancel mission ${active[0]!.id}" to stop one.`);
  return lines.join('\n');
}

// ---------- read-only tools only ----------

/** True when a mission may call this tool: read-only, no sensitivity, and not a mission tool itself. */
export function missionMayUse(tool: Pick<ToolDefinition, 'name' | 'readOnly' | 'sensitivity'>): boolean {
  return tool.readOnly === true && !(tool.sensitivity ?? []).length && !tool.name.startsWith('mission.');
}

/**
 * A fresh registry holding ONLY the tools a mission may use. A side-effect tool is not in it at all, so no model reply
 * can ever reach `beeper.send`, `shell.run`, `calendar.write` and the like.
 */
export function missionToolRegistry(tools: ToolRegistry | undefined): ToolRegistry {
  const out = new ToolRegistry();
  for (const t of tools?.list() ?? []) if (missionMayUse(t)) out.register(t);
  return out;
}

// ---------- the runner ----------

export interface MissionCardReply {
  question?: string;
  /** Sources for `buildDecisionCard`. Missing: the ones found during the mission. */
  results?: ResearchSource[];
  constraints?: string[];
  /** Or a finished card: up to two options, the pick, why, and the next step. */
  options?: DecisionOption[];
  pick?: 'A' | 'B';
  why?: string;
  next?: string;
}

export type MissionReply =
  | { kind: 'tool'; tool: string; args: Record<string, unknown> }
  | { kind: 'done'; summary: string; card?: MissionCardReply };

/** The first `{...}` object in a reply, by brace matching (strings respected). */
function firstJsonObject(text: string): Record<string, unknown> | undefined {
  const t = text.replace(/```(?:json)?/gi, '');
  const start = t.indexOf('{');
  if (start < 0) return undefined;
  let depth = 0;
  let inStr = false;
  for (let i = start; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try {
        const o = JSON.parse(t.slice(start, i + 1)) as unknown;
        return o && typeof o === 'object' && !Array.isArray(o) ? (o as Record<string, unknown>) : undefined;
      } catch {
        return undefined;
      }
    }
  }
  return undefined;
}

/**
 * Reads one model step: `{"tool":"web.search","args":{...}}` (also `TOOL_CALL: {...}`), or `{"done":true,"summary":"...",
 * "card":{...}}`. Plain prose with no JSON is taken as the final summary.
 */
export function parseMissionReply(raw: string): MissionReply {
  const o = firstJsonObject(raw);
  if (o) {
    if (o.done === true || typeof o.summary === 'string') {
      const card = o.card && typeof o.card === 'object' && !Array.isArray(o.card) ? (o.card as MissionCardReply) : undefined;
      return { kind: 'done', summary: typeof o.summary === 'string' ? o.summary.trim() : '', ...(card ? { card } : {}) };
    }
    const tool = typeof o.tool === 'string' ? o.tool.trim() : typeof o.name === 'string' ? o.name.trim() : '';
    if (tool) {
      const args = o.args && typeof o.args === 'object' && !Array.isArray(o.args) ? (o.args as Record<string, unknown>) : {};
      return { kind: 'tool', tool, args };
    }
  }
  return { kind: 'done', summary: raw.trim() };
}

/** Search results and fetched pages seen during a mission, for the Decision Card. */
function sourcesFrom(tool: string, args: Record<string, unknown>, out: unknown): ResearchSource[] {
  const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');
  if (Array.isArray(out)) {
    return out
      .filter((r): r is Record<string, unknown> => !!r && typeof r === 'object')
      .map((r) => ({ title: str(r.title), url: str(r.url), ...(str(r.snippet) ? { snippet: str(r.snippet) } : {}) }))
      .filter((r) => r.title && /^https?:\/\//.test(r.url));
  }
  if (tool === 'web.fetch' && out && typeof out === 'object') {
    const p = out as Record<string, unknown>;
    const url = str(p.finalUrl) || str(p.url) || str(args.url);
    if (/^https?:\/\//.test(url)) return [{ title: str(p.title) || url, url, ...(str(p.text) ? { text: str(p.text) } : {}) }];
  }
  return [];
}

function missionSystem(tools: ToolRegistry, maxSteps: number): string {
  const list = tools.list().map((t) => `- ${t.name}: ${t.description}`);
  return [
    'You are Rufus, a calm chief of staff, working on a background mission for your human: research or prep they asked for.',
    'You can ONLY use the read-only tools listed below. You cannot send messages, write files, change calendars or run commands; never pretend you did.',
    'Each reply is exactly ONE JSON object and nothing else:',
    '- to use a tool: {"tool":"<name>","args":{...}}',
    '- to finish: {"done":true,"summary":"2-4 short plain sentences: what you found and what you suggest","card":{"question":"...","options":[{"name":"...","summary":"one line of facts","url":"..."},{"name":"...","summary":"...","url":"..."}],"pick":"A","why":"one line","next":"one short next step"}}',
    'Include "card" only when they are choosing between options; otherwise leave it out. Use only facts you found. Plain text only: no markdown, tables or bullets.',
    `You have at most ${maxSteps} tool call${maxSteps === 1 ? '' : 's'}. Finish as soon as you have enough.`,
    'Tools:',
    ...(list.length ? list : ['(none: answer from what you were told)']),
  ].join('\n');
}

export interface RunMissionOptions {
  /** The workspace. */
  dir: string;
  id: string;
  /** Picks the model when `provider` is not given: the `smart` tier (or the default provider). */
  engine?: Pick<Engine, 'routeProvider'>;
  /** Every tool there is: only the read-only ones are kept. */
  tools?: ToolRegistry;
  provider?: AiProvider;
  now?: () => Date;
  /** Per tool call. Default 30s. */
  toolTimeoutMs?: number;
}

const withTimeout = <T>(p: Promise<T>, ms: number, what: string): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms);
    p.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e) => (clearTimeout(timer), reject(e)),
    );
  });

/** Joins the summary and the card into one chat-safe message of at most 900 characters. */
export function missionResultText(summary: string, card?: string): string {
  const s = summary.trim() ? chatSafe(summary, MAX_MISSION_RESULT_CHARS) : '';
  const c = card?.trim() ?? '';
  if (!c) return s || 'I looked into it but found nothing solid to report.';
  const room = MAX_MISSION_RESULT_CHARS - c.length - 2;
  const head = s && room > 40 ? clip(s, room) : '';
  const out = head ? `${head}\n\n${c}` : c;
  return out.length > MAX_MISSION_RESULT_CHARS ? `${out.slice(0, MAX_MISSION_RESULT_CHARS - 1).trimEnd()}…` : out;
}

/**
 * Runs one mission to the end: a bounded loop of read-only tool calls, then a short summary (and a Decision Card when
 * there is a choice to make). Saved after every step. Never throws for model or tool failures: the mission ends
 * `failed` with the reason. Returns the final record.
 */
export async function runMission(opts: RunMissionOptions): Promise<MissionRecord> {
  const { dir } = opts;
  const clock = opts.now ?? (() => new Date());
  const toolTimeoutMs = opts.toolTimeoutMs ?? 30_000;
  const start = await loadMission(dir, opts.id);
  if (!start) throw new Error(`No mission ${opts.id}.`);
  if (TERMINAL.includes(start.status)) return start;

  let m: MissionRecord = { ...start, status: 'running', startedAt: start.startedAt ?? clock().toISOString() };
  /** Saves progress unless the mission was cancelled meanwhile (then the cancellation wins and we stop). */
  const persist = async (): Promise<boolean> => {
    const disk = await loadMission(dir, m.id);
    if (disk?.status === 'cancelled') {
      m = disk;
      return false;
    }
    await saveMission(dir, m);
    return true;
  };
  const finish = async (patch: Partial<MissionRecord>): Promise<MissionRecord> => {
    m = { ...m, ...patch, finishedAt: clock().toISOString() };
    await persist();
    return m;
  };
  if (!(await persist())) return m;

  let provider: AiProvider;
  try {
    provider = opts.provider ?? opts.engine!.routeProvider({ tier: 'smart' });
    if (!provider) throw new Error('no AI provider');
  } catch (err) {
    return finish({ status: 'failed', error: `No model to run the mission: ${message(err)}` });
  }

  const tools = missionToolRegistry(opts.tools);
  const sources: ResearchSource[] = [];
  const resumed = m.steps.length;
  const budget = Math.max(0, m.maxSteps - resumed);
  const facts = [
    `Mission: ${m.goal}`,
    ...(m.context ? [`Context: ${m.context}`] : []),
    `Now: ${clock().toString()}`,
    ...(resumed ? [`Steps already done before a restart (results not kept, redo any you still need):\n${m.steps.map((s) => `- ${s.tool} ${JSON.stringify(s.args)}: ${s.ok ? 'ok' : 'failed'}: ${s.preview}`).join('\n')}`] : []),
  ];
  const messages: AiMessage[] = [{ role: 'user', content: facts.join('\n\n') }];
  const system = missionSystem(tools, budget);

  try {
    for (let step = 0; ; step++) {
      // Cancellation is read from disk before every step: it stops the mission before the next tool call.
      const disk = await loadMission(dir, m.id);
      if (!disk || disk.status === 'cancelled') return disk ?? m;
      const last = step >= budget;
      if (last && step > 0) messages.push({ role: 'user', content: 'No tool calls left. Finish now with {"done":true,...}.' });
      const out = await provider.complete({ system, messages: [...messages], meta: { runId: m.id, flowId: 'mission', step: `mission.${resumed + step}`, attempt: 1 } });
      const reply = parseMissionReply(out);

      if (reply.kind === 'done' || last) {
        const done = reply.kind === 'done' ? reply : { kind: 'done' as const, summary: 'I ran out of steps before I could finish, so this is what the first results say.' };
        const card = await cardText(done.card, { goal: m.goal, sources, provider, dir, forceFromSources: reply.kind !== 'done' });
        return await finish({ status: 'completed', resultText: missionResultText(done.summary, card) });
      }

      // And again right before the tool runs: a cancel that came in while the model was thinking wins.
      const again = await loadMission(dir, m.id);
      if (!again || again.status === 'cancelled') return again ?? m;
      const at = clock().toISOString();
      const tool = tools.get(reply.tool);
      let rec: MissionStep;
      let result: string;
      if (!tool) {
        // Not in the read-only registry: either unknown or a side-effect tool. Hard-blocked, nothing runs.
        const exists = opts.tools?.get(reply.tool);
        const why = exists ? `blocked: ${reply.tool} is not read-only, and missions never act` : `no such tool. Available: ${tools.list().map((t) => t.name).join(', ') || 'none'}`;
        rec = { at, tool: reply.tool, args: reply.args, ok: false, preview: why };
        result = `NOT RUN: ${why}.`;
      } else {
        try {
          // `execute` stage: the registry itself refuses anything with a side effect, a second lock behind the filter.
          const value = await withTimeout(tools.call(reply.tool, reply.args, { dir, now: clock(), runId: m.id, stage: 'execute' }), toolTimeoutMs, reply.tool);
          sources.push(...sourcesFrom(reply.tool, reply.args, value));
          const shown = typeof value === 'string' ? value : JSON.stringify(value ?? null);
          rec = { at, tool: reply.tool, args: reply.args, ok: true, preview: clip(shown, PREVIEW_CHARS) };
          result = shown.length > TOOL_RESULT_CHARS ? `${shown.slice(0, TOOL_RESULT_CHARS - 1)}…` : shown;
        } catch (err) {
          rec = { at, tool: reply.tool, args: reply.args, ok: false, preview: clip(message(err), PREVIEW_CHARS) };
          result = `FAILED: ${message(err)}`;
        }
      }
      m = { ...m, steps: [...m.steps, rec] };
      if (!(await persist())) return m;
      messages.push({ role: 'assistant', content: out.trim() });
      messages.push({ role: 'user', content: `TOOL_RESULT ${reply.tool}:\n${result}\n\nCall another tool, or finish.` });
    }
  } catch (err) {
    const disk = await loadMission(dir, m.id).catch(() => undefined);
    if (disk?.status === 'cancelled') return disk;
    return finish({ status: 'failed', error: clip(message(err), 300), resultText: `I couldn't finish "${clip(m.goal, 80)}": ${clip(message(err), 200)}` });
  }
}

/** The Decision Card as chat text: a finished card is formatted; sources go through v19's `buildDecisionCard`. */
async function cardText(
  card: MissionCardReply | undefined,
  ctx: { goal: string; sources: ResearchSource[]; provider: AiProvider; dir: string; forceFromSources: boolean },
): Promise<string | undefined> {
  if (!card && !(ctx.forceFromSources && ctx.sources.length)) return undefined;
  const question = (typeof card?.question === 'string' && card.question.trim()) || ctx.goal;
  const options = Array.isArray(card?.options)
    ? card!.options
        .filter((o) => o && typeof o.name === 'string' && o.name.trim())
        .slice(0, 2)
        .map((o) => ({ name: o.name, summary: typeof o.summary === 'string' ? o.summary : '', ...(typeof o.url === 'string' && /^https?:\/\//.test(o.url) ? { url: o.url } : {}) }))
    : [];
  if (options.length) {
    const pick = String(card?.pick ?? 'A').toUpperCase().startsWith('B') && options.length > 1 ? ('B' as const) : ('A' as const);
    return formatDecisionCard({ question, options, pick, why: typeof card?.why === 'string' ? card.why : '', next: typeof card?.next === 'string' && card.next.trim() ? card.next : 'Want me to look closer?' });
  }
  const given = Array.isArray(card?.results) ? card!.results.filter((r) => r && typeof r.title === 'string' && typeof r.url === 'string') : [];
  const results = given.length ? given : ctx.sources;
  if (!results.length) return undefined;
  const [soul, anchor] = await Promise.all([loadSoul(ctx.dir).catch(() => undefined), loadAnchor(ctx.dir).catch(() => undefined)]);
  const built = await buildDecisionCard({
    question,
    results,
    ...(ctx.forceFromSources ? {} : { ai: ctx.provider }),
    ...(soul ? { soul } : {}),
    ...(anchor ? { anchor } : {}),
    ...(Array.isArray(card?.constraints) ? { constraints: card!.constraints.filter((c) => typeof c === 'string') } : {}),
  });
  return built.text;
}

/** The message that announces a finished mission in chat. */
export function formatMissionDelivery(m: MissionRecord): string {
  const goal = chatSafe(m.goal, 80);
  if (m.status === 'failed') return clip(`I couldn't finish "${goal}" (${m.id}): ${m.error ?? 'unknown error'}. Want me to try again?`, MAX_MISSION_RESULT_CHARS + 120);
  const body = m.resultText ?? 'Done, but there was nothing solid to report.';
  return `Done digging into "${goal}":\n${body}`;
}
