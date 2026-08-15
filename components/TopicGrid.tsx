'use client';

import Link from 'next/link';
import { motion } from 'motion/react';
import { useProgress } from './ProgressProvider';
import { SCOPE_META, type Scope } from '@/lib/scope';
import { IconCheck, IconBookmark } from './Icons';

export type GridItem = {
  slug: string;
  title: string;
  summary: string;
  difficulty: string;
  scope: Scope;
  minutes: number;
  href: string;
  accent: string;
};

const DIFF: Record<string, string> = {
  easy: '#4ade80',
  medium: '#fbbf24',
  hard: '#fb7185',
};

export default function TopicGrid({ topics }: { topics: GridItem[] }) {
  const { progress, bookmarks } = useProgress();
  const onMove = (e: React.MouseEvent<HTMLElement>) => {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  };

  return (
    <>
      <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-3">
      {topics.map((t, i) => {
        const done = progress[t.slug]?.completed;
        const conf = progress[t.slug]?.confidence ?? 0;
        const saved = bookmarks.has(t.slug);
        const dc = DIFF[t.difficulty.toLowerCase()] ?? 'var(--text-dim)';

        return (
          <motion.div
            key={t.slug}
            initial={{ opacity: 0, y: 12 }}
            whileInView={{ opacity: 1, y: 0 }}
            viewport={{ once: true, margin: '-40px' }}
            transition={{ duration: 0.35, delay: Math.min(i * 0.03, 0.3) }}
          >
            <Link
              href={t.href}
              onMouseMove={onMove}
              data-topic-scope={t.scope}
              className="card-glow relative flex h-full flex-col rounded-2xl border p-5"
              style={
                {
                  borderColor: done
                    ? 'color-mix(in srgb, #4ade80 35%, transparent)'
                    : 'var(--border)',
                  background: 'var(--panel)',
                  '--card-accent': t.accent,
                } as React.CSSProperties
              }
            >
              <div className="mb-2.5 flex items-center gap-2">
                <span
                  className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                  style={{
                    background: `color-mix(in srgb, ${SCOPE_META[t.scope].color} 15%, transparent)`,
                    color: SCOPE_META[t.scope].color,
                  }}
                >
                  {SCOPE_META[t.scope].label}
                </span>
                {t.difficulty && (
                  <span
                    className="rounded-full px-2 py-0.5 text-[10.5px] font-bold"
                    style={{
                      background: `color-mix(in srgb, ${dc} 14%, transparent)`,
                      color: dc,
                    }}
                  >
                    {t.difficulty}
                  </span>
                )}
                <span className="font-mono text-[11px]" style={{ color: 'var(--text-dim)' }}>
                  {t.minutes} min
                </span>

                <span className="ml-auto flex items-center gap-1.5">
                  {saved && <IconBookmark size={13} filled className="opacity-70" style={{ color: t.accent }} />}
                  {done && (
                    <motion.span
                      initial={{ scale: 0 }}
                      animate={{ scale: 1 }}
                      className="grid h-4.5 w-4.5 place-items-center rounded-full"
                      style={{ background: '#4ade80', color: '#071018', width: 18, height: 18 }}
                    >
                      <IconCheck size={11} strokeWidth={3.5} />
                    </motion.span>
                  )}
                </span>
              </div>

              <h3
                className="mb-1.5 text-[15px] font-bold leading-snug tracking-[-0.01em]"
                style={{ color: done ? 'var(--text-soft)' : 'var(--text)' }}
              >
                {t.title}
              </h3>
              <p className="flex-1 text-[13px] leading-relaxed" style={{ color: 'var(--text-dim)' }}>
                {t.summary}
              </p>

              {conf > 0 && (
                <div className="mt-3 flex items-center gap-1">
                  {[1, 2, 3].map((n) => (
                    <span
                      key={n}
                      className="h-1 flex-1 rounded-full"
                      style={{
                        background:
                          n <= conf
                            ? ['#fb7185', '#fbbf24', '#4ade80'][conf - 1]
                            : 'var(--bg-inset)',
                      }}
                    />
                  ))}
                </div>
              )}
            </Link>
          </motion.div>
        );
      })}
      </div>
    </>
  );
}
