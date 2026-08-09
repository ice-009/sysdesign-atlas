import { prisma } from './prisma';
import { auth } from './auth';
import { entitlementFrom, type Entitlement } from './plans';

/** Resolve the signed-in user's plan, role and feature set in one query. */
export async function getEntitlement(): Promise<Entitlement & { userId: string | null }> {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id ?? null;

  if (!userId) {
    return { ...entitlementFrom(null, false), userId: null };
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      role: true,
      subscription: { select: { plan: true, status: true, currentPeriodEnd: true } },
    },
  });

  const ent = entitlementFrom(user?.subscription ?? null, user?.role === 'ADMIN');
  return { ...ent, userId };
}

export async function requireAdmin() {
  const ent = await getEntitlement();
  if (!ent.isAdmin) return null;
  return ent;
}

/** Global runtime flags an admin can flip from /admin. */
export async function getSetting(key: string, fallback = ''): Promise<string> {
  const row = await prisma.appSetting.findUnique({ where: { key } });
  return row?.value ?? fallback;
}

export async function setSetting(key: string, value: string) {
  await prisma.appSetting.upsert({
    where: { key },
    create: { key, value },
    update: { value },
  });
}

export async function logAudit(
  actorId: string | null,
  actorEmail: string | null,
  action: string,
  targetId?: string,
  detail?: string
) {
  await prisma.auditLog.create({
    data: { actorId, actorEmail, action, targetId, detail },
  });
}
