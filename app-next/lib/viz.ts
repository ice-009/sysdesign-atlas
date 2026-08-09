/* Server-rendered SVG diagrams.

   Authored as a ```viz fence containing JSON. Rendering happens at build time
   and animation is pure CSS, so there's no client JS and no hydration cost.

   Types: flow · stack · axes · ring · fanout · compare */

type Node = { id: string; label: string; sub?: string; col?: number; accent?: string };
type Edge = { from: string; to: string; label?: string; dashed?: boolean };

export type VizSpec =
  | { type: 'flow'; nodes: Node[]; edges: Edge[]; caption?: string }
  | { type: 'stack'; layers: { label: string; sub?: string; accent?: string }[]; caption?: string }
  | { type: 'axes'; caption?: string; x: string; y: string; z: string; xs?: string; ys?: string; zs?: string }
  | { type: 'ring'; nodes: string[]; keys?: string[]; caption?: string }
  | { type: 'fanout'; source: string; targets: string[]; caption?: string; note?: string }
  | { type: 'compare'; left: { title: string; items: string[] }; right: { title: string; items: string[] }; caption?: string }
  | { type: 'steps'; steps: { label: string; sub?: string; accent?: string }[]; caption?: string; note?: string };

const PALETTE = ['#38bdf8', '#a78bfa', '#4ade80', '#fbbf24', '#fb7185', '#22d3ee'];

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

function shell(inner: string, w: number, h: number, caption?: string) {
  return `<figure class="viz">
  <svg viewBox="0 0 ${w} ${h}" role="img" preserveAspectRatio="xMidYMid meet">
    <defs>
      <linearGradient id="vg" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity=".18"/>
        <stop offset="100%" stop-color="#a78bfa" stop-opacity=".08"/>
      </linearGradient>
      <linearGradient id="ve" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#38bdf8" stop-opacity=".25"/>
        <stop offset="100%" stop-color="#a78bfa" stop-opacity=".55"/>
      </linearGradient>
      <marker id="vh" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
        <path d="M0 0 L10 5 L0 10 z" fill="currentColor" opacity=".55"/>
      </marker>
    </defs>
${inner}
  </svg>
${caption ? `  <figcaption>${esc(caption)}</figcaption>` : ''}
</figure>`;
}

/* ---------- flow ---------- */

function flow(s: Extract<VizSpec, { type: 'flow' }>) {
  // Auto-column: explicit col wins, otherwise order of appearance.
  const cols = new Map<number, Node[]>();
  s.nodes.forEach((n, i) => {
    const c = n.col ?? i;
    if (!cols.has(c)) cols.set(c, []);
    cols.get(c)!.push(n);
  });

  const colKeys = [...cols.keys()].sort((a, b) => a - b);
  const NW = 116;
  const NH = 46;
  const GAPX = 62;
  const GAPY = 18;
  const PAD = 16;

  const maxRows = Math.max(...colKeys.map((k) => cols.get(k)!.length));
  const w = PAD * 2 + colKeys.length * NW + (colKeys.length - 1) * GAPX;
  const h = PAD * 2 + maxRows * NH + (maxRows - 1) * GAPY + 6;

  const pos = new Map<string, { x: number; y: number }>();
  colKeys.forEach((k, ci) => {
    const list = cols.get(k)!;
    const colH = list.length * NH + (list.length - 1) * GAPY;
    list.forEach((n, ri) => {
      pos.set(n.id, {
        x: PAD + ci * (NW + GAPX),
        y: (h - colH) / 2 + ri * (NH + GAPY),
      });
    });
  });

  const edges = s.edges
    .map((e, i) => {
      const a = pos.get(e.from);
      const b = pos.get(e.to);
      if (!a || !b) return '';
      const x1 = a.x + NW;
      const y1 = a.y + NH / 2;
      const x2 = b.x;
      const y2 = b.y + NH / 2;
      const mx = (x1 + x2) / 2;
      const d = `M${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`;
      return `    <path class="viz-edge${e.dashed ? ' is-dashed' : ''}" d="${d}" marker-end="url(#vh)"/>
    <circle class="viz-dot" r="2.8" style="--d:${(i * 0.4).toFixed(2)}s"><animateMotion dur="2.6s" repeatCount="indefinite" begin="${(i * 0.4).toFixed(2)}s" path="${d}"/></circle>
${e.label ? `    <text class="viz-edge-label" x="${mx}" y="${(y1 + y2) / 2 - 7}" text-anchor="middle">${esc(e.label)}</text>` : ''}`;
    })
    .join('\n');

  const nodes = s.nodes
    .map((n, i) => {
      const p = pos.get(n.id)!;
      const accent = n.accent ?? PALETTE[i % PALETTE.length];
      return `    <g class="viz-node" style="--a:${accent};--d:${(i * 0.07).toFixed(2)}s">
      <rect x="${p.x}" y="${p.y}" width="${NW}" height="${NH}" rx="10"/>
      <text x="${p.x + NW / 2}" y="${p.y + (n.sub ? 20 : 27)}" text-anchor="middle" class="viz-label">${esc(n.label)}</text>
${n.sub ? `      <text x="${p.x + NW / 2}" y="${p.y + 34}" text-anchor="middle" class="viz-sub">${esc(n.sub)}</text>` : ''}
    </g>`;
    })
    .join('\n');

  return shell(`${edges}\n${nodes}`, w, h, s.caption);
}

/* ---------- stack ---------- */

function stack(s: Extract<VizSpec, { type: 'stack' }>) {
  const W = 420;
  const LH = 52;
  const GAP = 10;
  const PAD = 14;
  const h = PAD * 2 + s.layers.length * LH + (s.layers.length - 1) * GAP;

  const rows = s.layers
    .map((l, i) => {
      const y = PAD + i * (LH + GAP);
      const accent = l.accent ?? PALETTE[i % PALETTE.length];
      return `    <g class="viz-node" style="--a:${accent};--d:${(i * 0.08).toFixed(2)}s">
      <rect x="${PAD}" y="${y}" width="${W - PAD * 2}" height="${LH}" rx="10"/>
      <rect x="${PAD}" y="${y}" width="4" height="${LH}" rx="2" fill="${accent}" opacity=".85"/>
      <text x="${PAD + 18}" y="${y + (l.sub ? 22 : 30)}" class="viz-label" text-anchor="start">${esc(l.label)}</text>
${l.sub ? `      <text x="${PAD + 18}" y="${y + 37}" class="viz-sub" text-anchor="start">${esc(l.sub)}</text>` : ''}
    </g>`;
    })
    .join('\n');

  return shell(rows, W, h, s.caption);
}

/* ---------- axes (the scale cube) ---------- */

function axes(s: Extract<VizSpec, { type: 'axes' }>) {
  const w = 460;
  const h = 300;
  const ox = 96;
  const oy = 218; // origin

  const arm = (dx: number, dy: number, color: string, label: string, sub: string, i: number, anchor: string, lx: number, ly: number) => `
    <g class="viz-axis" style="--a:${color};--d:${(i * 0.15).toFixed(2)}s">
      <line x1="${ox}" y1="${oy}" x2="${ox + dx}" y2="${oy + dy}" marker-end="url(#vh)"/>
      <text x="${ox + dx + lx}" y="${oy + dy + ly}" text-anchor="${anchor}" class="viz-label">${esc(label)}</text>
      <text x="${ox + dx + lx}" y="${oy + dy + ly + 15}" text-anchor="${anchor}" class="viz-sub">${esc(sub)}</text>
    </g>`;

  return shell(
    `    <circle class="viz-origin" cx="${ox}" cy="${oy}" r="5"/>
${arm(250, 0, '#38bdf8', s.x, s.xs ?? '', 0, 'start', 12, 4)}
${arm(0, -170, '#a78bfa', s.y, s.ys ?? '', 1, 'middle', 0, -14)}
${arm(-62, 58, '#4ade80', s.z, s.zs ?? '', 2, 'middle', 0, 22)}`,
    w,
    h,
    s.caption
  );
}

/* ---------- ring (consistent hashing) ---------- */

function ring(s: Extract<VizSpec, { type: 'ring' }>) {
  const size = 300;
  const c = size / 2;
  const r = 104;

  const nodes = s.nodes
    .map((label, i) => {
      const a = (i / s.nodes.length) * Math.PI * 2 - Math.PI / 2;
      const x = c + Math.cos(a) * r;
      const y = c + Math.sin(a) * r;
      const accent = PALETTE[i % PALETTE.length];
      return `    <g class="viz-ringnode" style="--a:${accent};--d:${(i * 0.1).toFixed(2)}s">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="15"/>
      <text x="${x.toFixed(1)}" y="${(y + 4).toFixed(1)}" text-anchor="middle" class="viz-label sm">${esc(label)}</text>
    </g>`;
    })
    .join('\n');

  const keys = (s.keys ?? [])
    .map((k, i) => {
      const a = ((i + 0.5) / (s.keys!.length || 1)) * Math.PI * 2 - Math.PI / 2 + 0.35;
      const x = c + Math.cos(a) * (r + 34);
      const y = c + Math.sin(a) * (r + 34);
      return `    <g class="viz-key" style="--d:${(0.5 + i * 0.12).toFixed(2)}s">
      <circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="4"/>
      <text x="${x.toFixed(1)}" y="${(y - 10).toFixed(1)}" text-anchor="middle" class="viz-sub">${esc(k)}</text>
    </g>`;
    })
    .join('\n');

  return shell(
    `    <circle class="viz-ring" cx="${c}" cy="${c}" r="${r}"/>
${keys}
${nodes}`,
    size,
    size,
    s.caption
  );
}

/* ---------- fanout ---------- */

function fanout(s: Extract<VizSpec, { type: 'fanout' }>) {
  const w = 430;
  const NH = 38;
  const GAP = 12;
  const h = Math.max(150, 32 + s.targets.length * (NH + GAP));
  const sx = 16;
  const sy = h / 2 - 24;
  const tx = 268;

  const targets = s.targets
    .map((t, i) => {
      const y = 20 + i * (NH + GAP);
      const d = `M${sx + 128} ${sy + 24} C ${tx - 46} ${sy + 24}, ${tx - 46} ${y + NH / 2}, ${tx} ${y + NH / 2}`;
      const accent = PALETTE[i % PALETTE.length];
      return `    <path class="viz-edge" d="${d}" marker-end="url(#vh)"/>
    <circle class="viz-dot" r="2.6"><animateMotion dur="2.2s" repeatCount="indefinite" begin="${(i * 0.22).toFixed(2)}s" path="${d}"/></circle>
    <g class="viz-node" style="--a:${accent};--d:${(0.1 + i * 0.07).toFixed(2)}s">
      <rect x="${tx}" y="${y}" width="${w - tx - 16}" height="${NH}" rx="9"/>
      <text x="${tx + (w - tx - 16) / 2}" y="${y + 24}" text-anchor="middle" class="viz-label sm">${esc(t)}</text>
    </g>`;
    })
    .join('\n');

  return shell(
    `    <g class="viz-node" style="--a:#38bdf8">
      <rect x="${sx}" y="${sy}" width="128" height="48" rx="10"/>
      <text x="${sx + 64}" y="${sy + 29}" text-anchor="middle" class="viz-label">${esc(s.source)}</text>
    </g>
${targets}
${s.note ? `    <text x="${w / 2}" y="${h - 4}" text-anchor="middle" class="viz-sub">${esc(s.note)}</text>` : ''}`,
    w,
    h,
    s.caption
  );
}

/* ---------- compare ---------- */

function compare(s: Extract<VizSpec, { type: 'compare' }>) {
  const w = 460;
  const colW = 210;
  const rows = Math.max(s.left.items.length, s.right.items.length);
  const h = 58 + rows * 24 + 14;

  const col = (side: { title: string; items: string[] }, x: number, accent: string, i: number) => `
    <g class="viz-node" style="--a:${accent};--d:${(i * 0.1).toFixed(2)}s">
      <rect x="${x}" y="14" width="${colW}" height="${h - 28}" rx="12"/>
      <text x="${x + colW / 2}" y="40" text-anchor="middle" class="viz-label">${esc(side.title)}</text>
    </g>
${side.items
  .map(
    (it, j) =>
      `    <text x="${x + 16}" y="${64 + j * 24}" class="viz-sub" text-anchor="start">• ${esc(it)}</text>`
  )
  .join('\n')}`;

  return shell(
    `${col(s.left, 12, '#38bdf8', 0)}
${col(s.right, w - colW - 12, '#fb7185', 1)}`,
    w,
    h,
    s.caption
  );
}

/* ---------- steps ----------
   Rendered as HTML rather than SVG on purpose: a numbered sequence is a list,
   so real text wrapping, selectable text and screen-reader semantics matter
   more than drawing precision. */
function steps(s: Extract<VizSpec, { type: 'steps' }>) {
  const items = s.steps
    .map((st, i) => {
      const accent = st.accent ?? PALETTE[i % PALETTE.length];
      return `    <li style="--a:${accent};--d:${(i * 0.09).toFixed(2)}s">
      <span class="vs-n">${i + 1}</span>
      <span class="vs-body">
        <span class="vs-label">${esc(st.label)}</span>
${st.sub ? `        <span class="vs-sub">${esc(st.sub)}</span>` : ''}
      </span>
    </li>`;
    })
    .join('\n');

  return `<figure class="viz viz-steps">
  <ol class="vs-list">
${items}
  </ol>
${s.note ? `  <p class="vs-note">${esc(s.note)}</p>` : ''}
${s.caption ? `  <figcaption>${esc(s.caption)}</figcaption>` : ''}
</figure>`;
}

export function renderViz(json: string): string | null {
  let spec: VizSpec;
  try {
    spec = JSON.parse(json);
  } catch {
    return null;
  }
  try {
    switch (spec.type) {
      case 'flow':
        return flow(spec);
      case 'stack':
        return stack(spec);
      case 'axes':
        return axes(spec);
      case 'ring':
        return ring(spec);
      case 'fanout':
        return fanout(spec);
      case 'compare':
        return compare(spec);
      case 'steps':
        return steps(spec);
      default:
        return null;
    }
  } catch {
    return null;
  }
}
