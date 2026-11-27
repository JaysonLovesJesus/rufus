/* Rufus dashboard: a live instrument plate of the outline.
   Vanilla JS + SVG, no build step. Every motion marks a real event (an event arriving, a turn of a wake,
   live or played back) and always ends. Colour has one meaning each:
   signal orange = Rufus acting right now, ice blue = the world arriving, amber = needs you, red = a real failure. */
'use strict';

(() => {
  // ------------------------------------------------------------------ utilities
  const $ = (sel, root = document) => root.querySelector(sel);
  const NS = 'http://www.w3.org/2000/svg';
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const PARTICLE_MAX_MS = 2500;

  function el(tag, attrs, ...kids) {
    const n = document.createElement(tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) setAttr(n, k, v);
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  function s(tag, attrs, ...kids) {
    const n = document.createElementNS(NS, tag);
    if (attrs) for (const [k, v] of Object.entries(attrs)) setAttr(n, k, v);
    for (const k of kids.flat(Infinity)) if (k !== null && k !== undefined && k !== false) n.append(k instanceof Node ? k : document.createTextNode(String(k)));
    return n;
  }
  function setAttr(n, k, v) {
    if (v === undefined || v === null || v === false) return;
    if (k === 'class') n.setAttribute('class', v);
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else n.setAttribute(k, v === true ? '' : String(v));
  }
  const fmtNum = (n) => (typeof n === 'number' && Number.isFinite(n) ? n.toLocaleString('en-US') : '–');
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
  const short = (t, n) => {
    const x = String(t ?? '').replace(/\s+/g, ' ').trim();
    if (x.length <= n) return x;
    // Cut at the last word boundary (never mid-word), unless that throws away too much.
    let cut = x.slice(0, n - 1);
    const sp = cut.lastIndexOf(' ');
    if (sp > n * 0.6) cut = cut.slice(0, sp);
    return `${cut.replace(/[\s,;:(\-–—/]+$/, '')}…`;
  };
  const fmtCost = (usd) => (!Number.isFinite(usd) ? '' : usd > 0 && usd < 0.01 ? 'under 1¢' : `$${usd.toFixed(2)}`);
  const plural = (n, one, many = `${one}s`) => `${fmtNum(n)} ${n === 1 ? one : many}`;
  const capFirst = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);
  const onActivate = (fn) => (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      e.stopPropagation();
      fn();
    }
  };

  // ------------------------------------------------------------------ time, in plain local words
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const clockFmt = new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
  const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const startOfDay = (t) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  function fmtWhen(iso, now = Date.now()) {
    const t = typeof iso === 'number' ? iso : Date.parse(iso);
    if (!Number.isFinite(t)) return '';
    const days = Math.round((startOfDay(t) - startOfDay(now)) / DAY);
    const clock = timeFmt.format(new Date(t));
    if (days === 0) return clock;
    if (days === -1) return `Yesterday ${clock}`;
    if (days === 1) return `Tomorrow ${clock}`;
    if (Math.abs(days) < 6) return `${dayFmt.format(new Date(t))} ${clock}`;
    return `${dateFmt.format(new Date(t))}, ${clock}`;
  }
  function fmtIn(ms) {
    if (ms <= 30e3) return 'due now';
    const mins = Math.round(ms / MIN);
    if (mins < 60) return `in ${mins}m`;
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    if (h < 48) return `in ${h}h${m ? ` ${m}m` : ''}`;
    return `in ${Math.round(h / 24)} days`;
  }
  function fmtAgo(ms) {
    if (ms < 45e3) return 'just now';
    const mins = Math.round(ms / MIN);
    if (mins < 60) return `${mins}m ago`;
    const h = Math.floor(mins / 60);
    if (h < 24) return `${h}h${h < 4 && mins % 60 ? ` ${mins % 60}m` : ''} ago`;
    return `${Math.round(h / 24)}d ago`;
  }
  function fmtDur(ms) {
    if (!Number.isFinite(ms)) return '';
    if (ms < 1000) return `${Math.round(ms)}ms`;
    if (ms < 60e3) return `${(ms / 1000).toFixed(ms < 10e3 ? 1 : 0)}s`;
    const m = Math.floor(ms / 60e3);
    const sec = Math.round((ms % 60e3) / 1000);
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m${sec ? ` ${sec}s` : ''}`;
  }
  /** A ticking stopwatch: 4:07, 1:04:07. */
  function fmtWatch(ms) {
    const t = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(t / 3600);
    const m = Math.floor((t % 3600) / 60);
    const sec = String(t % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
  }
  /** A countdown that visibly moves every second: 32:14, then 2h 05m, then 3d. */
  function fmtCountdown(ms) {
    if (ms <= 1000) return 'now';
    if (ms < HOUR) return fmtWatch(ms);
    const h = Math.floor(ms / HOUR);
    if (h < 48) return `${h}h ${String(Math.floor((ms % HOUR) / MIN)).padStart(2, '0')}m`;
    return `${Math.round(h / 24)}d`;
  }
  /** A calm span: 1h 20m, 3d. */
  function fmtSpan(ms) {
    const mins = Math.max(0, Math.round(ms / MIN));
    if (mins < 60) return `${mins}m`;
    const h = Math.floor(mins / 60);
    if (h < 48) return `${h}h ${String(mins % 60).padStart(2, '0')}m`;
    return `${Math.round(h / 24)}d`;
  }

  /** Free text from the workspace, made readable: ISO times in local words, gap ids as their titles. */
  const ISO_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
  const DATE_RE = /(?<![\w/.-])\d{4}-\d{2}-\d{2}(?![\w/.-])/g;
  const GAP_RE = /\bgap_(?:root|[a-z0-9]{6})\b/g;
  const UUID_RE = /\b(?:mcp:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const WATCH_ID_RE = /\bwatch_[0-9a-f]{6}\b(?:\s*\/\s*)?/g;
  const WAKE_ID_RE = /\bwake_[0-9a-f]{8}\b/g;
  const TOOL_RE = /\b[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\b/g;
  function clean(text) {
    let t = String(text ?? '');
    t = t.replace(ISO_RE, (m) => {
      const v = Date.parse(m.replace(' ', 'T'));
      return Number.isFinite(v) ? fmtWhen(v) : m;
    });
    t = t.replace(DATE_RE, (m) => {
      const v = Date.parse(`${m}T12:00:00`);
      return Number.isFinite(v) ? dateFmt.format(new Date(v)) : m;
    });
    const titles = state.snap?.gapTitles ?? {};
    t = t.replace(GAP_RE, (m) => (titles[m] ? `“${short(titles[m], 44)}”` : m === 'gap_root' ? '“the root gap”' : 'a gap'));
    // Internal ids mean nothing to the owner: thread uuids, watch ids, wake ids.
    t = t.replace(UUID_RE, '').replace(WATCH_ID_RE, '').replace(WAKE_ID_RE, 'a wake');
    t = t.replace(TOOL_RE, (m) => (isTool(m) ? toolWords(m) : m));
    return t.replace(/\(\s*\)/g, '').replace(/\(\s+/g, '(').replace(/[ \t]+([,)])/g, '$1').replace(/[ \t]{2,}/g, ' ');
  }

  /** Tools in the owner's words (the raw id stays in tooltips only). */
  const TOOL_WORDS = {
    send_message: 'send a message', edit_message: 'edit a message', react_message: 'react to a message', sleep: 'go to sleep',
    'tools.list_all': 'list his tools', 'tools.create': 'build a new tool', 'tools.repair': 'repair a tool', 'tools.rollback': 'roll back a tool',
    'memory.search': 'search memory', 'skills.save': 'update a brain skill',
    'brain.investigate': 'investigate', 'brain.plan': 'plan', 'brain.create': 'create', 'brain.verify': 'verify',
    'gaps.create': 'add a gap', 'gaps.approve': 'approve a gap', 'gaps.update': 'update a gap',
    'gaps.close': 'close a verified gap', 'gaps.note': 'note on a gap', 'gaps.retarget': "change a gap's target",
    'watch.set': 'schedule a next move', 'approvals.approve': 'carry out an approved move', 'approvals.deny': 'drop a declined move',
    'system.startup_snapshot': 'check his startup state', 'self.upgrade': 'upgrade himself', 'self.restart': 'restart himself',
    'self.inspect_tool': 'inspect a tool', 'self.recent_activity': 'review his recent activity', 'self.reasoning': 'review his own reasoning',
    'beeper.read_chat': 'read a chat', 'beeper.recent': 'check recent chats', 'beeper.send': 'send a chat message',
    'browser.agent': 'use the browser', 'browser.recent': 'check browser history',
    'calendar.today': 'check the calendar', 'calendar.write': 'change the calendar',
    'deploy.fly': 'check Fly deploys', 'deploy.vercel': 'check Vercel deploys',
    'files.list': 'list files', 'files.read': 'read a file', 'files.search': 'search files', 'files.write': 'write a file',
    'git.inspect': 'inspect a repo', 'gmail.read_message': 'read an email', 'gmail.recent': 'check email', 'gmail.reply': 'reply to an email', 'gmail.tidy': 'tidy the inbox',
    'instagram.recent': 'check Instagram', 'instagram.reply': 'reply on Instagram', 'life.files': 'search documents',
    'mac.apps': 'check open apps', 'mac.control': 'control the Mac', 'morning.briefing': 'make the morning briefing',
    'projects.status': 'check projects', 'shell.run': 'run a command', 't3.inspect': 'check coding threads', 't3.thread': 'run a coding thread',
    'todos.update': 'update the to-do list', 'web.fetch': 'read a web page', 'web.search': 'search the web', 'youtube.latest': 'check YouTube',
  };
  function isTool(id) {
    return Object.hasOwn(TOOL_WORDS, id) || !!state.snap?.tools?.some((t) => t.id === id);
  }
  function toolWords(id) {
    if (!id) return '';
    if (Object.hasOwn(TOOL_WORDS, id)) return TOOL_WORDS[id];
    // A tool he built himself: its id, read as words.
    return String(id).replace(/[._]+/g, ' ').trim();
  }

  // ------------------------------------------------------------------ vocabulary
  const SENSE_LABEL = { message: 'Messages', email: 'Email', calendar: 'Calendar', screen: 'Active app', browser: 'Browser', file: 'Downloads', system: 'System', other: 'Other', watch: 'Wake-ups', self: 'His own actions' };
  const LEVEL_WORDS = { never: 'Blocked', rehearse: 'Rehearse', draft: 'Draft and ask', act_and_report: 'Do and report', act_quietly: 'Do quietly' };
  const LEVEL_SHORT = { never: 'never', rehearse: 'rehearse', draft: 'draft', act_and_report: 'report', act_quietly: 'quiet' };
  const LADDER = ['never', 'rehearse', 'draft', 'act_and_report', 'act_quietly'];
  const STATUS_WORDS = { ok: 'Done', failed: 'Failed', timed_out: 'Timed out', pending_approval: 'Waiting for your yes', invalid_input: 'Rejected', rehearsed: 'Rehearsed' };
  const GAP_STATUS = { open: 'Open', proposed: 'Proposed', waiting: 'Waiting', closed: 'Closed', dropped: 'Dropped' };
  const GAP_GLYPH = { root: '◆', open: '○', proposed: '◐', waiting: '‖', closed: '●', dropped: '×', standing: '↻' };
  const CONNECTOR_LABEL = { telegram: 'Telegram', beeper: 'Beeper', gmail: 'Gmail', calendar: 'Calendar', 'browser-history': 'Browser history', repos: 'Code repos', watches: 'Wake-ups' };

  function triggerWords(tr) {
    if (!tr) return 'Unknown trigger';
    const k = tr.kind;
    switch (tr.source) {
      case 'message':
        if (k === 'owner_direct') return 'Message from you';
        if (k === 'assistant_sent') return 'His own message';
        return tr.actor ? `Message from ${tr.actor}` : 'A message';
      case 'email': return 'Email';
      case 'screen': return 'App switch';
      case 'calendar': return 'Calendar';
      case 'browser': return 'Browser';
      case 'file': return 'Download';
      case 'system': return k === 'startup' ? 'Restart' : k === 'sense_broken' ? 'A sense broke' : 'System';
      case 'watch': return k === 't3_thread_finished' ? 'Thread finished' : k === 't3_thread_unreachable' ? 'Thread unreachable' : 'Scheduled wake-up';
      case 'gap': return 'Empty board (old trigger)';
      case 'self': return 'His own actions';
      default: return tr.source ? tr.source[0].toUpperCase() + tr.source.slice(1) : 'Event';
    }
  }

  const GATE_REJECT = {
    no_gap: 'Rejected by code: the move named no gap',
    unknown_gap: 'Rejected by code: it named a gap that isn’t on the tree',
    root_gap_write: 'Rejected by code: the root gap only finds gaps',
    unreadable: 'Rejected by code: Decide’s reply couldn’t be read',
  };
  function gateOf(turn, levels) {
    const r = turn.receipt || {};
    const sum = r.summary || '';
    if (turn.toolId === 'sleep') {
      return r.status === 'ok' ? { tone: 'ok', text: 'Accepted: every gap has a next move' } : { tone: 'fail', text: `Refused: ${short(clean(sum.replace(/^Not yet:\s*/, '')), 140)}` };
    }
    if (r.error === 'neverAllow' || /^Blocked by Trust/.test(sum)) return { tone: 'fail', level: 'never', text: 'Blocked: this tool is never allowed' };
    if (r.status === 'invalid_input' && GATE_REJECT[r.error]) return { tone: 'fail', rejected: true, text: GATE_REJECT[r.error] };
    if (r.rehearsed || /^\[REHEARSE ONLY/.test(sum)) return { tone: 'wait', level: 'rehearse', text: 'Rehearse: recorded what it would do, ran nothing' };
    if (r.status === 'pending_approval') return { tone: 'wait', level: 'draft', text: 'Draft and ask: held for your yes' };
    const lvl = levels?.[turn.toolId];
    if (r.status === 'invalid_input') return { tone: 'fail', level: lvl, text: 'Passed; the tool rejected its input' };
    return { tone: 'ok', level: lvl, text: `${LEVEL_WORDS[lvl] || 'Allowed'} · ran` };
  }
  function statusOf(turn) {
    const r = turn.receipt || {};
    if (r.rehearsed || /^\[REHEARSE ONLY/.test(r.summary || '')) return 'rehearsed';
    return r.status || 'ok';
  }
  const toneOfStatus = (st) => (st === 'ok' || st === 'rehearsed' ? 'ok' : st === 'pending_approval' ? 'wait' : 'fail');
  function endingWord(e) {
    return e === 'sleep' ? 'asleep' : e === 'cap' ? 'turn cap' : e === 'safety' ? 'safety net' : e === 'crashed' ? 'crashed' : e === 'unreadable' ? 'unreadable replies' : '';
  }

  // ------------------------------------------------------------------ state + data
  const state = {
    snap: undefined,
    timeline: undefined,
    hours: 24,
    wakeFilter: 'acted',
    wakeLimit: 24,
    gapFilter: 'all',
    gapQuery: '',
    wakeQuery: '',
    openGaps: new Set(),
    showStanding: false,
    seenEvents: undefined,
    sheet: undefined, // { kind: 'node', part } | { kind: 'wake', id }
    player: undefined,
    liveDismissed: undefined,
    plateSize: 0,
    streamUp: false,
  };

  async function getJSON(url) {
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return res.json();
  }

  async function refresh(files) {
    const needTimeline = !files || files.some((f) => /events|wakes|decisions/.test(f));
    const [snap, tl] = await Promise.all([getJSON('/api/snapshot'), needTimeline ? getJSON(`/api/timeline?hours=${state.hours}`) : Promise.resolve(state.timeline)]);
    const prev = state.snap;
    state.snap = snap;
    state.timeline = tl;
    renderAll();
    if (prev) spawnArrivals(prev, snap);
    else state.seenEvents = new Set(snap.recentEvents.map((e) => e.id));
    await syncLive(prev, snap);
  }

  let refreshTimer;
  let pendingFiles = new Set();
  function scheduleRefresh(files) {
    for (const f of files) pendingFiles.add(f);
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const fs = [...pendingFiles];
      pendingFiles = new Set();
      refresh(fs).catch(showError);
    }, 90);
  }

  let stream;
  let bannerTimer;
  function setStreamUp(up) {
    state.streamUp = up;
    clearTimeout(bannerTimer);
    // A blip during a reconnect isn't news; a drop that lasts is.
    if (up) $('#streamBanner').hidden = true;
    else bannerTimer = setTimeout(() => ($('#streamBanner').hidden = state.streamUp), 1500);
  }
  function connectStream() {
    try {
      stream = new EventSource('/api/stream');
    } catch {
      setStreamUp(false);
      return;
    }
    stream.addEventListener('open', () => setStreamUp(true));
    stream.addEventListener('change', (ev) => {
      try {
        scheduleRefresh(JSON.parse(ev.data).files || []);
      } catch {
        scheduleRefresh(['live.json']);
      }
    });
    stream.addEventListener('hello', () => {
      setStreamUp(true);
      if (state.snap) scheduleRefresh(['events.jsonl', 'wakes.jsonl', 'live.json']);
    });
    stream.addEventListener('error', () => {
      setStreamUp(false);
      // The browser retries on its own unless the stream is closed for good; then start a new one.
      if (stream.readyState === EventSource.CLOSED) setTimeout(connectStream, 3000);
    });
  }

  function showError(err) {
    console.warn(err);
    $('#foot').textContent = `Couldn’t read the dashboard data (${err?.message ?? err}). Retrying on the next change.`;
  }

  // ------------------------------------------------------------------ render all
  function renderAll() {
    renderRail();
    renderStatement();
    renderReadout();
    Plate.render();
    renderGaps();
    renderNeeds();
    renderTimeline();
    renderWakeList();
    renderFoot();
    if (state.sheet?.kind === 'node') renderNodeSheet(state.sheet.part, false);
  }

  // ------------------------------------------------------------------ the glance
  function lastTurn(live) {
    return live?.turns?.length ? live.turns[live.turns.length - 1] : undefined;
  }
  function servingGap() {
    const live = state.snap?.live;
    if (live?.status !== 'awake') return undefined;
    for (let i = (live.turns || []).length - 1; i >= 0; i--) if (live.turns[i].gapId) return live.turns[i].gapId;
    return undefined;
  }
  function humanizeLabel(raw) {
    const x = clean(raw || '').replace(/\/(?:Users|home)\/[^/\s]+\//g, '~/');
    const reset = /(?:resets?\s+(?:at\s+)?|parked until\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(x);
    if (/5-hour limit|weekly limit|rate[ -]?limit|All providers failed|parked until/i.test(x)) {
      return reset ? `Resume after Claude limit resets (${reset[1]})` : 'Resume when AI provider is back';
    }
    if (/^Resume:\s*the last wake ended before these gaps had a next move/i.test(x)) return 'Quick return for gaps from the previous wake';
    return x;
  }

  /** What only the owner can unblock: approvals, proposed gaps, broken senses. Waiting-on gaps are listed but not counted. */
  const brokenSenses = (snap) => (snap.anatomy.senseHealth ?? []).filter((h) => h.status === 'broken');
  const ownerNeeds = (snap) => snap.approvals.length + snap.gaps.filter((g) => g.status === 'proposed').length + brokenSenses(snap).length;

  function meter(pct, tone) {
    const w = 40;
    const v = clamp(Number(pct) || 0, 0, 100);
    return s('svg', { class: `meter${tone ? ` ${tone}` : ''}`, width: w, height: 6, viewBox: `0 0 ${w} 6`, 'aria-hidden': 'true' }, s('line', { class: 'm-track', x1: 0, x2: w, y1: 3, y2: 3 }), v > 0 ? s('line', { class: 'm-fill', x1: 0, x2: Math.max(1, (w * v) / 100).toFixed(1), y1: 3, y2: 3 }) : null);
  }

  function renderRail() {
    const snap = state.snap;
    const live = snap.live;
    const now = Date.now();
    const st = $('#railState');
    if (live.status === 'awake') {
      st.className = 'rail-state awake';
      st.replaceChildren(el('i', { class: 'sig', 'aria-hidden': 'true' }), 'Awake ', el('span', { class: 'num', 'data-watch': live.startedAt }, live.startedAt ? fmtWatch(now - Date.parse(live.startedAt)) : ''));
    } else {
      st.className = 'rail-state';
      st.replaceChildren(el('i', { class: 'sig', 'aria-hidden': 'true' }), 'Asleep ', live.since ? el('span', { class: 'num', 'data-span': live.since, title: `since ${fmtWhen(live.since)}` }, fmtSpan(now - Date.parse(live.since))) : null);
    }
    const daemon = $('#daemon');
    daemon.className = `rail-item${snap.daemon.up ? '' : ' fail'}`;
    daemon.textContent = snap.daemon.up ? 'daemon ok' : 'daemon down';
    daemon.title = `Daemon on :${snap.daemon.port} ${snap.daemon.up ? 'is answering' : 'isn’t answering'}`;

    const c = snap.credits || {};
    const cr = $('#credits');
    cr.replaceChildren();
    if (c.pausedUntil) {
      cr.className = 'rail-item credits warn';
      cr.append(`paused · resets ${c.resetLabel || fmtWhen(c.pausedUntil)}`, c.localModel ? el('span', { class: 'dim' }, ` · local ${short(c.localModel.replace(/\.gguf$/i, ''), 24)}`) : null);
      cr.title = `Claude hit its ${c.limitWindow || ''} limit. Falling back to the other providers.`;
    } else {
      cr.className = 'rail-item credits';
      const low = (p) => (Number.isFinite(p) && p < 15 ? 'warn' : '');
      cr.append(
        el('span', { class: `cr ${low(c.left5hPct)}` }, '5h ', meter(c.left5hPct, low(c.left5hPct)), el('span', { class: 'num' }, `${fmtNum(c.left5hPct)}%`)),
        el('span', { class: `cr ${low(c.left7dPct)}` }, '7d ', meter(c.left7dPct, low(c.left7dPct)), el('span', { class: 'num' }, `${fmtNum(c.left7dPct)}%`)),
      );
      cr.title = `Claude credit left: ${c.left5hPct}% of the 5-hour window, ${c.left7dPct}% of the week${c.localModel ? `. Local fallback: ${c.localModel}` : ''}`;
    }

    const needCount = ownerNeeds(snap);
    const chip = $('#needsChip');
    chip.hidden = needCount === 0;
    chip.replaceChildren(el('span', { class: 'num' }, String(needCount)), needCount === 1 ? ' needs you' : ' need you');
    const light = document.documentElement.dataset.theme === 'light';
    $('#themeBtn').innerHTML = light ? MOON : SUN;
    $('#themeBtn').setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
    document.title = live.status === 'awake' ? 'Rufus · awake' : 'Rufus · asleep';
  }
  const SUN = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.2"/><g stroke="currentColor" stroke-width="1.2" stroke-linecap="round"><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></g></svg>';
  const MOON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z" fill="none" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>';

  function renderStatement() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const st = $('#statement');
    const th = $('#thought');
    const ml = $('#machineLine');
    st.replaceChildren();
    ml.replaceChildren();
    th.hidden = true;
    const live = snap.live;
    const next = snap.anatomy.sleep.next;

    if (live.status === 'awake') {
      const t = lastTurn(live);
      const gapId = servingGap();
      st.append(
        el('span', { class: 'st-word awake' }, 'Awake'),
        ' ',
        live.startedAt ? el('span', { 'data-ago': live.startedAt }, `for ${fmtDur(Date.now() - Date.parse(live.startedAt))}`) : null,
        ...(gapId ? [', serving ', el('span', { class: 'st-gap' }, `“${short(snap.gapTitles[gapId] ?? 'a gap', 70)}”`), '.'] : [', reading the Desk.']),
      );
      if (t?.thought) {
        th.hidden = false;
        th.textContent = `“${short(clean(t.thought), 220)}”`;
      }
      ml.append(
        el('span', null, t ? `last move: ${toolWords(t.toolId)} · ${(STATUS_WORDS[t.status] ?? t.status ?? '').toLowerCase()}` : 'deciding the first move'),
        el('span', null, `woke on: ${triggerWords(live.trigger).toLowerCase()}`),
        el('span', null, `turn ${(live.turns?.length ?? 0) + 1} of ${snap.anatomy.repeat.cap}`),
      );
    } else {
      if (!snap.daemon.up) st.append(el('span', { class: 'st-word fail' }, 'Not running.'), ' ');
      st.append(el('span', { class: 'st-word' }, snap.daemon.up ? 'Asleep' : 'Last seen asleep'));
      st.append(live.since ? ` since ${fmtWhen(live.since, now)}. ` : '. ');
      if (next?.at) st.append('Next wake ', el('span', { class: 'num' }, fmtWhen(next.at, now)), ', ', el('span', { class: 'num', 'data-in': next.at }, fmtIn(Date.parse(next.at) - Date.now())), '.');
      else st.append('Nothing scheduled to wake him.');
      if (next?.at) ml.append(el('span', { class: 'to' }, el('span', { class: 'k' }, 'to '), short(humanizeLabel(next.label), 140)));
      const lw = snap.wakes[0];
      if (lw) {
        ml.append(
          el(
            'button',
            { class: 'link', type: 'button', onclick: () => openWake(lw.wakeId), title: 'Play the last wake back' },
            `last wake ${fmtAgo(Date.now() - Date.parse(lw.at))}: ${triggerWords(lw.trigger).toLowerCase()} · ${plural(lw.turns, 'move')}${lw.sent ? ` · said ${lw.sent}` : ''}${lw.ending !== 'sleep' ? ` · ${endingWord(lw.ending)}` : ''} →`,
          ),
        );
      }
    }
  }

  function renderReadout() {
    const snap = state.snap;
    const t = snap.telemetry || {};
    const a = snap.anatomy;
    const pct = (v) => (Number.isFinite(v) ? `${v}%` : '–');
    const items = [
      { k: 'Median turns', v: fmtNum(t.medianTurns), part: 8, title: 'Median turns per wake, last 100 wakes' },
      { k: 'Bouncer slept', v: pct(t.bouncerSleepPct), part: 3, title: 'Share of events the Bouncer let him sleep through' },
      { k: 'SetFit', v: Number.isFinite(t.setfitMs) ? `${t.setfitMs}ms` : '–', part: 3, title: 'Median local Bouncer call' },
      { k: 'Crashes 24h', v: fmtNum(t.crashed24h), part: 8, tone: t.crashed24h > 0 ? 'fail' : '', title: 'Wakes that crashed in the last 24 hours' },
      { k: 'Clean sleep', v: pct(t.cleanSleepPct), part: 10, tone: Number.isFinite(t.cleanSleepPct) && t.cleanSleepPct < 80 ? 'warn' : '', title: 'Wakes that ended with an accepted sleep, 24h' },
      { k: 'Self-opt gaps', v: fmtNum(t.standingGaps), part: 4, title: 'Standing self-optimization gaps' },
      { k: 'Spend 24h', v: a.desk.metered24h > 0 ? fmtCost(a.desk.cost24h) : '–', part: 5, title: a.desk.metered24h > 0 ? `Model spend over ${plural(a.desk.metered24h, 'metered wake')}, ${plural(a.desk.modelCalls24h, 'model call')}` : 'No metered wakes in 24h' },
    ];
    $('#readout').replaceChildren(
      ...items.map((it) =>
        el('div', { class: `ro${it.tone ? ` ${it.tone}` : ''}`, role: 'button', tabindex: '0', title: it.title, onclick: () => openNodeSheet(it.part), onkeydown: onActivate(() => openNodeSheet(it.part)) }, el('dt', null, it.k), el('dd', { class: 'num' }, it.v)),
      ),
    );
  }

  // ------------------------------------------------------------------ the plate
  const Plate = {
    svg: undefined,
    base: undefined,
    fx: undefined,
    g: undefined,
    nodes: {},
    edges: {},
    on: { nodes: [], tones: {}, edges: new Set(), edgeTone: {}, gap: undefined, level: undefined },

    init() {
      this.svg = $('#plateSvg');
      this.base = s('g');
      this.fx = s('g', { 'aria-hidden': 'true' });
      this.svg.append(this.base, this.fx);
      const ro = new ResizeObserver(() => {
        const w = Math.round(this.svg.parentElement.clientWidth);
        if (w && w !== state.plateSize) {
          state.plateSize = w;
          if (state.snap) this.render();
        }
      });
      ro.observe(this.svg.parentElement);
    },

    geometry(W) {
      const senses = (state.snap?.anatomy.senses ?? []).filter((x) => x.id !== 'other' || x.count24h > 0);
      if (W < 720) return this.tallGeometry(W, senses);
      const compact = W < 1120;
      const roomy = W > 1560;
      const H = compact ? 450 : roomy ? 520 : 480;
      const yC = compact ? 256 : roomy ? 292 : 272;
      const r = compact ? 94 : roomy ? 132 : 114;
      const x0 = compact ? 128 : 156;
      const xM = Math.max(x0 + (compact ? 88 : 104), W * 0.215);
      const xB = Math.max(xM + (compact ? 112 : 128), W * 0.345);
      const xR = Math.max(xB + (compact ? 150 : 112) + r, W * 0.585);
      const xS = Math.min(W - 96, Math.max(xR + r + (compact ? 110 : 230), W * 0.88));
      const n = senses.length;
      const rowGap = compact ? 28 : roomy ? 34 : 31;
      const rows = senses.map((sense, i) => ({ ...sense, y: yC + (i - (n - 1) / 2) * rowGap }));
      const half = compact ? 100 : roomy ? 124 : 112;
      return { mode: 'wide', compact, W, H, yC, r, x0, xM, xB, xR, xS, rows, memTop: yC - half, memBot: yC + half };
    },

    tallGeometry(W, senses) {
      const rows = senses.map((sense, i) => ({ ...sense, y: 64 + i * 27 }));
      const lastY = rows.length ? rows[rows.length - 1].y : 64;
      const xM = W - 40;
      const yB = lastY + 56;
      const r = Math.min(86, W * 0.24);
      const yR = yB + 236;
      return { mode: 'tall', W, H: yR + r + 196, x0: Math.min(168, W * 0.48), xM, yB, xR: W / 2, yC: yR, r, rows, memTop: 54, memBot: lastY + 14 };
    },

    /** Station positions on the ring and the arc paths between them. */
    stations(g) {
      const { xR, yC, r } = g;
      const at = (deg, rad = r) => [xR + rad * Math.cos((deg * Math.PI) / 180), yC + rad * Math.sin((deg * Math.PI) / 180)];
      const tall = g.mode === 'tall';
      // wide: clockwise from the left; tall: counter-clockwise from the top.
      const deg = tall ? { desk: 270, decide: 180, trust: 90, tools: 0, repeat: 315 } : { desk: 180, decide: 270, trust: 0, tools: 90, repeat: 135 };
      const sweep = tall ? 0 : 1;
      const arc = (a, b) => {
        const [x1, y1] = at(a);
        const [x2, y2] = at(b);
        return `M${x1.toFixed(1)},${y1.toFixed(1)} A${r},${r} 0 0 ${sweep} ${x2.toFixed(1)},${y2.toFixed(1)}`;
      };
      return {
        at,
        deg,
        dir: tall ? -1 : 1,
        pos: Object.fromEntries(Object.entries(deg).map(([k, d]) => [k, at(d)])),
        arcs: {
          'desk-decide': arc(deg.desk, deg.decide),
          'decide-trust': arc(deg.decide, deg.trust),
          'trust-tools': arc(deg.trust, deg.tools),
          'tools-desk': arc(deg.tools, deg.desk),
        },
      };
    },

    render() {
      const snap = state.snap;
      if (!snap || !this.svg) return;
      const W = Math.max(320, Math.round(this.svg.parentElement.clientWidth || 1200));
      const g = this.geometry(W);
      this.g = g;
      this.svg.setAttribute('viewBox', `0 0 ${W} ${g.H}`);
      this.svg.setAttribute('width', String(W));
      this.svg.setAttribute('height', String(g.H));
      this.svg.classList.toggle('breathe', snap.live.status === 'awake');
      this.nodes = {};
      this.edges = {};
      const root = s('g');
      if (g.mode === 'wide') this.drawWide(root, g, snap);
      else this.drawTall(root, g, snap);
      this.base.replaceChildren(root);
      for (const lbl of root.querySelectorAll('.hit-me')) this.addHit(lbl);
      this.applyHighlight();
    },

    // ---- shared pieces
    edge(parent, id, d, cls = '') {
      const p = s('path', { class: `p-edge ${cls}`, d });
      this.edges[id] = { el: p, d };
      parent.append(p);
      return p;
    },
    chevron(parent, d, at = 0.5) {
      const tmp = s('path', { d });
      this.fx.append(tmp);
      const len = tmp.getTotalLength();
      const p1 = tmp.getPointAtLength(len * at - 3);
      const p2 = tmp.getPointAtLength(len * at + 3);
      tmp.remove();
      const ang = (Math.atan2(p2.y - p1.y, p2.x - p1.x) * 180) / Math.PI;
      const m = { x: (p1.x + p2.x) / 2, y: (p1.y + p2.y) / 2 };
      parent.append(s('path', { d: 'M-2.6,-2.8 L1.4,0 L-2.6,2.8', class: 'p-chev', transform: `translate(${m.x.toFixed(1)},${m.y.toFixed(1)}) rotate(${ang.toFixed(1)})` }));
    },
    marker(grp, x, y, { r = 6, halo = 14 } = {}) {
      grp.append(s('circle', { class: 'halo', cx: x, cy: y, r: halo }), s('circle', { class: 'ring', cx: x, cy: y, r }), s('circle', { class: 'dot', cx: x, cy: y, r: Math.max(1.8, r * 0.38) }));
    },
    bindPart(grp, part) {
      grp.addEventListener('click', () => openNodeSheet(part));
      grp.addEventListener('keydown', onActivate(() => openNodeSheet(part)));
    },
    node(parent, part, x, y, label, opts = {}) {
      const grp = s('g', { class: 'p-node', 'data-part': String(part), tabindex: '0', role: 'button', 'aria-label': `${label.name}${label.meta ? `: ${label.meta}` : ''}. Open details.` });
      if (opts.marker !== false) this.marker(grp, x, y, opts);
      if (opts.health) grp.classList.add(`health-${opts.health}`);
      grp.append(this.labelBlock(label, true));
      parent.append(grp);
      this.nodes[part] = { el: grp, x, y };
      this.bindPart(grp, part);
      return grp;
    },
    labelBlock({ x, y, anchor = 'start', no, name, meta }, hit = false) {
      const gEl = s('g', { class: hit ? 'lbl hit-me' : 'lbl' });
      gEl.append(s('text', { x, y, 'text-anchor': anchor }, s('tspan', { class: 'l-no' }, no), s('tspan', { class: 'l-name', dx: '6' }, name)));
      if (meta) gEl.append(s('text', { x, y: y + 14, 'text-anchor': anchor, class: 'l-meta' }, meta));
      return gEl;
    },
    addHit(grp) {
      try {
        const b = grp.getBBox();
        const pad = 4;
        grp.insertBefore(s('rect', { class: 'hit', x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2 }), grp.firstChild);
      } catch {
        /* not rendered yet */
      }
    },

    /** One short line per part. The full numbers live in the inspector. */
    metrics(snap) {
      const a = snap.anatomy;
      const now = Date.parse(snap.now) || Date.now();
      const sensesTotal = a.senses.reduce((n, x) => n + x.count24h, 0);
      const broken = brokenSenses(snap).length;
      const b = a.bouncer;
      const gc = a.gaps;
      const next = a.sleep.next;
      return {
        now,
        senses: broken ? `${broken} not working` : `${fmtNum(sensesTotal)} in 24h`,
        memory: `${fmtNum(a.memory.events)} events`,
        bouncer: `${b.model === 'setfit' ? 'SetFit' : 'prototype'} · ${fmtNum(b.examples)} ex.`,
        woke: `woke ${fmtNum(b.wake24h)}`,
        slept: b.sleep24h === undefined ? 'slept –' : `slept ${fmtNum(b.sleep24h)}`,
        gaps: [gc.open && `${gc.open} open`, gc.waiting && `${gc.waiting} waiting`, gc.proposed && `${gc.proposed} proposed`].filter(Boolean).join(' · ') || 'only the root',
        desk: `${fmtNum(a.desk.wakes24h)} wakes · ${fmtNum(a.desk.acted24h)} acted`,
        decide: `${fmtNum(a.decide.moves24h)} moves`,
        trust: snap.approvals.length ? `${snap.approvals.length} held for you` : '',
        repeat: `longest ${a.repeat.longest24h}/${a.repeat.cap}`,
        tools: `${fmtNum(a.tools.total)} tools${a.tools.broken?.length ? ` · ${a.tools.broken.length} failing` : ''}`,
        sleep: next?.at ? `next ${fmtWhen(next.at, now)} · ${a.sleep.timers + a.sleep.threads} in motion` : 'nothing scheduled',
        self: `self ${fmtNum(a.memory.self24h)}`,
        nextWake: next?.at ? `wakes himself ${fmtWhen(next.at, now)}` : 'no wake-up set',
      };
    },

    drawSenses(root, g, snap, wide) {
      const now = Date.parse(snap.now) || Date.now();
      const grp = s('g', { class: 'p-node senses-node', 'data-part': '1', tabindex: '0', role: 'button', 'aria-label': 'Senses. Open details.' });
      const head = wide ? { x: 0, y: g.rows[0].y - 38 } : { x: 0, y: 22 };
      grp.append(this.labelBlock({ x: head.x, y: head.y, no: '01', name: 'Senses', meta: this.metrics(snap).senses }, true));
      for (const row of g.rows) {
        const idle = row.count24h === 0;
        const broken = row.health === 'broken';
        const ym = wide ? g.yC + (row.y - g.yC) * 0.36 : (g.memTop + g.memBot) / 2 + (row.y - (g.rows[0].y + g.rows[g.rows.length - 1].y) / 2) * 0.62;
        const xEnd = g.xM - 9;
        const d = `M${g.x0},${row.y} C${g.x0 + 44},${row.y} ${xEnd - 56},${ym.toFixed(1)} ${xEnd},${ym.toFixed(1)}`;
        const rg = s('g', { class: `sense-row${idle ? ' idle' : ''}${broken ? ' broken' : ''}`, 'data-sense': row.id });
        const fiber = s('path', { class: 'fiber', d });
        this.edges[`fiber:${row.id}`] = { el: fiber, d, row: rg };
        rg.append(
          s('rect', { class: 'hit', x: -4, y: row.y - 13, width: g.x0 + 8, height: 26 }),
          fiber,
          s('circle', { class: 'end', cx: g.x0, cy: row.y, r: 2 }),
          s('text', { x: 0, y: row.y + 4, class: 'sense-name' }, row.label),
          s('text', { x: g.x0 - 9, y: row.y + 3.5, class: 'sense-count', 'text-anchor': 'end' }, broken ? 'down' : idle ? '–' : fmtNum(row.count24h)),
          s('title', null, broken ? row.problem ?? 'Not working' : idle ? `${row.label}: quiet in 24h` : `${row.label}: ${fmtNum(row.count24h)} in 24h, last ${fmtWhen(row.lastAt, now)}`),
        );
        grp.append(rg);
      }
      this.bindPart(grp, 1);
      root.append(grp);
      this.nodes[1] = { el: grp, x: g.x0, y: g.yC };
    },

    drawMemory(root, g, snap, labelPos) {
      const m = this.metrics(snap);
      const grp = this.node(root, 2, g.xM, g.memBot, { ...labelPos, no: '02', name: 'Memory', meta: m.memory }, { marker: false });
      const h = g.memBot - g.memTop;
      grp.append(s('rect', { class: 'mem-col', x: g.xM - 8, y: g.memTop, width: 16, height: h }));
      const ev = snap.recentEvents.slice(-Math.floor((h - 8) / 3.6));
      const ticks = s('g', { class: 'mem-ticks' });
      ev.forEach((e, i) => {
        const y = g.memBot - 5 - (ev.length - 1 - i) * 3.6;
        ticks.append(s('line', { class: `mem-tick${e.sense === 'self' ? ' self' : ''}`, x1: g.xM - 5, x2: g.xM + 5, y1: y.toFixed(1), y2: y.toFixed(1), opacity: (0.3 + 0.7 * ((i + 1) / ev.length)).toFixed(2) }));
      });
      grp.append(ticks);
    },

    /** 08 Repeat drawn as the ring itself: one tick per allowed turn, filled as turns are used. */
    drawRepeat(parent, g, st) {
      const cap = state.snap.anatomy.repeat.cap || 25;
      const grp = s('g', { class: 'repeat-ticks', 'aria-hidden': 'true' });
      const inner = g.r - (g.mode === 'tall' ? 15 : 17);
      const outer = g.r - (g.mode === 'tall' ? 10 : 11);
      const step = 360 / cap;
      this.repeatTicks = [];
      for (let i = 0; i < cap; i++) {
        const a = st.deg.desk + st.dir * (i + 0.5) * step;
        const [x1, y1] = st.at(a, inner);
        const [x2, y2] = st.at(a, outer);
        const t = s('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1) });
        grp.append(t);
        this.repeatTicks.push(t);
      }
      parent.append(grp);
    },

    drawWide(root, g, snap) {
      const m = this.metrics(snap);
      const st = this.stations(g);
      const { yC, r, xR, xB, xM, xS } = g;
      const P = st.pos;

      const edges = s('g');
      root.append(edges);
      edges.append(s('circle', { class: 'p-ring', cx: xR, cy: yC, r }));
      this.drawRepeat(edges, g, st);
      this.edge(edges, 'mem-bouncer', `M${xM + 8},${yC} L${xB - 2},${yC}`);
      this.edge(edges, 'bouncer-desk', `M${xB},${yC} L${P.desk[0] - 6},${yC}`);
      this.edge(edges, 'bouncer-tray', `M${xB},${yC + 26} L${xB},${yC + 66}`);
      for (const [id, d] of Object.entries(st.arcs)) this.edge(edges, id, d);
      this.edge(edges, 'trust-sleep', `M${P.trust[0] + 6},${yC} L${xS - 7},${yC}`);
      const yRet = g.H - 20;
      const last = g.rows[g.rows.length - 1];
      this.edge(edges, 'return', `M${xS},${yC + 7} L${xS},${yRet - 8} Q${xS},${yRet} ${xS - 8},${yRet} L${g.x0 + 8},${yRet} Q${g.x0},${yRet} ${g.x0},${yRet - 8} L${g.x0},${last.y + 5}`, 'faint');
      const selfD = `M${P.tools[0] - 7},${P.tools[1] + 2} C${P.tools[0] - 120},${P.tools[1] + 30} ${xM + 150},${g.memBot + 60} ${xM},${g.memBot + 2}`;
      this.edge(edges, 'self', selfD, 'faint');
      for (const id of ['desk-decide', 'decide-trust', 'trust-tools', 'tools-desk']) this.chevron(edges, st.arcs[id]);
      this.chevron(edges, this.edges['trust-sleep'].d, 0.5);
      this.chevron(edges, this.edges['return'].d, 0.55);

      this.drawGaps(root, g, snap, { cx: xR, top: 22 }, m);

      root.append(
        s('text', { class: 'edge-label', x: (xB + P.desk[0]) / 2, y: g.compact ? yC - 8 : yC + 16, 'text-anchor': 'middle' }, m.woke),
        s('text', { class: 'edge-label', x: xB, y: yC + 86, 'text-anchor': 'middle' }, m.slept),
        s('text', { class: 'edge-label', x: (xS + g.x0) / 2 + 40, y: yRet - 6, 'text-anchor': 'middle' }, m.nextWake),
        s('text', { class: 'edge-label', x: xM + 60, y: g.memBot + 42, 'text-anchor': 'start' }, m.self),
      );

      this.drawSenses(root, g, snap, true);
      this.drawMemory(root, g, snap, { x: xM, y: g.memTop - 30, anchor: 'middle' });
      const bouncer = this.node(root, 3, xB, yC, { x: xB, y: yC - (g.compact ? 70 : 60), anchor: 'middle', no: '03', name: 'Bouncer', meta: m.bouncer }, { marker: false });
      bouncer.append(
        s('path', { class: 'gate-bar', d: `M${xB - 5},${yC - 26} H${xB + 5} M${xB},${yC - 26} V${yC - 7} M${xB - 5},${yC - 7} H${xB + 5}` }),
        s('path', { class: 'gate-bar', d: `M${xB - 5},${yC + 7} H${xB + 5} M${xB},${yC + 7} V${yC + 26} M${xB - 5},${yC + 26} H${xB + 5}` }),
        s('line', { class: 'tray', x1: xB - 12, x2: xB + 12, y1: yC + 70, y2: yC + 70 }),
        s('circle', { class: 'halo', cx: xB, cy: yC, r: 14 }),
      );

      const cx = (x) => x.toFixed(1);
      const toolsBroken = snap.anatomy.tools.broken?.length ? 'fail' : undefined;
      this.node(root, 5, P.desk[0], P.desk[1], g.compact ? { x: cx(P.desk[0] - 12), y: yC + 34, anchor: 'end', no: '05', name: 'Desk', meta: m.desk } : { x: cx(P.desk[0] - 14), y: yC - 34, anchor: 'end', no: '05', name: 'Desk', meta: m.desk });
      this.node(root, 6, P.decide[0], P.decide[1], { x: cx(P.decide[0] + 16), y: P.decide[1] - 14, anchor: 'start', no: '06', name: 'Decide', meta: m.decide });
      this.node(root, 7, P.trust[0], P.trust[1], { x: cx(P.trust[0] + 16), y: g.compact ? yC + 24 : yC - 34, anchor: 'start', no: '07', name: 'Trust', meta: m.trust });
      this.node(root, 9, P.tools[0], P.tools[1], { x: cx(P.tools[0] + 16), y: P.tools[1] + 24, anchor: 'start', no: '09', name: 'Tools', meta: m.tools }, { health: toolsBroken });
      this.node(root, 8, P.repeat[0], P.repeat[1], { x: cx(P.repeat[0] - 12), y: P.repeat[1] + (g.compact ? 40 : 22), anchor: 'end', no: '08', name: 'Repeat', meta: m.repeat }, { r: 4, halo: 10 });
      this.drawLadder(root, P.trust[0] + 16, g.compact ? yC + 58 : yC + 22, snap);
      this.node(root, 10, xS, yC, { x: xS, y: yC - 46, anchor: 'middle', no: '10', name: 'Sleep', meta: m.sleep }, { r: 7, halo: 16 });
      this.drawCenter(root, xR, yC);
    },

    drawTall(root, g, snap) {
      const m = this.metrics(snap);
      const st = this.stations(g);
      const { yC, r, xR, xM, W } = g;
      const P = st.pos;
      const yB = g.yB;

      const edges = s('g');
      root.append(edges);
      edges.append(s('circle', { class: 'p-ring', cx: xR, cy: yC, r }));
      this.drawRepeat(edges, g, st);
      this.edge(edges, 'mem-bouncer', `M${xM},${g.memBot} L${xM},${yB - 2}`);
      this.edge(edges, 'bouncer-desk', `M${xM},${yB} C${xM},${yB + 170} ${P.desk[0] + 30},${P.desk[1] - 110} ${P.desk[0]},${P.desk[1] - 6}`);
      this.edge(edges, 'bouncer-tray', `M${xM + 20},${yB} L${W - 4},${yB}`);
      for (const [id, d] of Object.entries(st.arcs)) this.edge(edges, id, d);
      const yS = P.trust[1] + 118;
      this.edge(edges, 'trust-sleep', `M${xR},${P.trust[1] + 6} L${xR},${yS - 8}`);
      const selfD = `M${P.tools[0] + 6},${P.tools[1]} C${W - 6},${P.tools[1] - 40} ${W - 6},${g.memBot + 40} ${xM + 9},${g.memBot - 4}`;
      this.edge(edges, 'self', selfD, 'faint');
      for (const id of ['desk-decide', 'decide-trust', 'trust-tools', 'tools-desk']) this.chevron(edges, st.arcs[id]);

      this.drawSenses(root, g, snap, false);
      this.drawMemory(root, g, snap, { x: W, y: 22, anchor: 'end' });
      const bouncer = this.node(root, 3, xM, yB, { x: xM - 30, y: yB - 2, anchor: 'end', no: '03', name: 'Bouncer', meta: `${m.woke} · ${m.slept}` }, { marker: false });
      bouncer.append(
        s('line', { class: 'gate-bar', x1: xM - 20, x2: xM - 7, y1: yB, y2: yB }),
        s('line', { class: 'gate-bar', x1: xM + 7, x2: xM + 20, y1: yB, y2: yB }),
        s('line', { class: 'tray', x1: W - 2, x2: W - 2, y1: yB - 8, y2: yB + 8 }),
        s('circle', { class: 'halo', cx: xM, cy: yB, r: 14 }),
      );
      this.drawGaps(root, g, snap, { cx: 8, top: yB + 96, tall: true, label: { x: 0, y: yB + 70, anchor: 'start' } }, m);

      this.node(root, 5, P.desk[0], P.desk[1], { x: P.desk[0] - 14, y: P.desk[1] - 8, anchor: 'end', no: '05', name: 'Desk' });
      this.node(root, 6, P.decide[0], P.decide[1], { x: P.decide[0] - 12, y: P.decide[1] + 28, anchor: 'end', no: '06', name: 'Decide', meta: m.decide });
      this.node(root, 9, P.tools[0], P.tools[1], { x: W, y: P.tools[1] + 28, anchor: 'end', no: '09', name: 'Tools', meta: `${fmtNum(snap.anatomy.tools.total)} tools` }, { health: snap.anatomy.tools.broken?.length ? 'fail' : undefined });
      this.node(root, 8, P.repeat[0], P.repeat[1], { x: P.repeat[0] + 12, y: P.repeat[1] - 6, anchor: 'start', no: '08', name: 'Repeat' }, { r: 4, halo: 10 });
      this.node(root, 7, P.trust[0], P.trust[1], { x: P.trust[0] + 14, y: P.trust[1] + 22, anchor: 'start', no: '07', name: 'Trust', meta: m.trust });
      this.drawLadder(root, 0, P.trust[1] + 28, snap);
      const nx = snap.anatomy.sleep.next;
      this.node(root, 10, xR, yS, { x: xR + 22, y: yS + 4, anchor: 'start', no: '10', name: 'Sleep', meta: nx?.at ? `next ${fmtWhen(nx.at, m.now)}` : 'nothing scheduled' }, { r: 7, halo: 16 });
      this.drawCenter(root, xR, yC);
    },

    /** 04 Gaps: a clean tick array, one tick per gap under the root, feeding a single line into Decide. */
    drawGaps(root, g, snap, opts, m) {
      const kids = snap.gaps.filter((x) => x.id !== 'gap_root');
      const done = (x) => x.status === 'closed' || x.status === 'dropped';
      const rank = (x) => (done(x) ? 3 : x.standing ? 2 : x.status === 'proposed' ? 1 : 0);
      const sorted = [...kids].sort((a, b) => rank(a) - rank(b));
      const max = opts.tall ? 18 : 32;
      const shown = sorted.slice(0, max);
      const spacing = opts.tall ? 8 : 9;
      const glyph = s('g', { class: 'gapticks' });
      const yTop = opts.top;
      const yBus = yTop + 22;
      // a small break between groups (life, standing, done) keeps the pattern readable
      const xs = [];
      let x = 0;
      shown.forEach((gp, i) => {
        if (i && rank(gp) !== rank(shown[i - 1])) x += spacing;
        xs.push(x);
        x += spacing;
      });
      const width = xs.length ? xs[xs.length - 1] : 0;
      const x0 = opts.tall ? opts.cx : opts.cx - width / 2;
      shown.forEach((gp, i) => {
        const xx = x0 + xs[i];
        const cls = done(gp) ? 'done' : gp.standing ? 'standing' : gp.status;
        const tall = done(gp) ? 6 : 12;
        glyph.append(s('line', { class: `g-tick ${cls}`, x1: xx, x2: xx, y1: yTop + (12 - tall), y2: yTop + 12, 'data-gap': gp.id }, s('title', null, `${gp.title} (${gp.standing ? 'standing' : GAP_STATUS[gp.status] ?? gp.status})`)));
      });
      if (kids.length > max) glyph.append(s('text', { class: 'edge-label', x: x0 + width + 10, y: yTop + 11 }, `+${kids.length - max}`));
      const rootX = opts.tall ? opts.cx : opts.cx;
      glyph.append(s('path', { class: 'g-bus', d: `M${x0 - 3},${yTop + 17} H${x0 + width + 3}` }));
      const st = this.stations(g);
      const dec = st.pos.decide;
      const d = opts.tall ? `M${rootX},${yBus} C${rootX},${dec[1] - 10} ${dec[0] - 50},${dec[1]} ${dec[0] - 7},${dec[1]}` : `M${opts.cx},${yTop + 17} L${opts.cx},${dec[1] - 7}`;
      const link = s('path', { class: 'p-edge', d });
      this.edges['gaps-decide'] = { el: link, d };
      root.append(link);
      const lbl = opts.tall ? opts.label : { x: x0 - 16, y: yTop + 10, anchor: 'end' };
      const grp = this.node(root, 4, opts.cx, yTop, { ...lbl, no: '04', name: 'Gaps', meta: m.gaps }, { marker: false });
      grp.append(glyph);
      this.gapTicks = glyph;
    },

    drawLadder(root, x, y, snap) {
      const ladder = snap.anatomy.trust;
      const max = Math.max(1, ...LADDER.map((k) => ladder[k] || 0));
      const grp = s('g', { class: 'ladder' });
      const nameW = 54;
      const railW = 30;
      LADDER.forEach((k, i) => {
        const yy = y + i * 12;
        const v = ladder[k] || 0;
        const rung = s('g', { class: 'rung', 'data-level': k });
        rung.append(
          s('text', { class: 'r-name', x, y: yy + 3.5 }, LEVEL_SHORT[k]),
          s('line', { class: 'r-rail', x1: x + nameW, x2: x + nameW + railW, y1: yy, y2: yy }),
          v ? s('line', { class: 'r-bar', x1: x + nameW, x2: x + nameW + Math.max(2, (railW * v) / max), y1: yy, y2: yy }) : null,
          s('text', { class: 'r-num', x: x + nameW + railW + 6, y: yy + 3.5 }, fmtNum(v)),
        );
        grp.append(rung);
      });
      root.append(grp);
      this.ladder = grp;
    },

    drawCenter(root, x, y) {
      const c = s('g', { class: 'ring-center', 'text-anchor': 'middle', 'pointer-events': 'none' });
      const top = s('text', { class: 'c-top', x, y: y - 22 });
      const mid = s('text', { class: 'c-mid', x, y: y + 10 });
      const bot = s('text', { class: 'c-bot', x, y: y + 30 });
      c.append(top, mid, bot);
      root.append(c);
      this.center = { top, mid, bot };
      this.setCenter();
    },

    setCenter() {
      if (!this.center) return;
      const { top, mid, bot } = this.center;
      const pb = state.player;
      const snap = state.snap;
      const cap = snap.anatomy.repeat.cap || 25;
      const r = this.g?.r ?? 100;
      const maxChars = Math.floor((r * 1.5) / 6.5);
      const count = (n, total) => [s('tspan', { class: 'c-n' }, String(n)), s('tspan', { class: 'c-cap', dx: '2' }, `/${total}`)];
      let fill = 0;
      let fillTone = '';
      mid.classList.remove('awake');
      if (pb && pb.view) {
        const n = pb.wake.trace.length;
        top.textContent = pb.view.kind === 'end' ? 'playback · ended' : pb.view.kind === 'trigger' ? 'playback · woken' : pb.wake.live ? 'live · turn' : 'playback · turn';
        const turn = pb.view.live ? pb.view.turnNo : pb.view.turnNo ?? (pb.view.kind === 'end' ? n : 0);
        mid.replaceChildren(...count(turn, cap));
        mid.classList.add('awake');
        bot.textContent = short(pb.view.label || '', maxChars);
        fill = pb.view.kind === 'end' ? n : pb.view.live ? Math.max(0, turn - 1) : turn;
        fillTone = 'on';
      } else if (snap.live.status === 'awake') {
        const t = lastTurn(snap.live);
        const used = snap.live.turns?.length ?? 0;
        top.textContent = 'awake · turn';
        mid.replaceChildren(...count(used + 1, cap));
        mid.classList.add('awake');
        bot.textContent = t ? short(`after: ${toolWords(t.toolId)}`, maxChars) : 'deciding';
        fill = used;
        fillTone = 'on';
      } else {
        const next = snap.anatomy.sleep.next;
        top.textContent = 'asleep · next wake';
        if (next?.at) {
          mid.textContent = fmtCountdown(Date.parse(next.at) - Date.now());
          bot.textContent = `at ${fmtWhen(next.at)}`;
        } else {
          mid.textContent = '–';
          bot.textContent = 'no wake-up set';
        }
        fill = snap.anatomy.repeat.longest24h || 0;
        fillTone = 'rest';
      }
      if (this.repeatTicks) this.repeatTicks.forEach((t, i) => t.setAttribute('class', i < fill ? `used ${fillTone}` : ''));
    },

    // ---- highlight state (what is active right now). The first node listed is the one acting.
    setActive(nodes, tones = {}, edges = [], edgeTone = {}) {
      this.on.nodes = nodes.map(String);
      this.on.tones = tones;
      this.on.edges = new Set(edges);
      this.on.edgeTone = edgeTone;
      this.applyHighlight();
    },
    applyHighlight() {
      const on = this.on;
      const primary = on.nodes[0];
      for (const [part, n] of Object.entries(this.nodes)) {
        const lit = on.nodes.includes(String(part));
        const tone = on.tones[part];
        n.el.classList.toggle('on', lit);
        n.el.classList.toggle('primary', lit && String(part) === primary && tone !== 'sleep');
        n.el.classList.remove('tone-fail', 'tone-wait', 'tone-sleep');
        if (lit && (tone === 'fail' || tone === 'wait' || tone === 'sleep')) n.el.classList.add(`tone-${tone}`);
        n.el.classList.toggle('selected', state.sheet?.kind === 'node' && String(state.sheet.part) === String(part));
      }
      for (const [id, e] of Object.entries(this.edges)) {
        const lit = on.edges.has(id);
        e.el.classList.toggle('lit', lit);
        for (const c of ['t-wake', 't-quiet', 't-fail', 't-wait']) e.el.classList.remove(c);
        if (lit) e.el.classList.add(`t-${edgeToneOf(id, on.edgeTone[id])}`);
        if (e.row) e.row.classList.toggle('lit', lit);
      }
      if (this.gapTicks) for (const d of this.gapTicks.querySelectorAll('.g-tick')) d.classList.toggle('served', d.dataset.gap === on.gap);
      if (this.ladder) for (const r of this.ladder.querySelectorAll('.rung')) r.classList.toggle('active', r.dataset.level === on.level);
      this.setCenter();
    },

    // ---- motion: a comet along a path. Resolves when it arrives; always ends (rAF stops, a timer cleans up).
    travel(id, { dur = 600, tone = 'wake', from = 0, to = 1 } = {}) {
      const e = this.edges[id];
      if (!e || reduceMotion.matches || document.hidden) return Promise.resolve();
      dur = Math.min(dur, 1400);
      const p = s('path', { d: e.d, fill: 'none', stroke: 'none' });
      const tail = s('path', { d: e.d, class: `travel-tail ${tone}` });
      const dot = s('circle', { r: 2.6, class: `travel-dot ${tone}` });
      this.fx.append(p, tail, dot);
      const len = p.getTotalLength();
      const tailLen = Math.min(24, len * 0.4);
      tail.setAttribute('stroke-dasharray', `${tailLen} ${len + tailLen}`);
      const t0 = performance.now();
      return new Promise((resolve) => {
        let done = false;
        const finish = () => {
          if (done) return;
          done = true;
          p.remove();
          tail.remove();
          dot.animate?.([{ opacity: 1 }, { opacity: 0 }], { duration: 240, easing: 'ease-out' });
          setTimeout(() => dot.remove(), 240);
          resolve();
        };
        const guard = setTimeout(finish, dur + 200);
        const step = (now) => {
          if (done) return;
          const k = clamp((now - t0) / dur, 0, 1);
          const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          const pos = len * (from + (to - from) * eased);
          const pt = p.getPointAtLength(pos);
          dot.setAttribute('cx', pt.x.toFixed(2));
          dot.setAttribute('cy', pt.y.toFixed(2));
          tail.setAttribute('stroke-dashoffset', String(tailLen - pos));
          if (k < 1) requestAnimationFrame(step);
          else {
            clearTimeout(guard);
            finish();
          }
        };
        requestAnimationFrame(step);
      });
    },

    /** Reduced motion: a 150 ms edge flash replaces travel. */
    blink(id, tone = 'wake') {
      const e = this.edges[id];
      if (!e) return;
      const cls = `blink-${tone}`;
      e.el.classList.add(cls);
      setTimeout(() => e.el.classList.remove(cls), 150);
    },

    flash(part) {
      const n = this.nodes[part];
      if (!n || reduceMotion.matches) return;
      n.el.querySelector('.halo')?.animate?.([{ opacity: 0.2 }, { opacity: 0 }], { duration: 600, easing: 'cubic-bezier(.2,.7,.2,1)' });
    },
  };

  /** What colour a lit wire takes: only the loop's own wires carry the signal colour. */
  function edgeToneOf(id, override) {
    if (override === 'fail' || override === 'wait') return override;
    if (override === 'quiet' || override === 'sleep') return 'quiet';
    if (override === 'wake') return 'wake';
    if (id.startsWith('fiber:') || id === 'mem-bouncer' || id === 'bouncer-tray' || id === 'gaps-decide' || id === 'trust-sleep' || id === 'return') return 'quiet';
    return 'wake';
  }

  /** The resting state of the plate: what is true right now (asleep, or awake on a turn). */
  function restingHighlight() {
    if (state.player) return;
    const snap = state.snap;
    if (snap.live.status === 'awake') {
      const t = lastTurn(snap.live);
      Plate.on.gap = servingGap();
      Plate.on.level = t ? snap.trustLevels?.[t.toolId] : undefined;
      // Between turns, Decide is reading the rebuilt Desk.
      Plate.setActive([6, 5], {}, ['desk-decide', ...(Plate.on.gap ? ['gaps-decide'] : [])], {});
    } else {
      Plate.on.gap = undefined;
      Plate.on.level = undefined;
      Plate.setActive([10], { 10: 'sleep' }, ['return'], { return: 'quiet' });
    }
  }

  // ------------------------------------------------------------------ arrivals: particles for real new events
  function spawnArrivals(prev, snap) {
    const seen = state.seenEvents ?? new Set();
    const fresh = snap.recentEvents.filter((e) => !seen.has(e.id));
    for (const e of snap.recentEvents) seen.add(e.id);
    state.seenEvents = seen;
    if (!fresh.length) return;
    const decisions = new Map(snap.recentDecisions.map((d) => [d.eventId, d.label]));
    const liveTrigger = snap.live.status === 'awake' ? snap.live.trigger?.id : undefined;
    fresh.slice(-10).forEach((e, i) => {
      const outcome = decisions.get(e.id) ?? (e.id === liveTrigger ? 'WAKE' : snap.anatomy.bouncer.logged ? undefined : 'unknown');
      setTimeout(() => particle(e, outcome), i * 220);
    });
  }

  async function particle(e, outcome) {
    const t0 = performance.now();
    const left = () => PARTICLE_MAX_MS - (performance.now() - t0);
    if (e.sense === 'self') {
      if (reduceMotion.matches) return Plate.blink('self', 'quiet');
      await Plate.travel('self', { dur: 1100, tone: 'quiet' });
      return;
    }
    const fiber = `fiber:${Plate.edges[`fiber:${e.sense}`] ? e.sense : 'other'}`;
    if (reduceMotion.matches) {
      Plate.blink(fiber, 'in');
      if (outcome === 'WAKE') setTimeout(() => Plate.blink('bouncer-desk', 'wake'), 160);
      return;
    }
    const row = Plate.edges[fiber]?.row;
    row?.classList.add('arriving');
    await Plate.travel(fiber, { dur: 700, tone: 'in' });
    row?.classList.remove('arriving');
    if (left() < 420 + 300) return;
    await Plate.travel('mem-bouncer', { dur: 420, tone: 'in' });
    if (outcome === 'WAKE') {
      if (left() < 560 + 250) return;
      await Plate.travel('bouncer-desk', { dur: 560, tone: 'wake' });
      Plate.flash(5);
    } else if (outcome === 'SLEEP') {
      if (left() < 380 + 250) return;
      await Plate.travel('bouncer-tray', { dur: 380, tone: 'dim' });
    } else {
      Plate.flash(3);
    }
  }

  // ------------------------------------------------------------------ live follow
  async function syncLive(prev, snap) {
    const awakeId = snap.live.status === 'awake' ? snap.live.wakeId : undefined;
    const pb = state.player;
    if (awakeId) {
      if (pb && pb.wake.wakeId === awakeId) {
        const w = await getJSON(`/api/wake/${encodeURIComponent(awakeId)}`).catch(() => undefined);
        if (w) pb.update(w);
      } else if (!pb && state.liveDismissed !== awakeId && (!state.sheet || state.sheet.kind !== 'node')) {
        openWake(awakeId, { live: true, autoplay: true, quiet: true });
      }
    } else if (pb && pb.wake.live && snap.wakes.some((w) => w.wakeId === pb.wake.wakeId)) {
      // The wake ended and its finished record has landed in wakes.jsonl: play how it ended.
      const w = await getJSON(`/api/wake/${encodeURIComponent(pb.wake.wakeId)}`).catch(() => undefined);
      if (w && !w.live) pb.update(w);
    } else if (pb && pb.wake.live) {
      pb.liveEnded = true;
      pb.updateControls();
    }
    if (!state.player) restingHighlight();
  }

  function followLive() {
    const live = state.snap?.live;
    if (live?.status !== 'awake') {
      const st = $('#railState');
      st.classList.remove('nudge');
      void st.offsetWidth;
      st.classList.add('nudge');
      return;
    }
    state.liveDismissed = undefined;
    if (state.player?.wake.wakeId === live.wakeId) {
      state.player.goto(state.player.phases.length - 1, false);
      state.player.play();
      return;
    }
    openWake(live.wakeId, { live: true, autoplay: true });
  }

  // ------------------------------------------------------------------ the side panel
  const sheetEl = () => $('#sheet');
  function showSheet() {
    sheetEl().hidden = false;
    $('#stage').classList.add('with-sheet');
    document.body.classList.add('sheet-open');
  }
  function closeSheet() {
    if (state.player) {
      if (state.player.wake.live) state.liveDismissed = state.player.wake.wakeId;
      state.player.destroy();
      state.player = undefined;
    }
    state.sheet = undefined;
    const sh = sheetEl();
    sh.hidden = true;
    sh.replaceChildren();
    $('#stage').classList.remove('with-sheet');
    document.body.classList.remove('sheet-open');
    for (const r of document.querySelectorAll('.wake-row.selected')) r.classList.remove('selected');
    for (const r of document.querySelectorAll('.tl-wake.selected')) r.classList.remove('selected');
    restingHighlight();
  }
  function sheetHead(kicker, title, sub) {
    return el(
      'div',
      { class: 'sheet-head' },
      el('div', { class: 'sheet-kicker' }, kicker),
      el('button', { class: 'sheet-close', type: 'button', 'aria-label': 'Close (Esc)', title: 'Close (Esc)', onclick: closeSheet }, '×'),
      el('h3', { class: 'sheet-title' }, title),
      sub ? el('div', { class: 'sheet-sub' }, sub) : null,
    );
  }

  function openNodeSheet(part) {
    if (state.sheet?.kind === 'node' && state.sheet.part === Number(part)) {
      closeSheet();
      return;
    }
    if (state.player) {
      if (state.player.wake.live) state.liveDismissed = state.player.wake.wakeId;
      state.player.destroy();
      state.player = undefined;
    }
    state.sheet = { kind: 'node', part: Number(part) };
    renderNodeSheet(part, true);
    restingHighlight();
    Plate.applyHighlight();
  }

  function actList(items) {
    if (!items.length) return el('p', { class: 'empty' }, 'Nothing in the last 24 hours.');
    return el('ul', { class: 'act-list' }, items.map((it) => el('li', null, el('span', { class: 't' }, it.t), it.onclick ? el('button', { class: 'x', type: 'button', onclick: it.onclick }, it.x) : el('span', { class: 'x' }, it.x))));
  }

  function renderNodeSheet(part, fresh) {
    const snap = state.snap;
    const p = Number(part);
    const o = snap.outline.find((x) => x.n === p) ?? { n: p, name: `Part ${p}`, text: '' };
    const a = snap.anatomy;
    const now = Date.parse(snap.now) || Date.now();
    const body = el('div', { class: 'sheet-body' });
    body.append(o.text ? el('p', { class: 'outline-quote' }, o.text) : el('p', { class: 'empty' }, 'docs/OUTLINE.md wasn’t found.'));
    const kv = (pairs) => el('dl', { class: 'kv' }, pairs.filter(Boolean).map(([k, v]) => [el('dt', null, k), el('dd', null, v)]));
    const wakeItem = (w) => ({ t: fmtWhen(w.at, now), x: [el('b', null, triggerWords(w.trigger)), ` · ${plural(w.turns, 'move')}${w.sent ? ` · said ${w.sent}` : ''} — ${short(clean(w.trigger.text), 90)}`], onclick: () => openWake(w.wakeId) });

    switch (p) {
      case 1: {
        const counts = [el('h4', null, 'Last 24 hours'), kv(a.senses.map((x) => [x.label, x.count24h ? `${fmtNum(x.count24h)} · last ${fmtWhen(x.lastAt, now)}` : 'quiet']))];
        // A broken sense is the first thing to read here.
        const anyBroken = (a.senseHealth ?? []).some((h) => h.status === 'broken');
        if (!anyBroken) body.append(...counts);
        body.append(el('h4', null, 'Health'));
        if (a.senseHealth?.length)
          body.append(
            kv(
              a.senseHealth.map((h) => [
                CONNECTOR_LABEL[h.id] ?? capFirst(h.id.replace(/[-_.]+/g, ' ')),
                h.status === 'broken'
                  ? el('span', { class: 'status failed' }, `Not working: ${short(clean(h.problem ?? ''), 120)}`)
                  : h.status === 'quiet'
                    ? `working, nothing new in 24h${h.lastPollAt ? ` · checked ${fmtWhen(h.lastPollAt, now)}` : ''}`
                    : `working · ${fmtNum(h.events24h)} in 24h${h.failures24h ? ` · ${h.failures24h} failed polls` : ''}${h.lastPollAt ? ` · checked ${fmtWhen(h.lastPollAt, now)}` : ''}`,
              ]),
            ),
          );
        else body.append(el('p', { class: 'empty' }, 'Each sense’s health is recorded from the next daemon restart.'));
        if (anyBroken) body.append(...counts);
        body.append(el('h4', null, 'Latest events'), actList(snap.recentEvents.filter((e) => e.sense !== 'self').slice(-10).reverse().map((e) => ({ t: fmtWhen(e.at, now), x: [el('b', null, SENSE_LABEL[e.sense] ?? e.source), ` — ${short(clean(e.text), 110)}`] }))));
        break;
      }
      case 2:
        body.append(el('h4', null, 'The log'), kv([['Events', fmtNum(a.memory.events)], ['Indexed for meaning', fmtNum(a.memory.indexed)], ['His own actions, 24h', fmtNum(a.memory.self24h)], ['Last written', a.memory.lastAt ? fmtWhen(a.memory.lastAt, now) : '–']]));
        body.append(el('h4', null, 'His own actions, latest'), actList(snap.recentEvents.filter((e) => e.sense === 'self').slice(-8).reverse().map((e) => ({ t: fmtWhen(e.at, now), x: short(clean(e.text), 140) }))));
        break;
      case 3: {
        const b = a.bouncer;
        const t = snap.telemetry || {};
        body.append(
          el('h4', null, 'Last 24 hours'),
          kv([
            ['Woke him', fmtNum(b.wake24h)],
            ['Let him sleep', b.sleep24h === undefined ? 'not logged yet' : fmtNum(b.sleep24h)],
            Number.isFinite(t.bouncerSleepPct) && ['Slept through', `${t.bouncerSleepPct}%`],
            ['Model', b.model === 'setfit' ? 'SetFit (trained locally)' : 'prototype (untrained)'],
            ['Training examples', fmtNum(b.examples)],
            Number.isFinite(t.setfitMs) && ['Median SetFit call', `${t.setfitMs}ms`],
            b.lastMs !== undefined && ['Last call', fmtDur(b.lastMs)],
            ...Object.entries(b.backends).map(([k, v]) => [`Decided by ${k === 'rule' ? 'a rule' : k}`, fmtNum(v)]),
          ]),
        );
        if (!b.logged) body.append(el('p', { class: 'empty' }, 'Every bouncer call is logged from the next daemon restart. Until then only the events that woke him are known (from his wakes).'));
        body.append(el('h4', null, b.logged ? 'Latest calls' : 'Latest events that woke him'));
        if (b.logged) body.append(actList(snap.recentDecisions.slice(-10).reverse().map((d) => ({ t: fmtWhen(d.at, now), x: [el('b', null, d.label === 'WAKE' ? 'Woke him' : 'Let sleep'), ` · ${d.backend}${d.reason ? ` — ${short(d.reason, 80)}` : ''}`] }))));
        else body.append(actList(snap.wakes.slice(0, 8).map(wakeItem)));
        break;
      }
      case 4:
        body.append(el('h4', null, 'On the tree'), kv([...Object.entries(a.gaps).filter(([, v]) => v).map(([k, v]) => [GAP_STATUS[k] ?? k, fmtNum(v)]), ['Standing self-opt', fmtNum(snap.telemetry?.standingGaps)]]));
        body.append(el('h4', null, 'Gaps'), actList(snap.gaps.map((gp) => ({ t: gp.standing ? 'Standing' : GAP_STATUS[gp.status] ?? gp.status, x: [el('b', null, gp.title)], onclick: () => jumpGap(gp.id) }))));
        break;
      case 5:
        body.append(el('h4', null, 'Last 24 hours'), kv([['Wakes', fmtNum(a.desk.wakes24h)], ['Where he acted', fmtNum(a.desk.acted24h)], a.desk.metered24h > 0 && ['Model spend', `${fmtCost(a.desk.cost24h)} over ${plural(a.desk.metered24h, 'wake')}`], a.desk.modelCalls24h > 0 && ['Model calls', fmtNum(a.desk.modelCalls24h)]]));
        body.append(el('h4', null, 'Latest wakes'), actList(snap.wakes.slice(0, 10).map(wakeItem)));
        break;
      case 6: {
        const c = snap.credits || {};
        body.append(
          el('h4', null, 'Last 24 hours'),
          kv([
            ['Moves', fmtNum(a.decide.moves24h)],
            ['Primary model', c.primary || '–'],
            c.pausedUntil ? ['Claude', el('span', { class: 'status pending_approval' }, `paused until ${fmtWhen(c.pausedUntil, now)}`)] : ['Claude credit left', `${fmtNum(c.left5hPct)}% of 5h · ${fmtNum(c.left7dPct)}% of 7d`],
            c.localModel && ['Local fallback', c.localModel],
          ]),
        );
        body.append(el('h4', null, 'Latest thoughts'), actList((snap.recentMoves ?? []).slice(0, 10).map((mv) => ({ t: fmtWhen(mv.at, now), x: [el('span', { class: 'serif' }, `“${short(clean(mv.thought), 150)}”`), ` → ${toolWords(mv.toolId)}`], onclick: () => openWake(mv.wakeId) }))));
        break;
      }
      case 7: {
        body.append(el('h4', null, 'The ladder (lowest to highest)'), kv(LADDER.map((k) => [LEVEL_WORDS[k], `${fmtNum(a.trust[k] || 0)} tools`])));
        const byLevel = (lvl) => snap.tools.filter((t) => t.level === lvl).map((t) => t.id);
        for (const k of ['never', 'rehearse', 'draft', 'act_and_report']) {
          const ids = byLevel(k);
          if (ids.length) body.append(el('h4', null, LEVEL_WORDS[k]), el('p', { class: 'plain' }, capFirst(ids.map(toolWords).join(', '))));
        }
        body.append(el('h4', null, 'Held for your yes'), snap.approvals.length ? actList(snap.approvals.map((ap) => ({ t: fmtWhen(ap.createdAt, now), x: [el('b', { title: ap.toolId }, capFirst(toolWords(ap.toolId))), ` ${short(prettyInput(ap.input).replace(/\n/g, ' · '), 100)}`] }))) : el('p', { class: 'empty' }, 'Nothing.'));
        break;
      }
      case 8: {
        const e24 = a.sleep.ended24h;
        body.append(el('h4', null, 'Last 24 hours'), kv([['Turn cap', String(a.repeat.cap)], ['Median turns', fmtNum(snap.telemetry?.medianTurns)], ['Longest wake', plural(a.repeat.longest24h, 'move')], ['Ended by sleep', fmtNum(e24.sleep)], ['Hit the turn cap', fmtNum(e24.cap)], e24.crashed > 0 && ['Crashed', el('span', { class: 'status failed' }, fmtNum(e24.crashed))], e24.unreadable > 0 && ['Unreadable replies', fmtNum(e24.unreadable)], ['Ended another way', fmtNum(e24.safety)]]));
        body.append(el('h4', null, 'Longest recent wakes'), actList([...snap.wakes].sort((x, y) => y.turns - x.turns).slice(0, 6).map(wakeItem)));
        const crashes = snap.wakes.filter((w) => w.ending === 'crashed' || w.ending === 'unreadable').slice(0, 6);
        if (crashes.length) body.append(el('h4', null, 'Latest crashes'), actList(crashes.map(wakeItem)));
        break;
      }
      case 9: {
        const t = a.tools;
        body.append(el('h4', null, 'Tools'), kv([['Built in', fmtNum(t.builtin)], ['Built by him', fmtNum(t.custom)], ['Brain skills', t.skillNames.join(', ').toLowerCase() || '–'], t.broken.length && ['Failing', el('span', { class: 'status failed' }, t.broken.map(toolWords).join(', '))]]));
        const used = new Map();
        for (const w of snap.wakes) for (const mv of w.moves) if (mv.toolId !== 'sleep') used.set(mv.toolId, (used.get(mv.toolId) ?? 0) + 1);
        body.append(el('h4', null, 'Most used lately'), kv([...used.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => [capFirst(toolWords(k)), `${v}×`])));
        break;
      }
      case 10: {
        const sl = a.sleep;
        const e24 = sl.ended24h;
        body.append(el('h4', null, 'In motion'), kv([['Timers', fmtNum(sl.timers)], ['Threads running', fmtNum(sl.threads)], sl.next?.at && ['Next wake', `${fmtWhen(sl.next.at, now)} · ${fmtIn(Date.parse(sl.next.at) - Date.now())}`]]));
        body.append(el('h4', null, 'How wakes ended, 24h'), kv([['Accepted sleep', fmtNum(e24.sleep)], ['Turn cap', fmtNum(e24.cap)], ['Safety net', fmtNum(e24.safety)], ['Crashed', e24.crashed ? el('span', { class: 'status failed' }, fmtNum(e24.crashed)) : '0'], ['Unreadable', fmtNum(e24.unreadable)]]));
        const all = [...snap.gaps.flatMap((gp) => gp.next.map((n) => ({ ...n, gap: gp.title }))), ...snap.looseWatches];
        all.sort((x, y) => (x.fireAt ? Date.parse(x.fireAt) : Infinity) - (y.fireAt ? Date.parse(y.fireAt) : Infinity));
        body.append(el('h4', null, 'Next moves'), actList(all.slice(0, 12).map((n) => ({ t: n.fireAt ? fmtWhen(n.fireAt, now) : 'thread', x: [n.gap ? el('b', null, short(n.gap, 50)) : el('b', null, 'Not tied to a gap'), ` — ${short(humanizeLabel(n.label), 120)}`] }))));
        break;
      }
      default:
        break;
    }
    const sh = sheetEl();
    const keepScroll = !fresh ? sh.querySelector('.sheet-body')?.scrollTop : 0;
    sh.replaceChildren(sheetHead(`Part ${String(o.n).padStart(2, '0')} of 10`, o.name), body);
    if (keepScroll) body.scrollTop = keepScroll;
    showSheet();
    if (fresh) maybeScrollToPlate();
  }

  function maybeScrollToPlate() {
    const plate = $('#plate');
    const smooth = reduceMotion.matches ? 'auto' : 'smooth';
    if (Plate.g?.mode === 'tall' || window.innerWidth < 1120) {
      // The panel is a bottom sheet here: bring the ring into the space above it.
      const svgTop = Plate.svg.getBoundingClientRect().top + window.scrollY;
      const sheetH = sheetEl().offsetHeight || window.innerHeight * 0.5;
      const free = window.innerHeight - sheetH;
      const target = svgTop + (Plate.g?.yC ?? 300) - free / 2;
      window.scrollTo({ top: Math.max(0, target), behavior: smooth });
      return;
    }
    const r = plate.getBoundingClientRect();
    if (r.top < -40 || r.top > window.innerHeight * 0.5) plate.scrollIntoView({ behavior: smooth, block: 'start' });
  }

  // ------------------------------------------------------------------ wake playback
  async function openWake(id, opts = {}) {
    let wake;
    try {
      wake = await getJSON(`/api/wake/${encodeURIComponent(id)}`);
    } catch (err) {
      showError(err);
      return;
    }
    if (state.player) state.player.destroy();
    state.sheet = { kind: 'wake', id };
    for (const r of document.querySelectorAll('.wake-row')) r.classList.toggle('selected', r.dataset.wake === id);
    for (const r of document.querySelectorAll('.tl-wake')) r.classList.toggle('selected', r.dataset.wake === id);
    state.player = new Player(wake, opts);
    showSheet();
    if (!opts.quiet) maybeScrollToPlate();
  }

  function buildPhases(w) {
    const ph = [{ kind: 'trigger', dur: 2300 }];
    (w.trace || []).forEach((t, i) => {
      const gate = gateOf(t, w.trustLevels);
      ph.push({ kind: 'desk', ti: i, dur: 650 });
      ph.push({ kind: 'decide', ti: i, dur: 1200 });
      ph.push({ kind: 'gate', ti: i, dur: 700, gate });
      if (t.toolId === 'sleep') ph.push({ kind: 'sleeptool', ti: i, dur: 800, gate });
      else if (!gate.rejected && gate.level !== 'never') ph.push({ kind: 'tool', ti: i, dur: 800, gate });
      if (t.toolId !== 'sleep' || gate.tone !== 'ok') ph.push({ kind: 'receipt', ti: i, dur: t.receipt?.sentText ? 1300 : 850, gate });
    });
    if (!w.live) ph.push({ kind: 'end', dur: 1600 });
    else ph.push({ kind: 'deciding', dur: 600 });
    return ph;
  }

  const SPEEDS = [0.5, 1, 2, 4];

  class Player {
    constructor(wake, opts = {}) {
      this.wake = wake;
      this.phases = buildPhases(wake);
      this.i = -1;
      this.playing = false;
      this.speed = 1;
      this.timer = undefined;
      this.stopAt = undefined;
      this.view = undefined;
      this.build();
      if (wake.live) {
        // Live: show what already happened instantly, then animate new turns as they arrive.
        this.goto(Math.max(0, this.phases.length - 1), false);
        this.playing = true;
        this.updateControls();
      } else if (opts.autoplay !== false) {
        this.goto(0, true);
        this.play();
      }
    }

    destroy() {
      clearTimeout(this.timer);
      this.playing = false;
      this.view = undefined;
    }

    update(w) {
      const atEnd = this.i >= this.phases.length - 1;
      this.wake = w;
      this.phases = buildPhases(w);
      this.renderTurns();
      this.paint(false);
      if (atEnd && this.playing) this.advance();
      this.updateControls();
    }

    build() {
      const w = this.wake;
      const now = Date.now();
      const sh = sheetEl();
      const calls = Number.isFinite(w.modelCalls) && w.modelCalls ? `${plural(w.modelCalls, 'model call')}${w.modelFailures ? ` (${w.modelFailures} failed)` : ''}` : null;
      const sub = [w.live ? `since ${fmtWhen(w.startedAt, now)}` : fmtWhen(w.startedAt, now), w.live ? null : fmtDur(w.durationMs), plural(w.trace.length, 'move'), w.sentMessages?.length ? `said ${w.sentMessages.length}` : null, calls, Number.isFinite(w.costUsd) ? fmtCost(w.costUsd) : null].filter(Boolean).join(' · ');
      const kicker = w.live ? el('span', { class: 'live' }, el('i', { class: 'sig', 'aria-hidden': 'true' }), 'Live') : 'Wake playback';
      const head = sheetHead(kicker, triggerWords(w.trigger), sub);
      this.body = el('div', { class: 'sheet-body' });
      const tr = w.trigger || {};
      const dec = w.decision || {};
      this.triggerEl = el(
        'div',
        { class: 'pb-trigger' },
        el('div', { class: 'k' }, `New reality · ${SENSE_LABEL[tr.sense] ?? tr.source ?? ''}${tr.actor ? ` · ${tr.actor}` : ''}`),
        el('p', { class: 'what' }, short(clean(tr.text), 420)),
        el('div', { class: 'verdict' }, `Bouncer: ${dec.label === 'SLEEP' ? 'let sleep' : 'woke him'}${dec.backend ? ` · ${dec.backend === 'rule' ? 'by rule' : dec.backend}` : ''}${Number.isFinite(dec.confidence) ? ` · ${Math.round(dec.confidence * 100)}%` : ''}${Number.isFinite(dec.durationMs) ? ` · ${fmtDur(dec.durationMs)}` : ''}${dec.reason ? ` — ${dec.reason}` : ''}`),
      );
      this.turnsEl = el('ol', { class: 'turns' });
      this.endEl = el('div', { class: 'pb-end' });
      this.body.append(this.triggerEl, this.turnsEl, this.endEl);
      this.scrubEl = el('div', { class: 'scrub', role: 'group', 'aria-label': 'Turns', onclick: (e) => this.onScrub(e) });
      const btn = (label, svgPath, fn, extra = {}) => el('button', { type: 'button', 'aria-label': label, title: label, onclick: fn, ...extra }, svgPath ? svgIcon(svgPath) : label);
      this.playBtn = btn('Play (Space)', 'M4 2.5v11l9-5.5z', () => this.toggle(), { class: 'primary' });
      this.posEl = el('span', { class: 'pos' });
      this.speedBtn = btn('1×', null, () => this.cycleSpeed(), { title: 'Speed ([ and ])', class: 'speed' });
      this.liveBtn = btn('Live', null, () => followLive(), { title: 'Follow the live wake (L)', class: 'live-btn' });
      const controls = el(
        'div',
        { class: 'controls' },
        btn('Back to the start', 'M3 3v10M13 3 6 8l7 5z', () => (this.pause(), this.goto(0, true))),
        btn('Previous turn (←)', 'M12 3 5 8l7 5z', () => this.stepTurn(-1)),
        this.playBtn,
        btn('Next turn (→)', 'M4 3l7 5-7 5z', () => this.stepTurn(1)),
        btn('Jump to the end', 'M13 3v10M3 3l7 5-7 5z', () => (this.pause(), this.goto(this.phases.length - 1, true))),
        this.speedBtn,
        this.liveBtn,
        this.posEl,
      );
      const transport = el('div', { class: 'transport' }, this.scrubEl, controls);
      sh.replaceChildren(head, this.body, transport);
      this.renderTurns();
    }

    renderTurns() {
      const w = this.wake;
      const titles = { ...(state.snap?.gapTitles ?? {}), ...(w.gapTitles ?? {}) };
      this.turnEls = w.trace.map((t, i) => {
        const st = statusOf(t);
        const gate = gateOf(t, w.trustLevels);
        const gapTxt = t.gapId ? titles[t.gapId] ?? 'a gap no longer on the tree' : t.toolId === 'sleep' ? '—' : 'none named';
        const rows = [
          el('div', { class: 'ph', 'data-ph': 'gap' }, el('span', { class: 'k' }, 'Gap'), el('span', { class: 'v' }, gapTxt)),
          t.thought ? el('div', { class: 'ph', 'data-ph': 'thought' }, el('span', { class: 'k' }, 'Thinks'), el('span', { class: 'v thought' }, `“${clean(t.thought)}”`)) : null,
          el('div', { class: 'ph', 'data-ph': 'tool' }, el('span', { class: 'k' }, 'Tool'), el('span', { class: 'v code' }, el('b', { class: 'tool-id', title: t.toolId }, t.toolId), prettyInput(t.input) ? `\n${prettyInput(t.input)}` : '')),
          el('div', { class: 'ph', 'data-ph': 'gate' }, el('span', { class: 'k' }, 'Gate'), el('span', { class: 'v' }, el('span', { class: `status ${gate.tone === 'ok' ? 'ok' : gate.tone === 'wait' ? 'pending_approval' : 'blocked'}` }, gate.text))),
          el('div', { class: 'ph', 'data-ph': 'receipt' }, el('span', { class: 'k' }, 'Receipt'), el('span', { class: 'v' }, el('span', { class: `status ${st}` }, `${STATUS_WORDS[st] ?? st}${Number.isFinite(t.receipt?.durationMs) && t.receipt.durationMs ? ` · ${fmtDur(t.receipt.durationMs)}` : ''}`), ' ', short(clean(t.receipt?.summary), 420))),
          t.receipt?.sentText ? el('div', { class: 'ph', 'data-ph': 'said' }, el('span', { class: 'k' }, 'Said'), el('div', { class: 'v' }, el('blockquote', { class: 'said' }, clean(t.receipt.sentText)))) : null,
          t.receipt?.approvalId ? el('div', { class: 'ph', 'data-ph': 'receipt' }, el('span', { class: 'k' }, ''), el('span', { class: 'v held' }, 'held for your yes')) : null,
        ];
        return el(
          'li',
          { class: `turn future${t.receipt?.realChange ? ' changed' : ''}`, 'data-ti': String(i) },
          el(
            'button',
            { class: 'turn-head', type: 'button', onclick: () => this.gotoTurn(i) },
            el('span', { class: 'turn-no num' }, String(i + 1).padStart(2, '0')),
            el('span', { class: 'turn-tool', title: t.toolId }, capFirst(toolWords(t.toolId))),
            el('span', { class: `turn-st ${toneOfStatus(st)}`, title: STATUS_WORDS[st] ?? st, 'aria-label': STATUS_WORDS[st] ?? st }),
          ),
          el('div', { class: 'turn-body' }, rows),
        );
      });
      this.turnsEl.replaceChildren(...this.turnEls);
      // How it ended
      const end = this.wake.live ? undefined : this.wake.ending;
      this.endEl.className = `pb-end ${end ?? ''} future`;
      this.endEl.replaceChildren();
      if (end) {
        const ret = 'Code scheduled a quick return for every gap left without a next move.';
        const reason =
          end === 'sleep'
            ? `Went to sleep: ${short(clean(this.wake.sleepReason || 'done'), 360)}`
            : end === 'cap'
              ? `Hit the turn cap (${state.snap?.anatomy.repeat.cap ?? 25} moves). ${ret}`
              : end === 'crashed'
                ? `Crashed${this.wake.error ? `: ${short(clean(this.wake.error), 240).replace(/[^.!?…]$/, '$&.')}` : '.'} ${ret}`
                : end === 'unreadable'
                  ? `Decide’s replies couldn’t be read, several in a row. ${ret}`
                  : `Ended without an accepted sleep. ${ret}`;
        this.endEl.append(el('div', { class: 'k' }, 'How it ended'), el('div', { class: 'v' }, reason));
      }
      const segs = [];
      this.wake.trace.forEach((t, i) => {
        const tone = toneOfStatus(statusOf(t));
        segs.push(el('span', { class: tone === 'fail' ? 'st-fail' : tone === 'wait' ? 'st-wait' : '', 'data-ti': String(i), title: `Turn ${i + 1}: ${toolWords(t.toolId)}` }));
      });
      if (!this.wake.live) segs.push(el('span', { class: 'end', title: 'How it ended' }));
      this.scrubEl.replaceChildren(...segs);
    }

    onScrub(e) {
      const seg = e.target.closest('span');
      if (!seg) return;
      if (seg.classList.contains('end')) this.goto(this.phases.length - 1, true);
      else this.gotoTurn(Number(seg.dataset.ti));
    }

    gotoTurn(ti) {
      const idx = this.phases.findIndex((p) => p.ti === ti);
      if (idx < 0) return;
      const wasPlaying = this.playing;
      this.pause();
      this.stopAt = wasPlaying ? undefined : this.lastIndexOfTurn(ti);
      this.goto(idx, true);
      if (!reduceMotion.matches) this.run(true);
    }
    lastIndexOfTurn(ti) {
      let j = -1;
      this.phases.forEach((p, k) => p.ti === ti && (j = k));
      return j;
    }

    stepTurn(dir) {
      const cur = this.phases[this.i];
      const n = this.wake.trace.length;
      const curTi = cur?.ti ?? (cur?.kind === 'end' ? n : cur?.kind === 'deciding' ? n : -1);
      const target = clamp(curTi + dir, 0, n);
      if (target === n) {
        this.pause();
        return this.goto(this.phases.length - 1, true);
      }
      this.pause();
      // One turn exactly: land on the turn's first phase and stop at its last.
      const idx = this.phases.findIndex((p) => p.ti === target);
      if (idx < 0) return;
      this.stopAt = this.lastIndexOfTurn(target);
      this.goto(idx, true);
      if (!reduceMotion.matches) this.run(true);
    }

    toggle() {
      if (this.playing) this.pause();
      else {
        if (this.i >= this.phases.length - 1 && !this.wake.live) this.goto(0, true);
        this.play();
      }
    }
    play() {
      this.playing = true;
      this.stopAt = undefined;
      this.updateControls();
      this.schedule();
    }
    pause() {
      this.playing = false;
      clearTimeout(this.timer);
      this.updateControls();
    }
    run(play) {
      // play through to stopAt, then pause
      this.playing = play;
      this.updateControls();
      this.schedule();
    }
    setSpeed(dir) {
      const k = clamp(SPEEDS.indexOf(this.speed) + dir, 0, SPEEDS.length - 1);
      this.speed = SPEEDS[k];
      this.updateControls();
    }
    cycleSpeed() {
      const k = (SPEEDS.indexOf(this.speed) + 1) % SPEEDS.length;
      this.speed = SPEEDS[k];
      this.updateControls();
    }
    schedule() {
      clearTimeout(this.timer);
      if (!this.playing) return;
      const ph = this.phases[this.i];
      const dur = (ph?.dur ?? 800) / this.speed;
      this.timer = setTimeout(() => this.advance(), reduceMotion.matches ? Math.max(dur, 900) : dur);
    }
    advance() {
      if (this.stopAt !== undefined && this.i >= this.stopAt) {
        this.stopAt = undefined;
        this.pause();
        return;
      }
      if (this.i >= this.phases.length - 1) {
        if (!this.wake.live) this.pause();
        return; // live: wait for the next turn
      }
      this.goto(this.i + 1, true);
      this.schedule();
    }

    goto(i, animate) {
      this.i = clamp(i, 0, this.phases.length - 1);
      this.paint(animate);
      this.updateControls();
      if (this.playing) this.schedule();
    }

    paint(animate) {
      const ph = this.phases[this.i];
      if (!ph) return;
      const w = this.wake;
      const t = ph.ti !== undefined ? w.trace[ph.ti] : undefined;
      const turnNo = ph.ti !== undefined ? ph.ti + 1 : undefined;
      this.view = { kind: ph.kind, turnNo, label: t ? toolWords(t.toolId) : ph.kind === 'trigger' ? triggerWords(w.trigger).toLowerCase() : ph.kind === 'end' ? endingWord(w.ending) : '' };
      if (ph.kind === 'deciding') this.view = { kind: 'deciding', turnNo: w.trace.length + 1, label: this.liveEnded ? 'ended' : 'deciding…', live: true };
      const dur = (ph.dur ?? 800) / this.speed;
      const go = animate && !reduceMotion.matches;
      const blink = animate && reduceMotion.matches;
      const sense = w.trigger?.sense && Plate.edges[`fiber:${w.trigger.sense}`] ? w.trigger.sense : 'other';
      Plate.on.gap = t?.gapId;
      Plate.on.level = ph.gate?.level;
      const along = (id, opts) => (go ? Plate.travel(id, opts) : blink ? (Plate.blink(id, opts?.tone === 'in' ? 'in' : 'wake'), Promise.resolve()) : Promise.resolve());

      switch (ph.kind) {
        case 'trigger': {
          Plate.setActive([5, 1, 2, 3], {}, [`fiber:${sense}`, 'mem-bouncer', 'bouncer-desk'], { 'bouncer-desk': 'wake' });
          (async () => {
            await along(`fiber:${sense}`, { dur: dur * 0.38, tone: 'in' });
            await along('mem-bouncer', { dur: dur * 0.2, tone: 'in' });
            await along('bouncer-desk', { dur: dur * 0.28, tone: 'wake' });
          })();
          break;
        }
        case 'desk':
          Plate.setActive([5, 4], {}, ['gaps-decide'], {});
          break;
        case 'decide':
          Plate.setActive([6, 4], {}, ['desk-decide', ...(t?.gapId ? ['gaps-decide'] : [])], {});
          along('desk-decide', { dur: dur * 0.45 });
          break;
        case 'gate':
          Plate.setActive([7], { 7: ph.gate.tone === 'ok' ? undefined : ph.gate.tone }, ['decide-trust'], {});
          along('decide-trust', { dur: dur * 0.6 });
          break;
        case 'tool':
          Plate.setActive([9, 7], { 7: ph.gate.tone === 'ok' ? undefined : ph.gate.tone }, ['trust-tools'], {});
          along('trust-tools', { dur: dur * 0.6 });
          break;
        case 'sleeptool':
          Plate.setActive([10, 7], {}, ['trust-sleep'], { 'trust-sleep': 'wake' });
          along('trust-sleep', { dur: dur * 0.6 });
          break;
        case 'receipt': {
          const tone = ph.gate.tone === 'fail' ? 'fail' : toneOfStatus(statusOf(t));
          Plate.setActive([8, 5], { 8: tone === 'ok' ? undefined : tone }, ['tools-desk'], { 'tools-desk': tone === 'ok' ? 'wake' : tone });
          if (go) {
            const dt = tone === 'ok' ? 'wake' : tone;
            if (ph.gate.rejected || ph.gate.level === 'never' || t.toolId === 'sleep') Plate.travel('trust-tools', { dur: dur * 0.3, tone: dt }).then(() => Plate.travel('tools-desk', { dur: dur * 0.35, tone: dt }));
            else Plate.travel('tools-desk', { dur: dur * 0.6, tone: dt });
            if (t.receipt?.realChange && t.toolId !== 'send_message') setTimeout(() => Plate.travel('self', { dur: 900, tone: 'quiet' }), dur * 0.3);
          } else if (blink) Plate.blink('tools-desk', 'wake');
          break;
        }
        case 'deciding': {
          const lastGap = [...w.trace].reverse().find((x) => x.gapId)?.gapId;
          Plate.on.gap = lastGap;
          Plate.setActive([6, 5], {}, ['desk-decide', ...(lastGap ? ['gaps-decide'] : [])], {});
          if (w.trace.length) along('desk-decide', { dur: 700 });
          break;
        }
        case 'end': {
          const e = w.ending;
          if (e === 'sleep') Plate.setActive([10], { 10: 'sleep' }, ['trust-sleep', 'return'], { return: 'quiet', 'trust-sleep': 'quiet' });
          else if (e === 'cap') Plate.setActive([8, 10], { 8: 'wait', 10: 'wait' }, ['return'], { return: 'wait' });
          else if (e === 'crashed' || e === 'unreadable') Plate.setActive([6, 10], { 6: 'fail', 10: 'wait' }, ['return'], { return: 'wait' });
          else Plate.setActive([10], { 10: 'wait' }, ['return'], { return: 'wait' });
          along('return', { dur: dur * 0.8, tone: e === 'sleep' ? 'quiet' : 'wait' });
          break;
        }
        default:
          break;
      }

      // the panel, in sync
      this.triggerEl.classList.toggle('on', ph.kind === 'trigger');
      const curTi = ph.ti ?? (ph.kind === 'end' ? w.trace.length : ph.kind === 'deciding' ? w.trace.length - 1 : -1);
      this.turnEls.forEach((li, i) => {
        li.classList.toggle('past', i < curTi);
        li.classList.toggle('current', i === curTi);
        li.classList.toggle('future', i > curTi);
        for (const row of li.querySelectorAll('.ph')) {
          const k = row.dataset.ph;
          const on = i === curTi && ((ph.kind === 'decide' && (k === 'gap' || k === 'thought')) || (ph.kind === 'gate' && k === 'gate') || ((ph.kind === 'tool' || ph.kind === 'sleeptool') && k === 'tool') || (ph.kind === 'receipt' && (k === 'receipt' || k === 'said')));
          row.classList.toggle('on', on);
        }
      });
      this.endEl.classList.toggle('future', ph.kind !== 'end');
      this.endEl.classList.toggle('on', ph.kind === 'end');
      const cur = curTi >= 0 && curTi < this.turnEls.length ? this.turnEls[curTi] : ph.kind === 'end' ? this.endEl : this.triggerEl;
      if (cur && ph.kind !== 'gate' && ph.kind !== 'tool') {
        const body = this.body;
        const top = cur.offsetTop - body.offsetTop;
        if (top < body.scrollTop + 8 || top + Math.min(cur.offsetHeight, body.clientHeight * 0.7) > body.scrollTop + body.clientHeight) {
          body.scrollTo({ top: Math.max(0, top - 12), behavior: go ? 'smooth' : 'auto' });
        }
      }
      [...this.scrubEl.children].forEach((sp) => {
        const ti = sp.classList.contains('end') ? w.trace.length : Number(sp.dataset.ti);
        sp.classList.toggle('done', ti < curTi || (ph.kind === 'end' && sp.classList.contains('end')));
        sp.classList.toggle('cur', ti === curTi && !sp.classList.contains('end'));
      });
      Plate.setCenter();
    }

    updateControls() {
      if (!this.playBtn) return;
      this.playBtn.replaceChildren(svgIcon(this.playing ? 'M4 2.5h3v11H4zM9 2.5h3v11H9z' : 'M4 2.5v11l9-5.5z'));
      this.playBtn.setAttribute('aria-label', this.playing ? 'Pause (Space)' : 'Play (Space)');
      this.playBtn.title = this.playing ? 'Pause (Space)' : 'Play (Space)';
      this.speedBtn.textContent = `${this.speed}×`;
      const liveNow = state.snap?.live.status === 'awake';
      this.liveBtn.hidden = !liveNow;
      this.liveBtn.classList.toggle('on', liveNow && this.wake.live && this.wake.wakeId === state.snap.live.wakeId);
      const ph = this.phases[this.i];
      const n = this.wake.trace.length;
      this.posEl.textContent = !ph ? '' : this.view?.live ? `deciding turn ${n + 1}` : this.liveEnded ? 'ended · saving' : ph.kind === 'trigger' ? 'trigger' : ph.kind === 'end' ? 'ended' : `turn ${ph.ti + 1} of ${n}`;
    }
  }

  function svgIcon(d) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '12');
    svg.setAttribute('height', '12');
    svg.setAttribute('aria-hidden', 'true');
    svg.append(s('path', { d, fill: 'currentColor' }));
    return svg;
  }
  function prettyInput(raw) {
    let txt = typeof raw === 'string' ? raw : JSON.stringify(raw ?? {});
    try {
      const obj = typeof raw === 'object' && raw ? raw : JSON.parse(txt);
      const keys = Object.keys(obj);
      if (!keys.length) return '';
      txt = keys.map((k) => `${k}: ${typeof obj[k] === 'string' ? obj[k] : JSON.stringify(obj[k])}`).join('\n');
    } catch {
      /* keep raw */
    }
    return clean(txt);
  }

  // ------------------------------------------------------------------ the gap tree
  function jumpGap(gapId) {
    const target = document.querySelector(`[data-gap-row="${gapId}"]`);
    if (!target) {
      // Hidden behind a filter or the standing fold: clear them and try again.
      state.gapFilter = 'all';
      state.gapQuery = '';
      state.showStanding = true;
      $('#gapSearch').value = '';
      for (const o of document.querySelectorAll('#gapFilter button')) o.setAttribute('aria-checked', String(o.dataset.gfilter === 'all'));
      renderGaps();
    }
    state.openGaps.add(gapId);
    renderGaps();
    const row = document.querySelector(`[data-gap-row="${gapId}"]`);
    if (!row) return;
    row.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'center' });
    row.classList.remove('flash');
    void row.offsetWidth;
    row.classList.add('flash');
  }

  function renderGaps() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const gaps = snap.gaps;
    const byId = new Map(gaps.map((g) => [g.id, g]));
    const root = byId.get('gap_root');
    const childrenOf = (id) => gaps.filter((g) => g.id !== 'gap_root' && (g.parentId === id || (id === 'gap_root' && (!g.parentId || !byId.has(g.parentId)))));
    const served = servingGap();
    const order = { open: 0, waiting: 1, proposed: 2, closed: 3, dropped: 4 };
    const gf = state.gapFilter || 'all';
    const gq = (state.gapQuery || '').trim().toLowerCase();
    const isDone = (g) => g.status === 'closed' || g.status === 'dropped';
    const matchesGap = (g) => {
      if (g.id === 'gap_root') return true;
      if (gf === 'life' && (g.standing || isDone(g))) return false;
      if (gf === 'selfopt' && !g.standing) return false;
      if (gf === 'proposed' && g.status !== 'proposed') return false;
      if (gf === 'done' && !isDone(g)) return false;
      if (gq && !`${g.title} ${g.target} ${g.reality} ${g.id}`.toLowerCase().includes(gq)) return false;
      return true;
    };

    const nextOf = (g) => (g.id === 'gap_root' ? [...g.next, ...snap.looseWatches.map((w) => ({ ...w, loose: true }))] : g.next);
    const sideOf = (g) => {
      const bits = [];
      if (g.id === 'gap_root') return [el('span', null, 'never closes')];
      if (isDone(g)) return [el('span', null, `${g.status} ${fmtAgo(now - Date.parse(g.updatedAt))}`)];
      if (g.status === 'proposed') bits.push(el('span', { class: 'warn' }, 'needs your yes'));
      if (g.due && Number.isFinite(Date.parse(g.due))) {
        const ms = Date.parse(g.due) - Date.now();
        bits.push(el('span', { class: ms < 0 ? 'warn' : '', title: `Wanted by ${fmtWhen(g.due, now)}` }, ms >= 0 ? `due ${fmtIn(ms).replace(/^in /, 'in ')}`.replace('due due now', 'due now') : `overdue ${fmtAgo(-ms).replace(/ ago$/, '')}`));
      }
      const nx = g.next[0];
      if (nx) bits.push(nx.kind === 't3_thread' ? el('span', null, 'thread running') : nx.fireAt ? el('span', { class: 'num' }, `⏱ ${fmtWhen(nx.fireAt, now)}`) : null);
      else if (!g.standing) bits.push(el('span', { class: 'dim' }, 'no next move'));
      return bits.filter(Boolean);
    };

    const gapRow = (g) => {
      const isRoot = g.id === 'gap_root';
      const open = state.openGaps.has(g.id);
      const mark = isRoot ? 'root' : g.standing && !isDone(g) ? 'standing' : g.status;
      const toggle = () => {
        if (state.openGaps.has(g.id)) state.openGaps.delete(g.id);
        else state.openGaps.add(g.id);
        renderGaps();
      };
      const head = el(
        'button',
        { class: 'gap-head', type: 'button', 'aria-expanded': String(open), title: g.id, onclick: toggle },
        el('span', { class: `gap-mark ${mark}`, 'aria-label': isRoot ? 'Root' : g.standing ? 'Standing' : GAP_STATUS[g.status] ?? g.status }, GAP_GLYPH[mark] ?? '○'),
        el('span', { class: 'gap-title' }, g.title),
        el('span', { class: 'gap-side' }, sideOf(g)),
      );
      const row = el('div', { class: `gap${isDone(g) ? ' done' : ''}${isRoot ? ' root' : ''}${served === g.id ? ' served' : ''}${open ? ' open' : ''}`, 'data-gap-row': g.id }, head);
      if (open) {
        const detail = el('div', { class: 'gap-detail' });
        detail.append(
          el('div', { class: 'tvr' }, el('div', { class: 'want' }, el('div', { class: 'k' }, 'What you want'), el('p', null, clean(g.target))), el('div', { class: 'now' }, el('div', { class: 'k' }, 'True right now'), el('p', null, clean(g.reality)))),
        );
        const facts = [];
        if (!isRoot) facts.push(g.source === 'owner' ? 'you asked' : 'he spotted it', `opened ${fmtAgo(now - Date.parse(g.createdAt))}`);
        if (g.due) facts.push(`wanted by ${fmtWhen(g.due, now)}`);
        if (g.standing) facts.push('standing: never closes');
        if (facts.length) detail.append(el('div', { class: 'facts' }, facts.join(' · ')));
        if (g.waitingOn) detail.append(el('div', { class: 'sub' }, el('div', { class: 'k' }, 'Waits on'), el('p', null, clean(g.waitingOn))));
        if (!isDone(g)) {
          const moves = nextOf(g);
          const list = el('ul', { class: 'lines' });
          if (!moves.length) list.append(el('li', null, el('span', { class: 'when' }, '–'), el('span', { class: 'what dim' }, 'No next move in motion. Code schedules a quick return at the end of a wake.')));
          for (const mv of moves.slice(0, 5)) {
            const nice = humanizeLabel(mv.label);
            const when = mv.kind === 't3_thread' ? 'when thread ends' : mv.fireAt ? [fmtWhen(mv.fireAt, now), ' ', el('span', { class: 'dim', 'data-in': mv.fireAt }, fmtIn(Date.parse(mv.fireAt) - Date.now()))] : '–';
            list.append(el('li', { title: nice }, el('span', { class: 'when' }, when), el('span', { class: 'what' }, short(nice, 200))));
          }
          if (moves.length > 5) list.append(el('li', null, el('span', { class: 'when' }, ''), el('span', { class: 'what dim' }, `and ${moves.length - 5} more`)));
          detail.append(el('div', { class: 'sub' }, el('div', { class: 'k' }, 'Next moves'), list));
        }
        if (!isRoot && g.log?.length) {
          // Code's record of what was already tried for this gap, newest first.
          const tried = el('ul', { class: 'lines' });
          for (const e of [...g.log].reverse()) {
            const st = e.status === 'ok' ? 'ok' : e.status === 'pending_approval' ? 'pending_approval' : 'failed';
            tried.append(
              el(
                'li',
                { title: clean(e.result) },
                el('span', { class: 'when' }, fmtWhen(e.at, now)),
                el('span', { class: 'what' }, el('span', { class: `status ${st}` }, capFirst(toolWords(e.toolId))), ' ', short(clean(e.result), 160), e.wakeId ? [' ', el('button', { class: 'link', type: 'button', onclick: () => openWake(e.wakeId), title: 'Play this wake back' }, 'wake →')] : null),
              ),
            );
          }
          detail.append(el('div', { class: 'sub' }, el('div', { class: 'k' }, 'Work log'), tried));
        }
        row.append(detail);
      }
      return row;
    };

    const hasMatch = (g) => matchesGap(g) || childrenOf(g.id).some(hasMatch);
    const build = (g, depth) => {
      const li = el('li', null, gapRow(g));
      const allKids = childrenOf(g.id)
        .filter(hasMatch)
        .sort((a, b) => Number(!!a.standing) - Number(!!b.standing) || (order[a.status] ?? 9) - (order[b.status] ?? 9) || Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      if (g.id === 'gap_root' && gf === 'all' && !gq) {
        const lifeKids = allKids.filter((k) => !k.standing);
        const standKids = allKids.filter((k) => k.standing);
        const ul = el('ul', null, lifeKids.map((k) => build(k, depth + 1)));
        if (standKids.length) {
          const open = !!state.showStanding;
          const btn = el('button', { class: 'fold', type: 'button', 'aria-expanded': String(open), onclick: () => ((state.showStanding = !state.showStanding), renderGaps()) }, `${open ? '▾' : '▸'} ${GAP_GLYPH.standing} ${plural(standKids.length, 'standing self-optimization gap')}`);
          ul.append(el('li', null, btn, open ? el('ul', null, standKids.map((k) => build(k, depth + 1))) : null));
        }
        li.append(ul);
      } else if (allKids.length && depth < 6) {
        li.append(el('ul', null, allKids.map((k) => build(k, depth + 1))));
      }
      return li;
    };
    const tree = el('ul', { class: 'gap-tree' }, root ? build(root, 0) : null);
    const empty = root && !childrenOf('gap_root').some(hasMatch) && (gf !== 'all' || gq) ? el('p', { class: 'empty' }, 'No gaps match.') : null;
    $('#gapTree').replaceChildren(tree, empty ?? '');
    const c = snap.anatomy.gaps;
    $('#gapNote').textContent = [c.open && `${c.open} open`, c.waiting && `${c.waiting} waiting`, c.proposed && `${c.proposed} proposed`, (c.closed || c.dropped) && `${c.closed + c.dropped} done today`].filter(Boolean).join(' · ') || 'Only the root gap so far.';
  }

  // ------------------------------------------------------------------ needs you
  function renderNeeds() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const box = $('#needs');
    const items = [];
    for (const a of snap.approvals) {
      items.push(
        el(
          'div',
          { class: 'need' },
          el('div', { class: 'kind' }, 'Held for your yes'),
          el('div', { class: 'what', title: a.toolId }, `${capFirst(toolWords(a.toolId))}${a.gapId && snap.gapTitles[a.gapId] ? ` for “${short(snap.gapTitles[a.gapId], 60)}”` : ''}`),
          prettyInput(a.input) ? el('pre', { class: 'detail' }, short(prettyInput(a.input), 260)) : null,
          el('div', { class: 'ago' }, `asked ${fmtAgo(now - Date.parse(a.createdAt))} · reply yes or no in Telegram`),
        ),
      );
    }
    for (const g of snap.gaps.filter((x) => x.status === 'proposed')) {
      items.push(
        el(
          'div',
          { class: 'need clickable', tabindex: '0', role: 'button', onclick: () => jumpGap(g.id), onkeydown: onActivate(() => jumpGap(g.id)) },
          el('div', { class: 'kind' }, 'Gap waiting for your yes'),
          el('div', { class: 'what' }, g.title),
          el('p', { class: 'detail serif' }, short(clean(g.target), 220)),
          el('div', { class: 'ago' }, `he spotted it ${fmtAgo(now - Date.parse(g.createdAt))} · open it →`),
        ),
      );
    }
    for (const h of brokenSenses(snap)) {
      items.push(el('div', { class: 'need fail' }, el('div', { class: 'kind' }, 'A sense isn’t working'), el('div', { class: 'what' }, CONNECTOR_LABEL[h.id] ?? capFirst(h.id)), el('p', { class: 'detail' }, short(clean(h.problem ?? ''), 200)), h.lastSuccessAt ? el('div', { class: 'ago' }, `last worked ${fmtAgo(now - Date.parse(h.lastSuccessAt))}`) : null));
    }
    const waiting = snap.gaps.filter((x) => x.status === 'waiting' && x.waitingOn);
    const out = items.length ? items : [el('p', { class: 'calm' }, 'Nothing needs you')];
    if (waiting.length) {
      out.push(
        el('h3', { class: 'waiting-head' }, 'Waiting on others'),
        el(
          'ul',
          { class: 'waiting' },
          waiting.map((g) => el('li', null, el('button', { class: 'link', type: 'button', onclick: () => jumpGap(g.id) }, g.title), el('span', { class: 'dim' }, ` — on ${short(clean(g.waitingOn), 120)}`))),
        ),
      );
    }
    box.replaceChildren(...out);
    const n = ownerNeeds(snap);
    const head = $('#needsHead');
    head.replaceChildren('Needs you', n ? el('span', { class: 'count num' }, String(n)) : '');
  }

  // ------------------------------------------------------------------ timeline
  function renderTimeline() {
    const tl = state.timeline;
    const box = $('#timeline');
    if (!tl) return;
    const W = Math.max(300, Math.round(box.clientWidth || 1000));
    const narrow = W < 640;
    const gutter = narrow ? 84 : 128;
    const plotW = W - gutter - 12;
    const from = Date.parse(tl.from);
    const to = Date.parse(tl.to);
    const x = (t) => gutter + ((t - from) / (to - from)) * plotW;
    const laneH = 18;
    const lanes = [];
    const counts = {};
    for (const e of tl.events) if (e.sense !== 'self') (counts[e.sense] ??= []).push(e);
    lanes.push({ group: 'Senses' });
    for (const sense of ['message', 'email', 'calendar', 'screen', 'browser', 'file', 'system', 'other', 'watch']) {
      if (!counts[sense]?.length && sense !== 'message') continue;
      lanes.push({ id: sense, label: SENSE_LABEL[sense], items: counts[sense] ?? [] });
    }
    lanes.push({ group: 'Bouncer' });
    if (tl.decisionsLogged) {
      lanes.push({ id: 'b-wake', label: 'Woke him', items: tl.decisions.filter((d) => d.label === 'WAKE') });
      lanes.push({ id: 'b-sleep', label: 'Let sleep', items: tl.decisions.filter((d) => d.label === 'SLEEP') });
    } else lanes.push({ id: 'b-note', label: 'Calls', items: [], note: 'Each call is logged from the next daemon restart. Until then, the wakes below show what got through.' });
    lanes.push({ group: 'Rufus' });
    lanes.push({ id: 'wakes', label: 'Awake', items: tl.wakes });
    lanes.push({ id: 'sent', label: 'Said', items: tl.sent });

    let y = 4;
    const svg = s('svg', { width: W, role: 'img', 'aria-label': `Timeline of the last ${tl.hours} hours: ${tl.events.length} events, ${tl.wakes.length} wakes, ${tl.sent.length} messages sent` });
    const grid = s('g');
    const marks = s('g');
    const labels = s('g');
    svg.append(grid, marks, labels);
    const laneY = {};
    const liveId = state.snap?.live.status === 'awake' ? state.snap.live.wakeId : undefined;
    const selectedId = state.sheet?.kind === 'wake' ? state.sheet.id : undefined;
    for (const lane of lanes) {
      if (lane.group) {
        y += 10;
        labels.append(s('text', { class: 'tl-group', x: 0, y: y + 8 }, lane.group));
        y += 12;
        continue;
      }
      laneY[lane.id] = y;
      const mid = y + laneH / 2;
      labels.append(s('text', { class: 'tl-lane', x: 0, y: mid + 4 }, lane.label));
      if (lane.items.length && !narrow) labels.append(s('text', { class: 'tl-count', x: gutter - 12, y: mid + 3.5, 'text-anchor': 'end' }, fmtNum(lane.items.length)));
      grid.append(s('line', { class: 'tl-base', x1: gutter, x2: gutter + plotW, y1: mid, y2: mid }));
      if (lane.note) labels.append(s('text', { class: 'tl-note', x: gutter + 6, y: mid + 4 }, narrow ? 'Logged from the next restart.' : lane.note));
      if (lane.id === 'wakes') {
        for (const w of lane.items) {
          const x1 = x(Date.parse(w.start));
          const x2 = x(Date.parse(w.end));
          const broke = w.ending === 'crashed' || w.ending === 'unreadable';
          const cls = ['tl-wake', w.acted ? 'acted' : '', broke ? 'broke' : w.ending === 'cap' ? 'cap' : '', w.wakeId === liveId ? 'live' : '', w.wakeId === selectedId ? 'selected' : ''].filter(Boolean).join(' ');
          marks.append(s('rect', { class: cls, x: Math.min(x1, x2 - 2).toFixed(1), y: mid - 5, width: Math.max(2, x2 - x1).toFixed(1), height: 10, 'data-wake': w.wakeId }));
        }
      } else if (lane.id === 'sent') {
        for (const m of lane.items) marks.append(s('circle', { class: 'tl-sent', cx: x(Date.parse(m.at)).toFixed(1), cy: mid, r: 3 }));
      } else {
        const cls = lane.id === 'b-wake' ? 'wakeTick' : lane.id === 'b-sleep' ? 'sleepTick' : '';
        let d = '';
        let dOwner = '';
        for (const e of lane.items) {
          const xx = x(Date.parse(e.at)).toFixed(1);
          if (lane.id === 'message' && e.kind === 'owner_direct') dOwner += `M${xx},${mid - 6}V${mid + 6}`;
          else d += `M${xx},${mid - 4}V${mid + 4}`;
        }
        if (d) marks.append(s('path', { class: `tl-tick ${cls}`, d }));
        if (dOwner) marks.append(s('path', { class: 'tl-tick owner', d: dOwner }));
      }
      y += laneH + 2;
    }
    // axis
    const axisY = y + 8;
    const stepH = tl.hours <= 6 ? 1 : tl.hours <= 24 ? (narrow ? 6 : 3) : narrow ? 24 : 12;
    const first = new Date(from);
    first.setMinutes(0, 0, 0);
    let tt = first.getTime() + HOUR;
    while (new Date(tt).getHours() % stepH !== 0) tt += HOUR;
    for (; tt < to - (plotW < 500 ? 2 : 1) * HOUR * (stepH / 3); tt += stepH * HOUR) {
      const xx = x(tt);
      grid.append(s('line', { class: 'tl-grid', x1: xx, x2: xx, y1: 4, y2: axisY - 6 }));
      const d = new Date(tt);
      const label = d.getHours() === 0 ? `${dayFmt.format(d)}` : timeFmt.format(d).replace(':00', '');
      labels.append(s('text', { class: 'tl-axis', x: xx, y: axisY + 8, 'text-anchor': 'middle' }, label));
    }
    grid.append(s('line', { class: 'tl-now', x1: gutter + plotW, x2: gutter + plotW, y1: 4, y2: axisY - 6 }));
    labels.append(s('text', { class: 'tl-axis', x: gutter + plotW, y: axisY + 8, 'text-anchor': 'end' }, 'now'));
    const H = axisY + 16;
    svg.setAttribute('height', String(H));
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    const cross = s('line', { class: 'tl-cross', y1: 4, y2: axisY - 6, x1: -10, x2: -10, opacity: 0 });
    svg.append(cross);
    const hit = s('rect', { x: gutter, y: 0, width: plotW, height: axisY, fill: 'transparent', style: 'cursor: crosshair' });
    svg.append(hit);
    const legend = el(
      'ul',
      { class: 'tl-legend' },
      el('li', null, el('i', { class: 'k-tick' }), 'an event'),
      el('li', null, el('i', { class: 'k-owner' }), 'a message from you'),
      el('li', null, el('i', { class: 'k-wake' }), 'awake, and acted'),
      el('li', null, el('i', { class: 'k-wake soft' }), 'awake, only read'),
      el('li', null, el('i', { class: 'k-wake broke' }), 'crashed'),
      el('li', null, el('i', { class: 'k-sent' }), 'he said something'),
    );
    box.replaceChildren(svg, legend);

    const tip = $('#tooltip');
    let hovered;
    const nearestWake = (px) => {
      let best;
      let bd = 7;
      for (const w of tl.wakes) {
        const x1 = x(Date.parse(w.start));
        const x2 = Math.max(x1 + 2, x(Date.parse(w.end)));
        const dd = px < x1 ? x1 - px : px > x2 ? px - x2 : 0;
        if (dd < bd || (dd === bd && w.acted)) {
          bd = dd;
          best = w;
        }
      }
      return best;
    };
    const onLeave = () => {
      cross.setAttribute('opacity', '0');
      tip.hidden = true;
      if (hovered) hovered.classList.remove('hover');
      hovered = undefined;
    };
    const onMove = (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const py = ((ev.clientY - r.top) / r.height) * H;
      if (px < gutter || px > gutter + plotW) return onLeave();
      cross.setAttribute('x1', px.toFixed(1));
      cross.setAttribute('x2', px.toFixed(1));
      cross.setAttribute('opacity', '1');
      const t = from + ((px - gutter) / plotW) * (to - from);
      const half = (8 / plotW) * (to - from);
      const near = (iso) => Math.abs(Date.parse(iso) - t) <= half;
      const wNear = nearestWake(px);
      const inWakeLane = laneY.wakes !== undefined && py >= laneY.wakes - 4 && py <= laneY.wakes + laneH + 4;
      if (hovered) hovered.classList.remove('hover');
      hovered = undefined;
      tip.replaceChildren(el('div', { class: 'tt-time' }, fmtWhen(t)));
      if (wNear && (inWakeLane || !lanes.some((l) => l.items?.some?.((e) => e.at && near(e.at))))) {
        hovered = marks.querySelector(`[data-wake="${wNear.wakeId}"]`);
        hovered?.classList.add('hover');
        tip.append(
          el('div', { class: 'tt-row' }, el('b', null, String(wNear.turns)), wNear.turns === 1 ? 'move' : 'moves', ` · ${triggerWords({ source: wNear.sense === 'other' ? '' : wNear.sense, kind: wNear.triggerKind })} · ${fmtDur(Date.parse(wNear.end) - Date.parse(wNear.start))}${wNear.sent ? ` · said ${wNear.sent}` : ''}`),
          el('div', { class: 'tt-text' }, short(clean(wNear.text), 140)),
          el('div', { class: 'tt-hint' }, 'Click to play this wake back'),
        );
      } else {
        for (const lane of lanes) {
          if (!lane.items?.length || lane.id === 'wakes') continue;
          const n = lane.items.filter((e) => e.at && near(e.at)).length;
          if (n) tip.append(el('div', { class: 'tt-row' }, el('b', null, String(n)), lane.label));
        }
        const said = tl.sent.find((m) => near(m.at));
        if (said) tip.append(el('div', { class: 'tt-text' }, `“${short(clean(said.text), 140)}”`));
        if (tip.childElementCount === 1) tip.append(el('div', { class: 'tt-hint' }, 'Quiet.'));
      }
      tip.hidden = false;
      const tw = tip.offsetWidth;
      const th = tip.offsetHeight;
      let lx = ev.clientX + 14;
      if (lx + tw > window.innerWidth - 8) lx = ev.clientX - tw - 14;
      let ly = ev.clientY - th - 12;
      if (ly < 8) ly = ev.clientY + 16;
      tip.style.left = `${Math.max(8, lx)}px`;
      tip.style.top = `${ly}px`;
    };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerleave', onLeave);
    hit.addEventListener('click', (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const w = nearestWake(px);
      if (w) {
        onLeave();
        openWake(w.wakeId);
      }
    });

    const ev = tl.events.filter((e) => e.sense !== 'self').length;
    $('#timelineNote').textContent = `${plural(ev, 'event')} · ${plural(tl.wakes.length, 'wake')} · ${plural(tl.sent.length, 'message')} sent · since ${fmtWhen(from)}`;
  }

  // ------------------------------------------------------------------ wake log
  function renderWakeList() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const list = $('#wakeList');
    const all = snap.wakes;
    const wq = (state.wakeQuery || '').trim().toLowerCase();
    const byMode = state.wakeFilter === 'acted' ? all.filter((w) => w.acted || w.sent) : state.wakeFilter === 'crashed' ? all.filter((w) => w.ending && w.ending !== 'sleep') : all;
    const shown = wq ? byMode.filter((w) => `${w.trigger?.text || ''} ${w.firstSent || ''} ${w.ending || ''} ${triggerWords(w.trigger)}`.toLowerCase().includes(wq)) : byMode;
    const items = shown.slice(0, state.wakeLimit).map((w) => {
      const moves = el('span', { class: 'w-moves', 'aria-label': `${w.turns} moves` });
      for (const mv of w.moves.slice(0, 30)) {
        const tone = toneOfStatus(mv.status);
        const cls = mv.toolId === 'sleep' ? 'st-sleep' : tone === 'fail' ? 'st-fail' : tone === 'wait' ? 'st-wait' : mv.toolId === 'send_message' ? 'st-say' : '';
        moves.append(el('i', { class: cls, title: toolWords(mv.toolId) }));
      }
      const broke = w.ending === 'crashed' || w.ending === 'unreadable';
      return el(
        'li',
        { class: `wake-row${state.sheet?.kind === 'wake' && state.sheet.id === w.wakeId ? ' selected' : ''}`, 'data-wake': w.wakeId },
        el(
          'button',
          { type: 'button', onclick: () => openWake(w.wakeId) },
          el('span', { class: 'w-time num' }, fmtWhen(w.at, now)),
          el('span', { class: 'w-main' }, el('span', { class: 'w-src' }, triggerWords(w.trigger)), el('span', { class: 'w-text' }, short(clean(w.trigger.text), 150)), w.firstSent ? el('span', { class: 'w-said' }, `“${short(clean(w.firstSent), 150)}”`) : null),
          moves,
          el('span', { class: 'w-facts num' }, el('span', null, `${w.turns}`), el('span', null, w.sent ? `said ${w.sent}` : ''), el('span', null, Number.isFinite(w.costUsd) && w.costUsd > 0 ? fmtCost(w.costUsd) : ''), el('span', { class: broke ? 'fail' : w.ending === 'cap' ? 'warn' : '' }, w.ending !== 'sleep' ? endingWord(w.ending) : '')),
        ),
      );
    });
    if (!items.length) items.push(el('li', { class: 'wake-row empty-row' }, el('p', { class: 'empty' }, all.length ? (wq ? 'No wakes match.' : 'He hasn’t acted in the recent wakes. Choose All to see every wake.') : 'No wakes recorded yet.')));
    list.replaceChildren(...items);
    if (shown.length > state.wakeLimit) {
      list.append(el('li', { class: 'wake-row more-row' }, el('button', { type: 'button', class: 'link', onclick: () => ((state.wakeLimit += 24), renderWakeList()) }, `Show more (${shown.length - state.wakeLimit} older)`)));
    }
  }

  function renderFoot() {
    const snap = state.snap;
    $('#foot').replaceChildren(el('span', null, `Read-only view of ${snap.workspace} · 127.0.0.1`), el('span', null, `daemon :${snap.daemon.port} ${snap.daemon.up ? 'answering' : 'not answering'}`), el('span', null, 'Press ? for keys'));
  }

  // ------------------------------------------------------------------ ticking text (clock, timers, countdowns). Text only; no animation.
  function tick() {
    const now = Date.now();
    $('#clock').textContent = clockFmt.format(new Date(now));
    for (const n of document.querySelectorAll('[data-in]')) n.textContent = fmtIn(Date.parse(n.dataset.in) - now);
    for (const n of document.querySelectorAll('[data-ago]')) n.textContent = `for ${fmtDur(now - Date.parse(n.dataset.ago)).replace(/\.\ds$/, 's')}`;
    for (const n of document.querySelectorAll('[data-watch]')) n.textContent = fmtWatch(now - Date.parse(n.dataset.watch));
    for (const n of document.querySelectorAll('[data-span]')) n.textContent = fmtSpan(now - Date.parse(n.dataset.span));
    if (state.snap && !state.player) Plate.setCenter();
  }

  // ------------------------------------------------------------------ theme, help + controls
  function setTheme(t) {
    document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
    try {
      localStorage.setItem('rufus-theme', t);
    } catch {
      /* private mode */
    }
    if (state.snap) renderRail();
  }
  function initTheme() {
    let t = 'dark';
    try {
      t = localStorage.getItem('rufus-theme') || 'dark';
    } catch {
      /* private mode */
    }
    document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
    $('#themeBtn').addEventListener('click', () => setTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
  }

  const help = {
    open() {
      $('#help').hidden = false;
      $('#help .help-card').focus?.();
    },
    close() {
      $('#help').hidden = true;
    },
    toggle() {
      if ($('#help').hidden) this.open();
      else this.close();
    },
  };

  function setRadio(groupSel, btn) {
    for (const o of document.querySelectorAll(`${groupSel} button`)) o.setAttribute('aria-checked', String(o === btn));
  }

  function initControls() {
    $('#needsChip').addEventListener('click', () => $('#needsSec').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' }));
    $('#helpBtn').addEventListener('click', () => help.toggle());
    $('#help').addEventListener('click', (e) => e.target.id === 'help' && help.close());
    for (const b of document.querySelectorAll('#rangeSeg button')) {
      b.addEventListener('click', async () => {
        state.hours = Number(b.dataset.hours);
        setRadio('#rangeSeg', b);
        state.timeline = await getJSON(`/api/timeline?hours=${state.hours}`).catch(() => state.timeline);
        renderTimeline();
      });
    }
    for (const b of document.querySelectorAll('#gapFilter button')) {
      b.addEventListener('click', () => {
        state.gapFilter = b.dataset.gfilter;
        setRadio('#gapFilter', b);
        renderGaps();
      });
    }
    const gapSearch = $('#gapSearch');
    gapSearch.addEventListener('input', () => {
      state.gapQuery = gapSearch.value;
      renderGaps();
    });
    const wakeSearch = $('#wakeSearch');
    wakeSearch.addEventListener('input', () => {
      state.wakeQuery = wakeSearch.value;
      state.wakeLimit = 24;
      renderWakeList();
    });
    for (const b of document.querySelectorAll('#wakeFilter button')) {
      b.addEventListener('click', () => {
        state.wakeFilter = b.dataset.filter;
        state.wakeLimit = 24;
        setRadio('#wakeFilter', b);
        renderWakeList();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      const pb = state.player;
      const k = e.key;
      if (k === 'Escape') {
        if (!$('#help').hidden) help.close();
        else if (state.sheet) closeSheet();
        return;
      }
      if (k === '?') return help.toggle();
      if (!$('#help').hidden) return;
      if (k === '/') {
        e.preventDefault();
        gapSearch.focus();
        gapSearch.select();
      } else if (k === 't' || k === 'T') {
        $('#themeBtn').click();
      } else if (k === 'g' || k === 'G') {
        $('#gapsSec').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      } else if (k === 'n' || k === 'N') {
        $('#needsSec').scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
      } else if (k === 'l' || k === 'L') {
        followLive();
      } else if (/^[0-9]$/.test(k)) {
        openNodeSheet(k === '0' ? 10 : Number(k));
      } else if (pb && k === ' ' && !e.target.closest?.('button, [role="button"], a')) {
        e.preventDefault();
        pb.toggle();
      } else if (pb && k === 'ArrowRight') {
        e.preventDefault();
        pb.stepTurn(1);
      } else if (pb && k === 'ArrowLeft') {
        e.preventDefault();
        pb.stepTurn(-1);
      } else if (pb && k === ']') {
        pb.setSpeed(1);
      } else if (pb && k === '[') {
        pb.setSpeed(-1);
      }
    });
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => state.timeline && renderTimeline(), 120);
    });
    reduceMotion.addEventListener?.('change', () => state.snap && Plate.render());
  }

  // ------------------------------------------------------------------ boot
  async function boot() {
    initTheme();
    initControls();
    Plate.init();
    tick();
    setInterval(tick, 1000);
    try {
      await refresh();
    } catch (err) {
      showError(err);
      $('#statement').textContent = 'Couldn’t read the workspace.';
    }
    connectStream();
    // Health and countdown-driven state (a timer coming due) without any file change.
    setInterval(() => refresh(['live.json']).catch(() => undefined), 30_000);
  }
  window.__rufus = { state, refresh, openWake, openNodeSheet, closeSheet, followLive, Plate };
  boot();
})();
