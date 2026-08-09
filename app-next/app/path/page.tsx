import { getSectionTopics, resolvePrereqs, topicHref } from '@/lib/content';
import PathView from '@/components/PathView';

export const metadata = { title: 'Learning Path — SysDesign Atlas' };

const LEVEL_META: Record<number, { name: string; blurb: string; accent: string }> = {
  1: {
    name: 'Foundations',
    blurb: 'One service, one database, one cache. The shape every design starts from.',
    accent: '#38bdf8',
  },
  2: {
    name: 'Scale',
    blurb: 'Fanout, read/write asymmetry, and the celebrity problem.',
    accent: '#22d3ee',
  },
  3: {
    name: 'Real-time & Media',
    blurb: 'Stateful connections, delivery guarantees, and bandwidth as the constraint.',
    accent: '#4ade80',
  },
  4: {
    name: 'Hard Constraints',
    blurb: 'Geospatial matching, concurrent mutation, and money.',
    accent: '#fbbf24',
  },
  5: {
    name: 'AI Platforms',
    blurb:
      'GPU memory as the scarce resource. Token streaming, retrieval, agents, evaluation — the same techniques from levels 1–4 with different constants.',
    accent: '#a78bfa',
  },
  6: {
    name: 'Frontier Scale',
    blurb:
      'One computation, thousands of GPUs, sixty days, no partial credit. Where the hardware itself becomes the design constraint.',
    accent: '#f472b6',
  },
};

export default function PathPage() {
  const builds = getSectionTopics('builds')
    .filter((t) => t.slug !== 'how-guided-builds-work')
    .map((t) => ({
      slug: t.slug,
      title: t.title,
      summary: t.summary,
      href: topicHref(t),
      minutes: t.minutes,
      level: t.level || 1,
      unlocks: t.unlocks,
      prereqs: resolvePrereqs(t.prereqs),
    }));

  const levels = [1, 2, 3, 4, 5, 6].map((n) => ({
    n,
    ...LEVEL_META[n],
    builds: builds.filter((b) => b.level === n),
  }));

  return <PathView levels={levels} total={builds.length} />;
}
