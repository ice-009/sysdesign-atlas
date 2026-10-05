'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import Reveal from './Reveal';
import ProgressRing from './ProgressRing';
import { SectionIcon, IconFlame, IconBookmark, IconArrow, IconTarget } from './Icons';
import PlanPanel from './PlanPanel';
import type { States } from '@/lib/prep';

type Stats = {
  done: number;
  total: number;
  streak: number;
  minutes: number;
  bookmarks: number;
  notes: number;
};

export default function DashboardView({
  name,
  stats,
  plan,
  perSection,
  review,
  recent,
  heatmap,
  bookmarks,
}: {
  name: string;
  stats: Stats;
  plan: { states: Record<string, unknown>; settings: unknown };
  perSection: { slug: string; title: string; accent: string; icon: string; done: number; total: number }[];
  review: { slug: string; title: string; href: string; confidence: number; accent: string }[];
  recent: { title: string; href: string; completed: boolean; accent: string }[];
  heatmap: { day: string; topics: number }[];
  bookmarks: { title: string; href: string; accent: string }[];
}) {
  const pct = stats.total ? Math.round((stats.done / stats.total) * 100) : 0;

  // 18 weeks of cells, most recent column on the right.
  const byDay = new Map(heatmap.map((h) => [h.day, h.topics]));
  const cells: { day: string; n: number }[] = [];
  for (let i = 125; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const key = d.toISOString().slice(0, 10);
    cells.push({ day: key, n: byDay.get(key) ?? 0 });
  }

  const tiles = [
    { label: 'Completed', value: `${stats.done}`, sub: `of ${stats.total} topics`, color: '#38bdf8' },
    { label: 'Day streak', value: `${stats.streak}`, sub: stats.streak === 1 ? 'day' : 'days', color: '#fb7185', flame: true },
    { label: 'Time invested', value: `${Math.floor(stats.minutes / 60)}h`, sub: `${stats.minutes % 60}m of reading`, color: '#4ade80' },
    { label: 'Saved & noted', value: `${stats.bookmarks + stats.notes}`, sub: `${stats.bookmarks} saved · ${stats.notes} notes`, color: '#a78bfa' },
  ];

  return (
    <main className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 py-10 pb-24">
      <Reveal>
        <h1
          className="text-[clamp(1.8rem,3.4vw,2.4rem)] font-extrabold tracking-[-0.03em]"
          style={{ color: 'var(--text)' }}
        >
          Welcome back, {name.split(' ')[0]}.
        </h1>
        <p className="mt-2 text-[16px]" style={{ color: 'var(--text-soft)' }}>
          {stats.done === 0
            ? 'Nothing logged yet — open any topic and mark it complete to start tracking.'
            : `You've completed ${stats.done} of ${stats.total} topics. ${
                review.length ? `${review.length} need another pass.` : 'Nothing flagged for review.'
              }`}
        </p>
      </Reveal>

      <PlanPanel initialStates={plan.states as States} initialSettings={plan.settings} />

      {/* stat tiles */}
      <div className="mt-8 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t, i) => (
          <Reveal key={t.label} delay={i * 0.05}>
            <div
              className="rounded-2xl border p-5"
              style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
            >
              <div className="mb-3 flex items-center gap-2">
                <span
                  className="text-[11px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--text-dim)' }}
                >
                  {t.label}
                </span>
                {t.flame && stats.streak > 0 && (
                  <motion.span
                    animate={{ scale: [1, 1.12, 1] }}
                    transition={{ duration: 1.8, repeat: Infinity }}
                    style={{ color: t.color }}
                  >
                    <IconFlame size={14} />
                  </motion.span>
                )}
              </div>
              <div
                className="font-mono text-[30px] font-bold leading-none tracking-tight"
                style={{ color: t.color }}
              >
                {t.value}
              </div>
              <div className="mt-1.5 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                {t.sub}
              </div>
            </div>
          </Reveal>
        ))}
      </div>

      <div className="mt-10 grid gap-5 lg:grid-cols-[1.4fr_1fr]">
        {/* progress by track */}
        <Reveal>
          <div
            className="rounded-2xl border p-6"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <div className="mb-6 flex items-center gap-5">
              <ProgressRing value={pct} size={92} stroke={9} />
              <div>
                <h2 className="text-[17px] font-bold" style={{ color: 'var(--text)' }}>
                  Progress by track
                </h2>
                <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
                  {pct}% of the full curriculum complete
                </p>
              </div>
            </div>

            <div className="grid gap-3.5">
              {perSection.map((s) => {
                const p = s.total ? (s.done / s.total) * 100 : 0;
                return (
                  <Link key={s.slug} href={`/learn/${s.slug}`} className="group block">
                    <div className="mb-1.5 flex items-center gap-2">
                      <span style={{ color: s.accent }}>
                        <SectionIcon name={s.icon} size={14} />
                      </span>
                      <span
                        className="text-[13.5px] font-semibold transition-colors group-hover:text-[var(--accent-text)]"
                        style={{ color: 'var(--text)' }}
                      >
                        {s.title}
                      </span>
                      <span
                        className="ml-auto font-mono text-[12px]"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {s.done}/{s.total}
                      </span>
                    </div>
                    <div
                      className="h-1.5 overflow-hidden rounded-full"
                      style={{ background: 'var(--bg-inset)' }}
                    >
                      <motion.div
                        className="h-full rounded-full"
                        style={{ background: s.accent }}
                        initial={{ width: 0 }}
                        whileInView={{ width: `${p}%` }}
                        viewport={{ once: true }}
                        transition={{ duration: 0.7, ease: [0.2, 0, 0, 1] }}
                      />
                    </div>
                  </Link>
                );
              })}
            </div>
          </div>
        </Reveal>

        {/* review queue */}
        <Reveal delay={0.08}>
          <div
            className="rounded-2xl border p-6"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <div className="mb-4 flex items-center gap-2">
              <IconTarget size={16} className="opacity-80" />
              <h2 className="text-[17px] font-bold" style={{ color: 'var(--text)' }}>
                Review queue
              </h2>
            </div>

            {review.length === 0 ? (
              <p className="text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
                Rate your confidence on a topic and anything shaky will surface here, weakest first.
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {review.map((r) => (
                  <li key={r.slug}>
                    <Link
                      href={r.href}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--bg-inset)]"
                    >
                      <span
                        className="h-6 w-1 shrink-0 rounded-full"
                        style={{ background: r.confidence === 1 ? '#fb7185' : '#fbbf24' }}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[13.5px]"
                        style={{ color: 'var(--text-soft)' }}
                      >
                        {r.title}
                      </span>
                      <span
                        className="shrink-0 text-[11px] font-bold"
                        style={{ color: r.confidence === 1 ? '#fb7185' : '#fbbf24' }}
                      >
                        {r.confidence === 1 ? 'Shaky' : 'OK'}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Reveal>
      </div>

      {/* activity heatmap */}
      <Reveal delay={0.1}>
        <div
          className="mt-5 rounded-2xl border p-6"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <h2 className="mb-4 text-[17px] font-bold" style={{ color: 'var(--text)' }}>
            Study activity
          </h2>
          <div className="flex gap-[3px] overflow-x-auto pb-1">
            {Array.from({ length: 18 }, (_, w) => (
              <div key={w} className="flex flex-col gap-[3px]">
                {cells.slice(w * 7, w * 7 + 7).map((c) => {
                  const alpha = c.n === 0 ? 0 : Math.min(0.25 + c.n * 0.25, 1);
                  return (
                    <div
                      key={c.day}
                      title={`${c.day} · ${c.n} topic${c.n === 1 ? '' : 's'}`}
                      className="h-[11px] w-[11px] rounded-[3px]"
                      style={{
                        background:
                          c.n === 0
                            ? 'var(--bg-inset)'
                            : `color-mix(in srgb, #38bdf8 ${alpha * 100}%, transparent)`,
                      }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
          <p className="mt-3 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            Last 18 weeks. Each square is a day you completed at least one topic.
          </p>
        </div>
      </Reveal>

      {/* recent + saved */}
      <div className="mt-5 grid gap-5 lg:grid-cols-2">
        <Reveal>
          <div
            className="h-full rounded-2xl border p-6"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <h2 className="mb-4 text-[17px] font-bold" style={{ color: 'var(--text)' }}>
              Continue where you left off
            </h2>
            {recent.length === 0 ? (
              <Link
                href="/learn"
                className="inline-flex items-center gap-2 text-[14px] font-semibold"
                style={{ color: 'var(--accent-text)' }}
              >
                Browse the curriculum <IconArrow size={14} />
              </Link>
            ) : (
              <ul className="grid gap-1.5">
                {recent.map((r) => (
                  <li key={r.href}>
                    <Link
                      href={r.href}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--bg-inset)]"
                    >
                      <span
                        className="h-6 w-1 shrink-0 rounded-full"
                        style={{ background: r.accent }}
                      />
                      <span
                        className="min-w-0 flex-1 truncate text-[13.5px]"
                        style={{ color: 'var(--text-soft)' }}
                      >
                        {r.title}
                      </span>
                      {r.completed && (
                        <span className="shrink-0 text-[11px] font-bold" style={{ color: '#4ade80' }}>
                          Done
                        </span>
                      )}
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Reveal>

        <Reveal delay={0.06}>
          <div
            className="h-full rounded-2xl border p-6"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <div className="mb-4 flex items-center gap-2">
              <IconBookmark size={15} />
              <h2 className="text-[17px] font-bold" style={{ color: 'var(--text)' }}>
                Saved topics
              </h2>
            </div>
            {bookmarks.length === 0 ? (
              <p className="text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
                Hit <strong>Save</strong> on any topic to pin it here for quick access before your loop.
              </p>
            ) : (
              <ul className="grid gap-1.5">
                {bookmarks.map((b) => (
                  <li key={b.href}>
                    <Link
                      href={b.href}
                      className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-[var(--bg-inset)]"
                    >
                      <span className="h-6 w-1 shrink-0 rounded-full" style={{ background: b.accent }} />
                      <span
                        className="min-w-0 flex-1 truncate text-[13.5px]"
                        style={{ color: 'var(--text-soft)' }}
                      >
                        {b.title}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </Reveal>
      </div>
    </main>
  );
}
