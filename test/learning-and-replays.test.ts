import { promises as fs } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ToolRegistry } from '../src';
import { registerLocalSearch, searchLocal } from '../src/scripts/local-search';
import { tempDir } from './helpers';

const NOW = new Date('2026-11-27T03:20:00Z');

async function write(file: string, text: string, mtime?: Date): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, text, 'utf8');
  if (mtime) await fs.utimes(file, mtime, mtime);
}

/** A synthetic home folder, not a git repo: notes buried among many decoy chats, dependencies and caches. */
async function syntheticHome(): Promise<string> {
  const home = await tempDir('rufus-search-home-');
  for (let i = 0; i < 150; i++) {
    await write(path.join(home, 'Library', 'Application Support', 'ChatApp', 'chats', `chat-${i}.json`), JSON.stringify({ title: `coding task ${i}`, messages: ['fix the build', 'run the tests'] }));
  }
  for (let i = 0; i < 40; i++) await write(path.join(home, 'Projects', 'app', 'node_modules', `dep${i}`, 'index.js'), 'module.exports = "sabbath sermon";');
  await write(path.join(home, 'Life', 'bots', 'sam', 'notes', 'talk-framework.md'), '# Talk: how the mind changes\n\nPreaching Sabbath Nov 28.\nTitle: Conformed or Transformed (Romans 12:2)\n', new Date('2026-11-24T10:00:00Z'));
  await write(path.join(home, 'Life', 'bots', 'alex', 'notes', 'groceries.md'), 'milk, eggs');
  return home;
}

describe('the general search finds things anywhere, by name and content, in one call', () => {
  it('finds notes by their content in a folder that is not a git repo, skipping dependencies', async () => {
    const home = await syntheticHome();
    const res = await searchLocal({ query: 'sabbath conformed', roots: [home], spotlight: false, now: NOW });
    expect(res.stoppedEarly).toBe(false);
    expect(res.hits[0]?.path).toBe(path.join(home, 'Life', 'bots', 'sam', 'notes', 'talk-framework.md'));
    expect(res.hits[0]).toMatchObject({ match: 'content', line: 3 });
    expect(res.hits.some((h) => h.path.includes('node_modules'))).toBe(false);
  });

  it('matches file and folder names without reading them, ranked above weaker text matches', async () => {
    const home = await syntheticHome();
    await write(path.join(home, 'Documents', 'misc.txt'), 'a framework for talks');
    const res = await searchLocal({ query: 'talk framework', roots: [home], spotlight: false, now: NOW });
    expect(res.hits[0]?.path).toMatch(/talk-framework\.md$/);
    expect(res.hits[0]?.match).toBe('name');
  });

  it('returns what it has and the folders still unsearched when the budget runs out, instead of nothing', async () => {
    const home = await syntheticHome();
    const res = await searchLocal({ query: 'sabbath', roots: [home], budgetMs: 1, spotlight: false, now: NOW });
    expect(res.stoppedEarly).toBe(true);
    expect(res.unsearched.length).toBeGreaterThan(0);
  });

  it('as the files.find tool: one call answers "where are my notes", with the line that matched', async () => {
    const home = await syntheticHome();
    const reg = new ToolRegistry({ toolsDir: path.join(home, 'ws', 'tools') });
    await registerLocalSearch(reg, { spotlight: false });
    const r = await reg.call('files.find', { query: 'sabbath sermon notes', in: [home] }, { workspaceDir: path.join(home, 'ws'), now: NOW });
    expect(r.status).toBe('ok');
    expect((r.data as string[])[0]).toMatch(/talk-framework\.md:3 \[content: sabbath/);
    const none = await reg.call('files.find', { query: 'sabbath', in: [path.join(home, 'nope')] }, { workspaceDir: path.join(home, 'ws'), now: NOW });
    expect(none.status).toBe('failed');
    expect(none.summary).toMatch(/does not exist/);
  });
});
