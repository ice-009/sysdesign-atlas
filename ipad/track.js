/* Reading tracker for the iPad edition.

   What it keeps, all on the device first and synced when signed in:

     Sections read   A section counts once it has sat at the reading line for
                     long enough to have been read (scaled to its length, 6–20 s
                     of active time). Progress is words in read sections over
                     words in the topic — a flick to the bottom isn't reading.
     Time            app.js counts active seconds per day; here they are merged
                     with other devices' counts (each device owns its own count
                     per day and the totals are added, so nothing is lost or
                     double-counted).
     Review          Rating a topic schedules it: Shaky 1 day, Okay 4, Solid 10,
                     doubling after each good review up to 60; Shaky resets.
     Goals           A track and a date → minutes a day needed, on-track check.
     Sessions        Each topic visit: time, sections read, marks made.

   It fills the Home tiles, the Progress page, the review recap above a due
   topic, the review line in the end-of-topic card and Settings → Study.

   Exposes window.AtlasTrack (read by app.js for progress rings and the like). */

(function () {
  'use strict';

  const Atlas = window.Atlas;
  const Store = window.AtlasStore;
  if (!Atlas) return;

  const esc = Atlas.esc;
  const icon = Atlas.icon;
  const view = document.getElementById('atlas-view');
  const DAY = 864e5;
  const KEY = 'atlas.';
  const TRACK_KINDS = new Set(['sec', 'time', 'review', 'goal']);

  /* ---------- storage ---------- */

  function load(k, fallback) {
    try {
      const v = JSON.parse(localStorage.getItem(KEY + k));
      return v == null ? fallback : v;
    } catch {
      return fallback;
    }
  }
  function save(k) {
    try {
      localStorage.setItem(KEY + k, JSON.stringify(D[k]));
    } catch {
      /* not persisted this session */
    }
  }

  const D = {
    secs: load('secs', {}), //        slug → { sectionId: readAt }
    sectime: load('sectime', {}), //  slug → { sectionId: active seconds }
    secmeta: load('secmeta', {}), //  slug → { total: words, s: { sectionId: words } }
    review: load('review', {}), //    slug → { due, iv, n, last }
    goal: load('goal', null), //      { section, date: 'YYYY-MM-DD' }
    study: { goal: 30, rest: true, ...load('study', {}) },
    sessions: load('sessions', []), // newest first
    rtime: load('rtime', {}), //      day → { device: seconds } from other devices
  };

  let device = '';
  if (Store) Store.getMeta('device', '').then((d) => (device = d || '')).catch(() => {});

  /* ---------- dates and numbers ---------- */

  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const todayKey = () => dayKey(new Date());
  const startOfDay = (ts) => {
    const d = new Date(ts);
    d.setHours(0, 0, 0, 0);
    return d.getTime();
  };
  const endOfToday = () => startOfDay(Date.now()) + DAY - 1;
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const fmtMin = (m) => {
    m = Math.round(m);
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    return `${h}h${m % 60 ? ` ${m % 60}m` : ''}`;
  };
  const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
  function lastDays(n) {
    const out = [];
    const d = new Date();
    for (let i = n - 1; i >= 0; i--) {
      const x = new Date(d);
      x.setDate(d.getDate() - i);
      out.push(dayKey(x));
    }
    return out;
  }
  function relDay(ts) {
    const days = Math.round((startOfDay(ts) - startOfDay(Date.now())) / DAY);
    if (days < -1) return `${-days} days overdue`;
    if (days === -1) return 'overdue since yesterday';
    if (days === 0) return 'today';
    if (days === 1) return 'tomorrow';
    return `in ${days} days`;
  }
  function hashStr(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
  }

  /* ---------- time ---------- */

  // A day's reading across all devices: this device's count plus the others'.
  function daySeconds(key) {
    let s = (Atlas.days() || {})[key] || 0;
    const others = D.rtime[key];
    if (others) for (const [dev, v] of Object.entries(others)) if (dev !== device) s += v || 0;
    return s;
  }
  const dayMinutes = (key) => daySeconds(key) / 60;
  function totalMinutes() {
    const keys = new Set([...Object.keys(Atlas.days() || {}), ...Object.keys(D.rtime)]);
    let s = 0;
    for (const k of keys) s += daySeconds(k);
    return s / 60;
  }

  /* A streak counts days with at least two minutes of reading. With rest days
     on, one missed day a week is forgiven, as long as the day before it was a
     reading day — so a travel day doesn't wipe out a month. */
  function streak() {
    const studied = (d) => daySeconds(dayKey(d)) >= 120;
    const d = new Date();
    if (!studied(d)) d.setDate(d.getDate() - 1);
    let n = 0;
    let lastRest = -99;
    let rested = false;
    for (let i = 0; i < 3650; i++) {
      if (studied(d)) n++;
      else {
        const before = new Date(d);
        before.setDate(d.getDate() - 1);
        if (D.study.rest && n > 0 && i - lastRest >= 7 && studied(before)) {
          lastRest = i;
          rested = true;
        } else break;
      }
      d.setDate(d.getDate() - 1);
    }
    return { n, rested };
  }

  /* ---------- sections and progress ---------- */

  const countWords = (s) => (s.match(/\S+/g) || []).length;

  function computeSections(prose) {
    const kids = Array.from(prose.children).filter((el) => !el.hasAttribute('data-atlas-ui'));
    const out = [];
    let cur = { id: '_intro', title: 'Introduction', els: [], words: 0 };
    let n = 0;
    for (const el of kids) {
      if (el.tagName === 'H2') {
        if (cur.els.length) out.push(cur);
        n++;
        cur = { id: el.id || `section-${n}`, title: el.textContent.replace(/^#\s*/, '').trim(), els: [el], words: 0 };
        continue;
      }
      cur.els.push(el);
      cur.words += countWords(el.textContent);
    }
    if (cur.els.length) out.push(cur);
    return out.filter((s) => s.words >= 8);
  }

  let wpmCache = { at: 0, v: 220 };
  function wpm() {
    if (Date.now() - wpmCache.at < 60000) return wpmCache.v;
    let words = 0;
    let secs = 0;
    for (const [slug, read] of Object.entries(D.secs)) {
      const meta = D.secmeta[slug];
      const st = D.sectime[slug] || {};
      if (!meta) continue;
      for (const id of Object.keys(read)) {
        if (meta.s[id] && st[id]) {
          words += meta.s[id];
          secs += st[id];
        }
      }
    }
    const v = secs < 600 ? 220 : clamp(Math.round(words / (secs / 60)), 120, 450);
    wpmCache = { at: Date.now(), v };
    return v;
  }

  function percent(slug) {
    const meta = D.secmeta[slug];
    if (meta && meta.total) {
      const read = D.secs[slug] || {};
      let w = 0;
      for (const id of Object.keys(read)) w += meta.s[id] || 0;
      return Math.min(1, w / meta.total);
    }
    return Math.min(0.99, Atlas.posFraction(slug));
  }

  function minutesLeft(t) {
    const meta = D.secmeta[t.slug];
    if (meta && meta.total) return Math.max(1, Math.round((meta.total * (1 - percent(t.slug))) / wpm()));
    return Math.max(1, Math.round(t.minutes * (1 - Atlas.posFraction(t.slug))));
  }

  const isRead = (slug, id) => !!(D.secs[slug] && D.secs[slug][id]);
  const sectionsRead = (slug) => new Set(Object.keys(D.secs[slug] || {}));
  // Enough active seconds to have read a section: a third of its reading time,
  // between 6 and 20 seconds.
  const threshold = (words) => clamp(((words / wpm()) * 60) / 3, 6, 20);

  function putRecord(rec) {
    if (Store) Store.put(rec).catch(() => {});
  }

  function markRead(slug, id, { sync = true } = {}) {
    const read = (D.secs[slug] = D.secs[slug] || {});
    if (read[id]) return;
    read[id] = Date.now();
    save('secs');
    if (visit && visit.slug === slug) visit.read.add(id);
    if (sync) putRecord({ id: `sec:${slug}:${id}`, kind: 'sec', topic: slug, data: { id } });
    Atlas.refreshMarks();
  }

  /* Progress made before section tracking existed: the sections above the
     saved reading position count as read, so nobody's 45% turns into 0%. */
  function carryOver(slug, sections, meta) {
    const p = Atlas.posFraction(slug);
    if (p < 0.05 || (D.secs[slug] && Object.keys(D.secs[slug]).length)) return;
    let w = 0;
    for (const s of sections) {
      w += s.words;
      if (w / meta.total <= p + 0.02) markRead(slug, s.id);
    }
  }

  /* ---------- the topic on screen ---------- */

  let visit = null;
  let lastActive = Date.now();
  let ticks = 0;
  let sectimeDirty = false;
  for (const ev of ['scroll', 'touchstart', 'pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(ev, () => (lastActive = Date.now()), { passive: true, capture: true });
  }

  Atlas.on('leave', endVisit);
  Atlas.on('render', ({ route, topic }) => {
    if (topic) beginVisit(topic);
    paintSlots(route);
    Atlas.refreshMarks();
  });

  function beginVisit(topic) {
    endVisit();
    const prose = view.querySelector('.prose');
    if (!prose) return;
    const sections = computeSections(prose);
    const meta = { total: sections.reduce((a, s) => a + s.words, 0), s: Object.fromEntries(sections.map((s) => [s.id, s.words])) };
    const first = !D.secmeta[topic.slug];
    D.secmeta[topic.slug] = meta;
    save('secmeta');
    if (first && meta.total) carryOver(topic.slug, sections, meta);
    visit = { slug: topic.slug, t: topic, sections, secs: 0, read: new Set(), start: Date.now(), marks: new Set(), hl: 0, sc: 0, prompted: false };
    paintRecap(topic);
  }

  function endVisit() {
    if (!visit) return;
    const v = visit;
    visit = null;
    reviewing = null;
    flushSectime();
    if (v.secs >= 30) {
      D.sessions.unshift({ slug: v.slug, start: v.start, secs: v.secs, read: v.read.size, hl: v.hl, sc: v.sc });
      D.sessions = D.sessions.slice(0, 100);
      save('sessions');
    }
    if (v.secs >= 120) {
      const bits = [`${fmtMin(v.secs / 60)} on ${v.t.title}`];
      if (v.read.size) bits.push(`${plural(v.read.size, 'section')} read`);
      if (v.hl) bits.push(plural(v.hl, 'highlight'));
      if (v.sc) bits.push(`${plural(v.sc, 'stroke')} of scribbles`);
      Atlas.toast(bits.join(' · '), { ms: 5000 });
    }
  }

  function flushSectime() {
    if (!sectimeDirty) return;
    sectimeDirty = false;
    save('sectime');
  }

  function sectionAtLine() {
    const line = window.innerHeight * 0.4;
    for (const s of visit.sections) {
      const first = s.els[0];
      const last = s.els[s.els.length - 1];
      if (!first.isConnected) return null;
      if (line >= first.getBoundingClientRect().top && line <= last.getBoundingClientRect().bottom) return s;
    }
    return null;
  }

  // One second of reading, if the reader is actually here and active.
  function tick() {
    if (!visit) return;
    if (document.visibilityState !== 'visible' || Date.now() - lastActive > 180000) return;
    const sec = sectionAtLine();
    if (!sec) return;
    visit.secs++;
    const st = (D.sectime[visit.slug] = D.sectime[visit.slug] || {});
    st[sec.id] = (st[sec.id] || 0) + 1;
    sectimeDirty = true;
    if (!isRead(visit.slug, sec.id) && st[sec.id] >= threshold(sec.words)) markRead(visit.slug, sec.id);
    if (++ticks % 15 === 0) flushSectime();
    maybePromptDone();
  }
  setInterval(tick, 1000);

  /* Reaching the end with most of the topic read: offer to mark it done. */
  function maybePromptDone() {
    if (!visit || visit.prompted || Atlas.isDone(visit.slug)) return;
    const fin = document.getElementById('atlas-finish');
    if (!fin || fin.getBoundingClientRect().top > window.innerHeight * 0.92) return;
    if (percent(visit.slug) < 0.6) return;
    visit.prompted = true;
    const slug = visit.slug;
    Atlas.toast(`You've reached the end of ${visit.t.title}.`, { action: 'Mark as done', onAction: () => Atlas.setDone(slug, true), ms: 8000 });
  }

  // Count the marks made during a visit, for its session summary.
  if (Store) {
    Store.subscribe((records, origin) => {
      if (origin === 'local' && visit) {
        for (const r of records) {
          if (r.topic !== visit.slug || r.deleted || visit.marks.has(r.id)) continue;
          if (r.kind === 'highlight') {
            visit.marks.add(r.id);
            visit.hl++;
          } else if (r.kind === 'stroke' && r.data && r.data.a && r.data.a.t === 'c') {
            visit.marks.add(r.id);
            visit.sc++;
          }
        }
      }
      if (origin === 'remote') applyRemote(records);
    });
  }

  /* ---------- review ---------- */

  const BASE = { 1: 1, 2: 4, 3: 10 };
  const RATING = { 1: 'Shaky', 2: 'Okay', 3: 'Solid' };
  let reviewing = null; // topic whose recap is open

  const isDue = (slug) => !!D.review[slug] && D.review[slug].due <= endOfToday();

  function putReview(slug) {
    const r = D.review[slug];
    putRecord({ id: `review:${slug}`, kind: 'review', topic: slug, data: r || {}, deleted: !r });
  }

  function schedule(slug, conf) {
    const prev = D.review[slug];
    if (!conf) {
      if (prev) {
        delete D.review[slug];
        save('review');
        putReview(slug);
      }
      return null;
    }
    const reviewed = !!prev && (prev.due <= endOfToday() || reviewing === slug);
    let iv = BASE[conf] || 4;
    if (reviewed) iv = conf === 1 ? 1 : Math.min(60, Math.max(BASE[conf], Math.round(prev.iv * 2)));
    D.review[slug] = { due: startOfDay(Date.now() + iv * DAY), iv, n: (prev ? prev.n : 0) + (reviewed ? 1 : 0), last: Date.now() };
    save('review');
    putReview(slug);
    return { iv, reviewed };
  }

  Atlas.on('state', ({ kind, slug, data, deleted }) => {
    if (kind !== 'conf') return;
    const res = schedule(slug, deleted ? 0 : data.conf);
    if (res && res.reviewed && reviewing === slug) {
      reviewing = null;
      const slot = view.querySelector('[data-slot="recap"]');
      if (slot) slot.innerHTML = `<div class="recap done">${icon('check', 16, 2.4)} Reviewed · next review ${relDay(D.review[slug].due)}</div>`;
    }
  });

  function reviewLine(slug) {
    const r = D.review[slug];
    if (!r) return '';
    return `<p class="review-line">${icon('clock', 14)} ${isDue(slug) ? 'Due for review today' : `Next review ${relDay(r.due)}`}${r.n ? ` · reviewed ${plural(r.n, 'time')}` : ''}</p>`;
  }

  const reviewBadge = (slug) => (isDue(slug) ? 'Review due' : '');

  function reviewQueue() {
    return Object.entries(D.review)
      .map(([slug, r]) => ({ t: Atlas.topic(slug), r }))
      .filter((x) => x.t)
      .sort((a, b) => a.r.due - b.r.due)
      .map(({ t, r }) => ({ t, due: r.due, label: isDue(t.slug) ? (r.due < startOfDay(Date.now()) ? 'Overdue' : 'Due today') : relDay(r.due), sub: `${RATING[Atlas.confOf(t.slug)] || ''}` }));
  }

  /* A recap above a topic that is due: your highlights, note and scribbles
     first, then rate how well you remembered it. */
  async function paintRecap(topic) {
    const slot = view.querySelector('[data-slot="recap"]');
    if (!slot) return;
    if (!isDue(topic.slug)) {
      slot.innerHTML = '';
      return;
    }
    reviewing = topic.slug;
    const recs = Store ? await Store.byTopic(topic.slug).catch(() => []) : [];
    if (!visit || visit.slug !== topic.slug) return;
    const hls = recs.filter((r) => r.kind === 'highlight' && !r.deleted && r.data && r.data.a).sort((a, b) => a.data.a.s - b.data.a.s).slice(0, 8);
    const boxes = recs.filter((r) => r.kind === 'card' && !r.deleted).length;
    const note = Atlas.noteOf(topic.slug).trim();
    const r = D.review[topic.slug];
    const ago = Math.max(0, Math.round((Date.now() - (r.last || Date.now())) / DAY));
    slot.innerHTML = `<section class="recap" aria-label="Review recap">
      <div class="recap-head">
        <span class="recap-tag">${icon('clock', 14)} Review</span>
        <b>Recap before you reread</b>
        <small>Last rated ${ago === 0 ? 'today' : `${plural(ago, 'day')} ago`} · review ${r.n + 1}</small>
      </div>
      ${hls.length ? `<ul class="recap-hl">${hls.map((h) => `<li class="hl-${esc(h.data.c)}"><span>${esc(h.data.a.q)}</span>${h.data.n ? `<em>${esc(h.data.n)}</em>` : ''}</li>`).join('')}</ul>` : ''}
      ${note ? `<div class="recap-note"><b>Your note</b><p>${esc(note)}</p></div>` : ''}
      ${boxes ? `<p class="recap-meta">${plural(boxes, 'scribble box')} further down the page.</p>` : ''}
      ${!hls.length && !note && !boxes ? '<p class="recap-meta">No highlights or notes on this one yet. Skim the headings and see how much comes back.</p>' : ''}
      <div class="recap-rate"><span>How well do you remember it?</span><div class="seg">${[1, 2, 3]
        .map((v) => `<button type="button" data-recap="${v}">${RATING[v]}</button>`)
        .join('')}</div></div>
    </section>`;
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-recap]');
    if (!b || !visit) return;
    Atlas.setConf(visit.slug, Number(b.dataset.recap));
  });

  /* ---------- goals and forecasts ---------- */

  function goalStatus() {
    const g = D.goal;
    const sec = g && Atlas.section(g.section);
    if (!sec) return null;
    const list = Atlas.topics.filter((t) => t.section === g.section);
    const done = list.filter((t) => Atlas.isDone(t.slug)).length;
    const remaining = list.filter((t) => !Atlas.isDone(t.slug)).reduce((a, t) => a + minutesLeft(t), 0);
    const end = new Date(`${g.date}T23:59:59`).getTime();
    const daysLeft = Math.max(0, Math.ceil((end - Date.now()) / DAY));
    const perDay = daysLeft ? Math.ceil(remaining / daysLeft) : remaining;
    const recent = lastDays(7).reduce((a, k) => a + dayMinutes(k), 0) / 7;
    const state = done === list.length ? 'done' : daysLeft === 0 ? 'late' : recent >= perDay * 0.9 ? 'on' : 'behind';
    return { g, sec, list, done, remaining, daysLeft, perDay, recent, state };
  }

  const GOAL_TEXT = { done: 'complete', late: 'date passed', on: 'on track', behind: 'behind' };

  function forecast() {
    const remaining = Atlas.topics.filter((t) => !Atlas.isDone(t.slug)).reduce((a, t) => a + minutesLeft(t), 0);
    const avg = lastDays(14).reduce((a, k) => a + dayMinutes(k), 0) / 14;
    if (!remaining) return { remaining: 0, avg, days: 0 };
    return { remaining, avg, days: avg >= 2 ? Math.ceil(remaining / avg) : null };
  }

  /* ---------- pieces of UI ---------- */

  function ringSvg(frac, size = 86, stroke = 9, cls = 'tr-ring') {
    const r = (size - stroke) / 2;
    const c = 2 * Math.PI * r;
    const f = clamp(frac, 0, 1);
    return `<svg class="${cls}" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}" aria-hidden="true">
      <circle class="bg" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}"/>
      ${f > 0 ? `<circle class="fg${f >= 1 ? ' met' : ''}" cx="${size / 2}" cy="${size / 2}" r="${r}" stroke-width="${stroke}" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - f)).toFixed(1)}" transform="rotate(-90 ${size / 2} ${size / 2})"/>` : ''}
    </svg>`;
  }

  function todayCard() {
    const goal = D.study.goal;
    const mins = Math.floor(dayMinutes(todayKey())); // whole minutes read, like the website
    const st = streak();
    const left = Math.max(0, goal - mins);
    return `<div class="card tr-today">
      <div class="tr-ring-wrap">${ringSvg(mins / goal)}<div class="tr-ring-label"><b>${mins}</b><span>of ${goal} min</span></div></div>
      <div class="tr-today-text">
        <span class="eyebrow">Today</span>
        <b>${left ? `${left} min to your daily goal` : 'Daily goal met'}</b>
        <span>${st.n ? `${plural(st.n, 'day')} in a row${st.rested ? ' · rest day used' : ''}` : 'Read today to start a streak'}</span>
        <span>${fmtMin(totalMinutes())} studied in all</span>
      </div>
    </div>`;
  }

  function weekBars(big = false) {
    const keys = lastDays(7);
    const goal = D.study.goal;
    const vals = keys.map(dayMinutes);
    const max = Math.max(goal * 1.25, ...vals, 1);
    const names = keys.map((k) => new Date(`${k}T12:00:00`).toLocaleDateString(undefined, { weekday: 'narrow' }));
    return `<div class="tr-week${big ? ' big' : ''}">
      <div class="tr-bars">
        <i class="tr-goal" style="bottom:${(goal / max) * 100}%" title="Daily goal: ${goal} min"></i>
        ${vals.map((v, i) => `<div class="tr-bar${i === 6 ? ' today' : ''}${v >= goal ? ' met' : ''}" title="${Math.round(v)} min"><i style="height:${Math.max(v > 0 ? 3 : 0, (v / max) * 100)}%"></i></div>`).join('')}
      </div>
      <div class="tr-days">${names.map((n, i) => `<span${i === 6 ? ' class="today"' : ''}>${esc(n)}</span>`).join('')}</div>
    </div>`;
  }

  function dueTile() {
    const q = reviewQueue();
    const due = q.filter((x) => isDue(x.t.slug));
    const soon = q.filter((x) => !isDue(x.t.slug)).slice(0, Math.max(0, 3 - due.length));
    const rows = [...due.slice(0, 4), ...soon]
      .map((x) => `<a class="tr-row" href="${Atlas.topicHref(x.t)}"><span>${esc(x.t.title)}</span><small class="${isDue(x.t.slug) ? 'due' : ''}">${esc(x.label)}</small></a>`)
      .join('');
    return `<div class="card tr-tile">
      <span class="eyebrow">Due for review${due.length ? ` · ${due.length}` : ''}</span>
      ${rows || '<p class="tr-empty">Nothing due. Rate a topic at the end of the article and it comes back here when it’s time to review.</p>'}
      ${due.length > 4 ? `<a class="tr-more" href="#/library">${due.length - 4} more in the Library</a>` : ''}
    </div>`;
  }

  function goalTile() {
    const s = goalStatus();
    if (!s) {
      return `<a class="card tr-tile tr-goal-cta" href="#/progress"><span class="eyebrow">Goal</span><b>Set a goal</b><p class="tr-empty">Pick a track and a date; Atlas works out how much to read each day.</p></a>`;
    }
    return `<a class="card tr-tile" href="#/progress" style="--a:${s.sec.accent}">
      <span class="eyebrow">Goal · ${esc(s.sec.title)} by ${new Date(`${s.g.date}T12:00:00`).toLocaleDateString(undefined, { day: 'numeric', month: 'short' })}</span>
      <b>${s.done} of ${s.list.length} topics</b>
      <div class="bar-track"><div class="bar-fill" style="width:${(s.done / s.list.length) * 100}%"></div></div>
      <span class="tr-goal-state ${s.state}">${s.state === 'done' ? 'Goal complete' : s.state === 'late' ? 'The date has passed' : `About ${s.perDay} min a day · ${GOAL_TEXT[s.state]}`}</span>
    </a>`;
  }

  async function flashbackTile() {
    if (!Store) return '';
    const hs = (await Store.byKind('highlight').catch(() => [])).filter((h) => !h.deleted && h.data && h.data.a && Atlas.topic(h.topic));
    if (hs.length < 1) return '';
    const key = todayKey();
    const pick = hs
      .map((h) => ({ h, k: hashStr(h.id + key) }))
      .sort((a, b) => a.k - b.k)
      .slice(0, 3)
      .map((x) => x.h);
    return `<div class="card tr-tile tr-flash">
      <span class="eyebrow">From your highlights</span>
      ${pick
        .map((h) => {
          const t = Atlas.topic(h.topic);
          return `<a class="tr-quote hl-${esc(h.data.c)}" href="${Atlas.topicHref(t)}" data-mark="${h.id}"><span>${esc(h.data.a.q.slice(0, 160))}${h.data.a.q.length > 160 ? '…' : ''}</span><small>${esc(t.title)}</small></a>`;
        })
        .join('')}
    </div>`;
  }

  /* ---------- Home ---------- */

  async function paintHome() {
    const today = view.querySelector('[data-slot="home-today"]');
    const track = view.querySelector('[data-slot="home-track"]');
    if (today) today.innerHTML = todayCard();
    if (!track) return;
    track.innerHTML = `<div class="tr-grid">${dueTile()}<div class="card tr-tile"><span class="eyebrow">This week</span>${weekBars()}</div>${goalTile()}<div data-flash></div></div>`;
    const flash = await flashbackTile();
    const holder = track.querySelector('[data-flash]');
    if (holder) holder.outerHTML = flash;
  }

  /* ---------- Progress page ---------- */

  function heatmap() {
    // 18 weeks, Monday-first columns, ending with this week.
    const today = new Date();
    today.setHours(12, 0, 0, 0);
    const dow = (today.getDay() + 6) % 7;
    const start = new Date(today);
    start.setDate(today.getDate() - dow - 17 * 7);
    const goal = D.study.goal;
    const cols = [];
    for (let w = 0; w < 18; w++) {
      const cells = [];
      for (let d = 0; d < 7; d++) {
        const x = new Date(start);
        x.setDate(start.getDate() + w * 7 + d);
        if (x > today) {
          cells.push('<i class="future"></i>');
          continue;
        }
        const m = dayMinutes(dayKey(x));
        const lvl = m <= 0.5 ? 0 : m < goal * 0.5 ? 1 : m < goal ? 2 : m < goal * 1.5 ? 3 : 4;
        cells.push(`<i class="l${lvl}" title="${x.toLocaleDateString()} · ${Math.round(m)} min"></i>`);
      }
      cols.push(`<div class="tr-col">${cells.join('')}</div>`);
    }
    return `<div class="tr-heat">${cols.join('')}</div>
      <div class="tr-legend"><span>Less</span><i class="l0"></i><i class="l1"></i><i class="l2"></i><i class="l3"></i><i class="l4"></i><span>More</span></div>`;
  }

  function tracksTable() {
    const spent = Atlas.spent() || {};
    return Atlas.sections
      .map((s) => {
        const list = Atlas.topics.filter((t) => t.section === s.slug);
        const done = list.filter((t) => Atlas.isDone(t.slug)).length;
        const readFrac = list.reduce((a, t) => a + (Atlas.isDone(t.slug) ? 1 : percent(t.slug)), 0) / list.length;
        const left = list.filter((t) => !Atlas.isDone(t.slug)).reduce((a, t) => a + minutesLeft(t), 0);
        const mins = list.reduce((a, t) => a + (spent[t.slug] || 0), 0) / 60;
        return `<a class="tr-track" href="#/s/${s.slug}" style="--a:${s.accent}">
          <div class="tr-track-head"><b>${esc(s.title)}</b><span>${done}/${list.length} done</span></div>
          <div class="tr-track-bar"><i class="read" style="width:${readFrac * 100}%"></i><i class="done" style="width:${(done / list.length) * 100}%"></i></div>
          <small>${left ? `About ${fmtMin(left)} left at your pace` : 'All done'}${mins >= 1 ? ` · ${fmtMin(mins)} spent here` : ''}</small>
        </a>`;
      })
      .join('');
  }

  function goalForm() {
    const s = goalStatus();
    const min = todayKey();
    const g = D.goal || {};
    return `<div class="card tr-goal-form">
      ${s ? `<div class="tr-goal-now" style="--a:${s.sec.accent}"><b>${esc(s.sec.title)} by ${new Date(`${s.g.date}T12:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'long' })}</b>
          <span>${s.done} of ${s.list.length} topics done · about ${fmtMin(s.remaining)} of reading left · ${s.daysLeft ? `${plural(s.daysLeft, 'day')} to go` : 'due today'}</span>
          <span class="tr-goal-state ${s.state}">${s.state === 'done' ? 'Goal complete' : s.state === 'late' ? 'The date has passed — pick a new one' : `Needs about ${s.perDay} min a day; you've averaged ${Math.round(s.recent)} min over the last week · ${GOAL_TEXT[s.state]}`}</span></div>` : '<p class="tr-empty">Pick a track and a finish date. Atlas uses your actual reading speed to work out the time you need each day.</p>'}
      <div class="tr-goal-fields">
        <label>Track<select id="atlas-goal-sec">${Atlas.sections.map((x) => `<option value="${x.slug}"${g.section === x.slug ? ' selected' : ''}>${esc(x.title)}</option>`).join('')}</select></label>
        <label>Finish by<input id="atlas-goal-date" type="date" min="${min}" value="${esc(g.date || '')}"></label>
        <div class="tr-goal-btns"><button type="button" class="btn small primary" data-goal="save">${s ? 'Update goal' : 'Set goal'}</button>${s ? '<button type="button" class="btn small" data-goal="clear">Clear</button>' : ''}</div>
      </div>
    </div>`;
  }

  function paintProgress() {
    const slot = view.querySelector('[data-slot="progress"]');
    if (!slot) return;
    const st = streak();
    const week = lastDays(7).reduce((a, k) => a + dayMinutes(k), 0);
    const done = Atlas.topics.filter((t) => Atlas.isDone(t.slug)).length;
    const fc = forecast();
    const due = reviewQueue().filter((x) => isDue(x.t.slug));
    const nextUp = reviewQueue().find((x) => !isDue(x.t.slug));
    const sessions = D.sessions.slice(0, 10).filter((s) => Atlas.topic(s.slug));
    slot.innerHTML = `
      <div class="tr-summary">
        ${todayCard()}
        <div class="card tr-stat"><b>${st.n}</b><span>day streak${st.rested ? ' · rest day used' : ''}</span></div>
        <div class="card tr-stat"><b>${fmtMin(week)}</b><span>this week</span></div>
        <div class="card tr-stat"><b>${done}<small>/${Atlas.topics.length}</small></b><span>topics done</span></div>
      </div>

      <section class="block"><h2>This week</h2><div class="card tr-pad">${weekBars(true)}</div></section>
      <section class="block"><h2>Last 18 weeks</h2><div class="card tr-pad">${heatmap()}</div></section>

      <section class="block"><h2>Reading</h2>
        <div class="list">
          <div class="set-row"><div><b>Your reading speed</b><small>${wpm()} words a minute${wpm() === 220 ? ' (a starting estimate until you have read for a while)' : ', from the sections you have read'}.</small></div></div>
          <div class="set-row"><div><b>Finishing the curriculum</b><small>${fc.remaining === 0 ? 'Everything is done.' : fc.days ? `About ${fmtMin(fc.remaining)} of reading left. At your pace over the last two weeks (${Math.round(fc.avg)} min a day), roughly ${fc.days < 14 ? plural(fc.days, 'day') : plural(Math.round(fc.days / 7), 'week')}.` : `About ${fmtMin(fc.remaining)} of reading left. Read a little most days and a forecast appears here.`}</small></div></div>
        </div>
      </section>

      <section class="block"><h2>Goal</h2>${goalForm()}</section>

      <section class="block"><h2>Review</h2>
        <div class="list">${
          due.length
            ? due.map((x) => `<a class="row-link" href="${Atlas.topicHref(x.t)}" style="--a:${Atlas.section(x.t.section).accent}"><div class="row-main"><b>${esc(x.t.title)}</b><small><span class="row-kicker">${esc(Atlas.section(x.t.section).title)}</span> · ${esc(x.sub)}</small></div><span class="row-side due">${esc(x.label)}</span></a>`).join('')
            : `<div class="set-row"><div><b>Nothing due today</b><small>${nextUp ? `Next up: ${esc(nextUp.t.title)}, ${esc(nextUp.label)}. ${plural(Object.keys(D.review).length, 'topic')} on your review schedule.` : 'Rate topics at the end of the article to build a review schedule.'}</small></div></div>`
        }</div>
      </section>

      <section class="block"><h2>Tracks</h2><div class="tr-tracks">${tracksTable()}</div></section>

      <section class="block"><h2>Recent sessions</h2>
        ${sessions.length ? `<div class="list">${sessions
          .map((s) => {
            const t = Atlas.topic(s.slug);
            const bits = [fmtMin(s.secs / 60)];
            if (s.read) bits.push(`${plural(s.read, 'section')} read`);
            if (s.hl) bits.push(plural(s.hl, 'highlight'));
            if (s.sc) bits.push(`${plural(s.sc, 'stroke')} of scribbles`);
            return `<a class="row-link" href="${Atlas.topicHref(t)}" style="--a:${Atlas.section(t.section).accent}"><div class="row-main"><b>${esc(t.title)}</b><small>${new Date(s.start).toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })} · ${bits.join(' · ')}</small></div></a>`;
          })
          .join('')}</div>` : '<div class="empty">Sessions show up here after you spend a little time on a topic.</div>'}
      </section>`;
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-goal]');
    if (!b) return;
    if (b.dataset.goal === 'clear') {
      D.goal = null;
    } else {
      const section = view.querySelector('#atlas-goal-sec').value;
      const date = view.querySelector('#atlas-goal-date').value;
      if (!date) return Atlas.toast('Pick a finish date first.');
      D.goal = { section, date };
    }
    save('goal');
    putRecord({ id: 'goal:main', kind: 'goal', topic: 'main', data: D.goal || {}, deleted: !D.goal });
    paintProgress();
    Atlas.toast(D.goal ? 'Goal saved.' : 'Goal cleared.');
  });

  /* ---------- Settings → Study ---------- */

  function paintStudy() {
    const slot = view.querySelector('[data-slot="study"]');
    if (!slot) return;
    slot.innerHTML = `<section class="block"><h2>Study</h2>
      <div class="list">
        <div class="set-row stack"><div><b>Daily goal</b><small>Minutes of active reading a day. Drives the ring on Home and the streak.</small></div>
          <div class="seg full">${[15, 30, 45, 60, 90].map((m) => `<button type="button" data-study-goal="${m}" class="${D.study.goal === m ? 'on' : ''}">${m} min</button>`).join('')}</div></div>
        <div class="set-row"><div><b>Rest days</b><small>One missed day a week doesn't break your streak.</small></div>
          <button type="button" class="btn small" data-study-rest aria-pressed="${D.study.rest}">${D.study.rest ? 'On' : 'Off'}</button></div>
      </div></section>`;
  }

  view.addEventListener('click', (e) => {
    const g = e.target.closest('[data-study-goal]');
    const r = e.target.closest('[data-study-rest]');
    if (!g && !r) return;
    if (g) D.study.goal = Number(g.dataset.studyGoal);
    if (r) D.study.rest = !D.study.rest;
    save('study');
    paintStudy();
  });

  function paintSlots(route) {
    if (!route) return;
    if (route.name === 'home') paintHome();
    else if (route.name === 'progress') paintProgress();
    else if (route.name === 'settings') paintStudy();
  }

  /* ---------- sync ---------- */

  let lastTimePut = {};
  function putTime(key) {
    if (!Store || !device) return;
    const s = (Atlas.days() || {})[key] || 0;
    if (!s || lastTimePut[key] === s) return;
    lastTimePut[key] = s;
    putRecord({ id: `time:${key}:${device}`, kind: 'time', topic: key, data: { s, dev: device } });
  }
  setInterval(() => putTime(todayKey()), 60000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      putTime(todayKey());
      flushSectime();
    }
  });

  function applyRemote(records) {
    let touched = false;
    for (const r of records) {
      if (!TRACK_KINDS.has(r.kind)) continue;
      touched = true;
      const d = r.data || {};
      if (r.kind === 'sec') {
        const set = (D.secs[r.topic] = D.secs[r.topic] || {});
        if (r.deleted) delete set[d.id];
        else if (d.id && !set[d.id]) set[d.id] = Date.now();
        save('secs');
      } else if (r.kind === 'time') {
        if (d.dev && d.dev !== device) {
          (D.rtime[r.topic] = D.rtime[r.topic] || {})[d.dev] = r.deleted ? 0 : d.s || 0;
          save('rtime');
        }
      } else if (r.kind === 'review') {
        if (r.deleted || !d.due) delete D.review[r.topic];
        else D.review[r.topic] = d;
        save('review');
      } else if (r.kind === 'goal') {
        D.goal = r.deleted || !d.section ? null : d;
        save('goal');
      }
    }
    if (!touched) return;
    Atlas.refreshMarks();
    paintSlots(Atlas.current());
  }

  /* Reading time recorded before sync existed goes up once. */
  async function seedTime() {
    if (!Store) return;
    try {
      await Store.ready;
      device = device || (await Store.getMeta('device', ''));
      if (!device || (await Store.getMeta('timeSeeded', false))) return;
      const days = Atlas.days() || {};
      const list = Object.entries(days)
        .filter(([, s]) => s > 0)
        .map(([key, s]) => ({ id: `time:${key}:${device}`, kind: 'time', topic: key, data: { s, dev: device } }));
      if (list.length) await Store.put(list);
      await Store.setMeta('timeSeeded', true);
    } catch {
      /* try again next launch */
    }
  }

  /* ---------- export, import, reset ---------- */

  const EXPORT_KEYS = ['secs', 'sectime', 'secmeta', 'review', 'goal', 'study', 'sessions'];
  Atlas.exporters.push(async () => ({ tracking: Object.fromEntries(EXPORT_KEYS.map((k) => [k, D[k]])) }));
  Atlas.importers.push(async (d) => {
    const t = d && d.tracking;
    if (!t || typeof t !== 'object') return;
    for (const k of EXPORT_KEYS) {
      if (t[k] !== undefined) {
        D[k] = t[k];
        save(k);
      }
    }
    for (const slug of Object.keys(D.review)) putReview(slug);
    for (const [slug, read] of Object.entries(D.secs)) for (const id of Object.keys(read)) putRecord({ id: `sec:${slug}:${id}`, kind: 'sec', topic: slug, data: { id } });
  });
  Atlas.on('reset', () => {
    for (const [slug, read] of Object.entries(D.secs)) for (const id of Object.keys(read)) putRecord({ id: `sec:${slug}:${id}`, kind: 'sec', topic: slug, data: { id }, deleted: true });
    const reviewed = Object.keys(D.review);
    D.secs = {};
    D.sectime = {};
    D.review = {};
    D.sessions = [];
    for (const k of ['secs', 'sectime', 'review', 'sessions']) save(k);
    for (const slug of reviewed) putReview(slug);
    Atlas.refreshMarks();
  });

  /* ---------- start ---------- */

  window.AtlasTrack = {
    percent,
    minutesLeft,
    sectionsRead,
    reviewLine,
    reviewBadge,
    reviewQueue,
    isDue,
    streak,
    wpm,
    // for tests: run n seconds of reading at the current scroll position
    simulate(n) {
      const saved = lastActive;
      for (let i = 0; i < n; i++) {
        lastActive = Date.now();
        tick();
      }
      lastActive = saved;
    },
  };

  seedTime();
  Atlas.refreshMarks();
})();
