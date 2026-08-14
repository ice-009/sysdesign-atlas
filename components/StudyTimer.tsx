'use client';

import { AnimatePresence, motion } from 'motion/react';
import { useStudyTimer } from './StudyTimerProvider';
import { IconPause, IconPlay } from './Icons';

/* The timer as it appears inside the Focus panel. All of the state lives in
   StudyTimerProvider, so closing the panel leaves the session running — the
   pill takes over as the visible surface. */
export default function StudyTimer() {
  const { phase, paused, awayPaused, todayMin, mmss, pct, accent, start, stop, togglePause } =
    useStudyTimer();

  const idle = phase === 'idle';

  const label = idle
    ? todayMin != null
      ? `${todayMin} min today`
      : 'Focus session'
    : awayPaused
      ? 'Paused — you stepped away'
      : paused
        ? 'Paused'
        : phase === 'break'
          ? 'Break — step away'
          : 'Studying';

  return (
    <div className="w-full">
      <div className="flex items-center gap-2.5">
        <div className="relative h-8 w-8 shrink-0">
          <svg viewBox="0 0 36 36" className="-rotate-90">
            <circle cx="18" cy="18" r="15" fill="none" stroke="var(--bg-inset)" strokeWidth="3.5" />
            <circle
              cx="18"
              cy="18"
              r="15"
              fill="none"
              stroke={accent}
              strokeWidth="3.5"
              strokeLinecap="round"
              strokeDasharray={2 * Math.PI * 15}
              strokeDashoffset={2 * Math.PI * 15 * (1 - pct / 100)}
              style={{ transition: 'stroke-dashoffset 1s linear' }}
            />
          </svg>
          {phase === 'break' && (
            <span className="absolute inset-0 grid place-items-center text-[8px] font-bold">☕</span>
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div
            className="font-mono text-[15px] font-bold leading-none tabular-nums"
            style={{ color: idle ? 'var(--text-dim)' : 'var(--text)' }}
          >
            {mmss}
          </div>
          <div className="mt-0.5 text-[10px]" style={{ color: 'var(--text-dim)' }}>
            {label}
          </div>
        </div>

        {!idle && (
          <button
            onClick={togglePause}
            className="grid h-7 w-7 shrink-0 place-items-center rounded-lg transition-colors"
            style={{ background: 'var(--bg-inset)', color: 'var(--text-soft)' }}
            aria-label={paused ? 'Resume timer' : 'Pause timer'}
          >
            {paused ? <IconPlay size={12} /> : <IconPause size={12} />}
          </button>
        )}

        <button
          onClick={idle ? start : stop}
          className="shrink-0 rounded-lg px-2.5 py-1.5 text-[11.5px] font-bold transition-colors"
          style={{
            background: idle ? `color-mix(in srgb, ${accent} 16%, transparent)` : 'var(--bg-inset)',
            color: idle ? accent : 'var(--text-soft)',
          }}
        >
          {idle ? 'Start' : 'Stop'}
        </button>
      </div>

      <AnimatePresence>
        {awayPaused && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            className="overflow-hidden"
          >
            <p className="pt-2 text-[11px] leading-snug" style={{ color: '#fbbf24' }}>
              Paused while you were away — your minutes stay honest. It picks up where it left off
              when you come back.
            </p>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
