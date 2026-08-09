import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { currentUserId } from '@/lib/auth';

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** Accrue study minutes for today. Called periodically by the study timer. */
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ ok: false }, { status: 401 });

  const body = await req.json().catch(() => null);
  // Clamp: the client reports elapsed minutes, and a tab left open for hours
  // shouldn't be able to claim them in one call.
  const minutes = Math.max(0, Math.min(30, Math.round(Number(body?.minutes) || 0)));
  if (!minutes) return NextResponse.json({ ok: true, minutes: 0 });

  const row = await prisma.activity.upsert({
    where: { userId_day: { userId, day: today() } },
    create: { userId, day: today(), minutes, topics: 0 },
    update: { minutes: { increment: minutes } },
  });

  return NextResponse.json({ ok: true, minutes: row.minutes });
}

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ minutes: 0 });

  const row = await prisma.activity.findUnique({
    where: { userId_day: { userId, day: today() } },
  });
  return NextResponse.json({ minutes: row?.minutes ?? 0 });
}
