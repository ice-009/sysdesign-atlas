'use client';

import { createContext, useContext, useMemo } from 'react';

export type IndexRow = {
  t: string; // title
  s: string; // summary
  u: string; // href
  sec: string; // section title
  acc: string; // section accent colour
  d: string; // difficulty
  g: string; // tags, space-joined
  m: number; // estimated minutes
};

const Ctx = createContext<IndexRow[]>([]);
const ByHref = createContext<Map<string, IndexRow>>(new Map());

/* The search index is built once on the server and used by two client features
   — the command palette and link previews. Passing it as a prop to both would
   serialise ~40KB twice into the RSC payload, so it is held here instead. */
export function TopicIndexProvider({
  index,
  children,
}: {
  index: IndexRow[];
  children: React.ReactNode;
}) {
  const byHref = useMemo(() => new Map(index.map((r) => [r.u, r])), [index]);
  return (
    <Ctx.Provider value={index}>
      <ByHref.Provider value={byHref}>{children}</ByHref.Provider>
    </Ctx.Provider>
  );
}

export const useTopicIndex = () => useContext(Ctx);
export const useTopicByHref = () => useContext(ByHref);
