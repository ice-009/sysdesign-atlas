#!/usr/bin/env node
/* Builds the iPad / offline edition: a self-contained static web app that
   installs to the Home Screen and keeps every topic on the device.

     node scripts/ipad/build.mjs              → public/ipad/  (served at /ipad/)
     node scripts/ipad/build.mjs --out dist   → any other folder

   Content is rendered by the same lib/content.ts + lib/markdown.ts the website
   uses, so diagrams, callouts and highlighting are identical. The output uses
   relative URLs only and works from any base path on any static host — it just
   needs HTTPS (or localhost) for the service worker.

   Output:
     index.html                        app shell
     app.<hash>.css / app.<hash>.js    UI
     data.<hash>.js                    curriculum index (sections, topic metadata)
     topics/<sec>/<slug>.<hash>.html   one rendered fragment per topic
     search.<hash>.json                plain text of every topic, for full-text search
     sw.js                             service worker: precaches all of the above
     manifest.webmanifest, icons/      Home Screen install
*/

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(HERE, '..', '..');
const SRC = path.join(ROOT, 'ipad');

const arg = (name, fallback) => {
  const i = process.argv.indexOf(name);
  return i > -1 ? process.argv[i + 1] : fallback;
};
const OUT = path.resolve(ROOT, arg('--out', 'public/ipad'));
// Where the sync API lives, as seen from the app. The Next.js app serves it
// at /api/ipad on the same origin as /ipad.
const API = arg('--api', '/api/ipad');

register(pathToFileURL(path.join(HERE, 'ts-loader.mjs')));
process.chdir(ROOT); // lib/content.ts resolves content/ from the cwd
const content = await import(pathToFileURL(path.join(ROOT, 'lib/content.ts')).href);
const { SCOPE_META } = await import(pathToFileURL(path.join(ROOT, 'lib/scope.ts')).href);

const hash = (s) => crypto.createHash('sha256').update(s).digest('hex').slice(0, 10);

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(OUT, { recursive: true });

function emit(rel, body) {
  const file = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
  return rel;
}

/* Content-hashed names let the service worker treat every asset as immutable,
   so an update only re-downloads the files that actually changed. */
function emitHashed(rel, body) {
  const ext = path.extname(rel);
  return emit(`${rel.slice(0, -ext.length)}.${hash(body)}${ext}`, body);
}

/* ---------- topics ---------- */

const topics = content.getAllTopics();
const known = new Set(topics.map((t) => `${t.section.slug}/${t.slug}`));
const sectionSlugs = new Set(content.SECTIONS.map((s) => s.slug));
const warnings = [];

/* The renderer emits website routes (/learn/<section>/<slug>#anchor). The
   offline app is a single page with hash routes, so every internal link becomes
   #/t/<section>/<slug>/<anchor>. In-page anchors get the current topic. */
function rewriteLinks(html, t) {
  return html.replace(/href="([^"]*)"/g, (whole, href) => {
    if (/^(https?:|mailto:)/.test(href)) return whole;

    if (href.startsWith('#')) return `href="#/t/${t.section.slug}/${t.slug}/${href.slice(1)}"`;

    const m = href.match(/^\/learn(?:\/([\w-]+))?(?:\/([\w-]+))?\/?(?:#(.*))?$/);
    if (m) {
      const [, sec, slug, anchor] = m;
      if (sec && slug) {
        if (!known.has(`${sec}/${slug}`)) warnings.push(`${t.slug}: link to missing topic ${sec}/${slug}`);
        return `href="#/t/${sec}/${slug}${anchor ? `/${anchor}` : ''}"`;
      }
      if (sec) {
        if (!sectionSlugs.has(sec)) warnings.push(`${t.slug}: link to missing section ${sec}`);
        return `href="#/s/${sec}"`;
      }
      return 'href="#/"';
    }

    warnings.push(`${t.slug}: unhandled link ${href}`);
    return whole;
  });
}

const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" };

function toText(html) {
  return html
    .replace(/<a class="anchor"[^>]*>#<\/a>/g, '')
    .replace(/<\/(p|li|h\d|tr|td|th|div|figure|figcaption|aside|pre|blockquote|text)>/g, ' ')
    .replace(/<br\s*\/?>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(amp|lt|gt|quot|#39);/g, (e) => ENT[e])
    // box-drawing and arrow glyphs from ASCII diagrams are noise in a snippet
    .replace(/[─-▟■-◿←-⇿]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

const topicMeta = [];
const searchDocs = [];
let fragmentBytes = 0;

for (const t of topics) {
  const full = await content.getTopic(t.section.slug, t.slug);
  if (!full) throw new Error(`could not render ${t.section.slug}/${t.slug}`);

  const html = rewriteLinks(full.html, t);
  fragmentBytes += html.length;

  topicMeta.push({
    slug: t.slug,
    section: t.section.slug,
    title: t.title,
    summary: t.summary,
    difficulty: t.difficulty,
    scope: t.scope,
    tags: t.tags,
    minutes: t.minutes,
    prereqs: t.prereqs,
    unlocks: t.unlocks,
    level: t.level,
    file: emitHashed(`topics/${t.section.slug}/${t.slug}.html`, html),
  });

  searchDocs.push({
    h: full.headings.filter((h) => h.level >= 2).map((h) => [h.id, h.text]),
    x: toText(html),
  });
}

const searchFile = emitHashed('search.json', JSON.stringify(searchDocs));

/* ---------- curriculum index ---------- */

// Deterministic on purpose — no timestamps. Rebuilding unchanged content must
// produce byte-identical output, or every deploy of the website would make the
// installed app announce an "update" that changes nothing.
const version = hash(topicMeta.map((t) => t.file).join() + searchFile);
const dataBody = `window.ATLAS=${JSON.stringify({
  version,
  groups: content.GROUPS,
  sections: content.SECTIONS.map(({ slug, title, desc, group, accent, icon }) => ({
    slug, title, desc, group, accent, icon,
  })),
  scopes: SCOPE_META,
  topics: topicMeta,
  search: searchFile,
  api: API,
})};\n`;

/* ---------- styles ---------- */

/* The prose styles (callouts, diagrams, viz figures, tables, code) are lifted
   straight out of the website's stylesheet so the two never drift apart. */
const globals = fs.readFileSync(path.join(ROOT, 'app/globals.css'), 'utf8');
const START = '/* ---------- prose ---------- */';
const END = '/* ---------- utility ---------- */';
const from = globals.indexOf(START);
const to = globals.indexOf(END);
if (from < 0 || to < from) {
  throw new Error(`app/globals.css no longer has the "${START}" … "${END}" markers the iPad build slices on`);
}
const proseCss = globals.slice(from, to);
const appCss = fs.readFileSync(path.join(SRC, 'app.css'), 'utf8');
// Variables first, then the shared prose rules, then iPad overrides.
const [vars, overrides] = appCss.split('/* @prose */');
if (overrides === undefined) throw new Error('ipad/app.css is missing its /* @prose */ insertion marker');
const cssFile = emitHashed('app.css', `${vars}\n${proseCss}\n${overrides}`);

const dataFile = emitHashed('data.js', dataBody);
const script = (name) => emitHashed(name, fs.readFileSync(path.join(SRC, name), 'utf8'));
// Load order matters: store → app → track → sync → annotate (see ipad/index.html).
const storeFile = script('store.js');
const jsFile = script('app.js');
const trackFile = script('track.js');
const syncFile = script('sync.js');
const annotateFile = script('annotate.js');

/* ---------- install surface ---------- */

fs.mkdirSync(path.join(OUT, 'icons'), { recursive: true });
const icons = fs.readdirSync(path.join(SRC, 'icons')).filter((f) => f.endsWith('.png'));
for (const f of icons) fs.copyFileSync(path.join(SRC, 'icons', f), path.join(OUT, 'icons', f));

emit(
  'manifest.webmanifest',
  JSON.stringify(
    {
      name: 'SysDesign Atlas',
      short_name: 'Atlas',
      description: 'The full systems curriculum, readable offline.',
      id: './',
      start_url: './index.html',
      scope: './',
      display: 'standalone',
      orientation: 'any',
      background_color: '#07090e',
      theme_color: '#07090e',
      icons: [
        { src: 'icons/icon-180.png', sizes: '180x180', type: 'image/png' },
        { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
        { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
      ],
    },
    null,
    2
  )
);

const index = fs
  .readFileSync(path.join(SRC, 'index.html'), 'utf8')
  .replaceAll('{{CSS}}', cssFile)
  .replaceAll('{{DATA}}', dataFile)
  .replaceAll('{{STORE}}', storeFile)
  .replaceAll('{{JS}}', jsFile)
  .replaceAll('{{TRACK}}', trackFile)
  .replaceAll('{{SYNC}}', syncFile)
  .replaceAll('{{ANNOTATE}}', annotateFile);
if (/\{\{\w+\}\}/.test(index)) throw new Error(`ipad/index.html has an unfilled placeholder: ${index.match(/\{\{\w+\}\}/)[0]}`);
emit('index.html', index);

/* ---------- service worker ---------- */

// Launch images are fetched by iOS once, at install time — no need to cache them.
const shellFiles = [
  'index.html',
  cssFile,
  dataFile,
  storeFile,
  jsFile,
  trackFile,
  syncFile,
  annotateFile,
  'manifest.webmanifest',
  ...icons.filter((f) => f.startsWith('icon-')).map((f) => `icons/${f}`),
];
const contentFiles = [...topicMeta.map((t) => t.file), searchFile];
// Any change to any file changes this, which is what makes the browser
// notice the new service worker.
const build = hash(index + shellFiles.join() + contentFiles.join());

const sw = fs
  .readFileSync(path.join(SRC, 'sw.js'), 'utf8')
  .replace(
    '/* @manifest */',
    `const BUILD = ${JSON.stringify(build)};\n` +
      `const SHELL_FILES = ${JSON.stringify(shellFiles)};\n` +
      `const CONTENT_FILES = ${JSON.stringify(contentFiles, null, 0)};`
  );
if (!sw.includes('const BUILD =')) throw new Error('ipad/sw.js is missing its /* @manifest */ marker');
emit('sw.js', sw);

/* ---------- report ---------- */

const size = (rel) => fs.statSync(path.join(OUT, rel)).size;
const total = [...shellFiles, ...contentFiles].reduce((n, f) => n + size(f), 0);
const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;

for (const w of warnings) console.warn(`  warn  ${w}`);
console.log(
  `iPad edition → ${path.relative(ROOT, OUT) || '.'}\n` +
    `  ${topicMeta.length} topics (${mb(fragmentBytes)} html), search ${mb(size(searchFile))}\n` +
    `  ${shellFiles.length + contentFiles.length} files precached, ${mb(total)} on device · build ${build}`
);
