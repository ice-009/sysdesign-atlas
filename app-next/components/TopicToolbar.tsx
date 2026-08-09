'use client';

import { motion } from 'motion/react';
import { useProgress } from './ProgressProvider';
import { IconCheck, IconBookmark } from './Icons';

const LEVELS = [
  { v: 1, label: 'Shaky', color: '#fb7185' },
  { v: 2, label: 'OK', color: '#fbbf24' },
  { v: 3, label: 'Solid', color: '#4ade80' },
];

export default function TopicToolbar({
  slug,
  section,
  title,
}: {
  slug: string;
  section: string;
  title: string;
}) {
  const { progress, bookmarks, setCompleted, setConfidence, toggleBookmark } = useProgress();
  const row = progress[slug];
  const done = !!row?.completed;
  const conf = row?.confidence ?? 0;
  const saved = bookmarks.has(slug);

  return (
    <div
      data-noise
      className="mt-7 flex flex-wrap items-center gap-2.5 rounded-xl border p-3"
      style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
    >
      <button
        onClick={() => setCompleted(slug, section, !done)}
        className="flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13.5px] font-semibold transition-all"
        style={{
          background: done ? 'color-mix(in srgb, #4ade80 15%, transparent)' : 'var(--bg-inset)',
          color: done ? '#4ade80' : 'var(--text-soft)',
        }}
      >
        <motion.span
          animate={done ? { scale: [1, 1.25, 1] } : {}}
          transition={{ duration: 0.32 }}
          className="grid h-4 w-4 place-items-center rounded-full border"
          style={{
            borderColor: done ? '#4ade80' : 'var(--border-strong)',
            background: done ? '#4ade80' : 'transparent',
            color: '#071018',
          }}
        >
          {done && <IconCheck size={10} strokeWidth={3.5} />}
        </motion.span>
        {done ? 'Completed' : 'Mark complete'}
      </button>

      <button
        onClick={() => toggleBookmark(slug, section, title)}
        className="flex items-center gap-2 rounded-lg px-3 py-2 text-[13.5px] font-semibold transition-colors"
        style={{
          background: saved ? 'color-mix(in srgb, #38bdf8 14%, transparent)' : 'var(--bg-inset)',
          color: saved ? 'var(--accent)' : 'var(--text-soft)',
        }}
      >
        <IconBookmark size={14} filled={saved} />
        {saved ? 'Saved' : 'Save'}
      </button>

      <div className="ml-auto flex items-center gap-1.5">
        <span className="mr-1 text-[11.5px] font-semibold" style={{ color: 'var(--text-dim)' }}>
          Confidence
        </span>
        {LEVELS.map((l) => {
          const active = conf === l.v;
          return (
            <button
              key={l.v}
              onClick={() => setConfidence(slug, section, active ? 0 : l.v)}
              title={`Rate as ${l.label}`}
              className="rounded-lg px-2.5 py-1.5 text-[12px] font-bold transition-all"
              style={{
                background: active ? `color-mix(in srgb, ${l.color} 17%, transparent)` : 'var(--bg-inset)',
                color: active ? l.color : 'var(--text-dim)',
                outline: active ? `1px solid ${l.color}` : 'none',
              }}
            >
              {l.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}
