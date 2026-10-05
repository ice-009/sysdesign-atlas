/* The HLD + LLD plan from the switch-prep tracker, day by day.

   The plan and the scheduler come from the build (window.ATLAS_PREP and
   window.AtlasPrepCore, transpiled from lib/prep.ts, which the website runs
   too). This file is the UI and the state:

     Home        "Today's plan": what's on today, ticked off in place, and a
                 line for what spilled over.
     Plan page   Today, everything that spilled over and when it gets caught
                 up, the next seven days, the sheet's weeks, a health check
                 (revisit / stuck / partial / time), days off, CSV export.
     Item sheet  Status (Done / Partial / Stuck), Revisit, minutes with a
                 timer, notes, move to another day, and the Atlas topics that
                 teach it.
     Topic page  A chip when the topic belongs to a plan item; marking the
                 topic done offers to tick the item too.

   Each item's state is one record (kind "prep", id "prep:<item>") in the
   AtlasStore, so it syncs like everything else; the newest edit wins. The
   catch-up choice and days off are one more record, "prep:settings". */

(function () {
  'use strict';

  const Atlas = window.Atlas;
  const Store = window.AtlasStore;
  const C = window.AtlasPrepCore;
  const PLAN = window.ATLAS_PREP;
  if (!Atlas || !C || !PLAN) return;

  const esc = Atlas.esc;
  const icon = Atlas.icon;
  const view = document.getElementById('atlas-view');
  const ITEM = new Map(PLAN.items.map((it) => [it.id, it]));
  const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DAYS_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
  const TIMER_KEY = 'atlas.prepTimer';

  let states = {};
  let settings = { ...C.DEFAULT_SETTINGS };
  let loaded = false;
  let today = C.dayKey();
  let pinned = false; // tests pin the date

  /* ---------- formatting ---------- */

  const fmtMin = (m) => {
    m = Math.round(m);
    if (m < 60) return `${m} min`;
    return `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`;
  };
  const fmtDay = (day) => {
    const d = C.parseDay(day);
    return `${DAYS[d.getDay()]} ${d.getDate()} ${C.MONTHS[d.getMonth()]}`;
  };
  const fmtDayLong = (day) => {
    const d = C.parseDay(day);
    return `${DAYS_LONG[d.getDay()]} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
  };
  function relDay(day) {
    const n = C.diffDays(today, day);
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n > 1 && n < 7) return DAYS_LONG[C.weekday(day)];
    return fmtDay(day);
  }
  const lateText = (n) => (n === 1 ? '1 day late' : `${n} days late`);
  const weekRange = (w) => {
    const a = C.parseDay(w.from);
    const b = C.parseDay(w.to);
    return a.getMonth() === b.getMonth() ? `${a.getDate()}–${b.getDate()} ${C.MONTHS[b.getMonth()]}` : `${a.getDate()} ${C.MONTHS[a.getMonth()]} – ${b.getDate()} ${C.MONTHS[b.getMonth()]}`;
  };
  const typeLabel = (it) => (it.type === 'Milestone' ? 'Mock' : it.type);
  // "LC1603 Design Parking System (Easy)" from the sheet, else the problem's URL slug.
  const leetName = (it) => {
    if (/^LC\d+/.test(it.hint)) return it.hint;
    const slug = (it.link.match(/problems\/([\w-]+)/) || [])[1] || 'LeetCode';
    return slug.replace(/-/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  };

  /* ---------- state ---------- */

  async function load() {
    if (!Store) {
      loaded = true;
      return;
    }
    try {
      await Store.ready;
      const recs = await Store.byKind('prep');
      for (const r of recs) take(r);
    } catch {
      /* first paint without saved state */
    }
    loaded = true;
    refresh();
  }

  function take(r) {
    if (r.topic === 'settings') {
      settings = r.deleted ? { ...C.DEFAULT_SETTINGS } : { ...C.DEFAULT_SETTINGS, ...(r.data || {}) };
    } else if (ITEM.has(r.topic)) {
      if (r.deleted) delete states[r.topic];
      else states[r.topic] = r.data || { s: '' };
    }
  }

  const stateOf = (id) => C.stateOf(ITEM.get(id), states);

  function write(id, next) {
    states[id] = next;
    if (Store) Store.put({ id: `prep:${id}`, kind: 'prep', topic: id, data: next }).catch(() => {});
  }

  function setState(id, patch, { undo = '' } = {}) {
    const prev = stateOf(id);
    const next = { ...prev, ...patch, upd: Date.now() };
    if (next.s !== 'done') delete next.at;
    else if (!next.at) next.at = Date.now();
    if (next.s === 'done') delete next.mv;
    for (const k of Object.keys(next)) if (next[k] === undefined || next[k] === '' || next[k] === false) if (k !== 's') delete next[k];
    write(id, next);
    refresh();
    if (undo) {
      Atlas.toast(undo, {
        action: 'Undo',
        onAction: () => {
          write(id, { ...prev, upd: Date.now() });
          refresh();
        },
      });
    }
  }

  function saveSettings(patch) {
    settings = { ...settings, ...patch };
    if (Store) Store.put({ id: 'prep:settings', kind: 'prep', topic: 'settings', data: settings }).catch(() => {});
    refresh();
  }

  const sched = () => C.schedule(PLAN, states, today, settings);

  /* ---------- timer ---------- */

  function timer() {
    try {
      const t = JSON.parse(localStorage.getItem(TIMER_KEY));
      return t && ITEM.has(t.id) && t.start ? t : null;
    } catch {
      return null;
    }
  }
  function setTimer(t) {
    try {
      if (t) localStorage.setItem(TIMER_KEY, JSON.stringify(t));
      else localStorage.removeItem(TIMER_KEY);
    } catch {
      /* not kept */
    }
  }
  const clock = (ms) => {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const ss = String(s % 60).padStart(2, '0');
    return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`;
  };
  // Stops the timer and adds its minutes to the item; returns the minutes added.
  function stopTimer(save = true) {
    const t = timer();
    if (!t) return 0;
    setTimer(null);
    const mins = Math.max(1, Math.round((Date.now() - t.start) / 60000));
    if (save) {
      const st = stateOf(t.id);
      write(t.id, { ...st, min: (st.min || 0) + mins, upd: Date.now() });
    }
    return mins;
  }

  /* ---------- pieces ---------- */

  function trackChip(it) {
    return `<span class="pl-track ${it.track}">${esc(C.TRACK_LABEL[it.track])}</span>`;
  }

  function primaryHref(it) {
    const r = it.read[0];
    const t = r && Atlas.topic(r.slug);
    return t ? Atlas.topicHref(t, r.anchor) : '';
  }

  function row(e, { go = true, slot = false, compact = false } = {}) {
    const it = e.item;
    const st = e.state;
    const done = st.s === 'done';
    const t = timer();
    const flags = [];
    if (e.carried && !done) flags.push(`<span class="pl-flag late">${lateText(e.late)}</span>`);
    if (e.ahead) flags.push('<span class="pl-flag ahead">ahead of plan</span>');
    if (st.s === 'partial') flags.push('<span class="pl-flag partial">partial</span>');
    if (st.s === 'stuck') flags.push('<span class="pl-flag stuck">stuck</span>');
    if (st.rev) flags.push('<span class="pl-flag rev">revisit</span>');
    if (t && t.id === it.id) flags.push(`<span class="pl-flag timing" data-timer>${icon('clock', 12, 2)} ${clock(Date.now() - t.start)}</span>`);
    if (slot && e.slot && !done) flags.push(`<span class="pl-slot">${e.slot === today ? 'on today' : `→ ${esc(relDay(e.slot))}`}</span>`);
    const meta = [typeLabel(it), it.difficulty, fmtMin(it.minutes)].filter(Boolean).join(' · ');
    const href = go && !compact ? primaryHref(it) : '';
    return `<div class="pl-item${done ? ' done' : ''}${st.s === 'stuck' ? ' stuck' : ''}${compact ? ' compact' : ''}" data-item="${it.id}">
      <button type="button" class="pl-check" data-pl="toggle" aria-pressed="${done}" aria-label="${done ? 'Mark not done' : 'Mark done'}"><span>${icon('check', 14, 2.8)}</span></button>
      <button type="button" class="pl-body" data-pl="open">
        <span class="pl-title">${esc(it.title)}</span>
        <span class="pl-meta">${trackChip(it)}<span>${esc(meta)}</span>${flags.join('')}</span>
      </button>
      ${href ? `<a class="btn small pl-go" href="${href}">${it.type === 'Learn' ? 'Read' : 'Open'}</a>` : ''}
    </div>`;
  }

  function ringSvg(pct, size = 76) {
    const r = size / 2 - 7;
    const c = 2 * Math.PI * r;
    const p = Math.max(0, Math.min(1, pct));
    return `<svg class="tr-ring" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true">
      <circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="7"/>
      ${p > 0 ? `<circle class="fg${p >= 1 ? ' met' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="7" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - p)).toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}
    </svg>`;
  }

  function weekLine(s) {
    if (!s.started) return `Starts ${fmtDay(PLAN.start)}`;
    if (!s.week) return `Plan ended ${fmtDay(PLAN.end)}`;
    const focus = C.weekFocus(PLAN, s.week.n);
    return `Week ${s.week.n} of ${PLAN.weeks.length}${focus ? ` · ${esc(focus)}` : ''}`;
  }

  function catchupWord(key) {
    if (key === 'end') return `re-planned to ${fmtDay(PLAN.end)}`;
    if (key === 3) return '3 days';
    if (key === 7) return '1 week';
    if (key === 14) return '2 weeks';
    return `${key} days`;
  }

  function spillLine(s) {
    if (!s.spill.length) return '';
    const open = s.spill.filter((e) => !e.doneToday);
    if (!open.length) return '';
    const by = s.catchup.clearBy;
    return `${open.length} spilled over${by ? ` · ${s.catchup.chosen === 'end' ? 'spread to the end of the plan' : `catching up by ${esc(relDay(by) === 'today' ? 'tonight' : fmtDay(by))}`}` : ''}`;
  }

  /* ---------- Home card ---------- */

  function homeCard() {
    if (!loaded) return '';
    const s = sched();
    const list = s.todayList;
    const st = s.stats.today;
    const left = list.filter((e) => !e.doneToday);
    let body;
    if (s.finished) {
      body = `<p class="pl-empty">Every HLD and LLD item is done. Keep the reviews going on the Progress page.</p>`;
    } else if (!list.length) {
      body = `<p class="pl-empty">${s.started ? 'Nothing scheduled today.' : `The plan starts ${esc(fmtDayLong(PLAN.start))}.`}${s.nextUp ? ` Next up: <b>${esc(s.nextUp.item.title)}</b> (${esc(relDay(s.nextUp.slot))}).` : ''}</p>`;
    } else {
      const shown = list.slice(0, 6);
      body = `<div class="pl-list">${shown.map((e) => row(e)).join('')}</div>${
        list.length > shown.length ? `<a class="tr-more" href="#/plan">+ ${list.length - shown.length} more on the Plan page</a>` : ''
      }${!left.length ? `<p class="pl-done-line">${icon('check', 15, 2.4)} Today's list is done.${s.nextUp ? ` <button type="button" class="pl-link" data-pl="open" data-id="${s.nextUp.item.id}">Start on ${esc(s.nextUp.item.title)}?</button>` : ''}</p>` : ''}`;
    }
    const spill = spillLine(s);
    return `<section class="card pl-home">
      <div class="pl-home-head">
        <div class="pl-home-ring">${ringSvg(st.minutes ? st.doneMinutes / st.minutes : 0, 58)}<span>${st.done}/${st.items}</span></div>
        <div class="pl-home-text">
          <span class="eyebrow">Today's plan · ${esc(fmtDay(today))}</span>
          <b>${list.length ? `${left.length ? `${left.length} to go · about ${fmtMin(left.reduce((a, e) => a + e.item.minutes, 0))}` : 'All done for today'}` : s.started ? 'A free day' : 'Not started yet'}</b>
          <small>${weekLine(s)}</small>
        </div>
        <a class="btn small" href="#/plan">Plan ${icon('chevron', 14, 2)}</a>
      </div>
      ${body}
      ${spill ? `<a class="pl-spill" href="#/plan/spill">${icon('clock', 15, 2)} <span>${spill}</span>${icon('chevron', 14, 2)}</a>` : ''}
    </section>`;
  }

  /* ---------- Plan page ---------- */

  function summary(s) {
    const st = s.stats;
    const t = st.today;
    const tile = (big, small, extra = '', cls = '') => `<div class="card tr-stat ${cls}">${big}<span>${small}</span>${extra}</div>`;
    const bar = (done, total) => `<div class="bar-track"><div class="bar-fill" style="width:${total ? (done / total) * 100 : 0}%"></div></div>`;
    const oldest = s.spill.length ? Math.max(...s.spill.map((e) => e.late)) : 0;
    let finish;
    if (s.finished) finish = tile('<b>Done</b>', 'every item ticked');
    else if (st.forecast) finish = tile(`<b>${esc(fmtDay(st.forecast))}</b>`, `forecast at ${fmtMin(st.recentPace)} a day · plan ends ${esc(fmtDay(PLAN.end))}`);
    else finish = tile(`<b>${fmtMin(st.pace)}<small>/day</small></b>`, `to finish by ${esc(fmtDay(PLAN.end))}`);
    return `<div class="pl-summary">
      <div class="card tr-today">
        <div class="tr-ring-wrap">${ringSvg(t.minutes ? t.doneMinutes / t.minutes : 0)}<div class="tr-ring-label"><b>${t.done}</b><span>of ${t.items}</span></div></div>
        <div class="tr-today-text">
          <span class="eyebrow">Today</span>
          <b>${t.items ? (t.done >= t.items ? 'Today’s list is done' : `${fmtMin(t.minutes - t.doneMinutes)} left today`) : s.started ? 'Nothing due today' : 'Plan not started'}</b>
          <span>${weekLine(s)}</span>
        </div>
      </div>
      ${tile(`<b>${s.spill.length}</b>`, s.spill.length ? `spilled over · oldest ${lateText(oldest)}` : 'nothing spilled over')}
      ${finish}
      ${tile(`<b>${st.tracks.hld.done}<small>/${st.tracks.hld.total}</small></b>`, 'HLD done', bar(st.tracks.hld.done, st.tracks.hld.total), 'pl-track-tile')}
      ${tile(`<b>${st.tracks.lld.done}<small>/${st.tracks.lld.total}</small></b>`, 'LLD done', bar(st.tracks.lld.done, st.tracks.lld.total), 'pl-track-tile')}
    </div>`;
  }

  function todayBlock(s) {
    const list = s.todayList;
    let inner;
    if (!list.length) {
      inner = `<div class="card tr-pad"><p class="pl-empty">${s.finished ? 'Every item is done.' : s.started ? 'Nothing is scheduled today.' : `The plan starts ${esc(fmtDayLong(PLAN.start))}.`}</p>${
        s.nextUp ? `<button type="button" class="btn small" data-pl="open" data-id="${s.nextUp.item.id}">Get ahead: ${esc(s.nextUp.item.title)}</button>` : ''
      }</div>`;
    } else {
      const left = list.filter((e) => !e.doneToday);
      inner = `<div class="pl-list card">${list.map((e) => row(e)).join('')}</div>${
        !left.length && s.nextUp
          ? `<p class="pl-done-line">${icon('check', 15, 2.4)} Today's list is done. <button type="button" class="pl-link" data-pl="open" data-id="${s.nextUp.item.id}">Get ahead with ${esc(s.nextUp.item.title)}</button> (planned ${esc(relDay(s.nextUp.slot))}).</p>`
          : ''
      }`;
    }
    return `<section class="block" id="pl-today"><h2>Today · ${esc(fmtDayLong(today))}</h2>${inner}</section>`;
  }

  function spillBlock(s) {
    if (!s.spill.length) {
      return `<section class="block" id="pl-spill"><h2>Spilled over</h2><div class="card tr-pad"><p class="pl-empty">Nothing has spilled over — you're on the plan.</p></div></section>`;
    }
    const opts = s.catchup.options;
    const btn = (key, label, o) => {
      const on = String(s.catchup.key) === String(key);
      const lines = o
        ? `<small class="${o.peak > C.DAILY_LIMIT ? 'heavy' : ''}">up to ${fmtMin(o.peak)} a day</small><small>${key === 'end' ? `even pace to ${esc(fmtDay(PLAN.end))}` : o.clearBy ? `clear by ${esc(fmtDay(o.clearBy))}` : ''}</small>`
        : `<small>picks ${esc(catchupWord(s.catchup.chosen))}</small><small>days stay under ${fmtMin(C.DAILY_LIMIT)}</small>`;
      return `<button type="button" class="pl-opt${on ? ' on' : ''}" data-pl="catchup" data-v="${key}" aria-pressed="${on}"><b>${label}</b>${lines}</button>`;
    };
    const find = (k) => opts.find((o) => o.key === k);
    const groups = new Map();
    for (const e of s.spill) {
      const w = PLAN.weeks.find((x) => x.n === e.item.week);
      const key = w ? w.n : 0;
      if (!groups.has(key)) groups.set(key, { w, list: [] });
      groups.get(key).list.push(e);
    }
    const explain =
      s.catchup.chosen === 'end'
        ? `Everything left is laid out evenly, in plan order, from today to ${esc(fmtDayLong(PLAN.end))} — about ${fmtMin(s.stats.pace)} a day.`
        : `Spread over the next ${esc(catchupWord(s.catchup.chosen))} on top of what those days already hold — the heaviest day is ${fmtMin(s.catchup.peak)}. After ${esc(fmtDay(s.catchup.clearBy))} you're back on the sheet's plan.`;
    return `<section class="block" id="pl-spill"><h2>Spilled over · ${s.spill.length}</h2>
      <div class="card tr-pad pl-catchup">
        <div class="pl-catchup-head"><b>Catch up over</b><span>${explain}</span></div>
        <div class="pl-options">${btn('auto', 'Auto')}${btn(3, '3 days', find(3))}${btn(7, '1 week', find(7))}${btn(14, '2 weeks', find(14))}${find('end') ? btn('end', 'Re-plan', find('end')) : ''}</div>
      </div>
      ${[...groups.values()]
        .map(({ w, list }) => `<div class="pl-group"><div class="pl-group-head">${w ? `Week ${w.n} · ${esc(weekRange(w))}` : 'Moved'}<span>${list.length}</span></div><div class="pl-list card">${list.map((e) => row(e, { slot: true })).join('')}</div></div>`)
        .join('')}
    </section>`;
  }

  function comingBlock(s) {
    const days = s.days.slice(1, 7);
    return `<section class="block"><h2>Coming up</h2><div class="pl-days">${days
      .map((d) => {
        const head = `<div class="pl-day-head"><b>${esc(relDay(d.date) === 'tomorrow' ? 'Tomorrow' : fmtDay(d.date))}</b><span>${d.off ? 'day off' : d.entries.length ? `${d.entries.length} · ${fmtMin(d.minutes)}` : 'free'}</span></div>`;
        const list = d.entries.length ? `<div class="pl-list">${d.entries.map((e) => row(e, { compact: true })).join('')}</div>` : `<p class="pl-empty">${d.off ? 'Rest.' : 'Nothing planned.'}</p>`;
        return `<div class="card pl-day${d.off ? ' off' : ''}">${head}${list}</div>`;
      })
      .join('')}</div></section>`;
  }

  function weeksBlock(s) {
    const cur = s.week ? s.week.n : 0;
    return `<section class="block"><h2>The sheet's weeks</h2><div class="list pl-weeks">${s.stats.weeks
      .map((w) => {
        const pct = w.due ? w.done / w.due : 0;
        const past = w.to < today;
        const cls = w.n === cur ? ' current' : past && w.done < w.due ? ' behind' : w.due && w.done === w.due ? ' complete' : '';
        return `<div class="pl-week${cls}">
          <span class="pl-week-n">${w.n}</span>
          <span class="pl-week-text"><b>${esc(weekRange(w))}${w.n === cur ? ' · this week' : ''}</b><small>${esc(C.weekFocus(PLAN, w.n))}</small></span>
          <span class="pl-week-bar"><span class="bar-track"><span class="bar-fill" style="width:${pct * 100}%"></span></span></span>
          <span class="pl-week-count">${w.done}/${w.due}</span>
        </div>`;
      })
      .join('')}</div></section>`;
  }

  function healthBlock(s) {
    const st = s.stats;
    const list = (arr, empty) => (arr.length ? `<div class="pl-list">${arr.map((e) => row(e, { compact: true })).join('')}</div>` : `<p class="pl-empty">${empty}</p>`);
    const timed = PLAN.items.filter((it) => stateOf(it.id).min);
    const est = timed.reduce((a, it) => a + it.minutes, 0);
    const act = timed.reduce((a, it) => a + (stateOf(it.id).min || 0), 0);
    return `<section class="block"><h2>Health check</h2><div class="tr-grid">
      <div class="card tr-tile"><span class="eyebrow">Revisit queue · ${st.revisit.length}</span>${list(st.revisit, 'Tick Revisit on any item you didn’t nail and it lands here.')}</div>
      <div class="card tr-tile"><span class="eyebrow">Stuck · ${st.stuck.length}</span>${list(st.stuck, 'Nothing stuck.')}</div>
      <div class="card tr-tile"><span class="eyebrow">Partial · ${st.partial.length}</span>${list(st.partial, 'Nothing half-done.')}</div>
      <div class="card tr-tile"><span class="eyebrow">Time logged</span>${
        timed.length
          ? `<b>${fmtMin(act)}</b><p class="pl-empty">on ${timed.length} item${timed.length > 1 ? 's' : ''} — ${act > est * 1.15 ? `${Math.round((act / est - 1) * 100)}% over` : act < est * 0.85 ? `${Math.round((1 - act / est) * 100)}% under` : 'right on'} the plan's estimate of ${fmtMin(est)}.</p>`
          : '<p class="pl-empty">Use the timer in an item’s sheet, or type the minutes, to see how your pace compares with the estimates.</p>'
      }</div>
    </div></section>`;
  }

  function settingsBlock() {
    const off = settings.off || [];
    return `<section class="block"><h2>Plan settings</h2><div class="list">
      <div class="set-row stack"><div><b>Days off</b><small>Nothing is scheduled on these days; their items move to the other days of the week.</small></div>
        <div class="seg full">${[1, 2, 3, 4, 5, 6, 0]
          .map((d) => `<button type="button" class="${off.includes(d) ? 'on' : ''}" data-pl="off" data-v="${d}" aria-pressed="${off.includes(d)}">${DAYS[d]}</button>`)
          .join('')}</div></div>
      <div class="set-row"><div><b>Back to the spreadsheet</b><small>Your status, dates, revisit flags, minutes and notes in the tracker's own columns, one row per item.</small></div>
        <div class="pl-row-btns"><button type="button" class="btn small" data-pl="copy">Copy</button><button type="button" class="btn small" data-pl="csv">${icon('download', 15)} CSV</button></div></div>
      <div class="set-row"><div><b>Where this comes from</b><small>The HLD and LLD tabs of ${esc(PLAN.source)} (and its HLD mocks), weeks ${esc(weekRange(PLAN.weeks[0]))} to ${esc(weekRange(PLAN.weeks[PLAN.weeks.length - 1]))}. Every item's reading is in Atlas, offline; only LeetCode practice links leave the app.</small></div></div>
    </div></section>`;
  }

  function planPage() {
    if (!loaded) return '<p class="pl-empty">Loading your plan…</p>';
    const s = sched();
    return `${summary(s)}${todayBlock(s)}${spillBlock(s)}${comingBlock(s)}${weeksBlock(s)}${healthBlock(s)}${settingsBlock()}`;
  }

  /* ---------- item sheet ---------- */

  let sheet = null;
  let sheetId = '';
  let tickTimer = 0;

  function entryFor(id) {
    const s = sched();
    for (const e of [...s.spill, ...s.days.flatMap((d) => d.entries)]) if (e.item.id === id) return { e, s };
    return { e: null, s };
  }

  function sheetHtml(id) {
    const it = ITEM.get(id);
    const st = stateOf(id);
    const { e } = entryFor(id);
    const done = st.s === 'done';
    const t = timer();
    const timing = t && t.id === id;
    let when;
    if (done) when = `Done ${st.at ? esc(fmtDayLong(C.dayKey(new Date(st.at)))) : ''}`;
    else if (e && e.carried) when = `Due ${esc(fmtDay(e.due))} · <b class="late">${lateText(e.late)}</b> · ${e.slot === today ? 'caught up today' : `caught up ${esc(relDay(e.slot))}`}`;
    else if (e) when = `${e.slot === today ? 'On today' : `Planned for ${esc(fmtDayLong(e.slot))}`}${st.mv ? ' (moved)' : ''}`;
    else when = st.mv ? `Moved to ${esc(fmtDayLong(st.mv))}` : `Week ${it.week}`;
    const w = PLAN.weeks.find((x) => x.n === it.week);
    const reads = it.read
      .map((r) => {
        const tp = Atlas.topic(r.slug);
        if (!tp) return '';
        const sec = Atlas.section(tp.section);
        const pct = Atlas.isDone(tp.slug) ? 1 : window.AtlasTrack ? window.AtlasTrack.percent(tp.slug) : 0;
        const heading = r.anchor ? r.anchor.replace(/-/g, ' ') : '';
        return `<a class="pl-read" href="${Atlas.topicHref(tp, r.anchor)}" style="--a:${sec ? sec.accent : 'var(--accent)'}">
          <span class="pl-read-ico">${icon(sec ? sec.icon : 'book', 18)}</span>
          <span class="pl-read-text"><b>${esc(tp.title)}</b><small>${esc(sec ? sec.title : '')}${heading ? ` · from “${esc(heading)}”` : ''} · ${tp.minutes} min${Atlas.isDone(tp.slug) ? ' · read' : pct > 0.05 ? ` · ${Math.round(pct * 100)}% read` : ''}</small></span>
          ${icon('chevron', 16, 2)}
        </a>`;
      })
      .join('');
    const status = [
      ['', 'Not started'],
      ['partial', 'Partial'],
      ['stuck', 'Stuck'],
      ['done', 'Done'],
    ];
    const tomorrow = C.nextStudyDay(today, settings.off || []);
    return `<div class="pl-sheet-card" role="dialog" aria-modal="true" aria-labelledby="pl-sheet-title">
      <div class="pl-sheet-top">
        <div class="pl-sheet-tags">${trackChip(it)}<span>${esc([typeLabel(it), it.difficulty, `about ${fmtMin(it.minutes)}`].filter(Boolean).join(' · '))}</span></div>
        <button type="button" class="btn small" data-pl="close">Done</button>
      </div>
      <h2 id="pl-sheet-title">${esc(it.title)}</h2>
      <p class="pl-when">${when}${w ? ` · sheet week ${w.n} (${esc(weekRange(w))}) · ${esc(it.topic)}` : ''}</p>
      ${it.hint ? `<p class="pl-hint">${esc(it.hint)}</p>` : ''}

      <div class="pl-sec"><span class="eyebrow">Status</span>
        <div class="seg full">${status.map(([v, l]) => `<button type="button" class="${st.s === v ? 'on' : ''}" data-pl="status" data-v="${v}" aria-pressed="${st.s === v}">${l}</button>`).join('')}</div>
        <label class="pl-toggle"><input type="checkbox" data-pl="rev" ${st.rev ? 'checked' : ''}> <span>Revisit — come back to this one</span></label>
      </div>

      ${reads ? `<div class="pl-sec"><span class="eyebrow">Read in Atlas · offline</span><div class="pl-reads">${reads}</div></div>` : ''}
      ${it.link ? `<div class="pl-sec"><span class="eyebrow">Practise on LeetCode</span><a class="pl-ext" href="${esc(it.link)}" target="_blank" rel="noopener">${esc(leetName(it))} ↗</a><small class="pl-ext-note">The one link that leaves Atlas — it opens LeetCode in Safari and needs a connection.</small></div>` : ''}

      <div class="pl-sec"><span class="eyebrow">Time</span>
        <div class="pl-time">
          <button type="button" class="btn small${timing ? ' primary' : ''}" data-pl="timer">${icon('clock', 15, 2)} ${timing ? `Stop <span data-timer>${clock(Date.now() - t.start)}</span>` : t ? 'Switch timer here' : 'Start timer'}</button>
          <label class="pl-min"><input type="number" inputmode="numeric" min="0" max="999" value="${st.min || ''}" placeholder="0" data-pl="min"> min</label>
        </div>
      </div>

      <div class="pl-sec"><span class="eyebrow">Notes</span>
        <textarea rows="3" data-pl="note" placeholder="What tripped you up, what to remember">${esc(st.note || '')}</textarea>
      </div>

      ${
        done
          ? ''
          : `<div class="pl-sec"><span class="eyebrow">Move</span><div class="pl-move">
        <button type="button" class="btn small" data-pl="move" data-v="${tomorrow}">${C.diffDays(today, tomorrow) === 1 ? 'Tomorrow' : esc(fmtDay(tomorrow))}</button>
        <label class="btn small pl-date">${icon('calendar', 15)} Pick a day<input type="date" data-pl="moveto" min="${today}" value="${st.mv || ''}"></label>
        ${st.mv ? '<button type="button" class="btn small" data-pl="move" data-v="">Back to its plan day</button>' : ''}
      </div></div>`
      }
    </div>`;
  }

  function openSheet(id) {
    if (!ITEM.has(id)) return;
    sheetId = id;
    if (!sheet) {
      sheet = document.createElement('div');
      sheet.id = 'atlas-plan-sheet';
      sheet.className = 'pl-sheet';
      sheet.setAttribute('data-atlas-ui', '');
      document.body.appendChild(sheet);
      sheet.addEventListener('click', onSheetClick);
      sheet.addEventListener('change', onSheetChange);
      sheet.addEventListener('input', onSheetInput);
    }
    sheet.innerHTML = sheetHtml(id);
    sheet.hidden = false;
    document.documentElement.classList.add('pl-sheet-open');
    requestAnimationFrame(() => sheet.classList.add('show'));
    startTick();
  }

  function closeSheet() {
    if (!sheet || sheet.hidden) return;
    flushNote();
    sheet.classList.remove('show');
    sheet.hidden = true;
    sheetId = '';
    document.documentElement.classList.remove('pl-sheet-open');
    // Opened from search (#/plan/i/<id>): closing it shouldn't leave a URL that reopens it.
    if (/^#\/plan\/i\//.test(location.hash)) history.replaceState(history.state, '', '#/plan');
  }

  function repaintSheet() {
    if (!sheet || sheet.hidden || !sheetId) return;
    flushNote(); // a note still being typed is saved before the sheet is redrawn
    const scroll = sheet.querySelector('.pl-sheet-card') ? sheet.querySelector('.pl-sheet-card').scrollTop : 0;
    sheet.innerHTML = sheetHtml(sheetId);
    const card = sheet.querySelector('.pl-sheet-card');
    if (card) card.scrollTop = scroll;
  }

  let noteTimer = 0;
  function flushNote() {
    clearTimeout(noteTimer);
    if (!sheet || !sheetId) return;
    const area = sheet.querySelector('[data-pl="note"]');
    if (!area) return;
    const st = stateOf(sheetId);
    if ((st.note || '') === area.value) return;
    write(sheetId, { ...st, note: area.value, upd: Date.now() });
  }

  function onSheetClick(e) {
    if (e.target === sheet) return closeSheet();
    flushNote();
    const b = e.target.closest('[data-pl]');
    if (!b) {
      if (e.target.closest('a.pl-read')) closeSheet();
      return;
    }
    const act = b.dataset.pl;
    const id = sheetId;
    if (act === 'close') closeSheet();
    else if (act === 'status') {
      const v = b.dataset.v;
      if (v === 'done') {
        const t = timer();
        if (t && t.id === id) stopTimer();
      }
      setState(id, { s: v });
      repaintSheet();
    } else if (act === 'timer') {
      const t = timer();
      if (t && t.id === id) {
        const m = stopTimer();
        Atlas.toast(`${m} min added.`);
      } else {
        if (t) stopTimer();
        setTimer({ id, start: Date.now() });
      }
      refresh();
      repaintSheet();
    } else if (act === 'move') {
      setState(id, { mv: b.dataset.v || undefined }, { undo: b.dataset.v ? `Moved to ${relDay(b.dataset.v)}.` : 'Back on its plan day.' });
      repaintSheet();
    }
  }

  function onSheetChange(e) {
    const el = e.target;
    const id = sheetId;
    if (!id) return;
    if (el.dataset.pl !== 'note') flushNote();
    if (el.dataset.pl === 'rev') {
      setState(id, { rev: el.checked });
    } else if (el.dataset.pl === 'min') {
      const v = Math.max(0, Math.min(999, Math.round(Number(el.value) || 0)));
      setState(id, { min: v || undefined });
    } else if (el.dataset.pl === 'moveto' && el.value) {
      const v = el.value < today ? today : el.value;
      setState(id, { mv: v }, { undo: `Moved to ${relDay(v)}.` });
      repaintSheet();
    }
  }

  function onSheetInput(e) {
    if (e.target.dataset.pl !== 'note') return;
    clearTimeout(noteTimer);
    noteTimer = setTimeout(flushNote, 600);
  }

  function startTick() {
    clearInterval(tickTimer);
    tickTimer = setInterval(() => {
      const t = timer();
      if (!t) return;
      for (const el of document.querySelectorAll('[data-timer]')) {
        const owner = el.closest('[data-item]');
        if (!owner || owner.dataset.item === t.id || el.closest('.pl-sheet')) el.lastChild.nodeValue = ` ${clock(Date.now() - t.start)}`;
      }
    }, 1000);
  }

  /* ---------- topic page ---------- */

  function chipFor(topic) {
    if (!loaded) return '';
    const items = PLAN.items.filter((it) => it.read.some((r) => r.slug === topic.slug));
    if (!items.length) return '';
    const s = sched();
    const where = new Map([...s.spill, ...s.days.flatMap((d) => d.entries)].map((e) => [e.item.id, e]));
    // The most pressing first: open before done, then by when it's due.
    const ranked = items
      .map((it) => ({ it, st: stateOf(it.id), e: where.get(it.id) }))
      .sort((a, b) => Number(a.st.s === 'done') - Number(b.st.s === 'done') || (a.e ? a.e.slot : '9') .localeCompare(b.e ? b.e.slot : '9'))
      .slice(0, 2);
    return ranked
      .map(({ it, st, e }) => {
        const done = st.s === 'done';
        let when = '';
        if (done) when = st.at ? `ticked off ${relDay(C.dayKey(new Date(st.at)))}` : 'ticked off';
        else if (e && e.carried) when = `${lateText(e.late)} · on ${relDay(e.slot)}`;
        else if (e) when = e.slot === today ? 'on today' : `planned ${relDay(e.slot)}`;
        else when = `sheet week ${it.week}`;
        return `<div class="pl-chip${done ? ' done' : ''}" data-item="${it.id}">
          <span class="pl-chip-ico">${icon(done ? 'check' : 'calendar', 17, 2)}</span>
          <button type="button" class="pl-chip-text" data-pl="open"><b>${done ? 'On your plan — done' : 'On your plan'}</b><span>${trackChip(it)} ${esc(it.title)} · ${esc(when)}</span></button>
          ${done ? '' : '<button type="button" class="btn small" data-pl="toggle">Tick off</button>'}
        </div>`;
      })
      .join('');
  }

  /* ---------- painting ---------- */

  function paintSlots() {
    const home = view.querySelector('[data-slot="home-plan"]');
    if (home) home.innerHTML = homeCard();
    const page = view.querySelector('[data-slot="plan"]');
    if (page) page.innerHTML = planPage();
    const chip = view.querySelector('[data-slot="plan-chip"]');
    const t = Atlas.currentTopic();
    if (chip && t) chip.innerHTML = chipFor(t);
    paintBadge();
  }

  function paintBadge() {
    const el = document.getElementById('atlas-plan-count');
    if (!el || !loaded) return;
    const s = sched();
    const left = s.todayList.filter((e) => !e.doneToday).length;
    el.hidden = !left;
    el.textContent = left ? String(left) : '';
  }

  function refresh() {
    paintSlots();
    repaintSheet();
  }

  Atlas.on('render', ({ route }) => {
    if (!pinned) today = C.dayKey();
    paintSlots();
    if (route && route.name === 'plan') {
      if (route.sub === 'spill') {
        const el = document.getElementById('pl-spill');
        if (el) window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - 70);
      } else if (route.sub === 'i' && route.id) openSheet(route.id);
    }
  });
  Atlas.on('leave', closeSheet);
  Atlas.on('close', () => {
    if (sheet && !sheet.hidden) closeSheet();
  });

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pl]');
    if (!b || !view.contains(b)) return;
    const act = b.dataset.pl;
    const holder = b.closest('[data-item]');
    const id = b.dataset.id || (holder && holder.dataset.item);
    if (act === 'toggle' && id) {
      const st = stateOf(id);
      if (st.s === 'done') setState(id, { s: '' }, { undo: 'Marked not done.' });
      else {
        const t = timer();
        if (t && t.id === id) stopTimer();
        setState(id, { s: 'done' });
        const s = sched();
        const left = s.todayList.filter((x) => !x.doneToday).length;
        const prev = { ...st };
        Atlas.toast(left ? `Ticked off · ${left} left today.` : 'Ticked off · today’s list is done!', {
          action: 'Undo',
          onAction: () => {
            write(id, { ...prev, upd: Date.now() });
            refresh();
          },
        });
      }
    } else if (act === 'open' && id) openSheet(id);
    else if (act === 'catchup') {
      const v = b.dataset.v;
      saveSettings({ catchup: v === 'auto' || v === 'end' ? v : Number(v) });
    } else if (act === 'off') {
      const d = Number(b.dataset.v);
      const off = new Set(settings.off || []);
      if (off.has(d)) off.delete(d);
      else off.add(d);
      if (off.size >= 7) return Atlas.toast('Keep at least one study day.');
      saveSettings({ off: [...off].sort() });
    } else if (act === 'csv') exportCsv();
    else if (act === 'copy') copyCsv();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && sheet && !sheet.hidden) closeSheet();
  });

  // Marking a topic done offers to tick the plan item it teaches.
  Atlas.on('state', ({ kind, slug, data, deleted }) => {
    if (kind !== 'done' || deleted || !data || !data.done || !loaded) return;
    const it = PLAN.items.find((x) => x.type === 'Learn' && x.read[0] && x.read[0].slug === slug && stateOf(x.id).s !== 'done');
    if (!it) return;
    setTimeout(() => {
      Atlas.toast(`Tick “${it.title}” off your plan too?`, {
        action: 'Tick',
        ms: 6000,
        onAction: () => setState(it.id, { s: 'done' }, { undo: 'Ticked off your plan.' }),
      });
    }, 400);
  });

  /* ---------- sync, day change ---------- */

  if (Store) {
    Store.subscribe((records, origin) => {
      if (origin !== 'remote') return;
      let hit = false;
      for (const r of records) {
        if (r.kind !== 'prep') continue;
        take(r);
        hit = true;
      }
      if (hit) refresh();
    });
  }

  // The plan is about today, so a page left open overnight moves on with the date.
  function checkDay() {
    const now = C.dayKey();
    if (pinned || now === today) return;
    today = now;
    refresh();
  }
  setInterval(checkDay, 60000);
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && checkDay());

  /* ---------- export, import, reset, search ---------- */

  function exportCsv() {
    const csv = C.toCsv(PLAN, states);
    const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
    const a = document.createElement('a');
    a.href = url;
    a.download = `switch-prep-hld-lld-${today}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 4000);
  }

  async function copyCsv() {
    try {
      await navigator.clipboard.writeText(C.toCsv(PLAN, states));
      Atlas.toast('Copied — paste it into the sheet.');
    } catch {
      Atlas.toast('Copying isn’t allowed here; use CSV.');
    }
  }

  Atlas.exporters.push(async () => ({ plan: { states, settings } }));
  Atlas.importers.push(async (d) => {
    const p = d && d.plan;
    if (!p || typeof p !== 'object') return;
    const recs = [];
    for (const [id, st] of Object.entries(p.states || {})) if (ITEM.has(id) && st) recs.push({ id: `prep:${id}`, kind: 'prep', topic: id, data: st });
    if (p.settings) recs.push({ id: 'prep:settings', kind: 'prep', topic: 'settings', data: p.settings });
    for (const r of recs) take(r);
    if (Store && recs.length) await Store.put(recs).catch(() => {});
    refresh();
  });
  Atlas.on('reset', () => {
    const ids = Object.keys(states);
    states = {};
    setTimer(null);
    // A reset item falls back to what the sheet said, so mark it explicitly
    // not started rather than deleting it.
    const recs = PLAN.items.filter((it) => ids.includes(it.id) || it.seed).map((it) => ({ id: `prep:${it.id}`, kind: 'prep', topic: it.id, data: { s: '', upd: Date.now() } }));
    for (const r of recs) states[r.topic] = r.data;
    if (Store && recs.length) Store.put(recs).catch(() => {});
  });

  Atlas.searchProviders.push((q, tokens) => {
    if (!tokens || !tokens.length) return [];
    const out = [];
    for (const it of PLAN.items) {
      const hay = `${it.title} ${it.topic} ${C.TRACK_LABEL[it.track]}`.toLowerCase();
      if (!tokens.every((t) => hay.includes(t))) continue;
      const st = stateOf(it.id);
      out.push({
        href: `#/plan/i/${it.id}`,
        title: it.title,
        kicker: `Plan · ${C.TRACK_LABEL[it.track]} · week ${it.week}${st.s ? ` · ${st.s}` : ''}`,
        accent: it.track === 'lld' ? '#a78bfa' : it.track === 'mile' ? '#f59e0b' : '#38bdf8',
        snippet: [typeLabel(it), it.difficulty, it.topic].filter(Boolean).join(' · '),
      });
      if (out.length >= 6) break;
    }
    return out;
  });

  window.AtlasPlan = {
    schedule: sched,
    state: stateOf,
    open: openSheet,
    close: closeSheet,
    // for tests: pretend it's another day
    setToday: (d) => {
      pinned = !!d;
      today = d || C.dayKey();
      refresh();
    },
  };

  load();
})();
