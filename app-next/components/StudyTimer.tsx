'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import { AnimatePresence, motion } from 'motion/react';

type Phase = 'idle' | 'study' | 'break';

const STUDY_MIN = 25;
const BREAK_MIN = 5;

/* A study timer that only counts time you were actually here. Switching tabs
   pauses it, so the minutes it reports (and writes to your activity heatmap)
   are honest rather than "how long the tab was open". */
export default function StudyTimer({ compact = false }: { compact?: boolean }) {
  const { status } = useSession();
  const [phase, setPhase] = useState<Phase>('idle');
  const [left, setLeft] = useState(STUDY_MIN * 60);
  const [todayMin, setTodayMin] = useState<number | null>(null);
  const [awayNote, setAwayNote] = useState(false);

  const accrued = useRef(0); // seconds studied but not yet flushed
  const tick = useRef<ReturnType<typeof setInterval> | null>(null);

  const flush = useCallback(async () => {
    const mins = Math.floor(accrued.current / 60);
    if (mins < 1 || status !== 'authenticated') return;
    accrued.current -= mins * 60;
    try {
      const r = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: mins }),
      });
      const d = await r.json();
      if (typeof d.minutes === 'number') setTodayMin(d.minutes);
    } catch {
      accrued.current += mins * 60; // put it back; retry on the next flush
    }
  }, [status]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/activity')
      .then((r) => r.json())
      .then((d) => setTodayMin(d.minutes ?? 0))
      .catch(() => {});
  }, [status]);

  // The clock.
  useEffect(() => {
    if (phase === 'idle') return;
    tick.current = setInterval(() => {
      if (phase === 'study') accrued.current += 1;
      setLeft((s) => {
        if (s > 1) return s - 1;
        // phase complete
        if (phase === 'study') {
          flush();
          setPhase('break');
          return BREAK_MIN * 60;
        }
        setPhase('study');
        return STUDY_MIN * 60;
      });
    }, 1000);
    return () => {
      if (tick.current) clearInterval(tick.current);
    };
  }, [phase, flush]);

  // Pause when the tab loses focus — and say so on return.
  useEffect(() => {
    const onVis = () => {
      if (document.hidden) {
        if (phase === 'study') {
          flush();
          setPhase('idle');
          setAwayNote(true);
        }
      }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, [phase, flush]);

  // Flush whatever is pending when leaving the page.
  useEffect(() => {
    const onLeave = () => {
      const mins = Math.floor(accrued.current / 60);
      if (mins >= 1 && status === 'authenticated' && navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/activity',
          new Blob([JSON.stringify({ minutes: mins })], { type: 'application/json' })
        );
        accrued.current -= mins * 60;
      }
    };
    window.addEventListener('pagehide', onLeave);
    return () => window.removeEventListener('pagehide', onLeave);
  }, [status]);

  const mmss = `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`;
  const total = (phase === 'break' ? BREAK_MIN : STUDY_MIN) * 60;
  const pct = phase === 'idle' ? 0 : ((total - left) / total) * 100;
  const color = phase === 'break' ? '#4ade80' : '#38bdf8';

  const start = () => {
    setAwayNote(false);
    setPhase('study');
    setLeft(STUDY_MIN * 60);
  };
  const stop = () => {
    flush();
    setPhase('idle');
    setLeft(STUDY_MIN * 60);
  };

  return (
    <div className={compact ? '' : 'w-full'}>
      <div className="flex items-center gap-2.5">
        <div className="relative h-8 w-8 shrink-0">
          <svg viewBox="0 0 36 36" className="-rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--bg-inset)" strokeWidth="3.5" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke={color}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 15}
              strokeDashoffset={2 * Math.PI * 15 * (1 - pct / 100)}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
          {phase !== 'idle' && (
            <span
              className="absolute inset-0 grid place-items-center text-[8px] font-bold"
              style={{ color }}
            >
              {phase === 'break' ? '☕' : ''}
            </span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-[15px] font-bold leading-none tabular-nums"
            style={{ color: phase === 'idle' ? 'var(--text-dim)' : 'var(--text)' }}
          >
            {mmss}
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {phase === 'idle'
              ? todayMin != null
                ? `${todayMin} min today`
                : 'Focus session'
              : phase === 'break'
                ? 'Break — step away'
                : 'Studying'}
          </div>
        </div>

        <button
          onClick={phase === 'idle' ? start : stop}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px] font-bold transition-colors"
          style={{
            background: phase === 'idle' ? `color-mix(in srgb, ${color} 16%, transparent)` : 'var(--bg-inset)',
            color: phase === 'idle' ? color : 'var(--text-soft)',
          }}
        >
          {phase === 'idle' ? 'Start' : 'Stop'}
        </button>
      </div>

      <AnimatePresence>
        {awayNote && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <p className="pt-2 text-[11px] leading-snug" style={{ color: '#fbbf24' }}>
              Paused while you were away — your minutes stayed honest. Ready to pick it back up?
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
