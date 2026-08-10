'use client';

import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useTopicByHref, type IndexRow } from './TopicIndexProvider';

/* Hover a cross-reference and see where it goes without going there.

   The prose carries hundreds of links between topics. Following one to find out
   whether it's relevant costs you your place and usually your session; this
   turns that into a glance. Only prose links are previewed — the sidebar and
   topic cards already show the same information inline.

   The card is pointer-events-none by design. Nothing in it is clickable, so
   there's no need for the hover-bridge machinery that makes menus fiddly, and
   it can never sit between you and the link you were aiming at. */

const OPEN_DELAY = 350; // long enough that skimming a paragraph stays quiet
const CARD_W = 320;
const GAP = 10;

const DIFF: Record<string, string> = {
  easy: '#4ade80',
  medium: '#fbbf24',
  hard: '#fb7185',
};

type Shown = { row: IndexRow; x: number; y: number; above: boolean };

export default function LinkPreview() {
  const byHref = useTopicByHref();
  const [shown, setShown] = useState<Shown | null>(null);

  useEffect(() => {
    // No hover, no previews — on touch this would fire on tap and fight the nav.
    if (typeof window === 'undefined' || !window.matchMedia('(hover: hover)').matches) return;
    if (!byHref.size) return;

    let timer: ReturnType<typeof setTimeout> | null = null;
    let anchor: HTMLAnchorElement | null = null;

    const cancel = () => {
      if (timer) clearTimeout(timer);
      timer = null;
      anchor = null;
      setShown(null);
    };

    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement | null)?.closest?.(
        '.prose a[href^="/learn/"]'
      ) as HTMLAnchorElement | null;
      if (!el || el === anchor) return;

      if (timer) clearTimeout(timer);
      anchor = el;

      // Strip any #heading — the index is keyed by topic.
      const row = byHref.get((el.getAttribute('href') ?? '').split('#')[0]);
      if (!row) {
        anchor = null;
        return;
      }

      timer = setTimeout(() => {
        const r = el.getBoundingClientRect();
        // Flip above the link when there isn't room below it.
        const above = r.bottom + 190 > window.innerHeight;
        const x = Math.min(
          Math.max(GAP, r.left),
          Math.max(GAP, window.innerWidth - CARD_W - GAP)
        );
        setShown({ row, x, y: above ? r.top - GAP : r.bottom + GAP, above });
      }, OPEN_DELAY);
    };

    const onOut = (e: MouseEvent) => {
      if (!anchor) return;
      const to = e.relatedTarget as Node | null;
      if (to && anchor.contains(to)) return;
      cancel();
    };

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
    };

    document.addEventListener('mouseover', onOver);
    document.addEventListener('mouseout', onOut);
    document.addEventListener('keydown', onKey);
    // Any scroll invalidates the anchor rect, so drop it rather than chase it.
    window.addEventListener('scroll', cancel, { passive: true });
    return () => {
      document.removeEventListener('mouseover', onOver);
      document.removeEventListener('mouseout', onOut);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', cancel);
      if (timer) clearTimeout(timer);
    };
  }, [byHref]);

  return (
    <AnimatePresence>
      {shown && (
        <motion.div
          initial={{ opacity: 0, y: shown.above ? 4 : -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.14 }}
          aria-hidden="true"
          className="pointer-events-none fixed z-[80] rounded-xl border p-3.5 shadow-lg"
          style={{
            left: shown.x,
            top: shown.y,
            width: CARD_W,
            transform: shown.above ? 'translateY(-100%)' : undefined,
            borderColor: 'var(--border-strong)',
            background: 'color-mix(in srgb, var(--panel) 96%, transparent)',
            backdropFilter: 'blur(12px)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <div
            className="mb-1 text-[10px] font-bold uppercase tracking-wider"
            style={{ color: shown.row.acc }}
          >
            {shown.row.sec}
          </div>
          <div
            className="text-[14px] font-bold leading-snug"
            style={{ color: 'var(--text)' }}
          >
            {shown.row.t}
          </div>
          {shown.row.s && (
            <p
              className="mt-1.5 text-[12px] leading-relaxed"
              style={{
                color: 'var(--text-dim)',
                display: '-webkit-box',
                WebkitLineClamp: 3,
                WebkitBoxOrient: 'vertical',
                overflow: 'hidden',
              }}
            >
              {shown.row.s}
            </p>
          )}
          <div className="mt-2.5 flex items-center gap-2 text-[11px]">
            {shown.row.d && (
              <span
                className="rounded-full px-2 py-0.5 font-bold"
                style={{
                  background: `color-mix(in srgb, ${DIFF[shown.row.d.toLowerCase()] ?? 'var(--text-dim)'} 15%, transparent)`,
                  color: DIFF[shown.row.d.toLowerCase()] ?? 'var(--text-dim)',
                }}
              >
                {shown.row.d}
              </span>
            )}
            <span style={{ color: 'var(--text-dim)' }}>{shown.row.m} min read</span>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
