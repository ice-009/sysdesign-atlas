'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useSession } from 'next-auth/react';

export type Phase = 'idle' | 'study' | 'break';

export const STUDY_MIN = 25;
export const BREAK_MIN = 5;

type Ctx = {
  phase: Phase;
  /** Seconds remaining in the current phase. */
  left: number;
  paused: boolean;
  /** True when the pause was automatic — you switched tab or app. */
  awayPaused: boolean;
  todayMin: number | null;
  /** A session is running or paused mid-way, as opposed to not started. */
  active: boolean;
  mmss: string;
  /** Progress through the current phase, 0–100. */
  pct: number;
  accent: string;
  start: () => void;
  stop: () => void;
  togglePause: () => void;
};

const TimerCtx = createContext<Ctx | null>(null);

/* Owns the study session so it outlives the panel it's controlled from.
   Closing the Focus panel unmounts the controls, not the clock.

   It only counts time you were actually here: leaving the tab, or switching to
   another application, pauses it and coming back resumes it. The minutes
   written to your activity heatmap are honest rather than "how long the tab was
   left open", and unlike a stop, a pause keeps the time you'd already put in. */
export function StudyTimerProvider({ children }: { children: React.ReactNode }) {
  const { status } = useSession();
  const [phase, setPhase] = useState<Phase>('idle');
  const [left, setLeft] = useState(STUDY_MIN * 60);
  const [paused, setPaused] = useState(false);
  const [awayPaused, setAwayPaused] = useState(false);
  const [todayMin, setTodayMin] = useState<number | null>(null);

  const accrued = useRef(0); // seconds studied but not yet flushed to the server

  // Mirrors for the window listeners, which are registered once and so can't
  // close over the current state.
  const phaseRef = useRef(phase);
  const pausedRef = useRef(paused);
  const awayRef = useRef(awayPaused);
  phaseRef.current = phase;
  pausedRef.current = paused;
  awayRef.current = awayPaused;

  const flush = useCallback(async () => {
    const mins = Math.floor(accrued.current / 60);
    if (mins < 1 || status !== 'authenticated') return;
    accrued.current -= mins * 60;
    try {
      const r = await fetch('/api/activity', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ minutes: mins }),
      });
      const d = await r.json();
      if (typeof d.minutes === 'number') setTodayMin(d.minutes);
    } catch {
      accrued.current += mins * 60; // put it back; retry on the next flush
    }
  }, [status]);

  useEffect(() => {
    if (status !== 'authenticated') return;
    fetch('/api/activity')
      .then((r) => r.json())
      .then((d) => setTodayMin(d.minutes ?? 0))
      .catch(() => {});
  }, [status]);

  // The clock. Paused sessions keep their remaining time; only the interval stops.
  useEffect(() => {
    if (phase === 'idle' || paused) return;
    const id = setInterval(() => {
      if (phase === 'study') accrued.current += 1;
      setLeft((s) => {
        if (s > 1) return s - 1;
        if (phase === 'study') {
          flush();
          setPhase('break');
          return BREAK_MIN * 60;
        }
        setPhase('study');
        return STUDY_MIN * 60;
      });
    }, 1000);
    return () => clearInterval(id);
  }, [phase, paused, flush]);

  /* Away detection. `visibilitychange` covers switching tab and minimising;
     `blur` covers switching to another application while the tab stays visible.
     Only an automatic pause auto-resumes — a manual one is a decision, and
     coming back to the tab shouldn't quietly undo it. */
  useEffect(() => {
    const leave = () => {
      if (phaseRef.current === 'idle' || pausedRef.current) return;
      flush();
      setPaused(true);
      setAwayPaused(true);
    };
    const arrive = () => {
      if (document.hidden || !document.hasFocus() || !awayRef.current) return;
      setAwayPaused(false);
      setPaused(false);
    };
    const onVis = () => (document.hidden ? leave() : arrive());

    document.addEventListener('visibilitychange', onVis);
    window.addEventListener('blur', leave);
    window.addEventListener('focus', arrive);
    return () => {
      document.removeEventListener('visibilitychange', onVis);
      window.removeEventListener('blur', leave);
      window.removeEventListener('focus', arrive);
    };
  }, [flush]);

  // Flush whatever is pending when leaving the page.
  useEffect(() => {
    const onLeave = () => {
      const mins = Math.floor(accrued.current / 60);
      if (mins >= 1 && status === 'authenticated' && navigator.sendBeacon) {
        navigator.sendBeacon(
          '/api/activity',
          new Blob([JSON.stringify({ minutes: mins })], { type: 'application/json' })
        );
        accrued.current -= mins * 60;
      }
    };
    window.addEventListener('pagehide', onLeave);
    return () => window.removeEventListener('pagehide', onLeave);
  }, [status]);

  const start = useCallback(() => {
    setPaused(false);
    setAwayPaused(false);
    setPhase('study');
    setLeft(STUDY_MIN * 60);
  }, []);

  const stop = useCallback(() => {
    flush();
    setPaused(false);
    setAwayPaused(false);
    setPhase('idle');
    setLeft(STUDY_MIN * 60);
  }, [flush]);

  const togglePause = useCallback(() => {
    if (!pausedRef.current) flush(); // bank the minutes at the moment of pausing
    setPaused(!pausedRef.current);
    setAwayPaused(false);
  }, [flush]);

  const value = useMemo<Ctx>(() => {
    const total = (phase === 'break' ? BREAK_MIN : STUDY_MIN) * 60;
    return {
      phase,
      left,
      paused,
      awayPaused,
      todayMin,
      active: phase !== 'idle',
      mmss: `${String(Math.floor(left / 60)).padStart(2, '0')}:${String(left % 60).padStart(2, '0')}`,
      pct: phase === 'idle' ? 0 : ((total - left) / total) * 100,
      accent: phase === 'break' ? '#4ade80' : paused ? '#fbbf24' : '#38bdf8',
      start,
      stop,
      togglePause,
    };
  }, [phase, left, paused, awayPaused, todayMin, start, stop, togglePause]);

  return <TimerCtx.Provider value={value}>{children}</TimerCtx.Provider>;
}

export function useStudyTimer() {
  const c = useContext(TimerCtx);
  if (!c) throw new Error('useStudyTimer must be used inside <StudyTimerProvider>');
  return c;
}
