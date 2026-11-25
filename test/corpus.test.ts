import { execFileSync } from 'node:child_process';
import { mkdir, readFile, readdir, symlink, utimes, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CorpusStore,
  browserAdapter,
  buildCorpusSummary,
  calendarAdapter,
  categoryOfDomain,
  collectInto,
  corpusItemsFromPairs,
  emailAdapter,
  filesAdapter,
  formatCorpusSummary,
  getAdapter,
  isAutomatedSender,
  projectFolderOf,
  queryCorpus,
  type CorpusItem,
} from '../src';
import { main } from '../src/cli';
import { occurrencesBetween, parseRRule } from '../src/corpus/recurrence';
import { parseVisitTime, visitFromRecord } from '../src/corpus/adapters/browser';
import { parseAddress, splitMbox } from '../src/corpus/adapters/email';
import { parseIcs } from '../src/corpus/adapters/calendar';
import { tempDir } from './helpers';

const NOW = '2026-06-15T12:00:00.000Z';
const DAY = 86_400_000;
const ago = (days: number): string => new Date(Date.parse(NOW) - days * DAY).toISOString();

function capture() {
  const lines: string[] = [];
  return { lines, io: { out: (l: string) => void lines.push(l), err: (l: string) => void lines.push(l) } };
}

const item = (over: Partial<CorpusItem> & Pick<CorpusItem, 'id' | 'source' | 'timestamp'>): CorpusItem => ({ kind: 'x', summary: over.id, ...over });

// ---------- files ----------

describe('files adapter', () => {
  async function notesTree(): Promise<string> {
    const root = await tempDir();
    await mkdir(path.join(root, 'trip'), { recursive: true });
    await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true });
    await mkdir(path.join(root, '.git'), { recursive: true });
    await writeFile(
      path.join(root, 'trip', 'plan.md'),
      '---\ntitle: Lisbon plan\ntags: [travel, "family"]\n---\n# Heading ignored by front matter title\n\n## Flights\nWe fly out on Friday with Priya Patel. #logistics\n\n## Hotel\nBook near the old town.\n',
    );
    await writeFile(path.join(root, 'ideas.txt'), 'Just a loose idea about a garden shed.\n');
    await writeFile(path.join(root, 'budget.csv'), 'month,category,amount\njan,rent,1200\nfeb,rent,1200\n');
    await writeFile(path.join(root, 'settings.json'), JSON.stringify({ theme: 'dark', retries: 3 }));
    await writeFile(path.join(root, 'node_modules', 'pkg', 'readme.md'), '# Should be ignored');
    await writeFile(path.join(root, '.git', 'notes.md'), '# hidden');
    await writeFile(path.join(root, '.secret.md'), '# hidden file');
    await writeFile(path.join(root, 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    await writeFile(path.join(root, 'fake.txt'), Buffer.from([0x68, 0x00, 0x69, 0x00, 0x00]));
    await utimes(path.join(root, 'trip', 'plan.md'), new Date('2026-06-10T09:00:00Z'), new Date('2026-06-10T09:00:00Z'));
    await utimes(path.join(root, 'ideas.txt'), new Date('2026-05-01T09:00:00Z'), new Date('2026-05-01T09:00:00Z'));
    await utimes(path.join(root, 'budget.csv'), new Date('2026-06-01T09:00:00Z'), new Date('2026-06-01T09:00:00Z'));
    await utimes(path.join(root, 'settings.json'), new Date('2026-04-01T09:00:00Z'), new Date('2026-04-01T09:00:00Z'));
    return root;
  }

  it('indexes notes, tables and data with title, headings, tags, snippet and modified time', async () => {
    const root = await notesTree();
    const items = await filesAdapter.collect({ path: root });
    expect(items.map((i) => path.basename(i.path!))).toEqual(['plan.md', 'budget.csv', 'ideas.txt', 'settings.json']); // newest first
    const plan = items[0]!;
    expect(plan).toMatchObject({ source: 'file', kind: 'note', title: 'Lisbon plan', timestamp: '2026-06-10T09:00:00.000Z' });
    expect(plan.tags).toEqual(expect.arrayContaining(['md', 'travel', 'family', 'logistics']));
    expect(plan.metadata).toMatchObject({ headings: expect.arrayContaining(['Flights', 'Hotel']) });
    expect(plan.summary).toContain('Priya Patel');
    const csv = items.find((i) => i.kind === 'table')!;
    expect(csv.summary).toBe('Table of 2 rows with columns: month, category, amount');
    expect(csv.summary).not.toContain('1200'); // values are never indexed
    expect(items.find((i) => i.kind === 'data')!.summary).toBe('JSON object with keys: theme, retries');
    expect(items.find((i) => i.title === 'ideas')).toBeTruthy(); // no heading: the file name
  });

  it('skips ignored folders, hidden files, binaries and unsupported types; never follows symlinks', async () => {
    const root = await notesTree();
    await symlink(path.join(root, 'trip'), path.join(root, 'loop')).catch(() => undefined);
    const paths = (await filesAdapter.collect({ path: root })).map((i) => i.path!);
    expect(paths.some((p) => p.includes('node_modules') || p.includes('.git') || p.endsWith('.secret.md') || p.endsWith('photo.png') || p.endsWith('fake.txt'))).toBe(false);
    expect(paths.filter((p) => p.endsWith('plan.md'))).toHaveLength(1);
    const custom = await filesAdapter.collect({ path: root, ignore: ['trip'] });
    expect(custom.some((i) => i.path!.includes('/trip/'))).toBe(false);
  });

  it('keeps only a short snippet of a huge file, honors --limit and extra roots, and reports a missing path', async () => {
    const root = await tempDir();
    await writeFile(path.join(root, 'big.md'), `# Big\n${'lorem ipsum dolor sit amet '.repeat(50_000)}`);
    const [big] = await filesAdapter.collect({ path: root });
    expect(big!.summary.length).toBeLessThanOrEqual(300);
    expect(JSON.stringify(big).length).toBeLessThan(2000);

    const a = await notesTree();
    const b = await tempDir();
    await writeFile(path.join(b, 'other.md'), '# Other root');
    expect((await filesAdapter.collect({ path: a, roots: [b], limit: 2 })).length).toBe(2);
    expect((await filesAdapter.collect({ path: a, roots: [b] })).some((i) => i.title === 'Other root')).toBe(true);
    await expect(filesAdapter.collect({ path: path.join(a, 'nope') })).rejects.toThrow(/Path not found/);
  });
});

// ---------- browser ----------

describe('browser adapter', () => {
  it('reads a generic JSON export: domain, title, visit frequency, timestamps; strips queries; merges and drops non-web', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'history.json');
    await writeFile(
      file,
      JSON.stringify([
        { url: 'https://www.Bank.example.org/accounts?session=SECRET#top', title: 'Accounts', visitCount: 12, lastVisitAt: '2026-06-14T08:00:00Z' },
        { url: 'https://bank.example.org/accounts/?other=1', title: 'Accounts', visitCount: 3, lastVisitAt: '2026-06-15T08:00:00Z' },
        { url: 'https://docs.example.org/plan', visitCount: 1, lastVisitAt: 1781500000000 },
        { url: 'chrome://settings', title: 'Settings', lastVisitAt: '2026-06-14T08:00:00Z' },
        { url: 'not a url', lastVisitAt: '2026-06-14T08:00:00Z' },
        { url: 'https://nowhere.example.org/', title: 'No time' },
      ]),
    );
    const items = await browserAdapter.collect({ path: file });
    expect(items).toHaveLength(2);
    const bank = items.find((i) => i.domain === 'bank.example.org')!;
    expect(bank).toMatchObject({ source: 'browser', kind: 'visit', title: 'Accounts', timestamp: '2026-06-15T08:00:00.000Z' });
    expect(bank.metadata).toEqual({ url: 'https://bank.example.org/accounts', visitCount: 15 });
    expect(JSON.stringify(items)).not.toContain('SECRET');
    expect(items.find((i) => i.domain === 'docs.example.org')!.title).toBe('docs.example.org/plan');
    expect((await browserAdapter.collect({ path: file, keepQuery: true })).find((i) => i.domain === 'bank.example.org' && (i.metadata as { url: string }).url.includes('session'))).toBeTruthy();
  });

  it('reads JSONL and honors limit', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'history.jsonl');
    await writeFile(file, ['a', 'b', 'c'].map((s, i) => JSON.stringify({ url: `https://${s}.example.org/`, title: s, visit_count: i + 1, last_visit_time: `2026-06-1${i}T00:00:00Z` })).join('\n'));
    const items = await browserAdapter.collect({ path: file, limit: 2 });
    expect(items.map((i) => i.domain)).toEqual(['c.example.org', 'b.example.org']);
  });

  it('understands Chromium, millisecond and Unix-second timestamps', () => {
    const chromium = (Date.parse('2026-06-14T08:00:00Z') + 11644473600000) * 1000; // microseconds since 1601
    expect(new Date(parseVisitTime(chromium)!).toISOString()).toBe('2026-06-14T08:00:00.000Z');
    expect(new Date(parseVisitTime(Date.parse('2026-06-14T08:00:00Z'))!).toISOString()).toBe('2026-06-14T08:00:00.000Z');
    expect(new Date(parseVisitTime(Date.parse('2026-06-14T08:00:00Z') / 1000)!).toISOString()).toBe('2026-06-14T08:00:00.000Z');
    expect(new Date(parseVisitTime(Date.parse('2026-06-14T08:00:00Z') / 1000 - 978307200, 'cocoa')!).toISOString()).toBe('2026-06-14T08:00:00.000Z');
    expect(parseVisitTime('garbage')).toBeUndefined();
    expect(visitFromRecord({ url: 'https://example.org' })).toBeUndefined();
  });

  const hasSqlite = (() => {
    try {
      execFileSync('sqlite3', ['--version']);
      return true;
    } catch {
      return false;
    }
  })();

  it.skipIf(!hasSqlite)('reads a Chromium-style database from a read-only copy, and a Safari-style one', async () => {
    const dir = await tempDir();
    const chromeTime = (iso: string): number => (Date.parse(iso) + 11644473600000) * 1000;
    const chrome = path.join(dir, 'History');
    execFileSync('sqlite3', [
      chrome,
      `CREATE TABLE urls (id INTEGER PRIMARY KEY, url TEXT, title TEXT, visit_count INTEGER, last_visit_time INTEGER);
       INSERT INTO urls (url, title, visit_count, last_visit_time) VALUES
         ('https://travel.example.org/trips', 'My trips', 7, ${chromeTime('2026-06-14T08:00:00Z')}),
         ('https://docs.example.org/notes', 'Notes', 2, ${chromeTime('2026-06-10T08:00:00Z')});`,
    ]);
    const before = await readFile(chrome);
    const items = await browserAdapter.collect({ path: chrome });
    expect(items.map((i) => [i.domain, i.timestamp, (i.metadata as { visitCount: number }).visitCount])).toEqual([
      ['travel.example.org', '2026-06-14T08:00:00.000Z', 7],
      ['docs.example.org', '2026-06-10T08:00:00.000Z', 2],
    ]);
    expect(Buffer.compare(before, await readFile(chrome))).toBe(0); // the original is untouched

    const safari = path.join(dir, 'Safari.db');
    const cocoa = (iso: string): number => Date.parse(iso) / 1000 - 978307200;
    execFileSync('sqlite3', [
      safari,
      `CREATE TABLE history_items (id INTEGER PRIMARY KEY, url TEXT, visit_count INTEGER);
       CREATE TABLE history_visits (id INTEGER PRIMARY KEY, history_item INTEGER, visit_time REAL, title TEXT);
       INSERT INTO history_items VALUES (1, 'https://scheduling.example.org/book', 4);
       INSERT INTO history_visits VALUES (1, 1, ${cocoa('2026-06-01T08:00:00Z')}, 'Old title'), (2, 1, ${cocoa('2026-06-12T08:00:00Z')}, 'Book a slot');`,
    ]);
    const [s] = await browserAdapter.collect({ path: safari });
    expect(s).toMatchObject({ domain: 'scheduling.example.org', title: 'Book a slot', timestamp: '2026-06-12T08:00:00.000Z' });

    const junk = path.join(dir, 'Other.db');
    execFileSync('sqlite3', [junk, 'CREATE TABLE t (x);']);
    await expect(browserAdapter.collect({ path: junk })).rejects.toThrow(/does not look like/);
    await expect(browserAdapter.collect({ path: chrome, sqlite3: 'definitely-not-a-binary' })).rejects.toThrow(/sqlite3/);
  });
});

// ---------- calendar ----------

const ICS = [
  'BEGIN:VCALENDAR',
  'VERSION:2.0',
  'BEGIN:VEVENT',
  'UID:sync-1@example.org',
  'DTSTART:20260616T150000Z',
  'DTEND:20260616T160000Z',
  'SUMMARY:Weekly sync\\, product',
  'LOCATION:https://meet.example.org/room-4',
  'ORGANIZER;CN=Sam Rivera:mailto:sam@example.org',
  'ATTENDEE;CN="Alex Chen";RSVP=TRUE:mailto:alex@example.org',
  'ATTENDEE:mailto:priya@example.org',
  'RRULE:FREQ=WEEKLY;BYDAY=TU',
  'BEGIN:VALARM',
  'ACTION:DISPLAY',
  'DESCRIPTION:Reminder noise',
  'END:VALARM',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:dentist@example.org',
  'DTSTART;VALUE=DATE:20260618',
  'SUMMARY:Dentist',
  'DESCRIPTION:Bring the forms\\nand the card',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:folded@example.org',
  'DTSTART:20260617T100000Z',
  'SUMMARY:A very long title that the exporter',
  '  folded onto a second line',
  'END:VEVENT',
  'BEGIN:VEVENT',
  'UID:cancelled@example.org',
  'DTSTART:20260617T090000Z',
  'SUMMARY:Cancelled thing',
  'STATUS:CANCELLED',
  'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

describe('calendar adapter', () => {
  it('parses .ics: folding, escapes, attendees, all-day, recurrence, alarms and cancellations', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'cal.ics');
    await writeFile(file, ICS);
    const items = await calendarAdapter.collect({ path: file });
    expect(items.map((i) => i.title).sort()).toEqual(['A very long title that the exporter folded onto a second line', 'Dentist', 'Weekly sync, product']);
    const sync = items.find((i) => i.title === 'Weekly sync, product')!;
    expect(sync).toMatchObject({ source: 'calendar', kind: 'event', actor: 'Sam Rivera', domain: 'meet.example.org', timestamp: '2026-06-16T15:00:00.000Z', tags: ['recurring'] });
    expect(sync.metadata).toMatchObject({ end: '2026-06-16T16:00:00.000Z', attendees: ['Alex Chen', 'priya@example.org'], recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=TU' });
    expect(sync.summary).toContain('repeats weekly on Tue');
    expect(items.find((i) => i.title === 'Dentist')!.metadata).toMatchObject({ allDay: true, recurring: false });
    expect(items.some((i) => i.title === 'Cancelled thing')).toBe(false);
    expect(items.find((i) => i.title?.startsWith('A very long'))!.title).toBe('A very long title that the exporter folded onto a second line');
    expect(JSON.stringify(items)).not.toContain('Reminder noise');
    expect(parseIcs(ICS)).toHaveLength(3);
  });

  it('parses JSON event lists with recurring flags and rules', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'events.json');
    await writeFile(
      file,
      JSON.stringify({
        events: [
          { summary: 'Standup', start: '2026-06-16T09:00:00Z', end: '2026-06-16T09:15:00Z', location: 'Room 2', attendees: [{ name: 'Sam Rivera', email: 'sam@example.org' }, 'alex@example.org'], recurring: 'FREQ=DAILY' },
          { summary: 'Offsite', start: '2026-06-20', recurring: true },
          { summary: 'Broken' },
        ],
      }),
    );
    const items = await calendarAdapter.collect({ path: file });
    expect(items).toHaveLength(2);
    const standup = items.find((i) => i.title === 'Standup')!;
    expect(standup.metadata).toMatchObject({ attendees: ['Sam Rivera', 'alex@example.org'], recurring: true, location: 'Room 2' });
    const offsite = items.find((i) => i.title === 'Offsite')!;
    expect(offsite.metadata).toMatchObject({ allDay: true, recurring: true });
    expect(offsite.metadata).not.toHaveProperty('rrule'); // cadence is never guessed
  });

  it('expands recurrence: weekly days, nth weekday, interval, count and until', () => {
    const start = Date.parse('2026-06-01T10:00:00Z'); // a Monday
    const iso = (ms: number[]): string[] => ms.map((m) => new Date(m).toISOString().slice(0, 16));
    const from = Date.parse('2026-06-10T00:00:00Z');
    const to = Date.parse('2026-06-24T00:00:00Z');
    expect(iso(occurrencesBetween(start, parseRRule('FREQ=WEEKLY;BYDAY=MO,WE')!, from, to))).toEqual(['2026-06-10T10:00', '2026-06-15T10:00', '2026-06-17T10:00', '2026-06-22T10:00']);
    expect(iso(occurrencesBetween(start, parseRRule('FREQ=WEEKLY;INTERVAL=2')!, from, to))).toEqual(['2026-06-15T10:00']);
    expect(iso(occurrencesBetween(start, parseRRule('FREQ=MONTHLY;BYDAY=2TU')!, Date.parse('2026-06-01T00:00:00Z'), Date.parse('2026-08-31T00:00:00Z')))).toEqual(['2026-06-09T10:00', '2026-07-14T10:00', '2026-08-11T10:00']);
    expect(iso(occurrencesBetween(start, parseRRule('FREQ=DAILY;COUNT=3')!, Date.parse('2026-06-01T00:00:00Z'), to))).toEqual(['2026-06-01T10:00', '2026-06-02T10:00', '2026-06-03T10:00']);
    expect(occurrencesBetween(start, parseRRule('FREQ=WEEKLY;UNTIL=20260610T000000Z')!, from, to)).toEqual([]);
    expect(parseRRule('weekly')).toMatchObject({ freq: 'WEEKLY', interval: 1 });
    expect(parseRRule('nonsense')).toBeUndefined();
  });
});

// ---------- email ----------

const MBOX = [
  'From sam@example.org Mon Jun 15 09:00:00 2026',
  'From: Sam Rivera <sam@Example.org>',
  'To: Me <me@mail.example.net>',
  'Subject: =?UTF-8?B?UXVhcnRlcmx5IHBsYW4g4oCTIGRyYWZ0?=',
  'Date: Mon, 15 Jun 2026 09:00:00 +0000',
  'Message-ID: <m1@example.org>',
  'Content-Type: multipart/alternative; boundary="b1"',
  '',
  '--b1',
  'Content-Type: text/plain; charset=utf-8',
  'Content-Transfer-Encoding: quoted-printable',
  '',
  'Hi,=20please review the draft by Friday. Caf=C3=A9 is on me.',
  '> quoted earlier text that must not appear',
  '',
  '-- ',
  'Sam, signature that must not appear',
  '--b1',
  'Content-Type: text/html; charset=utf-8',
  '',
  '<p>html copy</p>',
  '--b1--',
  '',
  'From me@mail.example.net Tue Jun 16 10:00:00 2026',
  'From: me@mail.example.net',
  'To: "Chen, Alex" <alex@travel.example.org>, priya@example.org',
  'Subject: Re: itinerary',
  'Date: Tue, 16 Jun 2026 10:00:00 +0000',
  'Content-Type: text/plain',
  'Content-Transfer-Encoding: base64',
  '',
  Buffer.from('Booked the 9am train. >From here on we are set.').toString('base64'),
  '',
].join('\n');

describe('email adapter', () => {
  it('parses .mbox: headers, encodings, multipart, snippets, sender domains and sent vs. received', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'mail.mbox');
    await writeFile(file, MBOX);
    expect(splitMbox(MBOX)).toHaveLength(2);
    const items = await emailAdapter.collect({ path: file, me: ['ME@mail.example.net'] });
    expect(items).toHaveLength(2);
    const [sent, received] = items; // newest first
    expect(received).toMatchObject({ source: 'email', kind: 'received', title: 'Quarterly plan – draft', actor: 'Sam Rivera', domain: 'example.org', timestamp: '2026-06-15T09:00:00.000Z' });
    expect(received!.summary).toBe('Hi, please review the draft by Friday. Café is on me.');
    expect(received!.summary).not.toMatch(/quoted earlier|signature/);
    expect(sent).toMatchObject({ kind: 'sent', actor: 'Chen, Alex', domain: 'travel.example.org' });
    expect(sent!.summary).toBe('Booked the 9am train. >From here on we are set.');
    expect(sent!.metadata).toMatchObject({ isFromMe: true, to: ['alex@travel.example.org', 'priya@example.org'] });
    const unknown = await emailAdapter.collect({ path: file });
    expect(unknown.every((i) => i.kind === 'message')).toBe(true); // without --me nothing is guessed
  });

  it('parses .eml files (single and a folder) and normalized JSONL with isFromMe', async () => {
    const dir = await tempDir();
    await writeFile(path.join(dir, 'a.eml'), 'From: Priya Patel <priya@example.org>\nTo: me@example.net\nSubject: Lunch?\nDate: Wed, 17 Jun 2026 12:00:00 +0000\n\nAre you free on Thursday?\n');
    await writeFile(
      path.join(dir, 'b.jsonl'),
      [
        { id: 'x1', from: 'Sam Rivera <sam@example.org>', to: ['me@example.net'], subject: 'Invoice', snippet: 'Invoice attached', date: '2026-06-01T08:00:00Z', isFromMe: false },
        { id: 'x2', from: 'me@example.net', to: 'sam@example.org', subject: 'Re: Invoice', snippet: 'Paid today', date: '2026-06-02T08:00:00Z', isFromMe: true },
        { id: 'x3', subject: 'No date' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    );
    const items = await emailAdapter.collect({ path: dir });
    expect(items.map((i) => [i.title, i.kind])).toEqual([['Lunch?', 'message'], ['Re: Invoice', 'sent'], ['Invoice', 'received']]);
    expect(items[1]).toMatchObject({ actor: 'sam@example.org', domain: 'example.org' });
    expect((await emailAdapter.collect({ path: dir, limit: 1 })).map((i) => i.title)).toEqual(['Lunch?']);
    expect(parseAddress('"Rivera, Sam" <SAM@Example.org>')).toEqual({ name: 'Rivera, Sam', address: 'sam@example.org' });
  });
});

// ---------- store ----------

describe('CorpusStore', () => {
  it('dedupes by id, updates changed items, reports invalid ones, and writes atomically', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'corpus', 'items.jsonl');
    const store = new CorpusStore(file);
    expect(await store.load()).toEqual([]);
    const a = item({ id: 'a', source: 'file', timestamp: '2026-06-01T00:00:00Z', summary: 'first' });
    const b = item({ id: 'b', source: 'email', timestamp: '2026-05-01T00:00:00Z', summary: 'second' });
    const r1 = await store.add([a, b, a, { nope: true }]);
    expect(r1).toMatchObject({ added: 2, updated: 0, unchanged: 1, total: 2 });
    expect(r1.rejected).toEqual([{ index: 3, reason: 'missing "id"' }]);
    const r2 = await store.add([a, b]);
    expect(r2).toMatchObject({ added: 0, updated: 0, unchanged: 2, total: 2 });
    const r3 = await store.add([{ ...a, summary: 'first, edited' }]);
    expect(r3).toMatchObject({ added: 0, updated: 1, unchanged: 0, total: 2 });
    const loaded = await store.load();
    expect(loaded.map((i) => i.id)).toEqual(['b', 'a']); // oldest first on disk
    expect(loaded.find((i) => i.id === 'a')!.summary).toBe('first, edited');
    expect(await readdir(path.dirname(file))).toEqual(['items.jsonl']); // no temp files left
  });

  it('dry run writes nothing; a corrupt line is skipped, not fatal; timestamps are normalized', async () => {
    const dir = await tempDir();
    const file = path.join(dir, 'items.jsonl');
    const store = new CorpusStore(file);
    const dry = await store.add([item({ id: 'a', source: 'file', timestamp: '2026-06-01T00:00:00+02:00' })], { dryRun: true });
    expect(dry).toMatchObject({ added: 1, total: 1 });
    await expect(readFile(file)).rejects.toThrow();
    await store.add([item({ id: 'a', source: 'file', timestamp: '2026-06-01T00:00:00+02:00' })]);
    await writeFile(file, `${await readFile(file, 'utf8')}{not json\n`);
    const loaded = await store.load();
    expect(loaded).toHaveLength(1);
    expect(loaded[0]!.timestamp).toBe('2026-05-31T22:00:00.000Z');
  });

  it('collecting the same source twice changes nothing; a re-edited note is updated, not duplicated', async () => {
    const dir = await tempDir();
    const notes = await tempDir();
    await writeFile(path.join(notes, 'a.md'), '# Alpha\nbody');
    const store = new CorpusStore(path.join(dir, 'items.jsonl'));
    const first = await collectInto(store, getAdapter('files'), { path: notes });
    expect(first.report).toMatchObject({ added: 1, total: 1 });
    expect((await collectInto(store, filesAdapter, { path: notes })).report).toMatchObject({ added: 0, unchanged: 1 });
    await writeFile(path.join(notes, 'a.md'), '# Alpha renamed\nnew body');
    await utimes(path.join(notes, 'a.md'), new Date('2026-06-01T00:00:00Z'), new Date('2026-06-01T00:00:00Z'));
    expect((await collectInto(store, filesAdapter, { path: notes })).report).toMatchObject({ added: 0, updated: 1, total: 1 });
    expect(() => getAdapter('telepathy')).toThrow(/Unknown source/);
  });
});

// ---------- summary ----------

const corpus: CorpusItem[] = [
  // An old habit: heavily visited two years ago.
  item({ id: 'old1', source: 'browser', kind: 'visit', domain: 'oldshop.example.org', timestamp: ago(730), metadata: { visitCount: 200 }, summary: 'old shop' }),
  item({ id: 'old2', source: 'browser', kind: 'visit', domain: 'oldshop.example.org', timestamp: ago(731), metadata: { visitCount: 150 }, summary: 'old shop' }),
  // A recent portal: a few visits, over several days.
  item({ id: 'b1', source: 'browser', kind: 'visit', domain: 'bank.example.org', timestamp: ago(1), metadata: { visitCount: 3 }, summary: 'bank' }),
  item({ id: 'b2', source: 'browser', kind: 'visit', domain: 'bank.example.org', timestamp: ago(3), metadata: { visitCount: 2 }, summary: 'bank' }),
  item({ id: 'b3', source: 'browser', kind: 'visit', domain: 'bank.example.org', timestamp: ago(6), metadata: { visitCount: 1 }, summary: 'bank' }),
  item({ id: 'e1', source: 'email', kind: 'received', domain: 'travel.example.org', timestamp: ago(2), summary: 'trip confirmation' }),
  item({ id: 'e2', source: 'email', kind: 'received', domain: 'gmail.com', timestamp: ago(2), summary: 'personal' }),
  item({ id: 'f1', source: 'file', kind: 'note', title: 'Roadmap', path: '/work/alpha/roadmap.md', timestamp: ago(2), summary: 'roadmap notes', tags: ['md'] }),
  item({ id: 'f2', source: 'file', kind: 'note', title: 'Retro', path: '/work/alpha/retro.md', timestamp: ago(5), summary: 'retro' }),
  item({ id: 'f3', source: 'file', kind: 'note', title: 'Old essay', path: '/archive/essay.md', timestamp: ago(900), summary: 'essay' }),
  item({ id: 'c1', source: 'calendar', kind: 'event', title: 'Dentist', timestamp: '2026-06-17T09:00:00.000Z', summary: 'Dentist', metadata: { end: '2026-06-17T10:00:00.000Z', recurring: false, location: 'Clinic' } }),
  item({ id: 'c2', source: 'calendar', kind: 'event', title: 'Conference next month', timestamp: '2026-07-20T09:00:00.000Z', summary: 'far away', metadata: { recurring: false } }),
  item({ id: 'c3', source: 'calendar', kind: 'event', title: 'Weekly sync', timestamp: '2026-01-06T15:00:00.000Z', summary: 'sync', metadata: { end: '2026-01-06T16:00:00.000Z', recurring: true, rrule: 'FREQ=WEEKLY;BYDAY=TU' } }),
  item({ id: 'c4', source: 'calendar', kind: 'event', title: 'Ended series', timestamp: '2025-01-06T15:00:00.000Z', summary: 'ended', metadata: { recurring: true, rrule: 'FREQ=WEEKLY;UNTIL=20250301T000000Z' } }),
  item({ id: 'k1', source: 'chat', kind: 'exchange', actor: 'Sam Rivera', timestamp: ago(1), summary: 'Sam Rivera: lunch? → sure' }),
];

describe('buildCorpusSummary', () => {
  const s = buildCorpusSummary(corpus, { now: NOW, halfLifeDays: 90 }); // calendar decay, passed explicitly

  it('counts volume by source, raw and recency-weighted', () => {
    expect(Object.fromEntries(s.bySource.map((v) => [v.source, v.count]))).toEqual({ browser: 5, email: 2, file: 3, calendar: 4, chat: 1 });
    expect(s.total).toBe(corpus.length);
    expect(s.halfLifeDays).toBe(90);
    // Browser has the most raw items, but the old ones barely count: share reflects recent life.
    const browser = s.bySource.find((v) => v.source === 'browser')!;
    expect(browser.weight).toBeLessThan(browser.count);
    expect(s.bySource.reduce((a, v) => a + v.share, 0)).toBeCloseTo(1, 2);
  });

  it('lets recent activity outweigh a two-year-old habit, even a far bigger one', () => {
    const raw = buildCorpusSummary(corpus, { now: NOW, halfLifeDays: 0 });
    expect(raw.domains[0]!.domain).toBe('oldshop.example.org'); // unweighted: the old habit wins
    expect(s.domains[0]!.domain).toBe('bank.example.org'); // weighted: the recent portal wins
    expect(s.domains.find((d) => d.domain === 'oldshop.example.org')!.weight).toBeLessThan(0.2);
    expect(raw.halfLifeDays).toBeUndefined();
    // A shorter half-life is harsher still.
    const sharp = buildCorpusSummary(corpus, { now: NOW, halfLifeDays: 14 });
    expect(sharp.domains.find((d) => d.domain === 'oldshop.example.org')!.weight).toBeLessThan(s.domains.find((d) => d.domain === 'oldshop.example.org')!.weight);
  });

  it('lists active domains and recurring portals; mail providers are not portals; categories come from the name', () => {
    expect(s.domains.map((d) => d.domain)).not.toContain('gmail.com');
    const bank = s.domains.find((d) => d.domain === 'bank.example.org')!;
    expect(bank).toMatchObject({ count: 6, activeDays: 3, recurring: true, category: 'banking', sources: ['browser'] });
    expect(s.portals.map((d) => d.domain)).toContain('bank.example.org');
    expect(s.portals.map((d) => d.domain)).not.toContain('travel.example.org');
    expect(s.domains.find((d) => d.domain === 'travel.example.org')).toMatchObject({ category: 'travel', sources: ['email'] });
    expect([categoryOfDomain('scheduling.example.org'), categoryOfDomain('docs.example.org'), categoryOfDomain('airtable.example.org'), categoryOfDomain('example.org')]).toEqual(['scheduling', 'docs', undefined, undefined]);
  });

  it('finds recently active projects and files', () => {
    expect(s.projects[0]).toMatchObject({ name: 'alpha', files: 2, path: '/work/alpha' });
    expect(s.projects.map((p) => p.name)).toEqual(['alpha', 'archive']);
    expect(s.recentFiles.map((f) => f.title)).toEqual(['Roadmap', 'Retro', 'Old essay']);
  });

  it('shows the next 7 days of commitments, expands recurring events and lists them separately', () => {
    expect(s.calendar.upcoming.map((u) => [u.title, u.start.slice(0, 16)])).toEqual([
      ['Dentist', '2026-06-17T09:00'],
      ['Weekly sync', '2026-06-16T15:00'],
    ].sort((a, b) => a[1]!.localeCompare(b[1]!)));
    expect(s.calendar.upcoming.find((u) => u.title === 'Weekly sync')).toMatchObject({ recurring: true, end: '2026-06-16T16:00:00.000Z' });
    expect(s.calendar.upcoming.find((u) => u.title === 'Dentist')).toMatchObject({ location: 'Clinic', recurring: false });
    expect(s.calendar.upcoming.map((u) => u.title)).not.toContain('Conference next month');
    expect(s.calendar.recurring).toEqual([{ title: 'Weekly sync', cadence: 'weekly on Tue', next: '2026-06-16T15:00:00.000Z' }]); // the ended series is gone
    expect(buildCorpusSummary(corpus, { now: NOW, horizonDays: 40 }).calendar.upcoming.map((u) => u.title)).toContain('Conference next month');
  });

  it('is deterministic and handles an empty corpus', () => {
    expect(buildCorpusSummary(corpus, { now: NOW, halfLifeDays: 90 })).toEqual(s);
    expect(buildCorpusSummary(corpus, { now: NOW })).toEqual(buildCorpusSummary(corpus, { now: NOW }));
    expect(buildCorpusSummary([], { now: NOW })).toMatchObject({ total: 0, bySource: [], domains: [], calendar: { upcoming: [], recurring: [] } });
  });
});

// ---------- query ----------

describe('queryCorpus', () => {
  const q = (query: string, extra = {}) => queryCorpus(corpus, { query, now: NOW, ...extra }).map((h) => h.item.id);

  it('finds items by title, domain, actor, tags, summary and path, with prefixes', () => {
    expect(q('roadmap')).toEqual(['f1']);
    expect(q('bank')).toEqual(['b1', 'b2', 'b3']); // newest first among equals
    expect(q('travel')[0]).toBe('e1');
    expect(q('Sam Rivera')).toEqual(['k1']);
    expect(q('dent')).toEqual(['c1']); // prefix
    expect(q('alpha')).toEqual(['f1', 'f2']); // matches the path
    expect(q('zzzz')).toEqual([]);
  });

  it('ranks by relevance first, then recency, and softens but never erases old matches', () => {
    const items = [
      item({ id: 'old-exact', source: 'email', title: 'Passport renewal', timestamp: ago(800), summary: 'x' }),
      item({ id: 'new-weak', source: 'email', timestamp: ago(1), summary: 'something about a passport' }),
      item({ id: 'new-exact', source: 'email', title: 'Passport renewal', timestamp: ago(1), summary: 'x' }),
    ];
    const ids = queryCorpus(items, { query: 'passport renewal', now: NOW }).map((h) => h.item.id);
    expect(ids).toEqual(['new-exact', 'old-exact', 'new-weak']);
    const flat = queryCorpus(items, { query: 'passport', now: NOW, halfLifeDays: 0 }).map((h) => h.item.id);
    expect(flat.slice(0, 2).sort()).toEqual(['new-exact', 'old-exact']); // no recency: ties on relevance
    expect(queryCorpus(items, { query: 'passport renewal', now: NOW })[0]!.matched).toEqual(['passport', 'renewal']);
  });

  it('filters by source and period, limits results and lists the newest with no query', () => {
    expect(q('bank', { sources: ['email'] })).toEqual([]);
    expect(q('example', { sources: ['files'] })).toEqual([]);
    expect(q('', { sources: ['file'] })).toEqual(['f1', 'f2', 'f3']);
    expect(q('bank', { sinceDays: 4 })).toEqual(['b1', 'b2']);
    expect(q('', { limit: 3 })).toHaveLength(3);
    expect(q('the of')).toHaveLength(10); // only stop words: browse mode
    expect(q('', { sinceDays: 30 })).not.toContain('f3');
    expect(q('conference', { sinceDays: 30 })).toEqual(['c2']); // upcoming items always pass the period filter
  });

  it('turns answered chats into corpus items so one query spans every source', () => {
    const chat = corpusItemsFromPairs([
      { id: 'p1', channel: 'sms', sender: 'Alex Chen', incoming: 'Dinner Friday?', reply: 'Yes, 7pm works', incomingAt: ago(2) },
      { id: 'p2', channel: 'sms', sender: 'Alex Chen', incoming: 'undated', reply: 'skipped' },
    ]);
    expect(chat).toHaveLength(1);
    expect(chat[0]).toMatchObject({ source: 'chat', kind: 'exchange', actor: 'Alex Chen', tags: ['sms'] });
    expect(queryCorpus([...corpus, ...chat], { query: 'dinner', now: NOW }).map((h) => h.item.source)).toEqual(['chat']);
  });
});

// ---------- CLI ----------

describe('rufus collect / rufus context', () => {
  it('collects every source into <workspace>/corpus/items.jsonl and is idempotent', async () => {
    const dir = await tempDir();
    const src = await tempDir();
    await mkdir(path.join(src, 'notes'));
    await writeFile(path.join(src, 'notes', 'garden.md'), '# Garden plan\nPlant tomatoes in May.');
    await writeFile(path.join(src, 'cal.ics'), ICS);
    await writeFile(path.join(src, 'history.json'), JSON.stringify([{ url: 'https://docs.example.org/garden', title: 'Garden doc', visitCount: 4, lastVisitAt: '2026-06-14T08:00:00Z' }]));
    await writeFile(path.join(src, 'mail.jsonl'), JSON.stringify({ id: 'm1', from: 'sam@example.org', to: ['me@example.net'], subject: 'Garden party', snippet: 'Saturday?', date: '2026-06-13T08:00:00Z', isFromMe: false }));

    const run = async (...args: string[]) => {
      const c = capture();
      await main(['--dir', dir, ...args], c.io);
      return c.lines.join('\n');
    };
    expect(await run('collect', 'files', path.join(src, 'notes'))).toMatch(/Read 1 item\(s\) from files .*\nAdded 1, updated 0, unchanged 0\. The corpus now holds 1 item/);
    expect(await run('collect', 'calendar', path.join(src, 'cal.ics'))).toContain('Added 3');
    expect(await run('collect', 'browser', path.join(src, 'history.json'))).toContain('Added 1');
    expect(await run('collect', 'email', path.join(src, 'mail.jsonl'), '--me', 'me@example.net')).toContain('Added 1');
    expect(await run('collect', 'email', path.join(src, 'mail.jsonl'))).toContain('Added 0, updated 0, unchanged 1');

    const lines = (await readFile(path.join(dir, 'corpus', 'items.jsonl'), 'utf8')).trim().split('\n');
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => (JSON.parse(l) as CorpusItem).source).sort()).toEqual(['browser', 'calendar', 'calendar', 'calendar', 'email', 'file']);
  });

  it('--dry-run reads and reports but writes nothing; --limit keeps the newest; errors are plain', async () => {
    const dir = await tempDir();
    const notes = await tempDir();
    for (const n of ['a', 'b', 'c']) await writeFile(path.join(notes, `${n}.md`), `# Note ${n}`);
    const run = async (...args: string[]) => {
      const c = capture();
      await main(['--dir', dir, ...args], c.io);
      return c.lines.join('\n');
    };
    const dry = await run('collect', 'files', notes, '--dry-run', '--limit', '2');
    expect(dry).toContain('Read 2 item(s) from files');
    expect(dry).toContain('Dry run (nothing written): would add 2');
    await expect(readFile(path.join(dir, 'corpus', 'items.jsonl'))).rejects.toThrow();
    await expect(run('collect', 'telepathy', notes)).rejects.toThrow(/Unknown source/);
    await expect(run('collect', 'files')).rejects.toThrow(/Usage: rufus collect/);
    await expect(run('collect', 'files', path.join(notes, 'missing'))).rejects.toThrow(/Path not found/);
    await expect(run('collect', 'calendar', notes, 'extra')).rejects.toThrow(/takes one path/);
  });

  it('context shows a snapshot, answers a query at $0, filters, outputs JSON and includes seeded chats', async () => {
    const dir = await tempDir();
    const src = await tempDir();
    await writeFile(path.join(src, 'roadmap.md'), '# Roadmap\nQ3 priorities.');
    await writeFile(path.join(src, 'history.json'), JSON.stringify([{ url: 'https://bank.example.org/', title: 'Bank', visitCount: 9, lastVisitAt: new Date().toISOString() }]));
    const run = async (...args: string[]) => {
      const c = capture();
      await main(['--dir', dir, ...args], c.io);
      return c.lines.join('\n');
    };
    expect(await run('context')).toContain('The corpus is empty');
    await mkdir(path.join(dir, 'history'), { recursive: true });
    await writeFile(path.join(dir, 'history', 'pairs.jsonl'), JSON.stringify({ id: 'p1', channel: 'sms', sender: 'Priya Patel', incoming: 'Roadmap review today?', reply: 'Yes at 3', incomingAt: new Date().toISOString() }) + '\n');
    await run('collect', 'files', src);
    await run('collect', 'browser', path.join(src, 'history.json'));

    const snapshot = await run('context');
    expect(snapshot).toContain('Life Context Snapshot (observation-weighted, half-life 200 items): 4 item(s)');
    expect(snapshot).toMatch(/chat: 1/);
    expect(snapshot).toContain('bank.example.org');
    expect(snapshot).toContain('[banking]');

    const hits = await run('context', 'roadmap');
    expect(hits).toContain('[file/note] Roadmap');
    expect(hits).toContain('[chat/exchange]');
    expect(await run('context', 'roadmap', '--source', 'chat')).not.toContain('[file/note]');
    expect(await run('context', 'nothing-matches-this')).toContain('Nothing in the corpus matches "nothing-matches-this"');
    expect((JSON.parse(await run('context', 'roadmap', '--json', '--limit', '1')) as unknown[]).length).toBe(1);
    expect((JSON.parse(await run('context', '--json', '--source', 'browser')) as { total: number }).total).toBe(1);
    await expect(run('context', '--half-life', 'abc')).rejects.toThrow(/--half-life/);
    expect(await run('context', '--half-life', '0')).toContain('unweighted');
  });
});

// ---------- v7.1: observation recency, project grouping, automated mail, diverse queries ----------

describe('observation-rank recency in the corpus', () => {
  const HOUR = 3_600_000;
  it('adapts at the evidence pace by default, even when every timestamp falls inside 24 hours', () => {
    const base = Date.parse(NOW) - 20 * HOUR;
    const stamp = (k: number): string => new Date(base + k * 0.1 * HOUR).toISOString();
    const old = Array.from({ length: 40 }, (_, k) => item({ id: `old${k}`, source: 'browser', kind: 'visit', domain: 'oldhabit.example.org', timestamp: stamp(k), summary: 'old' }));
    const fresh = Array.from({ length: 40 }, (_, k) => item({ id: `new${k}`, source: 'browser', kind: 'visit', domain: 'newfocus.example.org', timestamp: stamp(40 + k), summary: 'new' }));
    const all = [...old, ...fresh];
    const byObs = buildCorpusSummary(all, { now: NOW, halfLifeObservations: 10 });
    expect(byObs.halfLifeObservations).toBe(10);
    expect(byObs.domains[0]!.domain).toBe('newfocus.example.org');
    expect(byObs.domains[0]!.weight).toBeGreaterThan(byObs.domains[1]!.weight * 5);
    // A calendar timer cannot tell them apart: same day, near-equal weights.
    const byDays = buildCorpusSummary(all, { now: NOW, halfLifeDays: 90 });
    expect(byDays.domains[0]!.weight / byDays.domains[1]!.weight).toBeLessThan(1.05);
    // The default is observation rank (200): a recent shift already tilts the picture.
    const def = buildCorpusSummary(all, { now: NOW });
    expect(def.halfLifeObservations).toBe(200);
    expect(def.halfLifeDays).toBeUndefined();
    expect(def.domains[0]!.domain).toBe('newfocus.example.org');
    expect(formatCorpusSummary(def)[0]).toContain('observation-weighted, half-life 200 items');
    expect(formatCorpusSummary(buildCorpusSummary(all, { now: NOW, halfLifeDays: 90 }))[0]).toContain('recency-weighted, half-life 90 days');
    expect(buildCorpusSummary(all, { now: NOW, halfLifeDays: 0 }).halfLifeObservations).toBeUndefined();
  });

  it('upcoming events keep full weight and take no rank from past evidence', () => {
    const items = [
      item({ id: 'past', source: 'file', kind: 'note', path: '/w/proj/a.md', timestamp: ago(1), summary: 'a' }),
      item({ id: 'future', source: 'calendar', kind: 'event', title: 'Next week', timestamp: '2026-06-20T09:00:00.000Z', summary: 'e', metadata: { recurring: false } }),
    ];
    const s = buildCorpusSummary(items, { now: NOW });
    expect(s.bySource.find((v) => v.source === 'file')!.weight).toBe(1);
    expect(s.bySource.find((v) => v.source === 'calendar')!.weight).toBe(1);
  });

  it('queryCorpus ranks recency by observation too, and still lets a perfect old match beat a weak new one', () => {
    const items = [
      item({ id: 'a', source: 'file', kind: 'note', title: 'Budget plan', timestamp: ago(400), summary: 'budget' }),
      item({ id: 'b', source: 'file', kind: 'note', title: 'Budget plan v2', timestamp: ago(399), summary: 'budget' }),
    ];
    const hits = queryCorpus(items, { query: 'budget', now: NOW, halfLifeObservations: 1 });
    expect(hits.map((h) => h.item.id)).toEqual(['b', 'a']);
    expect(hits[0]!.score).toBeGreaterThan(hits[1]!.score);
  });
});

describe('smart project grouping', () => {
  it('climbs out of generic and date-stamped subfolders to the real project', () => {
    expect(projectFolderOf('/w/project-a/outbox/2026-11-27')).toBe('/w/project-a');
    expect(projectFolderOf('/w/project-a/docs')).toBe('/w/project-a');
    expect(projectFolderOf('/w/project-a/2026-11-27-session')).toBe('/w/project-a');
    expect(projectFolderOf('/w/project-a/private/drafts')).toBe('/w/project-a');
    expect(projectFolderOf('/w/project-a')).toBe('/w/project-a');
    expect(projectFolderOf('/outbox')).toBe('/outbox'); // nothing meaningful above: keep what we have
  });

  it('merges counts for the same real folder, never lists a generic name, and disambiguates equal names', () => {
    const f = (id: string, p: string, d: number): CorpusItem => item({ id, source: 'file', kind: 'note', path: p, title: path.basename(p), timestamp: ago(d), summary: id });
    const items = [
      f('1', '/w/project-a/outbox/2026-11-27/captions.txt', 1),
      f('2', '/w/project-a/outbox/2026-11-26/captions.txt', 2),
      f('3', '/w/project-a/docs/readme.md', 3),
      f('4', '/w/project-a/private/notes.md', 3),
      f('5', '/w/project-a/plan.md', 4),
      f('6', '/w/project-b/tmp/scratch.md', 2),
      f('7', '/other/project-b/src/main.md', 5),
    ];
    const s = buildCorpusSummary(items, { now: NOW, topN: 10 });
    const names = s.projects.map((p) => p.name);
    expect(names).not.toContain('outbox');
    expect(names).not.toContain('docs');
    expect(names).not.toContain('private');
    expect(names).not.toContain('tmp');
    expect(names.some((n) => /^\d{4}-/.test(n))).toBe(false);
    const a = s.projects.find((p) => p.path === '/w/project-a')!;
    expect(a).toMatchObject({ name: 'project-a', files: 5 });
    expect(s.projects.filter((p) => p.path.endsWith('project-a'))).toHaveLength(1);
    // Two different real folders both called project-b get a parent prefix.
    expect(names).toContain('w/project-b');
    expect(names).toContain('other/project-b');
    expect(formatCorpusSummary(s).join('\n')).toContain('project-a: 5 file(s)');
  });
});

describe('automated alerts are kept apart from sites and people', () => {
  const mail = (id: string, from: string, domain: string, d = 1): CorpusItem =>
    item({ id, source: 'email', kind: 'received', domain, actor: from.split('@')[0], timestamp: ago(d), summary: id, metadata: { from } });

  it('detects noreply-style addresses and notification hosts, only for email', () => {
    expect(isAutomatedSender(mail('a', 'noreply@bank.example.org', 'bank.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('b', 'no-reply@shop.example.org', 'shop.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('c', 'donotreply@x.example.org', 'x.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('d', 'notifications@app.example.org', 'app.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('e', 'alerts@bank.example.org', 'bank.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('f', 'mailer-daemon@mail.example.org', 'mail.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('g', 'team@accounts.example.org', 'accounts.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('h', 'x@business-updates.example.org', 'business-updates.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('i', 'x@messages.example.org', 'messages.example.org'))).toBe(true);
    expect(isAutomatedSender(mail('j', 'priya@travel.example.org', 'travel.example.org'))).toBe(false);
    expect(isAutomatedSender(item({ id: 'k', source: 'browser', kind: 'visit', domain: 'accounts.example.org', timestamp: ago(1), summary: 'k' }))).toBe(false);
  });

  it('lists real portals and humans cleanly, with automated senders on their own line', () => {
    const items = [
      item({ id: 'v1', source: 'browser', kind: 'visit', domain: 'bank.example.org', timestamp: ago(1), metadata: { visitCount: 5 }, summary: 'bank' }),
      mail('h1', 'priya@travel.example.org', 'travel.example.org', 1),
      mail('n1', 'noreply@bank.example.org', 'bank.example.org', 1),
      mail('n2', 'alerts@bank.example.org', 'bank.example.org', 2),
      mail('n3', 'no-reply@accounts.example.org', 'accounts.example.org', 1),
      mail('n4', 'noreply@accounts.example.org', 'accounts.example.org', 3),
      mail('n5', 'noreply@accounts.example.org', 'accounts.example.org', 4),
    ];
    const s = buildCorpusSummary(items, { now: NOW });
    expect(s.domains.map((d) => d.domain).sort()).toEqual(['bank.example.org', 'travel.example.org']);
    expect(s.domains.find((d) => d.domain === 'bank.example.org')).toMatchObject({ count: 5, sources: ['browser'] }); // alerts did not inflate the portal
    expect(s.automated.map((a) => [a.domain, a.count])).toEqual([['accounts.example.org', 3], ['bank.example.org', 2]]);
    const text = formatCorpusSummary(s).join('\n');
    expect(text).toContain('Active sites & human contacts:');
    expect(text).toContain('Automated alerts / digests: accounts.example.org (3), bank.example.org (2).');
    const sites = text.slice(text.indexOf('Active sites'), text.indexOf('Automated alerts'));
    expect(sites).not.toContain('accounts.example.org');
  });
});

describe('queryCorpus dedupes near-duplicates and diversifies sources', () => {
  const caption = (k: number): CorpusItem => item({ id: `cap${k}`, source: 'file', kind: 'note', title: 'captions.txt', path: `/w/p/outbox/2026-11-2${k}/captions.txt`, timestamp: ago(k), summary: 'captions for the launch video', tags: ['txt'] });
  const items: CorpusItem[] = [
    ...[1, 2, 3, 4, 5].map(caption),
    item({ id: 'chat1', source: 'chat', kind: 'exchange', actor: 'Sam Rivera', timestamp: ago(30), summary: 'Sam Rivera: can you send the captions? → sent' }),
    item({ id: 'mail1', source: 'email', kind: 'received', title: 'Captions for review', actor: 'Priya', timestamp: ago(40), summary: 'please review the captions' }),
    item({ id: 'cal1', source: 'calendar', kind: 'event', title: 'Captions review', timestamp: ago(50), summary: 'sync', metadata: { recurring: false } }),
    item({ id: 'web1', source: 'browser', kind: 'visit', title: 'Captions style guide', domain: 'docs.example.org', timestamp: ago(60), summary: 'guide' }),
  ];

  it('collapses same-source same-title items to maxPerTitle (default 2) unless opted out', () => {
    const ids = (o = {}) => queryCorpus(items, { query: 'captions', now: NOW, sources: ['file'], ...o }).map((h) => h.item.id);
    expect(ids()).toHaveLength(2);
    expect(ids({ maxPerTitle: 3 })).toHaveLength(3);
    expect(ids({ dedupeTitles: false })).toHaveLength(5);
    // Different titles are not duplicates.
    expect(queryCorpus([...items, item({ id: 'x', source: 'file', kind: 'note', title: 'captions-notes.txt', timestamp: ago(1), summary: 'captions' })], { query: 'captions', now: NOW, sources: ['file'] })).toHaveLength(3);
  });

  it('does not let five identical files crowd out matching chats, emails, events and visits', () => {
    const hits = queryCorpus(items, { query: 'captions', now: NOW, limit: 5 });
    const found = new Set(hits.map((h) => h.item.source));
    expect(found).toEqual(new Set(['file', 'chat', 'email', 'calendar', 'browser']));
    expect(hits.filter((h) => h.item.source === 'file').length).toBeLessThanOrEqual(2);
    // Results stay sorted by score.
    expect(hits.map((h) => h.score)).toEqual([...hits.map((h) => h.score)].sort((a, b) => b - a));
    // Without dedupe and diversity, the files take every slot.
    const crowded = queryCorpus(items, { query: 'captions', now: NOW, limit: 5, dedupeTitles: false, diversify: false });
    expect(crowded.every((h) => h.item.source === 'file')).toBe(true);
  });

  it('keeps a plain top-N when restricted to one source or when only one source matches', () => {
    expect(queryCorpus(items, { query: 'captions', now: NOW, sources: ['chat'], limit: 5 }).map((h) => h.item.id)).toEqual(['chat1']);
    expect(queryCorpus(items.filter((i) => i.source === 'file'), { query: 'captions', now: NOW, limit: 5, dedupeTitles: false }).map((h) => h.item.id)).toHaveLength(5);
  });
});
