#!/usr/bin/env node
/* Content integrity check. Runs before `next build` so a broken cross-link or a
   prereq pointing at a topic that does not exist fails the build rather than
   shipping a dead page.

   Checks:
     - frontmatter present, with the fields the UI actually reads
     - every relative cross-link resolves to a real topic (and anchor-only
       links are left alone)
     - every prereq slug exists, and the prereq graph is acyclic
     - :::callout blocks are closed and use a known kind
     - ```viz blocks contain parseable JSON with a known type
     - ```recall blocks: every card has a question and an answer, no repeats
     - the learning layer — a :::predict "guess first" box at the top, a
       ```recall block of 5–8 cards, and a "What to carry forward" section —
       is present in every topic of the sections listed in LEARNING_REQUIRED
*/

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const CONTENT = path.join(ROOT, 'content');

/* Kept in sync by hand with lib/content.ts and lib/markdown.ts — this script
   runs before the TypeScript is compiled, so it cannot import them. */
const DIR_TO_SLUG = {
  '00-orientation': 'orientation',
  '01-foundations': 'fundamentals',
  '02-building-blocks': 'building-blocks',
  '03-distributed': 'distributed',
  '04-data': 'data',
  '05-ai-foundations': 'ai-foundations',
  '06-ai-infrastructure': 'ai-infra',
  '07-ai-systems': 'ai-systems',
  '08-case-studies': 'case-studies',
  '09-builds': 'builds',
  '10-appendix': 'appendix',
  '11-lld': 'lld',
  '12-hld-bridge': 'hld-bridge',
  // Legacy directory names still referenced from older prose.
  '00-start': 'orientation',
  '01-fundamentals': 'fundamentals',
  '05-case-studies': 'case-studies',
  '06-interview': 'appendix',
  '07-guided-builds': 'builds',
  start: 'orientation',
  interview: 'appendix',
  'guided-builds': 'builds',
};

/* rewriteContentLink also accepts a bare section slug in place of a directory
   name (`../building-blocks/caching.html`), so mirror that here. */
for (const slug of Object.values(DIR_TO_SLUG)) DIR_TO_SLUG[slug] ??= slug;

const CALLOUT_KINDS = new Set([
  'note', 'tip', 'warn', 'trap', 'interview', 'math', 'goat', 'derive', 'paper', 'exercise', 'predict',
]);

/* Sections whose every topic must carry the learning layer. Grows as each
   section gets its pass; when every section is listed, the whole atlas is
   held to it. */
const LEARNING_REQUIRED = new Set(['01-foundations', '02-building-blocks', '03-distributed', '04-data']);
const MIN_CARDS = 5;
const MAX_CARDS = 8;

const VIZ_TYPES = new Set(['flow', 'stack', 'axes', 'ring', 'fanout', 'compare', 'steps']);

const REQUIRED_FRONTMATTER = ['title', 'summary', 'difficulty', 'scope', 'tags'];

/* Kept in sync by hand with the Scope type in lib/content.ts. */
const SCOPES = new Set(['HLD', 'LLD', 'Both', 'Core']);

const errors = [];
const warnings = [];

function parseFrontmatter(raw) {
  const text = raw.replace(/^﻿/, '');
  if (!text.startsWith('---')) return { data: {}, body: text, hasFrontmatter: false };
  const end = text.indexOf('\n---', 3);
  if (end === -1) return { data: {}, body: text, hasFrontmatter: false };
  const data = {};
  for (const line of text.slice(3, end).trim().split('\n')) {
    const m = line.match(/^(\w+):\s*(.*)$/);
    if (!m) continue;
    const v = m[2].trim();
    data[m[1]] = /^\[.*\]$/.test(v)
      ? v.slice(1, -1).split(',').map((x) => x.trim().replace(/^["']|["']$/g, '')).filter(Boolean)
      : v.replace(/^["']|["']$/g, '');
  }
  return { data, body: text.slice(end + 4).replace(/^\n/, ''), hasFrontmatter: true };
}

/* ---------- load ---------- */

const topics = [];
for (const dir of fs.readdirSync(CONTENT).filter((d) => /^\d\d-/.test(d)).sort()) {
  const sectionSlug = DIR_TO_SLUG[dir];
  if (!sectionSlug) {
    errors.push(`${dir}/ — directory has no entry in DIR_TO_SLUG (add it here and in lib/markdown.ts)`);
    continue;
  }
  for (const file of fs.readdirSync(path.join(CONTENT, dir)).filter((f) => f.endsWith('.md')).sort()) {
    const rel = `${dir}/${file}`;
    const raw = fs.readFileSync(path.join(CONTENT, dir, file), 'utf8');
    const { data, body, hasFrontmatter } = parseFrontmatter(raw);
    topics.push({
      rel,
      dir,
      sectionSlug,
      slug: file.replace(/^\d+-/, '').replace(/\.md$/, ''),
      data,
      body,
      hasFrontmatter,
    });
  }
}

const bySlug = new Map(topics.map((t) => [t.slug, t]));
const byRoute = new Set(topics.map((t) => `${t.sectionSlug}/${t.slug}`));

if (topics.length !== bySlug.size) {
  const seen = new Set();
  for (const t of topics) {
    if (seen.has(t.slug)) errors.push(`${t.rel} — duplicate topic slug "${t.slug}"; slugs must be globally unique`);
    seen.add(t.slug);
  }
}

/* ---------- per-topic checks ---------- */

for (const t of topics) {
  if (!t.hasFrontmatter) {
    errors.push(`${t.rel} — missing frontmatter block`);
    continue;
  }

  for (const field of REQUIRED_FRONTMATTER) {
    const v = t.data[field];
    if (v === undefined || v === '' || (Array.isArray(v) && v.length === 0)) {
      errors.push(`${t.rel} — frontmatter missing "${field}"`);
    }
  }

  if (t.data.difficulty && !['Easy', 'Medium', 'Hard'].includes(t.data.difficulty)) {
    errors.push(`${t.rel} — difficulty "${t.data.difficulty}" is not Easy | Medium | Hard`);
  }

  if (t.data.scope && !SCOPES.has(t.data.scope)) {
    errors.push(`${t.rel} — scope "${t.data.scope}" is not ${[...SCOPES].join(' | ')}`);
  }

  const prereqs = Array.isArray(t.data.prereqs) ? t.data.prereqs : t.data.prereqs ? [t.data.prereqs] : [];
  for (const p of prereqs) {
    if (!bySlug.has(p)) errors.push(`${t.rel} — prereq "${p}" does not match any topic`);
    if (p === t.slug) errors.push(`${t.rel} — lists itself as a prereq`);
  }
  // Orientation, the appendix, and each section's 00- index page are entry
  // points by design and legitimately assume nothing.
  const isEntryPoint =
    t.dir === '00-orientation' || t.dir === '10-appendix' || /^00-/.test(path.basename(t.rel));
  if (!prereqs.length && !isEntryPoint) {
    warnings.push(`${t.rel} — no prereqs declared`);
  }

  // Cross-links: ../<dir>/<slug>.html and <slug>.html (same section).
  for (const [, href] of t.body.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    if (/^(https?:|#|mailto:|\/)/.test(href)) continue;
    const [pathPart] = href.split('#');
    if (!pathPart) continue;

    const cross = pathPart.match(/^\.\.\/([\w-]+)\/([\w-]+)\.html$/);
    if (cross) {
      const section = DIR_TO_SLUG[cross[1]];
      if (!section) {
        errors.push(`${t.rel} — link "${href}" points at unknown section "${cross[1]}"`);
      } else if (!byRoute.has(`${section}/${cross[2]}`)) {
        errors.push(`${t.rel} — link "${href}" resolves to /learn/${section}/${cross[2]}, which does not exist`);
      }
      continue;
    }

    const same = pathPart.match(/^\.?\/?([\w-]+)\.html$/);
    if (same) {
      if (!byRoute.has(`${t.sectionSlug}/${same[1]}`)) {
        errors.push(`${t.rel} — link "${href}" resolves to /learn/${t.sectionSlug}/${same[1]}, which does not exist`);
      }
      continue;
    }

    errors.push(`${t.rel} — link "${href}" is relative but matches no known form (use ../<dir>/<slug>.html)`);
  }

  // Callout blocks: opened with :::kind, closed with a bare :::
  let open = null;
  let openLine = 0;
  t.body.split('\n').forEach((line, i) => {
    const m = line.match(/^:::(\w*)\s*(.*)$/);
    if (!m) return;
    if (m[1]) {
      if (open) errors.push(`${t.rel}:${openLine} — ":::${open}" never closed before ":::${m[1]}" at line ${i + 1}`);
      if (!CALLOUT_KINDS.has(m[1].toLowerCase())) {
        errors.push(`${t.rel}:${i + 1} — unknown callout kind ":::${m[1]}"`);
      }
      open = m[1];
      openLine = i + 1;
    } else {
      if (!open) errors.push(`${t.rel}:${i + 1} — closing ":::" with no open callout`);
      open = null;
    }
  });
  if (open) errors.push(`${t.rel}:${openLine} — ":::${open}" never closed`);

  // recall fences: Q:/A: cards (same rules as parseRecall in lib/markdown.ts).
  t.cards = 0;
  const seenCards = new Set();
  for (const [, block] of t.body.matchAll(/```recall\n([\s\S]*?)```/g)) {
    let q = null;
    let a = null;
    const finish = () => {
      if (q === null) return;
      t.cards++;
      if (!q.trim()) errors.push(`${t.rel} — a recall card has an empty question`);
      if (!a || !a.trim()) errors.push(`${t.rel} — recall card "${q.slice(0, 50)}" has no answer`);
      const id = q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
      if (seenCards.has(id)) errors.push(`${t.rel} — recall card "${q.slice(0, 50)}" appears twice`);
      seenCards.add(id);
    };
    for (const raw of block.split('\n')) {
      const line = raw.trim();
      const m = line.match(/^([QA]):\s*(.*)$/);
      if (m && m[1] === 'Q') {
        finish();
        q = m[2];
        a = null;
      } else if (m && m[1] === 'A') {
        if (q === null) errors.push(`${t.rel} — recall block has an answer before any question`);
        a = (a ? a + ' ' : '') + m[2];
      } else if (line) {
        if (q === null) errors.push(`${t.rel} — recall block line "${line.slice(0, 40)}" is outside any card`);
        else if (a === null) q += ' ' + line;
        else a += ' ' + line;
      }
    }
    finish();
  }
  t.predict = /^:::predict\b/m.test(t.body);
  t.carry = /^## What to carry forward\s*$/m.test(t.body);
  if (t.predict) {
    const firstHeading = t.body.search(/^## /m);
    const predictAt = t.body.search(/^:::predict\b/m);
    if (firstHeading !== -1 && predictAt > firstHeading) {
      errors.push(`${t.rel} — the :::predict box must come before the first section, so it's read first`);
    }
  }
  if (LEARNING_REQUIRED.has(t.dir)) {
    if (!t.predict) errors.push(`${t.rel} — missing the :::predict "guess first" box`);
    if (t.cards < MIN_CARDS || t.cards > MAX_CARDS) {
      errors.push(`${t.rel} — has ${t.cards} recall cards; want ${MIN_CARDS}–${MAX_CARDS}`);
    }
    if (!t.carry) errors.push(`${t.rel} — missing a "## What to carry forward" section`);
  }

  // viz fences must be valid JSON of a renderable type.
  for (const [, spec] of t.body.matchAll(/```viz\n([\s\S]*?)```/g)) {
    let parsed;
    try {
      parsed = JSON.parse(spec);
    } catch (e) {
      errors.push(`${t.rel} — \`\`\`viz block is not valid JSON: ${e.message}`);
      continue;
    }
    if (!VIZ_TYPES.has(parsed.type)) {
      errors.push(`${t.rel} — \`\`\`viz type "${parsed.type}" is not one of ${[...VIZ_TYPES].join(', ')}`);
    }
  }
}

/* ---------- prereq cycles ---------- */

const WHITE = 0, GREY = 1, BLACK = 2;
const colour = new Map(topics.map((t) => [t.slug, WHITE]));

function visit(slug, trail) {
  if (colour.get(slug) === BLACK) return;
  if (colour.get(slug) === GREY) {
    errors.push(`prereq cycle: ${[...trail.slice(trail.indexOf(slug)), slug].join(' → ')}`);
    return;
  }
  colour.set(slug, GREY);
  const t = bySlug.get(slug);
  const prereqs = Array.isArray(t?.data.prereqs) ? t.data.prereqs : [];
  for (const p of prereqs) if (bySlug.has(p)) visit(p, [...trail, slug]);
  colour.set(slug, BLACK);
}
for (const t of topics) visit(t.slug, []);

/* ---------- report ---------- */

const sections = new Map();
for (const t of topics) sections.set(t.dir, (sections.get(t.dir) ?? 0) + 1);

if (process.env.CHECK_VERBOSE) {
  for (const w of warnings) console.log(`  warn  ${w}`);
}

if (errors.length) {
  console.error(`\n  ✗ ${errors.length} content error${errors.length === 1 ? '' : 's'}\n`);
  for (const e of errors) console.error(`    ${e}`);
  console.error('');
  process.exit(1);
}

const total = topics.length;
const noPrereqs = warnings.length;
const layered = topics.filter((t) => t.predict && t.cards >= MIN_CARDS && t.carry).length;
const cards = topics.reduce((a, t) => a + t.cards, 0);
console.log(
  `  ✓ content ok — ${total} topics across ${sections.size} sections` +
    (noPrereqs ? `, ${noPrereqs} without prereqs (CHECK_VERBOSE=1 to list)` : '')
);
console.log(`    learning layer: ${layered}/${total} topics, ${cards} recall cards`);
