/* Seeds the admin account and default app settings.
   Run: npm run seed

   Credentials come from env so production never has to use the defaults:
     ADMIN_EMAIL     (default: admin)
     ADMIN_PASSWORD  (default: admin)

   When the default password is used, the account is flagged
   mustChangePassword and the app shows a warning banner until it changes. */

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { PrismaBetterSqlite3 } from '@prisma/adapter-better-sqlite3';
import { PrismaPg } from '@prisma/adapter-pg';
import bcrypt from 'bcryptjs';

const url = process.env.DATABASE_URL ?? 'file:./dev.db';
const isPg = url.startsWith('postgres');
const adapter = isPg ? new PrismaPg({ connectionString: url }) : new PrismaBetterSqlite3({ url });
const prisma = new PrismaClient({ adapter });

const EMAIL = process.env.ADMIN_EMAIL ?? 'admin';
const PASSWORD = process.env.ADMIN_PASSWORD ?? 'admin';
const USING_DEFAULTS = PASSWORD === 'admin';

async function main() {
  const passwordHash = await bcrypt.hash(PASSWORD, 12);

  const admin = await prisma.user.upsert({
    where: { email: EMAIL },
    create: {
      email: EMAIL,
      name: 'Administrator',
      passwordHash,
      role: 'ADMIN',
      mustChangePassword: USING_DEFAULTS,
    },
    update: {
      role: 'ADMIN',
      passwordHash,
      mustChangePassword: USING_DEFAULTS,
    },
  });

  // Admins get a TEAM subscription so they can see every gated surface.
  await prisma.subscription.upsert({
    where: { userId: admin.id },
    create: { userId: admin.id, plan: 'TEAM', status: 'active', seats: 10 },
    update: { plan: 'TEAM', status: 'active' },
  });

  const defaults = [
    // Content stays free by default — flip to "true" in /admin to paywall it.
    ['gate_content', 'false'],
    ['allow_signups', 'true'],
    ['maintenance_mode', 'false'],
    ['announcement', ''],
  ];
  for (const [key, value] of defaults) {
    await prisma.appSetting.upsert({ where: { key }, create: { key, value }, update: {} });
  }

  console.log('');
  console.log('  ✓ Admin account ready');
  console.log(`    email    ${EMAIL}`);
  console.log(`    password ${USING_DEFAULTS ? 'admin' : '(from ADMIN_PASSWORD)'}`);
  console.log(`    sign in  http://localhost:4321/signin`);
  if (USING_DEFAULTS) {
    console.log('');
    console.log('  ⚠  Default password in use. Fine locally — change it before');
    console.log('     exposing this to a network. The app will keep warning you.');
  }
  console.log('');
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
