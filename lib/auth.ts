import NextAuth from 'next-auth';
import type { NextAuthConfig } from 'next-auth';
import Credentials from 'next-auth/providers/credentials';
import GitHub from 'next-auth/providers/github';
import Google from 'next-auth/providers/google';
import { PrismaAdapter } from '@auth/prisma-adapter';
import bcrypt from 'bcryptjs';
import { prisma } from './prisma';

/** OAuth providers only register when their env vars are present. */
function oauthProviders() {
  const list = [];
  if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) {
    list.push(
      GitHub({
        clientId: process.env.AUTH_GITHUB_ID,
        clientSecret: process.env.AUTH_GITHUB_SECRET,
        allowDangerousEmailAccountLinking: true,
      })
    );
  }
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) {
    list.push(
      Google({
        clientId: process.env.AUTH_GOOGLE_ID,
        clientSecret: process.env.AUTH_GOOGLE_SECRET,
        allowDangerousEmailAccountLinking: true,
      })
    );
  }
  return list;
}

/** Which OAuth buttons the sign-in page should render. */
export function enabledOAuth(): string[] {
  const out: string[] = [];
  if (process.env.AUTH_GITHUB_ID && process.env.AUTH_GITHUB_SECRET) out.push('github');
  if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) out.push('google');
  return out;
}

export const authConfig: NextAuthConfig = {
  adapter: PrismaAdapter(prisma),
  // JWT sessions so route handlers stay cheap — no DB read per request.
  session: { strategy: 'jwt', maxAge: 60 * 60 * 24 * 30 },
  pages: { signIn: '/signin' },
  trustHost: true,
  providers: [
    ...oauthProviders(),
    Credentials({
      name: 'credentials',
      credentials: {
        email: { label: 'Email', type: 'email' },
        password: { label: 'Password', type: 'password' },
      },
      async authorize(creds) {
        const email = String(creds?.email ?? '').trim().toLowerCase();
        const password = String(creds?.password ?? '');
        if (!email || !password) return null;

        const user = await prisma.user.findUnique({ where: { email } });
        if (!user?.passwordHash || user.suspended) return null;

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return null;

        return { id: user.id, email: user.email, name: user.name, image: user.image };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user, trigger }) {
      if (user) token.uid = user.id;
      // Refresh role on sign-in and on any explicit session update, so an
      // admin promotion takes effect without waiting for the JWT to expire.
      if (token.uid && (user || trigger === 'update')) {
        const row = await prisma.user.findUnique({
          where: { id: token.uid as string },
          select: { role: true },
        });
        token.role = row?.role ?? 'USER';
      }
      return token;
    },
    async session({ session, token }) {
      if (token?.uid && session.user) {
        const u = session.user as { id?: string; role?: string };
        u.id = token.uid as string;
        u.role = (token.role as string) ?? 'USER';
      }
      return session;
    },
  },
};

export const { handlers, auth, signIn, signOut } = NextAuth(authConfig);

/** Throws-free helper: returns the signed-in user id, or null. */
export async function currentUserId(): Promise<string | null> {
  const session = await auth();
  return (session?.user as { id?: string } | undefined)?.id ?? null;
}
