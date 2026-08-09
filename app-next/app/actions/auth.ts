'use server';

import bcrypt from 'bcryptjs';
import { prisma } from '@/lib/prisma';

export type FormState = { error?: string; ok?: boolean };

/* Account creation only. Signing in happens CLIENT-side via
   next-auth/react's signIn(), because a server-action redirect performs an
   RSC navigation — SessionProvider never remounts, so the header would keep
   showing the signed-out state until a hard reload. */
export async function signUpAction(
  _prev: FormState,
  formData: FormData
): Promise<FormState> {
  const name = String(formData.get('name') ?? '').trim();
  const email = String(formData.get('email') ?? '').trim().toLowerCase();
  const password = String(formData.get('password') ?? '');

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return { error: 'Enter a valid email address.' };
  }
  if (password.length < 8) {
    return { error: 'Password must be at least 8 characters.' };
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return { error: 'An account with that email already exists.' };

  const passwordHash = await bcrypt.hash(password, 12);
  await prisma.user.create({
    data: { email, name: name || email.split('@')[0], passwordHash },
  });

  return { ok: true };
}
