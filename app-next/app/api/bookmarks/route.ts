import { NextResponse } from 'next/server';
import { prisma } from '@/lib/prisma';
import { currentUserId } from '@/lib/auth';

export async function GET() {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ bookmarks: [] });

  const rows = await prisma.bookmark.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
  });
  return NextResponse.json({ bookmarks: rows.map((r) => r.slug), rows });
}

/** Toggle: creates if absent, removes if present. */
export async function POST(req: Request) {
  const userId = await currentUserId();
  if (!userId) return NextResponse.json({ error: 'unauthorized' }, { status: 401 });

  const body = await req.json().catch(() => null);
  const slug = String(body?.slug ?? '');
  if (!slug) return NextResponse.json({ error: 'slug required' }, { status: 400 });

  const existing = await prisma.bookmark.findUnique({ where: { userId_slug: { userId, slug } } });
  if (existing) {
    await prisma.bookmark.delete({ where: { id: existing.id } });
    return NextResponse.json({ ok: true, bookmarked: false });
  }

  await prisma.bookmark.create({
    data: {
      userId,
      slug,
      section: String(body?.section ?? ''),
      title: String(body?.title ?? slug),
    },
  });
  return NextResponse.json({ ok: true, bookmarked: true });
}
