import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { requireAdmin } from '@/lib/entitlements';
import AdminView from '@/components/AdminView';

export const metadata = { title: 'Admin — SysDesign Atlas' };
export const dynamic = 'force-dynamic';

export default async function AdminPage() {
  const admin = await requireAdmin();
  if (!admin) redirect('/');

  const [users, subs, invoices, settings, audit, counts] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      select: {
        id: true,
        email: true,
        name: true,
        role: true,
        suspended: true,
        mustChangePassword: true,
        createdAt: true,
        subscription: { select: { plan: true, status: true, currentPeriodEnd: true } },
        _count: { select: { progress: true, notes: true } },
      },
    }),
    prisma.subscription.groupBy({ by: ['plan'], _count: { plan: true } }),
    prisma.invoice.aggregate({ _sum: { amount: true }, _count: true, where: { status: 'paid' } }),
    prisma.appSetting.findMany(),
    prisma.auditLog.findMany({ orderBy: { createdAt: 'desc' }, take: 20 }),
    Promise.all([
      prisma.user.count(),
      prisma.progress.count({ where: { completed: true } }),
      prisma.note.count(),
      prisma.activity.count(),
    ]),
  ]);

  const [totalUsers, completions, notes, activeDays] = counts;
  const settingsMap = Object.fromEntries(settings.map((s) => [s.key, s.value]));
  const planCounts = Object.fromEntries(subs.map((s) => [s.plan, s._count.plan]));

  return (
    <AdminView
      users={users.map((u) => ({
        id: u.id,
        email: u.email,
        name: u.name ?? '—',
        role: u.role,
        suspended: u.suspended,
        mustChangePassword: u.mustChangePassword,
        createdAt: u.createdAt.toISOString().slice(0, 10),
        plan: u.subscription?.plan ?? 'FREE',
        status: u.subscription?.status ?? '—',
        completed: u._count.progress,
        notes: u._count.notes,
      }))}
      stats={{
        totalUsers,
        completions,
        notes,
        activeDays,
        revenue: invoices._sum.amount ?? 0,
        invoiceCount: invoices._count,
        planCounts: {
          FREE: totalUsers - ((planCounts.PRO ?? 0) + (planCounts.TEAM ?? 0)),
          PRO: planCounts.PRO ?? 0,
          TEAM: planCounts.TEAM ?? 0,
        },
      }}
      settings={settingsMap}
      audit={audit.map((a) => ({
        id: a.id,
        action: a.action,
        actor: a.actorEmail ?? 'system',
        detail: a.detail ?? '',
        at: a.createdAt.toISOString().replace('T', ' ').slice(0, 16),
      }))}
    />
  );
}
