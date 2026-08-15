/* Design altitude for a topic: HLD, LLD, both, or the background knowledge
   underneath them.

   This lives apart from lib/content.ts on purpose. Client components need the
   labels and colours, and content.ts reads the filesystem — importing it from
   the browser bundle pulls node:fs in and the build fails. */

export type Scope = 'HLD' | 'LLD' | 'Both' | 'Core';

export const SCOPES: readonly Scope[] = ['HLD', 'LLD', 'Both', 'Core'];

export const SCOPE_META: Record<Scope, { label: string; color: string; blurb: string }> = {
  HLD: { label: 'HLD', color: '#38bdf8', blurb: 'Services, stores and the traffic between them' },
  LLD: { label: 'LLD', color: '#f97316', blurb: 'Classes, interfaces and concurrency in one process' },
  Both: { label: 'HLD + LLD', color: '#a78bfa', blurb: 'Spans both altitudes' },
  Core: { label: 'Core', color: '#94a3b8', blurb: 'Background both rounds rest on' },
};

export const isScope = (v: unknown): v is Scope => SCOPES.includes(v as Scope);
