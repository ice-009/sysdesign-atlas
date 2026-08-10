'use client';

import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion, useScroll, useSpring } from 'motion/react';
import { useProgress } from './ProgressProvider';

/* Sits flush against the top of the viewport and above the header (z-55 beats
   the topbar's z-50). It was previously pinned at top-14 to tuck under the
   header — which left it floating across the text in focus mode, where the
   header slides away. top-0 is correct in both states.

   The bar answers "how far in am I"; the pill answers "how much is left", which
   is the question people actually stop to ask. It shows while you scroll and
   fades once you settle, so it is never sitting there competing with the text. */

const IDLE_MS = 1200;

export default function ReadingBar({ minutes }: { minutes: number }) {
  const { scrollYProgress } = useScroll();
  const width = useSpring(scrollYProgress, { stiffness: 180, damping: 30, restDelta: 0.001 });
  const { pace } = useProgress();

  const [left, setLeft] = useState<number | null>(null);
  const [visible, setVisible] = useState(false);
  const idle = useRef<ReturnType<typeof setTimeout> | null>(null);

  /* Your own pace beats the generic estimate. Guard the ratio: a single topic
     left open over lunch shouldn't tell everyone they read at 40× the estimate. */
  const ratio = pace?.ratio && pace.ratio > 0.25 && pace.ratio < 4 ? pace.ratio : 1;

  useEffect(() => {
    const unsub = scrollYProgress.on('change', (v) => {
      setLeft(Math.max(0, minutes * ratio * (1 - v)));
      setVisible(true);
      if (idle.current) clearTimeout(idle.current);
      idle.current = setTimeout(() => setVisible(false), IDLE_MS);
    });
    return () => {
      unsub();
      if (idle.current) clearTimeout(idle.current);
    };
  }, [scrollYProgress, minutes, ratio]);

  const label =
    left == null
      ? ''
      : left < 0.5
        ? 'Finished'
        : left < 1.5
          ? 'about a minute left'
          : `${Math.round(left)} min left`;

  return (
    <>
      <motion.div
        className="pointer-events-none fixed inset-x-0 top-0 z-[55] h-[2px] origin-left"
        style={{
          scaleX: width,
          background: 'linear-gradient(90deg,#38bdf8,#a78bfa,#f472b6)',
        }}
      />

      <AnimatePresence>
        {visible && label && (
          <motion.div
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 6 }}
            transition={{ duration: 0.18 }}
            className="pointer-events-none fixed bottom-5 left-5 z-[56] hidden rounded-full border px-3 py-1.5 text-[11.5px] font-semibold sm:block"
            style={{
              borderColor: 'var(--border)',
              background: 'color-mix(in srgb, var(--panel) 90%, transparent)',
              backdropFilter: 'blur(10px)',
              color: 'var(--text-dim)',
            }}
          >
            {label}
          </motion.div>
        )}
      </AnimatePresence>
    </>
  );
}
