// Week and date math: ISO primitives, the Monday→Saturday cutover scheme,
// and prep due-date resolution. Pure functions, no I/O.

// ---------- ISO weeks ----------
// All week math on UTC dates that carry the *local* calendar date, so "today"
// means the kitchen's today regardless of the server's TZ offset.

// MEMBERSHIP SET, NOT AN ORDER. Since the Saturday cutover (see the week
// scheme block below) each week carries its own day order, so nothing may
// derive a date offset from an index into DAYS — use weekDays(week) for the
// per-week order and weekDates(week) for the dates. This list is only "is this
// string a day name?" (parser guards, planning-notes regex, feedback
// validation).
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type DayName = (typeof DAYS)[number];

// Week-start-agnostic day-name lookup: index by Date#getUTCDay() (0 = Sunday).
const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const satisfies readonly DayName[];

export function todayUTC(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

export function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // ISO week is the week of its Thursday
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// The ISO Monday *contained in* the week — the anchor week ids are derived
// from. Since the 2026-08-08 cutover this is no longer the week's first day
// (Saturday-start weeks begin two days earlier); use startOfWeek() for that.
export function mondayOf(weekId: string): Date {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`bad week id: ${weekId}`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const w1Monday = new Date(jan4);
  w1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  w1Monday.setUTCDate(w1Monday.getUTCDate() + (Number(m[2]) - 1) * 7);
  return w1Monday;
}

// Pure ISO id-sequence arithmetic. Week ids stay consecutive ISO numbers
// across the Saturday cutover (…W32, W33, W34…), so this needs no scheme
// awareness — it only ever walks the id sequence.
export function addWeeks(weekId: string, n: number): string {
  const d = mondayOf(weekId);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return isoWeekId(d);
}

export const fmtISO = (d: Date) => d.toISOString().slice(0, 10);
export const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

// ---------- week scheme (the Monday→Saturday cutover) ----------
// THE ONLY PLACE THE CUTOVER EXISTS. Everything above is ISO primitives;
// everything below (and every caller) goes through this layer.
//
// From 2026-08-08 the household's week runs Saturday → Friday, because
// Saturday morning is shopping day and should be day 1 of the week it stocks.
// Week ids keep their shape and their sequence:
//   • id = `YYYY-Wnn` of the ISO week containing the week's Monday, so
//     Sat 2026-08-08 → Fri 2026-08-14 is 2026-W33 (its Monday is Aug 10).
//     For a date d in the Saturday era, Sat+2 and Fri+2 both land inside that
//     Monday's ISO week, hence weekIdForDate's `isoWeekId(d + 2 days)`.
//   • ids stay consecutive, so addWeeks() is untouched.
// Three eras, in this order:
//   2026-W33 and later — Sat…Fri (7 days)
//   2026-W32           — truncated to Mon 08-03 … Fri 08-07 (5 days); the
//                        old Sat/Sun tail was absorbed by W33
//   2026-W31 and older — Mon…Sun (7 days), frozen history
const SAT_ERA_START = '2026-08-08';       // first Saturday-start calendar date
const SAT_ERA_FIRST_WEEK = '2026-W33';    // first Saturday-start week id
const TRUNCATED_WEEK = '2026-W32';        // last Monday-start week, cut to Mon–Fri

// Week-id string comparison is safe throughout: ids are zero-padded and
// year-first, so lexical order is chronological order.
export const isSatEra = (weekId: string) => weekId >= SAT_ERA_FIRST_WEEK;

/** The week id a calendar date belongs to, under whichever scheme covers it. */
export function weekIdForDate(d: Date): string {
  return fmtISO(d) >= SAT_ERA_START ? isoWeekId(addDays(d, 2)) : isoWeekId(d);
}

/** The week's days in order, first day first. Length is the week's length. */
export function weekDays(weekId: string): DayName[] {
  if (isSatEra(weekId)) return ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (weekId === TRUNCATED_WEEK) return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
}

/** First calendar date of the week. */
export function startOfWeek(weekId: string): Date {
  const mon = mondayOf(weekId);
  return isSatEra(weekId) ? addDays(mon, -2) : mon;
}

/** Last calendar date of the week (inclusive). */
export function endOfWeek(weekId: string): Date {
  return addDays(startOfWeek(weekId), weekDays(weekId).length - 1);
}

// Day name → ISO date for one week. Declared as a full Record because every
// caller indexes it by a parsed day name; in practice it is PARTIAL (W32 has
// only 5 keys), and `noUncheckedIndexedAccess` keeps callers honest about that.
export function weekDates(weekId: string): Record<DayName, string> {
  const start = startOfWeek(weekId);
  const out = {} as Record<DayName, string>;
  weekDays(weekId).forEach((day, i) => { out[day] = fmtISO(addDays(start, i)); });
  return out;
}

// Day-of-week labels come from the actual endpoints, so this reads
// "Mon Jul 27 – Sun Aug 2, 2026" for an old week and
// "Sat Aug 8 – Fri Aug 14, 2026" for a Saturday-start one.
export function humanRange(weekId: string): string {
  const a = startOfWeek(weekId);
  const b = endOfWeek(weekId);
  const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${DOW_NAME[a.getUTCDay()]} ${f(a)} – ${DOW_NAME[b.getUTCDay()]} ${f(b)}, ${weekId.slice(0, 4)}`;
}

// Prep labels look like "Sun 26, night" / "Thu 30, morning" / "Mon, night".
// Resolve day-of-month within [start of week − 7, end of week] (thaws are
// often due before the week starts); a bare weekday resolves inside the week.
// The alternation below is a membership test — its order is irrelevant.
export function prepDueDate(label: string, week: string): string | undefined {
  const m = label.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*(\d{1,2})?/i);
  if (!m) return undefined;
  const dayName = (m[1]![0]!.toUpperCase() + m[1]!.slice(1, 3).toLowerCase()) as DayName;
  const dom = m[2] ? Number(m[2]) : undefined;
  const dates = weekDates(week);
  if (dom === undefined) return dates[dayName];
  const start = startOfWeek(week);
  const lastOff = weekDays(week).length - 1;
  for (let off = -7; off <= lastOff; off++) {
    const d = addDays(start, off);
    if (d.getUTCDate() === dom && DOW_NAME[d.getUTCDay()] === dayName) return fmtISO(d);
  }
  return dates[dayName]; // day-of-month didn't resolve; trust the weekday
}
