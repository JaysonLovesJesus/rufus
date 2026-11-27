import { promises as fs } from 'node:fs';
import path from 'node:path';
import { ROOT_GAP_ID, type Gap, type GapStore } from './store';

export const SELF_OPT_PARENT_ID = 'gap_self_opt';

export interface SelfOptSpec {
  id: string;
  parentId: string;
  title: string;
  target: string;
  reality: string;
}

/**
 * The built-in standing self-optimization gaps that ship with every Rufus install.
 * They never close: on Day 1 they drive onboarding, and forever after they keep Rufus
 * minimal, fast, accurate, fitted to the owner's life, and contributing clean upstream fixes.
 */
export const SELF_OPT_SPECS: readonly SelfOptSpec[] = [
  {
    id: SELF_OPT_PARENT_ID,
    parentId: ROOT_GAP_ID,
    title: 'Keep Rufus sharp, fitted to the owner, and improving',
    target: 'Toolset, senses, bouncer, voice/trust, and core engine stay measurably healthy and personalize around the owner over time.',
    reality: 'Baseline standing gap seeded; sub-gaps track each dimension.',
  },
  {
    id: 'gap_opt_tools',
    parentId: SELF_OPT_PARENT_ID,
    title: 'Toolset fit: minimal, fewest steps, full coverage',
    target: 'Zero duplicate or dead tools; repeating multi-step chains are packaged into single-call shortcuts; every active life area and gap has a working tool or MCP path.',
    reality: 'Not measured yet; audit wakes.jsonl, registered tools, and blocked gaps.',
  },
  {
    id: 'gap_opt_senses',
    parentId: SELF_OPT_PARENT_ID,
    title: 'Senses & world coverage (onboarding and signal health)',
    target: 'Every channel and life area the owner cares about is connected and producing clean, non-duplicate signal with zero silent pollers.',
    reality: 'Not measured yet; check connected senses, 24h volume, and duplicate rate.',
  },
  {
    id: 'gap_opt_bouncer',
    parentId: SELF_OPT_PARENT_ID,
    title: 'Bouncer precision: zero noise wakes, zero missed signal',
    target: 'Local classifier sleeps on noise (low wasted-wake rate) and never misses real owner-relevant events (held-out WAKE recall holds on every retrain).',
    reality: 'Not measured yet; check decisions.jsonl, wasted wakes, and held-out recall.',
  },
  {
    id: 'gap_opt_voice_trust',
    parentId: SELF_OPT_PARENT_ID,
    title: 'Voice & trust fit: feels like the owner’s chief of staff',
    target: 'Messages match the owner’s preferred tone, length, and channel (text vs voice); trust rungs match reality (offer promotions after clean streaks, drop on denials).',
    reality: 'Not measured yet; check VOICE.md, owner reactions/pushbacks, and trust streaks.',
  },
  {
    id: 'gap_opt_engine',
    parentId: SELF_OPT_PARENT_ID,
    title: 'Core engine health & upstream PRs',
    target: 'Zero recurring engine failures, 100% passing rufus verify loop checks, and generic engine improvements proposed cleanly upstream via privacy-checked PRs (personal config stays local).',
    reality: 'Not measured yet; check ops-failures.jsonl and rufus verify.',
  },
];

/**
 * Idempotently seeds the built-in standing self-optimization gaps on a workspace's Gap Board.
 * Existing gaps with the same title or id are kept untouched (never duplicated or reset).
 */
export async function seedSelfOptimizationGaps(store: GapStore, now = new Date()): Promise<{ added: Gap[]; total: number }> {
  await store.ensureRoot();
  const existing = await store.list();
  const byTitle = new Set(existing.map((g) => g.title.trim().toLowerCase()));
  const byId = new Set(existing.map((g) => g.id));
  const idMap = new Map<string, string>();
  for (const spec of SELF_OPT_SPECS) {
    const match = existing.find((g) => g.id === spec.id || g.title.trim().toLowerCase() === spec.title.trim().toLowerCase());
    if (match) idMap.set(spec.id, match.id);
  }
  const added: Gap[] = [];
  for (const spec of SELF_OPT_SPECS) {
    if (byId.has(spec.id) || byTitle.has(spec.title.trim().toLowerCase())) continue;
    const parentId = spec.parentId === ROOT_GAP_ID ? ROOT_GAP_ID : idMap.get(spec.parentId) ?? ROOT_GAP_ID;
    const created = await store.create({
      title: spec.title,
      target: spec.target,
      reality: spec.reality,
      source: 'owner',
      parentId,
      standing: true,
      now,
    });
    idMap.set(spec.id, created.id);
    added.push(created);
  }
  return { added, total: (await store.list()).length };
}

/** Starter VOICE.md written by `rufus init` when a workspace does not have one yet. */
export const STARTER_VOICE_MD = `# Voice

- Direct, concise, and honest. Never bluff or claim something is done without a receipt.
- Match the owner's channel: short, scannable messages in chat; natural spoken phrasing in voice notes.
- Lead with what actually happened or what decision is needed. Skip filler.
`;

/** Ensures a workspace has a starter VOICE.md (never overwrites an existing one). */
export async function ensureStarterVoice(workspaceDir: string): Promise<boolean> {
  const voicePath = path.join(workspaceDir, 'VOICE.md');
  try {
    await fs.access(voicePath);
    return false;
  } catch {
    await fs.mkdir(workspaceDir, { recursive: true });
    await fs.writeFile(voicePath, STARTER_VOICE_MD, 'utf8');
    return true;
  }
}
