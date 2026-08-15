import { notFound } from 'next/navigation';
import { SECTIONS, getSection, getSectionTopics } from '@/lib/content';
import TopicGrid from '@/components/TopicGrid';
import Reveal from '@/components/Reveal';
import { SectionIcon } from '@/components/Icons';

export function generateStaticParams() {
  return SECTIONS.map((s) => ({ section: s.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const s = getSection(section);
  return s ? { title: `${s.title} — SysDesign Atlas`, description: s.desc } : {};
}

export default async function SectionPage({ params }: { params: Promise<{ section: string }> }) {
  const { section } = await params;
  const s = getSection(section);
  if (!s) notFound();

  const topics = getSectionTopics(section);

  return (
    <main className="px-5 py-10 pb-24 xl:px-10">
      <Reveal>
        <div className="mb-3 flex items-center gap-3">
          <span
            className="grid h-11 w-11 place-items-center rounded-xl"
            style={{
              background: `color-mix(in srgb, ${s.accent} 13%, transparent)`,
              color: s.accent,
            }}
          >
            <SectionIcon name={s.icon} size={22} />
          </span>
          <h1
            className="text-[clamp(1.8rem,3.4vw,2.4rem)] font-extrabold tracking-[-0.03em]"
            style={{ color: 'var(--text)' }}
          >
            {s.title}
          </h1>
        </div>
        <p className="mb-9 max-w-[70ch] text-[16.5px]" style={{ color: 'var(--text-soft)' }}>
          {s.desc}
        </p>
      </Reveal>

      <TopicGrid
        topics={topics.map((t) => ({
          slug: t.slug,
          title: t.title,
          summary: t.summary,
          difficulty: t.difficulty,
          scope: t.scope,
          minutes: t.minutes,
          href: `/learn/${t.section.slug}/${t.slug}`,
          accent: s.accent,
        }))}
      />
    </main>
  );
}
