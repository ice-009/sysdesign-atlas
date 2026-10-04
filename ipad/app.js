/* SysDesign Atlas — iPad / offline edition.

   A single-page app over the curriculum index in data.js (window.ATLAS). Topic
   bodies are pre-rendered HTML fragments fetched on demand; the service worker
   keeps all of them on the device, so after the first online launch the whole
   thing runs with no network at all.

   Routes (hash-based, so the one cached index.html serves everything):
     #/                         home
     #/s/<section>              section
     #/t/<section>/<slug>[/id]  topic, optionally at a heading
     #/library                  bookmarks, review queue, notes, history
     #/settings                 reading, offline copy, your data

   Everything the reader produces — progress, bookmarks, notes, positions —
   lives in localStorage under "atlas.*" and never leaves the device. */

(function () {
  'use strict';

  const A = window.ATLAS;
  if (!A) {
    document.body.textContent = 'The curriculum index failed to load. Reload to try again.';
    return;
  }

  const root = document.documentElement;
  const view = document.getElementById('atlas-view');
  const bar = document.getElementById('atlas-bar');
  const progressEl = document.getElementById('atlas-progress');
  const popover = document.getElementById('atlas-popover');
  const searchEl = document.getElementById('atlas-search');
  const qEl = document.getElementById('atlas-q');
  const resultsEl = document.getElementById('atlas-results');
  const toastEl = document.getElementById('atlas-toast');

  /* ---------- extension hooks ----------
     sync.js and annotate.js plug in through window.Atlas (defined at the
     bottom) instead of being woven through this file. Events:
       leave   a page is about to be replaced
       paint   new page HTML is in the DOM, before scroll is positioned
       render  page is fully positioned
       prefs   reading preferences changed
       state   the reader changed done / confidence / bookmark / note
       close   close any floating panels */
  const handlers = {};
  const on = (ev, fn) => (handlers[ev] = handlers[ev] || []).push(fn);
  function emit(ev, payload) {
    for (const fn of handlers[ev] || []) {
      try {
        fn(payload);
      } catch (err) {
        console.error(`[atlas] ${ev} handler failed`, err);
      }
    }
  }
  const preparers = []; //    (topic) => Promise, awaited alongside the topic fetch
  const searchProviders = []; // (query, tokens) => [{ href, title, kicker, accent, snippet, mark }]
  const exporters = []; //    async () => ({ key: value }) merged into the export file
  const importers = []; //    async (parsedFile) => void

  /* ---------- helpers ---------- */

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ESC[c]);
  const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const pad2 = (n) => String(n).padStart(2, '0');
  const dayKey = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const fmtMin = (m) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${m % 60}m` : ''}`);
  const fmtDate = (v) => new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  const wideMQ = matchMedia('(min-width: 1024px)');
  const isWide = () => wideMQ.matches;
  const standalone = navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;
  const debounce = (fn, ms) => {
    let t = 0;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  };

  /* ---------- curriculum ---------- */

  const SECTIONS = A.sections;
  const SEC = new Map(SECTIONS.map((s) => [s.slug, s]));
  const TOPICS = A.topics;
  TOPICS.forEach((t, i) => (t.i = i));
  const TOPIC = new Map(TOPICS.map((t) => [t.slug, t]));
  const BY_SEC = new Map(SECTIONS.map((s) => [s.slug, TOPICS.filter((t) => t.section === s.slug)]));
  const GROUPS = A.groups
    .map((g) => ({ ...g, sections: SECTIONS.filter((s) => s.group === g.name) }))
    .filter((g) => g.sections.length);
  const TOTAL_MIN = TOPICS.reduce((n, t) => n + t.minutes, 0);
  const DIFF = { easy: '#22c55e', medium: '#f59e0b', hard: '#f43f5e' };

  const topicHref = (t, anchor) =>
    `#/t/${t.section}/${t.slug}${anchor ? `/${encodeURIComponent(anchor)}` : ''}`;
  const sectionHref = (s) => `#/s/${s.slug}`;

  /* ---------- storage ---------- */

  const KEY = 'atlas.';
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
      localStorage.setItem(KEY + k, JSON.stringify(S[k]));
    } catch {
      /* private mode or full — the session still works, it just won't persist */
    }
  }

  const PREF_DEFAULTS = { theme: 'auto', size: 'm', font: 'sans', leading: 'normal', width: 'normal', sbCollapsed: false };
  const S = {
    done: load('done', {}), //    slug → completed at (ms)
    conf: load('conf', {}), //    slug → 1 shaky · 2 okay · 3 solid
    saved: load('saved', {}), //  slug → bookmarked at (ms)
    notes: load('notes', {}), //  slug → text
    pos: load('pos', {}), //      slug → how far through the article, 0..1
    recent: load('recent', []), // slugs, most recently opened first
    days: load('days', {}), //    YYYY-MM-DD → seconds of active reading
    spent: load('spent', {}), //  slug → seconds of active reading
    open: load('open', {}), //    sidebar sections left expanded
    last: load('last', null), //  { hash, at } — reopened after iOS evicts the app
    version: load('version', null), // { id, at } — when this content version arrived
    prefs: { ...PREF_DEFAULTS, ...load('prefs', {}) },
  };
  const DATA_KEYS = ['done', 'conf', 'saved', 'notes', 'pos', 'recent', 'days', 'spent'];
  if (!S.version || S.version.id !== A.version) {
    S.version = { id: A.version, at: Date.now() };
    save('version');
  }
  const doneCount = (list = TOPICS) => list.reduce((n, t) => n + (S.done[t.slug] ? 1 : 0), 0);

  /* ---------- preferences ---------- */

  const darkMQ = matchMedia('(prefers-color-scheme: dark)');
  const THEME_BG = { light: '#ffffff', sepia: '#f6f0e4', dark: '#07090e' };
  const PREF_OPTS = {
    theme: [['auto', 'Auto'], ['light', 'Light'], ['sepia', 'Sepia'], ['dark', 'Dark']],
    size: [['s', 'S'], ['m', 'M'], ['l', 'L'], ['xl', 'XL']],
    font: [['sans', 'Sans'], ['serif', 'Serif']],
    leading: [['tight', 'Compact'], ['normal', 'Normal'], ['loose', 'Relaxed']],
    width: [['narrow', 'Narrow'], ['normal', 'Normal'], ['wide', 'Wide']],
  };
  const PREF_LABEL = { theme: 'Theme', size: 'Text size', font: 'Typeface', leading: 'Line spacing', width: 'Column width' };

  function applyPrefs() {
    const p = S.prefs;
    const theme = p.theme === 'auto' ? (darkMQ.matches ? 'dark' : 'light') : p.theme;
    root.classList.toggle('dark', theme === 'dark');
    root.classList.toggle('sepia', theme === 'sepia');
    root.classList.toggle('sb-collapsed', !!p.sbCollapsed);
    root.dataset.size = p.size;
    root.dataset.font = p.font;
    root.dataset.leading = p.leading;
    root.dataset.width = p.width;
    $('meta[name="theme-color"]').setAttribute('content', THEME_BG[theme]);
    emit('prefs', { ...p });
  }

  /* Show the page with someone else's settings without saving them — used by
     "Show as drawn" to recreate the layout a scribble was made in. */
  function previewPrefs(p) {
    const keep = current && current.name === 'topic' ? readFraction() : null;
    if (!p) {
      root.style.removeProperty('--read-max');
      root.style.removeProperty('--width-scale');
      applyPrefs();
    } else {
      for (const k of ['size', 'font', 'leading', 'width']) if (p[k]) root.dataset[k] = p[k];
      if (p.column) {
        root.style.setProperty('--read-max', `${p.column}px`);
        root.style.setProperty('--width-scale', '1');
      }
      emit('prefs', { ...S.prefs, ...p, preview: true });
    }
    if (keep != null) scrollToFraction(keep);
  }

  function setPref(k, v) {
    // Text reflows when size or spacing changes; keep the reader on the same
    // passage instead of wherever the old pixel offset now lands.
    const keep = current && current.name === 'topic' ? readFraction() : null;
    S.prefs[k] = v;
    save('prefs');
    applyPrefs();
    if (keep != null && k !== 'theme') scrollToFraction(keep);
    $$('[data-pref]').forEach((b) => b.classList.toggle('on', S.prefs[b.dataset.pref] === b.dataset.val));
  }

  if (darkMQ.addEventListener) darkMQ.addEventListener('change', () => S.prefs.theme === 'auto' && applyPrefs());

  const prefSeg = (k) =>
    `<div class="seg full">${PREF_OPTS[k]
      .map(
        ([v, l]) =>
          `<button type="button" data-pref="${k}" data-val="${v}" class="${S.prefs[k] === v ? 'on' : ''}">${l}</button>`
      )
      .join('')}</div>`;

  /* ---------- icons (same strokes as the website's set) ---------- */

  const ICONS = {
    compass: '<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5z"/>',
    atom: '<circle cx="12" cy="12" r="2"/><ellipse cx="12" cy="12" rx="10" ry="4.5"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(60 12 12)"/><ellipse cx="12" cy="12" rx="10" ry="4.5" transform="rotate(120 12 12)"/>',
    blocks: '<rect x="3" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="3" width="7.5" height="7.5" rx="1.5"/><rect x="3" y="13.5" width="7.5" height="7.5" rx="1.5"/><rect x="13.5" y="13.5" width="7.5" height="7.5" rx="1.5"/>',
    network: '<circle cx="12" cy="4" r="2.2"/><circle cx="4.5" cy="19" r="2.2"/><circle cx="19.5" cy="19" r="2.2"/><path d="M12 6.2 5.8 16.9M12 6.2l6.2 10.7M6.7 19h10.6"/>',
    database: '<ellipse cx="12" cy="5.5" rx="8" ry="3"/><path d="M4 5.5v13c0 1.7 3.6 3 8 3s8-1.3 8-3v-13"/><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3"/>',
    chip: '<rect x="7" y="7" width="10" height="10" rx="2"/><rect x="10.5" y="10.5" width="3" height="3" rx="0.6"/><path d="M10 4v3M14 4v3M10 17v3M14 17v3M4 10h3M4 14h3M17 10h3M17 14h3"/>',
    server: '<rect x="3" y="4" width="18" height="6" rx="1.8"/><rect x="3" y="14" width="18" height="6" rx="1.8"/><path d="M7 7h.01M7 17h.01"/><path d="M13 7h4M13 17h4"/>',
    brain: '<path d="M12 5.5a2.6 2.6 0 0 0-4.9-1.2A2.6 2.6 0 0 0 4.4 8a2.8 2.8 0 0 0 .5 4.6A2.7 2.7 0 0 0 7.4 17a2.6 2.6 0 0 0 4.6-.9Z"/><path d="M12 5.5a2.6 2.6 0 0 1 4.9-1.2A2.6 2.6 0 0 1 19.6 8a2.8 2.8 0 0 1-.5 4.6 2.7 2.7 0 0 1-2.5 4.4 2.6 2.6 0 0 1-4.6-.9Z"/><path d="M12 5.5v10.6"/>',
    blueprint: '<rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18M9 9v12M13 13h4M13 17h4"/>',
    rocket: '<path d="M5.5 14.5c-1.4 1.4-1.9 5.5-1.9 5.5s4.1-.5 5.5-1.9c.8-.8.8-2.1 0-2.9a2 2 0 0 0-3.6-.7Z"/><path d="M12.5 12.5 9 9m11.5-6.5c0 4-2 8-5 11l-3.5 1L9 13l1-3.5c3-3 7-5 10.5-5Z"/><circle cx="15" cy="8" r="1.4"/>',
    target: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1.4" fill="currentColor"/>',
    layers: '<path d="m12 3 9 5-9 5-9-5 9-5Z"/><path d="m3 13 9 5 9-5"/>',
    book: '<path d="M4 4.5A1.5 1.5 0 0 1 5.5 3H19v15H5.5A1.5 1.5 0 0 0 4 19.5Z"/><path d="M4 19.5A1.5 1.5 0 0 1 5.5 21H19v-3"/><path d="M8 7.5h7M8 10.5h5"/>',
    menu: '<path d="M3.5 7h17M3.5 12h17M3.5 17h17"/>',
    sidebar: '<rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/>',
    back: '<path d="m15 5-7 7 7 7"/>',
    chevron: '<path d="m9 5 7 7-7 7"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.6-3.6"/>',
    check: '<path d="m4 12.5 5.2 5.2L20 7"/>',
    bookmark: '<path d="M6 3.5h12a1 1 0 0 1 1 1V21l-7-4.2L5 21V4.5a1 1 0 0 1 1-1Z"/>',
    toc: '<path d="M9 6h11M9 12h11M9 18h11"/><circle cx="4.5" cy="6" r="1.1" fill="currentColor"/><circle cx="4.5" cy="12" r="1.1" fill="currentColor"/><circle cx="4.5" cy="18" r="1.1" fill="currentColor"/>',
    text: '<path d="M2.5 19 8 5h1l5.5 14M4.6 14h7.8"/><path d="M15 19l3-7.5h.6l3 7.5M16 16.7h4.6"/>',
    home: '<path d="M3.5 10.5 12 3.5l8.5 7V20a1 1 0 0 1-1 1h-5v-6h-5v6h-5a1 1 0 0 1-1-1Z"/>',
    settings: '<path d="M4 6h9M17 6h3M4 12h3M11 12h9M4 18h11M19 18h1"/><circle cx="15" cy="6" r="2"/><circle cx="9" cy="12" r="2"/><circle cx="17" cy="18" r="2"/>',
    arrow: '<path d="M4.5 12h15M13.5 6l6 6-6 6"/>',
    arrowL: '<path d="M19.5 12h-15M10.5 6l-6 6 6 6"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    note: '<path d="M5 3.5h9.5L19 8v12.5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1Z"/><path d="M14 3.5V8h5M8 13h8M8 17h5"/>',
    download: '<path d="M12 4v11M7 10l5 5 5-5M5 20h14"/>',
    refresh: '<path d="M20 12a8 8 0 1 1-2.3-5.6M20 4v4.5h-4.5"/>',
    share: '<path d="M12 15V3.5M8 7.5l4-4 4 4"/><path d="M7 10.5H6a1 1 0 0 0-1 1V20a1 1 0 0 0 1 1h12a1 1 0 0 0 1-1v-8.5a1 1 0 0 0-1-1h-1"/>',
    upload: '<path d="M12 20V9M7 14l5-5 5 5M5 4h14"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    plane: '<path d="M21 15.5v-2l-8-5V3.8a1.5 1.5 0 0 0-3 0v4.7l-8 5v2l8-2.5v5l-2 1.5V21l3.5-1 3.5 1v-1.5l-2-1.5v-5Z"/>',
  };

  function icon(name, size = 20, sw = 1.7, filled = false) {
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="${filled ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  /* ---------- routing ---------- */

  function parse(hash) {
    const parts = String(hash || '')
      .replace(/^#\/?/, '')
      .split('/')
      .filter(Boolean)
      .map((p) => {
        try {
          return decodeURIComponent(p);
        } catch {
          return p;
        }
      });
    if (!parts.length) return { name: 'home' };
    if (parts[0] === 't' && parts[2]) return { name: 'topic', sec: parts[1], slug: parts[2], anchor: parts[3] || '' };
    if (parts[0] === 's' && parts[1]) return { name: 'section', sec: parts[1] };
    if (parts[0] === 'library') return { name: 'library' };
    if (parts[0] === 'settings') return { name: 'settings' };
    return { name: 'missing' };
  }

  let current = null;
  let interacted = false; // has the reader touched the page since it rendered?
  history.scrollRestoration = 'manual';

  const depth = () => (history.state && history.state.d) || 0;

  function go(target, opts = {}) {
    const route = parse(target);
    // Remember the scroll offset of the page being left, for Back.
    history.replaceState({ ...(history.state || {}), y: window.scrollY }, '');
    history.pushState({ d: depth() + 1 }, '', target);

    if (current && current.name === 'topic' && route.name === 'topic' && route.slug === current.slug) {
      // Same article, different spot — no re-render.
      current = route;
      closeOverlays();
      if (route.anchor) scrollToId(route.anchor, true);
      else if (opts.find) findInArticle(opts.find);
      else if (opts.mark) emit('render', { route, topic: currentTopic(), view, opts });
      updateBack();
      return;
    }
    render(route, opts);
  }

  window.addEventListener('popstate', (e) => {
    const route = parse(location.hash);
    const y = e.state && typeof e.state.y === 'number' ? e.state.y : undefined;
    if (current && current.name === 'topic' && route.name === 'topic' && route.slug === current.slug) {
      current = route;
      if (y !== undefined) window.scrollTo(0, y);
      else if (route.anchor) scrollToId(route.anchor);
      updateBack();
      return;
    }
    render(route, { y });
  });

  let renderSeq = 0;

  async function render(route, opts = {}) {
    const seq = ++renderSeq;
    flushPosition();
    emit('leave', { route: current });
    closeOverlays();
    clearHighlight();
    current = route;
    interacted = false;
    bar.classList.remove('show-title');

    let html;
    let title = '';
    let topic = null;

    if (route.name === 'home') {
      html = homeView();
    } else if (route.name === 'section' && SEC.has(route.sec)) {
      const s = SEC.get(route.sec);
      html = sectionView(s);
      title = s.title;
    } else if (route.name === 'topic' && TOPIC.has(route.slug)) {
      topic = TOPIC.get(route.slug);
      title = topic.title;
      updateChrome(route); // bar + sidebar respond immediately, before the fetch
      const slow = setTimeout(() => seq === renderSeq && paint(loadingView(topic)), 140);
      let body = null;
      // Marks for this topic load from IndexedDB while the text loads, so both
      // are ready before anything is drawn and nothing jumps afterwards.
      const prep = Promise.all(preparers.map((fn) => Promise.resolve().then(() => fn(topic)).catch(() => {})));
      try {
        body = await loadTopic(topic);
      } catch {
        body = null;
      }
      await prep;
      clearTimeout(slow);
      if (seq !== renderSeq) return; // the reader moved on while this loaded
      html = body == null ? failedView(topic) : topicView(topic, body, opts);
      if (body == null) topic = null;
    } else if (route.name === 'library') {
      html = libraryView();
      title = 'Library';
    } else if (route.name === 'settings') {
      html = settingsView();
      title = 'Settings';
    } else {
      html = missingView();
    }

    paint(html);
    document.title = title ? `${title} · Atlas` : 'SysDesign Atlas';
    updateChrome(route);
    S.last = { hash: location.hash || '#/', at: Date.now() };
    save('last');
    emit('paint', { route, topic, view, opts });

    if (topic) afterTopic(topic, route, opts);
    else window.scrollTo(0, opts.y || 0);
    onScroll();

    if (route.name === 'settings') paintStorage();
    emit('render', { route, topic, view, opts });
  }

  function paint(html) {
    view.innerHTML = html;
    view.style.animation = 'none';
    void view.offsetHeight; // restart the fade-in
    view.style.animation = '';
  }

  /* ---------- topic loading ---------- */

  const fragments = new Map();

  async function loadTopic(t) {
    if (fragments.has(t.file)) return fragments.get(t.file);
    const res = await fetch(t.file);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const html = await res.text();
    fragments.set(t.file, html);
    if (fragments.size > 16) fragments.delete(fragments.keys().next().value);
    return html;
  }

  function afterTopic(t, route, opts) {
    S.recent = [t.slug, ...S.recent.filter((s) => s !== t.slug)].slice(0, 40);
    save('recent');

    if (typeof opts.y === 'number') window.scrollTo(0, opts.y);
    else if (opts.mark) {
      /* annotate.js scrolls to the mark on 'render' */
    } else if (route.anchor && scrollToId(route.anchor)) {
      /* positioned at the heading */
    } else if (opts.find && findInArticle(opts.find)) {
      /* positioned at the search hit */
    } else if (opts.resume && S.pos[t.slug] > 0.02 && S.pos[t.slug] < 0.98) scrollToFraction(S.pos[t.slug]);
    else window.scrollTo(0, 0);

    const next = TOPICS[t.i + 1];
    if (next) setTimeout(() => loadTopic(next).catch(() => {}), 1500);
  }

  /* ---------- scroll position & reading progress ---------- */

  function articleBounds() {
    const prose = $('.prose', view);
    if (!prose) return null;
    const top = prose.getBoundingClientRect().top + window.scrollY;
    const start = top - bar.offsetHeight - 24;
    const end = top + prose.offsetHeight - window.innerHeight;
    return { start, end: Math.max(start + 1, end) };
  }

  function readFraction() {
    const b = articleBounds();
    return b ? clamp((window.scrollY - b.start) / (b.end - b.start), 0, 1) : 0;
  }

  function scrollToFraction(f, smooth) {
    const b = articleBounds();
    if (b) window.scrollTo({ top: Math.max(0, b.start + f * (b.end - b.start)), behavior: smooth ? 'smooth' : 'auto' });
  }

  function scrollToId(id, smooth) {
    const el = document.getElementById(id);
    if (!el || !view.contains(el)) return false;
    const top = el.getBoundingClientRect().top + window.scrollY - bar.offsetHeight - 14;
    window.scrollTo({ top: Math.max(0, top), behavior: smooth ? 'smooth' : 'auto' });
    return true;
  }

  let ticking = false;
  let posTimer = 0;

  function onScroll() {
    ticking = false;
    bar.classList.toggle('scrolled', window.scrollY > 4);
    const h1 = $('h1', view);
    bar.classList.toggle('show-title', !!h1 && h1.getBoundingClientRect().bottom < bar.offsetHeight);
    if (!current || current.name !== 'topic' || !$('.prose', view)) return;
    progressEl.style.transform = `scaleX(${readFraction()})`;
    // Only a scroll the reader made counts as a new position. Opening an
    // article to peek at it must not wipe out where they actually were.
    if (interacted) {
      clearTimeout(posTimer);
      posTimer = setTimeout(flushPosition, 500);
    }
  }

  function flushPosition() {
    clearTimeout(posTimer);
    if (!interacted || !current || current.name !== 'topic' || !$('.prose', view)) return;
    S.pos[current.slug] = Math.round(readFraction() * 1000) / 1000;
    save('pos');
  }

  window.addEventListener(
    'scroll',
    () => {
      if (!ticking) {
        ticking = true;
        requestAnimationFrame(onScroll);
      }
    },
    { passive: true }
  );

  /* ---------- active reading time ---------- */

  let lastActive = Date.now();
  const SCROLL_KEYS = new Set(['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', ' ', 'Home', 'End']);
  for (const ev of ['touchstart', 'touchmove', 'pointerdown', 'keydown', 'wheel']) {
    window.addEventListener(
      ev,
      (e) => {
        lastActive = Date.now();
        // A tap isn't reading — only a gesture that scrolls moves the bookmark.
        if (ev === 'touchmove' || ev === 'wheel' || (ev === 'keydown' && SCROLL_KEYS.has(e.key))) interacted = true;
      },
      { passive: true, capture: true }
    );
  }

  setInterval(() => {
    if (document.visibilityState !== 'visible' || Date.now() - lastActive > 3 * 60 * 1000) return;
    const k = dayKey();
    S.days[k] = (S.days[k] || 0) + 15;
    save('days');
    if (current && current.name === 'topic' && TOPIC.has(current.slug)) {
      S.spent[current.slug] = (S.spent[current.slug] || 0) + 15;
      save('spent');
    }
  }, 15000);

  function streakDays() {
    let n = 0;
    const d = new Date();
    // Not having read yet today doesn't break a streak — yesterday still counts.
    if (!((S.days[dayKey(d)] || 0) >= 60)) d.setDate(d.getDate() - 1);
    while ((S.days[dayKey(d)] || 0) >= 60) {
      n++;
      d.setDate(d.getDate() - 1);
    }
    return n;
  }

  // iOS can evict a backgrounded Home Screen app at any moment; save first.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') flushPosition();
    else maybeCheckForUpdate();
  });
  window.addEventListener('pagehide', flushPosition);

  /* ---------- chrome: bar, sidebar, drawer ---------- */

  function updateChrome(route) {
    const titleEl = $('#atlas-bar-title');
    let kicker = '';
    let name = 'SysDesign Atlas';
    let accent = '';
    if (route.name === 'topic' && TOPIC.has(route.slug)) {
      const t = TOPIC.get(route.slug);
      const s = SEC.get(t.section);
      kicker = s.title;
      name = t.title;
      accent = s.accent;
    } else if (route.name === 'section' && SEC.has(route.sec)) {
      const s = SEC.get(route.sec);
      kicker = s.group;
      name = s.title;
      accent = s.accent;
    } else if (route.name === 'library') name = 'Library';
    else if (route.name === 'settings') name = 'Settings';

    titleEl.style.setProperty('--a', accent || 'var(--text-dim)');
    titleEl.innerHTML = `${kicker ? `<span class="bar-kicker">${esc(kicker)}</span>` : ''}<span class="bar-name">${esc(name)}</span>`;
    bar.classList.toggle('is-topic', route.name === 'topic' && TOPIC.has(route.slug));
    progressEl.style.transform = 'scaleX(0)';
    updateSaveBtn();
    updateBack();
    updateSidebar(route);
  }

  function updateBack() {
    $('#atlas-btn-back').hidden = depth() < 1;
  }

  function updateMenuIcon() {
    $('#atlas-btn-menu').innerHTML = icon(isWide() ? 'sidebar' : 'menu', 22);
  }

  function setDrawer(open) {
    root.classList.toggle('sb-open', !!open && !isWide());
  }

  function toggleSidebar() {
    if (isWide()) {
      S.prefs.sbCollapsed = !S.prefs.sbCollapsed;
      save('prefs');
      root.classList.toggle('sb-collapsed', S.prefs.sbCollapsed);
    } else {
      setDrawer(!root.classList.contains('sb-open'));
    }
  }

  function buildSidebar() {
    $('#atlas-sb-main').innerHTML = [
      ['#/', 'home', 'Home', 'home'],
      ['#/library', 'library', 'Library', 'bookmark'],
      ['#/settings', 'settings', 'Settings', 'settings'],
    ]
      .map(
        ([h, key, label, ic]) =>
          `<a href="${h}" data-nav="${key}">${icon(ic, 19)}<span>${label}</span>${
            key === 'library' ? '<span class="sb-badge" id="atlas-saved-count" hidden></span>' : ''
          }</a>`
      )
      .join('');

    $('#atlas-sb-nav').innerHTML = GROUPS.map(
      (g) => `<div class="sb-group">
        <div class="sb-group-title">${esc(g.name)}</div>
        ${g.sections
          .map(
            (s) => `<div class="sb-sec${S.open[s.slug] ? ' open' : ''}" data-sec="${s.slug}" style="--a:${s.accent}">
            <div class="sb-sec-row">
              <a class="sb-sec-link" href="${sectionHref(s)}">${icon(s.icon, 18)}<span class="sb-sec-title">${esc(s.title)}</span><span class="sb-count"></span></a>
              <button class="sb-toggle" type="button" aria-label="Show topics in ${esc(s.title)}">${icon('chevron', 16, 2)}</button>
            </div>
            <ol class="sb-topics">${BY_SEC.get(s.slug)
              .map(
                (t) =>
                  `<li><a href="${topicHref(t)}" data-slug="${t.slug}"><span class="sb-dot"></span><span>${esc(t.title)}</span></a></li>`
              )
              .join('')}</ol>
          </div>`
          )
          .join('')}
      </div>`
    ).join('');
    refreshProgressMarks();
  }

  function refreshProgressMarks() {
    for (const el of $$('.sb-sec')) {
      const list = BY_SEC.get(el.dataset.sec);
      const n = doneCount(list);
      const c = $('.sb-count', el);
      c.textContent = n ? `${n}/${list.length}` : String(list.length);
      c.classList.toggle('full', n === list.length);
    }
    for (const a of $$('.sb-topics a')) a.classList.toggle('done', !!S.done[a.dataset.slug]);
    const nSaved = Object.keys(S.saved).filter((k) => TOPIC.has(k)).length;
    const badge = $('#atlas-saved-count');
    badge.textContent = String(nSaved);
    badge.hidden = !nSaved;
  }

  function updateSidebar(route) {
    for (const a of $$('.sb-main a')) a.classList.toggle('active', a.dataset.nav === route.name);
    const secSlug =
      route.name === 'topic' ? (TOPIC.get(route.slug) || {}).section : route.name === 'section' ? route.sec : null;
    for (const a of $$('.sb-sec-link')) {
      a.classList.toggle('active', route.name === 'section' && a.closest('.sb-sec').dataset.sec === route.sec);
    }
    let active = null;
    for (const a of $$('.sb-topics a')) {
      const on = route.name === 'topic' && a.dataset.slug === route.slug;
      a.classList.toggle('active', on);
      if (on) active = a;
    }
    if (secSlug) {
      const el = $(`.sb-sec[data-sec="${secSlug}"]`);
      if (el && !el.classList.contains('open')) {
        el.classList.add('open');
        S.open[secSlug] = true;
        save('open');
      }
    }
    const nav = $('#atlas-sb-nav');
    const target = active || (secSlug && $(`.sb-sec[data-sec="${secSlug}"]`));
    if (target) {
      const r = target.getBoundingClientRect();
      const nr = nav.getBoundingClientRect();
      if (r.top < nr.top + 40 || r.top > nr.bottom - 80) nav.scrollTop += r.top - nr.top - nr.height / 3;
    }
  }

  /* ---------- views: home ---------- */

  function ring(done, total) {
    const pct = total ? done / total : 0;
    const r = 50;
    const c = 2 * Math.PI * r;
    return `<div class="ring" aria-label="${done} of ${total} topics done">
      <svg viewBox="0 0 116 116" aria-hidden="true">
        <defs><linearGradient id="atlas-ring-grad" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#38bdf8"/><stop offset="1" stop-color="#a78bfa"/></linearGradient></defs>
        <circle class="ring-bg" cx="58" cy="58" r="${r}" fill="none" stroke-width="10"/>
        ${done ? `<circle class="ring-fg" cx="58" cy="58" r="${r}" fill="none" stroke-width="10" stroke-linecap="round" stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${(c * (1 - pct)).toFixed(1)}"/>` : ''}
      </svg>
      <div class="ring-label"><b>${Math.round(pct * 100)}%</b><span>${done} of ${total}</span></div>
    </div>`;
  }

  function nextUnread(after) {
    for (let k = 1; k <= TOPICS.length; k++) {
      const t = TOPICS[(after.i + k) % TOPICS.length];
      if (!S.done[t.slug]) return t;
    }
    return null;
  }

  function continueCard() {
    const last = S.recent.map((s) => TOPIC.get(s)).find(Boolean);
    let t = last;
    let label = 'Continue reading';
    let resume = true;
    if (!last) {
      t = TOPICS[0];
      label = 'Start here';
      resume = false;
    } else if (S.done[last.slug]) {
      t = nextUnread(last);
      label = 'Up next';
      resume = !!S.pos[t && t.slug];
      if (!t) {
        return `<div class="card continue" style="--a:var(--good)"><div class="eyebrow">All done</div><h3>You've finished every topic.</h3><p>Use the Library's review queue to revisit the ones you marked Shaky.</p></div>`;
      }
    }
    const s = SEC.get(t.section);
    const p = S.pos[t.slug] || 0;
    const left = Math.max(1, Math.round(t.minutes * (1 - p)));
    return `<a class="card continue" href="${topicHref(t)}"${resume ? ' data-resume' : ''} style="--a:${s.accent}">
      <div class="eyebrow">${label} · ${esc(s.title)}</div>
      <h3>${esc(t.title)}</h3>
      <p>${esc(t.summary)}</p>
      <div class="meta-row">
        <div class="bar-track"><div class="bar-fill" style="width:${Math.round(p * 100)}%"></div></div>
        <span>${p > 0.02 ? `${Math.round(p * 100)}% · ${left} min left` : `${t.minutes} min`}</span>
      </div>
      <span class="btn primary cta">${p > 0.02 ? 'Resume' : 'Start reading'} ${icon('arrow', 18)}</span>
    </a>`;
  }

  function installCard() {
    if (standalone && OFF.state === 'ready') return '';
    if (!standalone) {
      return `<div class="card install">
        <h3>${icon('plane', 20)} Take it offline</h3>
        <p>Install Atlas on your iPad to study with no connection — on a flight, a train, anywhere.</p>
        <ol>
          <li>Tap <b>Share</b> in Safari's toolbar.</li>
          <li>Choose <b>Add to Home Screen</b>, keep <b>Open as Web App</b> on, tap <b>Add</b>.</li>
          <li>Open <b>Atlas</b> from your Home Screen once while online, and wait for <b>Available offline</b>.</li>
        </ol>
      </div>`;
    }
    return `<div class="card install"><div data-offline="detail">${offlineDetail()}</div></div>`;
  }

  function homeView() {
    const done = doneCount();
    const today = Math.round((S.days[dayKey()] || 0) / 60);
    const total = Math.round(Object.values(S.days).reduce((a, b) => a + b, 0) / 60);
    const review = TOPICS.filter((t) => S.conf[t.slug] === 1).slice(0, 8);

    return `<div class="wrap">
      <section class="hero">
        <div class="hero-text">
          <div class="eyebrow">Offline edition</div>
          <h1>SysDesign Atlas</h1>
          <p>${TOPICS.length} topics across ${SECTIONS.length} tracks — about ${Math.round(TOTAL_MIN / 60)} hours of reading, from the physics of a single machine up to AI infrastructure.</p>
        </div>
        ${ring(done, TOPICS.length)}
      </section>

      ${installCard()}

      <div class="home-grid">
        ${continueCard()}
        <div class="stats">
          <div class="card stat"><b>${today}<small style="font-size:14px"> min</small></b><span>Today</span></div>
          <div class="card stat"><b>${streakDays()}</b><span>Day streak</span></div>
          <div class="card stat"><b>${done}</b><span>Topics done</span></div>
          <div class="card stat"><b>${fmtMin(total)}</b><span>Time studied</span></div>
        </div>
      </div>

      ${
        review.length
          ? `<section class="review-strip"><h2>Marked shaky — worth another pass</h2><div class="chips">${review
              .map(
                (t) =>
                  `<a class="chip" href="${topicHref(t)}" style="--a:${SEC.get(t.section).accent}"><span class="dot"></span>${esc(t.title)}</a>`
              )
              .join('')}</div></section>`
          : ''
      }

      ${GROUPS.map(
        (g) => `<section class="group">
          <div class="group-head"><h2>${esc(g.name)}</h2><p>${esc(g.blurb)}</p></div>
          <div class="sec-grid">${g.sections.map(sectionCard).join('')}</div>
        </section>`
      ).join('')}
    </div>`;
  }

  function sectionCard(s) {
    const list = BY_SEC.get(s.slug);
    const n = doneCount(list);
    const mins = list.reduce((a, t) => a + t.minutes, 0);
    return `<a class="card sec-card" href="${sectionHref(s)}" style="--a:${s.accent}">
      <div class="sec-ico">${icon(s.icon, 22)}</div>
      <h3>${esc(s.title)}</h3>
      <p>${esc(s.desc)}</p>
      <div class="sec-foot">
        <div class="row"><span>${list.length} topics · ${fmtMin(mins)}</span><span>${n}/${list.length}</span></div>
        <div class="bar-track"><div class="bar-fill" style="width:${(n / list.length) * 100}%"></div></div>
      </div>
    </a>`;
  }

  /* ---------- views: section ---------- */

  function sectionView(s) {
    const list = BY_SEC.get(s.slug);
    const n = doneCount(list);
    const mins = list.reduce((a, t) => a + t.minutes, 0);
    const next = list.find((t) => !S.done[t.slug]);
    const started = list.some((t) => S.done[t.slug] || S.pos[t.slug] > 0.02);
    return `<div class="wrap" style="--a:${s.accent}">
      <header class="sec-head">
        <div class="sec-ico">${icon(s.icon, 26)}</div>
        <div class="eyebrow">${esc(s.group)}</div>
        <h1>${esc(s.title)}</h1>
        <p>${esc(s.desc)}</p>
        <div class="sec-progress">
          <div class="bar-track"><div class="bar-fill" style="width:${(n / list.length) * 100}%"></div></div>
          <span>${n} of ${list.length} done · ${fmtMin(mins)}</span>
        </div>
        ${
          next
            ? `<div class="sec-actions"><a class="btn primary" href="${topicHref(next)}"${S.pos[next.slug] > 0.02 ? ' data-resume' : ''}>${started ? 'Continue' : 'Start'}: ${esc(next.title)} ${icon('arrow', 18)}</a></div>`
            : ''
        }
      </header>
      <ol class="topic-list">${list.map(topicRow).join('')}</ol>
    </div>`;
  }

  function topicRow(t, i) {
    const done = !!S.done[t.slug];
    const p = S.pos[t.slug] || 0;
    const scope = A.scopes[t.scope];
    const conf = { 1: 'Shaky', 2: 'Okay', 3: 'Solid' }[S.conf[t.slug]];
    const meta = [
      `${t.minutes} min`,
      t.difficulty,
      scope && scope.label,
      t.level ? `Level ${t.level}` : '',
      !done && p > 0.02 ? `${Math.round(p * 100)}% read` : '',
      conf ? `Rated ${conf}` : '',
    ].filter(Boolean);
    return `<li><a class="card topic-row${done ? ' done' : ''}" href="${topicHref(t)}"${!done && p > 0.02 ? ' data-resume' : ''}>
      <span class="topic-num">${pad2(i + 1)}</span>
      <div class="topic-body">
        <h3>${esc(t.title)}</h3>
        ${t.summary ? `<p>${esc(t.summary)}</p>` : ''}
        <div class="topic-meta">${meta.map((m) => `<span>${esc(m)}</span>`).join('')}</div>
      </div>
      <span class="topic-state${!done && p > 0.02 ? ' partial' : ''}">${done ? icon('check', 15, 2.6) : ''}</span>
    </a></li>`;
  }

  /* ---------- views: topic ---------- */

  function topicView(t, body, opts) {
    const s = SEC.get(t.section);
    const list = BY_SEC.get(t.section);
    const scope = A.scopes[t.scope];
    const diff = DIFF[(t.difficulty || '').toLowerCase()];
    const pre = t.prereqs.map((p) => TOPIC.get(p)).filter(Boolean);
    const p = S.pos[t.slug] || 0;
    const prev = TOPICS[t.i - 1];
    const next = TOPICS[t.i + 1];

    const badges = [
      scope ? `<span class="badge tint" style="--c:${scope.color}">${esc(scope.label)}</span>` : '',
      t.difficulty ? `<span class="badge tint" style="--c:${diff || '#94a3b8'}">${esc(t.difficulty)}</span>` : '',
      `<span class="badge">${t.minutes} min read</span>`,
      t.level ? `<span class="badge">Level ${t.level}</span>` : '',
      ...t.tags.slice(0, 4).map((g) => `<span class="badge">${esc(g)}</span>`),
    ].join('');

    const prereq =
      pre.length || t.unlocks
        ? `<div class="prereq">
            ${
              pre.length
                ? `<div class="prereq-label">Builds on</div><div class="chips">${pre
                    .map(
                      (q) =>
                        `<a class="chip${S.done[q.slug] ? ' done' : ''}" href="${topicHref(q)}" style="--a:${SEC.get(q.section).accent}"><span class="dot"></span>${esc(q.title)}</a>`
                    )
                    .join('')}</div>`
                : ''
            }
            ${t.unlocks ? `<div class="prereq-unlocks"><b>After this:</b> ${esc(t.unlocks)}</div>` : ''}
          </div>`
        : '';

    const resume =
      !opts.resume && !opts.find && p > 0.03 && p < 0.97
        ? `<div class="resume" id="atlas-resume">${icon('book', 18)}<span>You were ${Math.round(p * 100)}% of the way through.</span><button class="btn small primary" type="button" data-act="resume">Resume</button></div>`
        : '';

    const pnCard = (q, cls, label) => {
      if (!q) return '<span></span>';
      const qs = SEC.get(q.section);
      return `<a class="card ${cls}" href="${topicHref(q)}" style="--a:${qs.accent}">
        <small>${cls === 'prev' ? `${icon('arrowL', 13, 2)} ${label}` : `${label} ${icon('arrow', 13, 2)}`}</small>
        <b>${esc(q.title)}</b>${q.section !== t.section ? `<em>${esc(qs.title)}</em>` : ''}
      </a>`;
    };

    return `<article class="reading topic" style="--a:${s.accent}">
      <nav class="crumbs">
        <a class="crumb-sec" href="${sectionHref(s)}">${icon(s.icon, 16)} ${esc(s.title)}</a>
        <span>Topic ${list.indexOf(t) + 1} of ${list.length}</span>
      </nav>
      <h1 class="topic-title">${esc(t.title)}</h1>
      ${t.summary ? `<p class="topic-summary">${esc(t.summary)}</p>` : ''}
      <div class="badges">${badges}</div>
      ${prereq}
      ${resume}
      <div class="prose">${body}</div>
      ${finishHtml(t)}
      <section class="card notes">
        <div class="notes-head"><b>Your notes</b><span id="atlas-note-state">${S.notes[t.slug] ? 'Saved on this device' : 'Private to this device'}</span></div>
        <textarea id="atlas-note" placeholder="What do you want to remember from this?">${esc(S.notes[t.slug] || '')}</textarea>
      </section>
      <nav class="pn">${pnCard(prev, 'prev', 'Previous')}${pnCard(next, 'next', 'Next')}</nav>
    </article>`;
  }

  function finishHtml(t) {
    const done = S.done[t.slug];
    const conf = S.conf[t.slug] || 0;
    return `<section class="card finish${done ? ' is-done' : ''}" id="atlas-finish">
      <h3>${done ? 'Completed' : 'Finished reading?'}</h3>
      <p>${done ? `Marked done on ${fmtDate(done)}.` : 'Mark it done to track your way through the curriculum.'}</p>
      <button class="btn btn-done${done ? '' : ' primary'}" type="button" data-act="done">${icon('check', 18, 2.4)} ${done ? 'Done' : 'Mark as done'}</button>
      <div class="conf"><span>How well do you know it?</span><div class="seg">${[
        [1, 'Shaky'],
        [2, 'Okay'],
        [3, 'Solid'],
      ]
        .map(([v, l]) => `<button type="button" data-conf="${v}" class="${conf === v ? 'on' : ''}">${l}</button>`)
        .join('')}</div></div>
    </section>`;
  }

  function loadingView(t) {
    return `<div class="reading topic topic-loading" style="--a:${SEC.get(t.section).accent}">
      <h1 class="topic-title">${esc(t.title)}</h1>
      <div class="skel" style="width:70%"></div><div class="skel"></div><div class="skel" style="width:85%"></div><div class="skel" style="width:60%"></div>
    </div>`;
  }

  function failedView(t) {
    return `<div class="reading topic" style="--a:${SEC.get(t.section).accent}">
      <nav class="crumbs"><a class="crumb-sec" href="${sectionHref(SEC.get(t.section))}">${esc(SEC.get(t.section).title)}</a></nav>
      <h1 class="topic-title">${esc(t.title)}</h1>
      <div class="empty" style="margin-top:24px">
        This topic isn't on the device yet${navigator.onLine ? ' and could not be downloaded' : ' and you are offline'}.
        Once the app has finished saving everything for offline use, every topic opens without a connection.
        <div style="margin-top:14px"><button class="btn small" type="button" data-act="retry">${icon('refresh', 16)} Try again</button></div>
      </div>
    </div>`;
  }

  function missingView() {
    return `<div class="wrap"><header class="page-head"><h1>Not found</h1><p>That page doesn't exist in this edition.</p></header>
      <p style="margin-top:20px"><a class="btn" href="#/">${icon('home', 18)} Go home</a></p></div>`;
  }

  /* ---------- views: library ---------- */

  function libraryView() {
    const saved = Object.entries(S.saved)
      .filter(([k]) => TOPIC.has(k))
      .sort((a, b) => b[1] - a[1])
      .map(([k]) => TOPIC.get(k));
    const review = [1, 2].flatMap((c) => TOPICS.filter((t) => S.conf[t.slug] === c));
    const notes = TOPICS.filter((t) => (S.notes[t.slug] || '').trim());
    const recent = S.recent.map((k) => TOPIC.get(k)).filter(Boolean).slice(0, 15);

    const row = (t, side, sub) => {
      const s = SEC.get(t.section);
      return `<a class="row-link" href="${topicHref(t)}" style="--a:${s.accent}"${S.pos[t.slug] > 0.02 && !S.done[t.slug] ? ' data-resume' : ''}>
        <div class="row-main"><b>${esc(t.title)}</b><small><span class="row-kicker">${esc(s.title)}</span>${sub ? ` · ${esc(sub)}` : ''}</small></div>
        ${side ? `<span class="row-side">${side}</span>` : ''}
        ${icon('chevron', 16, 2).replace('class="ic"', 'class="ic chev"')}
      </a>`;
    };
    const block = (title, items, empty) =>
      `<section class="block"><h2>${title}</h2>${items.length ? `<div class="list">${items.join('')}</div>` : `<div class="empty">${empty}</div>`}</section>`;
    const state = (t) =>
      S.done[t.slug] ? 'Done' : S.pos[t.slug] > 0.02 ? `${Math.round(S.pos[t.slug] * 100)}%` : '';

    return `<div class="wrap reading">
      <header class="page-head"><h1>Library</h1><p>Your bookmarks, review queue, notes and marks.</p></header>
      <div data-slot="annotations"></div>
      ${block('Bookmarks', saved.map((t) => row(t, state(t), `${t.minutes} min`)), 'Tap the bookmark icon at the top of any topic to keep it here.')}
      ${block(
        'Review queue',
        review.map((t) => row(t, S.conf[t.slug] === 1 ? 'Shaky' : 'Okay', '')),
        'Rate a topic Shaky or Okay at the end of the article and it lands here, shakiest first.'
      )}
      ${block(
        'Notes',
        notes.map((t) => row(t, '', S.notes[t.slug].trim().split('\n')[0].slice(0, 90))),
        'Notes you write at the bottom of a topic are collected here.'
      )}
      ${block('Recently opened', recent.map((t) => row(t, state(t), '')), 'Topics you open show up here.')}
    </div>`;
  }

  /* ---------- views: settings ---------- */

  function settingsView() {
    const prefRow = (k) =>
      `<div class="set-row stack"><div><b>${PREF_LABEL[k]}</b></div>${prefSeg(k)}</div>`;
    return `<div class="wrap reading">
      <header class="page-head"><h1>Settings</h1></header>

      <section class="block"><h2>Reading</h2>
        <div class="list">${['theme', 'size', 'font', 'leading', 'width'].map(prefRow).join('')}</div>
      </section>

      <div data-slot="pencil"></div>
      <div data-slot="sync"></div>

      <section class="block"><h2>Offline</h2>
        <div class="list">
          <div class="set-row"><div data-offline="detail">${offlineDetail()}</div></div>
          <div class="set-row"><div><b>Storage used</b><small id="atlas-storage">Checking…</small></div></div>
          <div class="set-row"><div><b>Check offline copy</b><small>Re-downloads anything missing. Needs a connection.</small></div>
            <button class="btn small" type="button" data-act="repair">${icon('refresh', 16)} Repair</button></div>
          <div class="set-row"><div><b>Updates</b><small>Content version ${esc(A.version.slice(0, 7))}, on this device since ${fmtDate(S.version.at)}. New content downloads by itself whenever you're online.</small></div>
            <button class="btn small" type="button" data-act="update">Check now</button></div>
        </div>
      </section>

      <section class="block"><h2>Your progress</h2>
        <div class="list">
          <div class="set-row"><div><b>Export</b><small>Save progress, bookmarks, notes, highlights and ink as a file — to Files, AirDrop, anywhere.</small></div>
            <button class="btn small" type="button" data-act="export">${icon('share', 16)} Export</button></div>
          <div class="set-row"><div><b>Import</b><small>Restore from an exported file. Replaces what's here.</small></div>
            <button class="btn small" type="button" data-act="import">${icon('upload', 16)} Import</button>
            <input type="file" id="atlas-import" accept=".json,application/json" hidden></div>
          <div class="set-row"><div><b>Reset</b><small>Erase all progress, bookmarks and notes. Highlights and ink are kept.</small></div>
            <button class="btn small danger" type="button" data-act="reset">${icon('trash', 16)} Reset</button></div>
        </div>
      </section>

      <section class="block"><h2>Keyboard shortcuts</h2>
        <div class="list"><div class="kbd-list">
          <span><kbd>⌘</kbd> <kbd>K</kbd> or <kbd>/</kbd></span><span>Search</span>
          <span><kbd>[</kbd> <kbd>]</kbd></span><span>Previous / next topic</span>
          <span><kbd>T</kbd></span><span>Contents of this topic</span>
          <span><kbd>D</kbd></span><span>Mark done</span>
          <span><kbd>B</kbd></span><span>Bookmark</span>
          <span><kbd>\\</kbd></span><span>Show / hide the sidebar</span>
          <span><kbd>H</kbd> <kbd>I</kbd> <kbd>E</kbd> <kbd>R</kbd></span><span>Highlight, ink, eraser, read (on a topic)</span>
          <span><kbd>⌘</kbd> <kbd>Z</kbd> / <kbd>⇧</kbd> <kbd>⌘</kbd> <kbd>Z</kbd></span><span>Undo / redo a mark</span>
          <span><kbd>Esc</kbd></span><span>Close panels</span>
        </div></div>
      </section>

      <section class="block"><h2>About</h2>
        <div class="list"><div class="set-row"><div><b>SysDesign Atlas · offline edition</b>
          <small>${TOPICS.length} topics · ${SECTIONS.length} tracks · about ${Math.round(TOTAL_MIN / 60)} hours of reading. Content is identical to the website.</small></div></div></div>
      </section>
    </div>`;
  }

  async function paintStorage() {
    const el = $('#atlas-storage');
    if (!el) return;
    try {
      const est = navigator.storage && navigator.storage.estimate ? await navigator.storage.estimate() : null;
      const persisted = navigator.storage && navigator.storage.persisted ? await navigator.storage.persisted() : false;
      el.textContent = est
        ? `${(est.usage / 1024 / 1024).toFixed(1)} MB on this device${persisted ? ' · protected from automatic cleanup' : ''}`
        : 'Not reported by this browser';
    } catch {
      el.textContent = 'Not reported by this browser';
    }
  }

  /* ---------- popovers: reading settings & contents ---------- */

  function openPopover(kind) {
    if (!popover.hidden && popover.dataset.kind === kind) return closePopover();
    closeSearch();
    popover.dataset.kind = kind;
    if (kind === 'text') {
      popover.innerHTML = `<div class="pop" role="dialog" aria-label="Reading settings"><h4>Reading</h4>${['theme', 'size', 'font', 'leading', 'width']
        .map((k) => `<div class="pop-field"><label>${PREF_LABEL[k]}</label>${prefSeg(k)}</div>`)
        .join('')}</div>`;
    } else {
      const heads = $$('.prose h2, .prose h3', view);
      const y = window.scrollY + bar.offsetHeight + 24;
      let active = -1;
      heads.forEach((h, i) => {
        if (h.getBoundingClientRect().top + window.scrollY <= y) active = i;
      });
      popover.innerHTML = `<div class="pop" role="dialog" aria-label="Contents"><h4>Contents</h4><div class="toc-list">${
        heads.length
          ? heads
              .map(
                (h, i) =>
                  `<button type="button" class="toc-item lvl-${h.tagName[1]}${i === active ? ' active' : ''}" data-toc="${esc(h.id)}">${esc(h.textContent.replace(/^#/, ''))}</button>`
              )
              .join('')
          : '<div class="empty">This topic has no sections.</div>'
      }</div></div>`;
    }
    popover.hidden = false;
    const act = $('.toc-item.active', popover);
    if (act) act.scrollIntoView({ block: 'center' });
  }

  function closePopover() {
    popover.hidden = true;
    popover.innerHTML = '';
  }

  function closeOverlays() {
    emit('close');
    closePopover();
    closeSearch();
    setDrawer(false);
  }

  popover.addEventListener('click', (e) => {
    if (e.target === popover) closePopover();
  });

  /* ---------- search ---------- */

  let docs = null;
  let docsLoading = null;
  let results = [];
  let sel = 0;
  let lastQuery = '';

  function loadDocs() {
    if (docs) return Promise.resolve(docs);
    if (!docsLoading) {
      docsLoading = fetch(A.search)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.json();
        })
        .then((raw) => {
          docs = raw.map((d) => ({
            x: d.x,
            lx: d.x.toLowerCase(),
            h: d.h,
            lh: d.h.map((h) => h[1].toLowerCase()),
          }));
          return docs;
        })
        .catch((err) => {
          docsLoading = null;
          throw err;
        });
    }
    return docsLoading;
  }

  function openSearch() {
    closePopover();
    setDrawer(false);
    searchEl.hidden = false;
    qEl.value = lastQuery;
    qEl.focus(); // must happen inside the tap for iOS to raise the keyboard
    qEl.select();
    runSearch();
    loadDocs()
      .then(() => !searchEl.hidden && runSearch())
      .catch(() => {});
  }

  function closeSearch() {
    if (searchEl.hidden) return;
    searchEl.hidden = true;
    qEl.blur();
  }

  function highlight(text, tokens) {
    if (!tokens.length) return esc(text);
    const re = new RegExp(`(${tokens.map(escRe).join('|')})`, 'gi');
    return String(text)
      .split(re)
      .map((part, i) => (i % 2 ? `<mark>${esc(part)}</mark>` : esc(part)))
      .join('');
  }

  function snippet(text, at, len, tokens) {
    let start = Math.max(0, at - 70);
    let end = Math.min(text.length, at + len + 130);
    if (start > 0) start = text.indexOf(' ', start) + 1 || start;
    if (end < text.length) end = text.lastIndexOf(' ', end) > at ? text.lastIndexOf(' ', end) : end;
    return `${start > 0 ? '… ' : ''}${highlight(text.slice(start, end), tokens)}${end < text.length ? ' …' : ''}`;
  }

  function countOf(hay, needle, cap) {
    let n = 0;
    for (let i = hay.indexOf(needle); i >= 0 && n < cap; i = hay.indexOf(needle, i + needle.length)) n++;
    return n;
  }

  function runSearch() {
    const q = qEl.value.trim();
    lastQuery = q;
    if (!q) return renderSearchHome();

    const lq = q.toLowerCase();
    const tokens = lq.split(/\s+/).filter(Boolean);
    const out = [];

    for (const t of TOPICS) {
      const title = t.title.toLowerCase();
      const meta = `${t.summary} ${t.tags.join(' ')} ${SEC.get(t.section).title}`.toLowerCase();
      const d = docs && docs[t.i];
      let score = 0;
      let miss = false;
      for (const tok of tokens) {
        if (title.includes(tok)) score += 30;
        else if (meta.includes(tok)) score += 10;
        else if (d && d.lx.includes(tok)) score += 2;
        else {
          miss = true;
          break;
        }
      }
      if (miss) continue;
      if (title.includes(lq)) score += 60 + (title.startsWith(lq) ? 30 : 0) + (title === lq ? 50 : 0);

      let head = null;
      let snip = '';
      let find = '';
      if (d) {
        const hi = d.lh.findIndex((h) => tokens.every((tok) => h.includes(tok)));
        if (hi >= 0) {
          head = d.h[hi];
          score += 18;
        }
        const at = d.lx.indexOf(lq);
        if (at >= 0) {
          score += Math.min(countOf(d.lx, lq, 12), 12) * 1.5;
          snip = snippet(d.x, at, lq.length, tokens);
          find = q;
        } else {
          const tok = tokens.slice().sort((a, b) => b.length - a.length)[0];
          const at2 = d.lx.indexOf(tok);
          if (at2 >= 0 && !title.includes(tok)) {
            snip = snippet(d.x, at2, tok.length, tokens);
            find = tok;
          }
        }
      }
      out.push({ t, score, head, snip, find });
    }

    out.sort((a, b) => b.score - a.score || a.t.i - b.t.i);
    results = out.slice(0, 40);
    sel = 0;

    // Your own highlights and their notes, from annotate.js.
    const mine = searchProviders.flatMap((fn) => {
      try {
        return fn(q, tokens) || [];
      } catch {
        return [];
      }
    }).slice(0, 12);
    const mineHtml = mine.length
      ? `<div class="sr-label">Your highlights &amp; notes</div>${mine
          .map(
            (m, k) => `<a class="sr-item" href="${m.href}" data-idx="${results.length + k}"${m.mark ? ` data-mark="${esc(m.mark)}"` : ''} style="--a:${m.accent || 'var(--accent)'}">
              <div class="sr-title"><span>${highlight(m.title, tokens)}</span></div>
              <div class="sr-meta"><span class="k">${esc(m.kicker || '')}</span></div>
              <div class="sr-snip">${m.snippet}</div>
            </a>`
          )
          .join('')}`
      : '';

    if (!results.length && mine.length) {
      resultsEl.innerHTML = mineHtml;
      return;
    }
    if (!results.length) {
      resultsEl.innerHTML = `<div class="sr-empty">No topics match “${esc(q)}”.${docs ? '' : ' Full-text search is still loading…'}</div>`;
      return;
    }
    resultsEl.innerHTML =
      `<div class="sr-label">${out.length > results.length ? `Top ${results.length} of ${out.length}` : `${results.length} topic${results.length > 1 ? 's' : ''}`}</div>` +
      results
        .map((r, idx) => {
          const s = SEC.get(r.t.section);
          const target = r.head ? topicHref(r.t, r.head[0]) : topicHref(r.t);
          return `<a class="sr-item${idx === sel ? ' sel' : ''}" href="${target}" data-idx="${idx}"${!r.head && r.find ? ` data-find="${esc(r.find)}"` : ''} style="--a:${s.accent}">
            <div class="sr-title"><span>${highlight(r.t.title, tokens)}</span>${S.done[r.t.slug] ? `<span class="done-tick">${icon('check', 13, 2.6)}</span>` : ''}</div>
            <div class="sr-meta"><span class="k">${esc(s.title)}</span> · ${r.t.minutes} min</div>
            ${r.head ? `<div class="sr-head">§ ${highlight(r.head[1], tokens)}</div>` : ''}
            ${r.snip ? `<div class="sr-snip">${r.snip}</div>` : !r.head ? `<div class="sr-snip">${highlight(r.t.summary, tokens)}</div>` : ''}
          </a>`;
        })
        .join('') +
      mineHtml +
      (docs ? '' : '<div class="sr-empty">Loading full-text search…</div>');
  }

  function renderSearchHome() {
    const recent = S.recent.map((k) => TOPIC.get(k)).filter(Boolean).slice(0, 6);
    results = [];
    resultsEl.innerHTML =
      (recent.length
        ? `<div class="sr-label">Recently opened</div>${recent
            .map((t, idx) => {
              const s = SEC.get(t.section);
              return `<a class="sr-item" href="${topicHref(t)}" data-idx="${idx}" style="--a:${s.accent}"><div class="sr-title">${esc(t.title)}</div><div class="sr-meta"><span class="k">${esc(s.title)}</span> · ${t.minutes} min</div></a>`;
            })
            .join('')}`
        : '') +
      `<div class="sr-empty">Searches titles, headings and the full text of all ${TOPICS.length} topics — no connection needed.</div>`;
  }

  function moveSel(delta) {
    const items = $$('.sr-item', resultsEl);
    if (!items.length) return;
    sel = clamp(sel + delta, 0, items.length - 1);
    items.forEach((el, i) => el.classList.toggle('sel', i === sel));
    items[sel].scrollIntoView({ block: 'nearest' });
  }

  qEl.addEventListener('input', debounce(runSearch, 70));
  searchEl.addEventListener('click', (e) => {
    if (e.target === searchEl) closeSearch();
  });

  /* Scroll to (and mark) the passage a full-text hit came from. */
  function findInArticle(q) {
    const prose = $('.prose', view);
    if (!prose || !q) return false;
    const needles = [q.toLowerCase(), ...q.toLowerCase().split(/\s+/).sort((a, b) => b.length - a.length)];
    for (const needle of needles) {
      if (!needle) continue;
      const ranges = [];
      const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n && ranges.length < 300; n = walker.nextNode()) {
        const text = n.data.toLowerCase();
        for (let i = text.indexOf(needle); i >= 0 && ranges.length < 300; i = text.indexOf(needle, i + needle.length)) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + needle.length);
          ranges.push(r);
        }
      }
      if (!ranges.length) continue;
      const rect = ranges[0].getBoundingClientRect();
      if (window.Highlight && window.CSS && CSS.highlights) {
        CSS.highlights.set('atlas-hit', new Highlight(...ranges));
      } else {
        const mark = document.createElement('mark');
        mark.className = 'atlas-hit';
        try {
          ranges[0].surroundContents(mark);
        } catch {
          /* range crossed an element boundary — scrolling there is enough */
        }
      }
      window.scrollTo(0, Math.max(0, rect.top + window.scrollY - window.innerHeight * 0.3));
      return true;
    }
    return false;
  }

  function clearHighlight() {
    if (window.CSS && CSS.highlights) CSS.highlights.delete('atlas-hit');
  }

  /* ---------- actions ---------- */

  function currentTopic() {
    return current && current.name === 'topic' ? TOPIC.get(current.slug) : null;
  }

  function updateSaveBtn() {
    const btn = $('#atlas-btn-save');
    const t = currentTopic();
    const on = !!(t && S.saved[t.slug]);
    btn.classList.toggle('on', on);
    btn.setAttribute('aria-pressed', String(on));
    btn.innerHTML = icon('bookmark', 21, 1.7, on);
  }

  function toggleSaved() {
    const t = currentTopic();
    if (!t) return;
    if (S.saved[t.slug]) delete S.saved[t.slug];
    else S.saved[t.slug] = Date.now();
    save('saved');
    emitState('bookmark', t.slug);
    updateSaveBtn();
    refreshProgressMarks();
    toast(S.saved[t.slug] ? 'Bookmarked — find it in your Library.' : 'Bookmark removed.');
  }

  function toggleDone() {
    const t = currentTopic();
    if (!t) return;
    if (S.done[t.slug]) delete S.done[t.slug];
    else S.done[t.slug] = Date.now();
    save('done');
    emitState('done', t.slug);
    refreshProgressMarks();
    const el = $('#atlas-finish');
    if (el) el.outerHTML = finishHtml(t);
    if (S.done[t.slug]) {
      const next = TOPICS[t.i + 1];
      toast(
        `Done — ${doneCount()} of ${TOPICS.length}.`,
        next ? { action: 'Next topic', onAction: () => go(topicHref(next)) } : {}
      );
    }
  }

  function setConf(v) {
    const t = currentTopic();
    if (!t) return;
    if (S.conf[t.slug] === v) delete S.conf[t.slug];
    else S.conf[t.slug] = v;
    save('conf');
    emitState('conf', t.slug);
    const el = $('#atlas-finish');
    if (el) el.outerHTML = finishHtml(t);
  }

  /* The current value of one piece of study state, in the shape sync.js
     stores and the server mirrors into the website's tables. */
  function stateRecord(kind, slug) {
    const t = TOPIC.get(slug);
    const section = t ? t.section : '';
    switch (kind) {
      case 'done':
        return { data: { done: S.done[slug] || 0, section }, deleted: !S.done[slug] };
      case 'conf':
        return { data: { conf: S.conf[slug] || 0, section }, deleted: !S.conf[slug] };
      case 'bookmark':
        return { data: { section, title: t ? t.title : slug, at: S.saved[slug] || 0 }, deleted: !S.saved[slug] };
      case 'note':
        return { data: { text: S.notes[slug] || '', section }, deleted: !(S.notes[slug] || '').trim() };
    }
    return null;
  }

  function emitState(kind, slug) {
    const rec = stateRecord(kind, slug);
    if (rec) emit('state', { kind, slug, ...rec });
  }

  /* A change to study state that arrived from another device or the website. */
  function applyState(kind, slug, data, deleted) {
    if (!TOPIC.has(slug)) return;
    data = data || {};
    if (kind === 'done') {
      if (deleted || !data.done) delete S.done[slug];
      else S.done[slug] = typeof data.done === 'number' && data.done > 1 ? data.done : Date.now();
      save('done');
    } else if (kind === 'conf') {
      const v = Math.round(Number(data.conf) || 0);
      if (deleted || !v) delete S.conf[slug];
      else S.conf[slug] = Math.max(1, Math.min(3, v));
      save('conf');
    } else if (kind === 'bookmark') {
      if (deleted) delete S.saved[slug];
      else S.saved[slug] = S.saved[slug] || data.at || Date.now();
      save('saved');
    } else if (kind === 'note') {
      const text = deleted ? '' : String(data.text || '');
      if (text.trim()) S.notes[slug] = text;
      else delete S.notes[slug];
      save('notes');
    } else return;

    refreshProgressMarks();
    const t = currentTopic();
    if (!t || t.slug !== slug) return;
    if (kind === 'done' || kind === 'conf') {
      const el = $('#atlas-finish');
      if (el) el.outerHTML = finishHtml(t);
    } else if (kind === 'bookmark') updateSaveBtn();
    else if (kind === 'note') {
      const area = $('#atlas-note');
      // Never yank text out from under someone who is typing.
      if (area && document.activeElement !== area) area.value = S.notes[slug] || '';
    }
  }

  function step(delta) {
    const t = currentTopic();
    const target = t && TOPICS[t.i + delta];
    if (target) go(topicHref(target));
  }

  let noteTimer = 0;
  view.addEventListener('input', (e) => {
    if (e.target.id !== 'atlas-note') return;
    const t = currentTopic();
    if (!t) return;
    const area = e.target;
    const stateEl = $('#atlas-note-state');
    if (stateEl) stateEl.textContent = 'Saving…';
    clearTimeout(noteTimer);
    noteTimer = setTimeout(() => {
      if (area.value.trim()) S.notes[t.slug] = area.value;
      else delete S.notes[t.slug];
      save('notes');
      emitState('note', t.slug);
      const st = $('#atlas-note-state');
      if (st) st.textContent = 'Saved on this device';
    }, 350);
  });

  view.addEventListener('change', (e) => {
    if (e.target.id === 'atlas-import' && e.target.files && e.target.files[0]) importData(e.target.files[0]);
  });

  async function exportData() {
    const payload = { app: 'sysdesign-atlas', kind: 'progress', version: 2, exportedAt: new Date().toISOString() };
    for (const k of DATA_KEYS) payload[k] = S[k];
    for (const fn of exporters) {
      try {
        Object.assign(payload, await fn());
      } catch (err) {
        console.error('[atlas] export extension failed', err);
      }
    }
    const name = `atlas-progress-${dayKey()}.json`;
    const file = new File([JSON.stringify(payload, null, 2)], name, { type: 'application/json' });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      navigator.share({ files: [file], title: 'Atlas progress' }).catch(() => {});
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(file);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 1000);
  }

  function importData(file) {
    const reader = new FileReader();
    reader.onload = async () => {
      let d;
      try {
        d = JSON.parse(String(reader.result));
        if (!d || d.app !== 'sysdesign-atlas') throw new Error('not an export');
      } catch {
        toast("That file isn't an Atlas progress export.");
        return;
      }
      for (const k of DATA_KEYS) {
        if (d[k] && typeof d[k] === 'object') {
          S[k] = d[k];
          save(k);
        }
      }
      // Queue the imported study state for upload like any other change.
      for (const slug of TOPIC.keys()) for (const kind of ['done', 'conf', 'bookmark', 'note']) emitState(kind, slug);
      for (const fn of importers) {
        try {
          await fn(d);
        } catch (err) {
          console.error('[atlas] import extension failed', err);
        }
      }
      refreshProgressMarks();
      render(current);
      toast('Progress imported.');
    };
    reader.readAsText(file);
  }

  function resetData() {
    if (!confirm('Erase all progress, bookmarks and notes? If you are signed in, this clears them from your account too. Highlights and ink are not affected. This cannot be undone.')) return;
    const had = { done: { ...S.done }, conf: { ...S.conf }, bookmark: { ...S.saved }, note: { ...S.notes } };
    for (const k of DATA_KEYS) {
      S[k] = Array.isArray(S[k]) ? [] : {};
      save(k);
    }
    for (const [kind, map] of Object.entries(had)) for (const slug of Object.keys(map)) emitState(kind, slug);
    refreshProgressMarks();
    render(current);
    toast('Progress erased.');
  }

  /* ---------- toast ---------- */

  let toastTimer = 0;
  let pendingUpdate = false;

  function toast(msg, opts = {}) {
    clearTimeout(toastTimer);
    toastEl.innerHTML = `<span>${esc(msg)}</span>${opts.action ? `<button type="button">${esc(opts.action)}</button>` : ''}`;
    if (opts.action) {
      toastEl.querySelector('button').onclick = () => {
        hideToast();
        opts.onAction();
      };
    }
    toastEl.classList.add('show');
    if (!opts.sticky) toastTimer = setTimeout(hideToast, opts.ms || 3600);
  }

  function hideToast() {
    toastEl.classList.remove('show');
    // An update offer that got bumped by another message comes back.
    if (pendingUpdate) setTimeout(() => pendingUpdate && offerUpdate(), 400);
  }

  /* ---------- offline copy ---------- */

  const CONTENT_URLS = [...TOPICS.map((t) => t.file), A.search];
  const abs = (u) => new URL(u, location.href).href;
  const OFF = { state: 'checking', done: 0, total: CONTENT_URLS.length, update: false };
  let swReg = null;
  let swInstalling = false;
  let reloadOnControllerChange = false;
  let lastUpdateCheck = Date.now();

  function setOffline(state, extra) {
    Object.assign(OFF, extra || {}, { state });
    paintOffline();
  }

  function offlineSummary() {
    switch (OFF.state) {
      case 'ready':
        return `<span class="status-dot ok"></span>Available offline · all ${TOPICS.length} topics`;
      case 'downloading':
        return `<span class="status-dot busy"></span>${OFF.update ? 'Downloading update' : 'Saving for offline'}… ${OFF.done}/${OFF.total}`;
      case 'partial':
        return `<span class="status-dot bad"></span>Offline copy incomplete · ${OFF.done}/${OFF.total}`;
      case 'unsupported':
        return '<span class="status-dot"></span>Offline mode isn’t available here';
      default:
        return '<span class="status-dot"></span>Checking offline copy…';
    }
  }

  function offlineDetail() {
    const pct = OFF.total ? Math.round((OFF.done / OFF.total) * 100) : 0;
    switch (OFF.state) {
      case 'ready':
        return `<b><span class="status-dot ok"></span>Available offline</b><small>All ${TOPICS.length} topics, search and the app itself are saved on this device. Airplane mode is fine.</small>`;
      case 'downloading':
        return `<b><span class="status-dot busy"></span>${OFF.update ? 'Downloading an update' : 'Saving for offline'} — ${pct}%</b>
          <small>${OFF.done} of ${OFF.total} files. Keep the app open on Wi-Fi until this finishes.</small>
          <div class="bar-track" style="margin-top:10px"><div class="bar-fill" style="width:${pct}%"></div></div>`;
      case 'partial':
        return `<b><span class="status-dot bad"></span>Offline copy incomplete</b><small>${OFF.done} of ${OFF.total} files saved. Connect to the internet and tap Repair in Settings, or just reopen the app online.</small>`;
      case 'unsupported':
        return `<b><span class="status-dot"></span>Offline mode isn’t available</b><small>${
          location.protocol === 'https:' || location.hostname === 'localhost'
            ? 'This browser blocked the offline cache (Private Browsing does this).'
            : 'Offline mode needs the app to be served over HTTPS.'
        }</small>`;
      default:
        return '<b><span class="status-dot"></span>Checking offline copy…</b>';
    }
  }

  function paintOffline() {
    $('#atlas-sb-offline').innerHTML = offlineSummary();
    for (const el of $$('[data-offline="detail"]')) el.innerHTML = offlineDetail();
  }

  async function checkOffline() {
    if (!('caches' in window) || !('serviceWorker' in navigator)) return setOffline('unsupported');
    try {
      const hits = await Promise.all(CONTENT_URLS.map((u) => caches.match(abs(u)).then(Boolean, () => false)));
      const shell = !!(await caches.match(abs('index.html')));
      const done = hits.filter(Boolean).length;
      const complete = done === CONTENT_URLS.length && shell;
      if (complete && navigator.serviceWorker.controller) setOffline('ready', { done, update: false });
      else if (swInstalling || complete) setOffline('downloading', { done: Math.max(done, OFF.done) });
      else setOffline('partial', { done });
    } catch {
      setOffline('unsupported');
    }
  }

  async function initServiceWorker() {
    if (!('serviceWorker' in navigator) || !('caches' in window)) return setOffline('unsupported');
    const sw = navigator.serviceWorker;

    sw.addEventListener('message', (e) => {
      const m = e.data || {};
      if (m.type === 'progress') {
        swInstalling = m.done < m.total;
        setOffline('downloading', { done: m.done, total: m.total, update: !!sw.controller });
      } else if (m.type === 'activated') {
        swInstalling = false;
        checkOffline();
      } else if (m.type === 'failed') {
        swInstalling = false;
        setOffline('partial');
      }
    });
    if (sw.startMessages) sw.startMessages();

    sw.addEventListener('controllerchange', () => {
      if (reloadOnControllerChange) {
        reloadOnControllerChange = false;
        flushPosition();
        location.reload();
      } else {
        checkOffline();
      }
    });

    try {
      swReg = await sw.register('sw.js');
    } catch {
      return setOffline('unsupported');
    }
    if (!swReg) return setOffline('unsupported'); // registration refused (e.g. blocked by policy)

    const track = (w) => {
      if (!w) return;
      swInstalling = true;
      w.addEventListener('statechange', () => {
        if (w.state === 'installed') {
          swInstalling = false;
          if (sw.controller) offerUpdate();
          else checkOffline();
        } else if (w.state === 'activated' || w.state === 'redundant') {
          swInstalling = false;
          checkOffline();
        }
      });
    };
    track(swReg.installing);
    swReg.addEventListener('updatefound', () => track(swReg.installing));
    if (swReg.waiting && sw.controller) offerUpdate();

    checkOffline();
    // Ask iOS not to evict the offline copy under storage pressure.
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  }

  function offerUpdate() {
    pendingUpdate = true;
    toast('A newer version of the curriculum is ready.', {
      action: 'Reload',
      sticky: true,
      onAction: () => {
        pendingUpdate = false;
        const waiting = swReg && swReg.waiting;
        if (!waiting) return location.reload();
        reloadOnControllerChange = true;
        waiting.postMessage({ type: 'skip-waiting' });
      },
    });
  }

  function maybeCheckForUpdate() {
    if (!swReg || !navigator.onLine || Date.now() - lastUpdateCheck < 20 * 60 * 1000) return;
    lastUpdateCheck = Date.now();
    swReg.update().catch(() => {});
  }
  window.addEventListener('online', () => {
    lastUpdateCheck = 0;
    maybeCheckForUpdate();
  });

  async function checkForUpdate() {
    if (!swReg) return toast('Offline mode isn’t available here.');
    if (!navigator.onLine) return toast('You’re offline — connect to check for updates.');
    lastUpdateCheck = Date.now();
    try {
      await swReg.update();
      if (!swReg.installing && !swReg.waiting) toast('You have the latest version.');
    } catch {
      toast('Couldn’t reach the server.');
    }
  }

  async function repairOffline() {
    if (!('caches' in window)) return toast('Offline mode isn’t available here.');
    if (!navigator.onLine) return toast('Connect to the internet to repair the offline copy.');
    const cache = await caches.open('atlas-ipad-content');
    const missing = [];
    for (const u of CONTENT_URLS) if (!(await caches.match(abs(u)))) missing.push(u);
    let done = CONTENT_URLS.length - missing.length;
    let failed = 0;
    let next = 0;
    setOffline('downloading', { done, update: false });
    await Promise.all(
      Array.from({ length: 6 }, async () => {
        while (next < missing.length) {
          const u = missing[next++];
          try {
            const res = await fetch(u, { cache: 'reload' });
            if (!res.ok) throw new Error(String(res.status));
            await cache.put(abs(u), res);
            done++;
            setOffline('downloading', { done });
          } catch {
            failed++;
          }
        }
      })
    );
    if (swReg && !(await caches.match(abs('index.html')))) await swReg.update().catch(() => {});
    await checkOffline();
    toast(failed ? `${failed} files couldn't be downloaded — try again on a better connection.` : 'Offline copy is complete.');
  }

  /* ---------- input ---------- */

  document.addEventListener('click', (e) => {
    const a = e.target.closest('a[href]');
    if (a) {
      const h = a.getAttribute('href');
      if (!h.startsWith('#/') || e.metaKey || e.ctrlKey || e.shiftKey) return;
      e.preventDefault();
      if (h === location.hash && !a.dataset.find && !a.dataset.mark) {
        // Tapping where you already are just closes the drawer.
        closeOverlays();
        return;
      }
      go(h, { resume: a.hasAttribute('data-resume'), find: a.dataset.find || '', mark: a.dataset.mark || '' });
      return;
    }

    const btn = e.target.closest('button');
    if (!btn) return;
    if (btn.hasAttribute('data-open-search')) return openSearch();
    if (btn.hasAttribute('data-close-search')) return closeSearch();
    if (btn.dataset.pref) return setPref(btn.dataset.pref, btn.dataset.val);
    if (btn.dataset.toc) {
      closePopover();
      scrollToId(btn.dataset.toc, true);
      return;
    }
    if (btn.dataset.conf) return setConf(Number(btn.dataset.conf));
    if (btn.classList.contains('sb-toggle')) {
      const sec = btn.closest('.sb-sec');
      sec.classList.toggle('open');
      S.open[sec.dataset.sec] = sec.classList.contains('open');
      save('open');
      return;
    }
    switch (btn.dataset.act) {
      case 'done':
        return toggleDone();
      case 'resume': {
        const t = currentTopic();
        const pill = $('#atlas-resume');
        if (pill) pill.remove();
        if (t) scrollToFraction(S.pos[t.slug] || 0, true);
        return;
      }
      case 'retry':
        return render(current);
      case 'repair':
        return repairOffline();
      case 'update':
        return checkForUpdate();
      case 'export':
        return exportData();
      case 'import':
        return $('#atlas-import').click();
      case 'reset':
        return resetData();
    }
  });

  $('#atlas-btn-menu').addEventListener('click', toggleSidebar);
  $('#atlas-btn-back').addEventListener('click', () => history.back());
  $('#atlas-btn-save').addEventListener('click', toggleSaved);
  $('#atlas-btn-toc').addEventListener('click', () => openPopover('toc'));
  $('#atlas-btn-text').addEventListener('click', () => openPopover('text'));
  $('#atlas-scrim').addEventListener('click', () => setDrawer(false));
  wideMQ.addEventListener('change', () => {
    setDrawer(false);
    updateMenuIcon();
  });

  // Hardware keyboard (Magic Keyboard / Smart Keyboard Folio).
  document.addEventListener('keydown', (e) => {
    if (!searchEl.hidden) {
      if (e.key === 'Escape') {
        e.preventDefault();
        closeSearch();
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        moveSel(e.key === 'ArrowDown' ? 1 : -1);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const a = $(`.sr-item[data-idx="${sel}"]`, resultsEl) || $('.sr-item', resultsEl);
        if (a) a.click();
      }
      return;
    }
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      openSearch();
      return;
    }
    if (e.target.closest && e.target.closest('input, textarea, select')) return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const topic = !!currentTopic();
    switch (e.key) {
      case '/':
        e.preventDefault();
        openSearch();
        break;
      case 'Escape':
        closeOverlays();
        break;
      case '[':
        step(-1);
        break;
      case ']':
        step(1);
        break;
      case '\\':
        toggleSidebar();
        break;
      case 't':
        if (topic) openPopover('toc');
        break;
      case 'd':
        if (topic) toggleDone();
        break;
      case 'b':
        if (topic) toggleSaved();
        break;
    }
  });

  /* ---------- public surface for sync.js and annotate.js ---------- */

  window.Atlas = {
    data: A,
    topics: TOPICS,
    sections: SECTIONS,
    topic: (slug) => TOPIC.get(slug),
    section: (slug) => SEC.get(slug),
    current: () => current,
    currentTopic,
    prefs: () => ({ ...S.prefs }),
    previewPrefs,
    readFraction,
    scrollToFraction,
    go,
    toast,
    icon,
    esc,
    topicHref,
    fmtDate,
    isWide,
    stateRecord,
    applyState,
    searchOpen: () => !searchEl.hidden,
    on,
    preparers,
    searchProviders,
    exporters,
    importers,
  };

  /* ---------- boot ---------- */

  $('#atlas-btn-back').innerHTML = icon('back', 22, 2);
  $('#atlas-btn-toc').innerHTML = icon('toc', 21);
  $('#atlas-btn-text').innerHTML = icon('text', 22, 1.6);
  $('#atlas-btn-search').innerHTML = icon('search', 21);
  applyPrefs();
  updateMenuIcon();
  buildSidebar();
  paintOffline();

  if (!history.state || typeof history.state.d !== 'number') history.replaceState({ d: 0 }, '');

  // A Home Screen app relaunched after iOS evicted it starts at the start URL.
  // If the reader was in the middle of something recently, put them back.
  function boot() {
    const startHash = location.hash;
    if ((!startHash || startHash === '#/') && S.last && S.last.hash && S.last.hash !== '#/' && Date.now() - S.last.at < 12 * 3600 * 1000) {
      history.replaceState({ d: 0 }, '', S.last.hash);
      render(parse(S.last.hash), { resume: true });
    } else {
      render(parse(startHash), { y: history.state && history.state.y, resume: true });
    }
    initServiceWorker();
  }

  // The extension scripts load after this one; wait for them so the first
  // page already has their hooks.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
