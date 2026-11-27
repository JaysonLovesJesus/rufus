/* Rufus dashboard: an anatomy plate of the outline, alive.
   Vanilla JS + SVG. Every motion marks a real event: an event arriving, a turn of a wake (live or played back). */
'use strict';

(() => {
  // ------------------------------------------------------------------ utilities
  const $ = (sel, root = document) => root.querySelector(sel);
  const NS = 'http://www.w3.org/2000/svg';
  const MIN = 60e3;
  const HOUR = 60 * MIN;
  const DAY = 24 * HOUR;
  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

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

  // ------------------------------------------------------------------ time, in plain local words
  const timeFmt = new Intl.DateTimeFormat('en-US', { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat('en-US', { weekday: 'short' });
  const dateFmt = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' });
  const startOfDay = (t) => {
    const d = new Date(t);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  function fmtClock(t) {
    return timeFmt.format(new Date(t));
  }
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

  /** Free text from the workspace, made readable: ISO times in local words, gap ids as their titles. */
  const ISO_RE = /\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g;
  const DATE_RE = /(?<![\w/.-])\d{4}-\d{2}-\d{2}(?![\w/.-])/g;
  const GAP_RE = /\bgap_(?:root|[a-z0-9]{6})\b/g;
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
  const UUID_RE = /\b(?:mcp:)?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi;
  const WATCH_ID_RE = /\bwatch_[0-9a-f]{6}\b(?:\s*\/\s*)?/g;
  const WAKE_ID_RE = /\bwake_[0-9a-f]{8}\b/g;
  const TOOL_RE = /\b[a-z][a-z0-9]*(?:[._][a-z0-9]+)+\b/g;

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
    'self.inspect_tool': 'inspect a tool', 'self.recent_activity': 'review his recent activity',
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
  const capFirst = (x) => (x ? x[0].toUpperCase() + x.slice(1) : x);

  // ------------------------------------------------------------------ vocabulary
  const SENSE_LABEL = { message: 'Messages', email: 'Email', calendar: 'Calendar', screen: 'Active app', browser: 'Browser', file: 'Downloads', system: 'System', other: 'Other', watch: 'Wake-ups', self: 'His own actions' };
  const LEVEL_WORDS = { never: 'Blocked', rehearse: 'Rehearse', draft: 'Draft and ask', act_and_report: 'Do and report', act_quietly: 'Do quietly' };
  const LADDER = ['never', 'rehearse', 'draft', 'act_and_report', 'act_quietly'];
  const STATUS_WORDS = { ok: 'Done', failed: 'Failed', timed_out: 'Timed out', pending_approval: 'Waiting for your yes', invalid_input: 'Rejected', rehearsed: 'Rehearsed' };
  const GAP_STATUS = { open: 'Open', proposed: 'Proposed', waiting: 'Waiting', closed: 'Closed', dropped: 'Dropped' };
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
      case 'system': return k === 'startup' ? 'Restart' : 'System';
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

  // ------------------------------------------------------------------ state + data
  const state = {
    snap: undefined,
    timeline: undefined,
    hours: 24,
    wakeFilter: 'acted',
    wakeLimit: 24,
    seenEvents: undefined,
    sheet: undefined, // { kind: 'node', part } | { kind: 'wake', id, live }
    player: undefined,
    liveDismissed: undefined,
    plateSize: 0,
    lastGeomKey: '',
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

  function connectStream() {
    let es;
    try {
      es = new EventSource('/api/stream');
    } catch {
      return;
    }
    es.addEventListener('change', (ev) => {
      try {
        scheduleRefresh(JSON.parse(ev.data).files || []);
      } catch {
        scheduleRefresh(['live.json']);
      }
    });
    es.addEventListener('hello', () => {
      if (state.snap) scheduleRefresh(['events.jsonl', 'wakes.jsonl', 'live.json']);
    });
  }

  function showError(err) {
    console.warn(err);
    $('#foot').textContent = `Couldn’t read the dashboard data (${err?.message ?? err}). Retrying on the next change.`;
  }

  // ------------------------------------------------------------------ render all
  function renderAll() {
    renderHeader();
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
    const s = clean(raw || '').replace(/\/(?:Users|home)\/[^/\s]+\//g, '~/');
    const reset = /(?:resets?\s+(?:at\s+)?|parked until\s+)(\d{1,2}(?::\d{2})?\s*(?:am|pm))/i.exec(s);
    if (/5-hour limit|weekly limit|rate[ -]?limit|All providers failed|parked until/i.test(s)) {
      return reset ? `Resume after Claude limit resets (${reset[1]})` : 'Resume when AI provider is back';
    }
    if (/^Resume:\s*the last wake ended before these gaps had a next move/i.test(s)) {
      return 'Quick return for gaps from the previous wake';
    }
    return s;
  }

  function renderTelemetry(snap) {
    const host = $('#telemetry');
    if (!host) return;
    host.replaceChildren();
    const c = snap.credits || {};
    const t = snap.telemetry || {};
    const a = snap.anatomy || {};
    const b = a.bouncer || {};
    const trust = a.trust || {};

    const mkCard = ({ kicker, dotCls, val, sub, pct, barCls, part, title }) =>
      el(
        'button',
        { class: 't-card', type: 'button', title: title || sub, onclick: () => openNodeSheet(part) },
        el('div', { class: 't-kicker' }, kicker, el('span', { class: `t-dot${dotCls ? ` ${dotCls}` : ''}` })),
        el('div', { class: 't-val' }, val),
        el('div', { class: 't-sub', title: sub }, sub),
        el('div', { class: 't-bar', role: 'progressbar', 'aria-valuenow': String(pct), 'aria-valuemin': '0', 'aria-valuemax': '100' }, el('i', { class: barCls || '', style: `width:${pct}%` })),
      );

    // Card 1: Intelligence & Credits
    const paused = !!c.pausedUntil;
    const creditVal = paused ? `Paused · resets ${c.resetLabel || 'soon'}` : `Claude · ${c.left5hPct ?? 100}% left (5h)`;
    const backups = ['Gemini', c.localModel ? 'Local Qwen 3B' : null, 'Zero-AI'].filter(Boolean).join(' → ');
    const card1 = mkCard({
      kicker: 'Intelligence & Credits',
      dotCls: paused ? 'warn' : '',
      val: creditVal,
      sub: paused ? `Backups: ${backups}` : `7d ~${c.left7dPct ?? 100}% left · backups: ${backups}`,
      pct: paused ? 100 : (c.left5hPct ?? 100),
      barCls: paused ? 'warn' : '',
      part: 6,
      title: 'Inspect Decide & credit status',
    });

    // Card 2: Bouncer Shield (uses SetFit median ms, never a triage spike)
    const pct = t.bouncerSleepPct;
    const msText = t.setfitMs !== undefined ? ` · ~${t.setfitMs}ms` : '';
    const card2 = mkCard({
      kicker: 'Bouncer Shield',
      dotCls: 'sense',
      val: pct !== undefined ? `${pct}% filtered at $0` : `${b.model === 'setfit' ? 'SetFit active' : 'Prototype'}`,
      sub: `${b.model === 'setfit' ? 'Local SetFit' : 'Prototype'} · ${fmtNum(b.examples || 0)} labels${msText}`,
      pct: pct ?? 60,
      barCls: 'sense',
      part: 3,
      title: 'Inspect local Bouncer model',
    });

    // Card 3: Wake Efficiency
    const med = t.medianTurns || 1;
    const acted = a.desk?.acted24h ?? 0;
    const wakes = a.desk?.wakes24h ?? 0;
    const cleanNote = t.cleanSleepPct !== undefined ? ` · ${t.cleanSleepPct}% clean` : '';
    const card3 = mkCard({
      kicker: 'Wake Efficiency',
      dotCls: 'wake',
      val: `${plural(med, 'turn')} median`,
      sub: `${fmtNum(acted)} acted / ${fmtNum(wakes)} wakes (24h)${cleanNote}`,
      pct: Math.max(15, Math.min(100, Math.round((1 / Math.max(1, med)) * 100))),
      barCls: 'wake',
      part: 5,
      title: 'Inspect Desk & wake efficiency',
    });

    // Card 4: Trust & Self-Optimization
    const held = snap.approvals?.length ?? 0;
    const standing = t.standingGaps ?? 0;
    const card4 = mkCard({
      kicker: 'Trust & Self-Opt',
      dotCls: held ? 'warn' : '',
      val: held ? `${plural(held, 'draft')} awaiting yes` : 'All actions gated',
      sub: `${trust.act_quietly || 0} quiet · ${trust.draft || 0} ask · ${standing} self-opt gaps`,
      pct: 100,
      barCls: held ? 'warn' : '',
      part: 7,
      title: 'Inspect Trust Ladder & approvals',
    });

    host.append(card1, card2, card3, card4);
  }

  function renderHeader() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const daemon = $('#daemon');
    daemon.className = `daemon${snap.daemon.up ? '' : ' down'}`;
    daemon.textContent = snap.daemon.up ? 'Daemon running' : 'Daemon not answering';
    const st = $('#statement');
    const sub = $('#substatement');
    st.replaceChildren();
    sub.replaceChildren();
    const live = snap.live;
    const next = snap.anatomy.sleep.next;

    if (live.status === 'awake') {
      const t = lastTurn(live);
      const gapId = servingGap();
      const turnNo = (live.turns?.length ?? 0) + 1;
      st.append(
        el('span', { class: 'state awake' }, 'Awake'),
        ' ',
        el('span', { class: 'soft' }, live.startedAt ? el('span', { 'data-ago': live.startedAt, 'data-fmt': 'for' }, `for ${fmtDur(Date.now() - Date.parse(live.startedAt))}`) : null, `, on turn ${turnNo}`),
        ...(gapId ? [el('span', { class: 'soft' }, ', serving '), `“${short(snap.gapTitles[gapId] ?? 'a gap', 70)}”`] : [el('span', { class: 'soft' }, ', reading the Desk')]),
      );
      if (t?.thought) sub.append(el('span', { class: 'thought' }, `“${short(clean(t.thought), 180)}”`));
      sub.append(
        el('span', { class: 'machine' }, t ? `last move: ${toolWords(t.toolId)} · ${(STATUS_WORDS[t.status] ?? t.status ?? '').toLowerCase()}` : 'deciding the first move'),
        el('span', { class: 'machine' }, `woke on: ${triggerWords(live.trigger).toLowerCase()}`),
      );
    } else {
      if (!snap.daemon.up) st.append(el('span', { class: 'state down' }, 'Not running.'), ' ', el('span', { class: 'soft' }, 'The daemon isn’t answering. '));
      st.append(el('span', { class: 'state' }, snap.daemon.up ? 'Asleep' : 'Last seen asleep'));
      st.append(live.since ? el('span', { class: 'soft' }, ` since ${fmtWhen(live.since, now)}. `) : '. ');
      if (next?.at) {
        st.append('Next wake ', el('span', { class: 'num' }, fmtWhen(next.at, now)), ', ', el('span', { class: 'num', 'data-in': next.at }, fmtIn(Date.parse(next.at) - Date.now())), '.');
        sub.append(el('span', null, el('span', { class: 'soft' }, 'To: '), short(humanizeLabel(next.label), 140)));
      } else {
        st.append(el('span', { class: 'soft' }, 'Nothing scheduled to wake him.'));
      }
      const lw = snap.wakes[0];
      if (lw) {
        sub.append(
          el(
            'button',
            { class: 'machine link-btn', type: 'button', onclick: () => openWake(lw.wakeId), title: 'Open last wake in playback' },
            `last wake: ${triggerWords(lw.trigger).toLowerCase()} · ${plural(lw.turns, 'move')}${lw.sent ? ` · said ${lw.sent}` : ''}${lw.ending !== 'sleep' ? ` · ${endingWord(lw.ending)}` : ''} →`,
          ),
        );
      }
    }

    const needCount = ownerNeeds(snap);
    const chip = $('#needsChip');
    chip.hidden = needCount === 0;
    chip.replaceChildren('Needs you ', el('b', null, String(needCount)));
    const icon = document.documentElement.dataset.theme === 'light' ? MOON : SUN;
    $('#themeBtn').innerHTML = icon;
    $('#themeBtn').setAttribute('aria-label', document.documentElement.dataset.theme === 'light' ? 'Switch to dark theme' : 'Switch to light theme');
    document.title = live.status === 'awake' ? 'Rufus · awake' : 'Rufus · asleep';
    renderTelemetry(snap);
  }
  const SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="none" stroke="currentColor" stroke-width="1.3"/><g stroke="currentColor" stroke-width="1.3" stroke-linecap="round"><path d="M8 1.5v1.6M8 12.9v1.6M1.5 8h1.6M12.9 8h1.6M3.4 3.4l1.1 1.1M11.5 11.5l1.1 1.1M3.4 12.6l1.1-1.1M11.5 4.5l1.1-1.1"/></g></svg>';
  const MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 10.1A5.6 5.6 0 0 1 5.9 2.8a5.6 5.6 0 1 0 7.3 7.3Z" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/></svg>';

  // ------------------------------------------------------------------ the plate
  const Plate = {
    svg: undefined,
    base: undefined,
    fx: undefined,
    g: undefined, // geometry
    nodes: {},
    edges: {},
    on: { nodes: new Set(), tones: {}, edges: new Set(), edgeTone: {}, gap: undefined, sense: undefined, center: undefined },

    init() {
      this.svg = $('#plateSvg');
      const defs = s('defs', null, s('linearGradient', { id: 'halfFill', x1: '0', x2: '1', y1: '0', y2: '0' }, s('stop', { offset: '50%', 'stop-color': 'var(--gap)' }), s('stop', { offset: '50%', 'stop-color': 'var(--bg)' })));
      this.base = s('g');
      this.fx = s('g', { 'aria-hidden': 'true' });
      this.svg.append(defs, this.base, this.fx);
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
      const H = compact ? 450 : roomy ? 530 : 486;
      const yC = compact ? 252 : roomy ? 294 : 272;
      const r = compact ? 92 : roomy ? 134 : 114;
      const x0 = compact ? 132 : 164;
      const xM = Math.max(x0 + (compact ? 88 : 104), W * 0.215);
      const xB = Math.max(xM + (compact ? 112 : 128), W * 0.345);
      const xR = Math.max(xB + (compact ? 150 : 112) + r, W * 0.585);
      // Regular layout: the Trust gate label sits on the same line as Sleep's, so leave room for both.
      const xS = Math.min(W - 112, Math.max(xR + r + (compact ? 110 : 250), W * 0.875));
      const n = senses.length;
      const rowGap = compact ? 31 : roomy ? 37 : 34;
      const rows = senses.map((sense, i) => ({ ...sense, y: yC + (i - (n - 1) / 2) * rowGap }));
      return { mode: 'wide', compact, W, H, yC, r, x0, xM, xB, xR, xS, rows, memTop: yC - (compact ? 100 : roomy ? 126 : 112), memBot: yC + (compact ? 100 : roomy ? 126 : 112) };
    },

    tallGeometry(W, senses) {
      const rows = senses.map((sense, i) => ({ ...sense, y: 70 + i * 29 }));
      const lastY = rows.length ? rows[rows.length - 1].y : 70;
      const xM = W - 46;
      const yB = lastY + 56;
      const r = Math.min(86, W * 0.24);
      const yR = yB + 236;
      return { mode: 'tall', W, H: yR + r + 196, x0: Math.min(176, W * 0.5), xM, yB, xR: W / 2, yC: yR, r, rows, memTop: 60, memBot: lastY + 14 };
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
      parent.append(s('path', { d: 'M-3,-3.2 L1.6,0 L-3,3.2', class: 'p-edge', transform: `translate(${m.x.toFixed(1)},${m.y.toFixed(1)}) rotate(${ang.toFixed(1)})`, 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }));
    },
    node(parent, part, stage, x, y, label, opts = {}) {
      const metaText = (label?.meta || []).map((m) => (typeof m === 'string' ? m : m?.text || '')).filter(Boolean).join(', ');
      const grp = s('g', { class: `p-node ${stage}`, 'data-part': String(part), tabindex: '0', role: 'button', 'aria-label': `${label.name}: ${metaText}. Open details.` });
      if (opts.marker !== false) {
        grp.append(s('circle', { class: 'halo', cx: x, cy: y, r: opts.halo ?? 15 }), s('circle', { class: 'dot', cx: x, cy: y, r: opts.r ?? 5.5 }));
      }
      if (label) grp.append(this.labelBlock(label, true));
      parent.append(grp);
      this.nodes[part] = { el: grp, x, y, stage };
      grp.addEventListener('click', () => openNodeSheet(part));
      grp.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          openNodeSheet(part);
        }
      });
      return grp;
    },
    labelBlock({ x, y, anchor = 'start', no, name, meta = [], metaGap = 16 }, hit = false) {
      const gEl = s('g', { class: hit ? 'lbl hit-me' : 'lbl' });
      gEl.append(s('text', { x, y, 'text-anchor': anchor }, s('tspan', { class: 'label-no' }, no), s('tspan', { class: 'label-name', dx: '7' }, name)));
      meta.forEach((m, i) => {
        if (!m) return;
        const txt = typeof m === 'string' ? m : m.text;
        gEl.append(s('text', { x, y: y + metaGap * (i + 1), 'text-anchor': anchor, class: `label-meta${typeof m === 'object' && m.dim ? ' dim' : ''}` }, txt));
      });
      return gEl;
    },
    addHit(grp) {
      try {
        const b = grp.getBBox();
        const pad = 4;
        grp.insertBefore(s('rect', { class: 'hit', x: b.x - pad, y: b.y - pad, width: b.width + pad * 2, height: b.height + pad * 2, rx: 6 }), grp.firstChild);
      } catch {
        /* not rendered yet */
      }
    },

    metrics(snap) {
      const a = snap.anatomy;
      const now = Date.parse(snap.now) || Date.now();
      const sensesTotal = a.senses.reduce((n, x) => n + x.count24h, 0);
      const brokenSenses = (a.senseHealth ?? []).filter((h) => h.status === 'broken').length;
      const b = a.bouncer;
      const gc = a.gaps;
      const gapsBits = [gc.open && `${gc.open} open`, gc.proposed && `${gc.proposed} proposed`, gc.waiting && `${gc.waiting} waiting`, gc.closed && `${gc.closed} closed today`, gc.dropped && `${gc.dropped} dropped`].filter(Boolean);
      const next = a.sleep.next;
      return {
        now,
        senses: `${plural(sensesTotal, 'event')} in 24h${brokenSenses ? ` · ${brokenSenses} not working` : ''}`,
        memory: [`${fmtNum(a.memory.events)} events`, !a.memory.events ? 'empty so far' : a.memory.indexed >= a.memory.events ? 'all indexed for meaning' : `${fmtNum(a.memory.indexed)} indexed`],
        bouncer: [`${b.model === 'setfit' ? 'SetFit model' : 'prototype'} · ${fmtNum(b.examples)} examples`],
        woke: `woke him ${fmtNum(b.wake24h)}×`,
        slept: b.sleep24h === undefined ? 'let sleep: not logged yet' : `let sleep ${fmtNum(b.sleep24h)}×`,
        gaps: gapsBits.join(' · ') || 'only the root',
        desk: [`${plural(a.desk.wakes24h, 'wake')} in 24h`, `he acted in ${fmtNum(a.desk.acted24h)}`],
        decide: [`${plural(a.decide.moves24h, 'move')} in 24h`],
        trust: [snap.approvals.length ? `${snap.approvals.length} held for your yes` : 'nothing held for you'],
        repeat: [`longest ${a.repeat.longest24h} of ${a.repeat.cap}`],
        tools: [`${fmtNum(a.tools.total)} tools · ${plural(a.tools.skills, 'skill')}`],
        sleep: next?.at ? [`next ${fmtWhen(next.at, now)}`, { text: `${fmtIn(Date.parse(next.at) - Date.now())} · ${a.sleep.timers + a.sleep.threads} in motion`, dim: true }] : ['nothing scheduled'],
        self: `his own actions · ${fmtNum(a.memory.self24h)} in 24h`,
        nextWake: next?.at ? `wakes himself ${fmtWhen(next.at, now)}` : 'no wake-up scheduled',
      };
    },

    drawSenses(root, g, snap, wide) {
      const now = Date.parse(snap.now) || Date.now();
      const grp = s('g', { class: 'p-node sense senses-node', 'data-part': '1', tabindex: '0', role: 'button', 'aria-label': 'Senses. Open details.' });
      const head = wide ? { x: 0, y: g.rows[0].y - 44 } : { x: 0, y: 20 };
      grp.append(this.labelBlock({ x: head.x, y: head.y, no: '01', name: 'Senses', meta: [this.metrics(snap).senses] }, true));
      for (const row of g.rows) {
        const idle = row.count24h === 0;
        const broken = row.health === 'broken';
        const ym = wide ? g.yC + (row.y - g.yC) * 0.36 : (g.memTop + g.memBot) / 2 + (row.y - (g.rows[0].y + g.rows[g.rows.length - 1].y) / 2) * 0.62;
        const xEnd = g.xM - 10;
        const d = `M${g.x0},${row.y} C${g.x0 + 44},${row.y} ${xEnd - 56},${ym.toFixed(1)} ${xEnd},${ym.toFixed(1)}`;
        const rg = s('g', { class: `sense-row${idle ? ' idle' : ''}${broken ? ' broken' : ''}`, 'data-sense': row.id });
        const fiber = s('path', { class: 'fiber', d });
        this.edges[`fiber:${row.id}`] = { el: fiber, d, row: rg };
        rg.append(
          s('rect', { class: 'hit', x: -4, y: row.y - 15, width: g.x0 + 8, height: 30, rx: 5 }),
          fiber,
          s('circle', { class: 'end', cx: g.x0, cy: row.y, r: 2.5 }),
          s('text', { x: 0, y: row.y - 2, class: 'sense-name' }, row.label),
          s('text', { x: 0, y: row.y + 12, class: 'sense-meta' }, broken ? 'not working' : idle ? 'quiet' : `${fmtNum(row.count24h)} · ${fmtWhen(row.lastAt, now)}`),
          ...(broken ? [s('title', null, row.problem ?? 'Not working')] : []),
        );
        grp.append(rg);
      }
      grp.addEventListener('click', () => openNodeSheet(1));
      grp.addEventListener('keydown', (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), openNodeSheet(1)));
      root.append(grp);
      this.nodes[1] = { el: grp, x: g.x0, y: g.yC, stage: 'sense' };
    },

    drawMemory(root, g, snap, labelPos) {
      const m = this.metrics(snap);
      const grp = this.node(root, 2, 'sense', g.xM, g.memBot, { ...labelPos, no: '02', name: 'Memory', meta: m.memory }, { marker: false });
      const h = g.memBot - g.memTop;
      grp.append(s('rect', { class: 'mem-col', x: g.xM - 10, y: g.memTop, width: 20, height: h, rx: 3 }));
      const ev = snap.recentEvents.slice(-Math.floor((h - 8) / 3.6));
      const ticks = s('g', { class: 'mem-ticks' });
      ev.forEach((e, i) => {
        const y = g.memBot - 5 - (ev.length - 1 - i) * 3.6;
        ticks.append(s('line', { class: `mem-tick${e.sense === 'self' ? ' self' : ''}`, x1: g.xM - 6, x2: g.xM + 6, y1: y.toFixed(1), y2: y.toFixed(1), opacity: (0.25 + 0.75 * ((i + 1) / ev.length)).toFixed(2), 'data-id': e.id }));
      });
      grp.append(ticks);
      this.memTicks = ticks;
    },

    drawWide(root, g, snap) {
      const m = this.metrics(snap);
      const st = this.stations(g);
      const { yC, r, xR, xB, xM, xS } = g;
      const P = st.pos;

      // --- 4 Gaps glyph (above the ring): the root, its children, and a line down into Decide.
      this.drawGapGlyph(root, g, snap, { cx: xR, top: 26, label: { x: 0, y: 0, anchor: 'end' } }, m);

      // --- edges first (under the nodes)
      const edges = s('g');
      root.append(edges);
      this.edge(edges, 'mem-bouncer', `M${xM + 10},${yC} L${xB - 2},${yC}`);
      this.edge(edges, 'bouncer-desk', `M${xB},${yC} L${P.desk[0] - 6},${yC}`);
      this.edge(edges, 'bouncer-tray', `M${xB},${yC + 28} L${xB},${yC + 70}`);
      for (const [id, d] of Object.entries(st.arcs)) this.edge(edges, id, d);
      this.edge(edges, 'trust-sleep', `M${P.trust[0] + 6},${yC} L${xS - 7},${yC}`);
      const yRet = g.H - 22;
      const last = g.rows[g.rows.length - 1];
      this.edge(edges, 'return', `M${xS},${yC + 8} L${xS},${yRet - 10} Q${xS},${yRet} ${xS - 10},${yRet} L${g.x0 + 10},${yRet} Q${g.x0},${yRet} ${g.x0},${yRet - 10} L${g.x0},${last.y + 5}`, 'faint');
      const selfD = `M${P.tools[0] - 7},${P.tools[1] + 2} C${P.tools[0] - 120},${P.tools[1] + 30} ${xM + 150},${g.memBot + 64} ${xM},${g.memBot + 2}`;
      this.edge(edges, 'self', selfD, 'faint');
      for (const id of ['desk-decide', 'decide-trust', 'trust-tools', 'tools-desk']) this.chevron(edges, st.arcs[id]);
      this.chevron(edges, this.edges['trust-sleep'].d, 0.5);
      this.chevron(edges, this.edges['return'].d, 0.55);

      // ring + instrument ticks
      const ring = s('g');
      ring.append(s('circle', { class: 'p-ring', cx: xR, cy: yC, r }));
      const ticks = s('g', { class: 'p-ring-ticks' });
      for (let a = 0; a < 360; a += 6) {
        const major = a % 90 === 0;
        const [x1, y1] = st.at(a, r + 7);
        const [x2, y2] = st.at(a, r + (major ? 14 : 10));
        ticks.append(s('line', { x1: x1.toFixed(1), y1: y1.toFixed(1), x2: x2.toFixed(1), y2: y2.toFixed(1), 'stroke-width': major ? 1 : 0.75 }));
      }
      ring.append(ticks);
      edges.prepend(ring);

      // edge labels
      root.append(
        s('text', { class: 'edge-label', x: (xB + P.desk[0]) / 2, y: g.compact ? yC - 8 : yC + 17, 'text-anchor': 'middle' }, m.woke),
        s('text', { class: 'edge-label', x: xB, y: yC + 92, 'text-anchor': 'middle' }, m.slept),
        s('text', { class: 'edge-label', x: (xS + g.x0) / 2 + 40, y: yRet - 7, 'text-anchor': 'middle' }, m.nextWake),
        s('text', { class: 'edge-label', x: xM + 62, y: g.memBot + 46, 'text-anchor': 'start' }, m.self),
      );

      // --- 1 Senses, 2 Memory, 3 Bouncer
      this.drawSenses(root, g, snap, true);
      this.drawMemory(root, g, snap, { x: xM, y: g.memTop - 48, anchor: 'middle' });
      const bouncer = this.node(root, 3, 'sense', xB, yC, { x: xB, y: yC - (g.compact ? 88 : 66), anchor: 'middle', no: '03', name: 'Bouncer', meta: m.bouncer }, { marker: false });
      bouncer.append(
        s('path', { class: 'gate-bar', d: `M${xB - 5},${yC - 28} H${xB + 5} M${xB},${yC - 28} V${yC - 7} M${xB - 5},${yC - 7} H${xB + 5}` }),
        s('path', { class: 'gate-bar', d: `M${xB - 5},${yC + 7} H${xB + 5} M${xB},${yC + 7} V${yC + 28} M${xB - 5},${yC + 28} H${xB + 5}` }),
        s('line', { class: 'tray', x1: xB - 12, x2: xB + 12, y1: yC + 74, y2: yC + 74 }),
        s('circle', { class: 'halo', cx: xB, cy: yC, r: 16 }),
      );

      // --- the wake loop
      const cx = (x) => x.toFixed(1);
      this.node(root, 5, 'wake', P.desk[0], P.desk[1], g.compact ? { x: cx(P.desk[0] - 12), y: yC + 36, anchor: 'end', no: '05', name: 'Desk', meta: [m.desk.join(', ').replace(' in 24h', '')] } : { x: cx(P.desk[0] - 14), y: yC - 40, anchor: 'end', no: '05', name: 'Desk', meta: m.desk });
      this.node(root, 6, 'wake', P.decide[0], P.decide[1], { x: cx(P.decide[0] + 16), y: P.decide[1] - 20, anchor: 'start', no: '06', name: 'Decide', meta: m.decide });
      this.node(root, 7, 'wake', P.trust[0], P.trust[1], { x: cx(P.trust[0] + 16), y: g.compact ? yC + 26 : yC - 40, anchor: 'start', no: '07', name: 'Trust gate', meta: m.trust });
      this.node(root, 9, 'wake', P.tools[0], P.tools[1], { x: cx(P.tools[0] + 18), y: P.tools[1] + 28, anchor: 'start', no: '09', name: 'Tools', meta: m.tools });
      this.node(root, 8, 'wake', P.repeat[0], P.repeat[1], { x: cx(P.repeat[0] - 14), y: P.repeat[1] + (g.compact ? 44 : 22), anchor: 'end', no: '08', name: 'Repeat', meta: m.repeat }, { r: 3.5, halo: 11 });
      this.drawLadder(root, P.trust[0] + 12, g.compact ? yC + 74 : yC + 34, snap, true);
      this.node(root, 10, 'sleep', xS, yC, { x: xS, y: yC - 66, anchor: 'middle', no: '10', name: 'Sleep', meta: m.sleep }, { r: 7, halo: 18 });
      this.drawCenter(root, xR, yC, snap);
    },

    drawTall(root, g, snap) {
      const m = this.metrics(snap);
      const st = this.stations(g);
      const { yC, r, xR, xM, W } = g;
      const P = st.pos;
      const yB = g.yB;

      const edges = s('g');
      root.append(edges);
      this.edge(edges, 'mem-bouncer', `M${xM},${g.memBot} L${xM},${yB - 2}`);
      this.edge(edges, 'bouncer-desk', `M${xM},${yB} C${xM},${yB + 170} ${P.desk[0] + 30},${P.desk[1] - 110} ${P.desk[0]},${P.desk[1] - 6}`);
      this.edge(edges, 'bouncer-tray', `M${xM + 22},${yB} L${W - 4},${yB}`);
      for (const [id, d] of Object.entries(st.arcs)) this.edge(edges, id, d);
      const yS = P.trust[1] + 118;
      this.edge(edges, 'trust-sleep', `M${xR},${P.trust[1] + 6} L${xR},${yS - 8}`);
      for (const id of ['desk-decide', 'decide-trust', 'trust-tools', 'tools-desk']) this.chevron(edges, st.arcs[id]);
      const ring = s('circle', { class: 'p-ring', cx: xR, cy: yC, r });
      edges.prepend(ring);

      this.drawSenses(root, g, snap, false);
      this.drawMemory(root, g, snap, { x: W, y: 20, anchor: 'end' });
      const bouncer = this.node(root, 3, 'sense', xM, yB, { x: xM - 34, y: yB - 4, anchor: 'end', no: '03', name: 'Bouncer', meta: [m.bouncer[0], `${m.woke} · ${m.slept.replace('let sleep: not logged yet', 'sleeps not logged').replace('let sleep ', 'slept ')}`] }, { marker: false });
      bouncer.append(
        s('line', { class: 'gate-bar', x1: xM - 22, x2: xM - 7, y1: yB, y2: yB }),
        s('line', { class: 'gate-bar', x1: xM + 7, x2: xM + 22, y1: yB, y2: yB }),
        s('line', { class: 'tray', x1: W - 2, x2: W - 2, y1: yB - 8, y2: yB + 8 }),
        s('circle', { class: 'halo', cx: xM, cy: yB, r: 16 }),
      );
      this.drawGapGlyph(root, g, snap, { cx: 52, top: yB + 104, tall: true, label: { x: 0, y: yB + 72, anchor: 'start' } }, { ...m, gaps: m.gaps.replace(' today', '') });

      this.node(root, 5, 'wake', P.desk[0], P.desk[1], { x: P.desk[0] - 14, y: P.desk[1] - 10, anchor: 'end', no: '05', name: 'Desk', meta: [] });
      this.node(root, 6, 'wake', P.decide[0], P.decide[1], { x: P.decide[0] - 12, y: P.decide[1] + 30, anchor: 'end', no: '06', name: 'Decide', meta: [m.decide[0].replace(' in 24h', '')] });
      this.node(root, 9, 'wake', P.tools[0], P.tools[1], { x: W, y: P.tools[1] + 30, anchor: 'end', no: '09', name: 'Tools', meta: [`${fmtNum(snap.anatomy.tools.total)} tools`] });
      this.node(root, 8, 'wake', P.repeat[0], P.repeat[1], { x: P.repeat[0] + 12, y: P.repeat[1] - 6, anchor: 'start', no: '08', name: 'Repeat', meta: [] }, { r: 3.5, halo: 11 });
      this.node(root, 7, 'wake', P.trust[0], P.trust[1], { x: P.trust[0] + 14, y: P.trust[1] + 24, anchor: 'start', no: '07', name: 'Trust gate', meta: m.trust });
      this.drawLadder(root, 0, P.trust[1] + 30, snap, true);
      const nx = snap.anatomy.sleep.next;
      const sleepMeta = nx?.at ? [`next ${fmtWhen(nx.at, m.now)}`, { text: fmtIn(Date.parse(nx.at) - Date.now()), dim: true }, { text: `${snap.anatomy.sleep.timers + snap.anatomy.sleep.threads} in motion`, dim: true }] : m.sleep;
      this.node(root, 10, 'sleep', xR, yS, { x: xR + 24, y: yS + 5, anchor: 'start', no: '10', name: 'Sleep', meta: sleepMeta }, { r: 7, halo: 18 });
      this.drawCenter(root, xR, yC, snap);
    },

    drawGapGlyph(root, g, snap, opts, m) {
      const gaps = snap.gaps;
      const rootGap = gaps.find((x) => x.id === 'gap_root');
      const kids = gaps.filter((x) => x.id !== 'gap_root');
      const max = opts.tall ? 6 : 11;
      const shown = kids.slice(0, max);
      const spacing = opts.tall ? 15 : 22;
      const glyph = s('g', { class: 'gapglyph' });
      const cx = opts.cx;
      const yRoot = opts.top + 8;
      const yBus = yRoot + 20;
      const yKid = yBus + 16;
      let xs;
      if (opts.tall) xs = shown.map((_, i) => 8 + i * spacing);
      else {
        // even spread around the center, never with a child sitting on the centre line (the line into Decide runs there)
        const n = shown.length;
        const offset = n % 2 === 1 ? spacing / 2 : 0;
        xs = shown.map((_, i) => cx + (i - (n - 1) / 2) * spacing + offset);
      }
      const rootX = opts.tall ? 8 : cx;
      glyph.append(s('rect', { class: 'g-root', x: rootX - 4.5, y: yRoot - 4.5, width: 9, height: 9, rx: 1.5, transform: `rotate(45 ${rootX} ${yRoot})` }));
      if (shown.length) {
        const minX = Math.min(rootX, ...xs);
        const maxX = Math.max(rootX, ...xs);
        glyph.append(s('path', { class: 'g-link', d: `M${rootX},${yRoot + 6} L${rootX},${yBus} M${minX},${yBus} L${maxX},${yBus}` }));
        shown.forEach((gp, i) => {
          const x = xs[i];
          const done = gp.status === 'closed' || gp.status === 'dropped';
          glyph.append(s('path', { class: 'g-link', d: `M${x},${yBus} L${x},${yKid - 5}` }));
          const dot = s('circle', { class: `g-dot ${done ? 'done' : gp.status}`, cx: x, cy: yKid, r: 4.2, 'data-gap': gp.id });
          glyph.append(dot, s('title', null, `${gp.title} (${GAP_STATUS[gp.status] ?? gp.status})`));
        });
        if (kids.length > max) glyph.append(s('text', { class: 'edge-label', x: Math.max(...xs) + 12, y: yKid + 4 }, `+${kids.length - max}`));
      }
      // line from the tree into Decide (top of the ring in wide; left side in tall)
      const st = this.stations(g);
      const dec = st.pos.decide;
      const d = opts.tall ? `M${rootX},${yKid + 8} C${rootX},${dec[1] - 10} ${dec[0] - 50},${dec[1]} ${dec[0] - 7},${dec[1]}` : `M${cx},${yBus} L${cx},${dec[1] - 7}`;
      const link = s('path', { class: 'p-edge', d });
      this.edges['gaps-decide'] = { el: link, d };
      root.append(link);
      const lbl = opts.tall ? opts.label : { x: Math.min(...xs, cx) - 22, y: yRoot + 4, anchor: 'end' };
      const grp = this.node(root, 4, 'gap', cx, yRoot, { ...lbl, no: '04', name: 'Gaps', meta: [m.gaps] }, { marker: false });
      grp.append(glyph);
      this.gapDots = glyph;
      if (rootGap) glyph.setAttribute('aria-label', `${rootGap.title}, with ${kids.length} gaps below it`);
    },

    drawLadder(root, x, y, snap, compact) {
      const ladder = snap.anatomy.trust;
      const max = Math.max(1, ...LADDER.map((k) => ladder[k] || 0));
      const grp = s('g', { class: 'ladder' });
      const nameW = compact ? 86 : 92;
      const railW = compact ? 34 : 46;
      LADDER.forEach((k, i) => {
        const yy = y + i * (compact ? 13 : 15);
        const v = ladder[k] || 0;
        const rung = s('g', { class: 'rung', 'data-level': k });
        rung.append(
          s('text', { class: 'r-name', x, y: yy + 4 }, LEVEL_WORDS[k].toLowerCase()),
          s('line', { class: 'r-rail', x1: x + nameW, x2: x + nameW + railW, y1: yy, y2: yy }),
          ...(v ? [s('line', { class: 'r-bar', x1: x + nameW, x2: x + nameW + Math.max(2, (railW * v) / max), y1: yy, y2: yy })] : []),
          s('text', { x: x + nameW + railW + 8, y: yy + 4 }, fmtNum(v)),
        );
        grp.append(rung);
      });
      root.append(grp);
      this.ladder = grp;
    },

    drawCenter(root, x, y, snap) {
      const c = s('g', { class: 'ring-center', 'text-anchor': 'middle', 'pointer-events': 'none' });
      const top = s('text', { class: 'c-top', x, y: y - 22 });
      const mid = s('text', { class: 'c-mid', x, y: y + 14 });
      const bot = s('text', { class: 'c-bot', x, y: y + 36 });
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
      const r = this.g?.r ?? 100;
      const maxChars = Math.floor((r * 1.6) / 7);
      mid.classList.remove('awake');
      if (pb && pb.view) {
        top.textContent = pb.view.kind === 'end' ? 'playback · ended' : pb.view.kind === 'trigger' ? 'playback · woken' : pb.wake.live ? 'live · turn' : 'playback · turn';
        mid.textContent = pb.view.live ? String(pb.view.turnNo) : pb.view.turnNo ? `${pb.view.turnNo}/${pb.wake.trace.length}` : pb.view.kind === 'end' ? `${pb.wake.trace.length}/${pb.wake.trace.length}` : '0';
        mid.classList.add('awake');
        bot.textContent = short(pb.view.label || '', maxChars);
        return;
      }
      if (snap.live.status === 'awake') {
        const t = lastTurn(snap.live);
        top.textContent = 'awake · turn';
        mid.textContent = String((snap.live.turns?.length ?? 0) + 1);
        mid.classList.add('awake');
        bot.textContent = t ? short(`after: ${toolWords(t.toolId)}`, maxChars) : 'deciding';
        return;
      }
      const next = snap.anatomy.sleep.next;
      top.textContent = 'asleep';
      if (next?.at) {
        const ms = Date.parse(next.at) - Date.now();
        mid.textContent = ms <= 30e3 ? 'now' : fmtIn(ms).replace(/^in /, '');
        bot.textContent = `until ${fmtWhen(next.at)}`;
      } else {
        mid.textContent = '–';
        bot.textContent = 'no wake-up set';
      }
    },

    // ---- highlight state (what is active right now)
    setActive(nodes, tones = {}, edges = [], edgeTone = {}) {
      this.on.nodes = new Set(nodes.map(String));
      this.on.tones = tones;
      this.on.edges = new Set(edges);
      this.on.edgeTone = edgeTone;
      this.applyHighlight();
    },
    applyHighlight() {
      const on = this.on;
      for (const [part, n] of Object.entries(this.nodes)) {
        n.el.classList.toggle('on', on.nodes.has(String(part)));
        n.el.classList.remove('tone-fail', 'tone-wait');
        const tone = on.tones[part];
        if (tone === 'fail' || tone === 'wait') n.el.classList.add(`tone-${tone}`);
        n.el.classList.toggle('selected', state.sheet?.kind === 'node' && String(state.sheet.part) === String(part));
      }
      for (const [id, e] of Object.entries(this.edges)) {
        const lit = on.edges.has(id);
        e.el.classList.toggle('lit', lit);
        for (const c of ['sense', 'gap', 'wake', 'sleep', 'fail', 'wait']) e.el.classList.remove(c);
        if (lit) e.el.classList.add(on.edgeTone[id] || stageOfEdge(id));
        if (e.row) e.row.classList.toggle('lit', lit);
      }
      if (this.gapDots) for (const d of this.gapDots.querySelectorAll('.g-dot')) d.classList.toggle('served', d.dataset.gap === on.gap);
      if (this.ladder) for (const r of this.ladder.querySelectorAll('.rung')) r.classList.toggle('active', r.dataset.level === on.level);
      this.setCenter();
    },

    // ---- motion: a comet along a path. Resolves when it arrives. Skipped under reduced motion.
    travel(id, { dur = 600, tone, from = 0, to = 1 } = {}) {
      const e = this.edges[id];
      if (!e || reduceMotion.matches || document.hidden) return Promise.resolve();
      const cls = tone || stageOfEdge(id);
      const p = s('path', { d: e.d, fill: 'none', stroke: 'none' });
      const tail = s('path', { d: e.d, class: `travel-tail ${cls}` });
      const dot = s('circle', { r: 3.2, class: `travel-dot ${cls}` });
      this.fx.append(p, tail, dot);
      const len = p.getTotalLength();
      const tailLen = Math.min(46, len * 0.45);
      tail.setAttribute('stroke-dasharray', `${tailLen} ${len + tailLen}`);
      const t0 = performance.now();
      return new Promise((resolve) => {
        const step = (now) => {
          const k = clamp((now - t0) / dur, 0, 1);
          const eased = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
          const pos = len * (from + (to - from) * eased);
          const pt = p.getPointAtLength(pos);
          dot.setAttribute('cx', pt.x.toFixed(2));
          dot.setAttribute('cy', pt.y.toFixed(2));
          tail.setAttribute('stroke-dashoffset', String(tailLen - pos));
          tail.setAttribute('opacity', String(k < 0.85 ? 0.9 : 0.9 * (1 - (k - 0.85) / 0.15)));
          if (k < 1) requestAnimationFrame(step);
          else {
            p.remove();
            tail.remove();
            dot.animate?.([{ opacity: 1, r: 3.2 }, { opacity: 0, r: 7 }], { duration: 380, easing: 'ease-out' });
            setTimeout(() => dot.remove(), 380);
            resolve();
          }
        };
        requestAnimationFrame(step);
      });
    },

    flash(part, tone) {
      const n = this.nodes[part];
      if (!n || reduceMotion.matches) return;
      const halo = n.el.querySelector('.halo');
      if (!halo) return;
      halo.animate?.([{ opacity: 0.55 }, { opacity: 0 }], { duration: 900, easing: 'ease-out' });
      if (tone) n.el.classList.add(`tone-${tone}`), setTimeout(() => this.applyHighlight(), 900);
    },
  };

  function stageOfEdge(id) {
    if (id.startsWith('fiber:') || id === 'mem-bouncer' || id === 'bouncer-tray') return 'sense';
    if (id === 'gaps-decide') return 'gap';
    if (id === 'trust-sleep' || id === 'return') return 'sleep';
    if (id === 'bouncer-desk') return 'sense';
    return 'wake';
  }

  /** The resting state of the plate: what is true right now (asleep, or awake on a turn). */
  function restingHighlight() {
    if (state.player) return;
    const snap = state.snap;
    if (snap.live.status === 'awake') {
      const t = lastTurn(snap.live);
      Plate.on.gap = servingGap();
      Plate.on.level = undefined;
      // Between turns, Decide is reading the rebuilt Desk.
      Plate.setActive([5, 6], {}, ['desk-decide', ...(Plate.on.gap ? ['gaps-decide'] : [])], {});
      if (t) Plate.on.level = snap.trustLevels?.[t.toolId];
    } else {
      Plate.on.gap = undefined;
      Plate.on.level = undefined;
      Plate.setActive([10], {}, ['return'], { return: 'sleep' });
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
    if (e.sense === 'self') {
      await Plate.travel('self', { dur: 1100, tone: 'wake', from: 0, to: 1 });
      return;
    }
    const fiber = `fiber:${Plate.edges[`fiber:${e.sense}`] ? e.sense : 'other'}`;
    const row = Plate.edges[fiber]?.row;
    row?.classList.add('lit');
    await Plate.travel(fiber, { dur: 700, tone: 'sense' });
    if (!state.player) row?.classList.toggle('lit', Plate.on.edges.has(fiber));
    await Plate.travel('mem-bouncer', { dur: 420, tone: 'sense' });
    if (outcome === 'WAKE') {
      await Plate.travel('bouncer-desk', { dur: 560, tone: 'wake' });
      Plate.flash(5);
    } else if (outcome === 'SLEEP') {
      await Plate.travel('bouncer-tray', { dur: 380, tone: 'dim' });
    } else {
      Plate.flash(3);
    }
  }

  // ------------------------------------------------------------------ live follow
  async function syncLive(prev, snap) {
    const wasAwake = prev?.live.status === 'awake' ? prev.live.wakeId : undefined;
    const awakeId = snap.live.status === 'awake' ? snap.live.wakeId : undefined;
    const pb = state.player;
    if (awakeId) {
      if (pb && pb.wake.wakeId === awakeId) {
        const w = await getJSON(`/api/wake/${encodeURIComponent(awakeId)}`).catch(() => undefined);
        if (w) pb.update(w);
      } else if (!pb && state.liveDismissed !== awakeId && (!state.sheet || state.sheet.kind !== 'node')) {
        openWake(awakeId, { live: true, autoplay: true });
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

  // ------------------------------------------------------------------ the sheet
  const sheetEl = () => $('#sheet');
  function showSheet() {
    const sh = sheetEl();
    sh.hidden = false;
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
    restingHighlight();
  }
  function sheetHead(kicker, title, sub) {
    return el(
      'div',
      { class: 'sheet-head' },
      el('div', { class: 'sheet-kicker' }, kicker),
      el('button', { class: 'sheet-close', type: 'button', 'aria-label': 'Close', onclick: closeSheet }, '×'),
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
    body.append(el('h4', null, 'From the outline'), o.text ? el('p', { class: 'outline-quote' }, o.text) : el('p', { class: 'empty' }, 'docs/OUTLINE.md wasn’t found.'));
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
                    : `working · ${fmtNum(h.events24h)} in 24h${h.lastPollAt ? ` · checked ${fmtWhen(h.lastPollAt, now)}` : ''}`,
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
        body.append(el('h4', null, 'Last 24 hours'), kv([['Woke him', fmtNum(b.wake24h)], ['Let him sleep', b.sleep24h === undefined ? 'not logged yet' : fmtNum(b.sleep24h)], ['Model', b.model === 'setfit' ? 'SetFit (trained locally)' : 'prototype (untrained)'], ['Training examples', fmtNum(b.examples)], b.lastMs !== undefined && ['Last call', fmtDur(b.lastMs)], ...Object.entries(b.backends).map(([k, v]) => [`Decided by ${k === 'rule' ? 'a rule' : k}`, fmtNum(v)])]));
        if (!b.logged) body.append(el('p', { class: 'empty' }, 'Every bouncer call is logged from the next daemon restart. Until then only the events that woke him are known (from his wakes).'));
        body.append(el('h4', null, b.logged ? 'Latest calls' : 'Latest events that woke him'));
        if (b.logged) body.append(actList(snap.recentDecisions.slice(-10).reverse().map((d) => ({ t: fmtWhen(d.at, now), x: [el('b', null, d.label === 'WAKE' ? 'Woke him' : 'Let sleep'), ` · ${d.backend}${d.reason ? ` — ${short(d.reason, 80)}` : ''}`] }))));
        else body.append(actList(snap.wakes.slice(0, 8).map(wakeItem)));
        break;
      }
      case 4:
        body.append(el('h4', null, 'On the tree'), kv(Object.entries(a.gaps).filter(([, v]) => v).map(([k, v]) => [GAP_STATUS[k] ?? k, fmtNum(v)])));
        body.append(el('h4', null, 'Gaps'), actList(snap.gaps.map((gp) => ({ t: GAP_STATUS[gp.status] ?? gp.status, x: [el('b', null, gp.title)], onclick: () => document.querySelector(`[data-gap-row="${gp.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }) }))));
        break;
      case 5:
        body.append(el('h4', null, 'Last 24 hours'), kv([['Wakes', fmtNum(a.desk.wakes24h)], ['Where he acted', fmtNum(a.desk.acted24h)], a.desk.metered24h > 0 && ['Model spend', `${fmtCost(a.desk.cost24h)} over ${plural(a.desk.metered24h, 'wake')}`], a.desk.modelCalls24h > 0 && ['Model calls', fmtNum(a.desk.modelCalls24h)]]));
        body.append(el('h4', null, 'Latest wakes'), actList(snap.wakes.slice(0, 10).map(wakeItem)));
        break;
      case 6:
        body.append(el('h4', null, 'Last 24 hours'), kv([['Moves', fmtNum(a.decide.moves24h)]]));
        body.append(el('h4', null, 'Latest thoughts'), actList((snap.recentMoves ?? []).slice(0, 10).map((mv) => ({ t: fmtWhen(mv.at, now), x: [el('span', { class: 'serif' }, `“${short(clean(mv.thought), 150)}”`), ` → ${toolWords(mv.toolId)}`], onclick: () => openWake(mv.wakeId) }))));
        break;
      case 7: {
        body.append(el('h4', null, 'The ladder (lowest to highest)'), kv(LADDER.map((k) => [LEVEL_WORDS[k], `${fmtNum(a.trust[k] || 0)} tools`])));
        const byLevel = (lvl) => snap.tools.filter((t) => t.level === lvl).map((t) => t.id);
        for (const k of ['never', 'rehearse', 'draft', 'act_and_report']) {
          const ids = byLevel(k);
          if (ids.length) body.append(el('h4', null, LEVEL_WORDS[k]), el('p', { class: 'empty' }, capFirst(ids.map(toolWords).join(', '))));
        }
        body.append(el('h4', null, 'Held for your yes'), snap.approvals.length ? actList(snap.approvals.map((ap) => ({ t: fmtWhen(ap.createdAt, now), x: [el('b', { title: ap.toolId }, capFirst(toolWords(ap.toolId))), ` ${short(prettyInput(ap.input).replace(/\n/g, ' · '), 100)}`] }))) : el('p', { class: 'empty' }, 'Nothing.'));
        break;
      }
      case 8:
        const e24 = a.sleep.ended24h;
        body.append(el('h4', null, 'Last 24 hours'), kv([['Turn cap', String(a.repeat.cap)], ['Longest wake', plural(a.repeat.longest24h, 'move')], ['Ended by sleep', fmtNum(e24.sleep)], ['Hit the turn cap', fmtNum(e24.cap)], e24.crashed > 0 && ['Crashed', fmtNum(e24.crashed)], e24.unreadable > 0 && ['Unreadable replies', fmtNum(e24.unreadable)], ['Ended another way', fmtNum(e24.safety)]]));
        body.append(el('h4', null, 'Longest recent wakes'), actList([...snap.wakes].sort((x, y) => y.turns - x.turns).slice(0, 6).map(wakeItem)));
        break;
      case 9: {
        const t = a.tools;
        body.append(el('h4', null, 'Tools'), kv([['Built in', fmtNum(t.builtin)], ['Built by him', fmtNum(t.custom)], ['Brain skills', t.skillNames.join(', ').toLowerCase() || '–'], t.broken.length && ['Failing', t.broken.map(toolWords).join(', ')]]));
        const used = new Map();
        for (const w of snap.wakes) for (const mv of w.moves) if (mv.toolId !== 'sleep') used.set(mv.toolId, (used.get(mv.toolId) ?? 0) + 1);
        body.append(el('h4', null, 'Most used lately'), kv([...used.entries()].sort((x, y) => y[1] - x[1]).slice(0, 10).map(([k, v]) => [capFirst(toolWords(k)), `${v}×`])));
        break;
      }
      case 10: {
        const sl = a.sleep;
        body.append(el('h4', null, 'In motion'), kv([['Timers', fmtNum(sl.timers)], ['Threads running', fmtNum(sl.threads)]]));
        const all = [...snap.gaps.flatMap((gp) => gp.next.map((n) => ({ ...n, gap: gp.title }))), ...snap.looseWatches];
        all.sort((x, y) => (x.fireAt ? Date.parse(x.fireAt) : Infinity) - (y.fireAt ? Date.parse(y.fireAt) : Infinity));
        body.append(el('h4', null, 'Next moves'), actList(all.slice(0, 12).map((n) => ({ t: n.fireAt ? fmtWhen(n.fireAt, now) : 'thread', x: [n.gap ? el('b', null, short(n.gap, 50)) : el('b', null, 'Not tied to a gap'), ` — ${short(clean(n.label), 120)}`] }))));
        break;
      }
      default:
        break;
    }
    const sh = sheetEl();
    const keepScroll = !fresh ? sh.querySelector('.sheet-body')?.scrollTop : 0;
    sh.replaceChildren(sheetHead(`Part ${o.n} of 10`, o.name), body);
    if (keepScroll) body.scrollTop = keepScroll;
    showSheet();
    if (fresh) maybeScrollToPlate();
  }

  function maybeScrollToPlate() {
    const plate = $('#plate');
    if (Plate.g?.mode === 'tall' || window.innerWidth < 1280) {
      // The sheet is a bottom drawer here: bring the ring into the space above it.
      const svgTop = Plate.svg.getBoundingClientRect().top + window.scrollY;
      const sheetH = sheetEl().offsetHeight || window.innerHeight * 0.5;
      const free = window.innerHeight - sheetH;
      const target = svgTop + (Plate.g?.yC ?? 300) - free / 2;
      window.scrollTo({ top: Math.max(0, target), behavior: reduceMotion.matches ? 'auto' : 'smooth' });
      return;
    }
    const r = plate.getBoundingClientRect();
    if (r.top < -40 || r.top > window.innerHeight * 0.5) plate.scrollIntoView({ behavior: reduceMotion.matches ? 'auto' : 'smooth', block: 'start' });
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
    state.player = new Player(wake, opts);
    showSheet();
    maybeScrollToPlate();
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
      document.removeEventListener('keydown', this.onKey);
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
      const kicker = w.live ? [el('span', { class: 'live-dot' }), 'Live now'] : 'Wake playback';
      const head = sheetHead(kicker, triggerWords(w.trigger), sub);
      this.body = el('div', { class: 'sheet-body' });
      const tr = w.trigger || {};
      const dec = w.decision || {};
      this.triggerEl = el(
        'div',
        { class: 'pb-trigger' },
        el('div', { class: 'who' }, `New reality · ${SENSE_LABEL[tr.sense] ?? tr.source ?? ''}`),
        el('p', { class: 'what' }, short(clean(tr.text), 420)),
        el('div', { class: 'verdict' }, `Bouncer: ${dec.label === 'SLEEP' ? 'let sleep' : 'woke him'}${dec.backend ? ` · ${dec.backend === 'rule' ? 'by rule' : dec.backend}` : ''}${dec.reason ? ` — ${dec.reason}` : ''}${Number.isFinite(dec.durationMs) ? ` · ${fmtDur(dec.durationMs)}` : ''}`),
      );
      this.turnsEl = el('ol', { class: 'turns' });
      this.endEl = el('div', { class: 'pb-end' });
      this.body.append(this.triggerEl, this.turnsEl, this.endEl);
      this.scrubEl = el('div', { class: 'scrub', role: 'slider', tabindex: '0', 'aria-label': 'Turn', onclick: (e) => this.onScrub(e) });
      const btn = (label, svgPath, fn, extra = {}) => el('button', { type: 'button', 'aria-label': label, title: label, onclick: fn, ...extra }, svgPath ? svgIcon(svgPath) : label);
      this.playBtn = btn('Play', 'M4 2.5v11l9-5.5z', () => this.toggle(), { class: 'primary' });
      this.posEl = el('span', { class: 'pos' });
      this.speedBtn = btn('1×', null, () => this.cycleSpeed(), { title: 'Speed' });
      const controls = el(
        'div',
        { class: 'controls' },
        btn('Back to the start', 'M3 3v10M13 3 6 8l7 5z', () => (this.pause(), this.goto(0, true))),
        btn('Previous turn', 'M12 3 5 8l7 5z', () => this.stepTurn(-1)),
        this.playBtn,
        btn('Next turn', 'M4 3l7 5-7 5z', () => this.stepTurn(1)),
        btn('Jump to the end', 'M13 3v10M3 3l7 5-7 5z', () => (this.pause(), this.goto(this.phases.length - 1, true))),
        this.speedBtn,
        this.posEl,
      );
      const transport = el('div', { class: 'transport' }, this.scrubEl, controls);
      sh.replaceChildren(head, this.body, transport);
      this.onKey = (e) => {
        if (e.target.closest?.('input, textarea')) return;
        if (e.key === 'Escape') closeSheet();
        else if (e.key === ' ' && !e.target.closest?.('button')) (e.preventDefault(), this.toggle());
        else if (e.key === 'ArrowRight') (e.preventDefault(), this.stepTurn(1));
        else if (e.key === 'ArrowLeft') (e.preventDefault(), this.stepTurn(-1));
      };
      document.addEventListener('keydown', this.onKey);
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
          el('div', { class: 'ph', 'data-ph': 'gap' }, el('span', { class: 'k' }, 'Gap'), el('span', { class: 'v' }, el('span', { class: 'gapname' }, gapTxt))),
          t.thought ? el('div', { class: 'ph', 'data-ph': 'thought' }, el('span', { class: 'k' }, 'Thinks'), el('span', { class: 'v thought' }, `“${clean(t.thought)}”`)) : null,
          el('div', { class: 'ph', 'data-ph': 'tool' }, el('span', { class: 'k' }, 'Tool'), el('span', { class: 'v code' }, el('b', { class: 'tool-id', title: t.toolId }, capFirst(toolWords(t.toolId))), prettyInput(t.input) ? `\n${prettyInput(t.input)}` : '')),
          el('div', { class: 'ph', 'data-ph': 'gate' }, el('span', { class: 'k' }, 'Gate'), el('span', { class: 'v' }, el('span', { class: `status ${gate.tone === 'ok' ? 'ok' : gate.tone === 'wait' ? 'pending_approval' : 'blocked'}` }, gate.text))),
          el('div', { class: 'ph', 'data-ph': 'receipt' }, el('span', { class: 'k' }, 'Receipt'), el('span', { class: 'v' }, el('span', { class: `status ${st}` }, `${STATUS_WORDS[st] ?? st}${Number.isFinite(t.receipt?.durationMs) && t.receipt.durationMs ? ` · ${fmtDur(t.receipt.durationMs)}` : ''}`), ' ', short(clean(t.receipt?.summary), 420))),
          t.receipt?.sentText ? el('div', { class: 'ph', 'data-ph': 'said' }, el('span', { class: 'k' }, 'Said'), el('div', { class: 'v' }, el('div', { class: 'bubble' }, clean(t.receipt.sentText)))) : null,
        ];
        return el(
          'li',
          { class: 'turn future', 'data-ti': String(i) },
          el('div', { class: 'turn-head', onclick: () => this.gotoTurn(i) }, el('span', { class: 'turn-no' }, `Turn ${i + 1}`), el('span', { class: 'turn-tool', title: t.toolId }, capFirst(toolWords(t.toolId))), el('span', { class: 'turn-status' }, el('span', { class: `status ${st}` }, STATUS_WORDS[st] ?? st))),
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
      const curTi = cur?.ti ?? (cur?.kind === 'end' ? this.wake.trace.length : -1);
      const target = clamp(curTi + dir, 0, this.wake.trace.length);
      if (target === this.wake.trace.length) return this.goto(this.phases.length - 1, true);
      if (target === curTi && cur?.kind === 'desk') return;
      this.pause();
      this.gotoTurn(target);
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
      this.playingTo = true;
      this.playing = play;
      this.updateControls();
      this.schedule();
    }
    cycleSpeed() {
      this.speed = this.speed === 1 ? 2 : this.speed === 2 ? 4 : 1;
      this.speedBtn.textContent = `${this.speed}×`;
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
      const sense = w.trigger?.sense && Plate.edges[`fiber:${w.trigger.sense}`] ? w.trigger.sense : 'other';
      Plate.on.gap = t?.gapId;
      Plate.on.level = ph.gate?.level;

      switch (ph.kind) {
        case 'trigger': {
          Plate.setActive([1, 2, 3, 5], {}, [`fiber:${sense}`, 'mem-bouncer', 'bouncer-desk'], { 'bouncer-desk': 'wake' });
          if (go) {
            (async () => {
              await Plate.travel(`fiber:${sense}`, { dur: dur * 0.38, tone: 'sense' });
              await Plate.travel('mem-bouncer', { dur: dur * 0.2, tone: 'sense' });
              await Plate.travel('bouncer-desk', { dur: dur * 0.28, tone: 'wake' });
            })();
          }
          break;
        }
        case 'desk':
          Plate.setActive([5, 4], {}, ['gaps-decide'], {});
          break;
        case 'decide':
          Plate.setActive([6, 4], {}, ['desk-decide', ...(t?.gapId ? ['gaps-decide'] : [])], {});
          if (go) Plate.travel('desk-decide', { dur: dur * 0.45 });
          break;
        case 'gate':
          Plate.setActive([7], { 7: ph.gate.tone === 'ok' ? undefined : ph.gate.tone }, ['decide-trust'], {});
          if (go) Plate.travel('decide-trust', { dur: dur * 0.6 });
          break;
        case 'tool':
          Plate.setActive([9, 7], { 7: ph.gate.tone === 'ok' ? undefined : ph.gate.tone }, ['trust-tools'], {});
          if (go) Plate.travel('trust-tools', { dur: dur * 0.6 });
          break;
        case 'sleeptool':
          Plate.setActive([10, 7], {}, ['trust-sleep'], {});
          if (go) Plate.travel('trust-sleep', { dur: dur * 0.6, tone: 'sleep' });
          break;
        case 'receipt': {
          const tone = ph.gate.tone === 'fail' ? 'fail' : toneOfStatus(statusOf(t));
          Plate.setActive([8, 5], { 8: tone === 'ok' ? undefined : tone }, ['tools-desk'], { 'tools-desk': tone === 'ok' ? 'wake' : tone });
          if (go) {
            if (ph.gate.rejected || ph.gate.level === 'never' || t.toolId === 'sleep') Plate.travel('trust-tools', { dur: dur * 0.3, tone }).then(() => Plate.travel('tools-desk', { dur: dur * 0.35, tone }));
            else Plate.travel('tools-desk', { dur: dur * 0.6, tone: tone === 'ok' ? 'wake' : tone });
            if (t.receipt?.realChange && t.toolId !== 'send_message') setTimeout(() => Plate.travel('self', { dur: 900, tone: 'wake' }), dur * 0.3);
          }
          break;
        }
        case 'deciding': {
          const lastGap = [...w.trace].reverse().find((x) => x.gapId)?.gapId;
          Plate.on.gap = lastGap;
          Plate.setActive([6, 5], {}, ['desk-decide', ...(lastGap ? ['gaps-decide'] : [])], {});
          if (go && w.trace.length) Plate.travel('desk-decide', { dur: 700 });
          break;
        }
        case 'end': {
          const e = w.ending;
          if (e === 'sleep') Plate.setActive([10], {}, ['trust-sleep', 'return'], { return: 'sleep' });
          else if (e === 'cap') Plate.setActive([8, 10], { 8: 'fail', 10: 'wait' }, ['return'], { return: 'wait' });
          else if (e === 'crashed' || e === 'unreadable') Plate.setActive([6, 10], { 6: 'fail', 10: 'wait' }, ['return'], { return: 'wait' });
          else Plate.setActive([10], { 10: 'wait' }, ['return'], { return: 'wait' });
          if (go) Plate.travel('return', { dur: dur * 0.8, tone: e === 'sleep' ? 'sleep' : 'wait' });
          break;
        }
        default:
          break;
      }

      // the sheet, in sync
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
      this.playBtn.setAttribute('aria-label', this.playing ? 'Pause' : 'Play');
      this.playBtn.title = this.playing ? 'Pause' : 'Play';
      const ph = this.phases[this.i];
      const n = this.wake.trace.length;
      this.posEl.textContent = !ph ? '' : this.view?.live ? `deciding turn ${n + 1}` : this.liveEnded ? 'ended · saving' : ph.kind === 'trigger' ? 'trigger' : ph.kind === 'end' ? 'ended' : `turn ${ph.ti + 1} of ${n}`;
    }
  }

  function endingWord(e) {
    return e === 'sleep' ? 'asleep' : e === 'cap' ? 'turn cap' : e === 'safety' ? 'safety net' : e === 'crashed' ? 'crashed' : e === 'unreadable' ? 'unreadable replies' : '';
  }
  function svgIcon(d) {
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
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
  /** "due in 26h" / "overdue by 3h": the owner's by-when, from his own words. */
  function dueChip(due, now) {
    const ms = Date.parse(due) - Date.now();
    const text = ms >= 0 ? `due ${fmtIn(ms)}` : `overdue by ${fmtAgo(-ms).replace(/ ago$/, '')}`;
    return el('span', { class: `pill due${ms < 0 ? ' overdue' : ''}`, title: `Wanted by ${fmtWhen(due, now)}` }, text.replace('due due now', 'due now').replace('overdue by just now', 'due now'));
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
    const matchesGap = (g) => {
      if (g.id === 'gap_root') return true;
      const done = g.status === 'closed' || g.status === 'dropped';
      if (gf === 'life' && (g.standing || done)) return false;
      if (gf === 'selfopt' && !g.standing) return false;
      if (gf === 'proposed' && g.status !== 'proposed') return false;
      if (gf === 'done' && !done) return false;
      if (gq && !`${g.title} ${g.target} ${g.reality} ${g.id}`.toLowerCase().includes(gq)) return false;
      return true;
    };

    const gapRow = (g) => {
      const done = g.status === 'closed' || g.status === 'dropped';
      const isRoot = g.id === 'gap_root';
      const isStanding = !!g.standing;
      const head = el(
        'div',
        { class: 'gap-head', title: g.id },
        el('span', { class: `gap-mark ${isRoot ? 'root' : g.status}`, 'aria-hidden': 'true' }),
        el('span', { class: 'gap-title' }, g.title),
        isRoot
          ? el('span', { class: 'pill quiet' }, 'never closes')
          : isStanding
            ? el('span', { class: 'pill standing' }, 'standing')
            : el('span', { class: `pill ${g.status}` }, GAP_STATUS[g.status] ?? g.status),
        !isRoot && !done && g.due && Number.isFinite(Date.parse(g.due)) ? dueChip(g.due, now) : null,
        !isRoot ? el('span', { class: 'pill quiet' }, isStanding ? 'never closes' : done ? `${g.status} ${fmtAgo(now - Date.parse(g.updatedAt))}` : g.source === 'owner' ? 'you asked' : 'he spotted it') : null,
      );
      const clampBox = (cls, text) => el('span', { class: `${cls} clamp` }, clean(text));
      const tvr = el('div', { class: 'tvr' });
      tvr.append(el('span', { class: 'k' }, 'Want'), clampBox('want', g.target), el('span', { class: 'k' }, 'Now'), clampBox('now', g.reality));
      if (g.waitingOn) tvr.append(el('span', { class: 'k' }, 'Waits on'), el('span', { class: 'now' }, clean(g.waitingOn)));
      if (!done && !isStanding) {
        const moves = isRoot ? [...g.next, ...snap.looseWatches.map((w) => ({ ...w, loose: true }))] : g.next;
        const list = el('ul', { class: 'next-moves' });
        if (!moves.length) list.append(el('li', { class: 'none' }, el('span', { class: 'when' }, 'none'), el('span', { class: 'what' }, 'No next move in motion. Code schedules a quick return at the end of a wake.')));
        for (const mv of moves.slice(0, 4)) {
          const nice = humanizeLabel(mv.label);
          const when = mv.kind === 't3_thread' ? [el('span', null, 'when thread ends')] : mv.fireAt ? [fmtWhen(mv.fireAt, now), ' ', el('span', { class: 'cd', 'data-in': mv.fireAt }, fmtIn(Date.parse(mv.fireAt) - Date.now()))] : ['–'];
          list.append(el('li', { title: nice }, el('span', { class: 'when' }, when), el('span', { class: 'what' }, short(nice, 180))));
        }
        if (moves.length > 4) list.append(el('li', null, el('span', { class: 'when' }, ''), el('span', { class: 'what' }, `and ${moves.length - 4} more`)));
        tvr.append(el('span', { class: 'k' }, 'Next'), list);
      }
      if (!isRoot && g.log?.length) {
        // Code's record of what was already tried for this gap, newest first.
        const tried = el('ul', { class: 'next-moves tried' });
        for (const e of [...g.log].reverse()) {
          const st = e.status === 'ok' ? 'ok' : e.status === 'pending_approval' ? 'pending_approval' : 'failed';
          tried.append(el('li', { title: clean(e.result) }, el('span', { class: 'when' }, fmtWhen(e.at, now)), el('span', { class: 'what' }, el('span', { class: `status ${st}` }, capFirst(toolWords(e.toolId))), ' ', short(clean(e.result), 160))));
        }
        tvr.append(el('span', { class: 'k' }, 'Tried'), tried);
      }
      const row = el('div', { class: `gap${done ? ' done' : ''}${isRoot ? ' root' : ''}${served === g.id ? ' served' : ''}`, 'data-gap-row': g.id }, head, tvr);
      // "more" toggles for clamped text, added after layout
      requestAnimationFrame(() => {
        for (const c of row.querySelectorAll('.clamp')) {
          if (c.scrollHeight > c.clientHeight + 2 && !c.nextElementSibling?.classList?.contains('more')) {
            const b = el('button', { class: 'more', type: 'button' }, 'more');
            b.addEventListener('click', () => {
              const open = c.classList.toggle('open');
              b.textContent = open ? 'less' : 'more';
            });
            c.append(' ', b);
          }
        }
      });
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
          const totalStand = gaps.filter((x) => x.standing).length;
          const open = !!state.showStanding;
          const btn = el('button', { class: 'selfopt-toggle', type: 'button', onclick: () => ((state.showStanding = !state.showStanding), renderGaps()) }, `${open ? '▾' : '▸'} ${plural(totalStand, 'standing self-optimization gap')}`);
          ul.append(el('li', null, btn, ...(open ? standKids.map((k) => build(k, depth + 1)) : [])));
        }
        li.append(ul);
      } else if (allKids.length && depth < 6) {
        li.append(el('ul', null, allKids.map((k) => build(k, depth + 1))));
      }
      return li;
    };
    const tree = el('ul', { class: 'gap-tree' }, root ? build(root, 0) : null);
    $('#gapTree').replaceChildren(tree);
    const c = snap.anatomy.gaps;
    $('#gapNote').textContent = `${[c.open && `${c.open} open`, c.proposed && `${c.proposed} proposed`, c.waiting && `${c.waiting} waiting`, (c.closed || c.dropped) && `${c.closed + c.dropped} done in the last day (faded)`].filter(Boolean).join(' · ') || 'Only the root gap so far.'}`;
  }

  // ------------------------------------------------------------------ needs you
  /** What only the owner can unblock: approvals, proposed gaps, broken senses. Waiting-on gaps are listed but not counted. */
  const brokenSenses = (snap) => (snap.anatomy.senseHealth ?? []).filter((h) => h.status === 'broken');
  const ownerNeeds = (snap) => snap.approvals.length + snap.gaps.filter((g) => g.status === 'proposed').length + brokenSenses(snap).length;
  function renderNeeds() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const box = $('#needs');
    const items = [];
    for (const a of snap.approvals) {
      items.push(el('div', { class: 'need' }, el('span', { class: 'kind' }, 'Held for your yes'), el('span', { class: 'what', title: a.toolId }, `${capFirst(toolWords(a.toolId))}${a.gapId && snap.gapTitles[a.gapId] ? ` for “${short(snap.gapTitles[a.gapId], 60)}”` : ''}`), el('span', { class: 'detail' }, short(prettyInput(a.input), 260)), el('span', { class: 'ago' }, `asked ${fmtAgo(now - Date.parse(a.createdAt))}`)));
    }
    const jumpGap = (gapId) => {
      const target = document.querySelector(`[data-gap-row="${gapId}"]`);
      if (!target) return;
      target.scrollIntoView({ behavior: 'smooth', block: 'center' });
      target.classList.remove('flash');
      void target.offsetWidth;
      target.classList.add('flash');
    };
    for (const g of snap.gaps.filter((x) => x.status === 'proposed')) {
      items.push(el('div', { class: 'need clickable', tabindex: '0', role: 'button', onclick: () => jumpGap(g.id), onkeydown: (e) => (e.key === 'Enter' || e.key === ' ') && (e.preventDefault(), jumpGap(g.id)) }, el('span', { class: 'kind' }, 'Gap waiting for your yes'), el('span', { class: 'what' }, g.title), el('span', { class: 'detail serif' }, short(clean(g.target), 220)), el('span', { class: 'ago' }, `he spotted it ${fmtAgo(now - Date.parse(g.createdAt))} · click to jump →`)));
    }
    for (const h of brokenSenses(snap)) {
      items.push(el('div', { class: 'need' }, el('span', { class: 'kind fail' }, 'A sense isn’t working'), el('span', { class: 'what' }, CONNECTOR_LABEL[h.id] ?? capFirst(h.id)), el('span', { class: 'detail' }, short(clean(h.problem ?? ''), 200)), h.lastSuccessAt ? el('span', { class: 'ago' }, `last worked ${fmtAgo(now - Date.parse(h.lastSuccessAt))}`) : null));
    }
    for (const g of snap.gaps.filter((x) => x.status === 'waiting' && x.waitingOn)) {
      items.push(el('div', { class: 'need' }, el('span', { class: 'kind' }, 'Waiting'), el('span', { class: 'what' }, g.title), el('span', { class: 'detail' }, `on ${clean(g.waitingOn)}`)));
    }
    box.replaceChildren(...(items.length ? items : [el('div', { class: 'calm' }, 'Nothing needs you right now.')]));
    const n = ownerNeeds(snap);
    $('#needsHead').textContent = n ? `Needs you · ${n}` : 'Needs you';
  }

  // ------------------------------------------------------------------ timeline
  function renderTimeline() {
    const tl = state.timeline;
    const box = $('#timeline');
    if (!tl) return;
    const W = Math.max(320, Math.round(box.clientWidth || 1000));
    const narrow = W < 640;
    const gutter = narrow ? 86 : 132;
    const plotW = W - gutter - 8;
    const from = Date.parse(tl.from);
    const to = Date.parse(tl.to);
    const x = (t) => gutter + ((t - from) / (to - from)) * plotW;
    const laneH = 20;
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

    let y = 6;
    const svg = s('svg', { width: W, role: 'img', 'aria-label': `Timeline of the last ${tl.hours} hours: ${tl.events.length} events, ${tl.wakes.length} wakes, ${tl.sent.length} messages sent` });
    const grid = s('g');
    const marks = s('g');
    const labels = s('g');
    svg.append(grid, marks, labels);
    const laneY = {};
    for (const lane of lanes) {
      if (lane.group) {
        y += 10;
        labels.append(s('text', { class: 'tl-lane-label group', x: 0, y: y + 8 }, lane.group));
        y += 14;
        continue;
      }
      laneY[lane.id] = y;
      const mid = y + laneH / 2;
      labels.append(s('text', { class: 'tl-lane-label', x: 0, y: mid + 4 }, lane.label));
      if (lane.items.length && !narrow) labels.append(s('text', { class: 'tl-lane-count', x: gutter - 12, y: mid + 4, 'text-anchor': 'end' }, fmtNum(lane.items.length)));
      grid.append(s('line', { class: 'tl-base', x1: gutter, x2: gutter + plotW, y1: mid, y2: mid, opacity: 0.5 }));
      if (lane.note) labels.append(s('text', { class: 'tl-note', x: gutter + 6, y: mid + 4 }, narrow ? 'Logged from the next restart.' : lane.note));
      if (lane.id === 'wakes') {
        for (const w of lane.items) {
          const x1 = x(Date.parse(w.start));
          const x2 = x(Date.parse(w.end));
          marks.append(s('rect', { class: `tl-wake${w.acted ? ' acted' : ''}${w.ending === 'crashed' || w.ending === 'unreadable' ? ' broke' : ''}`, x: Math.min(x1, x2 - 2).toFixed(1), y: mid - 6, width: Math.max(2, x2 - x1).toFixed(1), height: 12, rx: 2, 'data-wake': w.wakeId }));
        }
      } else if (lane.id === 'sent') {
        for (const m of lane.items) marks.append(s('circle', { class: 'tl-sent', cx: x(Date.parse(m.at)).toFixed(1), cy: mid, r: 4.5 }));
      } else {
        const cls = lane.id === 'b-wake' ? 'wakeTick' : lane.id === 'b-sleep' ? 'sleepTick' : '';
        let d = '';
        let dOwner = '';
        for (const e of lane.items) {
          const xx = x(Date.parse(e.at)).toFixed(1);
          if (lane.id === 'message' && e.kind === 'owner_direct') dOwner += `M${xx},${mid - 8}V${mid + 8}`;
          else d += `M${xx},${mid - 6}V${mid + 6}`;
        }
        if (d) marks.append(s('path', { class: `tl-tick ${cls}`, d }));
        if (dOwner) marks.append(s('path', { class: 'tl-tick owner', d: dOwner }));
      }
      y += laneH + 4;
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
      el('li', null, el('i', { class: 'k-wake soft' }), 'awake, went back to sleep'),
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
          el('div', { class: 'tt-row' }, el('b', null, String(wNear.turns)), wNear.turns === 1 ? 'move' : 'moves', ` · ${triggerWords({ source: wNear.sense === 'other' ? '' : wNear.sense, kind: wNear.triggerKind })}`),
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
    const onLeave = () => {
      cross.setAttribute('opacity', '0');
      tip.hidden = true;
      if (hovered) hovered.classList.remove('hover');
      hovered = undefined;
    };
    hit.addEventListener('pointermove', onMove);
    hit.addEventListener('pointerleave', onLeave);
    hit.addEventListener('click', (ev) => {
      const r = svg.getBoundingClientRect();
      const px = ((ev.clientX - r.left) / r.width) * W;
      const w = nearestWake(px);
      if (w) openWake(w.wakeId);
    });

    const ev = tl.events.filter((e) => e.sense !== 'self').length;
    $('#timelineNote').textContent = `${plural(ev, 'event')} sensed, ${plural(tl.wakes.length, 'wake')}, ${plural(tl.sent.length, 'message')} sent, since ${fmtWhen(from)}.`;
  }

  // ------------------------------------------------------------------ wakes list
  function renderWakeList() {
    const snap = state.snap;
    const now = Date.parse(snap.now) || Date.now();
    const list = $('#wakeList');
    const all = snap.wakes;
    const wq = (state.wakeQuery || '').trim().toLowerCase();
    const byMode =
      state.wakeFilter === 'acted'
        ? all.filter((w) => w.acted || w.sent)
        : state.wakeFilter === 'crashed'
          ? all.filter((w) => w.ending && w.ending !== 'sleep')
          : all;
    const shown = wq ? byMode.filter((w) => `${w.trigger?.text || ''} ${w.firstSent || ''} ${w.ending || ''}`.toLowerCase().includes(wq)) : byMode;
    const items = shown.slice(0, state.wakeLimit).map((w) => {
      const moves = el('span', { class: 'w-moves', 'aria-label': `${w.turns} moves` });
      for (const mv of w.moves.slice(0, 30)) {
        const cls = mv.toolId === 'sleep' ? 'st-sleep' : mv.toolId === 'send_message' && mv.status === 'ok' ? 'st-say' : toneOfStatus(mv.status) === 'fail' ? 'st-fail' : toneOfStatus(mv.status) === 'wait' ? 'st-wait' : '';
        moves.append(el('i', { class: cls, title: toolWords(mv.toolId) }));
      }
      return el(
        'li',
        { class: `wake-row${state.sheet?.kind === 'wake' && state.sheet.id === w.wakeId ? ' selected' : ''}`, 'data-wake': w.wakeId },
        el(
          'button',
          { type: 'button', onclick: () => openWake(w.wakeId) },
          el('span', { class: 'w-time' }, fmtWhen(w.at, now)),
          el('span', { class: 'w-main' }, el('span', { class: 'w-src' }, `${triggerWords(w.trigger)} · ${plural(w.turns, 'move')}${w.ending !== 'sleep' ? ` · ${endingWord(w.ending)}` : ''}${Number.isFinite(w.costUsd) && w.costUsd > 0 ? ` · ${fmtCost(w.costUsd)}` : ''}`), el('span', { class: 'w-text' }, short(clean(w.trigger.text), 160))),
          moves,
          w.firstSent ? el('span', { class: 'w-said' }, clean(w.firstSent)) : null,
        ),
      );
    });
    if (!items.length) items.push(el('li', { class: 'wake-row' }, el('p', { class: 'empty', style: 'padding:12px 0' }, all.length ? 'He hasn’t acted in the recent wakes. Choose All to see every wake.' : 'No wakes recorded yet.')));
    list.replaceChildren(...items);
    if (shown.length > state.wakeLimit) {
      list.append(el('li', { class: 'wake-row' }, el('button', { type: 'button', onclick: () => ((state.wakeLimit += 24), renderWakeList()) }, el('span', { class: 'w-time' }, ''), el('span', { class: 'w-src' }, `Show more (${shown.length - state.wakeLimit} older)`))));
    }
  }

  function renderFoot() {
    const snap = state.snap;
    $('#foot').replaceChildren(
      el('span', null, `Read-only view of ${snap.workspace} · 127.0.0.1`),
      el('span', null, `Daemon ${snap.daemon.up ? 'answering' : 'not answering'} on :${snap.daemon.port}`),
      el('span', null, 'Shortcuts: 1–9, 0 inspect · / search gaps · t theme · Esc close'),
    );
  }

  // ------------------------------------------------------------------ ticking text (countdowns, clock)
  function tick() {
    const now = Date.now();
    $('#clock').textContent = `${dayFmt.format(new Date(now))} ${fmtClock(now)}`;
    for (const n of document.querySelectorAll('[data-in]')) n.textContent = fmtIn(Date.parse(n.dataset.in) - now);
    for (const n of document.querySelectorAll('[data-ago]')) n.textContent = `for ${fmtDur(now - Date.parse(n.dataset.ago)).replace(/\.\ds$/, 's')}`;
    if (state.snap && !state.player) Plate.setCenter();
  }

  // ------------------------------------------------------------------ theme + controls
  function initTheme() {
    let t = 'dark';
    try {
      t = localStorage.getItem('rufus-theme') || 'dark';
    } catch {
      /* private mode */
    }
    document.documentElement.dataset.theme = t === 'light' ? 'light' : 'dark';
    $('#themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try {
        localStorage.setItem('rufus-theme', next);
      } catch {
        /* ignore */
      }
      if (state.snap) renderHeader();
    });
  }

  function initControls() {
    $('#needsChip').addEventListener('click', () => $('#needs').scrollIntoView({ behavior: 'smooth', block: 'center' }));
    for (const b of document.querySelectorAll('#rangeSeg button')) {
      b.addEventListener('click', async () => {
        state.hours = Number(b.dataset.hours);
        for (const o of document.querySelectorAll('#rangeSeg button')) o.setAttribute('aria-checked', String(o === b));
        state.timeline = await getJSON(`/api/timeline?hours=${state.hours}`).catch(() => state.timeline);
        renderTimeline();
      });
    }
    for (const b of document.querySelectorAll('#gapFilter button')) {
      b.addEventListener('click', () => {
        state.gapFilter = b.dataset.gfilter;
        for (const o of document.querySelectorAll('#gapFilter button')) o.setAttribute('aria-checked', String(o === b));
        renderGaps();
      });
    }
    const gapSearch = $('#gapSearch');
    if (gapSearch) {
      gapSearch.addEventListener('input', () => {
        state.gapQuery = gapSearch.value;
        renderGaps();
      });
    }
    const wakeSearch = $('#wakeSearch');
    if (wakeSearch) {
      wakeSearch.addEventListener('input', () => {
        state.wakeQuery = wakeSearch.value;
        state.wakeLimit = 24;
        renderWakeList();
      });
    }
    for (const b of document.querySelectorAll('#wakeFilter button')) {
      b.addEventListener('click', () => {
        state.wakeFilter = b.dataset.filter;
        state.wakeLimit = 24;
        for (const o of document.querySelectorAll('#wakeFilter button')) o.setAttribute('aria-checked', String(o === b));
        renderWakeList();
      });
    }
    document.addEventListener('keydown', (e) => {
      if (e.target && ['INPUT', 'TEXTAREA'].includes(e.target.tagName)) {
        if (e.key === 'Escape') e.target.blur();
        return;
      }
      if (e.key === '/' && gapSearch) {
        e.preventDefault();
        gapSearch.focus();
      } else if (e.key === 't' && !e.metaKey && !e.ctrlKey && !e.altKey) {
        $('#themeBtn')?.click();
      } else if (/^[0-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
        openNodeSheet(e.key === '0' ? 10 : Number(e.key));
      }
    });
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(() => state.timeline && renderTimeline(), 120);
    });
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && state.sheet && !state.player) closeSheet();
    });
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
  window.__rufus = { state, openWake, openNodeSheet, closeSheet };
  boot();
})();
