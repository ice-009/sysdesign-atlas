'use client';

import { useActionState } from 'react';
import { useFormStatus } from 'react-dom';
import { motion } from 'motion/react';
import { changeOwnPassword } from '@/app/actions/admin';

function Submit() {
  const { pending } = useFormStatus();
  return (
    <button
      type="submit"
      disabled={pending}
      className="mt-1 rounded-xl px-5 py-2.5 text-[14px] font-bold text-[#071018] disabled:opacity-60"
      style={{ background: 'linear-gradient(135deg,#38bdf8,#a78bfa)' }}
    >
      {pending ? 'Updating…' : 'Change password'}
    </button>
  );
}

const field =
  'w-full rounded-xl border px-3.5 py-2.5 text-[15px] outline-none transition-colors focus:border-[var(--accent)]';

export default function PasswordForm({ mustChange }: { mustChange: boolean }) {
  const [state, action] = useActionState(changeOwnPassword, {} as { error?: string; ok?: boolean });

  return (
    <div
      className="mt-5 rounded-2xl border p-6"
      style={{
        borderColor: mustChange
          ? 'color-mix(in srgb,#f43f5e 40%,transparent)'
          : 'var(--border)',
        background: mustChange
          ? 'color-mix(in srgb,#f43f5e 5%,var(--panel))'
          : 'var(--panel)',
      }}
    >
      <h2 className="text-[16px] font-bold" style={{ color: 'var(--text)' }}>
        {mustChange ? 'Change your default password' : 'Change password'}
      </h2>

      {mustChange && (
        <p className="mt-2 text-[13.5px] leading-relaxed" style={{ color: '#f43f5e' }}>
          This account still uses the seeded password. That&rsquo;s fine while everything runs on
          your machine, but set a real one before exposing this to a network or deploying it.
        </p>
      )}

      <form action={action} className="mt-5 grid gap-3">
        <label className="grid gap-1.5">
          <span className="text-[12.5px] font-semibold" style={{ color: 'var(--text-soft)' }}>
            Current password
          </span>
          <input
            name="current"
            type="password"
            required
            autoComplete="current-password"
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
            New password
          </span>
          <input
            name="next"
            type="password"
            required
            minLength={8}
            autoComplete="new-password"
            placeholder="At least 8 characters"
            className={field}
            style={{
              borderColor: 'var(--border-strong)',
              background: 'var(--bg-soft)',
              color: 'var(--text)',
            }}
          />
        </label>

        {state?.error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg px-3 py-2 text-[13px]"
            style={{ background: 'rgba(244,63,94,.1)', color: '#f43f5e' }}
          >
            {state.error}
          </motion.p>
        )}
        {state?.ok && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            className="rounded-lg px-3 py-2 text-[13px]"
            style={{ background: 'rgba(74,222,128,.1)', color: '#4ade80' }}
          >
            Password updated.
          </motion.p>
        )}

        <Submit />
      </form>
    </div>
  );
}
