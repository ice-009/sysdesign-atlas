'use server';

import { revalidatePath } from 'next/cache';
import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import { requireAdmin, setSetting, logAudit } from '@/lib/entitlements';
import type { PlanId } from '@/lib/plans';

async function actor() {
  const ent = await requireAdmin();
  if (!ent) throw new Error('forbidden');
  const session = await auth();
  return { id: ent.userId, email: session?.user?.email ?? null };
}

export async function setUserRole(userId: string, role: 'USER' | 'ADMIN') {
  const me = await actor();
  // Guard against an admin removing their own last access.
  if (role === 'USER' && userId === me.id) throw new Error('cannot demote yourself');

  await prisma.user.update({ where: { id: userId }, data: { role } });
  await logAudit(me.id, me.email, 'role.change', userId, `→ ${role}`);
  revalidatePath('/admin');
}

export async function setUserSuspended(userId: string, suspended: boolean) {
  const me = await actor();
  if (userId === me.id) throw new Error('cannot suspend yourself');

  await prisma.user.update({ where: { id: userId }, data: { suspended } });
  await logAudit(me.id, me.email, suspended ? 'user.suspend' : 'user.restore', userId);
  revalidatePath('/admin');
}

export async function setUserPlan(userId: string, plan: PlanId) {
  const me = await actor();

  const periodEnd = new Date();
  periodEnd.setMonth(periodEnd.getMonth() + 1);

  await prisma.subscription.upsert({
    where: { userId },
    create: {
      userId,
      plan,
      status: 'active',
      currentPeriodEnd: plan === 'FREE' ? null : periodEnd,
    },
    update: {
      plan,
      status: 'active',
      cancelAtPeriodEnd: false,
      canceledAt: null,
      currentPeriodEnd: plan === 'FREE' ? null : periodEnd,
    },
  });

  await logAudit(me.id, me.email, 'plan.change', userId, `→ ${plan}`);
  revalidatePath('/admin');
}

export async function deleteUser(userId: string) {
  const me = await actor();
  if (userId === me.id) throw new Error('cannot delete yourself');

  const target = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  await prisma.user.delete({ where: { id: userId } }); // cascades everywhere
  await logAudit(me.id, me.email, 'user.delete', userId, target?.email ?? '');
  revalidatePath('/admin');
}

export async function updateSetting(key: string, value: string) {
  const me = await actor();
  await setSetting(key, value);
  await logAudit(me.id, me.email, 'setting.change', key, `→ ${value}`);
  revalidatePath('/admin');
  revalidatePath('/');
}

/** Clears the mustChangePassword flag once a real password is set. */
export async function changeOwnPassword(_prev: { error?: string; ok?: boolean }, form: FormData) {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) return { error: 'Not signed in.' };

  const current = String(form.get('current') ?? '');
  const next = String(form.get('next') ?? '');
  if (next.length < 8) return { error: 'New password must be at least 8 characters.' };
  if (next === 'admin') return { error: 'Pick something other than the default.' };

  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user?.passwordHash) return { error: 'This account has no password set.' };
  if (!(await bcrypt.compare(current, user.passwordHash))) {
    return { error: 'Current password is incorrect.' };
  }

  await prisma.user.update({
    where: { id: userId },
    data: { passwordHash: await bcrypt.hash(next, 12), mustChangePassword: false },
  });
  await logAudit(userId, user.email, 'password.change', userId);
  revalidatePath('/admin');
  return { ok: true };
}
