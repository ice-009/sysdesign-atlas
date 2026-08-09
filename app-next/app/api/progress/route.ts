import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { currentUserId } from '@/lib/auth';
import { getAllTopics } from '@/lib/content';

function today() {
  return new Date().toISOString().slice(0, 10);
}

type Row = { slug: string; timeSpent: number };

/* How your logged time compares with the reading estimates, across every topic
   you have actually timed. Untimed topics are excluded — otherwise the average
   would just measure how much of the curriculum you have not started. */
function pace(rows: Row[]) {
  const estimate = new Map(getAllTopics().map((t) => [t.slug, t.minutes * 60]));
  let seconds = 0;
  let estimateSeconds = 0;
  let topics = 0;

  for (const r of rows) {
    const est = estimate.get(r.slug);
    if (!est || r.timeSpent <= 0) continue;
    seconds += r.timeSpent;
    estimateSeconds += est;
    topics += 1;
  }

  return {
    topics,
    seconds,
    estimateSeconds,
    ratio: estimateSeconds ? seconds / estimateSeconds : null,
  };
}

/** All progress rows for the signed-in user, keyed by slug. */
export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ progress: {}, pace: null });

  const rows = await prisma.progress.findMany({ where: { userId } });
  const progress: Record<string, { completed: boolean; confidence: number; timeSpent: number }> =
    {};
  for (const r of rows) {
    progress[r.slug] = {
      completed: r.completed,
      confidence: r.confidence,
      timeSpent: r.timeSpent,
    };
  }
  return NextResponse.json({ progress, pace: pace(rows) });
}

/** Upsert completion, confidence, and/or accrued study seconds for one topic. */
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
  // Clamp: the topic timer flushes about once a minute, so a single call
  // claiming more than an hour is a stale tab, not a study session.
  const seconds = Math.max(0, Math.min(3600, Math.round(Number(body?.seconds) || 0)));

  const before = seconds
    ? await prisma.progress.findUnique({
        where: { userId_slug: { userId, slug } },
        select: { timeSpent: true },
      })
    : null;

  const row = await prisma.progress.upsert({
    where: { userId_slug: { userId, slug } },
    create: {
      userId,
      slug,
      section,
      completed: completed ?? false,
      confidence: confidence ?? 0,
      timeSpent: seconds,
      completedAt: completed ? new Date() : null,
    },
    update: {
      ...(completed !== undefined && {
        completed,
        completedAt: completed ? new Date() : null,
      }),
      ...(confidence !== undefined && { confidence }),
      ...(seconds > 0 && { timeSpent: { increment: seconds } }),
      lastViewed: new Date(),
    },
  });

  // Streak bookkeeping: one row per day studied.
  //
  // Timer seconds roll into the day's minutes only when they cross a whole
  // minute of the topic's running total, so flushing 40s twice credits one
  // minute rather than zero or two. No drift, no double counting.
  const minutes =
    seconds > 0
      ? Math.floor(row.timeSpent / 60) - Math.floor((before?.timeSpent ?? 0) / 60)
      : 0;

  if (completed || minutes > 0) {
    await prisma.activity.upsert({
      where: { userId_day: { userId, day: today() } },
      create: { userId, day: today(), topics: completed ? 1 : 0, minutes },
      update: {
        ...(completed && { topics: { increment: 1 } }),
        ...(minutes > 0 && { minutes: { increment: minutes } }),
      },
    });
  }

  // The timer wants the refreshed cross-topic average to compare against.
  const summary = seconds
    ? pace(await prisma.progress.findMany({ where: { userId }, select: { slug: true, timeSpent: true } }))
    : undefined;

  return NextResponse.json({ ok: true, progress: row, pace: summary });
}
