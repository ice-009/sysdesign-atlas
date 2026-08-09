'use client';

import { useState, useTransition } from 'react';
import { motion } from 'motion/react';
import Reveal from './Reveal';
import { formatPrice, type PlanId } from '@/lib/plans';
import {
  setUserRole,
  setUserSuspended,
  setUserPlan,
  deleteUser,
  updateSetting,
} from '@/app/actions/admin';
import { IconTarget, IconSpark, IconX, IconCheck } from './Icons';

type U = {
  id: string;
  email: string;
  name: string;
  role: string;
  suspended: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  plan: string;
  status: string;
  completed: number;
  notes: number;
};

const PLAN_COLOR: Record<string, string> = {
  FREE: '#38bdf8',
  PRO: '#a78bfa',
  TEAM: '#f472b6',
};

const TOGGLES = [
  ['gate_content', 'Paywall the curriculum', 'Require a paid plan to read topics. Off by default — the atlas is free.'],
  ['allow_signups', 'Allow new signups', 'Turn off to close registration.'],
  ['maintenance_mode', 'Maintenance mode', 'Shows a banner to every visitor.'],
] as const;

export default function AdminView({
  users,
  stats,
  settings,
  audit,
}: {
  users: U[];
  stats: {
    totalUsers: number;
    completions: number;
    notes: number;
    activeDays: number;
    revenue: number;
    invoiceCount: number;
    planCounts: Record<string, number>;
  };
  settings: Record<string, string>;
  audit: { id: string; action: string; actor: string; detail: string; at: string }[];
}) {
  const [pending, start] = useTransition();
  const [q, setQ] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  const filtered = users.filter(
    (u) =>
      !q ||
      u.email.toLowerCase().includes(q.toLowerCase()) ||
      u.name.toLowerCase().includes(q.toLowerCase())
  );

  const tiles = [
    { label: 'Users', value: String(stats.totalUsers), color: '#38bdf8' },
    { label: 'Revenue (mock)', value: formatPrice(stats.revenue), color: '#4ade80', sub: `${stats.invoiceCount} invoices` },
    { label: 'Topics completed', value: String(stats.completions), color: '#a78bfa' },
    { label: 'Notes written', value: String(stats.notes), color: '#fbbf24' },
  ];

  return (
    <main className="mx-auto max-w-[1400px] 2xl:max-w-[1640px] px-5 py-10 pb-24">
      <Reveal>
        <div className="flex flex-wrap items-center gap-3">
          <h1
            className="text-[clamp(1.8rem,3.4vw,2.4rem)] font-extrabold tracking-[-0.03em]"
            style={{ color: 'var(--text)' }}
          >
            Admin
          </h1>
          <span
            className="rounded-full px-2.5 py-1 text-[11px] font-bold"
            style={{ background: 'color-mix(in srgb,#f43f5e 15%,transparent)', color: '#f43f5e' }}
          >
            RESTRICTED
          </span>
        </div>
        <p className="mt-2 text-[15.5px]" style={{ color: 'var(--text-soft)' }}>
          Manage users, plans, and platform settings. Every action here is written to the audit log.
        </p>
      </Reveal>

      {/* stats */}
      <div className="mt-8 grid gap-3.5 sm:grid-cols-2 lg:grid-cols-4">
        {tiles.map((t, i) => (
          <Reveal key={t.label} delay={i * 0.04}>
            <div
              className="rounded-2xl border p-5"
              style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
            >
              <div
                className="mb-2 text-[11px] font-bold uppercase tracking-wider"
                style={{ color: 'var(--text-dim)' }}
              >
                {t.label}
              </div>
              <div
                className="font-mono text-[28px] font-bold leading-none"
                style={{ color: t.color }}
              >
                {t.value}
              </div>
              {t.sub && (
                <div className="mt-1.5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
                  {t.sub}
                </div>
              )}
            </div>
          </Reveal>
        ))}
      </div>

      {/* plan split */}
      <Reveal delay={0.08}>
        <div
          className="mt-5 rounded-2xl border p-6"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <h2 className="mb-4 text-[16px] font-bold" style={{ color: 'var(--text)' }}>
            Plan distribution
          </h2>
          <div className="flex h-3 overflow-hidden rounded-full" style={{ background: 'var(--bg-inset)' }}>
            {(['FREE', 'PRO', 'TEAM'] as const).map((p) => {
              const n = stats.planCounts[p] ?? 0;
              const pct = stats.totalUsers ? (n / stats.totalUsers) * 100 : 0;
              return (
                <motion.div
                  key={p}
                  initial={{ width: 0 }}
                  animate={{ width: `${pct}%` }}
                  transition={{ duration: 0.7 }}
                  style={{ background: PLAN_COLOR[p] }}
                />
              );
            })}
          </div>
          <div className="mt-3 flex flex-wrap gap-5">
            {(['FREE', 'PRO', 'TEAM'] as const).map((p) => (
              <div key={p} className="flex items-center gap-2">
                <span className="h-2.5 w-2.5 rounded-full" style={{ background: PLAN_COLOR[p] }} />
                <span className="text-[13px]" style={{ color: 'var(--text-soft)' }}>
                  {p} · <strong style={{ color: 'var(--text)' }}>{stats.planCounts[p] ?? 0}</strong>
                </span>
              </div>
            ))}
          </div>
        </div>
      </Reveal>

      {/* settings */}
      <Reveal delay={0.1}>
        <div
          className="mt-5 rounded-2xl border p-6"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <div className="mb-4 flex items-center gap-2">
            <IconSpark size={16} />
            <h2 className="text-[16px] font-bold" style={{ color: 'var(--text)' }}>
              Platform settings
            </h2>
          </div>
          <div className="grid gap-3">
            {TOGGLES.map(([key, label, help]) => {
              const on = settings[key] === 'true';
              return (
                <div
                  key={key}
                  className="flex items-start justify-between gap-4 rounded-xl border p-3.5"
                  style={{ borderColor: 'var(--border)', background: 'var(--bg-soft)' }}
                >
                  <div className="min-w-0">
                    <div className="text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
                      {label}
                    </div>
                    <div className="mt-0.5 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                      {help}
                    </div>
                  </div>
                  <button
                    disabled={pending}
                    onClick={() => start(() => void updateSetting(key, on ? 'false' : 'true'))}
                    className="relative h-6 w-11 shrink-0 rounded-full transition-colors"
                    style={{ background: on ? 'var(--accent)' : 'var(--border-strong)' }}
                    aria-label={label}
                  >
                    <motion.span
                      className="absolute top-[3px] h-[18px] w-[18px] rounded-full bg-white"
                      animate={{ left: on ? 26 : 3 }}
                      transition={{ type: 'spring', stiffness: 500, damping: 32 }}
                    />
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      </Reveal>

      {/* users */}
      <Reveal delay={0.12}>
        <div
          className="mt-5 rounded-2xl border"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <div className="flex flex-wrap items-center gap-3 border-b p-5" style={{ borderColor: 'var(--border)' }}>
            <IconTarget size={16} />
            <h2 className="text-[16px] font-bold" style={{ color: 'var(--text)' }}>
              Users
            </h2>
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter by name or email…"
              className="ml-auto w-full max-w-[260px] rounded-lg border px-3 py-1.5 text-[13px] outline-none focus:border-[var(--accent)]"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--bg-soft)',
                color: 'var(--text)',
              }}
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-[13.5px]">
              <thead>
                <tr style={{ background: 'var(--bg-soft)' }}>
                  {['User', 'Plan', 'Role', 'Activity', 'Joined', 'Actions'].map((h) => (
                    <th
                      key={h}
                      className="px-4 py-2.5 text-left text-[11px] font-bold uppercase tracking-wider"
                      style={{ color: 'var(--text-dim)' }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {filtered.map((u) => (
                  <tr
                    key={u.id}
                    className="border-t transition-colors hover:bg-[var(--bg-soft)]"
                    style={{ borderColor: 'var(--border)', opacity: u.suspended ? 0.55 : 1 }}
                  >
                    <td className="px-4 py-3">
                      <div className="font-semibold" style={{ color: 'var(--text)' }}>
                        {u.name}
                      </div>
                      <div className="text-[12px]" style={{ color: 'var(--text-dim)' }}>
                        {u.email}
                        {u.mustChangePassword && (
                          <span className="ml-2 font-bold" style={{ color: '#f43f5e' }}>
                            default password
                          </span>
                        )}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        disabled={pending}
                        value={u.plan}
                        onChange={(e) =>
                          start(() => void setUserPlan(u.id, e.target.value as PlanId))
                        }
                        className="rounded-lg border px-2 py-1 text-[12.5px] font-semibold outline-none"
                        style={{
                          borderColor: 'var(--border)',
                          background: 'var(--bg-soft)',
                          color: PLAN_COLOR[u.plan] ?? 'var(--text)',
                        }}
                      >
                        <option value="FREE">FREE</option>
                        <option value="PRO">PRO</option>
                        <option value="TEAM">TEAM</option>
                      </select>
                    </td>
                    <td className="px-4 py-3">
                      <button
                        disabled={pending}
                        onClick={() =>
                          start(() =>
                            void setUserRole(u.id, u.role === 'ADMIN' ? 'USER' : 'ADMIN')
                          )
                        }
                        className="rounded-full px-2.5 py-1 text-[11px] font-bold transition-colors"
                        style={{
                          background:
                            u.role === 'ADMIN'
                              ? 'color-mix(in srgb,#f43f5e 15%,transparent)'
                              : 'var(--bg-inset)',
                          color: u.role === 'ADMIN' ? '#f43f5e' : 'var(--text-dim)',
                        }}
                      >
                        {u.role}
                      </button>
                    </td>
                    <td className="px-4 py-3" style={{ color: 'var(--text-soft)' }}>
                      {u.completed} done · {u.notes} notes
                    </td>
                    <td className="px-4 py-3 font-mono text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                      {u.createdAt}
                    </td>
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-1.5">
                        <button
                          disabled={pending}
                          onClick={() => start(() => void setUserSuspended(u.id, !u.suspended))}
                          className="rounded-lg px-2.5 py-1 text-[12px] font-semibold"
                          style={{ background: 'var(--bg-inset)', color: 'var(--text-soft)' }}
                        >
                          {u.suspended ? 'Restore' : 'Suspend'}
                        </button>
                        {confirmDelete === u.id ? (
                          <>
                            <button
                              disabled={pending}
                              onClick={() =>
                                start(() => {
                                  void deleteUser(u.id);
                                  setConfirmDelete(null);
                                })
                              }
                              className="grid h-7 w-7 place-items-center rounded-lg"
                              style={{ background: '#f43f5e', color: '#fff' }}
                              title="Confirm delete"
                            >
                              <IconCheck size={13} />
                            </button>
                            <button
                              onClick={() => setConfirmDelete(null)}
                              className="grid h-7 w-7 place-items-center rounded-lg"
                              style={{ background: 'var(--bg-inset)', color: 'var(--text-dim)' }}
                              title="Cancel"
                            >
                              <IconX size={13} />
                            </button>
                          </>
                        ) : (
                          <button
                            onClick={() => setConfirmDelete(u.id)}
                            className="rounded-lg px-2.5 py-1 text-[12px] font-semibold"
                            style={{
                              background: 'color-mix(in srgb,#f43f5e 12%,transparent)',
                              color: '#f43f5e',
                            }}
                          >
                            Delete
                          </button>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </Reveal>

      {/* audit */}
      <Reveal delay={0.14}>
        <div
          className="mt-5 rounded-2xl border p-6"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <h2 className="mb-4 text-[16px] font-bold" style={{ color: 'var(--text)' }}>
            Audit log
          </h2>
          {audit.length === 0 ? (
            <p className="text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
              No admin actions recorded yet.
            </p>
          ) : (
            <ul className="grid gap-1">
              {audit.map((a) => (
                <li
                  key={a.id}
                  className="flex flex-wrap items-baseline gap-2 rounded-lg px-2.5 py-1.5 font-mono text-[12.5px]"
                  style={{ background: 'var(--bg-soft)' }}
                >
                  <span style={{ color: 'var(--text-dim)' }}>{a.at}</span>
                  <span className="font-bold" style={{ color: 'var(--accent-text)' }}>
                    {a.action}
                  </span>
                  <span style={{ color: 'var(--text-soft)' }}>{a.detail}</span>
                  <span className="ml-auto" style={{ color: 'var(--text-dim)' }}>
                    {a.actor}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </Reveal>
    </main>
  );
}
