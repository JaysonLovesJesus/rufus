import { promises as fs } from 'node:fs';
import path from 'node:path';
import { createLocalEmbedder, topKBySimilarity, type Embedder, type Vector } from '../embed';

export interface SkillDoc {
  id: string;
  title: string;
  triggers: string;
  body: string;
  vector: Vector;
}

/**
 * Minimal embedded Skill loader (`<workspace>/skills/*.md`).
 * Embeds each skill's title + triggers so ONLY the top 1-2 relevant skills enter Opus's turn — zero context bloat.
 */
export async function selectRelevantSkills(
  workspaceDir: string,
  query: string,
  opts: { topK?: number; minScore?: number; maxChars?: number; embedder?: Embedder } = {},
): Promise<string> {
  const skillsDir = path.join(workspaceDir, 'skills');
  const topK = opts.topK ?? 2;
  const minScore = opts.minScore ?? 0.08;
  const maxChars = opts.maxChars ?? 1200;
  const embedder = opts.embedder ?? createLocalEmbedder();

  let files: string[];
  try {
    files = (await fs.readdir(skillsDir)).filter((f) => f.endsWith('.md') && !f.startsWith('.')).sort();
  } catch {
    return '';
  }
  if (!files.length) return '';

  const docs: Array<{ item: SkillDoc; vector: Vector }> = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(skillsDir, f), 'utf8').catch(() => '');
    if (!raw.trim()) continue;
    const title = (/^#\s+(.+)$/m.exec(raw)?.[1] ?? f.replace(/\.md$/, '')).trim();
    const triggers = (/^triggers:\s*(.+)$/im.exec(raw)?.[1] ?? title).trim();
    const body = raw.replace(/^---[\s\S]*?---\s*/m, '').trim();
    const vec = await embedder.embed(`${title}\n${triggers}\n${body.slice(0, 300)}`);
    docs.push({ item: { id: f.replace(/\.md$/, ''), title, triggers, body, vector: vec }, vector: vec });
  }
  if (!docs.length) return '';

  const qVec = await embedder.embed(query);
  const picked = topKBySimilarity(qVec, docs, topK).filter((r) => r.score >= minScore);
  if (!picked.length) return '';

  const joined = picked.map((p) => p.item.body).join('\n\n');
  return joined.length > maxChars ? `${joined.slice(0, maxChars - 1).trimEnd()}…` : joined;
}
