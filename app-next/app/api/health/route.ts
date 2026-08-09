import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';

export const dynamic = 'force-dynamic';

/* Two probes with different jobs:
   - /api/health?deep=1  checks the database. Used by the readiness probe,
     so a pod with a broken DB connection stops receiving traffic.
   - /api/health         process-only. Used by the liveness probe, so a
     database blip does NOT cause Kubernetes to restart every pod at once. */
export async function GET(req: Request) {
  const deep = new URL(req.url).searchParams.get('deep') === '1';

  if (!deep) {
    return NextResponse.json({ status: 'ok', uptime: process.uptime() });
  }

  try {
    await prisma.$queryRaw`SELECT 1`;
    return NextResponse.json({ status: 'ok', db: 'up', uptime: process.uptime() });
  } catch (err) {
    return NextResponse.json(
      { status: 'degraded', db: 'down', error: (err as Error).message },
      { status: 503 }
    );
  }
}
