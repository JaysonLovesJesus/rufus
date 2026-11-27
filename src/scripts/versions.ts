import { promises as fs } from 'node:fs';
import path from 'node:path';

/**
 * Every self-change keeps the version it replaced, tagged with the wake and gap that changed it:
 * tools in `tools/<id>/.versions/<stamp>-v<n>/`, brain skills in `skills/.history/<STATE>-<stamp>.md`.
 * Rollback restores one of them, after keeping the current version the same way, so a rollback can be undone too.
 */
export const TOOL_VERSIONS_DIR = '.versions';
export const SKILL_HISTORY_DIR = '.history';
const TOOL_CODE_FILES = ['tool.json', 'run.mjs', 'test.mjs'];
const TOOL_RECORD_FILES = ['stats.json', 'lessons.json'];

export interface ChangeTag {
  at: Date;
  reason: string;
  wakeId?: string;
  gapId?: string;
}

export interface VersionInfo {
  name: string;
  archivedAt: string;
  reason: string;
  version?: number;
  wakeId?: string;
  gapId?: string;
}

const stamp = (d: Date) => d.toISOString().replace(/[:.]/g, '-');

function metaOf(tag: ChangeTag, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return { archivedAt: tag.at.toISOString(), reason: tag.reason, ...(tag.wakeId ? { wakeId: tag.wakeId } : {}), ...(tag.gapId ? { gapId: tag.gapId } : {}), ...extra };
}

async function exists(p: string): Promise<boolean> {
  return fs.stat(p).then(() => true, () => false);
}

/** Copies a tool's current code and its stats into `.versions/`; returns the version name (undefined if there is nothing to keep). */
export async function archiveToolVersion(toolDir: string, tag: ChangeTag, spare?: string): Promise<string | undefined> {
  if (!(await exists(path.join(toolDir, 'tool.json')))) return undefined;
  let version: number | undefined;
  try {
    version = (JSON.parse(await fs.readFile(path.join(toolDir, 'tool.json'), 'utf8')) as { version?: number }).version;
  } catch {
    /* unreadable manifest is still kept */
  }
  const base = `${stamp(tag.at)}-v${version ?? 0}`;
  let name = base;
  for (let i = 2; await exists(path.join(toolDir, TOOL_VERSIONS_DIR, name)); i++) name = `${base}-${i}`;
  const dest = path.join(toolDir, TOOL_VERSIONS_DIR, name);
  await fs.mkdir(dest, { recursive: true });
  for (const f of [...TOOL_CODE_FILES, ...TOOL_RECORD_FILES]) {
    await fs.copyFile(path.join(toolDir, f), path.join(dest, f)).catch(() => undefined);
  }
  await fs.writeFile(path.join(dest, 'meta.json'), `${JSON.stringify(metaOf(tag, version !== undefined ? { version } : {}), null, 2)}\n`, 'utf8');
  // Only the newest versions are kept, so repairs and rollbacks never pile up forever.
  for (const old of (await listToolVersions(toolDir)).filter((v) => v.name !== spare).slice(MAX_KEPT_VERSIONS)) {
    await fs.rm(path.join(toolDir, TOOL_VERSIONS_DIR, old.name), { recursive: true, force: true }).catch(() => undefined);
  }
  return name;
}

/** How many earlier versions each tool and each brain skill keeps. */
export const MAX_KEPT_VERSIONS = 20;

/** A tool's kept versions, newest first. */
export async function listToolVersions(toolDir: string): Promise<VersionInfo[]> {
  const dir = path.join(toolDir, TOOL_VERSIONS_DIR);
  const names = await fs.readdir(dir).catch(() => [] as string[]);
  const out: VersionInfo[] = [];
  for (const name of names) {
    try {
      const meta = JSON.parse(await fs.readFile(path.join(dir, name, 'meta.json'), 'utf8')) as Omit<VersionInfo, 'name'>;
      out.push({ name, ...meta });
    } catch {
      out.push({ name, archivedAt: '', reason: '(no record)' });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

/** Restores a kept tool version (the newest if none is named). The current code is kept first; stats and lessons carry on. */
export async function restoreToolVersion(toolDir: string, tag: ChangeTag, name?: string): Promise<{ restored: string; kept?: string } | { error: string }> {
  const versions = await listToolVersions(toolDir);
  const pick = name ? versions.find((v) => v.name === name) : versions[0];
  if (!pick) return { error: name ? `No version "${name}". Kept: ${versions.map((v) => v.name).join(', ') || 'none'}.` : 'No earlier version is kept.' };
  const src = path.join(toolDir, TOOL_VERSIONS_DIR, pick.name);
  // The version being restored is spared from pruning until it has been copied back.
  const kept = await archiveToolVersion(toolDir, tag, pick.name);
  for (const f of TOOL_CODE_FILES) {
    if (await exists(path.join(src, f))) await fs.copyFile(path.join(src, f), path.join(toolDir, f));
  }
  return { restored: pick.name, ...(kept ? { kept } : {}) };
}

/** Keeps the current `skills/<STATE>.md` in `skills/.history/` before it changes. */
export async function archiveSkill(skillsDir: string, state: string, tag: ChangeTag, spare?: string): Promise<string | undefined> {
  const file = path.join(skillsDir, `${state}.md`);
  const content = await fs.readFile(file, 'utf8').catch(() => undefined);
  if (content === undefined) return undefined;
  const dir = path.join(skillsDir, SKILL_HISTORY_DIR);
  await fs.mkdir(dir, { recursive: true });
  const base = `${state}-${stamp(tag.at)}`;
  let name = base;
  for (let i = 2; await exists(path.join(dir, `${name}.md`)); i++) name = `${base}-${i}`;
  await fs.writeFile(path.join(dir, `${name}.md`), content, 'utf8');
  await fs.writeFile(path.join(dir, `${name}.json`), `${JSON.stringify(metaOf(tag, { state }), null, 2)}\n`, 'utf8');
  for (const old of (await listSkillVersions(skillsDir, state)).filter((v) => v.name !== spare).slice(MAX_KEPT_VERSIONS)) {
    for (const ext of ['.md', '.json']) await fs.rm(path.join(dir, `${old.name}${ext}`), { force: true }).catch(() => undefined);
  }
  return name;
}

/** A skill's kept versions, newest first. */
export async function listSkillVersions(skillsDir: string, state: string): Promise<VersionInfo[]> {
  const dir = path.join(skillsDir, SKILL_HISTORY_DIR);
  const names = (await fs.readdir(dir).catch(() => [] as string[])).filter((n) => n.startsWith(`${state}-`) && n.endsWith('.md')).map((n) => n.slice(0, -3));
  const out: VersionInfo[] = [];
  for (const name of names) {
    try {
      out.push({ name, ...(JSON.parse(await fs.readFile(path.join(dir, `${name}.json`), 'utf8')) as Omit<VersionInfo, 'name'>) });
    } catch {
      out.push({ name, archivedAt: '', reason: '(no record)' });
    }
  }
  return out.sort((a, b) => b.name.localeCompare(a.name));
}

export async function restoreSkill(skillsDir: string, state: string, tag: ChangeTag, name?: string): Promise<{ restored: string; kept?: string } | { error: string }> {
  const versions = await listSkillVersions(skillsDir, state);
  const pick = name ? versions.find((v) => v.name === name) : versions[0];
  if (!pick) return { error: name ? `No version "${name}" of ${state}.` : `No earlier version of ${state} is kept.` };
  const content = await fs.readFile(path.join(skillsDir, SKILL_HISTORY_DIR, `${pick.name}.md`), 'utf8');
  const kept = await archiveSkill(skillsDir, state, tag, pick.name);
  await fs.writeFile(path.join(skillsDir, `${state}.md`), content, 'utf8');
  return { restored: pick.name, ...(kept ? { kept } : {}) };
}

/** Moves a tool's kept versions and its records (stats, lessons) from the old directory into the new one. */
export async function carryToolHistory(fromDir: string, toDir: string): Promise<void> {
  if (await exists(path.join(fromDir, TOOL_VERSIONS_DIR))) {
    await fs.rename(path.join(fromDir, TOOL_VERSIONS_DIR), path.join(toDir, TOOL_VERSIONS_DIR));
  }
  for (const f of TOOL_RECORD_FILES) {
    await fs.copyFile(path.join(fromDir, f), path.join(toDir, f)).catch(() => undefined);
  }
}
