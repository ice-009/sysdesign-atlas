/* Scribble boxes and the text highlighter — Apple Pencil first.

   Two things only, each with its own place:

     Highlighter   With it on, a Pencil swipe over the article text highlights
                   those words (snapped to whole words). Swipes that miss the
                   text do nothing; the page scrolls as usual.
     Scribble box  A Notes-like writing area you drop in after any paragraph.
                   The Pencil writes in it; fingers scroll past it.

   Nothing else on the page is drawn on, and the app takes over a touch only
   when the Pencil lands inside a scribble box or on text with the highlighter
   on. Everywhere else the page is plain Safari scrolling — the earlier
   version intercepted touches page-wide, and that is what froze it.

   How marks stay put:
     Highlights are saved as the words themselves (quote + context) and are
     re-found in four steps after a topic edit: exact → moved → close match →
     "needs a new home" tray.
     A box is saved against the paragraph it follows (by a fingerprint of its
     text) and its strokes are stored in units of the box's own width, so text
     size, rotation and theme only scale it as a whole. It never distorts.

   Every finished stroke is written to IndexedDB on pen-up and the stroke in
   progress is checkpointed every 250 ms. A stroke whose lift never arrives is
   closed and saved by a safety timer.

   Text positions come from one walk over the article's text nodes that skips
   everything injected here ([data-atlas-ui]), so boxes and markers never shift
   highlight offsets. */

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
  const SIZES = { fine: 3, medium: 5, bold: 8.5 }; // box units (1000 = box width)
  const MARKER = 2.6; // marker strokes are this much wider
  const PAPERS = ['dots', 'lines', 'blank'];
  const MARK_KINDS = new Set(['highlight', 'stroke', 'card']);
  const CTX = 32;
  const KEEP_DELETED_DAYS = 30;
  const BOX_START = 0.42; // new box height / width
  const BOX_MAX = 4;
  const STROKE_IDLE_MS = 1500; // safety timer

  /* ---------- tool state (per device) ---------- */

  const TOOL_KEY = 'atlas.ink';
  const tool = {
    hl: false, // highlighter on
    hlColor: 'yellow',
    pen: 'ink',
    size: 'medium',
    paper: 'dots',
    finger: false, // fingers draw in boxes too
    collapsed: false, // boxes start collapsed
    diag: false, // touch diagnostics overlay
  };
  try {
    const saved = JSON.parse(localStorage.getItem(TOOL_KEY) || '{}') || {};
    const legacy = typeof saved.hl === 'string'; // the previous version kept the highlight colour here
    for (const k of Object.keys(tool)) if (k in saved && typeof saved[k] === typeof tool[k]) tool[k] = saved[k];
    if (legacy && HL.includes(saved.hl)) tool.hlColor = saved.hl;
    if (!PENS.includes(tool.pen)) tool.pen = 'ink';
    if (!HL.includes(tool.hlColor)) tool.hlColor = 'yellow';
    if (!PAPERS.includes(tool.paper)) tool.paper = 'dots';
    if (!SIZES[tool.size]) tool.size = 'medium';
  } catch {
    /* defaults */
  }
  let eraser = false; // session only: an eraser left on by accident shouldn't greet you tomorrow
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
  const deleted = (r, extra = {}) => ({ ...r, deleted: true, data: { ...r.data, del: now(), ...extra } });
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
  const normText = (el) => el.textContent.replace(/\s+/g, ' ').trim();

  /* ---------- per-topic state ---------- */

  let T = null; // the topic on screen
  const prepared = new Map(); // slug → records preloaded during the topic fetch
  let undoStack = [];
  let redoStack = [];
  let pendingReplace = null; // highlight id waiting to be re-attached
  let pendingPlace = null; // box id waiting for a new paragraph
  let insertMode = false; // ＋ markers showing

  Atlas.preparers.push(async (topic) => {
    prepared.set(topic.slug, await Store.byTopic(topic.slug));
  });

  Atlas.on('leave', teardown);
  Atlas.on('close', closeMenus);
  Atlas.on('paint', ({ topic }) => {
    if (topic) setup(topic);
    syncDock();
  });
  Atlas.on('render', ({ route, topic, opts }) => {
    if (topic && T && opts && opts.mark) jumpToMark(opts.mark);
    if (route.name === 'library') paintLibrary();
    if (route.name === 'settings') paintPencilSettings();
    syncDock();
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

  /* Grow a swipe to whole words and drop surrounding whitespace. */
  function snap(text, a, b) {
    let s = Math.min(a, b);
    let e = Math.max(a, b);
    while (s > 0 && WORD.test(text[s - 1]) && WORD.test(text[s] || ' ')) s--;
    while (e < text.length && WORD.test(text[e]) && WORD.test(text[e - 1] || ' ')) e++;
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return [s, e];
  }

  function trimSpan(text, [s, e]) {
    while (s < e && /\s/.test(text[s])) s++;
    while (e > s && /\s/.test(text[e - 1])) e--;
    return e > s ? [s, e] : null;
  }

  /* ---------- text anchors (highlights) ---------- */

  function textAnchor(s, e) {
    const text = index().text;
    return { s, e, q: text.slice(s, e), pre: text.slice(Math.max(0, s - CTX), s), suf: text.slice(e, e + CTX) };
  }

  function contextScore(text, s, e, a) {
    return commonSuffix(text.slice(Math.max(0, s - CTX), s), a.pre || '') + commonPrefix(text.slice(e, e + CTX), a.suf || '');
  }

  /* The four-step re-attach. Returns [start, end] or null (→ tray). */
  function resolveText(a) {
    if (!a || !a.q) return null;
    const text = index().text;
    // 1. Exact: same words at the same place.
    if (text.slice(a.s, a.e) === a.q) return [a.s, a.e];
    // 2. Same words elsewhere; the surrounding context picks the occurrence.
    //    A short quote must bring some of its surroundings, or it would jump
    //    to the same word in another paragraph.
    const len = a.q.length;
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

  /* ---------- paragraphs (what boxes follow) ---------- */

  function blocks() {
    if (!T.blocks) {
      T.blocks = Array.from(T.prose.children)
        .filter((el) => !el.hasAttribute('data-atlas-ui'))
        .map((el) => {
          const t = normText(el);
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

  // Box anchors: a paragraph, or the very top / very end of the article.
  function resolveBoxAnchor(a) {
    if (!a) return null;
    if (a.top) return 'top';
    if (a.end) return 'end';
    return resolveBlock(a);
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

  function topBlockOf(node) {
    let el = node.nodeType === 1 ? node : node.parentElement;
    while (el && el.parentElement !== T.prose) el = el.parentElement;
    return el && !el.hasAttribute('data-atlas-ui') ? el : null;
  }

  function sectionTitleBefore(el) {
    for (let n = el; n; n = n.previousElementSibling) {
      if (n.tagName === 'H2') return normText(n).replace(/^#\s*/, '');
    }
    return '';
  }

  /* ---------- setup / teardown ---------- */

  function setup(topic) {
    teardown();
    const article = view.querySelector('article.topic');
    const prose = article && article.querySelector('.prose');
    if (!prose) return;

    T = { topic, slug: topic.slug, article, prose, recs: new Map(), res: new Map(), orphans: [], ix: null, blocks: null };
    for (const r of prepared.get(topic.slug) || []) if (MARK_KINDS.has(r.kind)) T.recs.set(r.id, r);
    prepared.delete(topic.slug);

    T.top = document.createElement('div');
    T.top.className = 'atlas-ink-top';
    T.top.setAttribute('data-atlas-ui', '');
    article.insertBefore(T.top, prose);

    T.markers = document.createElement('div');
    T.markers.className = 'atlas-markers';
    T.markers.setAttribute('data-atlas-ui', '');
    article.appendChild(T.markers);

    resolveAll();
    renderBoxes();
    paintHighlights();
    layout();

    T.ro = new ResizeObserver(() => scheduleLayout());
    T.ro.observe(prose);

    // Ink written straight onto the page by the previous version moves into
    // boxes the first time its topic opens.
    if ([...T.recs.values()].some(isPageInk)) migratePageInk();
  }

  function teardown() {
    finishGesture(true);
    closeMenus();
    if (HAS_HIGHLIGHTS) {
      for (const c of HL) CSS.highlights.delete(`atlas-hl-${c}`);
      CSS.highlights.delete('atlas-hl-preview');
      CSS.highlights.delete('atlas-hl-flash');
    }
    if (T && T.ro) T.ro.disconnect();
    T = null;
    undoStack = [];
    redoStack = [];
    pendingPlace = null;
    pendingReplace = null;
    insertMode = false;
    root.classList.remove('ink-placing');
  }

  /* ---------- resolving and drawing ---------- */

  const live = (kind) => [...T.recs.values()].filter((r) => r.kind === kind && !r.deleted);
  const isPageInk = (r) => r.kind === 'stroke' && !r.deleted && r.data && r.data.a && r.data.a.t !== 'c';
  const boxStrokes = (boxId) => live('stroke').filter((s) => s.data.a && s.data.a.t === 'c' && s.data.a.c === boxId);

  function resolveAll() {
    T.res.clear();
    T.orphans = [];
    for (const h of live('highlight')) {
      const span = resolveText(h.data.a);
      T.res.set(h.id, span);
      if (!span) T.orphans.push({ kind: 'highlight', rec: h });
    }
    for (const c of live('card')) {
      const target = resolveBoxAnchor(c.data.a);
      T.res.set(c.id, target);
      if (!target) T.orphans.push({ kind: 'box', rec: c });
    }
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

  function layout() {
    if (!T) return;
    paintMarkers(T.article.getBoundingClientRect());
    paintTop();
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
      b.style.left = `${Math.min(pr.right - art.left + 6, window.innerWidth - art.left - 30)}px`;
      b.style.top = `${rect.top - art.top + rect.height / 2 - 13}px`;
      b.innerHTML = icon('note', 15, 1.8);
      T.markers.appendChild(b);
    }
  }

  /* ---------- stroke geometry ---------- */

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

  // Box strokes are stored in tenths of a box unit; these convert to and from
  // box units (0–1000 across the box).
  const boxPoints = (s) => decode(s.data.p || []).map(([x, y, q]) => [x * 10, y * 10, q]);
  const packBox = (pts) => encode(pts.map(([x, y, q]) => [x / 10, y / 10, q]));

  /* Variable-width ink outline (pressure, light taper at both ends).
     points: [[x, y, pressure 0..1]]; size: nominal width, same units. */
  function outline(points, size, flat = false) {
    if (!points.length) return '';
    const pts = [points[0]];
    for (let i = 1; i < points.length; i++) {
      const prev = pts[pts.length - 1];
      const p = points[i];
      if (Math.hypot(p[0] - prev[0], p[1] - prev[1]) < 0.35 && i < points.length - 1) continue;
      pts.push([prev[0] + (p[0] - prev[0]) * 0.65, prev[1] + (p[1] - prev[1]) * 0.65, p[2]]);
    }
    pts.push(points[points.length - 1]);
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

  const penClass = (c) => `pen-${PENS.includes(c) ? c : 'ink'}`;

  function pathEl(d, pen, id) {
    const p = document.createElementNS(SVGNS, 'path');
    p.setAttribute('d', d);
    p.setAttribute('class', penClass(pen));
    if (id) p.dataset.id = id;
    return p;
  }

  /* A small preview of a box's strokes, scaled to fit. */
  function thumb(strokes, maxW = 120, maxH = 44) {
    const all = strokes.flatMap(boxPoints);
    if (!all.length) return '<svg class="atlas-thumb" viewBox="0 0 10 10" aria-hidden="true"></svg>';
    const xs = all.map((p) => p[0]);
    const ys = all.map((p) => p[1]);
    const x0 = Math.min(...xs);
    const y0 = Math.min(...ys);
    const w = Math.max(1, Math.max(...xs) - x0);
    const h = Math.max(1, Math.max(...ys) - y0);
    const scale = Math.min(maxW / w, maxH / h);
    const paths = strokes
      .map((s) => {
        const pts = boxPoints(s).map(([x, y, q]) => [(x - x0) * scale + 3, (y - y0) * scale + 3, q]);
        return `<path class="${penClass(s.data.c)}" d="${outline(pts, Math.max(1.2, (s.data.w || 5) * scale), s.data.c === 'marker')}"/>`;
      })
      .join('');
    return `<svg class="atlas-thumb" viewBox="0 0 ${Math.ceil(w * scale) + 6} ${Math.ceil(h * scale) + 6}" aria-hidden="true">${paths}</svg>`;
  }

  /* ---------- scribble boxes ---------- */

  function boxLabel(c) {
    if ((c.data.label || '').trim()) return c.data.label.trim();
    const a = c.data.a || {};
    if (a.top) return 'Scribble · top of the topic';
    if (a.end) return 'Scribble · end of the topic';
    const q = (a.q || '').replace(/^#\s*/, '');
    return `Scribble · after “${q.slice(0, 42)}${q.length > 42 ? '…' : ''}”`;
  }

  const PEN_LABEL = { ink: 'Ink', red: 'Red', blue: 'Blue', green: 'Green', marker: 'Marker' };

  function boxToolsHtml() {
    return `<div class="sb-tools" role="toolbar" aria-label="Scribble tools">
        <div class="sb-pens">${PENS.map(
          (c) => `<button type="button" class="swatch pen-${c}${tool.pen === c && !eraser ? ' on' : ''}" data-sb="pen" data-v="${c}" aria-label="${PEN_LABEL[c]} pen"></button>`
        ).join('')}</div>
        <div class="sb-sizes">${Object.keys(SIZES)
          .map((s) => `<button type="button" class="size-${s}${tool.size === s ? ' on' : ''}" data-sb="size" data-v="${s}" aria-label="${s} line"><i></i></button>`)
          .join('')}</div>
        <button type="button" class="sb-btn${eraser ? ' on' : ''}" data-sb="eraser" aria-pressed="${eraser}" aria-label="Eraser">${svgIcon('eraser', 18)}</button>
        <button type="button" class="sb-btn" data-sb="undo" ${undoStack.length ? '' : 'disabled'} aria-label="Undo">${svgIcon('undo', 18)}</button>
        <button type="button" class="sb-btn" data-sb="redo" ${redoStack.length ? '' : 'disabled'} aria-label="Redo">${svgIcon('redo', 18)}</button>
      </div>`;
  }

  function renderBoxes() {
    for (const el of T.prose.querySelectorAll('.scribble')) el.remove();
    const cards = live('card').sort((a, b) => (a.data.at || 0) - (b.data.at || 0));
    for (const c of cards) {
      const target = T.res.get(c.id);
      if (!target) continue;
      const el = document.createElement('section');
      el.className = 'scribble';
      el.setAttribute('data-atlas-ui', '');
      el.dataset.card = c.id;
      paintBox(el, c);
      if (target === 'top') {
        const first = blocks()[0];
        T.prose.insertBefore(el, first ? first.el : T.prose.firstChild);
      } else if (target === 'end') {
        T.prose.appendChild(el);
      } else {
        // after its paragraph, and after boxes already placed there
        let ref = target.nextSibling;
        while (ref && ref.nodeType === 1 && ref.classList.contains('scribble')) ref = ref.nextSibling;
        T.prose.insertBefore(el, ref);
      }
    }
    if (insertMode) renderPlus();
  }

  function paintBox(el, c) {
    const collapsed = c.data.collapsed != null ? c.data.collapsed : tool.collapsed;
    const h = Math.max(0.2, Math.min(BOX_MAX, c.data.h || BOX_START));
    const paper = PAPERS.includes(c.data.paper) ? c.data.paper : 'dots';
    const strokes = boxStrokes(c.id);
    el.classList.toggle('collapsed', !!collapsed);
    el.dataset.paper = paper;
    const pid = `pp-${c.id}`;
    const pattern =
      paper === 'dots'
        ? `<pattern id="${pid}" width="25" height="25" patternUnits="userSpaceOnUse"><circle class="paper-mark" cx="12.5" cy="12.5" r="1.7"/></pattern>`
        : paper === 'lines'
          ? `<pattern id="${pid}" width="1000" height="40" patternUnits="userSpaceOnUse"><rect class="paper-mark" x="0" y="39" width="1000" height="1.4"/></pattern>`
          : '';
    el.innerHTML = `
      <header class="sb-head">
        <button type="button" class="sb-title" data-sb="collapse" aria-expanded="${!collapsed}">
          <span class="sb-chev">${svgIcon('chev', 16)}</span><span class="sb-label">${esc(boxLabel(c))}</span>
        </button>
        ${collapsed ? '' : boxToolsHtml()}
        <button type="button" class="sb-btn" data-sb="more" aria-label="Box options">${svgIcon('more', 18)}</button>
      </header>
      ${
        collapsed
          ? `<button type="button" class="sb-peek" data-sb="collapse">${thumb(strokes, 200, 46)}<span>${strokes.length ? `${strokes.length} stroke${strokes.length === 1 ? '' : 's'} · tap to open` : 'Empty · tap to open'}</span></button>`
          : `<div class="sb-body">
              <svg class="scribble-pad" viewBox="0 0 1000 ${Math.round(h * 1000)}" preserveAspectRatio="xMidYMid meet" aria-label="Scribble area">
                <defs>${pattern}</defs>
                ${pattern ? `<rect class="paper" x="0" y="0" width="1000" height="${Math.round(h * 1000)}" fill="url(#${pid})"/>` : ''}
                <g class="strokes"></g>
              </svg>
              ${h >= BOX_MAX - 0.01 ? `<button type="button" class="sb-another" data-sb="another">${svgIcon('plus', 16)} Another box below</button>` : ''}
            </div>`
      }`;
    if (!collapsed) {
      const g = el.querySelector('.strokes');
      for (const s of strokes) g.appendChild(pathEl(outline(boxPoints(s), s.data.w || SIZES.medium, s.data.c === 'marker'), s.data.c, s.id));
    }
  }

  function repaintBox(id) {
    const el = T && T.prose.querySelector(`.scribble[data-card="${id}"]`);
    const c = T && T.recs.get(id);
    if (el && c && !c.deleted) paintBox(el, c);
  }

  function refreshToolbars() {
    if (!T) return;
    for (const el of T.prose.querySelectorAll('.scribble:not(.collapsed)')) {
      const tools = el.querySelector('.sb-tools');
      if (tools) tools.outerHTML = boxToolsHtml();
    }
  }

  async function addBox(anchor, { open = true } = {}) {
    if (!T) return null;
    const rec = {
      id: Store.newId('c'),
      kind: 'card',
      topic: T.slug,
      data: { a: anchor, h: BOX_START, paper: tool.paper, collapsed: false, at: now() },
    };
    await commit([rec], [null]);
    if (open) {
      const el = T.prose.querySelector(`.scribble[data-card="${rec.id}"]`);
      if (el) {
        const r = el.getBoundingClientRect();
        if (r.top < 80 || r.bottom > window.innerHeight - 40) {
          window.scrollTo({ top: Math.max(0, window.scrollY + r.top - window.innerHeight * 0.25), behavior: 'smooth' });
        }
        el.classList.add('fresh');
        setTimeout(() => el.classList.remove('fresh'), 1400);
      }
    }
    return rec;
  }

  /* ＋ markers between blocks while adding a box. */
  function setInsertMode(on) {
    if (!T) return;
    insertMode = !!on;
    closeMenus();
    renderPlus();
    syncDock();
    if (insertMode) Atlas.toast('Tap ＋ where you want to write.', { ms: 2400 });
  }

  function renderPlus() {
    for (const el of T.prose.querySelectorAll('.scribble-plus')) el.remove();
    if (!insertMode) return;
    const list = blocks();
    list.forEach((b, i) => {
      if (/^H[1-6]$/.test(b.el.tagName)) return; // never between a heading and its text
      const next = list[i + 1];
      const end = !next || next.el.tagName === 'H2';
      const title = sectionTitleBefore(b.el);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = `scribble-plus${end ? ' end' : ''}`;
      btn.setAttribute('data-atlas-ui', '');
      btn.dataset.after = String(i);
      btn.innerHTML = `<span>${svgIcon('plus', 15)}${end ? (next ? `Scribble at the end of “${esc(title || 'this section')}”` : 'Scribble at the end of the topic') : 'Scribble here'}</span>`;
      let ref = b.el.nextSibling;
      while (ref && ref.nodeType === 1 && ref.classList.contains('scribble')) ref = ref.nextSibling;
      T.prose.insertBefore(btn, ref);
    });
  }

  /* ---------- moving page ink from the previous version into boxes ---------- */

  async function migratePageInk() {
    const old = [...T.recs.values()].filter(isPageInk);
    if (!old.length) return;
    const groups = new Map();
    for (const s of old) {
      const g = s.data.g || s.id;
      if (!groups.has(g)) groups.set(g, []);
      groups.get(g).push(s);
    }
    const em = parseFloat(getComputedStyle(T.prose).fontSize) || 17.5;
    const widthEm = T.prose.getBoundingClientRect().width / em;
    const HEAD = ['crumbs', 'topic-title', 'topic-summary', 'badges', 'prereq'];
    const out = [];
    const before = [];
    for (const [g, strokes] of groups) {
      const a = strokes[0].data.a;
      let anchor = null;
      let unitPx = em; // what one stored unit is in px
      if (a.t === 'w') {
        const span = resolveText(a);
        const node = span && locate(index(), span[0])[0];
        const block = node && topBlockOf(node);
        if (block) anchor = blockAnchor(block);
      } else if (a.t === 'b') {
        const block = resolveBlock(a);
        if (block) {
          anchor = blockAnchor(block);
          if (a.u === 'w') unitPx = block.getBoundingClientRect().width;
        }
      } else if (a.t === 'e') {
        anchor = HEAD.includes(a.k) ? { top: true } : { end: true };
      }
      if (!anchor) {
        const list = blocks();
        anchor = list.length ? blockAnchor(list[list.length - 1].el) : { end: true };
      }
      // Lay the group into a box at the same size, keeping its shape.
      const ptsEm = strokes.map((s) => decode(s.data.p || []).map(([x, y, q]) => [(x * unitPx) / em, (y * unitPx) / em, q]));
      const flat = ptsEm.flat();
      if (!flat.length) continue;
      const x0 = Math.min(...flat.map((p) => p[0]));
      const y0 = Math.min(...flat.map((p) => p[1]));
      const x1 = Math.max(...flat.map((p) => p[0]));
      const y1 = Math.max(...flat.map((p) => p[1]));
      const padEm = 1.2;
      const scale = Math.min(1, (widthEm - padEm * 2) / Math.max(0.1, x1 - x0));
      const k = (1000 / widthEm) * scale; // em → box units
      const padU = padEm * (1000 / widthEm);
      const boxId = `c_m_${g}`;
      const h = Math.max(0.22, Math.min(BOX_MAX, ((y1 - y0) * k + padU * 2) / 1000));
      out.push({ id: boxId, kind: 'card', topic: T.slug, data: { a: anchor, h, paper: 'blank', collapsed: false, at: strokes[0].data.at || now(), migrated: true } });
      before.push(null);
      strokes.forEach((s, i) => {
        const pts = ptsEm[i].map(([x, y, q]) => [(x - x0) * k + padU, (y - y0) * k + padU, q]);
        const wEm = ((s.data.w || 0.12) * unitPx) / em;
        out.push({
          id: `s_m_${s.id}`,
          kind: 'stroke',
          topic: T.slug,
          data: { g: boxId, a: { t: 'c', c: boxId }, c: s.data.c || 'ink', w: Math.max(1.5, wEm * k), p: packBox(pts), at: s.data.at || now() },
        });
        before.push(null);
        out.push(deleted(s, { migrated: true }));
        before.push(s);
      });
    }
    if (!out.length) return;
    await commit(out, before, { undoable: false });
    Atlas.toast('Your ink on this page now lives in scribble boxes, right after the paragraphs you wrote on.', { ms: 5000 });
  }

  /* ---------- the strip above the article: orphans ---------- */

  function paintTop() {
    if (!T.orphans.length) {
      T.top.innerHTML = '';
      return;
    }
    const items = T.orphans
      .map((o) => {
        if (o.kind === 'highlight') {
          return `<li><span class="dot hl-${esc(o.rec.data.c)}"></span><q>${esc((o.rec.data.a.q || '').slice(0, 160))}</q>
            <span class="acts"><button type="button" class="btn small" data-orphan="replace" data-id="${o.rec.id}">Place again</button>
            <button type="button" class="btn small danger" data-orphan="delete" data-id="${o.rec.id}">Delete</button></span></li>`;
        }
        return `<li>${thumb(boxStrokes(o.rec.id))}<span class="what">${esc(boxLabel(o.rec))}</span>
          <span class="acts"><button type="button" class="btn small" data-orphan="place" data-id="${o.rec.id}">Put it here</button>
          <button type="button" class="btn small danger" data-orphan="delete-box" data-id="${o.rec.id}">Delete</button></span></li>`;
      })
      .join('');
    const n = T.orphans.length;
    T.top.innerHTML = `<details class="atlas-orphans" open><summary>${n} mark${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} a new home</summary>
      <p>The text these were attached to has changed. Nothing was deleted — place each one again or remove it.</p><ul>${items}</ul></details>`;
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
    refreshToolbars();
    return saved;
  }

  /* Fold records (local or from sync) into what's on screen. Only what
     changed is redrawn: a new stroke repaints its own box, nothing else. */
  function absorb(records) {
    if (!T) return;
    const mine = records.filter((r) => r.topic === T.slug && MARK_KINDS.has(r.kind));
    if (!mine.length) return;
    for (const r of mine) T.recs.set(r.id, r);
    const onlyStrokes = mine.every((r) => r.kind === 'stroke' && r.data && r.data.a && r.data.a.t === 'c');
    if (onlyStrokes) {
      for (const id of new Set(mine.map((r) => r.data.a.c))) repaintBox(id);
      return;
    }
    resolveAll();
    renderBoxes();
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
    refreshToolbars();
  }

  async function redo() {
    const step = redoStack.pop();
    if (!step) return;
    absorb(await Store.put(step.after));
    undoStack.push(step);
    refreshToolbars();
  }

  /* ---------- touch and pointer input ---------- */

  let gesture = null;
  let draftTimer = 0;
  let watchdog = 0;
  let suppressClick = false; // the one click a mouse drag generates

  const drawsWith = (e) => e.pointerType === 'pen' || e.pointerType === 'mouse' || (tool.finger && e.pointerType === 'touch');
  const inUi = (t) => !!t.closest('button, input, textarea, select, label, a.btn, [contenteditable], [data-atlas-menu], #atlas-dock');

  function armWatchdog() {
    clearTimeout(watchdog);
    watchdog = setTimeout(() => {
      if (gesture) finishGesture(false);
    }, STROKE_IDLE_MS);
  }

  /* The only touches ever cancelled: a Pencil (or, if enabled, a finger) in a
     box, a Pencil on text with the highlighter on, and anything while a stroke
     is in progress. A finger outside a box always scrolls. */
  view.addEventListener(
    'touchstart',
    (e) => {
      if (!T) return;
      const touches = Array.from(e.changedTouches);
      const stylus = touches.find((t) => t.touchType === 'stylus');
      const pad = e.target.closest && e.target.closest('.scribble-pad');
      if (gesture || (pad && (stylus || tool.finger))) {
        e.preventDefault();
        return;
      }
      if (stylus && tool.hl && e.target.closest('.prose') && !e.target.closest('[data-atlas-ui]') && caretAt(stylus.clientX, stylus.clientY) >= 0) {
        e.preventDefault();
      }
    },
    { passive: false }
  );
  view.addEventListener(
    'touchmove',
    (e) => {
      if (gesture) e.preventDefault();
    },
    { passive: false }
  );

  view.addEventListener('pointerdown', (e) => {
    suppressClick = false;
    if (!T || e.button > 0) return;
    if (gesture) finishGesture(false); // a stroke whose lift never came is saved, not lost
    if (pendingPlace) {
      if (inUi(e.target)) return;
      e.preventDefault();
      placeBoxAt(e.clientY);
      return;
    }
    const pad = e.target.closest('.scribble-pad');
    if (pad) {
      if (!drawsWith(e)) return; // a finger scrolls past the box
      e.preventDefault();
      capture(e);
      closeMenus();
      if (eraser) startErase(e, pad);
      else startInk(e, pad);
      gesture.mouse = e.pointerType === 'mouse';
      armWatchdog();
      return;
    }
    if (tool.hl && (e.pointerType === 'pen' || e.pointerType === 'mouse') && e.target.closest('.prose') && !inUi(e.target) && !e.target.closest('[data-atlas-ui]')) {
      const at = caretAt(e.clientX, e.clientY);
      if (at < 0) return;
      e.preventDefault();
      capture(e);
      closeMenus();
      startHighlight(e, at);
      gesture.mouse = e.pointerType === 'mouse';
      armWatchdog();
    }
  });

  function capture(e) {
    try {
      view.setPointerCapture(e.pointerId);
    } catch {
      /* synthetic or already released */
    }
  }

  view.addEventListener('pointermove', (e) => {
    if (!gesture) {
      // The safety timer ended a stroke while the Pencil rested; carry on.
      const pad = e.buttons === 1 && drawsWith(e) && !eraser && e.target.closest && e.target.closest('.scribble-pad');
      if (pad && T) {
        startInk(e, pad);
        armWatchdog();
      }
      return;
    }
    if (e.pointerId !== gesture.id) return;
    e.preventDefault();
    armWatchdog();
    if (gesture.type === 'hl') moveHighlight(e);
    else if (gesture.type === 'ink') moveInk(e);
    else if (gesture.type === 'erase') eraseAt(e);
  });

  // On the whole window: wherever the Pencil lifts, the stroke ends.
  const end = (e) => {
    if (!gesture || e.pointerId !== gesture.id) return;
    finishGesture(e.type === 'pointercancel');
  };
  window.addEventListener('pointerup', end, true);
  window.addEventListener('pointercancel', end, true);

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
    clearTimeout(watchdog);
    if (g.mouse && !cancelled) suppressClick = true;
    if (g.type === 'hl') endHighlight(g, cancelled);
    else if (g.type === 'ink') endInk(g, cancelled);
    else if (g.type === 'erase') endErase(g);
  }

  /* Two-finger tap inside a box: eraser on/off. Touch events on the iPad
     (pointer events get cancelled when iOS suspects a pinch); pointer events
     elsewhere. */
  let twoTap = null;
  const TAP_MS = 350;
  const TAP_SLOP = 14;
  if ('ontouchstart' in window) {
    view.addEventListener(
      'touchstart',
      (e) => {
        if (!e.target.closest || !e.target.closest('.scribble')) return;
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
          if (s0 && Math.hypot(t.clientX - s0[0], t.clientY - s0[1]) > TAP_SLOP) twoTap.moved = true;
        }
      },
      { passive: true }
    );
    view.addEventListener(
      'touchend',
      (e) => {
        if (!twoTap || e.touches.length) return;
        const t = twoTap;
        twoTap = null;
        if (t.n === 2 && !t.moved && now() - t.at < TAP_MS) toggleEraser();
      },
      { passive: true }
    );
    view.addEventListener('touchcancel', () => (twoTap = null), { passive: true });
  } else {
    const fingers = new Map();
    view.addEventListener(
      'pointerdown',
      (e) => {
        if (e.pointerType !== 'touch' || !e.target.closest('.scribble')) return;
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
        if (f && twoTap && Math.hypot(e.clientX - f[0], e.clientY - f[1]) > TAP_SLOP) twoTap.moved = true;
      },
      true
    );
    view.addEventListener(
      'pointerup',
      (e) => {
        if (!fingers.delete(e.pointerId) || fingers.size || !twoTap) return;
        const t = twoTap;
        twoTap = null;
        if (t.n === 2 && !t.moved && now() - t.at < TAP_MS) toggleEraser();
      },
      true
    );
    view.addEventListener('pointercancel', (e) => fingers.delete(e.pointerId), true);
  }

  function toggleEraser() {
    eraser = !eraser;
    refreshToolbars();
    Atlas.toast(eraser ? 'Eraser on — swipe over strokes to remove them.' : 'Pen on.', { ms: 1200 });
  }

  /* ---------- highlighting ---------- */

  function startHighlight(e, at) {
    root.style.setProperty('--hl-preview', `var(--hl-${tool.hlColor})`);
    gesture = { type: 'hl', id: e.pointerId, start: at, end: at, x: e.clientX, y: e.clientY, moved: false };
  }

  function moveHighlight(e) {
    const g = gesture;
    if (Math.hypot(e.clientX - g.x, e.clientY - g.y) > 6) g.moved = true;
    const at = caretAt(e.clientX, e.clientY);
    if (at >= 0) g.end = at;
    if (!HAS_HIGHLIGHTS || !g.moved) return;
    const [s, en] = snap(index().text, g.start, g.end);
    if (en > s) CSS.highlights.set('atlas-hl-preview', new Highlight(rangeOf(s, en)));
  }

  async function endHighlight(g, cancelled) {
    if (HAS_HIGHLIGHTS) CSS.highlights.delete('atlas-hl-preview');
    if (cancelled || !T) return;
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
      data: { a: textAnchor(s, e), c: extra.color || tool.hlColor, n: extra.note || '', at: now() },
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

  /* ---------- writing in a box ---------- */

  function padPoint(ev, pad) {
    const r = pad.getBoundingClientRect();
    const k = 1000 / r.width;
    const q = ev.pointerType === 'pen' && ev.pressure > 0 ? ev.pressure : 0.5;
    return [(ev.clientX - r.left) * k, (ev.clientY - r.top) * k, q];
  }

  function startInk(e, pad) {
    const box = pad.closest('.scribble');
    gesture = {
      type: 'ink',
      id: e.pointerId,
      box: box.dataset.card,
      pad,
      pts: [],
      pen: tool.pen,
      size: tool.size,
      startedAt: now(),
      rid: Store.newId('s'),
    };
    gesture.live = pathEl('', tool.pen);
    pad.querySelector('.strokes').appendChild(gesture.live);
    addPoints(e);
    clearInterval(draftTimer);
    draftTimer = setInterval(saveDraftNow, 250);
  }

  function addPoints(e) {
    const g = gesture;
    const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [];
    for (const ev of list.length ? list : [e]) {
      const p = padPoint(ev, g.pad);
      const last = g.pts[g.pts.length - 1];
      if (!last || Math.hypot(p[0] - last[0], p[1] - last[1]) >= 0.5) g.pts.push(p);
    }
  }

  const strokeWidth = (pen, size) => (SIZES[size] || SIZES.medium) * (pen === 'marker' ? MARKER : 1);

  let liveQueued = false;
  function moveInk(e) {
    addPoints(e);
    if (liveQueued) return;
    liveQueued = true;
    requestAnimationFrame(() => {
      liveQueued = false;
      const g = gesture;
      if (!g || g.type !== 'ink') return;
      g.live.setAttribute('d', outline(g.pts, strokeWidth(g.pen, g.size), g.pen === 'marker'));
    });
  }

  function strokeRecord(g) {
    if (!g.pts.length) return null;
    return {
      id: g.rid,
      kind: 'stroke',
      topic: T.slug,
      data: { g: g.box, a: { t: 'c', c: g.box }, c: g.pen, w: strokeWidth(g.pen, g.size), p: packBox(g.pts), at: g.startedAt },
    };
  }

  function saveDraftNow() {
    const g = gesture;
    if (!g || g.type !== 'ink' || !T) return;
    const rec = strokeRecord(g);
    if (rec) Store.saveDraft(rec).catch(() => {});
  }

  async function endInk(g, cancelled) {
    clearInterval(draftTimer);
    if (g.live) g.live.remove();
    // iOS can cancel a touch mid-stroke; ink already drawn is kept.
    if (!T || !g.pts.length || (cancelled && g.pts.length < 3)) {
      Store.saveDraft(undefined).catch(() => {});
      return;
    }
    const rec = strokeRecord(g);
    const card = T.recs.get(g.box);
    const after = [rec];
    const before = [null];
    // Writing near the bottom makes the box grow, like a Notes page.
    if (card) {
      const h = card.data.h || BOX_START;
      const lowest = Math.max(...g.pts.map((p) => p[1]));
      if (lowest > h * 1000 * 0.78 && h < BOX_MAX) {
        after.push({ ...card, data: { ...card.data, h: Math.min(BOX_MAX, h + 0.3) } });
        before.push(card);
      }
    }
    await commit(after, before);
    Store.saveDraft(undefined).catch(() => {});
  }

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

  /* ---------- eraser (inside boxes) ---------- */

  function distToSeg(px, py, ax, ay, bx, by) {
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    let t = len ? ((px - ax) * dx + (py - ay) * dy) / len : 0;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  }

  function startErase(e, pad) {
    const box = pad.closest('.scribble').dataset.card;
    gesture = { type: 'erase', id: e.pointerId, box, pad, ids: new Set(), cache: boxStrokes(box).map((s) => ({ s, pts: boxPoints(s) })) };
    eraseAt(e);
  }

  /* Checks the whole path since the last sample, not just the sample: a quick
     swipe can jump right over a thin stroke between two reported points. */
  function eraseAt(e) {
    const g = gesture;
    const [x, y] = padPoint(e, g.pad);
    const tol = 12;
    const from = g.last || [x, y];
    g.last = [x, y];
    const steps = Math.max(1, Math.ceil(Math.hypot(x - from[0], y - from[1]) / 6));
    for (let k = 1; k <= steps; k++) {
      const px = from[0] + ((x - from[0]) * k) / steps;
      const py = from[1] + ((y - from[1]) * k) / steps;
      for (const { s, pts } of g.cache) {
        if (g.ids.has(s.id)) continue;
        const w = (s.data.w || 5) / 2;
        for (let i = 0; i < pts.length; i++) {
          const a = pts[i];
          const b = pts[Math.min(i + 1, pts.length - 1)];
          if (distToSeg(px, py, a[0], a[1], b[0], b[1]) <= tol + w) {
            g.ids.add(s.id);
            const el = g.pad.querySelector(`[data-id="${s.id}"]`);
            if (el) el.style.opacity = '0.15';
            break;
          }
        }
      }
    }
  }

  async function endErase(g) {
    if (!g.ids.size || !T) return;
    const before = [...g.ids].map((id) => T.recs.get(id)).filter(Boolean);
    await commit(before.map((r) => deleted(r)), before);
    Atlas.toast(`${before.length} stroke${before.length === 1 ? '' : 's'} erased.`, { action: 'Undo', onAction: undo });
  }

  /* ---------- placing boxes from the tray ---------- */

  async function placeBoxAt(y) {
    const id = pendingPlace;
    pendingPlace = null;
    root.classList.remove('ink-placing');
    const rec = T.recs.get(id);
    const block = blockAtY(y);
    if (!rec || !block) return;
    await commit([{ ...rec, data: { ...rec.data, a: blockAnchor(block) } }], [rec]);
    Atlas.toast('Box placed.');
  }

  /* ---------- clicks: boxes, markers, tray, ＋ ---------- */

  view.addEventListener('click', async (e) => {
    if (!T) return;
    const plus = e.target.closest('.scribble-plus');
    if (plus) {
      e.preventDefault();
      const b = blocks()[Number(plus.dataset.after)];
      insertMode = false;
      renderPlus(); // clears the markers
      syncDock();
      if (b) await addBox(blockAnchor(b.el));
      else renderPlus();
      return;
    }
    const marker = e.target.closest('.atlas-marker');
    if (marker) {
      const h = T.recs.get(marker.dataset.hl);
      if (h) openHighlightMenu([h], marker.getBoundingClientRect());
      return;
    }
    const sb = e.target.closest('[data-sb]');
    if (sb) {
      e.preventDefault();
      const box = sb.closest('.scribble');
      const rec = box && T.recs.get(box.dataset.card);
      if (!rec) return;
      await boxAction(sb.dataset.sb, sb, rec);
      return;
    }
    const orphan = e.target.closest('[data-orphan]');
    if (orphan) {
      e.preventDefault();
      const id = orphan.dataset.id;
      const rec = T.recs.get(id);
      const act = orphan.dataset.orphan;
      if (act === 'replace') {
        pendingReplace = id;
        if (!tool.hl) setHighlighter(true);
        Atlas.toast('Swipe the Pencil across the passage this highlight belongs to — or select it with a finger.');
      } else if (act === 'delete' && rec) {
        await commit([deleted(rec)], [rec]);
      } else if (act === 'delete-box' && rec) {
        const strokes = boxStrokes(id);
        await commit([rec, ...strokes].map((r) => deleted(r)), [rec, ...strokes]);
      } else if (act === 'place') {
        pendingPlace = id;
        root.classList.add('ink-placing');
        Atlas.toast('Tap the paragraph this box should follow.');
      }
    }
  });

  async function boxAction(act, btn, rec) {
    switch (act) {
      case 'collapse': {
        const collapsed = rec.data.collapsed != null ? rec.data.collapsed : tool.collapsed;
        await commit([{ ...rec, data: { ...rec.data, collapsed: !collapsed } }], [rec], { undoable: false });
        return;
      }
      case 'pen':
        tool.pen = btn.dataset.v;
        eraser = false;
        saveTool();
        refreshToolbars();
        return;
      case 'size':
        tool.size = btn.dataset.v;
        eraser = false;
        saveTool();
        refreshToolbars();
        return;
      case 'eraser':
        toggleEraser();
        return;
      case 'undo':
        return undo();
      case 'redo':
        return redo();
      case 'another':
        return addBox(rec.data.a);
      case 'more':
        return openBoxMenu(rec, btn.getBoundingClientRect());
    }
  }

  /* ---------- tapping a highlight ---------- */

  view.addEventListener('click', (e) => {
    if (!T || pendingPlace) return;
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
    const left = Math.max(10, Math.min(window.innerWidth - w - 10, rect.left + rect.width / 2 - w / 2));
    let top = rect.bottom + 10;
    if (top + h > window.innerHeight - 20) top = Math.max(10, rect.top - h - 10);
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
  }

  function newMenu(extraClass = '') {
    closeMenus();
    menu = document.createElement('div');
    menu.className = `atlas-menu ${extraClass}`.trim();
    menu.setAttribute('data-atlas-menu', '');
    menu.setAttribute('data-atlas-ui', '');
    return menu;
  }

  function highlightRect(h) {
    const span = T.res.get(h.id);
    if (!span) return null;
    return rangeOf(span[0], span[1]).getClientRects()[0] || null;
  }

  function openHighlightMenu(hits, rect) {
    const h = hits[0];
    rect = rect || highlightRect(h);
    if (!rect) return;
    const m = newMenu();
    const others = hits.slice(1);
    m.innerHTML = `
      ${others.length ? `<div class="menu-note">${hits.length} highlights overlap here · <button type="button" data-menu="next">Next</button></div>` : ''}
      <div class="menu-row">${HL.map((c) => `<button type="button" class="swatch hl-${c}${h.data.c === c ? ' on' : ''}" data-menu="color" data-c="${c}" aria-label="${c}"></button>`).join('')}
        <span class="menu-sep"></span>
        <button type="button" data-menu="note">${icon('note', 16)} ${h.data.n ? 'Edit note' : 'Note'}</button>
        <button type="button" data-menu="scribble">${svgIcon('plus', 16)} Scribble below</button>
        <button type="button" data-menu="copy">Copy</button>
        <button type="button" data-menu="delete" class="danger">Delete</button></div>
      ${h.data.n ? `<div class="menu-text">${esc(h.data.n)}</div>` : ''}`;
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      const act = b.dataset.menu;
      const cur = T && T.recs.get(h.id);
      if (!cur) return closeMenus();
      if (act === 'next') return openHighlightMenu([...others, h]);
      if (act === 'color') {
        await commit([{ ...cur, data: { ...cur.data, c: b.dataset.c } }], [cur]);
        tool.hlColor = b.dataset.c;
        saveTool();
        syncDock();
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
      } else if (act === 'scribble') {
        closeMenus();
        const span = T.res.get(cur.id);
        const block = span && topBlockOf(locate(index(), span[1] - 1)[0]);
        if (block) addBox(blockAnchor(block));
      }
    });
    placeMenu(m, rect);
  }

  function openNoteEditor(h, rect, { isNew } = {}) {
    const m = newMenu('atlas-note-editor');
    m.innerHTML = `<div class="menu-quote">“${esc(h.data.a.q.slice(0, 140))}${h.data.a.q.length > 140 ? '…' : ''}”</div>
      <textarea id="atlas-hl-note" rows="4" placeholder="Your note — type, or write with the Pencil (Scribble)">${esc(h.data.n || '')}</textarea>
      <div class="menu-row end"><button type="button" data-menu="cancel">${isNew ? 'Skip' : 'Cancel'}</button><button type="button" class="primary" data-menu="save">Save note</button></div>`;
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      if (b.dataset.menu === 'save') {
        const cur = T && T.recs.get(h.id);
        const text = m.querySelector('textarea').value;
        if (cur) await commit([{ ...cur, data: { ...cur.data, n: text.trim() ? text : '' } }], [cur]);
      }
      closeMenus();
    });
    placeMenu(m, rect);
    const area = m.querySelector('textarea');
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  }

  function openBoxMenu(rec, rect) {
    const m = newMenu('atlas-box-menu');
    const paper = PAPERS.includes(rec.data.paper) ? rec.data.paper : 'dots';
    m.innerHTML = `
      <div class="menu-head">Paper</div>
      <div class="seg full">${PAPERS.map((p) => `<button type="button" data-menu="paper" data-v="${p}" class="${paper === p ? 'on' : ''}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div>
      <div class="menu-head">Label</div>
      <div class="menu-row"><input id="atlas-box-label" class="field" type="text" value="${esc(rec.data.label || '')}" placeholder="Optional — makes the box searchable" maxlength="80"><button type="button" class="primary" data-menu="label">Save</button></div>
      <div class="menu-row end"><button type="button" class="danger" data-menu="delete">${svgIcon('trash', 16)} Delete box</button></div>`;
    m.addEventListener('click', async (e) => {
      const b = e.target.closest('[data-menu]');
      if (!b) return;
      const cur = T && T.recs.get(rec.id);
      if (!cur) return closeMenus();
      if (b.dataset.menu === 'paper') {
        await commit([{ ...cur, data: { ...cur.data, paper: b.dataset.v } }], [cur]);
        tool.paper = b.dataset.v;
        saveTool();
        closeMenus();
      } else if (b.dataset.menu === 'label') {
        const v = m.querySelector('#atlas-box-label').value.trim();
        await commit([{ ...cur, data: { ...cur.data, label: v } }], [cur]);
        closeMenus();
      } else if (b.dataset.menu === 'delete') {
        const strokes = boxStrokes(cur.id);
        await commit([cur, ...strokes].map((r) => deleted(r)), [cur, ...strokes]);
        closeMenus();
        Atlas.toast('Scribble box deleted.', { action: 'Undo', onAction: undo });
      }
    });
    m.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && e.target.id === 'atlas-box-label') m.querySelector('[data-menu="label"]').click();
    });
    placeMenu(m, rect);
  }

  document.addEventListener('pointerdown', (e) => {
    if (menu && !menu.contains(e.target) && !e.target.closest('.atlas-marker, [data-sb="more"]')) closeMenus();
  });
  window.addEventListener(
    'scroll',
    () => {
      if (menu && !menu.classList.contains('atlas-note-editor') && !menu.classList.contains('atlas-box-menu')) closeMenus();
    },
    { passive: true }
  );

  /* ---------- a finger selection: highlight it, note it, scribble below ---------- */

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
        const rect2 = selBar.getBoundingClientRect();
        hideSelectionBar();
        const r = window.getSelection();
        if (r) r.removeAllRanges();
        if (b.dataset.sel === 'note') {
          const rec = await saveHighlight(s, en);
          openNoteEditor(T.recs.get(rec.id) || rec, rect2, { isNew: true });
        } else if (b.dataset.sel === 'scribble') {
          const block = topBlockOf(locate(index(), Math.max(s, en - 1))[0]);
          if (block) addBox(blockAnchor(block));
        } else {
          await saveHighlight(s, en, { color: b.dataset.sel });
          tool.hlColor = b.dataset.sel;
          saveTool();
          syncDock();
        }
      });
      document.body.appendChild(selBar);
    }
    selBar.innerHTML = pendingReplace
      ? `<div class="menu-row"><button type="button" class="primary" data-sel="${esc(tool.hlColor)}">Attach highlight here</button></div>`
      : `<div class="menu-row">${HL.map((c) => `<button type="button" class="swatch hl-${c}" data-sel="${c}" aria-label="Highlight ${c}"></button>`).join('')}
         <span class="menu-sep"></span><button type="button" data-sel="note">${icon('note', 16)} Note</button>
         <button type="button" data-sel="scribble">${svgIcon('plus', 16)} Scribble below</button></div>`;
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
      if (!T || gesture) return hideSelectionBar();
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
    } else {
      const boxId = rec.kind === 'card' ? id : rec.data && rec.data.a && rec.data.a.c;
      const el = boxId && T.prose.querySelector(`.scribble[data-card="${boxId}"]`);
      if (el) {
        rect = el.getBoundingClientRect();
        el.classList.add('fresh');
        setTimeout(() => el.classList.remove('fresh'), 1400);
      }
    }
    if (rect) window.scrollTo(0, Math.max(0, rect.top + window.scrollY - window.innerHeight * 0.3));
  }

  /* ---------- the dock: Highlighter and Scribble ---------- */

  const ICONS = {
    highlighter: '<path d="m9 11-6 6v3h9l3-3"/><path d="m22 12-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4"/>',
    scribble: '<path d="M3 17c3-6 5-10 7-10s-2 10 1 10 4-8 6-8-1 6 1 6 2-2 3-3"/>',
    eraser: '<path d="m7 21-4.3-4.3a1 1 0 0 1 0-1.4l10-10a1 1 0 0 1 1.4 0l5.6 5.6a1 1 0 0 1 0 1.4L13 19"/><path d="M22 21H7M5 11l9 9"/>',
    undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10.5a5.5 5.5 0 0 1 0 11H11"/>',
    redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H9.5a5.5 5.5 0 0 0 0 11H13"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    chev: '<path d="m9 6 6 6-6 6"/>',
    more: '<circle cx="5" cy="12" r="1.3" fill="currentColor"/><circle cx="12" cy="12" r="1.3" fill="currentColor"/><circle cx="19" cy="12" r="1.3" fill="currentColor"/>',
    trash: '<path d="M4 7h16M10 11v6M14 11v6M6 7l1 13h10l1-13M9 7V4h6v3"/>',
    x: '<path d="M6 6l12 12M18 6 6 18"/>',
  };
  function svgIcon(name, size = 20) {
    return `<svg class="ic" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name] || ''}</svg>`;
  }

  const dock = document.createElement('div');
  dock.id = 'atlas-dock';
  dock.setAttribute('data-atlas-ui', '');
  dock.hidden = true;
  document.body.appendChild(dock);

  function syncDock() {
    dock.hidden = !T;
    if (!T) return;
    dock.className = `${tool.hl ? 'hl-on' : ''} ${insertMode ? 'inserting' : ''}`.trim();
    dock.innerHTML = `
      ${tool.hl ? `<div class="dock-colors" role="group" aria-label="Highlighter colour">${HL.map((c) => `<button type="button" class="swatch hl-${c}${tool.hlColor === c ? ' on' : ''}" data-dock="color" data-v="${c}" aria-label="${c}"></button>`).join('')}</div>` : ''}
      <button type="button" class="dock-btn dock-hl hl-${esc(tool.hlColor)}" data-dock="hl" aria-pressed="${tool.hl}">
        ${svgIcon('highlighter', 20)}<span>${tool.hl ? 'Highlighter on' : 'Highlighter'}</span></button>
      <button type="button" class="dock-btn dock-sc" data-dock="scribble" aria-pressed="${insertMode}">
        ${svgIcon(insertMode ? 'x' : 'scribble', 20)}<span>${insertMode ? 'Done' : 'Scribble'}</span></button>`;
  }

  function setHighlighter(on) {
    tool.hl = !!on;
    saveTool();
    syncDock();
    if (tool.hl) Atlas.toast('Highlighter on — swipe the Pencil over text.', { ms: 1800 });
  }

  dock.addEventListener('click', (e) => {
    const b = e.target.closest('[data-dock]');
    if (!b) return;
    if (b.dataset.dock === 'hl') setHighlighter(!tool.hl);
    else if (b.dataset.dock === 'scribble') setInsertMode(!insertMode);
    else if (b.dataset.dock === 'color') {
      tool.hlColor = b.dataset.v;
      saveTool();
      syncDock();
    }
  });

  document.addEventListener('keydown', (e) => {
    if (!T || Atlas.searchOpen() || (e.target.closest && e.target.closest('input, textarea, select'))) return;
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
      return;
    }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'h') setHighlighter(!tool.hl);
    else if (e.key === 's') setInsertMode(!insertMode);
    else if (e.key === 'e') toggleEraser();
    else if (e.key === 'Escape') {
      if (insertMode) setInsertMode(false);
      pendingPlace = null;
      pendingReplace = null;
      root.classList.remove('ink-placing');
    }
  });

  /* ---------- touch diagnostics ---------- */

  let diagEl = null;
  const diagLines = [];
  function diag(e) {
    if (!tool.diag) return;
    if (!diagEl) {
      diagEl = document.createElement('div');
      diagEl.id = 'atlas-diag';
      diagEl.setAttribute('data-atlas-ui', '');
      document.body.appendChild(diagEl);
    }
    const t = e.changedTouches ? e.changedTouches[0] : null;
    const who = t ? `${t.touchType || 'touch'} r=${(t.radiusX || 0).toFixed(1)}` : `${e.pointerType} p=${(e.pressure || 0).toFixed(2)}`;
    const target =
      e.target && e.target.nodeType === 1
        ? `${e.target.tagName.toLowerCase()}${e.target.className && typeof e.target.className === 'string' ? '.' + e.target.className.split(' ')[0] : ''}`
        : '';
    diagLines.push(`${new Date().toTimeString().slice(3, 8)} ${e.type.padEnd(12)} ${who.padEnd(14)} ${target}${e.defaultPrevented ? ' · held' : ''}${gesture ? ` · ${gesture.type}` : ''}`);
    while (diagLines.length > 9) diagLines.shift();
    diagEl.textContent = diagLines.join('\n');
  }
  for (const type of ['pointerdown', 'pointerup', 'pointercancel', 'touchstart', 'touchend', 'touchcancel']) {
    window.addEventListener(type, (e) => setTimeout(() => diag(e), 0), { passive: true, capture: true });
  }
  function setDiag(on) {
    tool.diag = !!on;
    saveTool();
    if (!on && diagEl) {
      diagEl.remove();
      diagEl = null;
      diagLines.length = 0;
    }
  }

  /* ---------- Settings → Pencil ---------- */

  async function paintPencilSettings() {
    const slot = view.querySelector('[data-slot="pencil"]');
    if (!slot) return;
    const recs = await Store.all().catch(() => []);
    const n = (k) => recs.filter((r) => r.kind === k && !r.deleted && !(k === 'stroke' && r.data && r.data.a && r.data.a.t !== 'c')).length;
    const toggle = (key, on) => `<button type="button" class="btn small" data-pencil="${key}" aria-pressed="${on}">${on ? 'On' : 'Off'}</button>`;
    slot.innerHTML = `<section class="block"><h2>Pencil</h2>
      <div class="list">
        <div class="set-row"><div><b>Highlighter</b><small>Turn it on with the button at the bottom right of a topic, then swipe the Pencil over text. Your finger always scrolls; select text with a finger to highlight it any time.</small></div></div>
        <div class="set-row"><div><b>Scribble boxes</b><small>Tap Scribble, then a ＋ after any paragraph. The Pencil writes inside the box; fingers scroll past it. Two-finger tap inside a box switches the eraser.</small></div></div>
        <div class="set-row"><div><b>Draw with a finger in boxes</b><small>For when the Pencil isn’t with you. Fingers then draw instead of scrolling while inside a box.</small></div>${toggle('finger', tool.finger)}</div>
        <div class="set-row"><div><b>Start boxes collapsed</b><small>Keeps topics clean for reading; tap a box to open it.</small></div>${toggle('collapsed', tool.collapsed)}</div>
        <div class="set-row stack"><div><b>Paper for new boxes</b></div><div class="seg full">${PAPERS.map((p) => `<button type="button" data-pencil="paper" data-v="${p}" class="${tool.paper === p ? 'on' : ''}">${p[0].toUpperCase() + p.slice(1)}</button>`).join('')}</div></div>
        <div class="set-row"><div><b>Touch diagnostics</b><small>Shows what the iPad reports for each touch — handy if something feels unresponsive.</small></div>${toggle('diag', tool.diag)}</div>
        <div class="set-row"><div><b>On this iPad</b><small>${n('highlight')} highlights · ${n('card')} scribble boxes · ${n('stroke')} strokes. Deleted marks can be restored from the Library for ${KEEP_DELETED_DAYS} days.</small></div></div>
      </div></section>`;
  }

  view.addEventListener('click', (e) => {
    const b = e.target.closest('[data-pencil]');
    if (!b) return;
    const k = b.dataset.pencil;
    if (k === 'finger') tool.finger = !tool.finger;
    else if (k === 'collapsed') tool.collapsed = !tool.collapsed;
    else if (k === 'paper') tool.paper = b.dataset.v;
    else if (k === 'diag') {
      setDiag(!tool.diag);
      paintPencilSettings();
      return;
    }
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
    const trash = recs.filter((r) => r.deleted && r.data && r.data.del > cutoff && !r.data.compacted && !r.data.migrated);

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
      libFilter === 'all' || (libFilter === 'notes' && (h.data.n || '').trim()) || (HL.includes(libFilter) && h.data.c === libFilter);
    const showBoxes = libFilter === 'all' || libFilter === 'scribbles';

    const sections = [...byTopic.keys()]
      .sort((a, b) => order(a) - order(b))
      .map((slug) => {
        const t = Atlas.topic(slug);
        const list = byTopic.get(slug);
        const hs = list.filter((r) => r.kind === 'highlight' && r.data.a && pass(r)).sort((a, b) => (a.data.a.s || 0) - (b.data.a.s || 0));
        const boxes = showBoxes ? list.filter((r) => r.kind === 'card').sort((a, b) => (a.data.at || 0) - (b.data.at || 0)) : [];
        const pageInk = list.filter(isPageInk);
        if (!hs.length && !boxes.length && !(showBoxes && pageInk.length)) return '';
        const s = t ? Atlas.section(t.section) : null;
        const href = t ? Atlas.topicHref(t) : '#/';
        const rows = hs
          .map(
            (h) => `<a class="ann-row" href="${href}" data-mark="${h.id}"><span class="ann-bar hl-${esc(h.data.c)}"></span>
              <span class="ann-body"><span class="ann-quote">${esc(h.data.a.q)}</span>${h.data.n ? `<span class="ann-note">${esc(h.data.n)}</span>` : ''}</span></a>`
          )
          .join('');
        const boxRows = boxes
          .map((c) => {
            const strokes = list.filter((r) => r.kind === 'stroke' && r.data.a && r.data.a.t === 'c' && r.data.a.c === c.id);
            return `<a class="ann-row ann-box" href="${href}" data-mark="${c.id}">${thumb(strokes, 150, 50)}
              <span class="ann-body"><span class="ann-quote">${esc(boxLabel(c))}</span><span class="ann-note">${strokes.length} stroke${strokes.length === 1 ? '' : 's'}</span></span></a>`;
          })
          .join('');
        const legacy =
          showBoxes && pageInk.length
            ? `<a class="ann-row" href="${href}"><span class="ann-body"><span class="ann-note">Ink from the previous version — opens in scribble boxes</span></span></a>`
            : '';
        return `<div class="ann-topic" style="--a:${s ? s.accent : 'var(--text-dim)'}">
          <div class="ann-head">${t ? `<a href="${href}">${esc(t.title)}</a><small>${esc(s.title)}</small>` : `<b>From a removed topic</b><small>${esc(slug)}</small>`}</div>
          ${rows}${boxRows}${legacy}</div>`;
      })
      .filter(Boolean)
      .join('');

    const groups = new Map();
    for (const r of trash) {
      const key = r.kind === 'stroke' ? `${r.topic}|${r.data.g || r.id}|${Math.round(r.data.del / 60000)}` : r.id;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    const trashRows = [...groups.entries()]
      .sort((a, b) => b[1][0].data.del - a[1][0].data.del)
      .slice(0, 40)
      .map(([key, list]) => {
        const r = list[0];
        const t = Atlas.topic(r.topic);
        const what =
          r.kind === 'highlight'
            ? `“${esc((r.data.a && r.data.a.q ? r.data.a.q : '').slice(0, 90))}”`
            : r.kind === 'card'
              ? 'Scribble box'
              : `Ink · ${list.length} stroke${list.length === 1 ? '' : 's'}`;
        return `<div class="set-row"><div><b>${what}</b><small>${t ? esc(t.title) : esc(r.topic)} · deleted ${Atlas.fmtDate(r.data.del)}</small></div>
          <button type="button" class="btn small" data-restore="${esc(key)}">Restore</button></div>`;
      })
      .join('');
    slot._trash = groups;

    const chips = [['all', 'All'], ...HL.map((c) => [c, c[0].toUpperCase() + c.slice(1)]), ['notes', 'With notes'], ['scribbles', 'Scribbles']]
      .map(([k, l]) => `<button type="button" class="chip${libFilter === k ? ' on' : ''}" data-ann-filter="${k}">${HL.includes(k) ? `<span class="dot hl-${k}"></span>` : ''}${l}</button>`)
      .join('');

    slot.innerHTML = `<section class="block"><h2>Annotations</h2>
        ${active.length ? `<div class="chips ann-filters">${chips}</div>${sections || '<div class="empty">Nothing matches this filter.</div>'}` : '<div class="empty">Highlights and scribble boxes you make on topics collect here. Open a topic and use Highlighter or Scribble at the bottom right.</div>'}
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
      // Restoring a box brings its strokes back; restoring ink in a deleted
      // box brings the box back.
      const extra = [];
      for (const x of list) {
        if (x.kind === 'card') {
          for (const s of await Store.byTopic(x.topic)) {
            if (s.kind === 'stroke' && s.deleted && s.data.a && s.data.a.c === x.id && Math.abs((s.data.del || 0) - (x.data.del || 0)) < 5000) extra.push(s);
          }
        }
        if (x.kind === 'stroke' && x.data.a && x.data.a.t === 'c') {
          const card = await Store.get(x.data.a.c);
          if (card && card.deleted) extra.push(card);
        }
      }
      await Store.put([...list, ...extra].map(restored));
      Atlas.toast('Restored.');
      paintLibrary();
    }
  });

  /* ---------- search over your highlights and box labels ---------- */

  let searchCache = [];
  let cacheTimer = 0;
  function refreshSearchCache() {
    clearTimeout(cacheTimer);
    cacheTimer = setTimeout(async () => {
      try {
        const all = await Store.all();
        searchCache = all
          .filter(
            (r) =>
              !r.deleted &&
              Atlas.topic(r.topic) &&
              ((r.kind === 'highlight' && r.data && r.data.a) || (r.kind === 'card' && (r.data.label || '').trim()))
          )
          .map((r) => ({ r, hay: r.kind === 'highlight' ? `${r.data.a.q} ${r.data.n || ''}`.toLowerCase() : r.data.label.toLowerCase() }));
      } catch {
        searchCache = [];
      }
    }, 150);
  }
  refreshSearchCache();

  Atlas.searchProviders.push((q, tokens) =>
    searchCache
      .filter((x) => tokens.every((t) => x.hay.includes(t)))
      .map(({ r }) => {
        const t = Atlas.topic(r.topic);
        const s = Atlas.section(t.section);
        if (r.kind === 'card') {
          return { href: Atlas.topicHref(t), mark: r.id, title: t.title, kicker: `Your scribble · ${s.title}`, accent: s.accent, snippet: esc(r.data.label) };
        }
        return {
          href: Atlas.topicHref(t),
          mark: r.id,
          title: t.title,
          kicker: `${r.data.n ? 'Your note' : 'Your highlight'} · ${s.title}`,
          accent: s.accent,
          snippet: `<span class="hl-inline hl-${esc(r.data.c)}">${esc(r.data.a.q.slice(0, 180))}</span>${r.data.n ? ` — ${esc(r.data.n.slice(0, 140))}` : ''}`,
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

  window.AtlasInk = {
    // for diagnostics and tests
    state: () => ({ gesture: gesture ? gesture.type : null, hl: tool.hl, eraser, insertMode, pendingPlace, topic: T ? T.slug : null }),
    setHighlighter,
    setInsertMode,
  };

  recoverDraft();
  Store.compact(KEEP_DELETED_DAYS).catch(() => {});
  syncDock();
})();
