'use client';

import { useEffect, useState } from 'react';
import type { Heading } from '@/lib/markdown';

export default function TableOfContents({ headings }: { headings: Heading[] }) {
  const items = headings.filter((h) => h.level >= 2);
  const [active, setActive] = useState<string>('');

  useEffect(() => {
    if (!items.length) return;
    const onScroll = () => {
      let current = items[0]?.id ?? '';
      for (const h of items) {
        const el = document.getElementById(h.id);
        if (el && el.getBoundingClientRect().top < 150) current = h.id;
      }
      setActive(current);
    };
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, [items]);

  if (!items.length) return null;

  return (
    <aside data-chrome="toc" className="sticky top-14 hidden h-[calc(100vh-3.5rem)] w-[230px] shrink-0 overflow-y-auto py-12 xl:block">
      <div
        className="mb-3 text-[10.5px] font-bold uppercase tracking-wider"
        style={{ color: 'var(--text-dim)' }}
      >
        On this page
      </div>
      <ul className="border-l" style={{ borderColor: 'var(--border)' }}>
        {items.map((h) => {
          const isActive = active === h.id;
          return (
            <li key={h.id}>
              <a
                href={`#${h.id}`}
                className="-ml-px block border-l-2 py-1 pr-2 text-[12.5px] leading-snug transition-colors"
                style={{
                  paddingLeft: h.level === 3 ? '1.4rem' : '0.8rem',
                  borderColor: isActive ? 'var(--accent)' : 'transparent',
                  color: isActive ? 'var(--accent-text)' : 'var(--text-dim)',
                  fontWeight: isActive ? 600 : 400,
                }}
              >
                {h.text}
              </a>
            </li>
          );
        })}
      </ul>
    </aside>
  );
}
