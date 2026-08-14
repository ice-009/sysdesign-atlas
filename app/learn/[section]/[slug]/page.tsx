import Link from 'next/link';
import { notFound } from 'next/navigation';
import {
  SECTIONS,
  getAllTopics,
  getNeighbors,
  getTopic,
  resolvePrereqs,
  topicHref,
} from '@/lib/content';
import PrereqBanner from '@/components/PrereqBanner';
import TopicToolbar from '@/components/TopicToolbar';
import TopicTimer from '@/components/TopicTimer';
import NotePanel from '@/components/NotePanel';
import TableOfContents from '@/components/TableOfContents';
import ReadingBar from '@/components/ReadingBar';
import ResumeReading from '@/components/ResumeReading';
import { IconArrow } from '@/components/Icons';

export function generateStaticParams() {
  return getAllTopics().map((t) => ({ section: t.section.slug, slug: t.slug }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ section: string; slug: string }>;
}) {
  const { section, slug } = await params;
  const topic = await getTopic(section, slug);
  if (!topic) return {};
  return { title: `${topic.title} — SysDesign Atlas`, description: topic.summary };
}

const DIFF: Record<string, string> = {
  easy: '#4ade80',
  medium: '#fbbf24',
  hard: '#fb7185',
};

export default async function TopicPage({
  params,
}: {
  params: Promise<{ section: string; slug: string }>;
}) {
  const { section, slug } = await params;
  const topic = await getTopic(section, slug);
  if (!topic) notFound();

  const { prev, next } = getNeighbors(section, slug);
  const sec = SECTIONS.find((s) => s.slug === section)!;
  const diffColor = DIFF[topic.difficulty.toLowerCase()] ?? 'var(--text-dim)';

  return (
    <>
      <ReadingBar minutes={topic.minutes} />
      <div className="flex justify-center gap-8 px-5 xl:px-8">
        <article data-reading className="min-w-0 flex-1 py-10 pb-28">
          <nav
            data-noise
            className="mb-5 flex flex-wrap items-center gap-2 text-[12.5px]"
            style={{ color: 'var(--text-dim)' }}
          >
            <Link href="/learn" className="hover:underline">
              Learn
            </Link>
            <span>/</span>
            <Link href={`/learn/${sec.slug}`} className="hover:underline" style={{ color: sec.accent }}>
              {sec.title}
            </Link>
          </nav>

          <h1
            className="text-[clamp(1.9rem,4vw,2.7rem)] font-extrabold leading-[1.12] tracking-[-0.03em]"
            style={{ color: 'var(--text)' }}
          >
            {topic.title}
          </h1>

          {topic.summary && (
            <p className="mt-4 text-[18px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
              {topic.summary}
            </p>
          )}

          <div className="mt-5 flex flex-wrap items-center gap-2">
            {topic.difficulty && (
              <span
                className="rounded-full px-2.5 py-1 text-[11.5px] font-bold"
                style={{
                  background: `color-mix(in srgb, ${diffColor} 14%, transparent)`,
                  color: diffColor,
                }}
              >
                {topic.difficulty}
              </span>
            )}
            <span
              className="rounded-full border px-2.5 py-1 text-[11.5px] font-semibold"
              style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              {topic.minutes} min read
            </span>
            {topic.tags.slice(0, 4).map((t) => (
              <span
                key={t}
                className="rounded-full border px-2.5 py-1 text-[11.5px]"
                style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
              >
                {t}
              </span>
            ))}
          </div>

          <PrereqBanner prereqs={resolvePrereqs(topic.prereqs)} unlocks={topic.unlocks} />

          <TopicToolbar slug={topic.slug} section={section} title={topic.title} />

          <ResumeReading key={`${section}/${topic.slug}`} slug={topic.slug} />

          <div className="prose mt-8" dangerouslySetInnerHTML={{ __html: topic.html }} />

          <NotePanel slug={topic.slug} section={section} />

          <nav data-noise className="mt-14 grid gap-3 sm:grid-cols-2">
            {prev ? (
              <Link
                href={topicHref(prev)}
                className="card-glow rounded-xl border p-4"
                style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
              >
                <div
                  className="mb-1 flex items-center gap-1.5 text-[11px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--text-dim)' }}
                >
                  <IconArrow size={12} className="rotate-180" /> Previous
                </div>
                <div className="text-[14.5px] font-semibold" style={{ color: 'var(--text)' }}>
                  {prev.title}
                </div>
              </Link>
            ) : (
              <span />
            )}
            {next && (
              <Link
                href={topicHref(next)}
                className="card-glow rounded-xl border p-4 text-right sm:col-start-2"
                style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
              >
                <div
                  className="mb-1 flex items-center justify-end gap-1.5 text-[11px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--text-dim)' }}
                >
                  Next <IconArrow size={12} />
                </div>
                <div className="text-[14.5px] font-semibold" style={{ color: 'var(--text)' }}>
                  {next.title}
                </div>
              </Link>
            )}
          </nav>
        </article>

        <TableOfContents headings={topic.headings} />
      </div>

      {/* keyed so moving to the next topic starts a genuinely fresh stopwatch
          rather than inheriting the previous one's refs */}
      <TopicTimer
        key={`${section}/${topic.slug}`}
        slug={topic.slug}
        section={section}
        estimateMin={topic.minutes}
      />
    </>
  );
}
