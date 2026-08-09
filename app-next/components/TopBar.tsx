'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { useSession } from 'next-auth/react';
import { motion } from 'motion/react';
import { IconSearch, IconSun, IconMoon, IconMenu } from './Icons';
import UserMenu from './UserMenu';

function useTheme() {
  const [dark, setDark] = useState(true);
  useEffect(() => setDark(document.documentElement.classList.contains('dark')), []);
  const toggle = () => {
    const next = !dark;
    setDark(next);
    document.documentElement.classList.toggle('dark', next);
    try {
      localStorage.setItem('sd.theme', next ? 'dark' : 'light');
    } catch {}
  };
  return { dark, toggle };
}

export default function TopBar() {
  const { dark, toggle } = useTheme();
  const { data: session } = useSession();
  const pathname = usePathname();

  const openSearch = () =>
    window.dispatchEvent(new CustomEvent('sd:search-open'));
  const openNav = () => window.dispatchEvent(new CustomEvent('sd:nav-open'));

  const isAdmin = (session?.user as { role?: string } | undefined)?.role === 'ADMIN';

  const links = [
    { href: '/learn', label: 'Learn' },
    { href: '/path', label: 'Path' },
    { href: '/dashboard', label: 'Dashboard' },
    { href: '/practice', label: 'Drills' },
    { href: '/pricing', label: 'Pricing' },
    ...(isAdmin ? [{ href: '/admin', label: 'Admin' }] : []),
  ];

  return (
    <header data-chrome="topbar" className="sticky top-0 z-50 glass border-b" style={{ borderColor: 'var(--border)' }}>
      <div className="mx-auto flex h-14 max-w-[1600px] items-center gap-3 px-4">
        <button
          onClick={openNav}
          className="grid h-9 w-9 place-items-center rounded-lg border lg:hidden"
          style={{ borderColor: 'var(--border)', color: 'var(--text-soft)' }}
          aria-label="Open navigation"
        >
          <IconMenu size={17} />
        </button>

        <Link href="/" className="group flex items-center gap-2.5">
          <motion.span
            whileHover={{ rotate: 8, scale: 1.06 }}
            transition={{ type: 'spring', stiffness: 400, damping: 18 }}
            className="grid h-8 w-8 place-items-center rounded-[9px] text-[#071018]"
            style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
          >
            <svg width="17" height="17" viewBox="0 0 100 100" fill="none">
              <path
                d="M28 62 L50 30 L72 62"
                stroke="currentColor"
                strokeWidth="10"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </motion.span>
          <span className="text-[15px] font-bold tracking-tight" style={{ color: 'var(--text)' }}>
            SysDesign<span style={{ color: 'var(--accent)' }}>Atlas</span>
          </span>
        </Link>

        <nav className="ml-4 hidden items-center gap-1 md:flex">
          {links.map((l) => {
            const active = pathname.startsWith(l.href);
            return (
              <Link
                key={l.href}
                href={l.href}
                className="relative rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors"
                style={{ color: active ? 'var(--text)' : 'var(--text-dim)' }}
              >
                {active && (
                  <motion.span
                    layoutId="nav-pill"
                    className="absolute inset-0 rounded-lg"
                    style={{ background: 'var(--bg-inset)' }}
                    transition={{ type: 'spring', stiffness: 380, damping: 30 }}
                  />
                )}
                <span className="relative">{l.label}</span>
              </Link>
            );
          })}
        </nav>

        <div className="flex-1" />

        <button
          onClick={openSearch}
          className="flex h-9 items-center gap-2 rounded-lg border px-2.5 text-[13px] transition-colors sm:min-w-[220px] sm:px-3"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--bg-soft)',
            color: 'var(--text-dim)',
          }}
        >
          <IconSearch size={15} />
          <span className="hidden sm:inline">Search topics</span>
          <kbd
            className="ml-auto hidden rounded border px-1.5 py-0.5 font-mono text-[10px] sm:inline"
            style={{ borderColor: 'var(--border-strong)' }}
          >
            ⌘K
          </kbd>
        </button>

        <button
          onClick={toggle}
          className="grid h-9 w-9 place-items-center rounded-lg border transition-colors"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--bg-soft)',
            color: 'var(--text-soft)',
          }}
          aria-label="Toggle theme"
        >
          <motion.span key={dark ? 'd' : 'l'} initial={{ rotate: -90, opacity: 0 }} animate={{ rotate: 0, opacity: 1 }}>
            {dark ? <IconSun size={16} /> : <IconMoon size={16} />}
          </motion.span>
        </button>

        <UserMenu />
      </div>
    </header>
  );
}
