import { promises as fs } from 'node:fs';
import path from 'node:path';
import { discoverLayer3, RADAR_FILE, type Layer3Inventory } from '../skills/runner';

export const SELF_MAP_FILE = 'SELF.md';

export interface SelfMapOptions {
  brain: 'classic' | 'continuous';
  tools: readonly string[];
  sensors?: readonly string[];
  now?: Date;
}

/**
 * Generates a concise, plain-English map of Rufus's own running engine and active Layer 3 code hooks
 * (`<workspace>/SELF.md`). Written at $0 on startup so Rufus can accurately explain or diagnose himself.
 */
export async function buildSelfMap(dir: string, opts: SelfMapOptions): Promise<string> {
  const inv: Layer3Inventory = await discoverLayer3(dir).catch(() => ({ units: [] }));
  const hasRadar = await fs.stat(path.join(dir, RADAR_FILE)).then((s) => s.isFile()).catch(() => false);
  const projects = await fs
    .readdir(path.join(dir, 'projects'))
    .then((xs) => xs.filter((f) => f.endsWith('.md') && !f.startsWith('.')).map((f) => f.replace(/\.md$/, '')).sort())
    .catch(() => [] as string[]);
  const evalCount = await fs
    .readFile(path.join(dir, 'evals', 'cases.json'), 'utf8')
    .then((raw) => {
      const parsed = JSON.parse(raw) as unknown;
      return Array.isArray(parsed) ? parsed.length : 0;
    })
    .catch(() => 0);

  const hooks: string[] = [];
  if (hasRadar) hooks.push('radar.mjs (live $0 ground truth before thinking)');
  if (inv.taste) hooks.push('taste.mjs (voice, formatting, and outcome verifier)');
  if (inv.boundaries) hooks.push('boundaries.mjs (hard safety and quiet-hours gate)');
  for (const u of inv.units) {
    const parts = [u.prepare && 'prepare', u.run && 'run', u.verify && 'verify'].filter(Boolean);
    if (parts.length) hooks.push(`${u.kind}s/${u.name} (${parts.join(', ')})`);
  }

  const lines = [
    '# SELF: How My Engine Works',
    '',
    `- **Mind mode:** ${opts.brain === 'continuous' ? 'Continuous Living Brain (event-driven actor loop with interrupt-while-thinking)' : 'Classic Chief of Staff'}`,
    `- **Active tools (${opts.tools.length}):** ${opts.tools.slice(0, 20).join(', ')}${opts.tools.length > 20 ? ` (+${opts.tools.length - 20} more)` : ''}`,
    ...(opts.sensors?.length ? [`- **Active sensors:** ${opts.sensors.join(', ')}`] : []),
    `- **Loaded projects (${projects.length}):** ${projects.join(', ') || 'none'}`,
    `- **Active Layer 3 code hooks:** ${hooks.join('; ') || 'none'}`,
    `- **Replay eval cases:** ${evalCount}`,
    '',
    '## Code + AI Loop',
    '1. **Code prepares (`radar.mjs` + `prepare.mjs`):** gathers live structured ground truth at $0 before I think.',
    '2. **AI thinks (`SOUL.md` + `USER.md` + `MEMORY.md` + `projects/*.md`):** decides actions (`say`, `react`, `tool`, `continue`, `rest`).',
    '3. **Code verifies (`taste.mjs` + `boundaries.mjs` + claim verifier):** checks every draft and action before anything reaches the human; external writes are queued for approval.',
    '4. **Crystallization:** repeated workflows and corrections graduate from AI prompts into deterministic Layer 3 `.mjs` code and `evals/cases.json` regression tests.',
  ];
  return `${lines.join('\n')}\n`;
}

export async function writeSelfMap(dir: string, opts: SelfMapOptions): Promise<string> {
  const content = await buildSelfMap(dir, opts);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(path.join(dir, SELF_MAP_FILE), content, 'utf8');
  return content;
}

export async function readSelfMap(dir: string, maxChars = 2500): Promise<string> {
  try {
    const raw = await fs.readFile(path.join(dir, SELF_MAP_FILE), 'utf8');
    const trimmed = raw.trim();
    return trimmed.length > maxChars ? `${trimmed.slice(0, maxChars - 1).trimEnd()}…` : trimmed;
  } catch {
    return '';
  }
}
