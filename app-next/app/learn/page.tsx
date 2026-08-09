import { SECTIONS, getAllTopics, getGroupedSections } from '@/lib/content';
import TopicGrid from '@/components/TopicGrid';
import Reveal from '@/components/Reveal';
import { SectionIcon } from '@/components/Icons';

export const metadata = { title: 'Learn — SysDesign Atlas' };

export default function LearnIndex() {
  const topics = getAllTopics();
  const groups = getGroupedSections();

  return (
    <main className="px-5 py-10 pb-24 xl:px-10">
      <Reveal>
        <h1
          className="text-[clamp(1.9rem,3.6vw,2.5rem)] font-extrabold tracking-[-0.03em]"
          style={{ color: 'var(--text)' }}
        >
          The curriculum
        </h1>
        <p className="mt-3 max-w-[68ch] text-[16.5px]" style={{ color: 'var(--text-soft)' }}>
          {topics.length} topics in four groups, ordered so that nothing depends on something you
          have not read yet. Foundations first — every later decision is downstream of them. Each
          topic lists what it assumes; mark topics complete and rate your confidence as you go.
        </p>
      </Reveal>

      {groups.map((g) => (
        <div key={g.name}>
          <Reveal>
            <div className="mt-16 border-t pt-6" style={{ borderColor: 'var(--border)' }}>
              <h2
                className="text-[11px] font-bold uppercase tracking-[0.16em]"
                style={{ color: 'var(--text-dim)' }}
              >
                {g.name}
              </h2>
              <p className="mt-1.5 max-w-[70ch] text-[15px]" style={{ color: 'var(--text-soft)' }}>
                {g.blurb}
              </p>
            </div>
          </Reveal>

          {g.sections.map((s) => {
            const items = topics.filter((t) => t.section.slug === s.slug);
            if (!items.length) return null;
            const si = SECTIONS.indexOf(s);
            return (
              <section key={s.slug} id={s.slug} className="mt-12">
                <Reveal>
                  <div className="mb-1.5 flex items-center gap-3">
                    <span
                      className="grid h-9 w-9 place-items-center rounded-xl"
                      style={{
                        background: `color-mix(in srgb, ${s.accent} 13%, transparent)`,
                        color: s.accent,
                      }}
                    >
                      <SectionIcon name={s.icon} size={18} />
                    </span>
                    <span className="font-mono text-[13px] font-bold" style={{ color: s.accent }}>
                      {String(si).padStart(2, '0')}
                    </span>
                    <h3
                      className="text-[22px] font-bold tracking-tight"
                      style={{ color: 'var(--text)' }}
                    >
                      {s.title}
                    </h3>
                  </div>
                  <p
                    className="mb-6 max-w-[70ch] text-[14.5px]"
                    style={{ color: 'var(--text-soft)' }}
                  >
                    {s.desc}
                  </p>
                </Reveal>
                <TopicGrid
                  topics={items.map((t) => ({
                    slug: t.slug,
                    title: t.title,
                    summary: t.summary,
                    difficulty: t.difficulty,
                    minutes: t.minutes,
                    href: `/learn/${t.section.slug}/${t.slug}`,
                    accent: s.accent,
                  }))}
                />
              </section>
            );
          })}
        </div>
      ))}
    </main>
  );
}
