import fs from 'node:fs';
import path from 'node:path';
import { render, parseFrontmatter, type Heading } from './markdown';

const CONTENT_DIR = path.join(process.cwd(), 'content');

/** Top-level grouping shown as a header in the sidebar and curriculum index. */
export type Group = 'Core Systems' | 'AI Systems' | 'Applied Design' | 'Appendix';

export const GROUPS: { name: Group; blurb: string }[] = [
  {
    name: 'Core Systems',
    blurb:
      'The physics, the components, and the failure modes. Everything else is downstream of this.',
  },
  {
    name: 'AI Systems',
    blurb:
      'How models actually run: the arithmetic, the hardware, the training and serving stacks, and the products built on top.',
  },
  {
    name: 'Applied Design',
    blurb: 'Whole systems, end to end — read as finished designs, or built up phase by phase.',
  },
  {
    name: 'Appendix',
    blurb: 'Optional. Only useful if you also have to pass an interview.',
  },
];

export type Section = {
  dir: string;
  slug: string;
  title: string;
  desc: string;
  group: Group;
  /** Tailwind-friendly accent used for gradients and glows. */
  accent: string;
  icon: string;
};

export const SECTIONS: Section[] = [
  {
    dir: '00-orientation',
    slug: 'orientation',
    title: 'Orientation',
    desc: 'What this covers, how the tracks depend on each other, and how to study systems so the knowledge sticks.',
    group: 'Core Systems',
    accent: '#38bdf8',
    icon: 'compass',
  },
  {
    dir: '01-foundations',
    slug: 'fundamentals',
    title: 'Foundations',
    desc: 'The physics: latency, queueing, hardware limits, consistency, and the arithmetic of failure. Every later decision is downstream of these.',
    group: 'Core Systems',
    accent: '#22d3ee',
    icon: 'atom',
  },
  {
    dir: '02-building-blocks',
    slug: 'building-blocks',
    title: 'Building Blocks',
    desc: 'The components you assemble in every design: load balancers, caches, queues, shards, indexes.',
    group: 'Core Systems',
    accent: '#4ade80',
    icon: 'blocks',
  },
  {
    dir: '03-distributed',
    slug: 'distributed',
    title: 'Distributed Systems',
    desc: 'Consensus, replication, time, and failure — plus how you convince yourself any of it is correct.',
    group: 'Core Systems',
    accent: '#a78bfa',
    icon: 'network',
  },
  {
    dir: '04-data',
    slug: 'data',
    title: 'Data & Storage',
    desc: 'What actually happens beneath the query. Storage engines, durability, execution, streams, and analytics.',
    group: 'Core Systems',
    accent: '#fbbf24',
    icon: 'database',
  },
  {
    dir: '05-ai-foundations',
    slug: 'ai-foundations',
    title: 'AI Foundations',
    desc: 'Models as systems. Tokens, attention, the KV cache, and the arithmetic that decides what inference costs.',
    group: 'AI Systems',
    accent: '#60a5fa',
    icon: 'chip',
  },
  {
    dir: '06-ai-infrastructure',
    slug: 'ai-infra',
    title: 'AI Infrastructure',
    desc: 'The machines underneath: GPUs, interconnects, distributed training, inference engines, and GPU-cluster economics.',
    group: 'AI Systems',
    accent: '#c084fc',
    icon: 'server',
  },
  {
    dir: '07-ai-systems',
    slug: 'ai-systems',
    title: 'Applied AI Systems',
    desc: 'Retrieval, agents, evaluation, guardrails, and ranking — the layer between a model and a product.',
    group: 'AI Systems',
    accent: '#f0abfc',
    icon: 'brain',
  },
  {
    dir: '08-case-studies',
    slug: 'case-studies',
    title: 'Case Studies',
    desc: 'Finished designs, end to end: requirements, estimation, API, data model, deep dives, failure modes.',
    group: 'Applied Design',
    accent: '#fb7185',
    icon: 'blueprint',
  },
  {
    dir: '09-builds',
    slug: 'builds',
    title: 'Guided Builds',
    desc: 'The same systems constructed phase by phase, each transition triggered by a concrete number that broke the previous version.',
    group: 'Applied Design',
    accent: '#34d399',
    icon: 'rocket',
  },
  {
    dir: '10-appendix',
    slug: 'appendix',
    title: 'Appendix: Interviews',
    desc: 'Optional. How the material maps onto a 45-minute interview, if that is something you also need.',
    group: 'Appendix',
    accent: '#94a3b8',
    icon: 'book',
  },
];

/** Sections bucketed by group, preserving SECTIONS order. Empty groups are dropped. */
export function getGroupedSections() {
  return GROUPS.map((g) => ({
    ...g,
    sections: SECTIONS.filter((s) => s.group === g.name),
  })).filter((g) => g.sections.length > 0);
}

export type Topic = {
  slug: string;
  title: string;
  summary: string;
  difficulty: string;
  tags: string[];
  minutes: number;
  section: Section;
  order: number;
  /** Slugs the reader should have studied first. Advisory, never a lock. */
  prereqs: string[];
  /** 1–5 difficulty ladder, used to group Guided Builds. */
  level: number;
  /** One-line "what you'll be able to do after this". */
  unlocks: string;
};

export type TopicWithBody = Topic & { html: string; headings: Heading[] };

function readTopicFile(section: Section, file: string) {
  const raw = fs.readFileSync(path.join(CONTENT_DIR, section.dir, file), 'utf8');
  const { data, body } = parseFrontmatter(raw);
  const slug = file.replace(/^\d+-/, '').replace(/\.md$/, '');
  const words = body.split(/\s+/).length;
  const order = Number(file.slice(0, 2)) || 0;

  const asList = (v: unknown) =>
    Array.isArray(v) ? v.map(String) : v ? [String(v)] : [];

  return {
    meta: {
      slug,
      title: String(data.title ?? slug),
      summary: String(data.summary ?? ''),
      difficulty: String(data.difficulty ?? ''),
      tags: asList(data.tags),
      minutes: Math.max(3, Math.round(words / 220)),
      section,
      order,
      prereqs: asList(data.prereqs),
      level: Number(data.level) || 0,
      unlocks: String(data.unlocks ?? ''),
    } satisfies Topic,
    body,
  };
}

let _cache: Topic[] | null = null;

export function getAllTopics(): Topic[] {
  if (_cache) return _cache;
  const out: Topic[] = [];
  for (const section of SECTIONS) {
    const dir = path.join(CONTENT_DIR, section.dir);
    if (!fs.existsSync(dir)) continue;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.md')).sort()) {
      out.push(readTopicFile(section, file).meta);
    }
  }
  _cache = out;
  return out;
}

export function getSectionTopics(sectionSlug: string): Topic[] {
  return getAllTopics().filter((t) => t.section.slug === sectionSlug);
}

export function getSection(slug: string): Section | undefined {
  return SECTIONS.find((s) => s.slug === slug);
}

export async function getTopic(
  sectionSlug: string,
  topicSlug: string
): Promise<TopicWithBody | null> {
  const section = getSection(sectionSlug);
  if (!section) return null;

  const dir = path.join(CONTENT_DIR, section.dir);
  if (!fs.existsSync(dir)) return null;

  const file = fs
    .readdirSync(dir)
    .find((f) => f.endsWith('.md') && f.replace(/^\d+-/, '').replace(/\.md$/, '') === topicSlug);
  if (!file) return null;

  const { meta, body } = readTopicFile(section, file);
  // Pass the section so cross-references rewrite to real Next routes.
  const { html, headings } = await render(body, section.slug);
  return { ...meta, html, headings };
}

/** Resolve a topic's prereq slugs into real topics, dropping any that don't exist. */
export function resolvePrereqs(slugs: string[]) {
  const all = getAllTopics();
  return slugs
    .map((s) => all.find((t) => t.slug === s))
    .filter((t): t is Topic => Boolean(t))
    .map((t) => ({
      slug: t.slug,
      title: t.title,
      href: topicHref(t),
      section: t.section.title,
      accent: t.section.accent,
    }));
}

/** Build-time check that every declared prereq points at a real topic. */
export function danglingPrereqs(): { topic: string; missing: string }[] {
  const all = getAllTopics();
  const known = new Set(all.map((t) => t.slug));
  const out: { topic: string; missing: string }[] = [];
  for (const t of all) {
    for (const p of t.prereqs) {
      if (!known.has(p)) out.push({ topic: t.slug, missing: p });
    }
  }
  return out;
}

/** Flat ordered list used for prev/next navigation. */
export function getNeighbors(sectionSlug: string, topicSlug: string) {
  const all = getAllTopics();
  const i = all.findIndex((t) => t.section.slug === sectionSlug && t.slug === topicSlug);
  return { prev: i > 0 ? all[i - 1] : null, next: i >= 0 && i < all.length - 1 ? all[i + 1] : null };
}

export function topicHref(t: Topic) {
  return `/learn/${t.section.slug}/${t.slug}`;
}

/** Lightweight index shipped to the client for instant search. */
export function getSearchIndex() {
  return getAllTopics().map((t) => ({
    t: t.title,
    s: t.summary,
    u: topicHref(t),
    sec: t.section.title,
    acc: t.section.accent,
    d: t.difficulty,
    g: t.tags.join(' '),
  }));
}

export function getStats() {
  const all = getAllTopics();
  const words = all.reduce((n, t) => n + t.minutes * 220, 0);
  const aiSlugs = new Set(
    SECTIONS.filter((s) => s.group === 'AI Systems').map((s) => s.slug)
  );
  return {
    topics: all.length,
    caseStudies: all.filter((t) => t.section.slug === 'case-studies').length,
    aiTopics: all.filter((t) => aiSlugs.has(t.section.slug)).length,
    builds: all.filter((t) => t.section.slug === 'builds').length,
    sections: SECTIONS.length,
    groups: GROUPS.length,
    minutes: all.reduce((n, t) => n + t.minutes, 0),
    words,
  };
}
