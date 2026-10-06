import Link from 'next/link';
import { SECTIONS, getAllTopics, getStats, topicHref } from '@/lib/content';
import { auth } from '@/lib/auth';
import HeroVisual from '@/components/HeroVisual';
import Reveal from '@/components/Reveal';
import { SectionIcon, IconArrow, IconCheck, IconSpark } from '@/components/Icons';

export default async function Home() {
  const stats = getStats();
  const topics = getAllTopics();
  const session = await auth();

  const features = [
    ['A real prerequisite graph', 'Every topic declares what it assumes. Nothing arrives before the idea it depends on.'],
    ['Derivations, not assertions', 'Where a number is claimed, the arithmetic behind it is shown so you can check it.'],
    ['A full AI systems track', `${stats.aiTopics} topics: transformer mechanics, GPUs and interconnects, distributed training, inference serving, retrieval, agents, evaluation.`],
    ['Built up, not just presented', 'Guided builds construct each system in phases, with the concrete number that broke the previous one.'],
    ['Primary sources throughout', 'Papers cited on the page, so you can go read Dynamo, Raft, PagedAttention, and ZeRO yourself.'],
    ['Everything unlocked', 'No tiers, no paywall, no upsell. Every topic, free, forever.'],
  ];

  return (
    <main>
      {/* ---------- hero ---------- */}
      <section className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 pt-16 pb-20 lg:pt-24">
        <div className="grid items-center gap-12 lg:grid-cols-[1.05fr_1fr]">
          <div>
            <Reveal>
              <span
                className="mb-6 inline-flex items-center gap-2 rounded-full border px-3.5 py-1.5 text-[12.5px] font-semibold"
                style={{
                  borderColor: 'color-mix(in srgb, var(--accent) 30%, transparent)',
                  background: 'color-mix(in srgb, var(--accent) 8%, transparent)',
                  color: 'var(--accent-text)',
                }}
              >
                <span className="pulse-dot h-1.5 w-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
                Core systems + AI infrastructure · everything unlocked
              </span>
            </Reveal>

            <Reveal delay={0.05}>
              <h1
                className="text-[clamp(2.4rem,5.5vw,4rem)] font-extrabold leading-[1.05] tracking-[-0.035em]"
                style={{ color: 'var(--text)' }}
              >
                Learn how systems{' '}
                <span
                  style={{
                    background: 'linear-gradient(120deg,#38bdf8,#a78bfa 60%,#f472b6)',
                    WebkitBackgroundClip: 'text',
                    backgroundClip: 'text',
                    color: 'transparent',
                  }}
                >
                  actually work
                </span>
                , from the hardware up.
              </h1>
            </Reveal>

            <Reveal delay={0.1}>
              <p className="mt-6 max-w-[58ch] text-[18px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                {stats.topics} topics in prerequisite order — from cache lines and queueing theory
                through consensus and storage engines to GPUs, distributed training, and inference
                serving. {stats.aiTopics} of them cover AI infrastructure properly, not as a footnote.
              </p>
            </Reveal>

            <Reveal delay={0.15}>
              <div className="mt-9 flex flex-wrap gap-3">
                <Link
                  href={session ? '/learn' : '/signup'}
                  className="group inline-flex items-center gap-2 rounded-xl px-6 py-3.5 text-[15px] font-bold text-[#071018] transition-transform hover:scale-[1.03]"
                  style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
                >
                  {session ? 'Continue learning' : 'Start learning free'}
                  <IconArrow size={17} className="transition-transform group-hover:translate-x-0.5" />
                </Link>
                <Link
                  href="/learn/fundamentals/hardware-numbers"
                  className="inline-flex items-center gap-2 rounded-xl border px-6 py-3.5 text-[15px] font-semibold transition-colors"
                  style={{
                    borderColor: 'var(--border-strong)',
                    color: 'var(--text)',
                    background: 'var(--panel)',
                  }}
                >
                  Jump to a case study
                </Link>
              </div>
            </Reveal>

            <Reveal delay={0.2}>
              <div className="mt-12 flex flex-wrap gap-x-10 gap-y-5">
                {[
                  [stats.topics, 'Topics'],
                  [stats.caseStudies, 'Case studies'],
                  [Math.round(stats.words / 1000) + 'k', 'Words'],
                  ['0', 'Paywalls'],
                ].map(([n, l]) => (
                  <div key={String(l)}>
                    <div
                      className="font-mono text-[28px] font-bold leading-none tracking-tight"
                      style={{ color: 'var(--text)' }}
                    >
                      {n}
                    </div>
                    <div
                      className="mt-1.5 text-[11.5px] font-semibold uppercase tracking-wider"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      {l}
                    </div>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          <Reveal delay={0.25} className="flex justify-center lg:justify-end">
            <HeroVisual />
          </Reveal>
        </div>
      </section>

      {/* ---------- features ---------- */}
      <section className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 py-16">
        <Reveal>
          <h2
            className="mb-3 text-[26px] font-bold tracking-tight"
            style={{ color: 'var(--text)' }}
          >
            Built to be studied, not just read
          </h2>
          <p className="mb-10 max-w-[64ch] text-[16px]" style={{ color: 'var(--text-soft)' }}>
            Reading produces recognition. Interviews demand generation. Every feature here exists to
            close that gap.
          </p>
        </Reveal>

        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {features.map(([title, body], i) => (
            <Reveal key={title} delay={i * 0.05}>
              <div
                className="h-full rounded-2xl border p-6"
                style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
              >
                <span
                  className="mb-4 grid h-9 w-9 place-items-center rounded-xl"
                  style={{
                    background: 'color-mix(in srgb, var(--accent) 12%, transparent)',
                    color: 'var(--accent)',
                  }}
                >
                  <IconCheck size={17} />
                </span>
                <h3 className="mb-2 text-[15.5px] font-bold" style={{ color: 'var(--text)' }}>
                  {title}
                </h3>
                <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                  {body}
                </p>
              </div>
            </Reveal>
          ))}
        </div>
      </section>

      {/* ---------- curriculum ---------- */}
      <section className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 py-16">
        <Reveal>
          <h2 className="mb-3 text-[26px] font-bold tracking-tight" style={{ color: 'var(--text)' }}>
            The curriculum
          </h2>
          <p className="mb-10 max-w-[64ch] text-[16px]" style={{ color: 'var(--text-soft)' }}>
            Seven tracks, deliberately ordered. Fundamentals first, because every later decision is
            downstream of them.
          </p>
        </Reveal>

        <div className="grid gap-4 md:grid-cols-2">
          {SECTIONS.map((s, i) => {
            const count = topics.filter((t) => t.section.slug === s.slug).length;
            return (
              <Reveal key={s.slug} delay={i * 0.04}>
                <Link
                  href={`/learn/${s.slug}`}
                  className="card-glow flex h-full flex-col rounded-2xl border p-6"
                  style={
                    {
                      borderColor: 'var(--border)',
                      background: 'var(--panel)',
                      '--card-accent': s.accent,
                    } as React.CSSProperties
                  }
                >
                  <div className="mb-4 flex items-center gap-3">
                    <span
                      className="grid h-10 w-10 place-items-center rounded-xl"
                      style={{
                        background: `color-mix(in srgb, ${s.accent} 13%, transparent)`,
                        color: s.accent,
                      }}
                    >
                      <SectionIcon name={s.icon} size={19} />
                    </span>
                    <div>
                      <div className="text-[16px] font-bold" style={{ color: 'var(--text)' }}>
                        {s.title}
                      </div>
                      <div className="font-mono text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                        {count} topics
                      </div>
                    </div>
                    <IconArrow size={16} className="ml-auto" />
                  </div>
                  <p className="text-[14px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                    {s.desc}
                  </p>
                </Link>
              </Reveal>
            );
          })}
        </div>
      </section>

      {/* ---------- cta ---------- */}
      <section className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 pb-24 pt-8">
        <Reveal>
          <div
            className="relative overflow-hidden rounded-3xl border px-8 py-14 text-center"
            style={{
              borderColor: 'color-mix(in srgb, var(--accent) 24%, transparent)',
              background:
                'radial-gradient(120% 140% at 50% 0%, color-mix(in srgb, var(--accent) 11%, transparent), transparent 62%), var(--panel)',
            }}
          >
            <IconSpark size={26} className="mx-auto mb-5" />
            <h2
              className="mx-auto max-w-[20ch] text-[clamp(1.6rem,3.4vw,2.3rem)] font-extrabold leading-tight tracking-tight"
              style={{ color: 'var(--text)' }}
            >
              Your progress, your notes, your account.
            </h2>
            <p className="mx-auto mt-4 max-w-[52ch] text-[16px]" style={{ color: 'var(--text-soft)' }}>
              Create an account to track completion, rate your confidence, and keep private notes
              against every topic. Free — there is no paid tier.
            </p>
            <Link
              href={session ? '/dashboard' : '/signup'}
              className="mt-8 inline-flex items-center gap-2 rounded-xl px-7 py-3.5 text-[15px] font-bold text-[#071018] transition-transform hover:scale-[1.03]"
              style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
            >
              {session ? 'Open your dashboard' : 'Create free account'}
              <IconArrow size={17} />
            </Link>
          </div>
        </Reveal>
      </section>
    </main>
  );
}
