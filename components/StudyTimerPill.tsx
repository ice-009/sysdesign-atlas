'use client';

import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { useFocus } from './FocusProvider';
import { useStudyTimer } from './StudyTimerProvider';
import { IconPause, IconPlay } from './Icons';

/* The running session, condensed. Appears whenever a timer is going and the
   Focus panel is closed, so closing the panel hides the controls rather than
   the clock. Tapping it reopens the panel; the button pauses without one. */
export default function StudyTimerPill() {
  const { timer, panelOpen, setPanelOpen } = useFocus();
  const { active, paused, awayPaused, phase, mmss, pct, accent, togglePause } = useStudyTimer();
  const pathname = usePathname();

  const onTopic = /^\/learn\/[^/]+\/[^/]+$/.test(pathname);
  const show = timer && active && !panelOpen;

  const R = 9;
  const C = 2 * Math.PI * R;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.94 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: 6, scale: 0.96 }}
          transition={{ type: 'spring', stiffness: 420, damping: 32 }}
          data-timer-pill
          // Sits above the Focus button on a topic page, and takes its place elsewhere.
          className={`fixed right-5 z-[59] flex h-9 items-center gap-1.5 rounded-full border pl-2 pr-1.5 shadow-lg ${
            onTopic ? 'bottom-[72px]' : 'bottom-5'
          }`}
          style={{
            borderColor: `color-mix(in srgb, ${accent} 40%, var(--border-strong))`,
            background: 'color-mix(in srgb, var(--panel) 92%, transparent)',
            backdropFilter: 'blur(12px)',
          }}
        >
          <button
            onClick={() => onTopic && setPanelOpen(true)}
            className="flex items-center gap-1.5"
            style={{ cursor: onTopic ? 'pointer' : 'default' }}
            aria-label={onTopic ? 'Open study controls' : undefined}
            title={
              awayPaused
                ? 'Paused while you were away'
                : phase === 'break'
                  ? 'Break'
                  : paused
                    ? 'Paused'
                    : 'Studying'
            }
          >
            <span className="relative grid h-[22px] w-[22px] place-items-center">
              <svg viewBox="0 0 22 22" className="-rotate-90 h-[22px] w-[22px]">
                <circle cx="11" cy="11" r={R} fill="none" stroke="var(--bg-inset)" strokeWidth="2.5" />
                <circle
                  cx="11"
                  cy="11"
                  r={R}
                  fill="none"
                  stroke={accent}
                  strokeWidth="2.5"
                  strokeLinecap="round"
                  strokeDasharray={C}
                  strokeDashoffset={C * (1 - pct / 100)}
                  style={{ transition: 'stroke-dashoffset 1s linear' }}
                />
              </svg>
              {phase === 'break' && (
                <span className="absolute text-[8px] leading-none">☕</span>
              )}
            </span>

            <span
              className="font-mono text-[12.5px] font-bold leading-none tabular-nums"
              style={{ color: paused ? 'var(--text-dim)' : 'var(--text)' }}
            >
              {mmss}
            </span>

            {paused && (
              <span
                className="text-[10px] font-semibold leading-none"
                style={{ color: '#fbbf24' }}
              >
                {awayPaused ? 'away' : 'paused'}
              </span>
            )}
          </button>

          <button
            onClick={togglePause}
            className="grid h-6 w-6 shrink-0 place-items-center rounded-full transition-colors hover:bg-[var(--bg-inset)]"
            style={{ color: 'var(--text-soft)' }}
            aria-label={paused ? 'Resume timer' : 'Pause timer'}
          >
            {paused ? <IconPlay size={11} /> : <IconPause size={11} />}
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
