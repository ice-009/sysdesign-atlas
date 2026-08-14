'use client';

import Link from 'next/link';
import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import Reveal from './Reveal';
import { IconSpark, IconArrow, IconTarget } from './Icons';

type Prompt = { q: string; group: string; star?: boolean; href?: string };

const PHASES = [
  { at: 0, label: 'Requirements & scope', mins: 8 },
  { at: 8, label: 'Estimation', mins: 5 },
  { at: 13, label: 'API & data model', mins: 4 },
  { at: 17, label: 'High-level design', mins: 10 },
  { at: 27, label: 'Deep dives', mins: 13 },
  { at: 40, label: 'Bottlenecks & wrap-up', mins: 5 },
];

export default function PracticeView({
  prompts,
  hostile,
}: {
  prompts: Prompt[];
  hostile: string[];
}) {
  const [current, setCurrent] = useState<Prompt | null>(null);
  const [seconds, setSeconds] = useState(45 * 60);
  const [running, setRunning] = useState(false);
  const [challenge, setChallenge] = useState<string | null>(null);
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!running) return;
    tick.current = setInterval(() => setSeconds((s) => Math.max(0, s - 1)), 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [running]);

  const elapsed = 45 * 60 - seconds;
  const elapsedMin = Math.floor(elapsed / 60);
  const phase = [...PHASES].reverse().find((p) => elapsedMin >= p.at) ?? PHASES[0];

  const start = useCallback(() => {
    const pool = prompts.filter((p) => p.q !== current?.q);
    setCurrent(pool[Math.floor(Math.random() * pool.length)]);
    setSeconds(45 * 60);
    setRunning(true);
    setChallenge(null);
  }, [prompts, current]);

  const mmss = `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(seconds % 60).padStart(2, '0')}`;
  const groups = [...new Set(prompts.map((p) => p.group))];

  return (
    <main className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 py-10 pb-24">
      <Reveal>
        <h1
          className="text-[clamp(1.8rem,3.4vw,2.4rem)] font-extrabold tracking-[-0.03em]"
          style={{ color: 'var(--text)' }}
        >
          Design drills
        </h1>
        <p className="mt-3 max-w-[68ch] text-[16.5px]" style={{ color: 'var(--text-soft)' }}>
          Reading produces recognition; designing produces understanding. Draw a prompt and work it
          through end to end — out loud, on paper, without looking anything up. The clock is optional;
          the point is to find where you stall, because that is your actual curriculum.
        </p>
      </Reveal>

      {/* timer */}
      <Reveal delay={0.06}>
        <div
          className="mt-8 overflow-hidden rounded-2xl border"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <div className="grid gap-6 p-7 lg:grid-cols-[1fr_auto] lg:items-center">
            <div className="min-w-0">
              <AnimatePresence mode="wait">
                {current ? (
                  <motion.div
                    key={current.q}
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                    transition={{ duration: 0.3 }}
                  >
                    <div
                      className="mb-2 text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: 'var(--accent)' }}
                    >
                      {current.group}
                    </div>
                    <h2
                      className="text-[clamp(1.3rem,2.6vw,1.9rem)] font-extrabold leading-tight tracking-tight"
                      style={{ color: 'var(--text)' }}
                    >
                      {current.q}
                    </h2>
                    {current.href && (
                      <Link
                        href={current.href}
                        className="mt-3 inline-flex items-center gap-1.5 text-[13.5px] font-semibold"
                        style={{ color: 'var(--accent-text)' }}
                      >
                        Worked solution (read after your attempt) <IconArrow size={13} />
                      </Link>
                    )}
                  </motion.div>
                ) : (
                  <motion.p
                    key="idle"
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    className="text-[17px]"
                    style={{ color: 'var(--text-dim)' }}
                  >
                    Draw a random prompt. Start the clock if you want the pressure.
                  </motion.p>
                )}
              </AnimatePresence>
            </div>

            <div className="flex items-center gap-5">
              <div className="text-right">
                <div
                  className="font-mono text-[42px] font-bold leading-none tracking-tight tabular-nums"
                  style={{ color: seconds < 300 && running ? '#fb7185' : 'var(--text)' }}
                >
                  {mmss}
                </div>
                {running && (
                  <div className="mt-1.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                    Now: <span style={{ color: 'var(--accent-text)' }}>{phase.label}</span>
                  </div>
                )}
              </div>
              <div className="grid gap-2">
                <button
                  onClick={start}
                  className="rounded-xl px-5 py-2.5 text-[14px] font-bold text-[#071018] transition-transform hover:scale-[1.03]"
                  style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
                >
                  {current ? 'New prompt' : 'Draw prompt'}
                </button>
                {current && (
                  <button
                    onClick={() => setRunning((r) => !r)}
                    className="rounded-xl border px-5 py-2.5 text-[14px] font-semibold"
                    style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}
                  >
                    {running ? 'Pause' : 'Resume'}
                  </button>
                )}
              </div>
            </div>
          </div>

          {/* phase track */}
          <div className="flex h-1.5" style={{ background: 'var(--bg-inset)' }}>
            {PHASES.map((p) => {
              const active = phase.label === p.label && running;
              return (
                <div
                  key={p.label}
                  title={`${p.label} · ${p.mins} min`}
                  style={{
                    flex: p.mins,
                    background: active ? 'var(--accent)' : 'transparent',
                    borderRight: '1px solid var(--bg)',
                    transition: 'background .3s',
                  }}
                />
              );
            })}
          </div>

          {current && (
            <div
              className="flex flex-wrap items-center gap-3 border-t px-7 py-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <button
                onClick={() => setChallenge(hostile[Math.floor(Math.random() * hostile.length)])}
                className="inline-flex items-center gap-2 rounded-lg px-3.5 py-2 text-[13px] font-semibold"
                style={{ background: 'var(--bg-inset)', color: 'var(--text-soft)' }}
              >
                <IconSpark size={14} /> Hit me with a hostile question
              </button>
              <AnimatePresence>
                {challenge && (
                  <motion.span
                    key={challenge}
                    initial={{ opacity: 0, x: -8 }}
                    animate={{ opacity: 1, x: 0 }}
                    exit={{ opacity: 0 }}
                    className="text-[14px] font-semibold"
                    style={{ color: '#fb7185' }}
                  >
                    “{challenge}”
                  </motion.span>
                )}
              </AnimatePresence>
            </div>
          )}
        </div>
      </Reveal>

      {/* full bank */}
      <section className="mt-14">
        <Reveal>
          <div className="mb-6 flex items-center gap-2">
            <IconTarget size={18} />
            <h2 className="text-[21px] font-bold tracking-tight" style={{ color: 'var(--text)' }}>
              The full question bank
            </h2>
          </div>
        </Reveal>

        <div className="grid gap-5 md:grid-cols-2 xl:grid-cols-3">
          {groups.map((g, i) => (
            <Reveal key={g} delay={i * 0.04}>
              <div
                className="h-full rounded-2xl border p-5"
                style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
              >
                <h3
                  className="mb-3 text-[12px] font-bold uppercase tracking-wider"
                  style={{ color: 'var(--accent)' }}
                >
                  {g}
                </h3>
                <ul className="grid gap-1">
                  {prompts
                    .filter((p) => p.group === g)
                    .map((p) => (
                      <li key={p.q} className="flex items-start gap-2">
                        {p.star && (
                          <span className="mt-[3px] shrink-0 text-[11px]" style={{ color: '#fbbf24' }}>
                            ★
                          </span>
                        )}
                        {p.href ? (
                          <Link
                            href={p.href}
                            className="text-[13.5px] leading-snug transition-colors hover:text-[var(--accent-text)]"
                            style={{ color: 'var(--text-soft)' }}
                          >
                            {p.q}
                          </Link>
                        ) : (
                          <span
                            className="text-[13.5px] leading-snug"
                            style={{ color: 'var(--text-dim)' }}
                          >
                            {p.q}
                          </span>
                        )}
                      </li>
                    ))}
                </ul>
              </div>
            </Reveal>
          ))}
        </div>
        <p className="mt-6 text-[13px]" style={{ color: 'var(--text-dim)' }}>
          ★ marks the highest-frequency prompts. Linked ones have a full worked solution — read it
          only <em>after</em> your own timed attempt.
        </p>
      </section>
    </main>
  );
}
