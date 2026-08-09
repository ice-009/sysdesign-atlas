'use client';

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { useSession } from 'next-auth/react';

export type ProgressRow = { completed: boolean; confidence: number };
type Map_ = Record<string, ProgressRow>;

type Ctx = {
  progress: Map_;
  bookmarks: Set<string>;
  total: number;
  done: number;
  ready: boolean;
  setCompleted: (slug: string, section: string, completed: boolean) => void;
  setConfidence: (slug: string, section: string, confidence: number) => void;
  toggleBookmark: (slug: string, section: string, title: string) => void;
};

const ProgressCtx = createContext<Ctx | null>(null);

const LS_KEY = 'sd.progress.guest';

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
        setBookmarks(new Set(b.bookmarks ?? []));
      } else if (status === 'unauthenticated') {
        try {
          setProgress(JSON.parse(localStorage.getItem(LS_KEY) ?? '{}'));
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
        const base: ProgressRow = prev[slug] ?? { completed: false, confidence: 0 };
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

  const value = useMemo<Ctx>(
    () => ({
      progress,
      bookmarks,
      total,
      done: Object.values(progress).filter((p) => p.completed).length,
      ready,
      setCompleted: (slug, section, completed) => push(slug, section, { completed }),
      setConfidence: (slug, section, confidence) => push(slug, section, { confidence }),
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
    [progress, bookmarks, total, ready, push, signedIn]
  );

  return <ProgressCtx.Provider value={value}>{children}</ProgressCtx.Provider>;
}

export function useProgress() {
  const ctx = useContext(ProgressCtx);
  if (!ctx) throw new Error('useProgress must be used inside <ProgressProvider>');
  return ctx;
}
