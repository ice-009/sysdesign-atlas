'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';

export type ProgressRow = { completed: boolean; confidence: number; timeSpent: number };
type Map_ = Record<string, ProgressRow>;

/** Logged time vs. reading estimate, across every topic you have timed. */
export type Pace = {
  topics: number;
  seconds: number;
  estimateSeconds: number;
  ratio: number | null;
};

type Ctx = {
  progress: Map_;
  bookmarks: Set<string>;
  pace: Pace | null;
  total: number;
  done: number;
  ready: boolean;
  setCompleted: (slug: string, section: string, completed: boolean) => void;
  setConfidence: (slug: string, section: string, confidence: number) => void;
  addTime: (slug: string, section: string, seconds: number) => void;
  toggleBookmark: (slug: string, section: string, title: string) => void;
};

const ProgressCtx = createContext<Ctx | null>(null);

const LS_KEY = 'sd.progress.guest';

const EMPTY_ROW: ProgressRow = { completed: false, confidence: 0, timeSpent: 0 };

export function ProgressProvider({
  total,
  children,
}: {
  total: number;
  children: React.ReactNode;
}) {
  const { status } = useSession();
  const signedIn = status === 'authenticated';

  const [progress, setProgress] = useState<Map_>({});
  const [bookmarks, setBookmarks] = useState<Set<string>>(new Set());
  const [pace, setPace] = useState<Pace | null>(null);
  const [ready, setReady] = useState(false);

  // Signed in → server is the source of truth. Signed out → localStorage,
  // so the app still works before someone creates an account.
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (signedIn) {
        const [p, b] = await Promise.all([
          fetch('/api/progress').then((r) => r.json()).catch(() => ({ progress: {} })),
          fetch('/api/bookmarks').then((r) => r.json()).catch(() => ({ bookmarks: [] })),
        ]);
        if (cancelled) return;
        setProgress(p.progress ?? {});
        setPace(p.pace ?? null);
        setBookmarks(new Set(b.bookmarks ?? []));
      } else if (status === 'unauthenticated') {
        try {
          const saved: Record<string, Partial<ProgressRow>> = JSON.parse(
            localStorage.getItem(LS_KEY) ?? '{}'
          );
          const rows: Map_ = {};
          // Rows written before the topic timer existed have no timeSpent.
          for (const [slug, r] of Object.entries(saved)) rows[slug] = { ...EMPTY_ROW, ...r };
          setProgress(rows);
        } catch {
          setProgress({});
        }
      }
      if (!cancelled && status !== 'loading') setReady(true);
    }
    load();
    return () => {
      cancelled = true;
    };
  }, [signedIn, status]);

  const persistGuest = useCallback((next: Map_) => {
    try {
      localStorage.setItem(LS_KEY, JSON.stringify(next));
    } catch {}
  }, []);

  const push = useCallback(
    (slug: string, section: string, patch: Partial<ProgressRow>) => {
      setProgress((prev) => {
        const base: ProgressRow = prev[slug] ?? EMPTY_ROW;
        const next = { ...prev, [slug]: { ...base, ...patch } };
        if (!signedIn) persistGuest(next);
        return next;
      });
      if (signedIn) {
        // Optimistic — the UI already moved. A failure just means it retries next visit.
        fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, section, ...patch }),
        }).catch(() => {});
      }
    },
    [signedIn, persistGuest]
  );

  /* Time is the one field the client can't just overwrite: two tabs on the same
     topic would clobber each other. The client sends a delta and the server
     increments, so it stays additive either way. */
  const addTime = useCallback(
    (slug: string, section: string, seconds: number) => {
      if (seconds <= 0) return;
      setProgress((prev) => {
        const base: ProgressRow = prev[slug] ?? EMPTY_ROW;
        const next = { ...prev, [slug]: { ...base, timeSpent: base.timeSpent + seconds } };
        if (!signedIn) persistGuest(next);
        return next;
      });
      if (signedIn) {
        fetch('/api/progress', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ slug, section, seconds }),
        })
          .then((r) => r.json())
          .then((d) => {
            if (d?.pace) setPace(d.pace);
          })
          .catch(() => {});
      }
    },
    [signedIn, persistGuest]
  );

  const value = useMemo<Ctx>(
    () => ({
      progress,
      bookmarks,
      pace,
      total,
      done: Object.values(progress).filter((p) => p.completed).length,
      ready,
      setCompleted: (slug, section, completed) => push(slug, section, { completed }),
      setConfidence: (slug, section, confidence) => push(slug, section, { confidence }),
      addTime,
      toggleBookmark: (slug, section, title) => {
        setBookmarks((prev) => {
          const next = new Set(prev);
          next.has(slug) ? next.delete(slug) : next.add(slug);
          return next;
        });
        if (signedIn) {
          fetch('/api/bookmarks', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ slug, section, title }),
          }).catch(() => {});
        }
      },
    }),
    [progress, bookmarks, pace, total, ready, push, addTime, signedIn]
  );

  return <ProgressCtx.Provider value={value}>{children}</ProgressCtx.Provider>;
}

export function useProgress() {
  const ctx = useContext(ProgressCtx);
  if (!ctx) throw new Error('useProgress must be used inside <ProgressProvider>');
  return ctx;
}
