'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { useProgress } from './ProgressProvider';
import Reveal from './Reveal';
import type { PrereqItem } from './PrereqBanner';
import { IconCheck, IconArrow, IconRocket } from './Icons';

type Build = {
  slug: string;
  title: string;
  summary: string;
  href: string;
  minutes: number;
  level: number;
  unlocks: string;
  prereqs: PrereqItem[];
};

type Level = { n: number; name: string; blurb: string; accent: string; builds: Build[] };

export default function PathView({ levels, total }: { levels: Level[]; total: number }) {
  const { progress, ready } = useProgress();

  const readyCount = levels
    .flatMap((l) => l.builds)
    .filter((b) => b.prereqs.every((p) => progress[p.slug]?.completed)).length;
  const doneCount = levels
    .flatMap((l) => l.builds)
    .filter((b) => progress[b.slug]?.completed).length;

  return (
    <main className="mx-auto max-w-[1100px] px-5 py-12 pb-24">
      <Reveal>
        <div className="flex items-center gap-3">
          <span
            className="grid h-11 w-11 place-items-center rounded-xl"
            style={{ background: 'color-mix(in srgb,#34d399 14%,transparent)', color: '#34d399' }}
          >
            <IconRocket size={22} />
          </span>
          <h1
            className="text-[clamp(1.9rem,3.6vw,2.5rem)] font-extrabold tracking-[-0.03em]"
            style={{ color: 'var(--text)' }}
          >
            The Learning Path
          </h1>
        </div>
        <p className="mt-3 max-w-[68ch] text-[16.5px]" style={{ color: 'var(--text-soft)' }}>
          {total} platforms built step by step, easy to hard. Each one lists what it assumes —
          mark those topics complete and it turns green, meaning the build will actually land
          rather than wash over you.
        </p>

        {ready && (
          <div className="mt-6 flex flex-wrap gap-x-8 gap-y-3">
            {[
              [doneCount, 'builds completed', '#4ade80'],
              [readyCount, 'ready to start', '#38bdf8'],
              [total - readyCount, 'need prep first', '#fbbf24'],
            ].map(([n, label, color]) => (
              <div key={String(label)} className="flex items-baseline gap-2">
                <span
                  className="font-mono text-[22px] font-bold"
                  style={{ color: color as string }}
                >
                  {n as number}
                </span>
                <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
                  {label as string}
                </span>
              </div>
            ))}
          </div>
        )}
      </Reveal>

      <div className="relative mt-12">
        {/* the spine */}
        <div
          className="absolute bottom-0 left-[19px] top-2 w-px md:left-[23px]"
          style={{ background: 'var(--border)' }}
        />

        {levels.map((level, li) => (
          <section key={level.n} className="relative mb-12">
            <Reveal>
              <div className="mb-5 flex items-center gap-4">
                <span
                  className="relative z-10 grid h-10 w-10 shrink-0 place-items-center rounded-full border-2 font-mono text-[15px] font-bold md:h-12 md:w-12"
                  style={{
                    borderColor: level.accent,
                    background: 'var(--bg)',
                    color: level.accent,
                  }}
                >
                  {level.n}
                </span>
                <div className="min-w-0">
                  <h2
                    className="text-[19px] font-bold tracking-tight"
                    style={{ color: 'var(--text)' }}
                  >
                    {level.name}
                  </h2>
                  <p className="text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
                    {level.blurb}
                  </p>
                </div>
              </div>
            </Reveal>

            <div className="ml-[52px] grid gap-3 md:ml-[68px]">
              {level.builds.map((b, i) => {
                const doneCount = b.prereqs.filter((p) => progress[p.slug]?.completed).length;
                const isReady = doneCount === b.prereqs.length;
                const isDone = !!progress[b.slug]?.completed;
                const state = isDone ? 'done' : isReady ? 'ready' : 'locked';
                const color =
                  state === 'done' ? '#4ade80' : state === 'ready' ? level.accent : 'var(--text-dim)';

                return (
                  <motion.div
                    key={b.slug}
                    initial={{ opacity: 0, x: -10 }}
                    whileInView={{ opacity: 1, x: 0 }}
                    viewport={{ once: true, margin: '-40px' }}
                    transition={{ duration: 0.35, delay: Math.min(i * 0.05, 0.3) }}
                  >
                    <Link
                      href={b.href}
                      className="card-glow block rounded-2xl border p-5"
                      style={
                        {
                          borderColor:
                            state === 'done'
                              ? 'color-mix(in srgb,#4ade80 35%,transparent)'
                              : state === 'ready'
                                ? `color-mix(in srgb, ${level.accent} 30%, transparent)`
                                : 'var(--border)',
                          background: 'var(--panel)',
                          '--card-accent': level.accent,
                          opacity: state === 'locked' ? 0.82 : 1,
                        } as React.CSSProperties
                      }
                    >
                      <div className="mb-2 flex flex-wrap items-center gap-2">
                        <h3
                          className="text-[15.5px] font-bold tracking-[-0.01em]"
                          style={{ color: 'var(--text)' }}
                        >
                          {b.title}
                        </h3>

                        {ready && (
                          <span
                            className="flex items-center gap-1 rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                            style={{
                              background: `color-mix(in srgb, ${color} 15%, transparent)`,
                              color,
                            }}
                          >
                            {state === 'done' && <IconCheck size={9} strokeWidth={4} />}
                            {state === 'done'
                              ? 'COMPLETED'
                              : state === 'ready'
                                ? 'READY'
                                : `${doneCount}/${b.prereqs.length} PREREQS`}
                          </span>
                        )}

                        <span
                          className="ml-auto font-mono text-[11.5px]"
                          style={{ color: 'var(--text-dim)' }}
                        >
                          {b.minutes} min
                        </span>
                      </div>

                      <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                        {b.summary}
                      </p>

                      {ready && !isReady && b.prereqs.length > 0 && (
                        <div className="mt-3 flex flex-wrap items-center gap-1.5">
                          <span className="text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                            Study first:
                          </span>
                          {b.prereqs
                            .filter((p) => !progress[p.slug]?.completed)
                            .map((p) => (
                              <span
                                key={p.slug}
                                className="rounded border px-1.5 py-0.5 text-[11px]"
                                style={{
                                  borderColor: 'var(--border)',
                                  color: 'var(--text-dim)',
                                }}
                              >
                                {p.title}
                              </span>
                            ))}
                        </div>
                      )}

                      {b.unlocks && isReady && (
                        <div
                          className="mt-3 flex items-start gap-1.5 text-[12px]"
                          style={{ color: 'var(--text-dim)' }}
                        >
                          <IconArrow size={12} className="mt-[3px] shrink-0" />
                          {b.unlocks}
                        </div>
                      )}
                    </Link>
                  </motion.div>
                );
              })}
            </div>
          </section>
        ))}
      </div>

      <Reveal>
        <p
          className="ml-[52px] text-[13px] md:ml-[68px]"
          style={{ color: 'var(--text-dim)' }}
        >
          Nothing here is locked — the states are guidance, not gates. If you&rsquo;re short on
          time, read anyway and backfill whatever the build exposes.
        </p>
      </Reveal>
    </main>
  );
}
