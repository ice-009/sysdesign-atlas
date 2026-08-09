import { getAllTopics, SECTIONS } from '@/lib/content';
import Sidebar from '@/components/Sidebar';

export default function LearnLayout({ children }: { children: React.ReactNode }) {
  const topics = getAllTopics().map((t) => ({
    slug: t.slug,
    title: t.title,
    href: `/learn/${t.section.slug}/${t.slug}`,
    section: t.section.slug,
  }));

  const sections = SECTIONS.map((s) => ({
    slug: s.slug,
    title: s.title,
    accent: s.accent,
    icon: s.icon,
    group: s.group,
  }));

  return (
    <div className="mx-auto flex w-full max-w-[1600px] 2xl:max-w-[1900px] min-[2400px]:max-w-[2200px]">
      <Sidebar sections={sections} topics={topics} />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
