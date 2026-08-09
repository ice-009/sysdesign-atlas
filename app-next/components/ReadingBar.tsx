'use client';

import { motion, useScroll, useSpring } from 'motion/react';

/* Sits flush against the top of the viewport and above the header (z-55 beats
   the topbar's z-50). It was previously pinned at top-14 to tuck under the
   header — which left it floating across the text in focus mode, where the
   header slides away. top-0 is correct in both states. */
export default function ReadingBar() {
  const { scrollYProgress } = useScroll();
  const width = useSpring(scrollYProgress, { stiffness: 180, damping: 30, restDelta: 0.001 });

  return (
    <motion.div
      className="pointer-events-none fixed inset-x-0 top-0 z-[55] h-[2px] origin-left"
      style={{
        scaleX: width,
        background: 'linear-gradient(90deg,#38bdf8,#a78bfa,#f472b6)',
      }}
    />
  );
}
