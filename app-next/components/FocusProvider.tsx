'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';

export type TextSize = 's' | 'm' | 'l' | 'xl';
export type Leading = 'tight' | 'normal' | 'loose';
export type ColumnWidth = 'narrow' | 'normal' | 'wide';

export type FocusSettings = {
  focus: boolean; // hide nav chrome, widen the column
  guide: boolean; // cursor-following reading line
  dim: boolean; // spotlight the paragraph you're reading
  timer: boolean; // study session timer visible

  // Reading comfort. These are preferences, not modes — "turn everything off"
  // leaves them alone, because someone who needs larger text still needs it
  // after they exit focus mode.
  size: TextSize;
  leading: Leading;
  width: ColumnWidth;
  serif: boolean;
};

/** The settings that behave as on/off modes. */
type ModeKey = {
  [K in keyof FocusSettings]: FocusSettings[K] extends boolean ? K : never;
}[keyof FocusSettings];

type Ctx = FocusSettings & {
  toggle: (k: ModeKey) => void;
  set: <K extends keyof FocusSettings>(k: K, v: FocusSettings[K]) => void;
  exitAll: () => void;
};

const FocusCtx = createContext<Ctx | null>(null);
const LS = 'sd.focus';

const DEFAULTS: FocusSettings = {
  focus: false,
  guide: false,
  dim: false,
  timer: false,
  size: 'm',
  leading: 'normal',
  width: 'normal',
  serif: false,
};

/* The default values are chosen so that an unstyled first paint — before this
   provider mounts and writes its attributes — already matches 'm' / 'normal' /
   'normal'. No flash of differently-sized text. */
export function FocusProvider({ children }: { children: React.ReactNode }) {
  const [s, setS] = useState<FocusSettings>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(LS);
      if (raw) setS({ ...DEFAULTS, ...JSON.parse(raw) });
    } catch {}
  }, []);

  // Drive everything from body classes and data attributes so plain CSS can do
  // the heavy lifting.
  useEffect(() => {
    const b = document.body;
    b.classList.toggle('focus-mode', s.focus);
    b.classList.toggle('dim-mode', s.dim);
    b.classList.toggle('guide-mode', s.guide);
    b.dataset.size = s.size;
    b.dataset.leading = s.leading;
    b.dataset.width = s.width;
    b.toggleAttribute('data-serif', s.serif);
    try {
      localStorage.setItem(LS, JSON.stringify(s));
    } catch {}
  }, [s]);

  const set = useCallback(
    <K extends keyof FocusSettings>(k: K, v: FocusSettings[K]) =>
      setS((p) => ({ ...p, [k]: v })),
    []
  );
  const toggle = useCallback((k: ModeKey) => setS((p) => ({ ...p, [k]: !p[k] })), []);

  // Only the modes switch off — reading preferences survive.
  const exitAll = useCallback(
    () => setS((p) => ({ ...p, focus: false, guide: false, dim: false, timer: false })),
    []
  );

  // Keyboard shortcuts, ignored while typing so notes aren't hijacked.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing =
        !!el && (/^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName) || el.isContentEditable);
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      const k = e.key.toLowerCase();
      if (k === 'f') {
        e.preventDefault();
        toggle('focus');
      } else if (k === 'g') {
        e.preventDefault();
        toggle('guide');
      } else if (k === 'd') {
        e.preventDefault();
        toggle('dim');
      } else if (e.key === 'Escape') {
        setS((p) => (p.focus || p.guide || p.dim ? { ...p, focus: false, guide: false, dim: false } : p));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggle]);

  const value = useMemo<Ctx>(() => ({ ...s, toggle, set, exitAll }), [s, toggle, set, exitAll]);
  return <FocusCtx.Provider value={value}>{children}</FocusCtx.Provider>;
}

export function useFocus() {
  const c = useContext(FocusCtx);
  if (!c) throw new Error('useFocus must be used inside <FocusProvider>');
  return c;
}
