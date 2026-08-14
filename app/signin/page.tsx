import { redirect } from 'next/navigation';
import { auth, enabledOAuth } from '@/lib/auth';
import AuthForm from '@/components/AuthForm';

export const metadata = { title: 'Sign in — SysDesign Atlas' };

export default async function SignInPage() {
  const session = await auth();
  if (session) redirect('/learn');
  return <AuthForm mode="signin" oauth={enabledOAuth()} />;
}
