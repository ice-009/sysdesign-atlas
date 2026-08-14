'use client';

import Link from 'next/link';
import { AnimatePresence, motion } from 'motion/react';
import { useProgress } from './ProgressProvider';
import { IconCheck, IconArrow, IconSpark } from './Icons';

export type PrereqItem = {
  slug: string;
  title: string;
  href: string;
  section: string;
  accent: string;
};

/* Advisory readiness indicator. Never blocks reading — it tells you which
   concepts a topic assumes, and which of those you've marked complete. */
export default function PrereqBanner({
  prereqs,
  unlocks,
}: {
  prereqs: PrereqItem[];
  unlocks?: string;
}) {
  const { progress, ready } = useProgress();

  if (!prereqs.length) return null;

  const done = prereqs.filter((p) => progress[p.slug]?.completed);
  const todo = prereqs.filter((p) => !progress[p.slug]?.completed);
  const allDone = todo.length === 0;
  const pct = Math.round((done.length / prereqs.length) * 100);

  // Avoid flashing "not ready" while progress is still loading.
  if (!ready) {
    return (
      <div
        className="mt-7 h-[92px] animate-pulse rounded-2xl border"
        style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
      />
    );
  }

  const accent = allDone ? '#4ade80' : '#fbbf24';

  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.35 }}
      className="mt-7 overflow-hidden rounded-2xl border"
      style={{
        borderColor: `color-mix(in srgb, ${accent} 34%, transparent)`,
        background: `color-mix(in srgb, ${accent} 5%, var(--panel))`,
      }}
    >
      <div className="flex flex-wrap items-center gap-3 px-5 pt-4">
        <span
          className="grid h-7 w-7 place-items-center rounded-full"
          style={{ background: `color-mix(in srgb, ${accent} 18%, transparent)`, color: accent }}
        >
          {allDone ? <IconCheck size={14} strokeWidth={3} /> : <IconSpark size={14} />}
        </span>

        <div className="min-w-0 flex-1">
          <h2 className="text-[14.5px] font-bold" style={{ color: accent }}>
            {allDone
              ? "You're ready for this"
              : `Study ${todo.length} more ${todo.length === 1 ? 'topic' : 'topics'} first`}
          </h2>
          <p className="mt-0.5 text-[13px]" style={{ color: 'var(--text-soft)' }}>
            {allDone
              ? 'You’ve completed everything this topic assumes. It should read as “of course” rather than “where did that come from”.'
              : 'You can read this now — but these concepts are assumed, so it’ll land better once they’re in place.'}
          </p>
        </div>

        <div className="flex items-center gap-2">
          <div
            className="h-1.5 w-20 overflow-hidden rounded-full"
            style={{ background: 'var(--bg-inset)' }}
          >
            <motion.div
              className="h-full rounded-full"
              style={{ background: accent }}
              initial={{ width: 0 }}
              animate={{ width: `${pct}%` }}
              transition={{ duration: 0.6, ease: [0.2, 0, 0, 1] }}
            />
          </div>
          <span className="font-mono text-[12px] font-bold" style={{ color: accent }}>
            {done.length}/{prereqs.length}
          </span>
        </div>
      </div>

      <ul className="flex flex-wrap gap-1.5 px-5 py-4">
        <AnimatePresence initial={false}>
          {prereqs.map((p) => {
            const isDone = !!progress[p.slug]?.completed;
            return (
              <motion.li key={p.slug} layout>
                <Link
                  href={p.href}
                  title={`${p.section} · ${isDone ? 'completed' : 'not yet studied'}`}
                  className="flex items-center gap-1.5 rounded-lg border px-2.5 py-1.5 text-[12.5px] font-medium transition-colors"
                  style={{
                    borderColor: isDone
                      ? 'color-mix(in srgb, #4ade80 40%, transparent)'
                      : 'var(--border)',
                    background: isDone
                      ? 'color-mix(in srgb, #4ade80 9%, transparent)'
                      : 'var(--bg-soft)',
                    color: isDone ? '#4ade80' : 'var(--text-soft)',
                  }}
                >
                  <span
                    className="grid h-3.5 w-3.5 place-items-center rounded-full border"
                    style={{
                      borderColor: isDone ? '#4ade80' : 'var(--border-strong)',
                      background: isDone ? '#4ade80' : 'transparent',
                      color: '#071018',
                    }}
                  >
                    {isDone && <IconCheck size={9} strokeWidth={4} />}
                  </span>
                  {p.title}
                </Link>
              </motion.li>
            );
          })}
        </AnimatePresence>
      </ul>

      {unlocks && (
        <div
          className="flex items-start gap-2 border-t px-5 py-3"
          style={{ borderColor: 'var(--border)' }}
        >
          <IconArrow size={13} className="mt-[3px] shrink-0" style={{ color: 'var(--text-dim)' }} />
          <p className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
            <span className="font-semibold" style={{ color: 'var(--text-soft)' }}>
              After this you&rsquo;ll be able to:
            </span>{' '}
            {unlocks}
          </p>
        </div>
      )}
    </motion.section>
  );
}
