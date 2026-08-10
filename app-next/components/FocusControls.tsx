'use client';

import { useEffect, useId, useState } from 'react';
import { usePathname } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { useFocus } from './FocusProvider';
import StudyTimer from './StudyTimer';
import { IconX, IconSpark } from './Icons';

/* Floating study controls. Only appears on topic pages — there's nothing to
   focus on elsewhere. */
export default function FocusControls() {
  const { focus, guide, dim, timer, size, leading, width, serif, toggle, set, exitAll } =
    useFocus();
  const [open, setOpen] = useState(false);
  const pathname = usePathname();

  const onTopic = /^\/learn\/[^/]+\/[^/]+$/.test(pathname);

  // Collapse the panel when navigating away from a topic.
  useEffect(() => {
    if (!onTopic) setOpen(false);
  }, [onTopic, pathname]);

  if (!onTopic) return null;

  const modes = [
    {
      key: 'focus' as const,
      on: focus,
      label: 'Focus mode',
      hint: 'Hide nav, sidebar and TOC',
      kbd: 'F',
    },
    {
      key: 'guide' as const,
      on: guide,
      label: 'Reading guide',
      hint: 'A band that follows your cursor',
      kbd: 'G',
    },
    {
      key: 'dim' as const,
      on: dim,
      label: 'Spotlight',
      hint: 'Fade everything but the current block',
      kbd: 'D',
    },
    {
      key: 'timer' as const,
      on: timer,
      label: 'Study timer',
      hint: '25/5 sessions, logged to your streak',
      kbd: '',
    },
  ];

  const activeCount = [focus, guide, dim].filter(Boolean).length;

  return (
    <>
      {/* trigger */}
      <motion.button
        onClick={() => setOpen((o) => !o)}
        whileHover={{ scale: 1.04 }}
        whileTap={{ scale: 0.97 }}
        data-focus-fab
        className="fixed bottom-5 right-5 z-[60] flex h-11 items-center gap-2 rounded-full border px-4 shadow-lg"
        style={{
          borderColor: activeCount
            ? 'color-mix(in srgb, var(--accent) 45%, transparent)'
            : 'var(--border-strong)',
          background: 'color-mix(in srgb, var(--panel) 92%, transparent)',
          backdropFilter: 'blur(12px)',
          color: activeCount ? 'var(--accent-text)' : 'var(--text-soft)',
        }}
        aria-label="Study controls"
      >
        <IconSpark size={15} />
        <span className="text-[13px] font-semibold">
          {activeCount ? `Focus · ${activeCount}` : 'Focus'}
        </span>
        {activeCount > 0 && (
          <span
            className="pulse-dot h-1.5 w-1.5 rounded-full"
            style={{ background: 'var(--accent)' }}
          />
        )}
      </motion.button>

      {/* panel */}
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: 12, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed bottom-20 right-5 z-[60] max-h-[min(78vh,640px)] w-[322px] overflow-y-auto rounded-2xl border"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--panel)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div
              className="flex items-center justify-between px-4 py-3"
              style={{
                background:
                  'radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 65%)',
              }}
            >
              <h2 className="text-[13.5px] font-bold" style={{ color: 'var(--text)' }}>
                Study controls
              </h2>
              <button
                onClick={() => setOpen(false)}
                className="grid h-6 w-6 place-items-center rounded-md"
                style={{ color: 'var(--text-dim)' }}
                aria-label="Close"
              >
                <IconX size={13} />
              </button>
            </div>

            <div className="h-px" style={{ background: 'var(--border)' }} />

            {/* Reading comfort first — it applies everywhere, whereas the modes
                below are things you switch on for a single session. */}
            <div className="px-3.5 pb-1 pt-3">
              <div
                className="mb-2 text-[10px] font-bold uppercase tracking-wider"
                style={{ color: 'var(--text-dim)' }}
              >
                Reading
              </div>

              <Seg
                label="Text size"
                value={size}
                onChange={(v) => set('size', v)}
                options={[
                  { v: 's' as const, label: 'S' },
                  { v: 'm' as const, label: 'M' },
                  { v: 'l' as const, label: 'L' },
                  { v: 'xl' as const, label: 'XL' },
                ]}
              />
              <Seg
                label="Line spacing"
                value={leading}
                onChange={(v) => set('leading', v)}
                options={[
                  { v: 'tight' as const, label: 'Tight' },
                  { v: 'normal' as const, label: 'Normal' },
                  { v: 'loose' as const, label: 'Loose' },
                ]}
              />
              <Seg
                label="Column width"
                value={width}
                onChange={(v) => set('width', v)}
                options={[
                  { v: 'narrow' as const, label: 'Narrow' },
                  { v: 'normal' as const, label: 'Normal' },
                  { v: 'wide' as const, label: 'Wide' },
                ]}
              />
              <Seg
                label="Typeface"
                value={serif ? 'serif' : 'sans'}
                onChange={(v) => set('serif', v === 'serif')}
                options={[
                  { v: 'sans' as const, label: 'Sans' },
                  { v: 'serif' as const, label: 'Serif' },
                ]}
              />
            </div>

            <div className="mx-3.5 h-px" style={{ background: 'var(--border)' }} />

            <div className="grid gap-0.5 p-2">
              {modes.map((m) => (
                <button
                  key={m.key}
                  onClick={() => toggle(m.key)}
                  className="flex items-start gap-3 rounded-xl px-2.5 py-2.5 text-left transition-colors hover:bg-[var(--bg-inset)]"
                >
                  <span
                    className="relative mt-0.5 h-5 w-9 shrink-0 rounded-full transition-colors"
                    style={{ background: m.on ? 'var(--accent)' : 'var(--border-strong)' }}
                  >
                    <motion.span
                      className="absolute top-[3px] h-[14px] w-[14px] rounded-full bg-white"
                      animate={{ left: m.on ? 21 : 3 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    />
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="flex items-center gap-1.5">
                      <span
                        className="text-[13px] font-semibold"
                        style={{ color: m.on ? 'var(--accent-text)' : 'var(--text)' }}
                      >
                        {m.label}
                      </span>
                      {m.kbd && (
                        <kbd
                          className="rounded border px-1 py-px font-mono text-[9.5px]"
                          style={{ borderColor: 'var(--border-strong)', color: 'var(--text-dim)' }}
                        >
                          {m.kbd}
                        </kbd>
                      )}
                    </span>
                    <span
                      className="mt-0.5 block text-[11.5px] leading-snug"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      {m.hint}
                    </span>
                  </span>
                </button>
              ))}
            </div>

            <AnimatePresence>
              {timer && (
                <motion.div
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  className="overflow-hidden"
                >
                  <div className="h-px" style={{ background: 'var(--border)' }} />
                  <div className="p-3.5">
                    <StudyTimer />
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {activeCount > 0 && (
              <>
                <div className="h-px" style={{ background: 'var(--border)' }} />
                <button
                  onClick={exitAll}
                  className="w-full px-4 py-2.5 text-left text-[12.5px] font-medium transition-colors hover:bg-[var(--bg-inset)]"
                  style={{ color: 'var(--text-dim)' }}
                >
                  Turn everything off · <kbd className="font-mono">esc</kbd>
                </button>
              </>
            )}
          </motion.div>
        )}
      </AnimatePresence>

      {/* minimal exit affordance while in focus mode */}
      <AnimatePresence>
        {focus && !open && (
          <motion.button
            initial={{ opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -8 }}
            onClick={() => toggle('focus')}
            className="fixed left-1/2 top-4 z-[60] -translate-x-1/2 rounded-full border px-3.5 py-1.5 text-[11.5px] font-semibold"
            style={{
              borderColor: 'var(--border)',
              background: 'color-mix(in srgb, var(--panel) 88%, transparent)',
              backdropFilter: 'blur(10px)',
              color: 'var(--text-dim)',
            }}
          >
            Focus mode · press <kbd className="font-mono">F</kbd> or{' '}
            <kbd className="font-mono">esc</kbd> to exit
          </motion.button>
        )}
      </AnimatePresence>
    </>
  );
}

/* A labelled segmented control. The selected pill slides between options with a
   shared layoutId rather than fading, so the change reads as one thing moving. */
function Seg<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { v: T; label: string }[];
  onChange: (v: T) => void;
}) {
  const id = useId();
  return (
    <div className="mb-2.5 flex items-center justify-between gap-2">
      <span className="shrink-0 text-[11.5px]" style={{ color: 'var(--text-soft)' }}>
        {label}
      </span>
      <div
        role="group"
        aria-label={label}
        className="flex shrink-0 gap-0.5 rounded-lg p-0.5"
        style={{ background: 'var(--bg-inset)' }}
      >
        {options.map((o) => {
          const on = o.v === value;
          return (
            <button
              key={o.v}
              onClick={() => onChange(o.v)}
              aria-pressed={on}
              className="relative rounded-md px-2 py-1 text-[11.5px] font-semibold transition-colors"
              style={{ color: on ? 'var(--accent-text)' : 'var(--text-dim)' }}
            >
              {on && (
                <motion.span
                  layoutId={`seg-${id}`}
                  transition={{ type: 'spring', stiffness: 480, damping: 34 }}
                  className="absolute inset-0 rounded-md"
                  style={{ background: 'color-mix(in srgb, var(--accent) 16%, transparent)' }}
                />
              )}
              <span className="relative">{o.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
