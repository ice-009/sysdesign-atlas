import { NextResponse } from 'next/server';
import { Prisma } from '@prisma/client';
import { deviceFromRequest, parseChanges, runSync } from '@/lib/ipad-sync';

// A first sync with a big backlog can take a few seconds against Neon.
export const maxDuration = 30;

const noStore = { 'Cache-Control': 'no-store' };

/** Push the device's outbox and pull everything after its cursor, in one call. */
export async function POST(req: Request) {
  const device = await deviceFromRequest(req);
  if (!device) return NextResponse.json({ error: 'signed_out' }, { status: 401, headers: noStore });

  const body = await req.json().catch(() => null);
  const rawCursor = String(body?.cursor ?? '0');
  if (!/^\d{1,19}$/.test(rawCursor)) {
    return NextResponse.json({ error: 'bad cursor' }, { status: 400, headers: noStore });
  }
  const changes = parseChanges(body?.changes);
  if (typeof changes === 'string') return NextResponse.json({ error: changes }, { status: 400, headers: noStore });

  try {
    const result = await runSync(device.userId, BigInt(rawCursor), changes);
    return NextResponse.json(result, { headers: noStore });
  } catch (err) {
    // Two devices syncing for the very first time at the same instant both try
    // to create the SyncState row; the loser just retries.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      return NextResponse.json({ error: 'retry' }, { status: 409, headers: noStore });
    }
    console.error('[ipad-sync] sync failed', err);
    return NextResponse.json({ error: 'sync_failed' }, { status: 500, headers: noStore });
  }
}
