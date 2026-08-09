import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { currentUserId } from '@/lib/auth';

function today() {
  return new Date().toISOString().slice(0, 10);
}

/** All progress rows for the signed-in user, keyed by slug. */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ progress: {} });

  const rows = await prisma.progress.findMany({ where: { userId } });
  const progress: Record<string, { completed: boolean; confidence: number }> = {};
  for (const r of rows) progress[r.slug] = { completed: r.completed, confidence: r.confidence };
  return NextResponse.json({ progress });
}

/** Upsert completion and/or confidence for one topic. */
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? '');
  const section = String(body?.section ?? '');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const completed = typeof body.completed === 'boolean' ? body.completed : undefined;
  const confidence =
    typeof body.confidence === 'number' ? Math.max(0, Math.min(3, body.confidence)) : undefined;

  const row = await prisma.progress.upsert({
    where: { userId_slug: { userId, slug } },
    create: {
      userId,
      slug,
      section,
      completed: completed ?? false,
      confidence: confidence ?? 0,
      completedAt: completed ? new Date() : null,
    },
    update: {
      ...(completed !== undefined && {
        completed,
        completedAt: completed ? new Date() : null,
      }),
      ...(confidence !== undefined && { confidence }),
      lastViewed: new Date(),
    },
  });

  // Streak bookkeeping: one row per day studied.
  if (completed) {
    await prisma.activity.upsert({
      where: { userId_day: { userId, day: today() } },
      create: { userId, day: today(), topics: 1, minutes: 0 },
      update: { topics: { increment: 1 } },
    });
  }

  return NextResponse.json({ ok: true, progress: row });
}
