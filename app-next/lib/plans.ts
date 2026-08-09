/* Plan catalogue and entitlement logic — the single source of truth for
   "what is this user allowed to do?". Imported by both server and client. */

export type PlanId = 'FREE' | 'PRO' | 'TEAM';

export type Feature =
  | 'unlimited_notes'
  | 'spaced_repetition'
  | 'export_progress'
  | 'advanced_analytics'
  | 'practice_history'
  | 'team_seats';

export type Plan = {
  id: PlanId;
  name: string;
  tagline: string;
  /** Minor units (paise). 0 = free. */
  monthly: number;
  yearly: number;
  accent: string;
  highlight?: boolean;
  features: Feature[];
  /** Null = unlimited. */
  noteLimit: number | null;
  bullets: string[];
};

export const PLANS: Record<PlanId, Plan> = {
  FREE: {
    id: 'FREE',
    name: 'Free',
    tagline: 'The entire curriculum, forever.',
    monthly: 0,
    yearly: 0,
    accent: '#38bdf8',
    features: [],
    noteLimit: 10,
    bullets: [
      'All 66 topics and 16 case studies',
      'Progress and completion tracking',
      'Confidence ratings and review queue',
      'Timed practice mode',
      'Up to 10 private notes',
    ],
  },
  PRO: {
    id: 'PRO',
    name: 'Pro',
    tagline: 'For an active interview loop.',
    monthly: 49900,
    yearly: 499000,
    accent: '#a78bfa',
    highlight: true,
    features: [
      'unlimited_notes',
      'spaced_repetition',
      'export_progress',
      'advanced_analytics',
      'practice_history',
    ],
    noteLimit: null,
    bullets: [
      'Everything in Free',
      'Unlimited private notes',
      'Spaced-repetition scheduling',
      'Advanced analytics and pace projection',
      'Practice session history',
      'Export progress as JSON or CSV',
    ],
  },
  TEAM: {
    id: 'TEAM',
    name: 'Team',
    tagline: 'For a group preparing together.',
    monthly: 199900,
    yearly: 1999000,
    accent: '#f472b6',
    features: [
      'unlimited_notes',
      'spaced_repetition',
      'export_progress',
      'advanced_analytics',
      'practice_history',
      'team_seats',
    ],
    noteLimit: null,
    bullets: [
      'Everything in Pro',
      'Up to 10 seats',
      'Shared team progress view',
      'Priority support',
    ],
  },
};

export const PLAN_LIST = [PLANS.FREE, PLANS.PRO, PLANS.TEAM];

export type Entitlement = {
  plan: PlanId;
  status: string;
  active: boolean;
  features: Set<Feature>;
  noteLimit: number | null;
  isAdmin: boolean;
};

/** A subscription only grants features while it is actually in good standing. */
export function entitlementFrom(
  sub: { plan: string; status: string; currentPeriodEnd: Date | null } | null,
  isAdmin = false
): Entitlement {
  const planId = (sub?.plan ?? 'FREE') as PlanId;
  const plan = PLANS[planId] ?? PLANS.FREE;
  const status = sub?.status ?? 'active';

  const notExpired =
    !sub?.currentPeriodEnd || sub.currentPeriodEnd.getTime() > Date.now();
  const good = status === 'active' || status === 'trialing';
  const active = planId === 'FREE' ? true : good && notExpired;

  // Admins get everything — they need to be able to see what they administer.
  const effective = isAdmin ? PLANS.TEAM : active ? plan : PLANS.FREE;

  return {
    plan: isAdmin ? planId : active ? planId : 'FREE',
    status,
    active,
    features: new Set(effective.features),
    noteLimit: effective.noteLimit,
    isAdmin,
  };
}

export function formatPrice(minor: number, currency = 'INR') {
  if (minor === 0) return 'Free';
  const symbol = currency === 'INR' ? '₹' : '$';
  return `${symbol}${(minor / 100).toLocaleString('en-IN')}`;
}
