'use client';

import { useState, useTransition } from 'react';
import { useRouter } from 'next/navigation';
import { motion } from 'motion/react';
import Reveal from './Reveal';
import { PLAN_LIST, formatPrice, type PlanId } from '@/lib/plans';
import { subscribe } from '@/app/actions/billing';
import { IconCheck, IconArrow } from './Icons';
import { useTopicIndex } from './TopicIndexProvider';

export default function PricingView({
  currentPlan,
  signedIn,
}: {
  currentPlan: PlanId;
  signedIn: boolean;
}) {
  const index = useTopicIndex();
  const topicCount = index.length;
  const caseStudyCount = index.filter((r) => r.u.startsWith('/learn/case-studies/')).length;
  const [interval, setInterval] = useState<'monthly' | 'yearly'>('monthly');
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<PlanId | null>(null);
  const router = useRouter();

  const choose = (plan: PlanId) => {
    if (!signedIn) return router.push('/signup');
    setBusy(plan);
    start(async () => {
      await subscribe(plan, interval);
      setBusy(null);
      router.push('/billing');
    });
  };

  return (
    <main className="mx-auto max-w-[1400px] px-5 py-14 pb-24">
      <Reveal>
        <div className="text-center">
          <h1
            className="text-[clamp(2rem,4vw,2.9rem)] font-extrabold tracking-[-0.035em]"
            style={{ color: 'var(--text)' }}
          >
            Plans
          </h1>
          <p
            className="mx-auto mt-4 max-w-[60ch] text-[17px] leading-relaxed"
            style={{ color: 'var(--text-soft)' }}
          >
            <strong style={{ color: 'var(--text)' }}>
              All {topicCount} topics and {caseStudyCount} case studies are free, permanently.
            </strong>{' '}
            Paid plans add study tooling on top — they never lock the curriculum.
          </p>
        </div>
      </Reveal>

      {/* interval toggle */}
      <Reveal delay={0.06}>
        <div className="mt-9 flex justify-center">
          <div
            className="relative flex rounded-xl border p-1"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            {(['monthly', 'yearly'] as const).map((i) => (
              <button
                key={i}
                onClick={() => setInterval(i)}
                className="relative rounded-lg px-5 py-2 text-[13.5px] font-semibold capitalize"
                style={{ color: interval === i ? 'var(--text)' : 'var(--text-dim)' }}
              >
                {interval === i && (
                  <motion.span
                    layoutId="interval-pill"
                    className="absolute inset-0 rounded-lg"
                    style={{ background: 'var(--bg-inset)' }}
                    transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                  />
                )}
                <span className="relative">
                  {i}
                  {i === 'yearly' && (
                    <span className="ml-1.5 text-[11px] font-bold" style={{ color: '#4ade80' }}>
                      2 months free
                    </span>
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      </Reveal>

      {/* plans */}
      <div className="mx-auto mt-10 grid max-w-[1050px] gap-5 md:grid-cols-3">
        {PLAN_LIST.map((p, i) => {
          const price = interval === 'yearly' ? p.yearly : p.monthly;
          const isCurrent = currentPlan === p.id;

          return (
            <Reveal key={p.id} delay={i * 0.07}>
              <div
                className="relative flex h-full flex-col rounded-2xl border p-7"
                style={{
                  borderColor: p.highlight
                    ? `color-mix(in srgb, ${p.accent} 45%, transparent)`
                    : 'var(--border)',
                  background: p.highlight
                    ? `radial-gradient(120% 100% at 50% 0%, color-mix(in srgb, ${p.accent} 9%, transparent), transparent 60%), var(--panel)`
                    : 'var(--panel)',
                }}
              >
                {p.highlight && (
                  <span
                    className="absolute -top-2.5 left-1/2 -translate-x-1/2 rounded-full px-3 py-1 text-[10.5px] font-bold text-[#071018]"
                    style={{ background: p.accent }}
                  >
                    MOST POPULAR
                  </span>
                )}

                <h2 className="text-[19px] font-bold" style={{ color: 'var(--text)' }}>
                  {p.name}
                </h2>
                <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
                  {p.tagline}
                </p>

                <div className="mt-5 flex items-baseline gap-1.5">
                  <span
                    className="font-mono text-[34px] font-bold tracking-tight"
                    style={{ color: p.accent }}
                  >
                    {formatPrice(price)}
                  </span>
                  {price > 0 && (
                    <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
                      /{interval === 'yearly' ? 'year' : 'month'}
                    </span>
                  )}
                </div>

                <ul className="mt-6 grid flex-1 gap-2.5">
                  {p.bullets
                    .map((b) => b.replace('{topics}', String(topicCount)).replace('{caseStudies}', String(caseStudyCount)))
                    .map((b) => (
                    <li key={b} className="flex items-start gap-2.5">
                      <span className="mt-[3px] shrink-0" style={{ color: p.accent }}>
                        <IconCheck size={13} strokeWidth={3} />
                      </span>
                      <span className="text-[13.5px] leading-snug" style={{ color: 'var(--text-soft)' }}>
                        {b}
                      </span>
                    </li>
                  ))}
                </ul>

                <button
                  onClick={() => choose(p.id)}
                  disabled={isCurrent || pending}
                  className="mt-7 flex items-center justify-center gap-2 rounded-xl px-5 py-3 text-[14.5px] font-bold transition-all disabled:cursor-default disabled:opacity-60"
                  style={
                    isCurrent
                      ? { background: 'var(--bg-inset)', color: 'var(--text-dim)' }
                      : p.highlight
                        ? { background: `linear-gradient(135deg, ${p.accent}, #38bdf8)`, color: '#071018' }
                        : { border: '1px solid var(--border-strong)', color: 'var(--text)' }
                  }
                >
                  {isCurrent
                    ? 'Current plan'
                    : busy === p.id
                      ? 'Processing…'
                      : p.id === 'FREE'
                        ? 'Switch to Free'
                        : signedIn
                          ? `Choose ${p.name}`
                          : 'Get started'}
                  {!isCurrent && busy !== p.id && <IconArrow size={15} />}
                </button>
              </div>
            </Reveal>
          );
        })}
      </div>

      <Reveal delay={0.2}>
        <div
          className="mx-auto mt-12 max-w-[760px] rounded-2xl border p-6"
          style={{
            borderColor: 'color-mix(in srgb, #fbbf24 30%, transparent)',
            background: 'color-mix(in srgb, #fbbf24 5%, var(--panel))',
          }}
        >
          <h3 className="mb-2 text-[14px] font-bold" style={{ color: '#fbbf24' }}>
            Checkout is simulated
          </h3>
          <p className="text-[13.5px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
            No payment provider is wired up, so choosing a plan updates your subscription
            immediately and writes an invoice row — nothing is charged. The data model already
            carries <code className="inline-code">providerCustomerId</code> and{' '}
            <code className="inline-code">providerSubscriptionId</code>, so connecting Stripe means
            replacing one server action with a redirect to hosted checkout and moving the
            subscription write into the webhook handler.
          </p>
        </div>
      </Reveal>
    </main>
  );
}
