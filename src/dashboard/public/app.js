(() => {
  'use strict';

  const state = {
    snap: null,
    view: 'command',
    missionFilter: 'active',
    missionQuery: '',
    wakeFilter: 'acted',
    wakeQuery: '',
  };

  const $ = (id) => document.getElementById(id);

  function esc(v) {
    return String(v ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function relTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '—';
    const sec = Math.round((d.getTime() - Date.now()) / 1000);
    const abs = Math.abs(sec);
    if (abs < 45) return sec >= 0 ? 'in moments' : 'just now';
    const min = Math.round(abs / 60);
    if (min < 60) return sec >= 0 ? `in ${min}m` : `${min}m ago`;
    const hr = Math.round(min / 60);
    if (hr < 36) return sec >= 0 ? `in ${hr}h` : `${hr}h ago`;
    const days = Math.round(hr / 24);
    return sec >= 0 ? `in ${days}d` : `${days}d ago`;
  }

  function shortTime(iso) {
    if (!iso) return '--:--';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '--:--';
    return d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
  }

  function fmtCost(v) {
    const n = Number(v || 0);
    if (n === 0) return '$0.00';
    return n < 0.01 ? '<$0.01' : `$${n.toFixed(2)}`;
  }

  function fmtMs(ms) {
    const n = Number(ms || 0);
    if (n < 1000) return `${Math.round(n)}ms`;
    return `${(n / 1000).toFixed(1)}s`;
  }

  function setView(view) {
    state.view = view;
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      const on = btn.dataset.view === view;
      btn.classList.toggle('active', on);
      btn.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('.view').forEach((sec) => {
      const on = sec.id === `view-${view}`;
      sec.classList.toggle('active', on);
      sec.hidden = !on;
    });
    render();
  }

  function openDrawer(eyebrow, title, bodyHtml) {
    $('drawerEyebrow').textContent = eyebrow;
    $('drawerTitle').textContent = title;
    $('drawerBody').innerHTML = bodyHtml;
    $('drawerBackdrop').hidden = false;
    $('drawer').hidden = false;
  }

  function closeDrawer() {
    $('drawerBackdrop').hidden = true;
    $('drawer').hidden = true;
  }

  function updateClock() {
    $('hudClock').textContent = new Date().toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      second: '2-digit',
    });
  }

  function renderHeader(snap) {
    const pill = $('daemonPill');
    const lbl = $('daemonLabel');
    const isAwake = snap.live?.status === 'awake';
    pill.className = 'status-pill ' + (!snap.daemon?.up ? 'offline' : isAwake ? 'awake' : 'live');
    lbl.textContent = !snap.daemon?.up ? 'OFFLINE' : isAwake ? 'AWAKE' : 'ONLINE';

    const approvals = snap.approvals || [];
    const proposed = (snap.gaps || []).filter((g) => g.status === 'proposed' && !g.standing);
    const totalNeeds = approvals.length + proposed.length;
    const btn = $('attentionBtn');
    if (totalNeeds > 0) {
      btn.hidden = false;
      btn.textContent = `${totalNeeds} NEEDS YOU`;
    } else {
      btn.hidden = true;
    }
  }

  function renderCore(snap) {
    const svg = $('coreSvg');
    const isAwake = snap.live?.status === 'awake';
    const isUp = !!snap.daemon?.up;
    const approvals = snap.approvals || [];
    const proposed = (snap.gaps || []).filter((g) => g.status === 'proposed' && !g.standing);

    svg.classList.remove('awake', 'offline', 'attention');
    if (!isUp) svg.classList.add('offline');
    else if (isAwake) svg.classList.add('awake');
    else if (approvals.length > 0) svg.classList.add('attention');

    const turns = snap.live?.turns || [];
    const lastTurn = turns[turns.length - 1];
    const nextWatch = snap.anatomy?.sleep?.next;

    if (!isUp) {
      $('coreState').textContent = 'OFFLINE';
      $('coreSub').textContent = 'DAEMON DOWN';
      $('coreEyebrow').textContent = 'DAEMON NOT REACHABLE';
      $('coreHeadline').textContent = 'Rufus is currently offline.';
      $('coreCaption').textContent = 'Start the daemon to resume live sensing and autonomous wakes.';
    } else if (isAwake) {
      $('coreState').textContent = 'AWAKE';
      $('coreSub').textContent = `TURN ${turns.length || 1}`;
      $('coreEyebrow').textContent = `LIVE WAKE · ${(snap.live?.trigger?.source || 'event').toUpperCase()}`;
      $('coreHeadline').textContent = lastTurn?.thought || snap.live?.trigger?.text?.slice(0, 110) || 'Working active mission…';
      $('coreCaption').textContent = lastTurn
        ? `Running ${lastTurn.toolId}${lastTurn.gapId && snap.gapTitles?.[lastTurn.gapId] ? ` for “${snap.gapTitles[lastTurn.gapId]}”` : ''}.`
        : 'Evaluating The Desk and choosing next move.';
    } else {
      $('coreState').textContent = 'STANDBY';
      $('coreSub').textContent = nextWatch?.at ? relTime(nextWatch.at).toUpperCase() : 'LISTENING';
      $('coreEyebrow').textContent = 'AUTONOMOUS STANDBY · ZERO IDLE BURN';
      const lifeActive = (snap.gaps || []).filter((g) => !g.standing && g.id !== 'gap_root' && (g.status === 'open' || g.status === 'waiting'));
      $('coreHeadline').textContent = lifeActive.length
        ? `Watching ${lifeActive.length} active mission${lifeActive.length === 1 ? '' : 's'} across ${snap.anatomy?.senses?.length || 0} senses.`
        : 'All clear. Listening for incoming signals.';
      $('coreCaption').textContent = nextWatch?.at
        ? `Next scheduled check ${relTime(nextWatch.at)}: ${nextWatch.label || 'follow-up'}.`
        : 'Bouncer is filtering incoming events locally at $0.';
    }

    const activeCount = (snap.gaps || []).filter((g) => !g.standing && g.id !== 'gap_root' && (g.status === 'open' || g.status === 'waiting')).length;
    const left5h = Math.round(snap.credits?.left5hPct ?? 100);
    const wakes24 = snap.anatomy?.desk?.wakes24h ?? 0;
    const cost24 = snap.anatomy?.desk?.cost24h ?? 0;

    const kpis = [
      { val: String(activeCount), lbl: 'Active Missions', cls: 'accent' },
      { val: `${left5h}%`, lbl: '5h Runway', cls: left5h > 40 ? 'green' : left5h > 15 ? 'amber' : 'rose' },
      { val: String(wakes24), lbl: 'Wakes (24h)', cls: '' },
      { val: fmtCost(cost24), lbl: 'Spend (24h)', cls: '' },
    ];
    $('kpiStrip').innerHTML = kpis
      .map((k) => `<div class="kpi-item"><span class="kpi-val ${k.cls}">${esc(k.val)}</span><span class="kpi-lbl">${esc(k.lbl)}</span></div>`)
      .join('');

    // Live 6-stage pipeline tracker so you can always see exactly where Rufus is right now
    const stages = [
      { id: 'sense', label: 'SENSE' },
      { id: 'bouncer', label: 'BOUNCER' },
      { id: 'desk', label: 'DESK' },
      { id: 'decide', label: 'DECIDE' },
      { id: 'tools', label: 'TOOLS' },
      { id: 'sleep', label: isAwake && lastTurn?.toolId === 'send_message' ? 'SPEAK' : 'SLEEP' },
    ];
    let activeIdx = -1;
    if (isAwake) {
      if (!lastTurn) activeIdx = 3; // DECIDE
      else if (lastTurn.toolId === 'send_message' || lastTurn.toolId === 'sleep') activeIdx = 5;
      else activeIdx = 4; // TOOLS
    }
    $('livePipeline').innerHTML = stages
      .map((st, idx) => {
        let cls = '';
        if (isAwake) {
          cls = idx === activeIdx ? 'active' : idx < activeIdx ? 'passed' : '';
        } else if (isUp && (idx === 0 || idx === 5)) {
          cls = 'standby';
        }
        return `<div class="pipe-node ${cls}"><span class="pipe-dot"></span><span>${esc(st.label)}</span></div>`;
      })
      .join('');

    const liveTurnsEl = $('liveTurns');
    if (isAwake && turns.length) {
      liveTurnsEl.hidden = false;
      liveTurnsEl.innerHTML = turns
        .slice(-3)
        .map(
          (t) => `
          <div class="live-turn-row">
            <span class="live-turn-num">#${t.turn}</span>
            <span class="live-turn-tool">${esc(t.toolId)}</span>
            <span class="live-turn-thought">${esc(t.thought || t.summary || '')}</span>
          </div>`,
        )
        .join('');
    } else {
      liveTurnsEl.hidden = true;
    }
  }

  function renderCommandMissions(snap) {
    const life = (snap.gaps || [])
      .filter((g) => !g.standing && g.id !== 'gap_root' && (g.status === 'open' || g.status === 'waiting'))
      .sort((a, b) => new Date(b.updatedAt || 0) - new Date(a.updatedAt || 0));

    const proposedCount = (snap.gaps || []).filter((g) => !g.standing && g.status === 'proposed').length;
    $('activeMissionsSub').textContent = `${life.length} in motion${proposedCount ? ` · ${proposedCount} proposed` : ''}`;

    const el = $('commandMissions');
    if (!life.length) {
      el.innerHTML = '<div class="empty">No active life missions right now.</div>';
      return;
    }
    el.innerHTML = life
      .slice(0, 6)
      .map((g) => {
        const next = g.next?.[0]?.label ? `Next: ${g.next[0].label}` : g.reality || g.target || '';
        return `
          <button class="mission-row" type="button" data-gap-id="${esc(g.id)}">
            <div class="mission-left">
              <span class="status-dot ${esc(g.status)}"></span>
              <div>
                <div class="mission-title">${esc(g.title)}</div>
                <div class="mission-meta">${esc(next)}</div>
              </div>
            </div>
            <div class="mission-right">
              <span class="tag ${esc(g.status)}">${esc(g.status)}</span>
              <span class="mono-dim">${esc(relTime(g.updatedAt))}</span>
            </div>
          </button>`;
      })
      .join('');
  }

  function renderAttention(snap) {
    const approvals = snap.approvals || [];
    const proposed = (snap.gaps || []).filter((g) => !g.standing && g.status === 'proposed');
    const panel = $('attentionPanel');
    if (!approvals.length && !proposed.length) {
      panel.hidden = true;
      return;
    }
    panel.hidden = false;
    const items = [];
    for (const a of approvals) {
      items.push(`
        <div class="attention-item" data-approval-id="${esc(a.id)}">
          <div class="attention-kind">Approval · ${esc(a.toolId)}</div>
          <div class="attention-text">${esc(a.gapId && snap.gapTitles?.[a.gapId] ? snap.gapTitles[a.gapId] : a.toolId)}</div>
        </div>`);
    }
    for (const g of proposed.slice(0, 4)) {
      items.push(`
        <div class="attention-item" data-gap-id="${esc(g.id)}">
          <div class="attention-kind">Proposed Mission</div>
          <div class="attention-text">${esc(g.title)}</div>
        </div>`);
    }
    $('attentionList').innerHTML = items.join('');
  }

  function renderCredits(snap) {
    const c = snap.credits || {};
    const left5 = Math.max(0, Math.min(100, Math.round(c.left5hPct ?? 100)));
    const left7 = Math.max(0, Math.min(100, Math.round(c.left7dPct ?? 100)));
    const localName = c.localModel ? c.localModel.replace(/\.gguf$/i, '') : 'none';
    $('creditStackSub').textContent = `Primary ${c.primary || 'Claude'} · Local ${localName}`;

    const clsFor = (p) => (p > 45 ? 'green' : p > 20 ? 'amber' : 'rose');
    $('creditGauges').innerHTML = [
      { label: '5-Hour Limit Remaining', pct: left5 },
      { label: 'Weekly Limit Remaining', pct: left7 },
    ]
      .map(
        (g) => `
        <div class="gauge-row">
          <div class="gauge-head">
            <span>${esc(g.label)}</span>
            <span class="gauge-pct">${g.pct}%</span>
          </div>
          <div class="bar-track"><div class="bar-fill ${clsFor(g.pct)}" style="width:${g.pct}%"></div></div>
        </div>`,
      )
      .join('');
  }

  function renderRecentFeed(snap) {
    const wakes = (snap.wakes || []).slice(0, 7);
    const el = $('recentFeed');
    if (!wakes.length) {
      el.innerHTML = '<div class="empty">No recorded wakes yet.</div>';
      return;
    }
    el.innerHTML = wakes
      .map((w) => {
        const label = w.firstSent || w.trigger?.text || w.sleepReason || w.wakeId;
        const issue = w.ending && w.ending !== 'sleep';
        return `
          <button class="feed-item" type="button" data-wake-id="${esc(w.wakeId)}">
            <span class="feed-time">${esc(shortTime(w.at))}</span>
            <span class="feed-title">${esc(label)}</span>
            <span class="feed-meta">${issue ? '!' : `${w.turns}t`}</span>
          </button>`;
      })
      .join('');
  }

  function renderSenses(snap) {
    const senses = snap.anatomy?.senses || [];
    const broken = senses.filter((s) => s.health === 'broken' || s.health === 'degraded').length;
    $('sensesSub').textContent = broken ? `${broken} degraded` : `${senses.length} connected`;
    $('sensesGrid').innerHTML = senses
      .map((s) => {
        const cls = s.health === 'broken' ? 'bad' : s.health === 'degraded' ? 'warn' : s.count24h > 0 ? '' : 'idle';
        return `
          <div class="sense-chip">
            <span class="sense-name"><span class="sense-dot ${cls}"></span><span>${esc(s.label || s.id)}</span></span>
            <span class="sense-count">${s.count24h || 0}</span>
          </div>`;
      })
      .join('');
  }

  function renderMissionsView(snap) {
    const q = state.missionQuery.trim().toLowerCase();
    const all = (snap.gaps || []).filter((g) => g.id !== 'gap_root');
    const filtered = all.filter((g) => {
      if (state.missionFilter === 'active') return !g.standing && (g.status === 'open' || g.status === 'waiting');
      if (state.missionFilter === 'proposed') return !g.standing && g.status === 'proposed';
      if (state.missionFilter === 'selfopt') return !!g.standing;
      if (state.missionFilter === 'done') return g.status === 'closed' || g.status === 'dropped';
      return true;
    }).filter((g) => !q || `${g.title} ${g.reality || ''} ${g.target || ''}`.toLowerCase().includes(q));

    $('missionsSummary').textContent = `${filtered.length} shown · ${all.length} total missions`;
    const board = $('missionBoard');
    if (!filtered.length) {
      board.innerHTML = '<div class="empty">No missions match this filter.</div>';
      return;
    }
    board.innerHTML = filtered
      .map((g) => `
        <button class="mission-card" type="button" data-gap-id="${esc(g.id)}">
          <div class="mission-card-top">
            <span class="tag ${esc(g.status)}">${esc(g.standing ? 'standing' : g.status)}</span>
            <span class="mono-dim">${esc(relTime(g.updatedAt))}</span>
          </div>
          <div class="mission-card-title">${esc(g.title)}</div>
          <div class="mission-card-body">${esc(g.reality || g.target || '')}</div>
          <div class="mission-card-foot">
            <span>${g.log?.length || 0} log entries</span>
            <span>${g.next?.length ? `Next: ${esc(g.next[0].label || 'scheduled').slice(0, 32)}` : 'Inspect →'}</span>
          </div>
        </button>`)
      .join('');
  }

  function renderLogView(snap) {
    const allWakes = snap.wakes || [];
    const q = state.wakeQuery.trim().toLowerCase();
    const filtered = allWakes.filter((w) => {
      if (state.wakeFilter === 'acted') return !!w.acted;
      if (state.wakeFilter === 'issues') return w.ending && w.ending !== 'sleep';
      return true;
    }).filter((w) => !q || `${w.trigger?.text || ''} ${w.firstSent || ''} ${w.sleepReason || ''} ${w.wakeId}`.toLowerCase().includes(q));

    const acted24 = snap.anatomy?.desk?.acted24h ?? 0;
    const cost24 = snap.anatomy?.desk?.cost24h ?? 0;
    $('logSummary').textContent = `${filtered.length} wakes shown · ${acted24} acted in 24h · ${fmtCost(cost24)}`;

    // 24-hour bucket sparkline
    const now = Date.now();
    const buckets = Array.from({ length: 24 }, () => ({ total: 0, acted: 0, issue: 0 }));
    for (const w of allWakes) {
      const t = new Date(w.at).getTime();
      if (Number.isNaN(t)) continue;
      const hrsAgo = Math.floor((now - t) / 3_600_000);
      if (hrsAgo >= 0 && hrsAgo < 24) {
        const b = buckets[23 - hrsAgo];
        b.total++;
        if (w.acted) b.acted++;
        if (w.ending && w.ending !== 'sleep') b.issue++;
      }
    }
    const maxB = Math.max(1, ...buckets.map((b) => b.total));
    $('sparkStats').textContent = `Median ${snap.telemetry?.medianTurns ?? 0} turns · Clean sleep ${Math.round(snap.telemetry?.cleanSleepPct ?? 100)}%`;
    $('sparkChart').innerHTML = buckets
      .map((b) => {
        const h = Math.max(6, Math.round((b.total / maxB) * 100));
        const cls = b.issue ? 'issue' : b.acted ? 'acted' : '';
        return `<div class="spark-bar ${cls}" style="height:${h}%" title="${b.total} wakes (${b.acted} acted)"></div>`;
      })
      .join('');

    const table = $('wakeTable');
    if (!filtered.length) {
      table.innerHTML = '<div class="empty">No wakes match this filter.</div>';
      return;
    }
    table.innerHTML = filtered
      .slice(0, 60)
      .map((w) => {
        const issue = w.ending && w.ending !== 'sleep';
        const badgeCls = issue ? 'fail' : w.acted ? 'ok' : '';
        const badgeText = issue ? w.ending : w.acted ? 'acted' : 'quiet';
        return `
          <button class="wake-row" type="button" data-wake-id="${esc(w.wakeId)}">
            <span class="mono-dim">${esc(shortTime(w.at))}</span>
            <span class="tag ${badgeCls} hide-sm">${esc(badgeText)}</span>
            <span class="wake-trigger">${esc(w.firstSent || w.trigger?.text || w.sleepReason || w.wakeId)}</span>
            <span class="mono-dim hide-sm">${w.turns} turns</span>
            <span class="mono-dim hide-sm">${fmtMs(w.durationMs)}</span>
            <span class="mono-dim">${fmtCost(w.costUsd)}</span>
          </button>`;
      })
      .join('');
  }

  function renderSystemsView(snap) {
    const a = snap.anatomy || {};
    const t = snap.telemetry || {};
    const c = snap.credits || {};
    $('systemsSummary').textContent = `Workspace ${snap.workspace || '~/.rufus-v2'} · Bound to 127.0.0.1 (read-only)`;

    const brokenTools = a.tools?.broken || [];
    const skills = a.tools?.skillNames || [];

    $('systemsGrid').innerHTML = `
      <section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Intelligence & Routing</h2><p class="panel-sub">Fast loop vs deep specialists</p></div></div>
        <div class="kv-list">
          <div class="kv-row"><span class="kv-k">Fast Loop (Decide · Speaker · Triage)</span><span class="kv-v">Claude Haiku</span></div>
          <div class="kv-row"><span class="kv-k">Deep Specialists (Plan · Create · Verify)</span><span class="kv-v">Claude Opus</span></div>
          <div class="kv-row"><span class="kv-k">Local Offline Fallback</span><span class="kv-v">${esc((c.localModel || 'none').replace(/\.gguf$/i, ''))}</span></div>
          <div class="kv-row"><span class="kv-k">5h / Weekly Runway</span><span class="kv-v">${Math.round(c.left5hPct ?? 100)}% / ${Math.round(c.left7dPct ?? 100)}%</span></div>
          <div class="kv-row"><span class="kv-k">Model Calls (24h)</span><span class="kv-v">${a.desk?.modelCalls24h ?? 0} (${fmtCost(a.desk?.cost24h)})</span></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Bouncer & Memory</h2><p class="panel-sub">$0 local event filter & lossless log</p></div></div>
        <div class="kv-list">
          <div class="kv-row"><span class="kv-k">Bouncer Sleep Rate</span><span class="kv-v">${Math.round(t.bouncerSleepPct ?? 0)}%</span></div>
          <div class="kv-row"><span class="kv-k">SetFit Latency</span><span class="kv-v">${fmtMs(t.setfitMs ?? a.bouncer?.lastMs ?? 0)}</span></div>
          <div class="kv-row"><span class="kv-k">24h Wakes / Sleeps</span><span class="kv-v">${a.bouncer?.wake24h ?? 0} / ${a.bouncer?.sleep24h ?? 0}</span></div>
          <div class="kv-row"><span class="kv-k">Indexed Memory Events</span><span class="kv-v">${(a.memory?.events ?? 0).toLocaleString()}</span></div>
          <div class="kv-row"><span class="kv-k">Training Examples</span><span class="kv-v">${a.bouncer?.examples ?? 0}</span></div>
        </div>
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Toolset & Skills</h2><p class="panel-sub">${a.tools?.total ?? 0} tools · ${skills.length} skills</p></div></div>
        <div class="kv-list">
          <div class="kv-row"><span class="kv-k">Built-in / Custom Tools</span><span class="kv-v">${a.tools?.builtin ?? 0} / ${a.tools?.custom ?? 0}</span></div>
          <div class="kv-row"><span class="kv-k">Broken Tools</span><span class="kv-v">${brokenTools.length ? esc(brokenTools.join(', ')) : 'None'}</span></div>
          <div class="kv-row"><span class="kv-k">Trust: Act Quietly / Report / Draft</span><span class="kv-v">${a.trust?.act_quietly ?? 0} / ${a.trust?.act_and_report ?? 0} / ${a.trust?.draft ?? 0}</span></div>
        </div>
        ${skills.length ? `<div class="tool-pills">${skills.map((s) => `<span class="tool-pill">${esc(s)}</span>`).join('')}</div>` : ''}
      </section>

      <section class="panel">
        <div class="panel-head"><div><h2 class="panel-title">Senses Health</h2><p class="panel-sub">24-hour signal status</p></div></div>
        <div class="kv-list">
          ${(a.senses || [])
            .map(
              (s) => `
              <div class="kv-row">
                <span class="kv-k">${esc(s.label || s.id)}</span>
                <span class="kv-v">${s.count24h || 0} events · ${esc(s.health || 'ok')}</span>
              </div>`,
            )
            .join('')}
        </div>
      </section>`;
  }

  function inspectGap(gapId) {
    const g = (state.snap?.gaps || []).find((x) => x.id === gapId);
    if (!g) return;
    const logs = (g.log || []).slice(-10).reverse();
    const watches = g.next || [];
    const html = `
      <div class="drawer-section">
        <div class="drawer-label">Status</div>
        <div><span class="tag ${esc(g.status)}">${esc(g.standing ? 'standing · ' + g.status : g.status)}</span> <span class="mono-dim" style="margin-left:8px">${esc(g.id)} · updated ${esc(relTime(g.updatedAt))}</span></div>
      </div>
      <div class="drawer-section">
        <div class="drawer-label">Target</div>
        <div class="drawer-text">${esc(g.target || '—')}</div>
      </div>
      <div class="drawer-section">
        <div class="drawer-label">Current Reality</div>
        <div class="drawer-text">${esc(g.reality || '—')}</div>
      </div>
      ${
        watches.length
          ? `<div class="drawer-section">
              <div class="drawer-label">Scheduled Next Moves</div>
              ${watches
                .map(
                  (w) => `<div class="turn-card"><div class="turn-head"><span>${esc(w.label || w.kind)}</span><span class="mono-dim">${esc(relTime(w.fireAt))}</span></div></div>`,
                )
                .join('')}
            </div>`
          : ''
      }
      <div class="drawer-section">
        <div class="drawer-label">Work Log (${logs.length})</div>
        ${
          logs.length
            ? logs
                .map(
                  (l) => `
                  <div class="turn-card">
                    <div class="turn-head">
                      <span>${esc(l.toolId)}</span>
                      <span class="mono-dim">${esc(relTime(l.at))}</span>
                    </div>
                    <div class="turn-summary">${esc(l.result || l.status || '')}</div>
                  </div>`,
                )
                .join('')
            : '<div class="mono-dim">No moves recorded yet.</div>'
        }
      </div>`;
    openDrawer('MISSION INSPECTOR', g.title, html);
  }

  async function inspectWake(wakeId) {
    openDrawer('FLIGHT RECORDER', `Loading ${wakeId}…`, '<div class="empty">Reading trace…</div>');
    try {
      const res = await fetch(`/api/wake/${encodeURIComponent(wakeId)}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const w = await res.json();
      const turns = w.trace || [];
      const html = `
        <div class="drawer-section">
          <div class="drawer-label">Trigger · ${esc(shortTime(w.at))}</div>
          <div class="drawer-text">${esc(w.trigger?.text || '—')}</div>
          <div class="mono-dim">${esc(w.trigger?.source || '')}/${esc(w.trigger?.kind || '')} · ${turns.length} turns · ${fmtMs(w.durationMs)} · ${fmtCost(w.costUsd)}</div>
        </div>
        ${
          w.decision?.reason
            ? `<div class="drawer-section">
                <div class="drawer-label">Bouncer / Triage Reasoning</div>
                <div class="drawer-text">${esc(w.decision.reason)}</div>
              </div>`
            : ''
        }
        <div class="drawer-section">
          <div class="drawer-label">Recorded Thoughts & Tool Receipts</div>
          ${turns
            .map(
              (t) => `
              <div class="turn-card">
                <div class="turn-head">
                  <span>#${t.turn} · ${esc(t.toolId)}</span>
                  <span class="tag ${t.receipt?.status === 'ok' ? 'ok' : 'fail'}">${esc(t.receipt?.status || 'ok')}</span>
                </div>
                ${t.thought ? `<div class="turn-thought">${esc(t.thought)}</div>` : ''}
                ${t.receipt?.sentText ? `<div class="sent-box">${esc(t.receipt.sentText)}</div>` : ''}
                ${t.receipt?.summary ? `<div class="turn-summary">${esc(t.receipt.summary)}</div>` : ''}
              </div>`,
            )
            .join('')}
        </div>`;
      openDrawer('FLIGHT RECORDER', w.wakeId, html);
    } catch (err) {
      openDrawer('FLIGHT RECORDER', wakeId, `<div class="empty">Could not load wake: ${esc(err.message)}</div>`);
    }
  }

  function render() {
    const snap = state.snap;
    if (!snap) return;
    renderHeader(snap);
    if (state.view === 'command') {
      renderCore(snap);
      renderCommandMissions(snap);
      renderAttention(snap);
      renderCredits(snap);
      renderRecentFeed(snap);
      renderSenses(snap);
    } else if (state.view === 'missions') {
      renderMissionsView(snap);
    } else if (state.view === 'log') {
      renderLogView(snap);
    } else if (state.view === 'systems') {
      renderSystemsView(snap);
    }
  }

  async function refresh() {
    try {
      const res = await fetch('/api/snapshot');
      if (!res.ok) return;
      state.snap = await res.json();
      render();
    } catch {
      /* retry via SSE or timer */
    }
  }

  function initEvents() {
    document.querySelectorAll('.nav-tab').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.view));
    });
    document.querySelectorAll('[data-goto]').forEach((btn) => {
      btn.addEventListener('click', () => setView(btn.dataset.goto));
    });
    $('attentionBtn').addEventListener('click', () => {
      setView('command');
      $('attentionPanel').scrollIntoView({ behavior: 'smooth', block: 'center' });
    });

    $('themeBtn').addEventListener('click', () => {
      const next = document.documentElement.dataset.theme === 'light' ? 'dark' : 'light';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('rufus-theme', next); } catch {}
    });

    $('drawerClose').addEventListener('click', closeDrawer);
    $('drawerBackdrop').addEventListener('click', closeDrawer);

    document.body.addEventListener('click', (e) => {
      const gapEl = e.target.closest('[data-gap-id]');
      if (gapEl) { inspectGap(gapEl.dataset.gapId); return; }
      const wakeEl = e.target.closest('[data-wake-id]');
      if (wakeEl) { inspectWake(wakeEl.dataset.wakeId); return; }
    });

    $('missionFilter').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-mf]');
      if (!btn) return;
      state.missionFilter = btn.dataset.mf;
      $('missionFilter').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b === btn ? 'true' : 'false'));
      render();
    });
    $('missionSearch').addEventListener('input', (e) => {
      state.missionQuery = e.target.value;
      render();
    });

    $('wakeFilter').addEventListener('click', (e) => {
      const btn = e.target.closest('button[data-wf]');
      if (!btn) return;
      state.wakeFilter = btn.dataset.wf;
      $('wakeFilter').querySelectorAll('button').forEach((b) => b.setAttribute('aria-checked', b === btn ? 'true' : 'false'));
      render();
    });
    $('wakeSearch').addEventListener('input', (e) => {
      state.wakeQuery = e.target.value;
      render();
    });

    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { closeDrawer(); return; }
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA') return;
      if (e.key === '1') setView('command');
      else if (e.key === '2') setView('missions');
      else if (e.key === '3') setView('log');
      else if (e.key === '4') setView('systems');
      else if (e.key === 't' || e.key === 'T') $('themeBtn').click();
      else if (e.key === '/') {
        e.preventDefault();
        if (state.view === 'missions') $('missionSearch').focus();
        else if (state.view === 'log') $('wakeSearch').focus();
        else { setView('missions'); setTimeout(() => $('missionSearch').focus(), 20); }
      }
    });
  }

  function initStream() {
    try {
      const es = new EventSource('/api/stream');
      es.onmessage = () => refresh();
      es.onerror = () => { /* browser reconnects automatically */ };
    } catch {
      /* fallback polling below */
    }
    setInterval(refresh, 15_000);
  }

  try {
    const saved = localStorage.getItem('rufus-theme');
    if (saved === 'light' || saved === 'dark') document.documentElement.dataset.theme = saved;
  } catch {}

  updateClock();
  setInterval(updateClock, 1000);
  initEvents();
  refresh();
  initStream();
})();
