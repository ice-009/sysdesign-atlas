'use client';

import Link from 'next/link';
import { useEffect, useRef, useState } from 'react';
import { signOut, useSession } from 'next-auth/react';
import { AnimatePresence, motion } from 'motion/react';
import { IconLogout, IconChevron, IconTarget, IconBookmark, IconSpark } from './Icons';

function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  return ((parts[0][0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function greeting() {
  const h = new Date().getHours();
  if (h < 12) return 'Good morning';
  if (h < 18) return 'Good afternoon';
  return 'Good evening';
}

export default function UserMenu() {
  const { data: session, status } = useSession();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onClick = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', onClick);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onClick);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  if (status === 'loading') {
    return (
      <div
        className="h-9 w-[120px] animate-pulse rounded-xl"
        style={{ background: 'var(--bg-inset)' }}
      />
    );
  }

  if (!session?.user) {
    return (
      <div className="flex items-center gap-2">
        <Link
          href="/signin"
          className="hidden rounded-lg px-3 py-1.5 text-[13.5px] font-medium transition-colors sm:block"
          style={{ color: 'var(--text-soft)' }}
        >
          Sign in
        </Link>
        <Link
          href="/signup"
          className="rounded-lg px-3.5 py-1.5 text-[13.5px] font-semibold text-[#071018] transition-transform hover:scale-[1.03]"
          style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
        >
          Sign up
        </Link>
      </div>
    );
  }

  const user = session.user as { name?: string | null; email?: string | null; role?: string };
  const name = user.name || user.email?.split('@')[0] || 'there';
  const firstName = name.split(/\s+/)[0];
  const isAdmin = user.role === 'ADMIN';

  const items = [
    { href: '/dashboard', label: 'Dashboard', icon: <IconTarget size={14} /> },
    { href: '/path', label: 'Learning path', icon: <IconSpark size={14} /> },
    { href: '/billing', label: 'Billing & plan', icon: <IconBookmark size={14} /> },
    { href: '/account', label: 'Account settings', icon: null },
  ];

  return (
    <div className="relative" ref={ref}>
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-2.5 rounded-xl border py-1 pl-1 pr-2.5 transition-colors"
        style={{
          borderColor: open ? 'var(--border-strong)' : 'transparent',
          background: open ? 'var(--bg-inset)' : 'transparent',
        }}
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <span
          className="grid h-7 w-7 shrink-0 place-items-center rounded-lg text-[11px] font-bold text-[#071018]"
          style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
        >
          {initials(name)}
        </span>
        <span className="hidden text-left leading-tight sm:block">
          <span className="block text-[9.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
            {greeting()}
          </span>
          <span className="block max-w-[130px] truncate text-[12.5px] font-bold" style={{ color: 'var(--text)' }}>
            {firstName}
          </span>
        </span>
        <motion.span
          animate={{ rotate: open ? 90 : 0 }}
          transition={{ duration: 0.18 }}
          className="hidden sm:block"
          style={{ color: 'var(--text-dim)' }}
        >
          <IconChevron size={11} />
        </motion.span>
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            role="menu"
            initial={{ opacity: 0, y: -6, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 420, damping: 30 }}
            className="absolute right-0 top-[46px] w-[264px] overflow-hidden rounded-2xl border"
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--panel)',
              boxShadow: 'var(--shadow-lg)',
            }}
          >
            <div
              className="flex items-center gap-3 px-4 py-3.5"
              style={{
                background:
                  'radial-gradient(120% 140% at 0% 0%, color-mix(in srgb, var(--accent) 10%, transparent), transparent 65%)',
              }}
            >
              <span
                className="grid h-10 w-10 shrink-0 place-items-center rounded-xl text-[14px] font-bold text-[#071018]"
                style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
              >
                {initials(name)}
              </span>
              <div className="min-w-0">
                <div className="flex items-center gap-1.5">
                  <span className="truncate text-[14px] font-bold" style={{ color: 'var(--text)' }}>
                    {name}
                  </span>
                  {isAdmin && (
                    <span
                      className="shrink-0 rounded px-1.5 py-0.5 text-[9px] font-bold"
                      style={{
                        background: 'color-mix(in srgb,#f43f5e 16%,transparent)',
                        color: '#f43f5e',
                      }}
                    >
                      ADMIN
                    </span>
                  )}
                </div>
                <div className="truncate text-[11.5px]" style={{ color: 'var(--text-dim)' }}>
                  {user.email}
                </div>
              </div>
            </div>

            <div className="h-px" style={{ background: 'var(--border)' }} />

            <nav className="p-1.5">
              {items.map((it) => (
                <Link
                  key={it.href}
                  href={it.href}
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] transition-colors hover:bg-[var(--bg-inset)]"
                  style={{ color: 'var(--text-soft)' }}
                >
                  <span className="w-4 shrink-0" style={{ color: 'var(--text-dim)' }}>
                    {it.icon}
                  </span>
                  {it.label}
                </Link>
              ))}

              {isAdmin && (
                <Link
                  href="/admin"
                  onClick={() => setOpen(false)}
                  className="flex items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13.5px] font-semibold transition-colors hover:bg-[var(--bg-inset)]"
                  style={{ color: '#f43f5e' }}
                >
                  <span className="w-4 shrink-0" />
                  Admin panel
                </Link>
              )}
            </nav>

            <div className="h-px" style={{ background: 'var(--border)' }} />

            <div className="p-1.5">
              <button
                onClick={() => {
                  setOpen(false);
                  signOut({ callbackUrl: '/' });
                }}
                className="flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13.5px] transition-colors hover:bg-[var(--bg-inset)]"
                style={{ color: 'var(--text-soft)' }}
              >
                <span className="w-4 shrink-0" style={{ color: 'var(--text-dim)' }}>
                  <IconLogout size={14} />
                </span>
                Sign out
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
