import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { currentUserId } from '@/lib/auth';
import { getEntitlement } from '@/lib/entitlements';

export async function GET(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ note: null });

  const slug = new URL(req.url).searchParams.get('slug');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const note = await prisma.note.findUnique({ where: { userId_slug: { userId, slug } } });
  return NextResponse.json({ note: note?.body ?? '' });
}

export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? '');
  const section = String(body?.section ?? '');
  const text = String(body?.body ?? '');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  // Empty body means "delete the note" rather than storing a blank row.
  if (!text.trim()) {
    await prisma.note.deleteMany({ where: { userId, slug } });
    return NextResponse.json({ ok: true, note: '' });
  }

  // Plan limits are enforced here, not in the UI — a client-side gate is
  // decoration. Editing an existing note is always allowed; only creating
  // a new one past the cap is refused.
  const existing = await prisma.note.findUnique({ where: { userId_slug: { userId, slug } } });
  if (!existing) {
    const ent = await getEntitlement();
    if (ent.noteLimit !== null) {
      const count = await prisma.note.count({ where: { userId } });
      if (count >= ent.noteLimit) {
        return NextResponse.json(
          {
            error: 'note_limit_reached',
            limit: ent.noteLimit,
            message: `The Free plan includes ${ent.noteLimit} notes. Upgrade for unlimited.`,
          },
          { status: 402 }
        );
      }
    }
  }

  await prisma.note.upsert({
    where: { userId_slug: { userId, slug } },
    create: { userId, slug, section, body: text },
    update: { body: text },
  });
  return NextResponse.json({ ok: true, note: text });
}
