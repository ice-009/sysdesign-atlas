'use server';

import { revalidatePath } from 'next/cache';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { PLANS, type PlanId } from '@/lib/plans';

/* Mock checkout. Swapping in a real provider means replacing subscribe()
   with a redirect to a hosted checkout page and moving the subscription
   write into the provider's webhook handler. The data model already carries
   providerCustomerId / providerSubscriptionId for that. */

async function userId() {
  const session = await auth();
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}

export async function subscribe(plan: PlanId, interval: 'monthly' | 'yearly') {
  const uid = await userId();
  if (!uid) return { error: 'Sign in first.' };
  if (plan === 'FREE') return downgrade();

  const def = PLANS[plan];
  const start = new Date();
  const end = new Date(start);
  interval === 'yearly' ? end.setFullYear(end.getFullYear() + 1) : end.setMonth(end.getMonth() + 1);

  await prisma.$transaction(async (tx) => {
    await tx.subscription.upsert({
      where: { userId: uid },
      create: {
        userId: uid,
        plan,
        interval,
        status: 'active',
        currentPeriodStart: start,
        currentPeriodEnd: end,
        seats: plan === 'TEAM' ? 10 : 1,
      },
      update: {
        plan,
        interval,
        status: 'active',
        cancelAtPeriodEnd: false,
        canceledAt: null,
        currentPeriodStart: start,
        currentPeriodEnd: end,
        seats: plan === 'TEAM' ? 10 : 1,
      },
    });

    await tx.invoice.create({
      data: {
        userId: uid,
        plan,
        amount: interval === 'yearly' ? def.yearly : def.monthly,
        currency: 'INR',
        status: 'paid',
        periodStart: start,
        periodEnd: end,
      },
    });
  });

  revalidatePath('/billing');
  revalidatePath('/pricing');
  return { ok: true };
}

/** Keeps access until the period ends, which is what users expect. */
export async function cancelSubscription() {
  const uid = await userId();
  if (!uid) return { error: 'Sign in first.' };

  await prisma.subscription.updateMany({
    where: { userId: uid },
    data: { cancelAtPeriodEnd: true, canceledAt: new Date() },
  });

  revalidatePath('/billing');
  return { ok: true };
}

export async function resumeSubscription() {
  const uid = await userId();
  if (!uid) return { error: 'Sign in first.' };

  await prisma.subscription.updateMany({
    where: { userId: uid },
    data: { cancelAtPeriodEnd: false, canceledAt: null },
  });

  revalidatePath('/billing');
  return { ok: true };
}

export async function downgrade() {
  const uid = await userId();
  if (!uid) return { error: 'Sign in first.' };

  await prisma.subscription.upsert({
    where: { userId: uid },
    create: { userId: uid, plan: 'FREE', status: 'active' },
    update: {
      plan: 'FREE',
      status: 'active',
      cancelAtPeriodEnd: false,
      canceledAt: null,
      currentPeriodEnd: null,
    },
  });

  revalidatePath('/billing');
  return { ok: true };
}
