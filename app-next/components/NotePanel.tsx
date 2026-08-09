'use client';

import { useEffect, useRef, useState } from 'react';
import { useSession } from 'next-auth/react';
import Link from 'next/link';
import { motion } from 'motion/react';
import { IconNote } from './Icons';

export default function NotePanel({ slug, section }: { slug: string; section: string }) {
  const { status } = useSession();
  const [body, setBody] = useState('');
  const [state, setState] = useState<'idle' | 'saving' | 'saved'>('idle');
  const [limitMsg, setLimitMsg] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const loaded = useRef(false);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch(`/api/notes?slug=${encodeURIComponent(slug)}`)
      .then((r) => r.json())
      .then((d) => {
        setBody(d.note ?? '');
        loaded.current = true;
      })
      .catch(() => {
        loaded.current = true;
      });
  }, [slug, status]);

  // Debounced autosave — one write ~700ms after typing stops.
  useEffect(() => {
    if (status !== 'authenticated' || !loaded.current) return;
    if (timer.current) clearTimeout(timer.current);
    setState('saving');
    timer.current = setTimeout(async () => {
      try {
        const res = await fetch('/api/notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, section, body }),
        });
        if (res.status === 402) {
          const d = await res.json();
          setLimitMsg(d.message ?? 'Note limit reached.');
          setState('idle');
          return;
        }
        setLimitMsg(null);
      } catch {
        setState('idle');
        return;
      }
      setState('saved');
      setTimeout(() => setState('idle'), 1600);
    }, 700);
    return () => {
      if (timer.current) clearTimeout(timer.current);
    };
  }, [body, slug, section, status]);

  if (status === 'loading') return null;

  if (status !== 'authenticated') {
    return (
      <div
        className="mt-12 rounded-xl border border-dashed p-5 text-center"
        style={{ borderColor: 'var(--border-strong)' }}
      >
        <IconNote size={20} className="mx-auto mb-2" />
        <p className="text-[14px]" style={{ color: 'var(--text-soft)' }}>
          <Link href="/signup" className="font-semibold" style={{ color: 'var(--accent-text)' }}>
            Create a free account
          </Link>{' '}
          to keep private notes on this topic and sync progress across devices.
        </p>
      </div>
    );
  }

  return (
    <section className="mt-12">
      <div className="mb-2 flex items-center gap-2">
        <IconNote size={15} />
        <h2 className="text-[14px] font-bold" style={{ color: 'var(--text)' }}>
          Your notes
        </h2>
        {state !== 'idle' && (
          <motion.span
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            className="text-[11.5px]"
            style={{ color: state === 'saved' ? '#4ade80' : 'var(--text-dim)' }}
          >
            {state === 'saving' ? 'Saving…' : 'Saved'}
          </motion.span>
        )}
      </div>
      {limitMsg && (
        <div
          className="mb-2 flex flex-wrap items-center gap-2 rounded-lg px-3 py-2 text-[13px]"
          style={{ background: 'color-mix(in srgb,#fbbf24 12%,transparent)', color: '#fbbf24' }}
        >
          {limitMsg}
          <Link href="/pricing" className="font-bold underline">
            See plans
          </Link>
        </div>
      )}
      <textarea
        value={body}
        onChange={(e) => setBody(e.target.value)}
        placeholder="What did your own design miss? Log the gap — that becomes your real curriculum."
        rows={5}
        className="w-full resize-y rounded-xl border p-3.5 font-mono text-[13.5px] leading-relaxed outline-none transition-colors focus:border-[var(--accent)]"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--bg-soft)',
          color: 'var(--text)',
        }}
      />
    </section>
  );
}
