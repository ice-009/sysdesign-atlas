import { redirect } from 'next/navigation';
import { prisma } from '@/lib/prisma';
import { auth } from '@/lib/auth';
import PasswordForm from '@/components/PasswordForm';
import Reveal from '@/components/Reveal';
import { revokeDeviceAction } from '@/app/actions/devices';

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

  // iPads signed in to the offline edition (/ipad). Tolerates the table not
  // existing yet so a deploy that lands before the schema push can't break
  // the account page.
  const devices = await prisma.deviceToken
    .findMany({ where: { userId, revokedAt: null }, orderBy: { lastUsedAt: 'desc' } })
    .catch(() => []);

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

      {devices.length > 0 && (
        <Reveal delay={0.15}>
          <section
            className="mt-7 rounded-2xl border p-6"
            style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}
          >
            <h2 className="text-[16px] font-bold" style={{ color: 'var(--text)' }}>
              Signed-in devices
            </h2>
            <p className="mt-1 text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
              The offline iPad edition syncs highlights, ink and progress through these. Revoking one
              signs that device out; its marks stay on the device until it signs in again.
            </p>
            <ul className="mt-4 grid gap-2">
              {devices.map((d) => (
                <li
                  key={d.id}
                  className="flex items-center justify-between gap-4 rounded-xl border px-4 py-3"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <div className="min-w-0">
                    <div className="truncate text-[14px] font-semibold" style={{ color: 'var(--text)' }}>
                      {d.name}
                    </div>
                    <div className="text-[12.5px]" style={{ color: 'var(--text-dim)' }}>
                      Signed in {d.createdAt.toISOString().slice(0, 10)} · last sync{' '}
                      {d.lastUsedAt.toISOString().slice(0, 10)}
                    </div>
                  </div>
                  <form action={revokeDeviceAction}>
                    <input type="hidden" name="id" value={d.id} />
                    <button
                      type="submit"
                      className="rounded-lg border px-3 py-1.5 text-[13px] font-semibold"
                      style={{ borderColor: 'var(--border)', color: '#e11d48' }}
                    >
                      Revoke
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          </section>
        </Reveal>
      )}
    </main>
  );
}
