import type { Metadata } from 'next';
import './globals.css';
import { SessionProvider } from 'next-auth/react';
import { getSearchIndex, getStats } from '@/lib/content';
import TopBar from '@/components/TopBar';
import SearchPalette from '@/components/SearchPalette';
import { ProgressProvider } from '@/components/ProgressProvider';
import { FocusProvider } from '@/components/FocusProvider';
import { TopicIndexProvider } from '@/components/TopicIndexProvider';
import FocusControls from '@/components/FocusControls';
import ReadingGuide from '@/components/ReadingGuide';
import LinkPreview from '@/components/LinkPreview';

export const metadata: Metadata = {
  title: 'SysDesign Atlas — Master system design for MAANG interviews',
  description:
    '66 in-depth topics, 16 full case studies, and the interview framework that gets you hired. Everything unlocked.',
};

// Avoid a flash of the wrong theme before React hydrates.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('sd.theme');
var d=t?t==='dark':window.matchMedia('(prefers-color-scheme: dark)').matches;
document.documentElement.classList.toggle('dark',d);}catch(e){
document.documentElement.classList.add('dark');}})();`;

// Deliberately NOT calling auth() here — reading cookies in the root layout
// makes every page dynamic. SessionProvider fetches the session client-side
// instead, which lets all 66 content pages prerender at build time.
export default function RootLayout({ children }: { children: React.ReactNode }) {
  const index = getSearchIndex();
  const { topics: totalTopics } = getStats();

  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
        <link
          rel="icon"
          href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'%3E%3Crect width='100' height='100' rx='24' fill='%2338bdf8'/%3E%3Cpath d='M28 62 L50 30 L72 62' stroke='%23071018' stroke-width='9' fill='none' stroke-linecap='round' stroke-linejoin='round'/%3E%3C/svg%3E"
        />
      </head>
      <body>
        <div className="grid-bg" />
        <div className="aurora" />
        <SessionProvider>
          <ProgressProvider total={totalTopics}>
            <TopicIndexProvider index={index}>
              <FocusProvider>
                <TopBar />
                {children}
                <SearchPalette />
                <ReadingGuide />
                <LinkPreview />
                <FocusControls />
              </FocusProvider>
            </TopicIndexProvider>
          </ProgressProvider>
        </SessionProvider>
      </body>
    </html>
  );
}
