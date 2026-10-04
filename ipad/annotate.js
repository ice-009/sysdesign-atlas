/* Highlights, ink and sketch cards on topic pages — Apple Pencil first.

   How marks survive reflow (text size, typeface, spacing, width, rotation,
   window size) and content edits:

     Highlight   saved as the words themselves: position + exact quote + ~32
                 characters of context either side. Re-found in four steps:
                 exact position → same quote elsewhere (context picks the
                 right one) → close match → "Needs a new home" tray.
     Ink         every stroke belongs to a group (strokes drawn close together
                 in time and space). A group is anchored to the WORD under its
                 centre, or to the paragraph beside it when drawn in the
                 margin, and its points are stored in em relative to that
                 anchor — so it follows the word and scales with the text.
     Sketch card a drawing pad after a paragraph; its strokes are in units of
                 the card's width, so it scales as a whole and never distorts.

   Stored points are never rewritten by layout; placement is recomputed every
   time the page is drawn. The stroke being drawn is checkpointed every 250 ms
   so iOS closing the app can't lose more than that.

   Text positions come from one canonical walk over the article's text nodes
   that skips everything this file injects ([data-atlas-ui]), so cards, trays
   and markers never shift the offsets. */

(function () {
  'use strict';

  const Atlas = window.Atlas;
  const Store = window.AtlasStore;
  if (!Atlas || !Store) return;

  const esc = Atlas.esc;
  const icon = Atlas.icon;
  const view = document.getElementById('atlas-view');
  const root = document.documentElement;
  const SVGNS = 'http://www.w3.org/2000/svg';
  const HAS_HIGHLIGHTS = !!(window.CSS && CSS.highlights && window.Highlight);

  const HL = ['yellow', 'green', 'blue', 'pink'];
  const PENS = ['ink', 'red', 'blue', 'green', 'marker'];
  const MARKER_WIDTH = 2.8; // a marker stroke is this many times the pen width
  // Page parts outside the article body that ink can hang on, by class name.
  const REGION_KEYS = ['crumbs', 'topic-title', 'topic-summary', 'badges', 'prereq', 'finish', 'notes', 'pn'];
  const SIZES = { fine: 0.075, medium: 0.12, bold: 0.2 }; // stroke width, em
  const MARK_KINDS = new Set(['highlight', 'stroke', 'card']);
  const GROUP_GAP_MS = 1600;
  const GROUP_DIST_EM = 4;
  const CTX = 32;
  const KEEP_DELETED_DAYS = 30;

  /* ---------- tool state (per device) ---------- */

  const TOOL_KEY = 'atlas.ink';
  const tool = { mode: 'read', hl: 'yellow', pen: 'ink', size: 'medium', open: false, finger: false, lastTool: 'pen', margin: false };
  try {
    Object.assign(tool, JSON.parse(localStorage.getItem(TOOL_KEY) || '{}'));
  } catch {
    /* defaults */
  }
  const saveTool = () => {
    try {
      localStorage.setItem(TOOL_KEY, JSON.stringify(tool));
    } catch {
      /* not persisted this session */
    }
  };

  /* ---------- small utilities ---------- */

  const now = () => Date.now();
  const clone = (r) => (r ? JSON.parse(JSON.stringify(r)) : r);
  const prefSig = (p) => `${p.size}|${p.font}|${p.leading}|${p.width}`;
  const deleted = (r) => ({ ...r, deleted: true, data: { ...r.data, del: now() } });
  const restored = (r) => {
    const data = { ...r.data };
    delete data.del;
    return { ...r, deleted: false, data };
  };
  function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  }
  function commonPrefix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[i] === b[i]) i++;
    return i;
  }
  function commonSuffix(a, b) {
    let i = 0;
    while (i < a.length && i < b.length && a[a.length - 1 - i] === b[b.length - 1 - i]) i++;
    return i;
  }
  function levenshtein(a, b) {
    if (a === b) return 0;
    let prev = new Array(b.length + 1);
    let cur = new Array(b.length + 1);
    for (let j = 0; j <= b.length; j++) prev[j] = j;
    for (let i = 1; i <= a.length; i++) {
      cur[0] = i;
      for (let j = 1; j <= b.length; j++) {
        cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      }
      [prev, cur] = [cur, prev];
    }
    return prev[b.length];
  }
  const clip = (s) => (s.length > 400 ? s.slice(0, 200) + s.slice(-200) : s);
  function similarity(a, b) {
    if (a === b) return 1;
    const A = clip(a);
    const B = clip(b);
    return 1 - levenshtein(A, B) / Math.max(A.length, B.length, 1);
  }

  /* ---------- per-topic state ---------- */

  let T = null; // the topic currently on screen
  const prepared = new Map(); // slug → records preloaded during the topic fetch
  let undoStack = [];
  let redoStack = [];
  let lastGroup = null; // for joining strokes into one group
  let pendingReplace = null; // highlight id waiting to be re-attached
  let pendingPlace = null; // ink group id waiting to be placed
  let previewing = false; // "Show as drawn" active

  Atlas.preparers.push(async (topic) => {
    prepared.set(topic.slug, await Store.byTopic(topic.slug));
  });

  Atlas.on('leave', teardown);
  Atlas.on('close', closeMenus);
  Atlas.on('paint', ({ topic }) => {
    if (topic) setup(topic);
    syncTray();
  });
  Atlas.on('render', ({ route, topic, opts }) => {
    if (topic && T && opts && opts.mark) jumpToMark(opts.mark);
    if (route.name === 'library') paintLibrary();
    if (route.name === 'settings') paintPencilSettings();
    syncTray();
  });
  Atlas.on('prefs', () => scheduleLayout());

  /* ---------- text index ---------- */

  function buildIndex(prose) {
    const nodes = [];
    const starts = [];
    const pos = new Map();
    let text = '';
    const walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.parentElement && n.parentElement.closest('.anchor, [data-atlas-ui], style, script')
          ? NodeFilter.FILTER_REJECT
          : NodeFilter.FILTER_ACCEPT,
    });
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      pos.set(n, nodes.length);
      nodes.push(n);
      starts.push(text.length);
      text += n.data;
    }
    return { text, nodes, starts, pos };
  }

  const index = () => (T.ix || (T.ix = buildIndex(T.prose)));

  function locate(ix, at) {
    let lo = 0;
    let hi = ix.starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (ix.starts[mid] <= at) lo = mid;
      else hi = mid - 1;
    }
    const node = ix.nodes[lo];
    return [node, Math.max(0, Math.min(at - ix.starts[lo], node.data.length))];
  }

  function rangeOf(s, e) {
    const ix = index();
    const r = document.createRange();
    const [a, ao] = locate(ix, s);
    const [b, bo] = locate(ix, e);
    r.setStart(a, ao);
    r.setEnd(b, bo);
    return r;
  }

  function offsetOf(node, offset) {
    const ix = index();
    if (node.nodeType === 3) {
      const i = ix.pos.get(node);
      return i == null ? -1 : ix.starts[i] + offset;
    }
    // An element position: the first indexed text at or after it.
    const probe = node.childNodes[offset] || node;
    for (let i = 0; i < ix.nodes.length; i++) {
      const rel = probe.compareDocumentPosition(ix.nodes[i]);
      if (probe === ix.nodes[i] || rel & Node.DOCUMENT_POSITION_FOLLOWING || rel & Node.DOCUMENT_POSITION_CONTAINED_BY) {
        return ix.starts[i];
      }
    }
    return ix.text.length;
  }

  /* Text offset under a point, or -1. Tries both caret APIs: Safari has
     shipped each at different times and either can come back empty. */
  function caretAt(x, y) {
    const tries = [];
    if (document.caretPositionFromPoint) {
      tries.push(() => {
        const p = document.caretPositionFromPoint(x, y);
        return p && [p.offsetNode, p.offset];
      });
    }
    if (document.caretRangeFromPoint) {
      tries.push(() => {
        const r = document.caretRangeFromPoint(x, y);
        return r && [r.startContainer, r.startOffset];
      });
    }
    for (const attempt of tries) {
      let hit = null;
      try {
        hit = attempt();
      } catch {
        hit = null;
      }
      if (!hit || !hit[0] || !T.prose.contains(hit[0])) continue;
      const el = hit[0].nodeType === 1 ? hit[0] : hit[0].parentElement;
      if (el && el.closest('[data-atlas-ui]')) continue;
      const at = offsetOf(hit[0], hit[1]);
      if (at >= 0) return at;
    }
    return -1;
  }

  const WORD = /[\p{L}\p{N}_'’]/u;

  function wordAt(text, at) {
    let s = at;
    if (!WORD.test(text[s] || '')) {
      if (WORD.test(text[s - 1] || '')) s = at - 1;
      else return null;
    }
    let e = s;
    while (s > 0 && WORD.test(text[s - 1])) s--;
    while (e < text.length && WORD.test(text[e])) e++;
    return [s, e];
  }

  /* Grow a pen swipe to whole words and drop surrounding whitespace. */
  function snap(text, a, b) {
    let s = Math.min(a, b);
    let e = Math.max(a, b);
    while (s > 0 && WORD.test(text[s - 1]) && WORD.test(text[s] || ' ')) s--;
    while (e < text.length && WORD.test(text[e]) && WORD.test(text[e - 1] || ' ')) e++;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return [s, e];
  }

  /* ---------- text anchors ---------- */

  function textAnchor(s, e) {
    const text = index().text;
    return { s, e, q: text.slice(s, e), pre: text.slice(Math.max(0, s - CTX), s), suf: text.slice(e, e + CTX) };
  }

  function contextScore(text, s, e, a) {
    return commonSuffix(text.slice(Math.max(0, s - CTX), s), a.pre || '') + commonPrefix(text.slice(e, e + CTX), a.suf || '');
  }

  function trimSpan(text, [s, e]) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return e > s ? [s, e] : null;
  }

  /* The four-step re-attach. Returns [start, end] or null (→ tray). */
  function resolveText(a) {
    if (!a || !a.q) return null;
    const text = index().text;
    // 1. Exact: same words at the same place.
    if (text.slice(a.s, a.e) === a.q) return [a.s, a.e];
    // 2. Same words elsewhere; the surrounding context picks the occurrence.
    const len = a.q.length;
    // A single word (what ink hangs on) occurs all over a page, so a short
    // quote only counts as found if some of its surroundings came with it —
    // otherwise a circle would jump to the same word in another paragraph.
    const short = len < 12;
    let best = null;
    let bestScore = -Infinity;
    for (let i = text.indexOf(a.q); i >= 0; i = text.indexOf(a.q, i + 1)) {
      const ctx = contextScore(text, i, i + len, a);
      if (short && ctx < 8) continue;
      const score = ctx - Math.abs(i - a.s) / 1e6;
      if (score > bestScore) {
        bestScore = score;
        best = [i, i + len];
      }
    }
    if (best) return best;
    if (short) return null;
    // 3. Close match, for passages that were lightly reworded.
    return fuzzy(text, a);
  }

  function fuzzy(text, a) {
    const q = a.q;
    const len = q.length;
    if (len < 6) return null; // a single short word is too ambiguous to guess
    const k = Math.min(16, Math.max(4, Math.floor(len / 3)));
    const head = q.slice(0, k);
    const tail = q.slice(-k);
    const cands = [];
    for (let i = text.indexOf(head); i >= 0 && cands.length < 60; i = text.indexOf(head, i + 1)) {
      const j = text.indexOf(tail, i + Math.max(k, Math.floor(len * 0.5) - k));
      cands.push(j >= 0 && j <= i + Math.ceil(len * 1.6) ? [i, j + k] : [i, Math.min(text.length, i + len)]);
    }
    for (let j = text.indexOf(tail); j >= 0 && cands.length < 120; j = text.indexOf(tail, j + 1)) {
      cands.push([Math.max(0, j + k - len), j + k]);
    }
    if ((a.pre || '').length >= 10) {
      const p = text.indexOf(a.pre);
      if (p >= 0) cands.push([p + a.pre.length, Math.min(text.length, p + a.pre.length + len)]);
    }
    if ((a.suf || '').length >= 10) {
      const p = text.indexOf(a.suf);
      if (p >= 0) cands.push([Math.max(0, p - len), p]);
    }
    let best = null;
    let bestSim = 0;
    for (const span of cands) {
      const sim = similarity(text.slice(span[0], span[1]), q);
      if (sim > bestSim) {
        bestSim = sim;
        best = span;
      }
    }
    // 4. Not close enough: the caller sends the mark to the tray.
    return best && bestSim >= 0.72 ? trimSpan(text, best) : null;
  }

  /* ---------- block anchors (margin ink, sketch cards) ---------- */

  function blocks() {
    if (!T.blocks) {
      T.blocks = Array.from(T.prose.children)
        .filter((el) => !el.hasAttribute('data-atlas-ui'))
        .map((el) => {
          const t = el.textContent.replace(/\s+/g, ' ').trim();
          return { el, t, h: hash(t) };
        });
    }
    return T.blocks;
  }

  function blockAnchor(el) {
    const list = blocks();
    const i = list.findIndex((b) => b.el === el);
    const b = list[i];
    return { i, h: b.h, q: b.t.slice(0, 80) };
  }

  function resolveBlock(a) {
    if (!a) return null;
    const list = blocks();
    if (list[a.i] && list[a.i].h === a.h) return list[a.i].el;
    const same = list.find((b) => b.h === a.h);
    if (same) return same.el;
    if ((a.q || '').length >= 12) {
      let best = null;
      let bestSim = 0;
      for (const b of list) {
        const sim = similarity(b.t.slice(0, 80), a.q);
        if (sim > bestSim) {
          bestSim = sim;
          best = b.el;
        }
      }
      if (bestSim >= 0.7) return best;
    }
    return null;
  }

  /* Everything on the page ink can hang on, top to bottom: the header parts,
     every block of the article body, and the end-of-topic sections. */
  function regions() {
    const out = [];
    for (const el of T.article.children) {
      if (el === T.prose) {
        for (const b of blocks()) out.push({ el: b.el, block: true });
        continue;
      }
      const key = REGION_KEYS.find((k) => el.classList.contains(k));
      if (key) out.push({ el, key });
    }
    return out;
  }

  function regionAtY(y) {
    let best = null;
    let dist = Infinity;
    for (const r of regions()) {
      const rect = r.el.getBoundingClientRect();
      if (y >= rect.top && y <= rect.bottom) return r;
      const d = Math.min(Math.abs(y - rect.top), Math.abs(y - rect.bottom));
      if (d < dist) {
        dist = d;
        best = r;
      }
    }
    return best;
  }

  function resolveTarget(a) {
    if (!a) return null;
    if (a.t === 'w') return resolveText(a);
    if (a.t === 'b') return resolveBlock(a);
    if (a.t === 'e') return REGION_KEYS.includes(a.k) ? T.article.querySelector(`:scope > .${a.k}`) : null;
    return null;
  }

  function blockAtY(y) {
    let best = null;
    let dist = Infinity;
    for (const b of blocks()) {
      const r = b.el.getBoundingClientRect();
      if (y >= r.top && y <= r.bottom) return b.el;
      const d = Math.min(Math.abs(y - r.top), Math.abs(y - r.bottom));
      if (d < dist) {
        dist = d;
        best = b.el;
      }
    }
    return best;
  }

  /* ---------- setup / teardown ---------- */

  function setup(topic) {
    teardown();
    const article = view.querySelector('article.topic');
    const prose = article && article.querySelector('.prose');
    if (!prose) return;

    T = { topic, slug: topic.slug, article, prose, recs: new Map(), res: new Map(), hits: [], ix: null, blocks: null };
    for (const r of prepared.get(topic.slug) || []) if (MARK_KINDS.has(r.kind)) T.recs.set(r.id, r);
    prepared.delete(topic.slug);

    T.top = document.createElement('div');
    T.top.className = 'atlas-ink-top';
    T.top.setAttribute('data-atlas-ui', '');
    article.insertBefore(T.top, prose);

    T.layer = document.createElementNS(SVGNS, 'svg');
    T.layer.setAttribute('class', 'atlas-ink-layer');
    T.layer.setAttribute('data-atlas-ui', '');
    T.layer.setAttribute('aria-hidden', 'true');
    article.appendChild(T.layer);

    T.markers = document.createElement('div');
    T.markers.className = 'atlas-markers';
    T.markers.setAttribute('data-atlas-ui', '');
    article.appendChild(T.markers);

    resolveAll();
    renderCards();
    paintHighlights();
    layout();

    T.ro = new ResizeObserver(() => scheduleLayout());
    T.ro.observe(prose);
    applyModeClass();
  }

  function teardown() {
    finishGesture(true);
    closeMenus();
    if (previewing) {
      previewing = false;
      Atlas.previewPrefs(null);
    }
    if (HAS_HIGHLIGHTS) {
      for (const c of HL) CSS.highlights.delete(`atlas-hl-${c}`);
      CSS.highlights.delete('atlas-hl-preview');
      CSS.highlights.delete('atlas-hl-flash');
    }
    if (T && T.ro) T.ro.disconnect();
    T = null;
    undoStack = [];
    redoStack = [];
    lastGroup = null;
    pendingPlace = null;
    pendingReplace = null;
    root.classList.remove('ink-placing');
  }

  /* ---------- resolving and drawing ---------- */

  const live = (kind) => [...T.recs.values()].filter((r) => r.kind === kind && !r.deleted);

  function groupsOf(strokes) {
    const groups = new Map();
    for (const s of strokes) {
      const g = s.data.g || s.id;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    return groups;
  }

  /* Work out where every mark belongs in the current text. Run when the page
     is set up and when marks change; layout() then turns that into pixels. */
  function resolveAll() {
    T.res.clear();
    T.orphans = [];
    for (const h of live('highlight')) {
      const span = resolveText(h.data.a);
      T.res.set(h.id, span);
      if (!span) T.orphans.push({ kind: 'highlight', rec: h });
    }
    const pageStrokes = live('stroke').filter((s) => s.data.a && s.data.a.t !== 'c');
    for (const [g, strokes] of groupsOf(pageStrokes)) {
      const target = resolveTarget(strokes[0].data.a);
      T.res.set(`g:${g}`, target);
      if (!target) T.orphans.push({ kind: 'ink', g, strokes });
    }
    for (const c of live('card')) {
      const el = resolveBlock(c.data.a);
      T.res.set(c.id, el);
      if (!el) T.orphans.push({ kind: 'card', rec: c });
    }
  }

  function emPx() {
    return parseFloat(getComputedStyle(T.prose).fontSize) || 17.5;
  }

  /* Pixel origin (article coordinates) and unit for an anchor right now. */
  function originOf(a, target, art, em) {
    if (a.t === 'w') {
      if (!target) return null;
      const r = rangeOf(target[0], target[1]);
      const rect = r.getClientRects()[0] || r.getBoundingClientRect();
      return { x: rect.left - art.left, y: rect.top - art.top, unit: em };
    }
    if (a.t === 'b' || a.t === 'e') {
      if (!target) return null;
      const rect = target.getBoundingClientRect();
      if (a.u === 'w') return { x: rect.left - art.left, y: rect.top - art.top, unit: rect.width };
      // Margin ink is measured from the nearer edge of the text column, so it
      // stays in the margin however wide or narrow the column becomes.
      const pr = T.prose.getBoundingClientRect();
      return { x: (a.side === 'r' ? pr.right : pr.left) - art.left, y: rect.top - art.top, unit: em };
    }
    return null;
  }

  function decode(p) {
    const out = [];
    let x = 0;
    let y = 0;
    let q = 0;
    for (let i = 0; i + 2 < p.length; i += 3) {
      x += p[i];
      y += p[i + 1];
      q += p[i + 2];
      out.push([x / 100, y / 100, q / 100]);
    }
    return out;
  }

  function encode(points) {
    const out = [];
    let px = 0;
    let py = 0;
    let pq = 0;
    for (const [x, y, q] of points) {
      const ix = Math.round(x * 100);
      const iy = Math.round(y * 100);
      const iq = Math.round(q * 100);
      out.push(ix - px, iy - py, iq - pq);
      px = ix;
      py = iy;
      pq = iq;
    }
    return out;
  }

  /* Variable-width ink outline (pressure, with a light taper at both ends).
     points: [[x, y, pressure 0..1]] in px; size: nominal width in px. */
  function outline(points, size, flat = false) {
    if (!points.length) return '';
    const pts = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = pts[pts.length - 1];
      const p = points[i];
      if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 0.35 && i < points.length - 1) continue;
      // light smoothing so 240 Hz jitter doesn't show
      pts.push([prev[0] + (p[0] - prev[0]) * 0.65, prev[1] + (p[1] - prev[1]) * 0.65, p[2]]);
    }
    const last = points[points.length - 1];
    pts.push(last);
    const pressures = pts.map((p) => p[2]);
    const varies = !flat && Math.max(...pressures) - Math.min(...pressures) > 0.08;
    const n = pts.length;
    const r = pts.map((p, i) => {
      const press = varies ? 0.45 + 0.85 * p[2] : 1;
      const taper = flat ? 1 : Math.min(1, 0.55 + 0.15 * Math.min(i, n - 1 - i));
      return Math.max(0.35, (size / 2) * press * taper);
    });
    if (n < 3) {
      const [x, y] = pts[0];
      const rr = (size / 2).toFixed(2);
      return `M${(x - +rr).toFixed(2)} ${y.toFixed(2)}a${rr} ${rr} 0 1 0 ${(2 * rr).toFixed(2)} 0a${rr} ${rr} 0 1 0 ${(-2 * rr).toFixed(2)} 0Z`;
    }
    const L = [];
    const R = [];
    for (let i = 0; i < n; i++) {
      const a = pts[Math.max(0, i - 1)];
      const b = pts[Math.min(n - 1, i + 1)];
      let dx = b[0] - a[0];
      let dy = b[1] - a[1];
      const d = Math.hypot(dx, dy) || 1;
      dx /= d;
      dy /= d;
      L.push([pts[i][0] - dy * r[i], pts[i][1] + dx * r[i]]);
      R.push([pts[i][0] + dy * r[i], pts[i][1] - dx * r[i]]);
    }
    const f = (v) => v.toFixed(2);
    const curve = (arr) => {
      let d = '';
      for (let i = 1; i < arr.length - 1; i++) {
        const mx = (arr[i][0] + arr[i + 1][0]) / 2;
        const my = (arr[i][1] + arr[i + 1][1]) / 2;
        d += `Q${f(arr[i][0])} ${f(arr[i][1])} ${f(mx)} ${f(my)}`;
      }
      const e = arr[arr.length - 1];
      return d + `L${f(e[0])} ${f(e[1])}`;
    };
    const Rr = R.slice().reverse();
    return (
      `M${f(L[0][0])} ${f(L[0][1])}` +
      curve(L) +
      `A${f(r[n - 1])} ${f(r[n - 1])} 0 0 1 ${f(Rr[0][0])} ${f(Rr[0][1])}` +
      curve(Rr) +
      `A${f(r[0])} ${f(r[0])} 0 0 1 ${f(L[0][0])} ${f(L[0][1])}Z`
    );
  }

  function pathEl(d, pen, id) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', `pen-${PENS.includes(pen) ? pen : 'ink'}`);
    if (id) p.dataset.id = id;
    return p;
  }

  let layoutQueued = false;
  function scheduleLayout() {
    if (layoutQueued || !T) return;
    layoutQueued = true;
    requestAnimationFrame(() => {
      layoutQueued = false;
      if (T) layout();
    });
  }

  /* Turn resolved anchors into pixels. Cheap enough to run on every resize. */
  function layout() {
    if (!T) return;
    const art = T.article.getBoundingClientRect();
    const em = emPx();
    T.em = em;
    T.layer.replaceChildren();
    T.hits = [];

    const strokes = live('stroke');
    for (const [g, group] of groupsOf(strokes.filter((s) => s.data.a && s.data.a.t !== 'c'))) {
      const a = group[0].data.a;
      const o = originOf(a, T.res.get(`g:${g}`), art, em);
      if (!o) continue;
      for (const s of group) {
        const pts = decode(s.data.p || []).map(([x, y, q]) => [o.x + x * o.unit, o.y + y * o.unit, q]);
        const width = (s.data.w || SIZES.medium) * em;
        T.layer.appendChild(pathEl(outline(pts, width, s.data.c === 'marker'), s.data.c, s.id));
        T.hits.push(hitBox(s.id, pts, width));
      }
    }

    // Notes written with Margin on can run past the screen edge without it.
    T.offscreen = !tool.margin && T.hits.some((h) => art.left + h.box[2] > window.innerWidth - 4);

    paintCardStrokes();
    paintMarkers(art);
    paintTop();
  }

  function hitBox(id, pts, width) {
    let x0 = Infinity;
    let y0 = Infinity;
    let x1 = -Infinity;
    let y1 = -Infinity;
    for (const [x, y] of pts) {
      if (x < x0) x0 = x;
      if (y < y0) y0 = y;
      if (x > x1) x1 = x;
      if (y > y1) y1 = y;
    }
    return { id, pts, w: width, box: [x0, y0, x1, y1] };
  }

  function paintHighlights() {
    if (!T || !HAS_HIGHLIGHTS) return;
    const by = { yellow: [], green: [], blue: [], pink: [] };
    for (const h of live('highlight')) {
      const span = T.res.get(h.id);
      if (span) (by[h.data.c] || by.yellow).push(rangeOf(span[0], span[1]));
    }
    for (const c of HL) {
      if (by[c].length) CSS.highlights.set(`atlas-hl-${c}`, new Highlight(...by[c]));
      else CSS.highlights.delete(`atlas-hl-${c}`);
    }
  }

  /* A small note marker in the right margin beside every highlight that has
     a note — tap it to read or edit the note. */
  function paintMarkers(art) {
    T.markers.replaceChildren();
    const pr = T.prose.getBoundingClientRect();
    for (const h of live('highlight')) {
      if (!(h.data.n || '').trim()) continue;
      const span = T.res.get(h.id);
      if (!span) continue;
      const rect = rangeOf(span[0], span[1]).getClientRects()[0];
      if (!rect) continue;
      const b = document.createElement('button');
      b.type = 'button';
      b.className = `atlas-marker hl-${h.data.c}`;
      b.dataset.hl = h.id;
      b.setAttribute('aria-label', 'Highlight note');
      b.style.left = `${pr.right - art.left + 6}px`;
      b.style.top = `${rect.top - art.top + rect.height / 2 - 13}px`;
      b.innerHTML = icon('note', 15, 1.8);
      T.markers.appendChild(b);
    }
  }

  /* ---------- sketch cards ---------- */

  function renderCards() {
    for (const el of T.prose.querySelectorAll('.atlas-card')) el.remove();
    const cards = live('card').sort((a, b) => (a.data.at || 0) - (b.data.at || 0));
    for (const c of cards) {
      const after = T.res.get(c.id);
      if (!after) continue;
      const h = c.data.h || 0.5;
      const el = document.createElement('div');
      el.className = 'atlas-card';
      el.setAttribute('data-atlas-ui', '');
      el.dataset.card = c.id;
      el.innerHTML = `<div class="atlas-card-head"><span>${icon('note', 14)} Writing space</span>
          <button type="button" data-card-act="size" aria-label="Change height">${h >= 0.85 ? 'Shorter' : 'Taller'}</button>
          <button type="button" data-card-act="delete" aria-label="Delete sketch">Delete</button></div>
        <svg class="atlas-card-pad" viewBox="0 0 1000 ${Math.round(h * 1000)}" preserveAspectRatio="xMidYMid meet"></svg>`;
      // Several cards after one paragraph keep their creation order.
      let ref = after.nextSibling;
      while (ref && ref.nodeType === 1 && ref.classList.contains('atlas-card')) ref = ref.nextSibling;
      T.prose.insertBefore(el, ref);
    }
  }

  function paintCardStrokes() {
    T.cardHits = [];
    for (const el of T.prose.querySelectorAll('.atlas-card')) {
      const pad = el.querySelector('.atlas-card-pad');
      pad.replaceChildren();
      const id = el.dataset.card;
      for (const s of live('stroke')) {
        if (!s.data.a || s.data.a.t !== 'c' || s.data.a.c !== id) continue;
        const pts = decode(s.data.p || []).map(([x, y, q]) => [x * 10, y * 10, q]); // tenths → card units
        pad.appendChild(pathEl(outline(pts, s.data.w || 4, s.data.c === 'marker'), s.data.c, s.id));
        T.cardHits.push({ card: id, ...hitBox(s.id, pts, s.data.w || 4) });
      }
    }
  }

  async function addCard() {
    if (!T) return;
    const el = blockAtY(window.innerHeight * 0.45);
    if (!el) return;
    const rec = { id: Store.newId('c'), kind: 'card', topic: T.slug, data: { a: blockAnchor(el), h: 0.5, at: now() } };
    await commit([rec], [null]);
    setMode('pen');
    const card = T.prose.querySelector(`.atlas-card[data-card="${rec.id}"]`);
    if (card) card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    Atlas.toast('Space added — write in it with the Pencil. It grows as you reach the bottom.');
  }

  /* ---------- the strip above the article: tray, show-as-drawn ---------- */

  function thumb(strokes) {
    const all = strokes.flatMap((s) => decode(s.data.p || []));
    if (!all.length) return '';
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - x0);
    const h = Math.max(1, Math.max(...ys) - y0);
    const scale = Math.min(110 / w, 44 / h);
    const paths = strokes
      .map((s) => {
        const pts = decode(s.data.p || []).map(([x, y, q]) => [(x - x0) * scale + 3, (y - y0) * scale + 3, q]);
        return `<path class="pen-${esc(s.data.c || 'ink')}" d="${outline(pts, Math.max(1.4, (s.data.w || 0.12) * scale))}"/>`;
      })
      .join('');
    return `<svg class="atlas-thumb" viewBox="0 0 ${Math.ceil(w * scale) + 6} ${Math.ceil(h * scale) + 6}" aria-hidden="true">${paths}</svg>`;
  }

  function paintTop() {
    const parts = [];
    const cw = Math.round(T.prose.getBoundingClientRect().width);
    const sig = prefSig(Atlas.prefs());

    if (previewing) {
      parts.push(`<div class="atlas-chip">${icon('layers', 16)}<span>Showing ink with the text settings it was drawn in.</span>
        <button type="button" class="btn small" data-ink-act="unpreview">Back to my settings</button></div>`);
    } else {
      const groups = groupsOf(live('stroke').filter((s) => s.data.a && s.data.a.t !== 'c'));
      let differs = null;
      for (const [g, strokes] of groups) {
        const c = strokes[0].data.ctx;
        if (!c || !T.res.get(`g:${g}`)) continue;
        if (c.pr !== sig || Math.abs(c.cw - cw) / c.cw > 0.08) {
          if (!differs || (strokes[0].data.at || 0) > (differs.at || 0)) differs = { ...c, at: strokes[0].data.at };
        }
      }
      if (differs) {
        T.drawnCtx = differs;
        parts.push(`<div class="atlas-chip">${icon('layers', 16)}<span>Some ink was drawn with different text settings, so it may sit slightly differently now.</span>
          <button type="button" class="btn small" data-ink-act="preview">Show as drawn</button></div>`);
      }
    }

    if (T.offscreen && !previewing) {
      parts.push(`<div class="atlas-chip">${icon('layers', 16)}<span>Some of your margin notes run past the edge of the screen.</span>
        <button type="button" class="btn small" data-ink-act="margin-on">Show margin</button></div>`);
    }

    if (T.orphans.length) {
      const items = T.orphans
        .map((o) => {
          if (o.kind === 'highlight') {
            return `<li><span class="dot hl-${esc(o.rec.data.c)}"></span><q>${esc((o.rec.data.a.q || '').slice(0, 160))}</q>
              <span class="acts"><button type="button" class="btn small" data-orphan="replace" data-id="${o.rec.id}">Place again</button>
              <button type="button" class="btn small danger" data-orphan="delete" data-id="${o.rec.id}">Delete</button></span></li>`;
          }
          if (o.kind === 'ink') {
            return `<li>${thumb(o.strokes)}<span class="what">Ink${o.strokes[0].data.a.q ? ` near “${esc(o.strokes[0].data.a.q)}”` : ''}</span>
              <span class="acts"><button type="button" class="btn small" data-orphan="place" data-id="${esc(o.g)}">Place here</button>
              <button type="button" class="btn small danger" data-orphan="delete-ink" data-id="${esc(o.g)}">Delete</button></span></li>`;
          }
          return `<li><span class="what">A sketch card after “${esc((o.rec.data.a.q || '').slice(0, 60))}”</span>
            <span class="acts"><button type="button" class="btn small" data-orphan="card-here" data-id="${o.rec.id}">Put it here</button>
            <button type="button" class="btn small danger" data-orphan="delete" data-id="${o.rec.id}">Delete</button></span></li>`;
        })
        .join('');
      parts.push(`<details class="atlas-orphans" open><summary>${T.orphans.length} mark${T.orphans.length === 1 ? '' : 's'} need${T.orphans.length === 1 ? 's' : ''} a new home</summary>
        <p>The text these were attached to has changed. Nothing was deleted — place each one again or remove it.</p><ul>${items}</ul></details>`);
    }
    T.top.innerHTML = parts.join('');
  }

  /* ---------- changes, undo, redo ---------- */

  async function commit(after, before, { undoable = true } = {}) {
    const saved = await Store.put(after.map((r) => ({ id: r.id, kind: r.kind, topic: r.topic, data: r.data, deleted: !!r.deleted })));
    absorb(saved);
    if (undoable) {
      undoStack.push({ before: before.map(clone), after: saved.map(clone) });
      if (undoStack.length > 200) undoStack.shift();
      redoStack = [];
    }
    syncTray();
    return saved;
  }

  /* Fold records (local or from sync) into what's on screen. */
  function absorb(records) {
    if (!T) return;
    let touched = false;
    for (const r of records) {
      if (r.topic !== T.slug || !MARK_KINDS.has(r.kind)) continue;
      T.recs.set(r.id, r);
      touched = true;
    }
    if (!touched) return;
    resolveAll();
    renderCards();
    paintHighlights();
    layout();
  }

  Store.subscribe((records, origin) => {
    if (origin === 'remote') absorb(records);
    refreshSearchCache();
  });

  async function undo() {
    const step = undoStack.pop();
    if (!step) return;
    const back = step.before.map((b, i) => (b ? b : deleted(step.after[i])));
    absorb(await Store.put(back));
    redoStack.push(step);
    syncTray();
  }

  async function redo() {
    const step = redoStack.pop();
    if (!step) return;
    absorb(await Store.put(step.after));
    undoStack.push(step);
    syncTray();
  }

  /* ---------- pointer input ---------- */

  let gesture = null;
  let draftTimer = 0;
  let suppressClick = false; // the one click a mouse drag generates

  const drawsWith = (e) =>
    e.pointerType === 'pen' || e.pointerType === 'mouse' || (tool.finger && e.pointerType === 'touch');

  /* The whole page takes ink — text, title, margins, the space below — except
     real controls, and the notes box, where the Pencil should Scribble. */
  function blockedTarget(t) {
    return !!t.closest(
      'button, input, textarea, select, label, [contenteditable], .atlas-ink-top, .atlas-card-head, [data-atlas-menu], #atlas-tray'
    );
  }

  const marking = () => !!T && (tool.mode !== 'read' || !!pendingPlace);

  // While a tool is on: the Pencil never scrolls, nothing scrolls while it is
  // down (not even a resting palm), and palm-sized touches are ignored.
  view.addEventListener(
    'touchstart',
    (e) => {
      if (!marking()) return;
      const touches = Array.from(e.changedTouches);
      const stylus = touches.some((t) => t.touchType === 'stylus');
      const palm = touches.some((t) => t.touchType !== 'stylus' && (t.radiusX || 0) > 30);
      if (gesture || palm || ((stylus || tool.finger) && !blockedTarget(e.target))) e.preventDefault();
    },
    { passive: false }
  );
  view.addEventListener(
    'touchmove',
    (e) => {
      if (gesture || (tool.finger && marking())) e.preventDefault();
    },
    { passive: false }
  );

  // Text selection would fight the Pencil. This used to be done with
  // user-select:none, but Safari then refuses to paint highlights at all.
  document.addEventListener('selectstart', (e) => {
    if (!marking()) return;
    const el = e.target && (e.target.nodeType === 1 ? e.target : e.target.parentElement);
    if (el && T.article.contains(el) && !el.closest('textarea, input')) e.preventDefault();
  });

  view.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    if (!T) return;
    if (pendingPlace) {
      if (blockedTarget(e.target)) return;
      e.preventDefault();
      placeGroupAt(e.clientX, e.clientY);
      return;
    }
    if (tool.mode === 'read' || !drawsWith(e) || e.button > 0 || blockedTarget(e.target)) return;

    e.preventDefault();
    // A previous stroke whose lift never arrived is saved, not lost.
    if (gesture) finishGesture(false);
    try {
      view.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released */
    }
    closeMenus();
    const byMouse = e.pointerType === 'mouse';
    if (tool.mode === 'highlight') startHighlight(e);
    else if (tool.mode === 'pen') startStroke(e);
    else if (tool.mode === 'eraser') {
      gesture = { type: 'erase', id: e.pointerId, ids: new Set() };
      eraseAt(e);
    }
    if (gesture) gesture.mouse = byMouse;
  });

  view.addEventListener('pointermove', (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    e.preventDefault();
    if (gesture.type === 'hl') moveHighlight(e);
    else if (gesture.type === 'stroke') moveStroke(e);
    else if (gesture.type === 'erase') eraseAt(e);
  });

  // Listened for on the whole window: wherever the Pencil lifts — over the
  // tray, the sidebar, off the edge — the stroke ends and is saved.
  const end = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    finishGesture(e.type === 'pointercancel');
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);

  // A mouse drag that drew something mustn't also follow a link underneath.
  // (The Pencil never produces that click: its touches are cancelled above.)
  view.addEventListener(
    'click',
    (e) => {
      if (suppressClick) {
        suppressClick = false;
        e.preventDefault();
        e.stopPropagation();
      }
    },
    true
  );

  function finishGesture(cancelled) {
    const g = gesture;
    if (!g) return;
    gesture = null;
    if (g.mouse && !cancelled) suppressClick = true;
    if (g.type === 'hl') endHighlight(g, cancelled);
    else if (g.type === 'stroke') endStroke(g, cancelled);
    else if (g.type === 'erase') endErase(g);
  }

  /* ---------- highlighting with the Pencil ---------- */

  /* Over text a swipe highlights the words. Anywhere else — the title, a
     margin, a figure — it lays down translucent marker ink instead, the way
     a highlighter works on a PDF. */
  function startHighlight(e) {
    const at = caretAt(e.clientX, e.clientY);
    root.style.setProperty('--hl-preview', `var(--hl-${tool.hl})`);
    const art = T.article.getBoundingClientRect();
    gesture = {
      type: 'hl',
      id: e.pointerId,
      start: at,
      end: at,
      x: e.clientX,
      y: e.clientY,
      moved: false,
      art,
      pts: [articlePoint(e, art)],
      startedAt: now(),
      rid: Store.newId('s'),
    };
  }

  function moveHighlight(e) {
    const g = gesture;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6) g.moved = true;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) g.pts.push(articlePoint(ev, g.art));
    const at = caretAt(e.clientX, e.clientY);
    if (at >= 0) {
      if (g.start < 0) g.start = at;
      g.end = at;
    }
    if (g.start < 0) {
      // Still off text: show the marker stroke as it's drawn.
      if (!g.livePath) {
        g.livePath = pathEl('', 'marker');
        T.layer.appendChild(g.livePath);
      }
      g.livePath.setAttribute('d', outline(g.pts, SIZES[tool.size] * MARKER_WIDTH * (T.em || emPx()), true));
      return;
    }
    if (g.livePath) {
      g.livePath.remove();
      g.livePath = null;
    }
    if (!HAS_HIGHLIGHTS || !g.moved) return;
    const [s, en] = snap(index().text, g.start, g.end);
    if (en > s) CSS.highlights.set('atlas-hl-preview', new Highlight(rangeOf(s, en)));
  }

  async function endHighlight(g, cancelled) {
    if (HAS_HIGHLIGHTS) CSS.highlights.delete('atlas-hl-preview');
    if (g.livePath) g.livePath.remove();
    if (cancelled) return;
    if (g.start < 0) {
      if (!g.moved) return;
      const made = strokeRecord({ ...g, pen: 'marker', size: tool.size, card: null });
      if (made && made.rec) {
        lastGroup = { ...made.group, endedAt: now(), box: made.box };
        await commit([made.rec], [null]);
      }
      return;
    }
    if (!g.moved) {
      const hits = highlightsAt(g.start);
      if (hits.length) openHighlightMenu(hits);
      return;
    }
    const [s, e] = snap(index().text, g.start, g.end);
    if (e - s < 1) return;
    await saveHighlight(s, e);
  }

  async function saveHighlight(s, e, extra = {}) {
    if (pendingReplace) {
      const rec = T.recs.get(pendingReplace);
      pendingReplace = null;
      if (rec) {
        await commit([{ ...rec, deleted: false, data: { ...rec.data, a: textAnchor(s, e) } }], [rec]);
        Atlas.toast('Highlight re-attached.');
        return rec;
      }
    }
    const rec = {
      id: Store.newId('h'),
      kind: 'highlight',
      topic: T.slug,
      data: { a: textAnchor(s, e), c: extra.color || tool.hl, n: extra.note || '', at: now() },
    };
    await commit([rec], [null]);
    return rec;
  }

  function highlightsAt(at) {
    return live('highlight')
      .filter((h) => {
        const span = T.res.get(h.id);
        return span && at >= span[0] && at < span[1];
      })
      .sort((a, b) => (b.data.at || 0) - (a.data.at || 0));
  }

  /* ---------- ink ---------- */

  function articlePoint(ev, art) {
    const q = ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5;
    return [ev.clientX - art.left, ev.clientY - art.top, q];
  }

  function startStroke(e) {
    const art = T.article.getBoundingClientRect();
    const cardEl = e.target.closest('.atlas-card');
    const pad = cardEl && cardEl.querySelector('.atlas-card-pad');
    gesture = {
      type: 'stroke',
      id: e.pointerId,
      card: cardEl ? cardEl.dataset.card : null,
      pad,
      art,
      pts: [],
      pen: tool.pen,
      size: tool.size,
      startedAt: now(),
      rid: Store.newId('s'),
    };
    if (pad) {
      gesture.livePath = pathEl('', tool.pen);
      pad.appendChild(gesture.livePath);
    } else {
      gesture.livePath = pathEl('', tool.pen);
      T.layer.appendChild(gesture.livePath);
    }
    addPoints(e);
    clearInterval(draftTimer);
    draftTimer = setInterval(saveDraftNow, 250);
  }

  function addPoints(e) {
    const g = gesture;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) {
      let p;
      if (g.pad) {
        const r = g.pad.getBoundingClientRect();
        const k = 1000 / r.width;
        p = [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k, ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5];
      } else p = articlePoint(ev, g.art);
      const last = g.pts[g.pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.4) g.pts.push(p);
    }
  }

  let liveQueued = false;
  function moveStroke(e) {
    addPoints(e);
    if (liveQueued) return;
    liveQueued = true;
    requestAnimationFrame(() => {
      liveQueued = false;
      const g = gesture;
      if (!g || g.type !== 'stroke') return;
      const k = g.pen === 'marker' ? MARKER_WIDTH : 1;
      const width = (g.pad ? cardWidthUnits(g.size) : SIZES[g.size] * (T.em || emPx())) * k;
      g.livePath.setAttribute('d', outline(g.pts, width, g.pen === 'marker'));
    });
  }

  const cardWidthUnits = (size) => ({ fine: 3, medium: 5, bold: 8.5 })[size] || 5;

  function ctxNow() {
    return { fs: emPx(), cw: Math.round(T.prose.getBoundingClientRect().width), pr: prefSig(Atlas.prefs()) };
  }

  /* Pick what a new group of ink hangs on: the word under it when it's on
     the article text; otherwise the part of the page beside it — a paragraph,
     a figure, the title, the end-of-topic sections. */
  function anchorFor(cx, cy) {
    const pr = T.prose.getBoundingClientRect();
    const overText = cx >= pr.left && cx <= pr.right && cy >= pr.top && cy <= pr.bottom;
    const el = document.elementFromPoint(cx, cy);
    if (overText && !(el && el.closest('.viz, .atlas-card'))) {
      const at = caretAt(cx, cy);
      if (at >= 0) {
        const w = wordAt(index().text, at);
        if (w) {
          const rect = rangeOf(w[0], w[1]).getBoundingClientRect();
          const em = emPx();
          // caret APIs snap to the nearest text even from far away; only
          // accept a word that's genuinely under the ink
          if (cy >= rect.top - em * 1.6 && cy <= rect.bottom + em * 1.6) return { t: 'w', ...textAnchor(w[0], w[1]) };
        }
      }
    }
    const reg = regionAtY(cy);
    if (!reg) return null;
    const side = cx > pr.right ? { side: 'r' } : {};
    if (reg.block) {
      const viz = reg.el.matches('.viz');
      return { t: 'b', u: viz ? 'w' : 'em', ...(viz ? {} : side), ...blockAnchor(reg.el) };
    }
    return { t: 'e', k: reg.key, ...side };
  }

  function strokeRecord(g) {
    if (!g.pts.length) return null;
    if (g.card) {
      return {
        id: g.rid,
        kind: 'stroke',
        topic: T.slug,
        data: {
          g: g.rid,
          a: { t: 'c', c: g.card },
          c: g.pen,
          w: cardWidthUnits(g.size) * (g.pen === 'marker' ? MARKER_WIDTH : 1),
          p: encode(g.pts.map(([x, y, q]) => [x / 10, y / 10, q])),
          at: g.startedAt,
        },
      };
    }
    const art = T.article.getBoundingClientRect();
    const em = emPx();
    const xs = g.pts.map((p) => p[0]);
    const ys = g.pts.map((p) => p[1]);
    const box = [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];

    // Join the previous group if this stroke follows it closely in time and
    // space — the letters of one handwritten word must move together.
    let group = null;
    if (lastGroup && lastGroup.topic === T.slug && g.startedAt - lastGroup.endedAt < GROUP_GAP_MS) {
      const [a0, b0, a1, b1] = lastGroup.box;
      const gap = GROUP_DIST_EM * em;
      if (box[0] < a1 + gap && box[2] > a0 - gap && box[1] < b1 + gap && box[3] > b0 - gap) group = lastGroup;
    }
    let anchor;
    let target;
    if (group) {
      anchor = group.a;
      target = group.target;
    } else {
      const cx = (box[0] + box[2]) / 2 + art.left;
      const cy = (box[1] + box[3]) / 2 + art.top;
      anchor = anchorFor(cx, cy);
      if (!anchor) return null;
      target = anchor.t === 'w' ? [anchor.s, anchor.e] : resolveTarget(anchor);
    }
    const o = originOf(anchor, target, art, em);
    if (!o) return null;
    return {
      rec: {
        id: g.rid,
        kind: 'stroke',
        topic: T.slug,
        data: {
          g: group ? group.g : g.rid,
          a: anchor,
          c: g.pen,
          w: SIZES[g.size] * (g.pen === 'marker' ? MARKER_WIDTH : 1),
          p: encode(g.pts.map(([x, y, q]) => [(x - o.x) / o.unit, (y - o.y) / o.unit, q])),
          ctx: group ? group.ctx : ctxNow(),
          at: g.startedAt,
        },
      },
      group: group || { g: g.rid, a: anchor, target, ctx: ctxNow(), topic: T.slug },
      box,
    };
  }

  function saveDraftNow() {
    const g = gesture;
    if (!g || g.type !== 'stroke' || !T) return;
    const made = g.card ? { rec: strokeRecord(g) } : strokeRecord(g);
    if (made && made.rec) Store.saveDraft(made.rec).catch(() => {});
  }

  async function endStroke(g, cancelled) {
    clearInterval(draftTimer);
    if (g.livePath) g.livePath.remove();
    // iOS can cancel a touch mid-stroke (a system gesture, an alert). Ink
    // already on the page is kept; only an accidental dot is dropped.
    if (!T || !g.pts.length || (cancelled && g.pts.length < 3)) {
      Store.saveDraft(undefined).catch(() => {});
      return;
    }
    const made = g.card ? { rec: strokeRecord(g) } : strokeRecord(g);
    if (!made || !made.rec) {
      Store.saveDraft(undefined).catch(() => {});
      return;
    }
    if (made.group) {
      lastGroup = { ...made.group, endedAt: now(), box: made.box };
      if (T.res.get(`g:${made.group.g}`) == null) T.res.set(`g:${made.group.g}`, made.group.target);
    }
    // Writing near the bottom of a space makes it grow, like a Notes page.
    const card = g.card && T.recs.get(g.card);
    if (card) {
      const h = card.data.h || 0.5;
      const lowest = Math.max(...g.pts.map((p) => p[1]));
      if (lowest > h * 1000 * 0.8 && h < 4) {
        await commit([made.rec, { ...card, data: { ...card.data, h: Math.min(4, h + 0.35) } }], [null, card]);
        Store.saveDraft(undefined).catch(() => {});
        return;
      }
    }
    await commit([made.rec], [null]);
    Store.saveDraft(undefined).catch(() => {});
  }

  /* After iOS closes the app mid-stroke: save what was checkpointed. */
  async function recoverDraft() {
    try {
      const d = await Store.takeDraft();
      if (d && d.id && !(await Store.get(d.id))) {
        await Store.put(d);
        if (T && d.topic === T.slug) absorb([await Store.get(d.id)]);
      }
    } catch {
      /* nothing to recover */
    }
  }

  /* ---------- eraser ---------- */

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function hitsStroke(h, x, y, tol) {
    const [x0, y0, x1, y1] = h.box;
    if (x < x0 - tol || x > x1 + tol || y < y0 - tol || y > y1 + tol) return false;
    for (let i = 0; i < h.pts.length; i++) {
      const a = h.pts[i];
      const b = h.pts[Math.min(i + 1, h.pts.length - 1)];
      if (distToSeg(x, y, a[0], a[1], b[0], b[1]) <= tol + h.w / 2) return true;
    }
    return false;
  }

  function eraseAt(e) {
    const g = gesture;
    const art = T.article.getBoundingClientRect();
    const x = e.clientX - art.left;
    const y = e.clientY - art.top;
    for (const h of T.hits) {
      if (!g.ids.has(h.id) && hitsStroke(h, x, y, 10)) {
        g.ids.add(h.id);
        const el = T.layer.querySelector(`[data-id="${h.id}"]`);
        if (el) el.style.opacity = '0.15';
      }
    }
    const under = document.elementFromPoint(e.clientX, e.clientY);
    const cardEl = under && under.closest('.atlas-card');
    if (cardEl) {
      const pad = cardEl.querySelector('.atlas-card-pad').getBoundingClientRect();
      const k = 1000 / pad.width;
      for (const h of T.cardHits) {
        if (h.card === cardEl.dataset.card && !g.ids.has(h.id) && hitsStroke(h, (e.clientX - pad.left) * k, (e.clientY - pad.top) * k, 10 * k)) {
          g.ids.add(h.id);
          const el = cardEl.querySelector(`[data-id="${h.id}"]`);
          if (el) el.style.opacity = '0.15';
        }
      }
    }
    const at = caretAt(e.clientX, e.clientY);
    if (at >= 0) {
      const pr = T.prose.getBoundingClientRect();
      if (e.clientX >= pr.left && e.clientX <= pr.right) for (const h of highlightsAt(at)) g.ids.add(h.id);
    }
  }

  async function endErase(g) {
    if (!g.ids.size) return;
    const before = [...g.ids].map((id) => T.recs.get(id)).filter(Boolean);
    await commit(before.map(deleted), before);
    Atlas.toast(`${before.length} mark${before.length === 1 ? '' : 's'} erased.`, { action: 'Undo', onAction: undo });
  }

  /* ---------- re-placing marks from the tray ---------- */

  async function placeGroupAt(cx, cy) {
    const g = pendingPlace;
    pendingPlace = null;
    root.classList.remove('ink-placing');
    const strokes = live('stroke').filter((s) => (s.data.g || s.id) === g);
    const anchor = anchorFor(cx, cy);
    if (!strokes.length || !anchor) return;
    // Put the group's top-left corner where the reader tapped.
    const all = strokes.flatMap((s) => decode(s.data.p || []));
    const x0 = Math.min(...all.map((p) => p[0]));
    const y0 = Math.min(...all.map((p) => p[1]));
    const art = T.article.getBoundingClientRect();
    const target = anchor.t === 'w' ? [anchor.s, anchor.e] : resolveTarget(anchor);
    const o = originOf(anchor, target, art, emPx());
    const dx = (cx - art.left - o.x) / o.unit;
    const dy = (cy - art.top - o.y) / o.unit;
    const after = strokes.map((s) => ({
      ...s,
      data: { ...s.data, a: anchor, ctx: ctxNow(), p: encode(decode(s.data.p).map(([x, y, q]) => [x - x0 + dx, y - y0 + dy, q])) },
    }));
    await commit(after, strokes);
    Atlas.toast('Ink placed.');
  }

  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-orphan], [data-card-act], [data-ink-act], .atlas-marker');
    if (!btn || !T) return;
    e.preventDefault();
    if (btn.classList.contains('atlas-marker')) {
      const h = T.recs.get(btn.dataset.hl);
      if (h) openHighlightMenu([h], btn.getBoundingClientRect());
      return;
    }
    if (btn.dataset.cardAct) {
      const card = btn.closest('.atlas-card');
      const rec = card && T.recs.get(card.dataset.card);
      if (!rec) return;
      if (btn.dataset.cardAct === 'size') {
        const h = rec.data.h || 0.5;
        await commit([{ ...rec, data: { ...rec.data, h: h >= 0.85 ? 0.5 : h >= 0.6 ? 0.9 : 0.65 } }], [rec]);
      } else {
        const strokes = live('stroke').filter((s) => s.data.a && s.data.a.t === 'c' && s.data.a.c === rec.id);
        await commit([rec, ...strokes].map(deleted), [rec, ...strokes]);
        Atlas.toast('Sketch deleted.', { action: 'Undo', onAction: undo });
      }
      return;
    }
    const act = btn.dataset.orphan || btn.dataset.inkAct;
    const id = btn.dataset.id;
    if (act === 'replace') {
      pendingReplace = id;
      setMode('highlight');
      Atlas.toast('Swipe the Pencil across the passage this highlight belongs to — or select it with a finger.');
    } else if (act === 'delete') {
      const rec = T.recs.get(id);
      if (rec) await commit([deleted(rec)], [rec]);
    } else if (act === 'delete-ink') {
      const strokes = live('stroke').filter((s) => (s.data.g || s.id) === id);
      await commit(strokes.map(deleted), strokes);
    } else if (act === 'place') {
      pendingPlace = id;
      root.classList.add('ink-placing');
      Atlas.toast('Tap the word or paragraph this ink belongs next to.');
    } else if (act === 'card-here') {
      const rec = T.recs.get(id);
      const el = blockAtY(window.innerHeight * 0.45);
      if (rec && el) await commit([{ ...rec, data: { ...rec.data, a: blockAnchor(el) } }], [rec]);
    } else if (act === 'preview') {
      const c = T.drawnCtx;
      if (!c) return;
      const [size, font, leading, width] = c.pr.split('|');
      previewing = true;
      Atlas.previewPrefs({ size, font, leading, width, column: c.cw });
      paintTop();
    } else if (act === 'margin-on') {
      if (!tool.margin) toggleMargin();
    } else if (act === 'unpreview') {
      previewing = false;
      Atlas.previewPrefs(null);
      paintTop();
    }
  });

  /* ---------- tapping a highlight while reading ---------- */

  view.addEventListener('click', (e) => {
    if (!T || tool.mode !== 'read' || pendingPlace) return;
    if (e.target.closest('a, button, [data-atlas-ui]') || !T.prose.contains(e.target)) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    const at = caretAt(e.clientX, e.clientY);
    if (at < 0) return;
    const hits = highlightsAt(at);
    if (hits.length) openHighlightMenu(hits);
  });

  /* ---------- floating menus ---------- */

  let menu = null;

  function closeMenus() {
    if (menu) {
      menu.remove();
      menu = null;
    }
    hideSelectionBar();
  }

  function placeMenu(el, rect) {
    document.body.appendChild(el);
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const vw = window.innerWidth;
    let left = Math.max(10, Math.min(vw - w - 10, rect.left + rect.width / 2 - w / 2));
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 20) top = Math.max(10, rect.top - h - 10);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function highlightRect(h) {
    const span = T.res.get(h.id);
    if (!span) return null;
    const rects = rangeOf(span[0], span[1]).getClientRects();
    return rects[0] || null;
  }

  function openHighlightMenu(hits, rect) {
    closeMenus();
    const h = hits[0];
    rect = rect || highlightRect(h);
    if (!rect) return;
    menu = document.createElement('div');
    menu.className = 'atlas-menu';
    menu.setAttribute('data-atlas-menu', '');
    menu.setAttribute('data-atlas-ui', '');
    const others = hits.slice(1);
    menu.innerHTML = `
      ${others.length ? `<div class="menu-note">${hits.length} highlights overlap here · <button type="button" data-menu="next">Next</button></div>` : ''}
      <div class="menu-row">${HL.map((c) => `<button type="button" class="swatch hl-${c}${h.data.c === c ? ' on' : ''}" data-menu="color" data-c="${c}" aria-label="${c}"></button>`).join('')}
        <span class="menu-sep"></span>
        <button type="button" data-menu="note">${icon('note', 16)} ${h.data.n ? 'Edit note' : 'Note'}</button>
        <button type="button" data-menu="copy">Copy</button>
        <button type="button" data-menu="delete" class="danger">Delete</button></div>
      ${h.data.n ? `<div class="menu-text">${esc(h.data.n)}</div>` : ''}`;
    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      const act = b.dataset.menu;
      const cur = T && T.recs.get(h.id);
      if (!cur) return closeMenus();
      if (act === 'next') return openHighlightMenu([...others, h]);
      if (act === 'color') {
        await commit([{ ...cur, data: { ...cur.data, c: b.dataset.c } }], [cur]);
        tool.hl = b.dataset.c;
        saveTool();
        closeMenus();
      } else if (act === 'copy') {
        try {
          await navigator.clipboard.writeText(cur.data.a.q);
          Atlas.toast('Copied.');
        } catch {
          Atlas.toast('Copying isn’t allowed here.');
        }
        closeMenus();
      } else if (act === 'delete') {
        await commit([deleted(cur)], [cur]);
        closeMenus();
        Atlas.toast('Highlight deleted.', { action: 'Undo', onAction: undo });
      } else if (act === 'note') {
        openNoteEditor(cur, rect);
      }
    });
    placeMenu(menu, rect);
  }

  function openNoteEditor(h, rect, { isNew } = {}) {
    closeMenus();
    menu = document.createElement('div');
    menu.className = 'atlas-menu atlas-note-editor';
    menu.setAttribute('data-atlas-menu', '');
    menu.setAttribute('data-atlas-ui', '');
    menu.innerHTML = `<div class="menu-quote">“${esc(h.data.a.q.slice(0, 140))}${h.data.a.q.length > 140 ? '…' : ''}”</div>
      <textarea id="atlas-hl-note" rows="4" placeholder="Your note — type, or write with the Pencil (Scribble)">${esc(h.data.n || '')}</textarea>
      <div class="menu-row end"><button type="button" data-menu="cancel">${isNew ? 'Skip' : 'Cancel'}</button><button type="button" class="primary" data-menu="save">Save note</button></div>`;
    menu.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      if (b.dataset.menu === 'save') {
        const cur = T && T.recs.get(h.id);
        const text = menu.querySelector('textarea').value;
        if (cur) await commit([{ ...cur, data: { ...cur.data, n: text.trim() ? text : '' } }], [cur]);
      }
      closeMenus();
    });
    placeMenu(menu, rect);
    const area = menu.querySelector('textarea');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target) && !e.target.closest('.atlas-marker')) closeMenus();
  });
  window.addEventListener(
    'scroll',
    () => {
      if (menu && !menu.classList.contains('atlas-note-editor')) closeMenus();
    },
    { passive: true }
  );

  /* ---------- highlighting a finger selection (Read mode) ---------- */

  let selBar = null;
  let selSpan = null;

  function hideSelectionBar() {
    if (selBar) selBar.hidden = true;
    selSpan = null;
  }

  function showSelectionBar(rect) {
    if (!selBar) {
      selBar = document.createElement('div');
      selBar.className = 'atlas-menu atlas-selbar';
      selBar.setAttribute('data-atlas-menu', '');
      selBar.setAttribute('data-atlas-ui', '');
      // Remember the selection the moment a button is pressed: on iOS the tap
      // itself can collapse the selection before the click arrives.
      let pressed = null;
      selBar.addEventListener('pointerdown', (e) => {
        pressed = selSpan;
        e.preventDefault();
      });
      selBar.addEventListener('click', async (e) => {
        const b = e.target.closest('[data-sel]');
        const span = pressed || selSpan;
        pressed = null;
        if (!b || !span || !T) return;
        const [s, en] = span;
        const r = window.getSelection();
        const rect2 = selBar.getBoundingClientRect();
        hideSelectionBar();
        if (r) r.removeAllRanges();
        if (b.dataset.sel === 'note') {
          const rec = await saveHighlight(s, en);
          openNoteEditor(T.recs.get(rec.id) || rec, rect2, { isNew: true });
        } else {
          await saveHighlight(s, en, { color: b.dataset.sel });
          tool.hl = b.dataset.sel;
          saveTool();
        }
      });
      document.body.appendChild(selBar);
    }
    selBar.innerHTML = pendingReplace
      ? `<div class="menu-row"><button type="button" class="primary" data-sel="${esc(tool.hl)}">Attach highlight here</button></div>`
      : `<div class="menu-row">${HL.map((c) => `<button type="button" class="swatch hl-${c}" data-sel="${c}" aria-label="Highlight ${c}"></button>`).join('')}
         <span class="menu-sep"></span><button type="button" data-sel="note">${icon('note', 16)} Note</button></div>`;
    selBar.hidden = false;
    const w = selBar.offsetWidth;
    const h = selBar.offsetHeight;
    // Below the selection: iOS puts its own Copy / Look Up menu above it.
    let top = rect.bottom + 14;
    if (top + h > window.innerHeight - 16) top = Math.max(10, rect.top - h - 56);
    selBar.style.left = `${Math.max(10, Math.min(window.innerWidth - w - 10, rect.left + rect.width / 2 - w / 2))}px`;
    selBar.style.top = `${top}px`;
  }

  let selTimer = 0;
  document.addEventListener('selectionchange', () => {
    clearTimeout(selTimer);
    selTimer = setTimeout(() => {
      if (!T || tool.mode !== 'read') return hideSelectionBar();
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return hideSelectionBar();
      const r = sel.getRangeAt(0);
      if (!T.prose.contains(r.commonAncestorContainer)) return hideSelectionBar();
      const s = offsetOf(r.startContainer, r.startOffset);
      const e = offsetOf(r.endContainer, r.endOffset);
      if (s < 0 || e < 0) return hideSelectionBar();
      const span = trimSpan(index().text, [Math.min(s, e), Math.max(s, e)]);
      if (!span) return hideSelectionBar();
      selSpan = span;
      showSelectionBar(r.getBoundingClientRect());
    }, 220);
  });

  /* ---------- jumping to a mark (from the Library or search) ---------- */

  function jumpToMark(id) {
    const rec = T.recs.get(id);
    if (!rec) return;
    let rect = null;
    if (rec.kind === 'highlight') {
      const span = T.res.get(id);
      if (span) {
        rect = rangeOf(span[0], span[1]).getBoundingClientRect();
        if (HAS_HIGHLIGHTS) {
          CSS.highlights.set('atlas-hl-flash', new Highlight(rangeOf(span[0], span[1])));
          setTimeout(() => HAS_HIGHLIGHTS && CSS.highlights.delete('atlas-hl-flash'), 1600);
        }
      }
    } else if (rec.kind === 'card') {
      const el = T.prose.querySelector(`.atlas-card[data-card="${id}"]`);
      if (el) rect = el.getBoundingClientRect();
    } else {
      const el = T.layer.querySelector(`[data-id="${id}"]`);
      if (el) rect = el.getBoundingClientRect();
    }
    if (rect) window.scrollTo(0, Math.max(0, rect.top + window.scrollY - window.innerHeight * 0.3));
  }

  /* ---------- the Pencil tray ---------- */

  const tray = document.createElement('div');
  tray.id = 'atlas-tray';
  tray.setAttribute('data-atlas-ui', '');
  tray.hidden = true;
  document.body.appendChild(tray);

  const MODE_ICONS = {
    read: '<path d="M2.5 12s3.5-7 9.5-7 9.5 7 9.5 7-3.5 7-9.5 7-9.5-7-9.5-7Z"/><circle cx="12" cy="12" r="3"/>',
    highlight: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    pen: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
    eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19"/><path d="M22 21H7M5 11l9 9"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    sketch: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M7 15c2-4 4 1 6-2s3-2 4-1"/>',
    margin: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M14 4v16M6 8h5M6 11h5M6 14h3"/>',
    close: '<path d="m6 9 6 6 6-6"/>',
  };
  const svg = (name, size = 20) =>
    `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${MODE_ICONS[name]}</svg>`;
  const LABEL = { read: 'Read', highlight: 'Highlight', pen: 'Pen', eraser: 'Eraser' };

  function syncTray() {
    const onTopic = !!T;
    tray.hidden = !onTopic;
    if (!onTopic) return;
    const colors = tool.mode === 'pen' ? PENS : HL;
    const current = tool.mode === 'pen' ? tool.pen : tool.hl;
    tray.className = `${tool.open ? 'open' : ''} mode-${tool.mode}`;
    tray.innerHTML = `
      <div class="tray-panel" role="toolbar" aria-label="Pencil tools">
        <div class="tray-modes">${['read', 'highlight', 'pen', 'eraser']
          .map((m) => `<button type="button" data-tool-mode="${m}" class="${tool.mode === m ? 'on' : ''}" aria-pressed="${tool.mode === m}">${svg(m, 19)}<span>${LABEL[m]}</span></button>`)
          .join('')}</div>
        <div class="tray-opts">
          ${tool.mode === 'highlight' || tool.mode === 'pen'
            ? `<div class="tray-colors">${colors
                .map((c) => `<button type="button" class="swatch ${tool.mode === 'pen' ? 'pen' : 'hl'}-${c}${current === c ? ' on' : ''}" data-tool-color="${c}" aria-label="${c}"></button>`)
                .join('')}</div>`
            : ''}
          ${tool.mode === 'pen'
            ? `<div class="tray-sizes">${Object.keys(SIZES)
                .map((s) => `<button type="button" data-tool-size="${s}" class="size-${s}${tool.size === s ? ' on' : ''}" aria-label="${s} line"><i></i></button>`)
                .join('')}</div>`
            : ''}
          <button type="button" class="tray-btn" data-tool-act="sketch" title="Add space to write">${svg('sketch', 19)}<span>Space</span></button>
          <button type="button" class="tray-btn${tool.margin ? ' on' : ''}" data-tool-act="margin" aria-pressed="${tool.margin}" title="Wide margin to write in">${svg('margin', 19)}<span>Margin</span></button>
          <button type="button" class="tray-btn" data-tool-act="undo" ${undoStack.length ? '' : 'disabled'} aria-label="Undo">${svg('undo', 19)}</button>
          <button type="button" class="tray-btn" data-tool-act="redo" ${redoStack.length ? '' : 'disabled'} aria-label="Redo">${svg('redo', 19)}</button>
        </div>
      </div>
      ${!tool.open && tool.mode !== 'read'
        ? `<button type="button" class="tray-quick" data-tool-act="eraser" aria-label="${tool.mode === 'eraser' ? `Back to ${LABEL[tool.lastTool] || 'Pen'}` : 'Eraser'}">${svg(tool.mode === 'eraser' ? tool.lastTool || 'pen' : 'eraser', 20)}</button>`
        : ''}
      <button type="button" class="tray-fab" data-tool-act="toggle" aria-expanded="${tool.open}" aria-label="${tool.open ? 'Hide Pencil tools' : 'Pencil tools'}">
        ${tool.open ? svg('close', 22) : svg(tool.mode === 'read' ? 'pen' : tool.mode, 22)}
        ${tool.mode !== 'read' && !tool.open ? `<em>${LABEL[tool.mode]}</em>` : ''}
      </button>`;
  }

  function applyModeClass() {
    for (const m of ['highlight', 'pen', 'eraser']) root.classList.toggle(`ink-mode-${m}`, tool.mode === m);
    root.classList.toggle('ink-margin', !!tool.margin);
  }

  function setMode(m) {
    if (m === 'highlight' || m === 'pen') tool.lastTool = m;
    tool.mode = m;
    if (m !== 'read') hideSelectionBar();
    saveTool();
    applyModeClass();
    syncTray();
  }

  tray.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    if (b.dataset.toolMode) setMode(b.dataset.toolMode);
    else if (b.dataset.toolColor) {
      if (tool.mode === 'pen') tool.pen = b.dataset.toolColor;
      else tool.hl = b.dataset.toolColor;
      saveTool();
      syncTray();
    } else if (b.dataset.toolSize) {
      tool.size = b.dataset.toolSize;
      saveTool();
      syncTray();
    } else if (b.dataset.toolAct === 'toggle') {
      tool.open = !tool.open;
      saveTool();
      syncTray();
    } else if (b.dataset.toolAct === 'undo') undo();
    else if (b.dataset.toolAct === 'redo') redo();
    else if (b.dataset.toolAct === 'sketch') addCard();
    else if (b.dataset.toolAct === 'eraser') toggleEraser();
    else if (b.dataset.toolAct === 'margin') toggleMargin();
  });

  /* Apple Pencil double-tap only reaches native apps — iPadOS never tells a
     web page about it. The nearest equivalents: a two-finger tap anywhere on
     the page, the round button beside the pencil button, or E on a keyboard. */
  function toggleEraser() {
    if (tool.mode === 'eraser') setMode(tool.lastTool || 'pen');
    else setMode('eraser');
  }

  function toggleMargin() {
    Atlas.keepPlace(() => {
      tool.margin = !tool.margin;
      saveTool();
      applyModeClass();
    });
    syncTray();
  }

  // Two-finger tap. Touch events on iPad (pointer events get cancelled when
  // iOS thinks a pinch may be starting); pointer events everywhere else.
  let twoTap = null;
  const tapTimeout = 350;
  const tapSlop = 14;
  if ('ontouchstart' in window) {
    view.addEventListener(
      'touchstart',
      (e) => {
        const fingers = Array.from(e.touches).filter((t) => t.touchType !== 'stylus');
        if (fingers.length === 2 && !twoTap) twoTap = { at: now(), n: 2, start: new Map(fingers.map((f) => [f.identifier, [f.clientX, f.clientY]])), moved: false };
        else if (twoTap && fingers.length > 2) twoTap.n = fingers.length;
      },
      { passive: true }
    );
    view.addEventListener(
      'touchmove',
      (e) => {
        if (!twoTap) return;
        for (const t of e.changedTouches) {
          const s0 = twoTap.start.get(t.identifier);
          if (s0 && Math.hypot(t.clientX - s0[0], t.clientY - s0[1]) > tapSlop) twoTap.moved = true;
        }
      },
      { passive: true }
    );
    const done = (e) => {
      if (!twoTap || e.touches.length) return;
      const t = twoTap;
      twoTap = null;
      if (t.n === 2 && !t.moved && now() - t.at < tapTimeout && marking() && !pendingPlace) toggleEraser();
    };
    view.addEventListener('touchend', done, { passive: true });
    view.addEventListener('touchcancel', () => (twoTap = null), { passive: true });
  } else {
    const fingers = new Map();
    view.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch') return;
        if (!fingers.size) twoTap = { at: now(), n: 0, moved: false };
        fingers.set(e.pointerId, [e.clientX, e.clientY]);
        twoTap.n = Math.max(twoTap.n, fingers.size);
      },
      true
    );
    view.addEventListener(
      'pointermove',
      (e) => {
        const f = fingers.get(e.pointerId);
        if (f && twoTap && Math.hypot(e.clientX - f[0], e.clientY - f[1]) > tapSlop) twoTap.moved = true;
      },
      true
    );
    view.addEventListener(
      'pointerup',
      (e) => {
        if (!fingers.delete(e.pointerId) || fingers.size || !twoTap) return;
        const t = twoTap;
        twoTap = null;
        if (t.n === 2 && !t.moved && now() - t.at < tapTimeout && marking() && !pendingPlace) toggleEraser();
      },
      true
    );
    view.addEventListener('pointercancel', (e) => fingers.delete(e.pointerId), true);
  }

  document.addEventListener('keydown', (e) => {
    if (!T || Atlas.searchOpen() || (e.target.closest && e.target.closest('input, textarea, select'))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'e') return toggleEraser();
    const m = { h: 'highlight', i: 'pen', r: 'read' }[e.key];
    if (m) setMode(m);
    else if (e.key === 'Escape') {
      pendingPlace = null;
      pendingReplace = null;
      root.classList.remove('ink-placing');
    }
  });

  /* ---------- Settings → Pencil ---------- */

  async function paintPencilSettings() {
    const slot = view.querySelector('[data-slot="pencil"]');
    if (!slot) return;
    const recs = await Store.all().catch(() => []);
    const n = (k) => recs.filter((r) => r.kind === k && !r.deleted).length;
    slot.innerHTML = `<section class="block"><h2>Pencil</h2>
      <div class="list">
        <div class="set-row"><div><b>Draw with a finger too</b><small>For when the Pencil isn’t with you. While a marking tool is on, one finger draws instead of scrolling.</small></div>
          <button type="button" class="btn small" data-pencil="finger" aria-pressed="${tool.finger}">${tool.finger ? 'On' : 'Off'}</button></div>
        <div class="set-row"><div><b>Switching to the eraser</b><small>Tap with two fingers anywhere on the page, tap the round button beside the pencil button, or press E on a keyboard. (Apple only sends the Pencil's double-tap to native apps, not to web apps.)</small></div></div>
        <div class="set-row"><div><b>Where you can write</b><small>Anywhere on a topic — over the text, the title, the margins and the space below. Turn on Margin in the tray for a wide margin, or add a writing space between paragraphs.</small></div></div>
        <div class="set-row"><div><b>On this iPad</b><small>${n('highlight')} highlights · ${n('stroke')} ink strokes · ${n('card')} sketch cards. Deleted marks can be restored from the Library for ${KEEP_DELETED_DAYS} days.</small></div></div>
      </div></section>`;
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pencil="finger"]');
    if (!b) return;
    tool.finger = !tool.finger;
    saveTool();
    paintPencilSettings();
  });

  /* ---------- Library → Annotations ---------- */

  let libFilter = 'all';

  async function paintLibrary() {
    const slot = view.querySelector('[data-slot="annotations"]');
    if (!slot) return;
    const recs = (await Store.all().catch(() => [])).filter((r) => MARK_KINDS.has(r.kind));
    const active = recs.filter((r) => !r.deleted);
    const cutoff = now() - KEEP_DELETED_DAYS * 864e5;
    const trash = recs.filter((r) => r.deleted && r.data && r.data.del > cutoff && !r.data.compacted);

    const byTopic = new Map();
    for (const r of active) {
      if (!byTopic.has(r.topic)) byTopic.set(r.topic, []);
      byTopic.get(r.topic).push(r);
    }
    const order = (slug) => {
      const t = Atlas.topic(slug);
      return t ? t.i : 1e9;
    };
    const pass = (h) =>
      libFilter === 'all' ||
      (libFilter === 'notes' && (h.data.n || '').trim()) ||
      (HL.includes(libFilter) && h.data.c === libFilter);

    const sections = [...byTopic.keys()]
      .sort((a, b) => order(a) - order(b))
      .map((slug) => {
        const t = Atlas.topic(slug);
        const list = byTopic.get(slug);
        const hs = list.filter((r) => r.kind === 'highlight' && pass(r)).sort((a, b) => (a.data.a.s || 0) - (b.data.a.s || 0));
        const strokes = list.filter((r) => r.kind === 'stroke');
        const groups = new Set(strokes.map((s) => s.data.g || s.id)).size;
        const cards = list.filter((r) => r.kind === 'card').length;
        const showInk = libFilter === 'all' || libFilter === 'ink';
        if (!hs.length && !(showInk && (groups || cards))) return '';
        const s = t ? Atlas.section(t.section) : null;
        const href = t ? Atlas.topicHref(t) : '#/';
        const rows = hs
          .map(
            (h) => `<a class="ann-row" href="${href}" data-mark="${h.id}"><span class="ann-bar hl-${esc(h.data.c)}"></span>
              <span class="ann-body"><span class="ann-quote">${esc(h.data.a.q)}</span>${h.data.n ? `<span class="ann-note">${esc(h.data.n)}</span>` : ''}</span></a>`
          )
          .join('');
        const ink =
          showInk && (groups || cards)
            ? `<a class="ann-row ann-ink" href="${href}" data-mark="${esc(strokes[0] ? strokes[0].id : list.find((r) => r.kind === 'card').id)}">${thumb(strokes.slice(0, 12))}
                <span class="ann-body"><span class="ann-note">${groups ? `${groups} scribble${groups === 1 ? '' : 's'}` : ''}${groups && cards ? ' · ' : ''}${cards ? `${cards} sketch${cards === 1 ? '' : 'es'}` : ''}</span></span></a>`
            : '';
        return `<div class="ann-topic" style="--a:${s ? s.accent : 'var(--text-dim)'}">
          <div class="ann-head">${t ? `<a href="${href}">${esc(t.title)}</a><small>${esc(s.title)}</small>` : `<b>From a removed topic</b><small>${esc(slug)}</small>`}</div>
          ${rows}${ink}</div>`;
      })
      .filter(Boolean)
      .join('');

    const trashGroups = new Map();
    for (const r of trash) {
      const key = r.kind === 'stroke' ? `${r.topic}|${r.data.g || r.id}|${Math.round(r.data.del / 60000)}` : r.id;
      if (!trashGroups.has(key)) trashGroups.set(key, []);
      trashGroups.get(key).push(r);
    }
    const trashRows = [...trashGroups.entries()]
      .sort((a, b) => b[1][0].data.del - a[1][0].data.del)
      .slice(0, 40)
      .map(([key, list]) => {
        const r = list[0];
        const t = Atlas.topic(r.topic);
        const what =
          r.kind === 'highlight'
            ? `“${esc((r.data.a && r.data.a.q ? r.data.a.q : '').slice(0, 90))}”`
            : r.kind === 'card'
              ? 'Sketch card'
              : `Ink · ${list.length} stroke${list.length === 1 ? '' : 's'}`;
        return `<div class="set-row"><div><b>${what}</b><small>${t ? esc(t.title) : esc(r.topic)} · deleted ${Atlas.fmtDate(r.data.del)}</small></div>
          <button type="button" class="btn small" data-restore="${esc(key)}">Restore</button></div>`;
      })
      .join('');
    slot._trash = trashGroups;

    const chips = [
      ['all', 'All'],
      ...HL.map((c) => [c, c[0].toUpperCase() + c.slice(1)]),
      ['notes', 'With notes'],
      ['ink', 'Ink'],
    ]
      .map(([k, l]) => `<button type="button" class="chip${libFilter === k ? ' on' : ''}" data-ann-filter="${k}">${HL.includes(k) ? `<span class="dot hl-${k}"></span>` : ''}${l}</button>`)
      .join('');

    slot.innerHTML = `<section class="block"><h2>Annotations</h2>
        ${active.length ? `<div class="chips ann-filters">${chips}</div>${sections || '<div class="empty">Nothing matches this filter.</div>'}` : '<div class="empty">Highlights, ink and sketches you make on topics collect here. Open a topic and tap the pencil button at the bottom right.</div>'}
      </section>
      ${trashRows ? `<section class="block"><h2>Recently deleted</h2><div class="list">${trashRows}</div></section>` : ''}`;
  }

  view.addEventListener('click', async (e) => {
    const f = e.target.closest('[data-ann-filter]');
    if (f) {
      libFilter = f.dataset.annFilter;
      paintLibrary();
      return;
    }
    const r = e.target.closest('[data-restore]');
    if (r) {
      const slot = view.querySelector('[data-slot="annotations"]');
      const list = slot && slot._trash && slot._trash.get(r.dataset.restore);
      if (!list) return;
      // Restoring ink on a deleted card restores the card too.
      const extra = [];
      for (const s of list) {
        if (s.kind === 'stroke' && s.data.a && s.data.a.t === 'c') {
          const card = await Store.get(s.data.a.c);
          if (card && card.deleted) extra.push(card);
        }
      }
      await Store.put([...list, ...extra].map(restored));
      Atlas.toast('Restored.');
      paintLibrary();
    }
  });

  /* ---------- search over your own highlights ---------- */

  let searchCache = [];
  let cacheTimer = 0;
  function refreshSearchCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(async () => {
      try {
        searchCache = (await Store.byKind('highlight'))
          .filter((h) => !h.deleted && h.data && h.data.a && Atlas.topic(h.topic))
          .map((h) => ({ h, hay: `${h.data.a.q} ${h.data.n || ''}`.toLowerCase() }));
      } catch {
        searchCache = [];
      }
    }, 150);
  }
  refreshSearchCache();

  Atlas.searchProviders.push((q, tokens) =>
    searchCache
      .filter((x) => tokens.every((t) => x.hay.includes(t)))
      .map(({ h }) => {
        const t = Atlas.topic(h.topic);
        const s = Atlas.section(t.section);
        return {
          href: Atlas.topicHref(t),
          mark: h.id,
          title: t.title,
          kicker: `${h.data.n ? 'Your note' : 'Your highlight'} · ${s.title}`,
          accent: s.accent,
          snippet: `<span class="hl-inline hl-${esc(h.data.c)}">${esc(h.data.a.q.slice(0, 180))}</span>${h.data.n ? ` — ${esc(h.data.n.slice(0, 140))}` : ''}`,
        };
      })
  );

  /* ---------- export / import ---------- */

  Atlas.exporters.push(async () => ({ annotations: (await Store.all()).filter((r) => MARK_KINDS.has(r.kind)) }));
  Atlas.importers.push(async (d) => {
    const list = Array.isArray(d.annotations) ? d.annotations : [];
    const valid = list.filter((r) => r && typeof r.id === 'string' && MARK_KINDS.has(r.kind) && typeof r.clock === 'string');
    if (valid.length) await Store.applyRemote(valid, { queue: true });
  });

  /* ---------- start ---------- */

  recoverDraft();
  Store.compact(KEEP_DELETED_DAYS).catch(() => {});
  syncTray();
})();
