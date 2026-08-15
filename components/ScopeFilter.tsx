'use client';

import { useEffect, useState } from 'react';
import { SCOPE_META, type Scope } from '@/lib/scope';

/* Filters the whole curriculum index by design altitude.

   It writes the choice onto <body> and lets CSS hide the cards that don't
   match, rather than lifting every section's list into client state — the
   index is a server component rendering thirteen grids, and this keeps it
   that way. Topics marked Both survive either filter, because they belong to
   both. Sections left with nothing hide themselves. */
export default function ScopeFilter() {
  const [active, setActive] = useState<Scope | null>(null);

  useEffect(() => {
    if (active) document.body.dataset.scopeFilter = active;
    else delete document.body.dataset.scopeFilter;
    return () => {
      delete document.body.dataset.scopeFilter;
    };
  }, [active]);

  const options: (Scope | null)[] = [null, 'HLD', 'LLD', 'Core'];

  return (
    <div className="mt-6 flex flex-wrap items-center gap-1.5">
      <span
        className="mr-1 text-[11px] font-bold uppercase tracking-[0.16em]"
        style={{ color: 'var(--text-dim)' }}
      >
        Show
      </span>
      {options.map((s) => {
        const on = active === s;
        const meta = s ? SCOPE_META[s] : null;
        const color = meta?.color ?? 'var(--text-soft)';
        return (
          <button
            key={s ?? 'all'}
            onClick={() => setActive(s)}
            aria-pressed={on}
            title={meta?.blurb ?? 'Every topic'}
            className="rounded-full border px-3 py-1.5 text-[12px] font-semibold transition-colors"
            style={{
              borderColor: on ? `color-mix(in srgb, ${color} 55%, transparent)` : 'var(--border)',
              background: on ? `color-mix(in srgb, ${color} 14%, transparent)` : 'transparent',
              color: on ? color : 'var(--text-dim)',
            }}
          >
            {meta?.label ?? 'Everything'}
          </button>
        );
      })}
      {active && (
        <span className="ml-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          {SCOPE_META[active].blurb}
        </span>
      )}
    </div>
  );
}
