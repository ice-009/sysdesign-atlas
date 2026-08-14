'use client';

import Link from 'next/link';
import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { signIn } from 'next-auth/react';
import { motion } from 'motion/react';
import { signUpAction } from '@/app/actions/auth';
import { IconArrow } from './Icons';

const field =
  'w-full rounded-xl border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]';

export default function AuthForm({
  mode,
  oauth,
}: {
  mode: 'signin' | 'signup';
  oauth: string[];
}) {
  const isSignup = mode === 'signup';
  const router = useRouter();
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    setError(null);
    setPending(true);

    const form = new FormData(e.currentTarget);
    const email = String(form.get('email') ?? '').trim().toLowerCase();
    const password = String(form.get('password') ?? '');

    // Signup creates the account server-side first, then falls through
    // to the same client-side sign-in path.
    if (isSignup) {
      const res = await signUpAction({}, form);
      if (res.error) {
        setError(res.error);
        setPending(false);
        return;
      }
    }

    // redirect:false keeps us on the client so SessionProvider receives the
    // new session immediately — this is what makes the header update.
    const res = await signIn('credentials', { email, password, redirect: false });

    if (!res || res.error) {
      setError(isSignup ? 'Account created, but sign-in failed. Try signing in.' : 'Incorrect email or password.');
      setPending(false);
      return;
    }

    router.push('/learn');
    router.refresh(); // re-render server components with the new session
  }

  return (
    <main className="mx-auto flex min-h-[calc(100vh-3.5rem)] max-w-[1400px] items-center justify-center px-5 py-12">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.45, ease: [0.2, 0, 0, 1] }}
        className="w-full max-w-[420px]"
      >
        <div
          className="rounded-2xl border p-8"
          style={{
            borderColor: 'var(--border)',
            background: 'var(--panel)',
            boxShadow: 'var(--shadow-lg)',
          }}
        >
          <h1 className="text-[26px] font-extrabold tracking-tight" style={{ color: 'var(--text)' }}>
            {isSignup ? 'Create your account' : 'Welcome back'}
          </h1>
          <p className="mt-2 text-[14.5px]" style={{ color: 'var(--text-soft)' }}>
            {isSignup
              ? 'Track progress, rate confidence, and keep notes across all 81 topics. Free — there is no paid tier for the curriculum.'
              : 'Pick up exactly where you left off.'}
          </p>

          {oauth.length > 0 && (
            <>
              <div className="mt-6 grid gap-2">
                {oauth.map((p) => (
                  <button
                    key={p}
                    type="button"
                    onClick={() => signIn(p, { callbackUrl: '/learn' })}
                    className="w-full rounded-xl border px-4 py-2.5 text-[14.5px] font-semibold capitalize transition-colors hover:border-[var(--accent)]"
                    style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}
                  >
                    Continue with {p}
                  </button>
                ))}
              </div>
              <div className="my-5 flex items-center gap-3">
                <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
                <span className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  or
                </span>
                <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
              </div>
            </>
          )}

          <form onSubmit={onSubmit} className={oauth.length ? 'grid gap-3' : 'mt-6 grid gap-3'}>
            {isSignup && (
              <label className="grid gap-1.5">
                <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-soft)' }}>
                  Name
                </span>
                <input
                  name="name"
                  autoComplete="name"
                  placeholder="Armaan Shukla"
                  className={field}
                  style={{
                    borderColor: 'var(--border-strong)',
                    background: 'var(--bg-soft)',
                    color: 'var(--text)',
                  }}
                />
              </label>
            )}

            <label className="grid gap-1.5">
              <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-soft)' }}>
                {isSignup ? 'Email' : 'Email or username'}
              </span>
              <input
                name="email"
                // Sign-in accepts a bare username (e.g. the seeded "admin"),
                // so it can't use type="email" — that would fail validation.
                type={isSignup ? 'email' : 'text'}
                required
                autoComplete={isSignup ? 'email' : 'username'}
                placeholder={isSignup ? 'you@example.com' : 'you@example.com or admin'}
                className={field}
                style={{
                  borderColor: 'var(--border-strong)',
                  background: 'var(--bg-soft)',
                  color: 'var(--text)',
                }}
              />
            </label>

            <label className="grid gap-1.5">
              <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-soft)' }}>
                Password
              </span>
              <input
                name="password"
                type="password"
                required
                minLength={8}
                autoComplete={isSignup ? 'new-password' : 'current-password'}
                placeholder={isSignup ? 'At least 8 characters' : '••••••••'}
                className={field}
                style={{
                  borderColor: 'var(--border-strong)',
                  background: 'var(--bg-soft)',
                  color: 'var(--text)',
                }}
              />
            </label>

            {error && (
              <motion.p
                initial={{ opacity: 0, y: -4 }}
                animate={{ opacity: 1, y: 0 }}
                className="rounded-lg px-3 py-2 text-[13px]"
                style={{ background: 'rgba(244,63,94,.1)', color: '#f43f5e' }}
              >
                {error}
              </motion.p>
            )}

            <button
              type="submit"
              disabled={pending}
              className="mt-2 flex w-full items-center justify-center gap-2 rounded-xl px-5 py-3 text-[15px] font-bold text-[#071018] transition-all disabled:opacity-60"
              style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
            >
              {pending ? 'Just a moment…' : isSignup ? 'Create account' : 'Sign in'}
              {!pending && <IconArrow size={16} />}
            </button>
          </form>

          <p className="mt-6 text-center text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
            {isSignup ? 'Already have an account? ' : 'No account yet? '}
            <Link
              href={isSignup ? '/signin' : '/signup'}
              className="font-semibold"
              style={{ color: 'var(--accent-text)' }}
            >
              {isSignup ? 'Sign in' : 'Create one free'}
            </Link>
          </p>
        </div>

        <p className="mt-5 text-center text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
          Your data stays in your own local database. Nothing is sent anywhere.
        </p>
      </motion.div>
    </main>
  );
}
