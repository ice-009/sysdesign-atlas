/* The HLD + LLD prep plan: what is due when, what spilled over, and how the
   spill-over gets caught up.

   The plan itself (lib/prep-plan.json) comes from the switch-prep tracker
   workbook via scripts/prep/import-tracker.py. Each sheet week runs Sunday to
   Saturday; inside a week, concepts come first, then design problems, then
   any milestone, spread over the study days so each day holds about the same
   number of minutes.

   Spill-over is anything not finished by the end of the day it was due. Two
   ways to absorb it:
     catch up   spread it over the next 3, 7 or 14 study days on top of what
                those days already hold, oldest first, filling the lightest
                days most — then the original plan carries on as written;
     re-plan    lay everything that's left, in plan order, evenly over the
                days until the plan's last day.
   "Auto" picks the shortest catch-up that keeps every day under DAILY_LIMIT
   minutes, else re-plans. Items marked Partial lead the spill-over.

   A day's list is computed from the state as of that morning: finishing an
   item ticks it off where it stands instead of reshuffling the day.

   Pure and dependency-free on purpose: the website imports this file, and the
   iPad build transpiles the same file into the offline app, so both always
   agree. Days are local calendar days, written 'YYYY-MM-DD'. */

export type Track = 'hld' | 'lld' | 'mile';
export type Status = 'done' | 'partial' | 'stuck' | '';
export type ItemType = 'Learn' | 'Design' | 'Practice' | 'Milestone';

export type Read = { sec: string; slug: string; anchor?: string };

export type Item = {
  id: string;
  track: Track;
  num: number;
  week: number;
  topic: string;
  title: string;
  type: ItemType | string;
  difficulty: string;
  minutes: number;
  hint: string;
  link: string;
  read: Read[];
  seed?: { s?: Status; at?: string; rev?: boolean; min?: number };
};

export type Week = { n: number; from: string; to: string };
export type Plan = { source: string; start: string; end: string; weeks: Week[]; items: Item[] };

/** What the reader recorded for one item. `at`: when it was finished (ms).
    `mv`: a day the reader moved it to. `upd`: last edit (ms). */
export type ItemState = { s: Status; at?: number; rev?: boolean; min?: number; note?: string; mv?: string; upd?: number };
export type States = Record<string, ItemState | undefined>;

/** `catchup`: 'auto', a number of study days, or 'end' (the rest of the plan).
    `off`: weekdays with nothing scheduled, 0 = Sunday. */
export type Settings = { catchup: 'auto' | 'end' | number; off: number[] };
export const DEFAULT_SETTINGS: Settings = { catchup: 'auto', off: [] };

export const DAILY_LIMIT = 150;
const WINDOWS = [3, 7, 14] as const;

export type Entry = {
  item: Item;
  state: ItemState;
  /** Day the sheet's week puts it on. */
  planned: string;
  /** Day it is due: the planned day, or the day it was moved to. */
  due: string;
  /** Day it sits on now (a catch-up day for spill-over). */
  slot: string;
  /** Whole days past due, as of this morning. */
  late: number;
  carried: boolean;
  doneToday: boolean;
  /** Finished today although it was scheduled for a later day. */
  ahead: boolean;
};

export type Day = { date: string; entries: Entry[]; minutes: number; off: boolean };

export type CatchupOption = { key: 'auto' | 'end' | number; days: number; peak: number; clearBy: string | null };

export type Schedule = {
  today: string;
  week: Week | null;
  started: boolean;
  finished: boolean;
  todayList: Entry[];
  spill: Entry[];
  days: Day[];
  catchup: { key: Settings['catchup']; chosen: CatchupOption['key']; days: number; clearBy: string | null; peak: number; options: CatchupOption[] };
  nextUp: Entry | null;
  stats: Stats;
};

export type Stats = {
  total: number;
  done: number;
  tracks: Record<Track, { total: number; done: number }>;
  weeks: { n: number; from: string; to: string; due: number; done: number }[];
  /** Items the sheet expected finished before today. */
  expected: number;
  behind: number;
  remainingMinutes: number;
  studyDaysLeft: number;
  /** Minutes a day the rest of the plan needs to finish on its last day. */
  pace: number;
  /** Minutes a day actually finished over the last 14 days. */
  recentPace: number;
  forecast: string | null;
  today: { items: number; done: number; minutes: number; doneMinutes: number };
  revisit: Entry[];
  stuck: Entry[];
  partial: Entry[];
  logged: number;
};

/* ---------- days ---------- */

const pad = (n: number) => String(n).padStart(2, '0');

export function parseDay(s: string): Date {
  const [y, m, d] = s.split('-').map(Number);
  return new Date(y, m - 1, d, 12);
}
export function dayKey(d: Date = new Date()): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
export function addDays(s: string, n: number): string {
  const d = parseDay(s);
  d.setDate(d.getDate() + n);
  return dayKey(d);
}
/** b − a in whole days. */
export function diffDays(a: string, b: string): number {
  return Math.round((parseDay(b).getTime() - parseDay(a).getTime()) / 864e5);
}
export const weekday = (s: string) => parseDay(s).getDay();

export function isOff(day: string, off: number[]): boolean {
  return off.length > 0 && off.length < 7 && off.includes(weekday(day));
}
export function nextStudyDay(day: string, off: number[]): string {
  let d = addDays(day, 1);
  while (isOff(d, off)) d = addDays(d, 1);
  return d;
}
function studyDaysFrom(day: string, count: number, off: number[]): string[] {
  const out: string[] = [];
  let d = day;
  while (isOff(d, off)) d = addDays(d, 1);
  while (out.length < count) {
    out.push(d);
    d = nextStudyDay(d, off);
  }
  return out;
}
function studyDaysBetween(from: string, to: string, off: number[]): number {
  let n = 0;
  for (let d = from; d <= to; d = addDays(d, 1)) if (!isOff(d, off)) n++;
  return n;
}

export function weekOf(plan: Plan, day: string): Week | null {
  return plan.weeks.find((w) => w.from <= day && day <= w.to) || null;
}

/* ---------- the plan's own dates ---------- */

const phase = (i: Item) => (i.type === 'Learn' ? 0 : i.type === 'Milestone' ? 2 : 1);

// Two tracks woven together in proportion, so a day mixes HLD and LLD.
function weave(a: Item[], b: Item[]): Item[] {
  const keyed = [
    ...a.map((it, k) => ({ it, key: (k + 0.5) / a.length, t: 0 })),
    ...b.map((it, k) => ({ it, key: (k + 0.5) / b.length, t: 1 })),
  ];
  keyed.sort((x, y) => x.key - y.key || x.t - y.t);
  return keyed.map((x) => x.it);
}

/** Every item in the order the plan meant them to be done. */
export function planOrder(plan: Plan): Item[] {
  const out: Item[] = [];
  for (const w of plan.weeks) {
    const its = plan.items.filter((i) => i.week === w.n);
    for (const p of [0, 1, 2]) {
      const of = (t: Track) => its.filter((i) => phase(i) === p && i.track === t).sort((x, y) => x.num - y.num);
      out.push(...weave(of('hld'), of('lld')), ...of('mile'));
    }
  }
  return out;
}

/** The day the sheet's week puts each item on. */
export function plannedDates(plan: Plan, off: number[] = []): Map<string, string> {
  const out = new Map<string, string>();
  const order = planOrder(plan);
  for (const w of plan.weeks) {
    let days: string[] = [];
    for (let d = w.from; d <= w.to; d = addDays(d, 1)) if (!isOff(d, off)) days.push(d);
    if (!days.length) days = [w.to];
    const its = order.filter((i) => i.week === w.n);
    for (const [id, day] of level(its, days, () => 0).slots) out.set(id, day);
  }
  return out;
}

/* Lays items, in order, over days that already hold base(day) minutes, so
   the days end up as even as whole items allow. Each day takes items while
   it stays under the level still needed by the days after it; an item goes
   to the next day once more than half of it would sit above that level. */
function level(items: { id: string; minutes: number }[], days: string[], base: (day: string) => number) {
  const slots = new Map<string, string>();
  const loads = new Map(days.map((d) => [d, base(d)]));
  if (!days.length) return { slots, loads };
  let remaining = items.reduce((a, e) => a + e.minutes, 0);
  const levelFrom = (k: number) => {
    let sum = remaining;
    for (let j = k; j < days.length; j++) sum += base(days[j]);
    return sum / (days.length - k);
  };
  let k = 0;
  let target = levelFrom(0);
  for (const it of items) {
    while (k < days.length - 1 && loads.get(days[k])! + it.minutes / 2 > target) {
      k++;
      target = levelFrom(k);
    }
    slots.set(it.id, days[k]);
    loads.set(days[k], loads.get(days[k])! + it.minutes);
    remaining -= it.minutes;
  }
  return { slots, loads };
}

/* ---------- state ---------- */

export function stateOf(item: Item, states: States): ItemState {
  const s = states[item.id];
  if (s) return s;
  const seed = item.seed;
  if (!seed) return { s: '' };
  return {
    s: seed.s || '',
    at: seed.at ? parseDay(seed.at).getTime() : undefined,
    rev: seed.rev,
    min: seed.min,
  };
}

const doneDay = (st: ItemState) => (st.s === 'done' ? (st.at ? dayKey(new Date(st.at)) : '0000-00-00') : null);

/* ---------- the schedule ---------- */

export function schedule(plan: Plan, states: States, today: string = dayKey(), settings: Settings = DEFAULT_SETTINGS, horizon = 14): Schedule {
  const off = (settings.off || []).filter((d) => d >= 0 && d < 7);
  const planned = plannedDates(plan, off);
  const order = planOrder(plan);
  const rank = new Map(order.map((it, k) => [it.id, k]));
  const byDue = (a: { due: string; item: Item }, b: { due: string; item: Item }) =>
    a.due < b.due ? -1 : a.due > b.due ? 1 : rank.get(a.item.id)! - rank.get(b.item.id)!;

  const all = order.map((item) => {
    const state = stateOf(item, states);
    const fin = doneDay(state);
    const p = planned.get(item.id) || plan.end;
    const due = state.s !== 'done' && state.mv ? state.mv : p;
    return { item, state, fin, planned: p, due };
  });
  // As of this morning: anything finished today still counts as open.
  const open = all.filter((e) => e.fin === null || e.fin >= today);
  // Anything half-done goes first: finish what you started.
  const spillRaw = open.filter((e) => e.due < today).sort((a, b) => Number(b.state.s === 'partial') - Number(a.state.s === 'partial') || byDue(a, b));
  const regular = open.filter((e) => e.due >= today).sort(byDue);
  const daysLeft = Math.max(1, studyDaysBetween(today, plan.end, off));
  const minutesOn = (list: typeof all, slots?: Map<string, string>) => {
    const m = new Map<string, number>();
    for (const e of list) {
      const d = slots ? slots.get(e.item.id) || e.due : e.due;
      m.set(d, (m.get(d) || 0) + e.item.minutes);
    }
    return m;
  };

  // Each option: where every open item lands, the heaviest day, and the day
  // the last spilled item is done.
  const optionFor = (key: CatchupOption['key']) => {
    const replan = key === 'end';
    const n = replan ? daysLeft : Math.max(1, Math.round(Number(key)));
    const days = studyDaysFrom(today, n, off);
    const fixed = replan ? regular.filter((e) => e.state.mv) : regular;
    const flowing = replan ? [...spillRaw, ...regular.filter((e) => !e.state.mv)] : spillRaw;
    const fixedOn = minutesOn(fixed);
    const { slots, loads } = level(
      flowing.map((e) => ({ id: e.item.id, minutes: e.item.minutes })),
      days,
      (d) => fixedOn.get(d) || 0
    );
    for (const e of fixed) slots.set(e.item.id, e.due);
    let peak = 0;
    for (const v of loads.values()) peak = Math.max(peak, v);
    if (!replan) for (const [d, v] of fixedOn) if (!loads.has(d)) peak = Math.max(peak, v);
    const clearBy = spillRaw.length ? spillRaw.map((e) => slots.get(e.item.id) || today).sort().pop()! : null;
    return { option: { key, days: n, peak, clearBy } as CatchupOption, slots };
  };
  const computed = [...WINDOWS.map((n) => optionFor(n)), optionFor('end')];
  let chosen = computed[computed.length - 1];
  if (settings.catchup === 'auto') chosen = computed.find((o) => o.option.peak <= DAILY_LIMIT) || chosen;
  else if (settings.catchup === 'end') chosen = computed[computed.length - 1];
  else chosen = computed.find((o) => o.option.key === settings.catchup) || optionFor(settings.catchup);
  const options = computed.map((o) => o.option);
  const slotOf = chosen.slots;

  const entry = (e: (typeof all)[number], slot: string): Entry => {
    const doneToday = e.fin === today;
    return {
      item: e.item,
      state: e.state,
      planned: e.planned,
      due: e.due,
      slot,
      late: e.due < today ? diffDays(e.due, today) : 0,
      carried: e.due < today,
      doneToday,
      ahead: doneToday && slot > today,
    };
  };

  const spill = spillRaw.map((e) => entry(e, slotOf.get(e.item.id) || today));
  const scheduled = [...spill, ...regular.map((e) => entry(e, slotOf.get(e.item.id) || e.due))];
  // Finished today ahead of time: shown in today's list, not on its own day.
  const byRank = (a: Entry, b: Entry) => rank.get(a.item.id)! - rank.get(b.item.id)!;
  const todayList = [
    ...scheduled.filter((e) => e.slot === today && e.carried),
    ...scheduled.filter((e) => e.slot === today && !e.carried).sort(byRank),
    ...scheduled.filter((e) => e.slot !== today && e.doneToday),
  ];

  const days: Day[] = [];
  for (let k = 0; k < horizon; k++) {
    const date = addDays(today, k);
    const entries = k === 0 ? todayList : scheduled.filter((e) => e.slot === date && !e.doneToday).sort((a, b) => Number(b.carried) - Number(a.carried) || byRank(a, b));
    days.push({ date, entries, minutes: entries.reduce((a, e) => a + e.item.minutes, 0), off: isOff(date, off) });
  }

  const nextUp = scheduled.filter((e) => e.slot > today && !e.doneToday).sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : byRank(a, b)))[0] || null;

  return {
    today,
    week: weekOf(plan, today),
    started: today >= plan.start,
    finished: all.every((e) => e.state.s === 'done'),
    todayList,
    spill,
    days,
    catchup: { key: settings.catchup, chosen: chosen.option.key, days: chosen.option.days, clearBy: chosen.option.clearBy, peak: chosen.option.peak, options },
    nextUp,
    stats: statsOf(plan, all, scheduled, todayList, today, off),
  };
}

type Row = { item: Item; state: ItemState; fin: string | null; planned: string; due: string };

function statsOf(plan: Plan, all: Row[], scheduled: Entry[], todayList: Entry[], today: string, off: number[]): Stats {
  const tracks: Stats['tracks'] = { hld: { total: 0, done: 0 }, lld: { total: 0, done: 0 }, mile: { total: 0, done: 0 } };
  for (const e of all) {
    tracks[e.item.track].total++;
    if (e.state.s === 'done') tracks[e.item.track].done++;
  }
  const done = all.filter((e) => e.state.s === 'done').length;
  const weeks = plan.weeks.map((w) => {
    const its = all.filter((e) => e.item.week === w.n);
    return { ...w, due: its.length, done: its.filter((e) => e.state.s === 'done').length };
  });
  const expected = all.filter((e) => e.planned < today).length;
  const behind = scheduled.filter((e) => e.carried).length;
  const remaining = all.filter((e) => e.state.s !== 'done');
  const remainingMinutes = remaining.reduce((a, e) => a + e.item.minutes, 0);
  const studyDaysLeft = Math.max(1, studyDaysBetween(today, plan.end, off));
  const since = addDays(today, -13);
  const recent = all.filter((e) => e.fin && e.fin >= since && e.fin <= today);
  const recentPace = recent.reduce((a, e) => a + (e.state.min || e.item.minutes), 0) / 14;
  // Only once there's a real pace to go on: a few finished items in two weeks
  // would otherwise "forecast" a finish years away.
  let forecast: string | null = null;
  if (!remaining.length) forecast = today;
  else if (recent.length >= 3 && recentPace >= 15) forecast = addDays(today, Math.ceil(remainingMinutes / recentPace));
  const find = (pred: (r: Row) => boolean) =>
    all
      .filter(pred)
      .map((r) => scheduled.find((e) => e.item.id === r.item.id) || { item: r.item, state: r.state, planned: r.planned, due: r.due, slot: r.due, late: 0, carried: false, doneToday: r.fin === today, ahead: false });
  return {
    total: all.length,
    done,
    tracks,
    weeks,
    expected,
    behind,
    remainingMinutes,
    studyDaysLeft,
    pace: Math.ceil(remainingMinutes / studyDaysLeft),
    recentPace: Math.round(recentPace),
    forecast,
    today: {
      items: todayList.length,
      done: todayList.filter((e) => e.doneToday).length,
      minutes: todayList.reduce((a, e) => a + e.item.minutes, 0),
      doneMinutes: todayList.filter((e) => e.doneToday).reduce((a, e) => a + e.item.minutes, 0),
    },
    revisit: find((r) => !!r.state.rev),
    stuck: find((r) => r.state.s === 'stuck'),
    partial: find((r) => r.state.s === 'partial'),
    logged: all.reduce((a, e) => a + (e.state.min || 0), 0),
  };
}

/* ---------- input from outside (the website's API) ---------- */

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** A state as stored: known fields only, each within bounds. */
export function cleanState(input: unknown): ItemState | null {
  if (!input || typeof input !== 'object') return null;
  const i = input as Record<string, unknown>;
  const s = ['done', 'partial', 'stuck', ''].includes(String(i.s ?? '')) ? (String(i.s ?? '') as Status) : null;
  if (s === null) return null;
  const out: ItemState = { s };
  if (s === 'done') out.at = typeof i.at === 'number' && i.at > 0 ? Math.floor(i.at) : Date.now();
  if (i.rev === true) out.rev = true;
  if (typeof i.min === 'number' && i.min > 0) out.min = Math.min(999, Math.round(i.min));
  if (typeof i.note === 'string' && i.note.trim()) out.note = i.note.slice(0, 4000);
  if (s !== 'done' && typeof i.mv === 'string' && DAY_RE.test(i.mv)) out.mv = i.mv;
  out.upd = Date.now();
  return out;
}

export function cleanSettings(input: unknown): Settings {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const c = i.catchup;
  const catchup: Settings['catchup'] = c === 'end' || c === 'auto' ? c : typeof c === 'number' && c >= 1 && c <= 60 ? Math.round(c) : 'auto';
  const off = Array.isArray(i.off) ? [...new Set(i.off.filter((d): d is number => Number.isInteger(d) && d >= 0 && d < 7))].sort() : [];
  return { catchup, off: off.length >= 7 ? [] : off };
}

/* ---------- labels ---------- */

export const TRACK_LABEL: Record<Track, string> = { hld: 'HLD', lld: 'LLD', mile: 'Milestone' };

export function weekFocus(plan: Plan, n: number): string {
  const seen: string[] = [];
  for (const it of plan.items) if (it.week === n && it.track !== 'mile' && !seen.includes(it.topic)) seen.push(it.topic);
  return seen.slice(0, 3).join(' · ');
}

/* ---------- back to the spreadsheet ---------- */

// The sheet's own spelling ("Sep", not the locale's "Sept").
export const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

const csvCell = (v: unknown) => {
  const s = v == null ? '' : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** The plan with your progress in the tracker's own columns, one row per
    item, ready to paste back into the workbook's tabs. */
export function toCsv(plan: Plan, states: States): string {
  const head = ['Track', 'Week', 'Dates', 'Topic', '#', 'Item', 'Difficulty', 'Status', 'Date Done', 'Revisit', 'Time (min)', 'Notes', 'Type', 'Link'];
  const fmt = (w: Week) => {
    const a = parseDay(w.from);
    const b = parseDay(w.to);
    const m = (d: Date) => MONTHS[d.getMonth()];
    return a.getMonth() === b.getMonth() ? `${a.getDate()}-${b.getDate()} ${m(b)}` : `${a.getDate()} ${m(a)}-${b.getDate()} ${m(b)}`;
  };
  const rows = plan.items.map((it) => {
    const st = stateOf(it, states);
    const w = plan.weeks.find((x) => x.n === it.week);
    const title = it.type === 'Learn' ? `Learn: ${it.title}` : it.title;
    return [
      TRACK_LABEL[it.track],
      it.week,
      w ? fmt(w) : '',
      it.topic,
      it.num,
      title,
      it.difficulty,
      st.s ? st.s[0].toUpperCase() + st.s.slice(1) : '',
      st.s === 'done' && st.at ? dayKey(new Date(st.at)) : '',
      st.rev ? 'Y' : '',
      st.min || '',
      [it.hint, st.note].filter(Boolean).join(' — '),
      it.type,
      it.link,
    ];
  });
  return [head, ...rows].map((r) => r.map(csvCell).join(',')).join('\n') + '\n';
}
