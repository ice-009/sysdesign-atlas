import { redirect } from 'next/navigation';
import { auth, enabledOAuth } from '@/lib/auth';
import AuthForm from '@/components/AuthForm';

export const metadata = { title: 'Create account — SysDesign Atlas' };

export default async function SignUpPage() {
  const session = await auth();
  if (session) redirect('/learn');
  return <AuthForm mode="signup" oauth={enabledOAuth()} />;
}
