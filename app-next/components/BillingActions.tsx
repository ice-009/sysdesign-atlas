'use client';

import Link from 'next/link';
import { useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { cancelSubscription, resumeSubscription } from '@/app/actions/billing';
import type { PlanId } from '@/lib/plans';

export default function BillingActions({
  plan,
  cancelAtPeriodEnd,
}: {
  plan: PlanId;
  cancelAtPeriodEnd: boolean;
}) {
  const [pending, start] = useTransition();
  const router = useRouter();

  const run = (fn: () => Promise<unknown>) =>
    start(async () => {
      await fn();
      router.refresh();
    });

  return (
    <div className="mt-7 flex flex-wrap gap-2.5">
      <Link
        href="/pricing"
        className="rounded-xl border px-5 py-2.5 text-[14px] font-semibold"
        style={{ borderColor: 'var(--border-strong)', color: 'var(--text)' }}
      >
        {plan === 'FREE' ? 'Upgrade' : 'Change plan'}
      </Link>

      {plan !== 'FREE' &&
        (cancelAtPeriodEnd ? (
          <button
            disabled={pending}
            onClick={() => run(resumeSubscription)}
            className="rounded-xl px-5 py-2.5 text-[14px] font-semibold disabled:opacity-60"
            style={{ background: 'color-mix(in srgb,#4ade80 15%,transparent)', color: '#4ade80' }}
          >
            {pending ? 'Working…' : 'Resume subscription'}
          </button>
        ) : (
          <button
            disabled={pending}
            onClick={() => run(cancelSubscription)}
            className="rounded-xl px-5 py-2.5 text-[14px] font-semibold disabled:opacity-60"
            style={{ background: 'var(--bg-inset)', color: 'var(--text-soft)' }}
          >
            {pending ? 'Working…' : 'Cancel at period end'}
          </button>
        ))}
    </div>
  );
}
