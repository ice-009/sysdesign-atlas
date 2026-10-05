'use client';

import { useEffect, useMemo, useState } from 'react';
import Link from 'next/link';
import Reveal from './Reveal';
import { IconCheck, IconChevron } from './Icons';
import rawPlan from '@/lib/prep-plan.json';
import {
  type Entry,
  type ItemState,
  type Plan,
  type Settings,
  type States,
  DEFAULT_SETTINGS,
  MONTHS,
  TRACK_LABEL,
  cleanSettings,
  dayKey,
  diffDays,
  parseDay,
  schedule,
  weekFocus,
} from '@/lib/prep';

const plan = rawPlan as Plan;
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const TRACK_COLOR = { hld: '#38bdf8', lld: '#a78bfa', mile: '#f59e0b' } as const;

const fmtMin = (m: number) => (m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)}h${m % 60 ? ` ${Math.round(m % 60)}m` : ''}`);
const fmtDay = (day: string) => {
  const d = parseDay(day);
  return `${DAYS[d.getDay()]} ${d.getDate()} ${MONTHS[d.getMonth()]}`;
};
function relDay(day: string, today: string) {
  const n = diffDays(today, day);
  if (n === 0) return 'today';
  if (n === 1) return 'tomorrow';
  return fmtDay(day);
}
const href = (e: Entry) => {
  const r = e.item.read[0];
  return r ? `/learn/${r.sec}/${r.slug}${r.anchor ? `#${r.anchor}` : ''}` : '';
};

/* The HLD + LLD plan from the switch-prep tracker: today's list (tick items
   off here), what spilled over and when it gets caught up, the next few days.
   Same scheduler as the iPad app's Plan page (lib/prep.ts), same state — it
   lives in the sync log, so ticks here reach the iPad on its next sync. */
export default function PlanPanel({ initialStates, initialSettings }: { initialStates: States; initialSettings: unknown }) {
  const [states, setStates] = useState<States>(initialStates);
  const [error, setError] = useState('');
  const [showSpill, setShowSpill] = useState(false);
  // Today is the reader's own calendar day, so it's only known in the browser.
  const [today, setToday] = useState<string | null>(null);
  const settings: Settings = useMemo(() => (initialSettings ? cleanSettings(initialSettings) : DEFAULT_SETTINGS), [initialSettings]);

  useEffect(() => {
    setToday(dayKey());
    const id = setInterval(() => setToday(dayKey()), 60_000);
    return () => clearInterval(id);
  }, []);

  const s = useMemo(() => (today ? schedule(plan, states, today, settings) : null), [states, today, settings]);

  async function toggle(e: Entry) {
    const prev = states[e.item.id];
    const done = e.state.s === 'done';
    const next: ItemState = done ? { ...e.state, s: '', at: undefined } : { ...e.state, s: 'done', at: Date.now() };
    delete next.mv;
    setStates((m) => ({ ...m, [e.item.id]: next }));
    setError('');
    try {
      const res = await fetch('/api/prep', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ item: e.item.id, state: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
    } catch {
      setStates((m) => ({ ...m, [e.item.id]: prev }));
      setError('Couldn’t save that — check your connection and try again.');
    }
  }

  if (!s) {
    return (
      <div className="mt-8 h-[220px] rounded-2xl border" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }} />
    );
  }

  const st = s.stats;
  const left = s.todayList.filter((e) => !e.doneToday);
  const spillOpen = s.spill.filter((e) => !e.doneToday);
  const focus = s.week ? weekFocus(plan, s.week.n) : '';

  const row = (e: Entry, slot = false) => {
    const done = e.state.s === 'done';
    const link = href(e);
    return (
      <li key={e.item.id} className="flex items-center gap-3 py-2.5" style={{ borderTop: '1px solid var(--border)' }}>
        <button
          type="button"
          onClick={() => toggle(e)}
          aria-pressed={done}
          aria-label={done ? 'Mark not done' : 'Mark done'}
          className="grid h-[26px] w-[26px] shrink-0 place-items-center rounded-full border-2 transition-colors"
          style={{
            borderColor: done ? '#10b981' : 'var(--border-strong, var(--border))',
            background: done ? '#10b981' : 'transparent',
            color: done ? '#fff' : 'transparent',
          }}
        >
          <IconCheck size={13} />
        </button>
        <div className="min-w-0 flex-1">
          <div
            className="text-[14.5px] font-semibold leading-snug"
            style={{ color: done ? 'var(--text-dim)' : 'var(--text)', textDecoration: done ? 'line-through' : undefined }}
          >
            {e.item.title}
          </div>
          <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px]" style={{ color: 'var(--text-dim)' }}>
            <span
              className="rounded px-1.5 py-px text-[10px] font-extrabold uppercase tracking-wider"
              style={{
                // Mixed toward the text colour so the label reads on light and dark alike.
                color: `color-mix(in srgb, ${TRACK_COLOR[e.item.track]} 72%, var(--text))`,
                background: `color-mix(in srgb, ${TRACK_COLOR[e.item.track]} 15%, transparent)`,
              }}
            >
              {TRACK_LABEL[e.item.track]}
            </span>
            <span>{[e.item.type === 'Milestone' ? 'Mock' : e.item.type, e.item.difficulty, fmtMin(e.item.minutes)].filter(Boolean).join(' · ')}</span>
            {e.carried && !done && (
              <span className="rounded-full px-2 font-bold" style={{ color: '#d97706', background: 'color-mix(in srgb, #f59e0b 15%, transparent)' }}>
                {e.late === 1 ? '1 day late' : `${e.late} days late`}
              </span>
            )}
            {e.ahead && <span className="font-bold" style={{ color: '#10b981' }}>ahead of plan</span>}
            {slot && !done && <span className="font-semibold" style={{ color: 'var(--accent-text)' }}>→ {relDay(e.slot, s.today)}</span>}
          </div>
        </div>
        {link && (
          <Link
            href={link}
            className="shrink-0 rounded-lg border px-3 py-1.5 text-[13px] font-semibold transition-colors hover:bg-[var(--bg-inset)]"
            style={{ borderColor: 'var(--border)', color: 'var(--text)' }}
          >
            {e.item.type === 'Learn' ? 'Read' : 'Open'}
          </Link>
        )}
      </li>
    );
  };

  return (
    <Reveal>
      <section className="mt-8 rounded-2xl border p-6" style={{ borderColor: 'var(--border)', background: 'var(--panel)' }}>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
              Today’s plan · {fmtDay(s.today)}
            </div>
            <h2 className="mt-1 text-[19px] font-bold" style={{ color: 'var(--text)' }}>
              {s.finished
                ? 'Every HLD and LLD item is done'
                : s.todayList.length
                  ? left.length
                    ? `${left.length} to go · about ${fmtMin(left.reduce((a, e) => a + e.item.minutes, 0))}`
                    : 'Today’s list is done'
                  : s.started
                    ? 'Nothing scheduled today'
                    : `The plan starts ${fmtDay(plan.start)}`}
            </h2>
            <p className="mt-1 text-[13px]" style={{ color: 'var(--text-dim)' }}>
              {s.week ? `Week ${s.week.n} of ${plan.weeks.length}${focus ? ` · ${focus}` : ''}` : s.started ? `Plan ended ${fmtDay(plan.end)}` : ''}
            </p>
          </div>
          <div className="flex gap-5 text-right">
            {(['hld', 'lld'] as const).map((t) => (
              <div key={t}>
                <div className="font-mono text-[22px] font-bold leading-none" style={{ color: TRACK_COLOR[t] }}>
                  {st.tracks[t].done}
                  <span className="text-[13px]" style={{ color: 'var(--text-dim)' }}>
                    /{st.tracks[t].total}
                  </span>
                </div>
                <div className="mt-1 text-[11.5px] font-semibold" style={{ color: 'var(--text-dim)' }}>
                  {TRACK_LABEL[t]} done
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="mt-5 grid gap-6 lg:grid-cols-[1.5fr_1fr]">
          <div>
            {s.todayList.length ? (
              <ul className="-mt-px">{s.todayList.map((e) => row(e))}</ul>
            ) : (
              <p className="text-[13.5px]" style={{ color: 'var(--text-dim)' }}>
                {s.nextUp ? `Next up: ${s.nextUp.item.title} (${relDay(s.nextUp.slot, s.today)}).` : 'Nothing to do.'}
              </p>
            )}
            {error && (
              <p className="mt-2 text-[13px]" style={{ color: '#e11d48' }}>
                {error}
              </p>
            )}
          </div>

          <div className="grid content-start gap-4">
            <div className="rounded-xl p-4" style={{ background: spillOpen.length ? 'color-mix(in srgb, #f59e0b 10%, transparent)' : 'var(--bg-inset)' }}>
              <div className="text-[13.5px] font-bold" style={{ color: spillOpen.length ? '#d97706' : 'var(--text)' }}>
                {spillOpen.length ? `${spillOpen.length} spilled over` : 'Nothing spilled over'}
              </div>
              <p className="mt-1 text-[12.5px] leading-relaxed" style={{ color: 'var(--text-soft)' }}>
                {spillOpen.length
                  ? s.catchup.chosen === 'end'
                    ? `Re-planned: everything left, evenly to ${fmtDay(plan.end)} — about ${fmtMin(st.pace)} a day.`
                    : `Caught up by ${fmtDay(s.catchup.clearBy || s.today)}, on top of each day’s own items — the heaviest day is ${fmtMin(s.catchup.peak)}.`
                  : 'You’re on the plan.'}
              </p>
              {spillOpen.length > 0 && (
                <button
                  type="button"
                  onClick={() => setShowSpill((v) => !v)}
                  className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-semibold"
                  style={{ color: 'var(--accent-text)' }}
                >
                  {showSpill ? 'Hide the list' : 'Show when each one happens'}
                  <span style={{ transform: showSpill ? 'rotate(90deg)' : undefined, display: 'inline-flex' }}>
                    <IconChevron size={12} />
                  </span>
                </button>
              )}
            </div>

            <div>
              <div className="mb-2 text-[11px] font-bold uppercase tracking-wider" style={{ color: 'var(--text-dim)' }}>
                Coming up
              </div>
              <div className="grid grid-cols-6 gap-1.5">
                {s.days.slice(1, 7).map((d) => {
                  const h = Math.min(1, d.minutes / 180);
                  return (
                    <div key={d.date} className="text-center" title={d.entries.map((e) => e.item.title).join('\n')}>
                      <div className="flex h-14 items-end rounded-md" style={{ background: 'var(--bg-inset)' }}>
                        <div className="w-full rounded-md" style={{ height: `${h * 100}%`, background: d.off ? 'transparent' : 'color-mix(in srgb, var(--accent) 55%, transparent)' }} />
                      </div>
                      <div className="mt-1 text-[11px] font-semibold" style={{ color: 'var(--text-dim)' }}>
                        {DAYS[parseDay(d.date).getDay()]}
                      </div>
                      <div className="text-[10.5px]" style={{ color: 'var(--text-dim)' }}>
                        {d.off ? 'off' : d.entries.length ? fmtMin(d.minutes) : '—'}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </div>
        </div>

        {showSpill && (
          <ul className="mt-4">{s.spill.map((e) => row(e, true))}</ul>
        )}

        <p className="mt-5 text-[12px]" style={{ color: 'var(--text-dim)' }}>
          From the HLD and LLD tabs of your switch-prep tracker. The full plan — catch-up choices, days off, notes, timers — is on the iPad
          app’s Plan page; ticks sync both ways.
        </p>
      </section>
    </Reveal>
  );
}
