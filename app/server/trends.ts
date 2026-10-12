// Trends over the weekly plan logs, joined to recipe frontmatter: per week,
// nights planned vs cooked, average nutrition per serving over the dinners
// actually cooked, average rating, protein-lane mix, and new-recipe count.
// Pure — plans and recipes in, numbers out (trends-routes.ts does the I/O).
// Feeds the Week tab's Trends card and the close-out prompt's {{TRENDS}}.
//
// Counting rules (the Log table vocabulary pinned by plans/TEMPLATE.md):
//   • planned  = non-flexible Plan rows (rejected ones excluded)
//   • cooked   = Log rows whose "Actually cooked" is `as planned`, a recipe
//                link, or free text — anything but `skipped…`/empty. A cook on
//                a flexible night counts too (it is a dinner that happened).
//   • skipped  = `skipped`, `skipped — …` (and "didn't cook") on planned nights;
//                a "skipped" flexible night is not a missed plan, so it is ignored
//   • unlogged = planned nights with an empty cell or no Log row at all
// Nutrition per cooked dinner: the recipe file's nutrition_per_serving (the
// planned recipe for `as planned`, the linked one for a link, an exact
// file-slug match for free text such as "Red lentil soup (NYT recipe)");
// otherwise the plan row's ~cal / ~protein estimate. Each nutrient is
// averaged over the dinners where it is known.
import type { ParsedPlan, PlanMeal, RecipeMeta } from './parse.ts';
import { dateSpan, endOfWeek, fmtISO, shortDate, startOfWeek } from './weeks.ts';

export const NUTRIENTS = ['calories', 'protein_g', 'carbs_g', 'fat_g', 'fiber_g'] as const;
export type Nutrient = (typeof NUTRIENTS)[number];
export const LANES = ['chicken', 'fish', 'plant', 'red', 'other'] as const;
export type Lane = (typeof LANES)[number];

export interface WeekTrend {
  week: string;
  start: string;            // first calendar date (Mon for ≤W32, Sat from W33)
  end: string;              // last calendar date, inclusive
  status: 'locked' | 'complete';
  inProgress: boolean;      // the current week: its unlogged nights may still happen
  planned: number;
  cooked: number;
  skipped: number;
  unlogged: number;
  avg: Record<Nutrient, number | null> | null;  // per serving, over cooked dinners
  nutritionN: number;       // cooked dinners with a calorie figure (the avg's base)
  avgRating: number | null;
  ratedN: number;
  lanes: Record<Lane, number>;                   // sums to `cooked`
  newCount: number;         // 🆕 rows in the plan
}

export interface Trends {
  weeks: WeekTrend[];       // oldest first, newest last
  summary: string;          // one plain-text line (card + close-out prompt)
  summaryWeeks: string[];   // the weeks the summary averages over
}

export interface TrendOpts {
  /** How many weeks to return, newest last (default 12). */
  weeks?: number;
  /** Ignore weeks after this one (e.g. a locked plan for a week not started yet). */
  through?: string;
  /** Flag this week as in progress and keep it out of the summary. */
  inProgress?: string;
}

// ---------- classification ----------

const LANE_RULES: ReadonlyArray<readonly [Lane, RegExp]> = [
  ['chicken', /(chicken|turkey|poultry|\bduck\b)/i],
  ['fish', /(salmon|shrimp|prawn|\bcod\b|tuna|\bahi\b|fish|tilapia|halibut|haddock|trout|mahi|scallop|crab|lobster|mussel|clam|sardine|anchov|seafood|snapper|pollock)/i],
  ['red', /(beef|pork|lamb|oxtail|veal|steak|\bchuck\b|brisket|bison|venison|\bgoat\b|sausage|bacon|chorizo|\bham\b|prosciutto|short[- ]?rib|goulash|pot roast)/i],
  ['plant', /(lentil|\bdal\b|bean|chickpea|chana|tofu|tempeh|paneer|seitan|edamame|legume|vegetarian|vegan)/i],
];

/** Protein lane from a recipe's `protein` value (or, failing that, a dish name). */
export function laneOf(text: string | undefined): Lane {
  if (!text) return 'other';
  for (const [lane, re] of LANE_RULES) if (re.test(text)) return lane;
  return 'other';
}

type Outcome = 'cooked' | 'skipped' | 'unlogged';
function outcomeOf(cookedCell: string): Outcome {
  const t = cookedCell.trim();
  if (!t || /^[—–-]+$/.test(t)) return 'unlogged';
  if (/^(skip|didn'?t cook|not cooked|no cook)/i.test(t)) return 'skipped';
  return 'cooked';
}

const isFlexText = (s: string) => /^flexible\b/i.test(s.trim());
const slugify = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();

interface CookedMeal {
  nutrition: Partial<Record<Nutrient, number>>;
  lane: Lane;
  rating?: number;
}

function nutritionFor(recipe: RecipeMeta | undefined, fallback: PlanMeal | undefined): Partial<Record<Nutrient, number>> {
  const n = recipe?.nutrition;
  if (n && Object.values(n).some((v) => typeof v === 'number')) return { ...n };
  const out: Partial<Record<Nutrient, number>> = {};
  if (fallback?.cal) out.calories = fallback.cal;
  if (fallback?.protein) out.protein_g = fallback.protein;
  return out;
}

const round = (v: number, dp: number) => {
  const f = 10 ** dp;
  return Math.round(v * f) / f;
};
const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

function averages(meals: CookedMeal[]): Record<Nutrient, number | null> | null {
  const out = {} as Record<Nutrient, number | null>;
  let any = false;
  for (const k of NUTRIENTS) {
    const xs = meals.map((m) => m.nutrition[k]).filter((v): v is number => typeof v === 'number');
    out[k] = xs.length ? round(mean(xs), k === 'calories' ? 0 : 1) : null;
    if (xs.length) any = true;
  }
  return any ? out : null;
}

// ---------- one week ----------

function weekTrend(plan: ParsedPlan, byFile: Map<string, RecipeMeta>, inProgress: boolean): { trend: WeekTrend; meals: CookedMeal[] } {
  const live = plan.meals.filter((m) => m.status.toLowerCase() !== 'rejected');
  const planned = live.filter((m) => !m.flexible);
  const byDay = new Map(live.map((m) => [m.day, m]));
  const loggedDays = new Set(plan.log.map((r) => r.day));
  let cooked = 0;
  let skipped = 0;
  let unlogged = planned.filter((m) => !loggedDays.has(m.day)).length;
  const meals: CookedMeal[] = [];

  for (const row of plan.log) {
    // The backing plan row: same day (the convention every reader uses), else
    // the first planned dish whose name starts like the log's "Planned" cell.
    let m = byDay.get(row.day);
    if (!m && !isFlexText(row.planned)) {
      const p = norm(row.planned).split(' ').slice(0, 3).join(' ');
      m = p ? planned.find((x) => norm(x.dish).startsWith(p)) : undefined;
    }
    const flexNight = m ? m.flexible : isFlexText(row.planned);
    const out = outcomeOf(row.cooked);
    if (out !== 'cooked') {
      if (flexNight) continue;
      if (out === 'skipped') skipped++;
      else unlogged++;
      continue;
    }
    cooked++;
    const cell = row.cooked.trim();
    let recipe: RecipeMeta | undefined;
    let dishText = cell;
    if (/^as planned\b/i.test(cell)) {
      recipe = m?.recipeFile ? byFile.get(m.recipeFile) : undefined;
      dishText = m?.dish ?? row.planned;
    } else {
      const link = cell.match(/\]\(\.\.\/recipes\/([^)]+?)\)/);
      if (link) recipe = byFile.get(link[1]!);
      else {
        const head = cell.split(/\s+[—–]\s+|\s+-\s+|\s*\(/)[0] ?? '';
        recipe = byFile.get(`${slugify(head)}.md`);
      }
    }
    meals.push({
      nutrition: nutritionFor(recipe, flexNight ? undefined : m),
      lane: recipe?.protein ? laneOf(recipe.protein) : laneOf(dishText),
      rating: row.rating,
    });
  }

  const lanes = Object.fromEntries(LANES.map((l) => [l, 0])) as Record<Lane, number>;
  for (const meal of meals) lanes[meal.lane]++;
  const ratings = meals.map((x) => x.rating).filter((v): v is number => typeof v === 'number');

  return {
    meals,
    trend: {
      week: plan.week,
      start: fmtISO(startOfWeek(plan.week)),
      end: fmtISO(endOfWeek(plan.week)),
      status: plan.status as 'locked' | 'complete',
      inProgress,
      planned: planned.length,
      cooked,
      skipped,
      unlogged,
      avg: averages(meals),
      nutritionN: meals.filter((x) => typeof x.nutrition.calories === 'number').length,
      avgRating: ratings.length ? round(mean(ratings), 2) : null,
      ratedN: ratings.length,
      lanes,
      newCount: planned.filter((x) => x.isNew).length,
    },
  };
}

// ---------- summary line ----------

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtCount = (v: number) => (Number.isInteger(v) ? String(v) : v.toFixed(1));

function summaryLine(rows: Array<{ trend: WeekTrend; meals: CookedMeal[] }>, span = 4): { text: string; weeks: string[] } {
  const eligible = rows.filter((r) => !r.trend.inProgress);
  const pool = eligible.filter((r) => r.trend.cooked + r.trend.skipped > 0).slice(-span);
  if (!pool.length) return { text: 'Not enough logged weeks yet.', weeks: [] };
  const k = pool.length;
  const first = pool[0]!.trend.week;
  const last = pool[k - 1]!.trend.week;
  // named by dates, never ids: the line is shown on the Trends card
  const range = dateSpan(pool[0]!.trend.start, pool[k - 1]!.trend.end);
  const meals = pool.flatMap((r) => r.meals);
  const cal = meals.map((m) => m.nutrition.calories).filter((v): v is number => typeof v === 'number');
  const pro = meals.map((m) => m.nutrition.protein_g).filter((v): v is number => typeof v === 'number');
  const ratings = meals.map((m) => m.rating).filter((v): v is number => typeof v === 'number');
  const red = meals.filter((m) => m.lane === 'red').length;
  const plant = meals.filter((m) => m.lane === 'plant').length;
  const cookedAvg = mean(pool.map((r) => r.trend.cooked));
  const plannedAvg = mean(pool.map((r) => r.trend.planned));
  const parts = [
    `${cookedAvg.toFixed(1)} of ${fmtCount(round(plannedAvg, 1))} nights cooked`,
    cal.length
      ? `~${Math.round(mean(cal) / 10) * 10} cal${pro.length ? ` / ${Math.round(mean(pro))} g protein` : ''} per serving`
      : 'nutrition unknown',
    `red meat ${plural(red, 'night')}`,
    `plant protein ${plural(plant, 'night')}`,
    ratings.length ? `avg rating ${mean(ratings).toFixed(1)}` : 'no ratings',
  ];
  // Weeks inside the span that were left out for having no log at all.
  const gaps = eligible
    .filter((r) => r.trend.week >= first && r.trend.week <= last && r.trend.cooked + r.trend.skipped === 0)
    .map((r) => shortDate(r.trend.start));
  const tail = gaps.length ? ` (week${gaps.length === 1 ? '' : 's'} of ${gaps.join(', ')} not logged, left out)` : '';
  return {
    text: `Last ${k === 1 ? 'week' : `${k} weeks`} (${range}): ${parts.join(', ')}${tail}`,
    weeks: pool.map((r) => r.trend.week),
  };
}

// ---------- entry points ----------

export function computeTrends(plans: ParsedPlan[], recipes: RecipeMeta[], opts: TrendOpts = {}): Trends {
  const n = Math.max(1, Math.min(104, Math.floor(opts.weeks ?? 12)));
  const byFile = new Map(recipes.map((r) => [r.file, r]));
  const chosen = plans
    .filter((p) => /^\d{4}-W\d{2}$/.test(p.week) && (p.status === 'locked' || p.status === 'complete'))
    .filter((p) => !opts.through || p.week <= opts.through)
    .sort((a, b) => a.week.localeCompare(b.week))
    .slice(-n);
  const rows = chosen.map((p) => weekTrend(p, byFile, p.week === opts.inProgress));
  const s = summaryLine(rows);
  return { weeks: rows.map((r) => r.trend), summary: s.text, summaryWeeks: s.weeks };
}

const cellNum = (v: number | null | undefined) => (v === null || v === undefined ? '—' : String(Math.round(v)));

/**
 * The close-out prompt's {{TRENDS}} block: the summary line plus one row per
 * week (the caller passes trends computed through the week being closed).
 */
export function trendsPromptBlock(t: Trends, week: string): string {
  if (!t.weeks.length) return 'none (no locked or complete weeks found).';
  const rows = t.weeks.map((w) => {
    const extra = [w.skipped && `${w.skipped} skipped`, w.unlogged && `${w.unlogged} unlogged`].filter(Boolean).join(', ');
    const lanes = LANES.filter((l) => w.lanes[l]).map((l) => `${l} ${w.lanes[l]}`).join(', ') || '—';
    return `| ${w.week} | ${w.cooked}/${w.planned}${extra ? ` (${extra})` : ''} | ${cellNum(w.avg?.calories)} | ${cellNum(w.avg?.protein_g)} | ${cellNum(w.avg?.carbs_g)} | ${cellNum(w.avg?.fiber_g)} | ${w.avgRating === null ? '—' : w.avgRating.toFixed(1)} | ${lanes} |`;
  });
  return [
    '',
    '',
    `   (Per-serving averages over the dinners actually cooked, from each recipe's nutrition_per_serving, falling back to the plan row's estimate. Computed from the plan files before this run's capture fold: if you folded anything for ${week} above, recount its row.)`,
    '',
    `   ${t.summary}`,
    '',
    '| Week | Cooked/planned | Cal | Protein g | Carbs g | Fiber g | Rating | Protein lanes |',
    '|---|---|---|---|---|---|---|---|',
    ...rows,
    '',
  ].join('\n');
}
