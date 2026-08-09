'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { AnimatePresence, motion } from 'motion/react';
import { IconSearch } from './Icons';

export type IndexRow = {
  t: string;
  s: string;
  u: string;
  sec: string;
  acc: string;
  d: string;
  g: string;
};

function score(row: IndexRow, q: string): number {
  const t = row.t.toLowerCase();
  const s = row.s.toLowerCase();
  const g = row.g.toLowerCase();
  let total = 0;
  for (const w of q.split(/\s+/).filter(Boolean)) {
    if (t === w) total += 120;
    else if (t.startsWith(w)) total += 80;
    else if (t.includes(w)) total += 55;
    else if (g.includes(w)) total += 26;
    else if (s.includes(w)) total += 18;
    else return 0;
  }
  return total;
}

export default function SearchPalette({ index }: { index: IndexRow[] }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [sel, setSel] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const hits = useMemo(() => {
    const query = q.trim().toLowerCase();
    if (!query) return index.slice(0, 8);
    return index
      .map((r) => ({ r, sc: score(r, query) }))
      .filter((x) => x.sc > 0)
      .sort((a, b) => b.sc - a.sc)
      .slice(0, 20)
      .map((x) => x.r);
  }, [q, index]);

  useEffect(() => setSel(0), [q]);

  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('sd:search-open', onOpen);

    const onKey = (e: KeyboardEvent) => {
      const typing = /^(INPUT|TEXTAREA)$/.test((e.target as HTMLElement)?.tagName ?? '');
      if ((e.key === 'k' && (e.metaKey || e.ctrlKey)) || (e.key === '/' && !typing)) {
        e.preventDefault();
        setOpen(true);
      }
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('sd:search-open', onOpen);
      window.removeEventListener('keydown', onKey);
    };
  }, []);

  useEffect(() => {
    if (open) {
      setQ('');
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  const go = (u: string) => {
    setOpen(false);
    router.push(u);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => (s + 1) % Math.max(hits.length, 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => (s - 1 + hits.length) % Math.max(hits.length, 1));
    } else if (e.key === 'Enter' && hits[sel]) {
      e.preventDefault();
      go(hits[sel].u);
    }
  };

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          className="fixed inset-0 z-[100] px-4 pt-[12vh]"
          style={{ background: 'rgba(4,7,12,.62)', backdropFilter: 'blur(3px)' }}
          onClick={(e) => e.target === e.currentTarget && setOpen(false)}
        >
          <motion.div
            initial={{ opacity: 0, scale: 0.97, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.98, y: -4 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            className="mx-auto max-w-[620px] overflow-hidden rounded-2xl border"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--panel)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div
              className="flex items-center gap-3 border-b px-4"
              style={{ borderColor: 'var(--border)' }}
            >
              <IconSearch size={17} className="shrink-0" />
              <input
                ref={inputRef}
                value={q}
                onChange={(e) => setQ(e.target.value)}
                onKeyDown={onKeyDown}
                placeholder="Search 66 topics — try “sharding”, “raft”, “uber”…"
                className="w-full bg-transparent py-4 text-[16px] outline-none"
                style={{ color: 'var(--text)' }}
                spellCheck={false}
              />
            </div>

            <div className="max-h-[56vh] overflow-y-auto p-1.5">
              {hits.length === 0 ? (
                <div className="px-4 py-10 text-center text-[14px]" style={{ color: 'var(--text-dim)' }}>
                  No topics match “{q}”
                </div>
              ) : (
                hits.map((h, i) => (
                  <button
                    key={h.u}
                    onClick={() => go(h.u)}
                    onMouseEnter={() => setSel(i)}
                    className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left transition-colors"
                    style={{ background: i === sel ? 'var(--bg-inset)' : 'transparent' }}
                  >
                    <span
                      className="h-7 w-1 shrink-0 rounded-full"
                      style={{ background: h.acc }}
                    />
                    <span className="min-w-0 flex-1">
                      <span
                        className="block truncate text-[14.5px] font-semibold"
                        style={{ color: 'var(--text)' }}
                      >
                        {h.t}
                      </span>
                      <span
                        className="block truncate text-[12px]"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {h.sec}
                        {h.s ? ` · ${h.s}` : ''}
                      </span>
                    </span>
                    {h.d && (
                      <span
                        className="shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-semibold"
                        style={{ background: 'var(--bg-inset)', color: 'var(--text-dim)' }}
                      >
                        {h.d}
                      </span>
                    )}
                  </button>
                ))
              )}
            </div>

            <div
              className="flex gap-4 border-t px-4 py-2 text-[11px]"
              style={{ borderColor: 'var(--border)', color: 'var(--text-dim)' }}
            >
              <span>↑↓ navigate</span>
              <span>↵ open</span>
              <span>esc close</span>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
