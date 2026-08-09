'use client';

import { useEffect, useRef, useState } from 'react';
import { useFocus } from './FocusProvider';

/* Two reading aids that share a scroll listener:

   guide → a soft horizontal band that tracks the pointer, so your eye has a
           fixed line to return to (the digital version of a finger under text)
   dim   → spotlights the block nearest the middle of the viewport and fades
           the rest, so peripheral text stops competing for attention          */
export default function ReadingGuide() {
  const { guide, dim } = useFocus();
  const [y, setY] = useState(0);
  const raf = useRef<number | null>(null);

  // Pointer-following band.
  useEffect(() => {
    if (!guide) return;
    const onMove = (e: MouseEvent) => {
      if (raf.current) return;
      raf.current = requestAnimationFrame(() => {
        setY(e.clientY);
        raf.current = null;
      });
    };
    window.addEventListener('mousemove', onMove, { passive: true });
    return () => {
      window.removeEventListener('mousemove', onMove);
      if (raf.current) cancelAnimationFrame(raf.current);
      raf.current = null;
    };
  }, [guide]);

  // Paragraph spotlight.
  useEffect(() => {
    if (!dim) {
      document.querySelectorAll('.prose > .is-active').forEach((n) => n.classList.remove('is-active'));
      return;
    }

    let ticking = false;
    const update = () => {
      ticking = false;
      const blocks = Array.from(
        document.querySelectorAll<HTMLElement>('.prose > *')
      ).filter((el) => el.offsetHeight > 0);
      if (!blocks.length) return;

      const mid = window.innerHeight * 0.42;
      let best: HTMLElement | null = null;
      let bestDist = Infinity;

      for (const el of blocks) {
        const r = el.getBoundingClientRect();
        if (r.bottom < 0 || r.top > window.innerHeight) continue;
        const d = Math.abs(r.top + r.height / 2 - mid);
        if (d < bestDist) {
          bestDist = d;
          best = el;
        }
      }

      for (const el of blocks) el.classList.toggle('is-active', el === best);
    };

    const onScroll = () => {
      if (ticking) return;
      ticking = true;
      requestAnimationFrame(update);
    };

    update();
    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onScroll);
    return () => {
      window.removeEventListener('scroll', onScroll);
      window.removeEventListener('resize', onScroll);
      document.querySelectorAll('.prose > .is-active').forEach((n) => n.classList.remove('is-active'));
    };
  }, [dim]);

  if (!guide) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-[45]" aria-hidden="true">
      {/* shade above and below leaves a clear reading band */}
      <div
        className="absolute inset-x-0 top-0"
        style={{
          height: Math.max(0, y - 46),
          background: 'color-mix(in srgb, var(--bg) 62%, transparent)',
          transition: 'height .06s linear',
        }}
      />
      <div
        className="absolute inset-x-0 bottom-0"
        style={{
          top: y + 46,
          background: 'color-mix(in srgb, var(--bg) 62%, transparent)',
          transition: 'top .06s linear',
        }}
      />
      <div
        className="absolute inset-x-0"
        style={{
          top: y - 46,
          height: 92,
          borderTop: '1px solid color-mix(in srgb, var(--accent) 32%, transparent)',
          borderBottom: '1px solid color-mix(in srgb, var(--accent) 32%, transparent)',
          background:
            'linear-gradient(180deg, transparent, color-mix(in srgb, var(--accent) 5%, transparent), transparent)',
          transition: 'top .06s linear',
        }}
      />
    </div>
  );
}
