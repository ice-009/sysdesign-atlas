'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { useProgress } from './ProgressProvider';
import { SectionIcon, IconChevron, IconX } from './Icons';

type S = { slug: string; title: string; accent: string; icon: string; group: string };
type T = { slug: string; title: string; href: string; section: string };

export default function Sidebar({ sections, topics }: { sections: S[]; topics: T[] }) {
  const pathname = usePathname();
  const { progress, total, done } = useProgress();
  const [mobileOpen, setMobileOpen] = useState(false);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  useEffect(() => {
    const open = () => setMobileOpen(true);
    window.addEventListener('sd:nav-open', open);
    return () => window.removeEventListener('sd:nav-open', open);
  }, []);

  useEffect(() => setMobileOpen(false), [pathname]);

  const pct = total ? Math.round((done / total) * 100) : 0;

  const body = (
    <>
      <div
        className="mb-4 rounded-xl border p-3.5"
        style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
      >
        <div className="mb-2 flex items-center justify-between">
          <span
            className="text-[10.5px] font-bold uppercase tracking-wider"
            style={{ color: 'var(--text-dim)' }}
          >
            Progress
          </span>
          <span className="font-mono text-[12px] font-semibold" style={{ color: 'var(--text)' }}>
            {done}/{total}
          </span>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full" style={{ background: 'var(--bg-inset)' }}>
          <motion.div
            className="h-full rounded-full"
            style={{ background: 'linear-gradient(90deg,#38bdf8,#a78bfa)' }}
            initial={{ width: 0 }}
            animate={{ width: `${pct}%` }}
            transition={{ type: 'spring', stiffness: 120, damping: 22 }}
          />
        </div>
      </div>

      {sections.map((s, i) => {
        const items = topics.filter((t) => t.section === s.slug);
        const isCollapsed = collapsed[s.slug] && !items.some((t) => t.href === pathname);
        const secDone = items.filter((t) => progress[t.slug]?.completed).length;
        // Eleven sections is a lot to scan; group headers give the eye anchors.
        const startsGroup = i === 0 || sections[i - 1].group !== s.group;

        return (
          <div key={s.slug} className="mb-1">
            {startsGroup && (
              <div
                className="mt-4 mb-1.5 px-2 text-[10px] font-bold uppercase tracking-[0.14em] first:mt-0"
                style={{ color: 'var(--text-dim)' }}
              >
                {s.group}
              </div>
            )}
            <button
              onClick={() => setCollapsed((c) => ({ ...c, [s.slug]: !c[s.slug] }))}
              className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left transition-colors hover:bg-[var(--bg-inset)]"
            >
              <motion.span animate={{ rotate: isCollapsed ? 0 : 90 }} transition={{ duration: 0.18 }}>
                <IconChevron size={11} />
              </motion.span>
              <span style={{ color: s.accent }}>
                <SectionIcon name={s.icon} size={14} />
              </span>
              <span className="text-[12.5px] font-bold" style={{ color: 'var(--text)' }}>
                {s.title}
              </span>
              <span
                className="ml-auto font-mono text-[10.5px]"
                style={{ color: 'var(--text-dim)' }}
              >
                {secDone}/{items.length}
              </span>
            </button>

            <AnimatePresence initial={false}>
              {!isCollapsed && (
                <motion.ul
                  initial={{ height: 0, opacity: 0 }}
                  animate={{ height: 'auto', opacity: 1 }}
                  exit={{ height: 0, opacity: 0 }}
                  transition={{ duration: 0.2, ease: [0.2, 0, 0, 1] }}
                  className="ml-[13px] overflow-hidden border-l pl-2.5"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {items.map((t) => {
                    const active = pathname === t.href;
                    const isDone = progress[t.slug]?.completed;
                    return (
                      <li key={t.slug}>
                        <Link
                          href={t.href}
                          className="flex items-center gap-2 rounded-lg px-2 py-[5px] text-[13px] leading-snug transition-colors"
                          style={{
                            background: active ? 'color-mix(in srgb, var(--accent) 11%, transparent)' : undefined,
                            color: active
                              ? 'var(--accent-text)'
                              : isDone
                                ? 'var(--text-dim)'
                                : 'var(--text-soft)',
                            fontWeight: active ? 600 : 400,
                          }}
                        >
                          <span
                            className="h-1.5 w-1.5 shrink-0 rounded-full border transition-colors"
                            style={{
                              background: isDone ? '#4ade80' : 'transparent',
                              borderColor: isDone ? '#4ade80' : 'var(--border-strong)',
                            }}
                          />
                          <span className="truncate">{t.title}</span>
                        </Link>
                      </li>
                    );
                  })}
                </motion.ul>
              )}
            </AnimatePresence>
          </div>
        );
      })}
    </>
  );

  return (
    <>
      <aside
        data-chrome="sidebar"
        className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[290px] shrink-0 overflow-y-auto border-r px-3 py-5 lg:block"
        style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)' }}
      >
        {body}
      </aside>

      <AnimatePresence>
        {mobileOpen && (
          <>
            <motion.div
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="fixed inset-0 z-[70] lg:hidden"
              style={{ background: 'rgba(4,7,12,.6)' }}
              onClick={() => setMobileOpen(false)}
            />
            <motion.aside
              initial={{ x: '-100%' }}
              animate={{ x: 0 }}
              exit={{ x: '-100%' }}
              transition={{ type: 'spring', stiffness: 380, damping: 38 }}
              className="fixed inset-y-0 left-0 z-[71] w-[85vw] max-w-[320px] overflow-y-auto border-r px-3 py-5 lg:hidden"
              style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)' }}
            >
              <button
                onClick={() => setMobileOpen(false)}
                className="mb-3 ml-auto grid h-8 w-8 place-items-center rounded-lg border"
                style={{ borderColor: 'var(--border)', color: 'var(--text-soft)' }}
                aria-label="Close navigation"
              >
                <IconX size={15} />
              </button>
              {body}
            </motion.aside>
          </>
        )}
      </AnimatePresence>
    </>
  );
}
