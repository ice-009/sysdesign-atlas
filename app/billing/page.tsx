import Link from 'next/link';
import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { PLANS, formatPrice, type PlanId } from '@/lib/plans';
import BillingActions from '@/components/BillingActions';
import Reveal from '@/components/Reveal';

export const metadata = { title: 'Billing — SysDesign Atlas' };
export const dynamic = 'force-dynamic';

export default async function BillingPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/signin');

  const [sub, invoices] = await Promise.all([
    prisma.subscription.findUnique({ where: { userId } }),
    prisma.invoice.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 20 }),
  ]);

  const planId = (sub?.plan ?? 'FREE') as PlanId;
  const plan = PLANS[planId];
  const renews = sub?.currentPeriodEnd?.toISOString().slice(0, 10);

  return (
    <main className="mx-auto max-w-[900px] px-5 py-12 pb-24">
      <Reveal>
        <h1
          className="text-[clamp(1.8rem,3.4vw,2.4rem)] font-extrabold tracking-[-0.03em]"
          style={{ color: 'var(--text)' }}
        >
          Billing
        </h1>
      </Reveal>

      <Reveal delay={0.05}>
        <div
          className="mt-7 rounded-2xl border p-7"
          style={{
            borderColor: `color-mix(in srgb, ${plan.accent} 32%, transparent)`,
            background: `radial-gradient(120% 100% at 0% 0%, color-mix(in srgb, ${plan.accent} 8%, transparent), transparent 60%), var(--panel)`,
          }}
        >
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div>
              <div
                className="text-[11px] font-bold uppercase tracking-wider"
                style={{ color: 'var(--text-dim)' }}
              >
                Current plan
              </div>
              <div
                className="mt-1.5 font-mono text-[30px] font-bold leading-none"
                style={{ color: plan.accent }}
              >
                {plan.name}
              </div>
              <p className="mt-2 text-[14px]" style={{ color: 'var(--text-soft)' }}>
                {plan.tagline}
              </p>
            </div>

            <div className="text-right">
              {sub?.cancelAtPeriodEnd ? (
                <span
                  className="rounded-full px-3 py-1 text-[11.5px] font-bold"
                  style={{ background: 'color-mix(in srgb,#fbbf24 15%,transparent)', color: '#fbbf24' }}
                >
                  CANCELS {renews}
                </span>
              ) : (
                <span
                  className="rounded-full px-3 py-1 text-[11.5px] font-bold"
                  style={{ background: 'color-mix(in srgb,#4ade80 15%,transparent)', color: '#4ade80' }}
                >
                  {(sub?.status ?? 'active').toUpperCase()}
                </span>
              )}
              {renews && !sub?.cancelAtPeriodEnd && (
                <div className="mt-2 text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                  Renews {renews}
                </div>
              )}
            </div>
          </div>

          <BillingActions
            plan={planId}
            cancelAtPeriodEnd={sub?.cancelAtPeriodEnd ?? false}
          />
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div
          className="mt-5 rounded-2xl border p-6"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <h2 className="mb-4 text-[16px] font-bold" style={{ color: 'var(--text)' }}>
            Invoice history
          </h2>
          {invoices.length === 0 ? (
            <p className="text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
              No invoices yet. The Free plan doesn&rsquo;t generate any.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13.5px]">
                <thead>
                  <tr style={{ background: 'var(--bg-soft)' }}>
                    {['Date', 'Plan', 'Period', 'Amount', 'Status'].map((h) => (
                      <th
                        key={h}
                        className="px-3 py-2 text-left text-[11px] font-bold uppercase tracking-wider"
                        style={{ color: 'var(--text-dim)' }}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {invoices.map((inv) => (
                    <tr key={inv.id} className="border-t" style={{ borderColor: 'var(--border)' }}>
                      <td className="px-3 py-2.5 font-mono text-[12.5px]" style={{ color: 'var(--text-soft)' }}>
                        {inv.createdAt.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5 font-semibold" style={{ color: 'var(--text)' }}>
                        {inv.plan}
                      </td>
                      <td className="px-3 py-2.5 font-mono text-[12px]" style={{ color: 'var(--text-dim)' }}>
                        {inv.periodStart.toISOString().slice(0, 10)} →{' '}
                        {inv.periodEnd.toISOString().slice(0, 10)}
                      </td>
                      <td className="px-3 py-2.5 font-mono" style={{ color: 'var(--text)' }}>
                        {formatPrice(inv.amount, inv.currency)}
                      </td>
                      <td className="px-3 py-2.5">
                        <span className="text-[12px] font-bold" style={{ color: '#4ade80' }}>
                          {inv.status.toUpperCase()}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </Reveal>

      <p className="mt-6 text-center text-[13px]" style={{ color: 'var(--text-dim)' }}>
        Looking for a different plan?{' '}
        <Link href="/pricing" className="font-semibold" style={{ color: 'var(--accent-text)' }}>
          Compare plans
        </Link>
      </p>
    </main>
  );
}
