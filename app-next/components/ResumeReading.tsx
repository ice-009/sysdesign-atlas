'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { IconArrow, IconX } from './Icons';

/* Remembers how far down a topic you got, and offers to put you back there.

   It never scrolls on its own. An unrequested jump on page load is worse than
   starting at the top: you lose your place while the page is still settling,
   and you can't tell whether you moved or the page did. */

const KEY = (slug: string) => `sd.read.${slug}`;
const MAX_AGE = 30 * 24 * 60 * 60 * 1000; // a month-old position is not useful
const WRITE_EVERY = 700; // ms; scroll fires far faster than localStorage should

// Ignore the extremes — the top isn't worth resuming, and the bottom means done.
const FLOOR = 0.08;
const CEIL = 0.92;

const maxScroll = () =>
  document.documentElement.scrollHeight - window.innerHeight;

export default function ResumeReading({ slug }: { slug: string }) {
  const [saved, setSaved] = useState<number | null>(null);
  const [gone, setGone] = useState(false);
  const lastWrite = useRef(0);

  // Read the stored position once, before scrolling starts overwriting it.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(KEY(slug));
      if (!raw) return;
      const { pct, at } = JSON.parse(raw) as { pct: number; at: number };
      if (typeof pct !== 'number' || !Number.isFinite(pct)) return;
      if (!at || Date.now() - at > MAX_AGE) return;
      if (pct > FLOOR && pct < CEIL) setSaved(pct);
    } catch {}
  }, [slug]);

  // Record progress as you read.
  useEffect(() => {
    let raf: number | null = null;
    const write = () => {
      raf = null;
      const max = maxScroll();
      if (max <= 0) return;
      const pct = Math.min(1, Math.max(0, window.scrollY / max));
      lastWrite.current = Date.now();
      try {
        if (pct <= FLOOR) localStorage.removeItem(KEY(slug));
        else localStorage.setItem(KEY(slug), JSON.stringify({ pct, at: Date.now() }));
      } catch {}
    };
    const onScroll = () => {
      if (raf || Date.now() - lastWrite.current < WRITE_EVERY) return;
      raf = requestAnimationFrame(write);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    // Catch the final position even if the last scroll was inside the throttle.
    window.addEventListener('pagehide', write);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('pagehide', write);
      if (raf) cancelAnimationFrame(raf);
      write();
    };
  }, [slug]);

  const jump = useCallback(() => {
    if (saved == null) return;
    window.scrollTo({ top: saved * maxScroll(), behavior: 'smooth' });
    setGone(true);
  }, [saved]);

  const show = saved != null && !gone;

  return (
    <AnimatePresence>
      {show && (
        <motion.div
          initial={{ opacity: 0, height: 0 }}
          animate={{ opacity: 1, height: 'auto' }}
          exit={{ opacity: 0, height: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 34 }}
          className="overflow-hidden"
          data-noise
        >
          <div className="flex items-center gap-2 pt-4">
            <button
              onClick={jump}
              className="flex items-center gap-2 rounded-lg px-3 py-2 text-[12.5px] font-semibold transition-colors"
              style={{
                background: 'color-mix(in srgb, var(--accent) 13%, transparent)',
                color: 'var(--accent-text)',
              }}
            >
              <IconArrow size={13} className="rotate-90" />
              Resume where you left off · {Math.round(saved * 100)}%
            </button>
            <button
              onClick={() => setGone(true)}
              aria-label="Dismiss"
              className="grid h-7 w-7 place-items-center rounded-lg transition-colors"
              style={{ color: 'var(--text-dim)' }}
            >
              <IconX size={13} />
            </button>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
