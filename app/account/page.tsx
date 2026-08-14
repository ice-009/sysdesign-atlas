import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import PasswordForm from '@/components/PasswordForm';
import Reveal from '@/components/Reveal';

export const metadata = { title: 'Account — SysDesign Atlas' };
export const dynamic = 'force-dynamic';

export default async function AccountPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/signin');

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { email: true, name: true, role: true, mustChangePassword: true, createdAt: true },
  });
  if (!user) redirect('/signin');

  return (
    <main className="mx-auto max-w-[620px] px-5 py-12 pb-24">
      <Reveal>
        <h1
          className="text-[clamp(1.8rem,3.4vw,2.3rem)] font-extrabold tracking-[-0.03em]"
          style={{ color: 'var(--text)' }}
        >
          Account
        </h1>
      </Reveal>

      <Reveal delay={0.05}>
        <div
          className="mt-7 rounded-2xl border p-6"
          style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
        >
          <dl className="grid gap-3 text-[14px]">
            {[
              ['Name', user.name ?? '—'],
              ['Email', user.email],
              ['Role', user.role],
              ['Joined', user.createdAt.toISOString().slice(0, 10)],
            ].map(([k, v]) => (
              <div key={k} className="flex justify-between gap-4">
                <dt style={{ color: 'var(--text-dim)' }}>{k}</dt>
                <dd className="font-semibold" style={{ color: 'var(--text)' }}>
                  {v}
                </dd>
              </div>
            ))}
          </dl>
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <PasswordForm mustChange={user.mustChangePassword} />
      </Reveal>
    </main>
  );
}
