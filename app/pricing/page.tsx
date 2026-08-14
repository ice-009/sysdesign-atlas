import { getEntitlement } from '@/lib/entitlements';
import PricingView from '@/components/PricingView';

export const metadata = { title: 'Pricing — SysDesign Atlas' };
export const dynamic = 'force-dynamic';

export default async function PricingPage() {
  const ent = await getEntitlement();
  return <PricingView currentPlan={ent.plan} signedIn={!!ent.userId} />;
}
