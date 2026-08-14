'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useProgress } from './ProgressProvider';
import { IconChevron } from './Icons';

/* Per-topic stopwatch, pinned to the bottom of the reading column.
   Press start when you begin a topic and it answers one question: how long did
   this actually take you, next to the estimate and next to your own pace on
   every other topic you've timed. */

const FLUSH_EVERY = 30_000; // write accrued seconds back this often
const AWAY_GRACE = 90_000; // tab-switches shorter than this still count

const fmt = (s: number) => {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  const mm = String(m).padStart(2, '0');
  const ss = String(sec).padStart(2, '0');
  return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
};

/** Compact human duration for totals — "1h 04m", "12m", "45s". */
const human = (s: number) => {
  if (s < 60) return `${Math.round(s)}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
};

/* The snapshot is always banked — seconds already earned, plus whether the
   clock was running and when the snapshot was taken. Storing a raw start
   timestamp instead would mean a tab closed overnight came back showing nine
   hours on this topic. */
type Saved = { base: number; running: boolean; at: number };

export default function TopicTimer({
  slug,
  section,
  estimateMin,
}: {
  slug: string;
  section: string;
  estimateMin: number;
}) {
  const { progress, pace, addTime, ready } = useProgress();

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0); // this session, seconds
  const [open, setOpen] = useState(false);
  const [awayNote, setAwayNote] = useState(false);

  const base = useRef(0); // seconds banked before the current run
  const startedAt = useRef<number | null>(null); // wall clock, ms
  const logged = useRef(0); // of `elapsed`, how much is already saved
  const hiddenAt = useRef<number | null>(null);

  const LS = `sd.timer.${slug}`;
  const estimate = estimateMin * 60;
  const banked = progress[slug]?.timeSpent ?? 0;

  const read = useCallback(
    () => base.current + (startedAt.current ? (Date.now() - startedAt.current) / 1000 : 0),
    []
  );

  const save = useCallback(() => {
    try {
      localStorage.setItem(
        LS,
        JSON.stringify({ base: read(), running: !!startedAt.current, at: Date.now() } satisfies Saved)
      );
    } catch {}
  }, [LS, read]);

  /* Hand whole seconds to the provider, which increments rather than
     overwrites — so a flush racing another tab can't lose time. */
  const flush = useCallback(() => {
    const now = Math.floor(read());
    const delta = now - logged.current;
    if (delta < 1) return;
    logged.current = now;
    addTime(slug, section, delta);
  }, [read, addTime, slug, section]);

  /* Restore an in-flight session across reloads and navigation. A snapshot
     older than the away grace means the tab was closed, not refreshed — keep
     the seconds already earned, but don't credit the gap. */
  useEffect(() => {
    let saved: Saved | null = null;
    try {
      saved = JSON.parse(localStorage.getItem(LS) ?? 'null');
    } catch {}
    if (!saved) return;

    const gap = Date.now() - (saved.at ?? 0);
    const resumable = saved.running && gap >= 0 && gap <= AWAY_GRACE;

    base.current = (saved.base ?? 0) + (resumable ? gap / 1000 : 0);
    startedAt.current = resumable ? Date.now() : null;
    logged.current = Math.floor(base.current);
    setRunning(resumable);
    setAwayNote(saved.running && !resumable);
    setElapsed(base.current);
  }, [LS]);

  // The clock. Wall-clock derived, so a throttled background tab can't drift.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setElapsed(read()), 250);
    return () => clearInterval(id);
  }, [running, read]);

  // Periodic write-back, so a crashed tab loses seconds rather than an hour.
  // The local snapshot rides along, which keeps `at` fresh for the restore.
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => {
      flush();
      save();
    }, FLUSH_EVERY);
    return () => clearInterval(id);
  }, [running, flush, save]);

  const start = useCallback(() => {
    setAwayNote(false);
    startedAt.current = Date.now();
    setRunning(true);
    save();
  }, [save]);

  const pause = useCallback(() => {
    flush();
    base.current = read();
    startedAt.current = null;
    setRunning(false);
    setElapsed(base.current);
    save();
  }, [flush, read, save]);

  const reset = useCallback(() => {
    // Only clears the visible session — time already logged to the topic stays.
    flush();
    base.current = 0;
    startedAt.current = null;
    logged.current = 0;
    setRunning(false);
    setElapsed(0);
    setAwayNote(false);
    try {
      localStorage.removeItem(LS);
    } catch {}
  }, [flush, LS]);

  // Walked away with it running? Bank the time up to the moment you left and
  // stop, rather than crediting a lunch break to this topic.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        hiddenAt.current = Date.now();
        flush();
        return;
      }
      const away = hiddenAt.current ? Date.now() - hiddenAt.current : 0;
      hiddenAt.current = null;
      if (!running || away <= AWAY_GRACE || !startedAt.current) return;
      // Credit up to the moment you left, not the moment you came back.
      base.current = base.current + (Date.now() - away - startedAt.current) / 1000;
      startedAt.current = null;
      setRunning(false);
      setElapsed(base.current);
      setAwayNote(true);
      save();
      flush();
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [running, flush, save]);

  // Leaving the page: beacon survives the unload, fetch usually doesn't.
  useEffect(() => {
    const onLeave = () => {
      const now = Math.floor(read());
      const delta = now - logged.current;
      save();
      if (delta < 1 || !navigator.sendBeacon) return;
      logged.current = now;
      navigator.sendBeacon(
        '/api/progress',
        new Blob([JSON.stringify({ slug, section, seconds: delta })], {
          type: 'application/json',
        })
      );
    };
    window.addEventListener('pagehide', onLeave);
    return () => window.removeEventListener('pagehide', onLeave);
  }, [read, save, slug, section]);

  // Flush on unmount too — navigating to the next topic is not a page unload.
  useEffect(() => () => flush(), [flush]);

  // `t` starts and stops, matching the f/g/d shortcuts in the focus controls.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== 't') return;
      e.preventDefault();
      running ? pause() : start();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [running, pause, start]);

  // Everything logged for this topic, including the un-flushed tail.
  const unsaved = Math.max(0, Math.floor(elapsed) - logged.current);
  const total = banked + unsaved;
  const ratio = total / estimate;
  const pct = Math.min(100, ratio * 100);

  const tone = !total ? 'var(--text-dim)' : ratio <= 1 ? '#4ade80' : ratio <= 1.6 ? '#38bdf8' : '#fbbf24';

  const verdict = !total
    ? `${estimateMin} min estimated`
    : ratio < 1
      ? `${Math.round(pct)}% of the ${estimateMin} min estimate`
      : ratio < 1.05
        ? `right on the ${estimateMin} min estimate`
        : `${ratio.toFixed(1)}× the ${estimateMin} min estimate`;

  return (
    <div
      className="fixed bottom-20 left-3 right-3 z-[58] sm:bottom-5 sm:left-1/2 sm:right-auto sm:w-[min(560px,calc(100vw-11rem))] sm:-translate-x-1/2"
      data-noise
    >
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ type: 'spring', stiffness: 400, damping: 32 }}
            className="mb-2 overflow-hidden rounded-2xl border px-4 py-3"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'color-mix(in srgb, var(--panel) 94%, transparent)',
              backdropFilter: 'blur(14px)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div className="grid grid-cols-3 gap-3">
              <Stat label="This session" value={fmt(elapsed)} />
              <Stat label="Total on topic" value={human(total)} tone={tone} />
              <Stat label="Estimate" value={`${estimateMin}m`} />
            </div>

            <div className="mt-3 border-t pt-3" style={{ borderColor: 'var(--border)' }}>
              {pace && pace.topics > 0 && pace.ratio != null ? (
                <p className="text-[12px] leading-snug" style={{ color: 'var(--text-soft)' }}>
                  Across <strong style={{ color: 'var(--text)' }}>{pace.topics}</strong> timed{' '}
                  {pace.topics === 1 ? 'topic' : 'topics'} you average{' '}
                  <strong style={{ color: 'var(--text)' }}>{pace.ratio.toFixed(2)}×</strong> the
                  estimate — {human(pace.seconds)} against {human(pace.estimateSeconds)} estimated.
                </p>
              ) : (
                <p className="text-[12px] leading-snug" style={{ color: 'var(--text-dim)' }}>
                  {ready
                    ? 'Time a few topics and your personal pace shows up here.'
                    : 'Loading your pace…'}
                </p>
              )}
              <button
                onClick={reset}
                className="mt-2.5 rounded-lg px-2.5 py-1 text-[11.5px] font-semibold"
                style={{ background: 'var(--bg-inset)', color: 'var(--text-dim)' }}
              >
                Reset session
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      <div
        className="flex items-center gap-3 rounded-2xl border px-3 py-2.5"
        style={{
          borderColor: running ? `color-mix(in srgb, ${tone} 45%, transparent)` : 'var(--border-strong)',
          background: 'color-mix(in srgb, var(--panel) 92%, transparent)',
          backdropFilter: 'blur(14px)',
          boxShadow: 'var(--shadow-lg)',
        }}
      >
        <button
          onClick={running ? pause : start}
          className="shrink-0 rounded-xl px-3.5 py-2 text-[12.5px] font-bold transition-colors"
          style={{
            background: running ? 'var(--bg-inset)' : `color-mix(in srgb, ${tone} 18%, transparent)`,
            color: running ? 'var(--text-soft)' : tone,
          }}
          title="Start or pause (T)"
        >
          {running ? 'Pause' : elapsed > 0 ? 'Resume' : 'Start'}
        </button>

        <div
          className="shrink-0 font-mono text-[17px] font-bold leading-none tabular-nums"
          style={{ color: elapsed > 0 ? 'var(--text)' : 'var(--text-dim)' }}
        >
          {fmt(elapsed)}
          {running && (
            <span className="pulse-dot ml-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle" style={{ background: tone }} />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-inset)' }}>
            <motion.div
              className="h-full rounded-full"
              animate={{ width: `${pct}%` }}
              transition={{ type: 'spring', stiffness: 120, damping: 24 }}
              style={{ background: tone }}
            />
          </div>
          <div className="mt-1 truncate text-[11px]" style={{ color: 'var(--text-dim)' }}>
            {awayNote ? (
              <span style={{ color: '#fbbf24' }}>Paused while you were away.</span>
            ) : (
              verdict
            )}
          </div>
        </div>

        <button
          onClick={() => setOpen((o) => !o)}
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg"
          style={{ background: 'var(--bg-inset)', color: 'var(--text-dim)' }}
          aria-label={open ? 'Hide timer details' : 'Show timer details'}
        >
          <IconChevron size={14} className={open ? '-rotate-90' : 'rotate-90'} />
        </button>
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: string }) {
  return (
    <div>
      <div className="text-[10px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
        {label}
      </div>
      <div
        className="mt-0.5 font-mono text-[15px] font-bold tabular-nums"
        style={{ color: tone ?? 'var(--text)' }}
      >
        {value}
      </div>
    </div>
  );
}
