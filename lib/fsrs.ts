/* FSRS-5 — the Free Spaced Repetition Scheduler — for Atlas's recall cards.

   Each card's memory is held as three numbers (the "DSR" model):

     stability S       days until the chance of recalling it falls to 90%
     difficulty D      1 (easy) … 10 (hard): how much a review helps
     retrievability R  the chance of recalling it right now; it decays with
                       time since the last review: R = (1 + F·t/S)^C

   After each attempt the reader grades themself Again, Hard, Good or Easy,
   and S and D move by the formulas below, which the FSRS project fitted to
   hundreds of millions of real reviews. The next review is set for when R
   is predicted to reach the target retention (90% by default): just before
   the card would be forgotten.

   Weights are FSRS-5's published defaults and the formulas follow its
   reference implementation. Same-day repeats (a card failed and tried again
   in one sitting) use FSRS-5's short-term stability rule.

   Pure and dependency-free: the iPad build transpiles this file into the
   offline app. Times are epoch milliseconds; intervals are days. */

export type Grade = 1 | 2 | 3 | 4;
export type Step = 'new' | 'learning' | 'review' | 'relearning';

export type CardState = {
  s: number; //      stability, days
  d: number; //      difficulty, 1–10
  due: number; //    when it's next due (ms)
  last: number; //   when it was last reviewed (ms)
  reps: number; //   reviews so far
  lapses: number; // times forgotten after being learned
  step: Step;
};

export type Options = { target: number; maxDays: number };
export const DEFAULTS: Options = { target: 0.9, maxDays: 365 };

export const W = [
  0.40255, 1.18385, 3.173, 15.69105, 7.1949, 0.5345, 1.4604, 0.0046, 1.54575, 0.1192, 1.01925, 1.9395,
  0.11, 0.29605, 2.2698, 0.2315, 2.9898, 0.51655, 0.6621,
];

const F = 19 / 81;
const C = -0.5;
const MIN = 60_000;
const DAY = 86_400_000;
export const AGAIN_DELAY = 1 * MIN; //        a failed new card comes back within the sitting
export const RELEARN_DELAY = 10 * MIN; //     a forgotten card, a little later

const clampD = (d: number) => Math.min(10, Math.max(1, d));
const clampS = (s: number) => Math.max(0.01, s);

/** Chance of recalling a card `elapsedDays` after a review, given its stability. */
export function retrievability(elapsedDays: number, s: number): number {
  return Math.pow(1 + (F * Math.max(0, elapsedDays)) / s, C);
}

/** Days until retrievability falls to `target`. At the default 90%, that's S. */
export function intervalDays(s: number, target = DEFAULTS.target): number {
  return (s / F) * (Math.pow(target, 1 / C) - 1);
}

export function initialDifficulty(g: Grade): number {
  return clampD(W[4] - Math.exp(W[5] * (g - 1)) + 1);
}

export function nextDifficulty(d: number, g: Grade): number {
  const delta = -W[6] * (g - 3);
  const damped = d + (delta * (10 - d)) / 9; // smaller steps near the top
  return clampD(W[7] * initialDifficulty(4) + (1 - W[7]) * damped); // drift back toward the mean
}

export function stabilityAfterRecall(d: number, s: number, r: number, g: Grade): number {
  const hard = g === 2 ? W[15] : 1;
  const easy = g === 4 ? W[16] : 1;
  return clampS(s * (1 + Math.exp(W[8]) * (11 - d) * Math.pow(s, -W[9]) * (Math.exp(W[10] * (1 - r)) - 1) * hard * easy));
}

export function stabilityAfterLapse(d: number, s: number, r: number): number {
  const fresh = W[11] * Math.pow(d, -W[12]) * (Math.pow(s + 1, W[13]) - 1) * Math.exp(W[14] * (1 - r));
  return clampS(Math.min(s, fresh));
}

export function shortTermStability(s: number, g: Grade): number {
  return clampS(s * Math.exp(W[17] * (g - 3 + W[18])));
}

/** Local midnight of the day `days` after `now` — review cards fall due at the
    start of their day, so a day's reviews are all available together. */
function dueDay(now: number, days: number): number {
  const d = new Date(now + days * DAY);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function scheduleDays(s: number, o: Options): number {
  return Math.min(o.maxDays, Math.max(1, Math.round(intervalDays(s, o.target))));
}

export function newCard(): CardState {
  return { s: 0, d: 0, due: 0, last: 0, reps: 0, lapses: 0, step: 'new' };
}

/** The card's state after the reader grades it `g` at time `now`. */
export function review(card: CardState | null | undefined, g: Grade, now: number, opts: Partial<Options> = {}): CardState {
  const o = { ...DEFAULTS, ...opts };
  const c = card && card.step !== 'new' ? card : null;

  if (!c) {
    const s = W[g - 1];
    const d = initialDifficulty(g);
    if (g === 1) return { s, d, due: now + AGAIN_DELAY, last: now, reps: 1, lapses: 0, step: 'learning' };
    return { s, d, due: dueDay(now, scheduleDays(s, o)), last: now, reps: 1, lapses: 0, step: 'review' };
  }

  const elapsed = (now - c.last) / DAY;
  const d = nextDifficulty(c.d, g);

  // Again within the same day (still learning, or relearning after a lapse).
  if (elapsed < 1 && (c.step === 'learning' || c.step === 'relearning')) {
    const s = shortTermStability(c.s, g);
    if (g === 1) return { ...c, s, d, due: now + (c.step === 'learning' ? AGAIN_DELAY : RELEARN_DELAY), last: now, reps: c.reps + 1 };
    return { ...c, s, d, due: dueDay(now, scheduleDays(s, o)), last: now, reps: c.reps + 1, step: 'review' };
  }

  const r = retrievability(elapsed, c.s);
  if (g === 1) {
    const s = stabilityAfterLapse(c.d, c.s, r);
    return { s, d, due: now + RELEARN_DELAY, last: now, reps: c.reps + 1, lapses: c.lapses + 1, step: 'relearning' };
  }
  const s = elapsed < 1 ? shortTermStability(c.s, g) : stabilityAfterRecall(c.d, c.s, r, g);
  return { s, d, due: dueDay(now, scheduleDays(s, o)), last: now, reps: c.reps + 1, lapses: c.lapses, step: 'review' };
}

/** What each grade would do — shown on the buttons ("10 min", "3 d"). */
export function preview(card: CardState | null | undefined, now: number, opts: Partial<Options> = {}): Record<Grade, CardState> {
  return { 1: review(card, 1, now, opts), 2: review(card, 2, now, opts), 3: review(card, 3, now, opts), 4: review(card, 4, now, opts) };
}

export function isDue(card: CardState | null | undefined, now: number): boolean {
  return !!card && card.step !== 'new' && card.due <= now;
}

/** Chance of recalling it right now. */
export function recallChance(card: CardState, now: number): number {
  if (card.step === 'new' || !card.last) return 0;
  return retrievability((now - card.last) / DAY, card.s);
}

/** "1 min", "10 min", "3 d", "2 mo", "1.2 y" — for an interval from now. */
export function formatInterval(ms: number): string {
  const m = Math.max(1, Math.round(ms / MIN));
  if (m < 60) return `${m} min`;
  const h = Math.round(m / 60);
  if (h < 20) return `${h} h`;
  const days = Math.max(1, Math.round(ms / DAY));
  if (days < 31) return `${days} d`;
  if (days < 365) return `${Math.round(days / 30)} mo`;
  return `${(days / 365).toFixed(1).replace(/\.0$/, '')} y`;
}

/** A card counts as mature once it would be remembered for three weeks. */
export const isMature = (card: CardState) => card.step === 'review' && card.s >= 21;
