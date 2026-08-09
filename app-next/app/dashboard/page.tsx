import { redirect } from 'next/navigation';
import { auth } from '@/lib/auth';
import { prisma } from '@/lib/prisma';
import { SECTIONS, getAllTopics } from '@/lib/content';
import DashboardView from '@/components/DashboardView';

export const metadata = { title: 'Dashboard — SysDesign Atlas' };
export const dynamic = 'force-dynamic';

export default async function DashboardPage() {
  const session = await auth();
  const userId = (session?.user as { id?: string } | undefined)?.id;
  if (!userId) redirect('/signin');

  const [rows, bookmarks, notes, activity] = await Promise.all([
    prisma.progress.findMany({ where: { userId } }),
    prisma.bookmark.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 12 }),
    prisma.note.findMany({ where: { userId }, orderBy: { updatedAt: 'desc' }, take: 8 }),
    prisma.activity.findMany({ where: { userId }, orderBy: { day: 'desc' }, take: 120 }),
  ]);

  const topics = getAllTopics();
  const bySlug = new Map(topics.map((t) => [t.slug, t]));
  const progressBySlug = new Map(rows.map((r) => [r.slug, r]));

  const perSection = SECTIONS.map((s) => {
    const items = topics.filter((t) => t.section.slug === s.slug);
    const done = items.filter((t) => progressBySlug.get(t.slug)?.completed).length;
    return { slug: s.slug, title: s.title, accent: s.accent, icon: s.icon, done, total: items.length };
  });

  // Weakest first: explicitly shaky, then completed-but-unrated.
  const review = rows
    .filter((r) => r.confidence > 0 && r.confidence < 3)
    .sort((a, b) => a.confidence - b.confidence)
    .slice(0, 10)
    .map((r) => {
      const t = bySlug.get(r.slug);
      return t
        ? {
            slug: r.slug,
            title: t.title,
            href: `/learn/${t.section.slug}/${t.slug}`,
            confidence: r.confidence,
            accent: t.section.accent,
          }
        : null;
    })
    .filter(Boolean) as {
    slug: string;
    title: string;
    href: string;
    confidence: number;
    accent: string;
  }[];

  const recent = rows
    .slice()
    .sort((a, b) => b.lastViewed.getTime() - a.lastViewed.getTime())
    .slice(0, 6)
    .map((r) => {
      const t = bySlug.get(r.slug);
      return t
        ? {
            title: t.title,
            href: `/learn/${t.section.slug}/${t.slug}`,
            completed: r.completed,
            accent: t.section.accent,
          }
        : null;
    })
    .filter(Boolean) as { title: string; href: string; completed: boolean; accent: string }[];

  // Streak = consecutive days back from today (or yesterday, if today is idle).
  const days = new Set(activity.map((a) => a.day));
  let streak = 0;
  const cursor = new Date();
  if (!days.has(cursor.toISOString().slice(0, 10))) cursor.setDate(cursor.getDate() - 1);
  while (days.has(cursor.toISOString().slice(0, 10))) {
    streak++;
    cursor.setDate(cursor.getDate() - 1);
  }

  const doneCount = rows.filter((r) => r.completed).length;
  const minutesDone = topics
    .filter((t) => progressBySlug.get(t.slug)?.completed)
    .reduce((n, t) => n + t.minutes, 0);

  return (
    <DashboardView
      name={session!.user?.name ?? 'there'}
      stats={{
        done: doneCount,
        total: topics.length,
        streak,
        minutes: minutesDone,
        bookmarks: bookmarks.length,
        notes: notes.length,
      }}
      perSection={perSection}
      review={review}
      recent={recent}
      heatmap={activity.map((a) => ({ day: a.day, topics: a.topics }))}
      bookmarks={bookmarks.map((b) => {
        const t = bySlug.get(b.slug);
        return {
          title: b.title,
          href: t ? `/learn/${t.section.slug}/${t.slug}` : '/learn',
          accent: t?.section.accent ?? '#38bdf8',
        };
      })}
    />
  );
}
