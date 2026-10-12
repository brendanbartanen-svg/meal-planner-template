// Assembles the /api/state payload: which week is being cooked, which is
// ahead, the Shop tab's live list, carry cards, and close-out readiness.
import { configuredPasscode } from './auth.ts';
import { pullIfStale } from './git.ts';
import type { ParsedPlan, PlanMeal } from './parse.ts';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { recipesDir, repoRoot } from './paths.ts';
import { readAllPlans } from './repo.ts';
import { starterCounts } from './starter.ts';
import { effectiveServings, foldPublic, runPublic } from './runs.ts';
import { autoFoldOn, captures, checks, extras, feedback, typicalMs, type RunType, type WeekFeedback } from './store.ts';
import { addDays, addWeeks, endOfWeek, fmtISO, isSatEra, todayUTC, weekDates, weekDays, weekIdForDate, type DayName } from './weeks.ts';

// ---------- state assembly ----------

function carryEntries(prevPlan: ParsedPlan | null, today: string) {
  if (!prevPlan) return [];
  const dates = weekDates(prevPlan.week);
  // show stragglers for 3 days after the week ends
  const cutoff = addDays(endOfWeek(prevPlan.week), 3);
  if (today > fmtISO(cutoff)) return [];
  const logged = new Map(prevPlan.log.map((l) => [l.day, l]));
  return prevPlan.meals
    .filter((m) => !m.flexible)
    .filter((m) => !!dates[m.day]) // a row on a day the week doesn't have (drifted file) has no date to show
    .filter((m) => {
      const l = logged.get(m.day);
      return !(l && (l.rating !== undefined || (l.cooked && l.cooked !== '')));
    })
    .map((m) => ({ date: dates[m.day]!, day: m.day, week: prevPlan.week, dish: m.dish, recipeFile: m.recipeFile }));
}

export function mealApproved(plan: ParsedPlan, fb: WeekFeedback | undefined, m: PlanMeal): boolean {
  if (m.flexible) return true;
  if (m.status === 'approved') return true;
  return fb?.meals[m.day]?.decision === 'approve';
}

/** Non-flexible meals with no decision in the feedback and not already approved in the file. */
export function undecidedDays(plan: ParsedPlan, fb: WeekFeedback | undefined): DayName[] {
  return plan.meals
    // a servings-only entry (stepper, no decision) is still undecided
    .filter((m) => !m.flexible && m.status !== 'approved' && !fb?.meals[m.day]?.decision)
    .map((m) => m.day);
}

// The week the Next tab plans and the propose route targets. Normally next
// week — but when the current week itself has no usable plan (no file, or one
// still in planning) the week to plan IS the current one. Without that, the
// Saturday cutover would show cooking = last week's fallback and ahead = the
// week after next, skipping the unplanned current week entirely. Shared by
// buildState and POST /api/runs/propose so there is only one derivation.
export function aheadWeekIdFor(plans: Map<string, ParsedPlan>, curId: string): string {
  const cur = plans.get(curId);
  return (!cur || cur.status === 'planning') ? curId : addWeeks(curId, 1);
}

// ---------- first-run setup (the Get started card) ----------
// A profile file is "ready" once it exists and no `_fill in_` placeholder is
// left (the template ships both files blank). A household's own repo has both
// filled in, plans, and no starter-recipes/ folder, so the card never shows.
export const FILL_IN = '_fill in_';
const filledIn = (rel: string) => fs.readFile(path.join(repoRoot, rel), 'utf8').then((t) => !t.includes(FILL_IN), () => false);
export const profileReady = () => filledIn('profile/preferences.md');

export interface SetupStatus {
  profileReady: boolean;
  pantryReady: boolean;
  recipes: number;
  plans: number;
  starter: { available: boolean; remaining: number };
}

export async function setupStatus(planCount: number): Promise<SetupStatus> {
  const [prof, pantry, recipeFiles, starter] = await Promise.all([
    profileReady(),
    filledIn('profile/pantry.md'),
    fs.readdir(recipesDir).catch(() => [] as string[]),
    starterCounts(),
  ]);
  return {
    profileReady: prof,
    pantryReady: pantry,
    recipes: recipeFiles.filter((f) => f.endsWith('.md') && f !== 'README.md').length,
    plans: planCount,
    starter,
  };
}

export async function buildState() {
  await pullIfStale();
  const plans = await readAllPlans();
  const t = todayUTC();
  const today = fmtISO(t);
  const curId = weekIdForDate(t);
  const nextId = aheadWeekIdFor(plans, curId);

  let cooking = plans.get(curId) ?? null;
  let fallback = false;
  if (!cooking || cooking.status === 'planning') {
    const candidates = [...plans.keys()].filter((w) => w < curId && plans.get(w)!.status !== 'planning').sort();
    const latest = candidates[candidates.length - 1];
    if (latest) { cooking = plans.get(latest)!; fallback = true; }
  }
  const cookingWeek = cooking?.week ?? curId;
  const prevPlan = plans.get(addWeeks(cookingWeek, -1)) ?? null;
  const ahead = plans.get(nextId) ?? null;

  const fb = feedback[nextId];
  // servings = what the meal is planned at right now: the Next-tab stepper's
  // feedback override, else the Plan table's Servings cell (4 when absent)
  const aheadApproval = ahead
    ? ahead.meals.filter((m) => !m.flexible).map((m) => ({
        day: m.day, approved: mealApproved(ahead, fb, m), servings: effectiveServings(nextId, m),
      }))
    : [];

  // close-out readiness: every planned night rated, in the file or in captures.
  // A "Didn't cook" skip counts as logged: it is a capture dish
  // ("skipped — ate out") until folded, then the Log row's Actually-cooked text.
  // A row on a day the week doesn't contain (a drifted file — e.g. a Sat/Sun
  // row left in the truncated 2026-W32) is skipped: it has no date, so the UI
  // can't card it and the user can't rate it — counting it would deadlock
  // close-out with no way out from the app.
  const cookDates = cooking ? weekDates(cooking.week) : null;
  const missing = cooking
    ? cooking.meals.filter((m) => !m.flexible).filter((m) => !!cookDates![m.day]).filter((m) => {
        const l = cooking.log.find((x) => x.day === m.day);
        if (l && (l.rating !== undefined || (l.cooked && l.cooked !== ''))) return false;
        const c = captures[cookDates![m.day]!];
        return !(c && (c.rating !== undefined || c.dish));
      }).map((m) => m.day)
    : [];

  // Shop tab targeting. Normally the ahead week's list. But once weeks start on
  // shopping day, Saturday morning's live list belongs to the week being cooked
  // (locked the night before) while `ahead` has already rolled to the next one —
  // so fall back to the cooking week's list when it is a Saturday-era week and
  // ahead has none. Failing both, show ahead's empty state. Checkbox keys ride
  // along inside the parsed plan, so they are already scoped to whichever week
  // this picks.
  // A plan still in planning never owns the Shop tab — its list is built at
  // lock, so anything grocery-shaped before that is skeleton or drift.
  const shopPlan = (ahead?.hasGrocery && ahead.status !== 'planning') ? ahead
    : (cooking?.hasGrocery && isSatEra(cooking.week)) ? cooking
    : (ahead ?? null);
  const shopWeek = shopPlan?.week ?? nextId;

  return {
    now: Date.now(),
    today,
    passcodeGate: !!(await configuredPasscode()),
    autoFold: autoFoldOn(),
    run: runPublic(),
    // { pending, nextAt, quietMin, last } — also inside run (runPublic) and in
    // capture / fold-state broadcasts; the client keeps the newest as state.fold
    fold: foldPublic(),
    typical: Object.fromEntries((['propose', 'revise', 'lock', 'fold', 'shop-adjust', 'review', 'rescale', 'ideas', 'import'] as RunType[])
      .map((k) => [k, typicalMs(k)])),
    cooking: cooking ? {
      week: cooking.week, dates: weekDates(cooking.week), fallback,
      plan: cooking, closeReady: cooking.status === 'locked' && missing.length === 0, missing,
    } : null,
    currentWeekId: curId,
    aheadWeekId: nextId,
    aheadDays: weekDays(nextId), // the ahead week's own day order (cook-night chips) — exists before its plan file does
    ahead: ahead ? { week: ahead.week, dates: weekDates(ahead.week), plan: ahead, approval: aheadApproval } : null,
    // The Shop tab renders exactly this — which week's list is live, whether
    // that week is planned at all, and the list itself. The client does no
    // week picking of its own. (Extras stay keyed to aheadWeekId above:
    // they're "for the next plan", consumed by the lock run.)
    shop: {
      week: shopWeek,                                              // list + checkbox scope
      planned: !!shopPlan,                                         // is that week planned at all?
      grocery: shopPlan?.hasGrocery ? shopPlan.grocery : null,     // null → render the empty state
    },
    carry: carryEntries(prevPlan, today),
    captures,
    checks,
    feedback: fb ?? null,
    extras: extras[nextId] ?? [],
    setup: await setupStatus(plans.size),
  };
}
