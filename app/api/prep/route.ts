import { NextResponse } from 'next/server';
import type { Prisma } from '@prisma/client';
import { currentUserId } from '@/lib/auth';
import { cleanSettings, cleanState } from '@/lib/prep';
import { readPlanState, writePlanState } from '@/lib/ipad-sync';
import plan from '@/lib/prep-plan.json';

const ITEMS = new Set(plan.items.map((i) => i.id));

/* The HLD + LLD plan's state for the dashboard. The iPad app keeps the same
   state in its sync log; ticks made here reach it on its next sync. */

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  return NextResponse.json(await readPlanState(userId));
}

// { item: 'hld-3', state: { s: 'done' } }  or  { settings: { catchup, off } }
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });
  const body = await req.json().catch(() => null);

  if (body && 'settings' in body) {
    const settings = cleanSettings(body.settings);
    await writePlanState(userId, 'settings', settings as unknown as Prisma.InputJsonValue);
    return NextResponse.json({ ok: true, settings });
  }

  const item = String(body?.item ?? '');
  if (!ITEMS.has(item)) return NextResponse.json({ error: 'unknown item' }, { status: 400 });
  const state = cleanState(body?.state);
  if (!state) return NextResponse.json({ error: 'bad state' }, { status: 400 });
  await writePlanState(userId, item, state as unknown as Prisma.InputJsonValue);
  return NextResponse.json({ ok: true, state });
}
