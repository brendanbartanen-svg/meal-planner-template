// Moving a dinner to another day of the week being cooked: the Week tab's Move
// control → POST /api/runs/move → a light `move` run (prompts/move.md).
// Everything here is pure (no I/O, no store): the eligibility rules live in
// checkMove and nowhere else. buildState attaches moveTargets() to the cooking
// week's meals (`meal.moveTo`), so the client never re-derives them, and the
// endpoint re-validates the tapped pair with the same function.
import { prepKey, type LogRow, type MoveTarget, type ParsedPlan, type PlanMeal } from './parse.ts';
import { weekDates, weekDays, weekIdForDate, type DayName } from './weeks.ts';

/** The part of a capture (captures.json, keyed by ISO date) that makes a night "logged". */
export type CaptureLike = { rating?: number; dish?: string } | undefined;

/**
 * Is this night already logged? In the file: a Log-table row for the day with
 * a rating or a non-empty "Actually cooked". In the app: a capture for its
 * date with a rating or a dish (a dish correction, or "skipped — …" from
 * Didn't cook), folded or not. The same rule close-out readiness (state.ts
 * `missing`, 10-week.js syncCloseReady) and the tonight notice (notify.ts) use.
 */
export function nightLogged(log: readonly LogRow[], day: DayName, cap: CaptureLike): boolean {
  const l = log.find((x) => x.day === day);
  if (l && (l.rating !== undefined || (l.cooked && l.cooked !== ''))) return true;
  return !!(cap && (cap.rating !== undefined || cap.dish));
}

export interface MoveContext {
  plan: ParsedPlan;
  /** The kitchen's today, ISO. */
  today: string;
  /** captures.json as loaded: ISO date → entry. */
  captures: Readonly<Record<string, CaptureLike>>;
}

export type MoveCheck = { ok: true; target: MoveTarget } | { ok: false; why: string };

const DAY_LONG: Record<DayName, string> = {
  Sat: 'Saturday', Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday',
};
export const dayLong = (d: DayName): string => DAY_LONG[d] ?? d;

// A meal whose Status says the night is settled has nothing left to move.
const SETTLED = /^(rejected|skipped|cooked|substituted)$/i;

/**
 * May the dinner on `from` move to `to`? The rules:
 *  - only the week that contains today, and only once it is `locked`;
 *  - the source is a cook night (not flexible, not settled) that is not logged;
 *  - the target is another day of the same week, today or later, not logged;
 *  - a flexible target is a plain move (the source day becomes the flexible
 *    night); a target holding another unlogged dinner is a swap, allowed only
 *    while the source day is itself today or later: a straggler from earlier
 *    in the week may only move onto a flexible night.
 * A day with no row, or more than one, in the Plan table is never a source or
 * a target (the run swaps exactly two rows).
 */
export function checkMove(ctx: MoveContext, from: DayName, to: DayName): MoveCheck {
  const { plan, today, captures } = ctx;
  const no = (why: string): MoveCheck => ({ ok: false, why });
  if (plan.status !== 'locked') return no(`${plan.week} is ${plan.status}: moving a dinner is for a locked week.`);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(today) || weekIdForDate(new Date(`${today}T00:00:00Z`)) !== plan.week) {
    return no(`${plan.week} is not the week being cooked: a dinner moves within the current week only.`);
  }
  const dates = weekDates(plan.week);
  const rowsOn = (d: DayName): PlanMeal[] => plan.meals.filter((m) => m.day === d);

  const src = rowsOn(from);
  const meal = src[0];
  if (src.length !== 1 || !meal || meal.flexible || !dates[from]) return no(`${plan.week} has no cook night on ${from}.`);
  if (SETTLED.test(meal.status)) return no(`${dayLong(from)}'s dinner is marked ${meal.status.toLowerCase()}: there is nothing to move.`);
  if (nightLogged(plan.log, from, captures[dates[from]])) return no(`${dayLong(from)}'s dinner is already logged.`);

  if (to === from) return no(`That dinner is already on ${dayLong(to)}.`);
  const toDate = dates[to];
  if (!weekDays(plan.week).includes(to) || !toDate) return no(`${plan.week} has no ${to}.`);
  if (toDate < today) return no(`${dayLong(to)} has already passed.`);
  const dst = rowsOn(to);
  const other = dst[0];
  if (dst.length !== 1 || !other) return no(`${plan.week} has no single ${to} row in its Plan table.`);
  if (nightLogged(plan.log, to, captures[toDate])) return no(`${dayLong(to)} is already logged.`);
  if (other.flexible) return { ok: true, target: { day: to, date: toDate } };

  if (SETTLED.test(other.status)) return no(`${dayLong(to)}'s dinner is marked ${other.status.toLowerCase()}.`);
  if (dates[from]! < today) {
    return no(`${dayLong(from)} has passed, so its dinner can only move to a flexible night, and ${dayLong(to)} has a dinner planned.`);
  }
  return { ok: true, target: { day: to, date: toDate, swapsWith: other.dish } };
}

/** Every allowed move of the plan, by source day, targets in the week's own day order. Days with none are absent. */
export function moveTargets(ctx: MoveContext): Partial<Record<DayName, MoveTarget[]>> {
  const out: Partial<Record<DayName, MoveTarget[]>> = {};
  const order = weekDays(ctx.plan.week);
  for (const from of order) {
    const list: MoveTarget[] = [];
    for (const to of order) {
      if (to === from) continue;
      const r = checkMove(ctx, from, to);
      if (r.ok) list.push(r.target);
    }
    if (list.length) out[from] = list;
  }
  return out;
}

/**
 * The plan file's Prep-timeline lines whose box is ticked in checks.json,
 * exactly as written (trimmed). Prep ticks are keyed by a slug of the line
 * text, so a reworded line comes back unticked: the move run is told to leave
 * these lines byte-identical, and a thaw already done stays done.
 */
export function donePrepLines(raw: string, plan: ParsedPlan, checked: Readonly<Record<string, unknown>>): string[] {
  const done = new Set(plan.prep.filter((p) => checked[p.key]).map((p) => p.key));
  if (!done.size) return [];
  const out: string[] = [];
  for (const rawLine of raw.split('\n')) {
    const t = rawLine.trim();
    const m = t.match(/^- \[[ xX]\]\s+(.*)$/);
    if (m && done.has(prepKey(plan.week, m[1]!.trim()))) out.push(t);
  }
  return out;
}

/** What prompts/move.md is filled with, besides {{WEEK}} {{DATES}} {{TODAY}}. Its keys ARE the placeholder names. */
export interface MoveFills {
  MOVE_FROM: string; MOVE_FROM_DATE: string; MOVE_TO: string; MOVE_TO_DATE: string;
  MOVE_DISH: string; MOVE_KIND: string; DONE_PREP: string;
}
/** The three every run prompt gets, plus MoveFills' keys: exactly the placeholders move.md may use (selftest). */
export const MOVE_PLACEHOLDERS = [
  'WEEK', 'DATES', 'TODAY', 'MOVE_FROM', 'MOVE_FROM_DATE', 'MOVE_TO', 'MOVE_TO_DATE', 'MOVE_DISH', 'MOVE_KIND', 'DONE_PREP',
] as const;

/** Fill values for a move of `from` → `to`. No validation here: the route ran checkMove first. */
export function moveFills(plan: ParsedPlan | undefined, move: { day: DayName; to: DayName }, doneLines: readonly string[]): MoveFills {
  const dates = plan ? weekDates(plan.week) : ({} as Partial<Record<DayName, string>>);
  const meal = plan?.meals.find((m) => m.day === move.day && !m.flexible);
  const other = plan?.meals.find((m) => m.day === move.to);
  const from = `${dayLong(move.day)} (${move.day} ${dates[move.day] ?? '?'})`;
  const kind = other && !other.flexible
    ? `${dayLong(move.to)} holds another dinner that has not been cooked yet (${other.dish}), so this is a **swap**: that dinner moves to ${from}.`
    : `${dayLong(move.to)} is a flexible night, so this is a **plain move**: ${dayLong(move.day)} becomes the flexible night.`;
  return {
    MOVE_FROM: move.day,
    MOVE_FROM_DATE: dates[move.day] ?? '',
    MOVE_TO: move.to,
    MOVE_TO_DATE: dates[move.to] ?? '',
    MOVE_DISH: meal?.dish ?? '(no cook night on that day)',
    MOVE_KIND: kind,
    DONE_PREP: doneLines.length ? doneLines.join('\n') : '(none: no prep task is ticked this week)',
  };
}
