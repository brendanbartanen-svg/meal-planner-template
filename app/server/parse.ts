// Plan + recipe markdown parsers (formats pinned by plans/TEMPLATE.md and the
// run prompts), checkbox key helpers, and filename guards. Pure, no I/O —
// repo.ts does the reading.
import { DAYS, type DayName, prepDueDate } from './weeks.ts';

// ---------- keys ----------
// Checkbox keys are week-scoped (like the old page's mp-W prefixes) so stale
// state can't bleed across weeks, and content-hashed so a reworded item is a
// fresh box.
function slug(text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${base || 'item'}-${(h >>> 0).toString(36)}`;
}

export const CHECK_KEY = /^\d{4}-W\d{2}:(prep|shop|extra):[a-z0-9][a-z0-9-]{0,79}$/;

/**
 * A Prep-timeline task's checkbox key, from its line text after `- [ ] ` (bold
 * label included). The key IS the text: reword a task and its box comes back
 * unticked (move.ts hands the move run the ticked lines for that reason).
 */
export const prepKey = (week: string, text: string): string => `${week}:prep:${slug(text)}`;

// ---------- plan parsing ----------
// The plan files' structure comes from plans/TEMPLATE.md and is pinned by the
// run prompts; this parser is deliberately tolerant of the small drift the
// real W29–W31 files show (missing sections, status prose, '—' cells).

export interface PlanMeal {
  day: DayName;
  mealType: string;
  dish: string;
  recipeFile?: string;
  /**
   * What the dish is, in one sentence: the recipe file's frontmatter
   * `description`. Not in the plan file — /api/state joins it by recipeFile
   * (repo.ts addDescriptions) for the Week tab's day cards.
   */
  description?: string;
  /** URL of the recipe's picture (`/recipe-images/<slug>.jpg`), joined like `description`; absent when it has none. */
  image?: string;
  isNew: boolean;
  favRating?: number;
  /**
   * Servings the meal is planned at: the Plan table's Servings cell (leading
   * whole number — `8`, `~9`, `9 (3½ lb)`), DEFAULT_SERVINGS when the cell is
   * empty or the file predates the column. Set on every non-flexible meal;
   * absent on flexible rows.
   */
  servings?: number;
  timeMin?: number;
  cal?: number;
  protein?: number;
  status: string; // proposed | approved | rejected | cooked | skipped | substituted | —
  flexible: boolean;
  /**
   * Where this dinner may be moved from the Week tab (server/move.ts), in the
   * week's day order. Not in the plan file — /api/state sets it on the cooking
   * week's meals only; absent or empty = not movable.
   */
  moveTo?: MoveTarget[];
}

/** One place a dinner can move to: a flexible night, or (with `swapsWith`, that night's dish) a swap. */
export interface MoveTarget { day: DayName; date: string; swapsWith?: string }

/** House default: recipes are written at 4 servings. */
export const DEFAULT_SERVINGS = 4;

export interface PrepTask { key: string; label: string; text: string; dueDate?: string }
export interface GroceryItem { key: string; text: string }
export interface GrocerySection { name: string; items: GroceryItem[] }
export interface GroceryStore { name: string; sections: GrocerySection[] }
export interface LogRow { day: DayName; planned: string; cooked: string; rating?: number; notes: string }

export interface ParsedPlan {
  file: string;
  week: string;
  title: string;
  status: 'planning' | 'locked' | 'complete' | 'unknown';
  statusLine: string;
  meals: PlanMeal[];
  whys: Partial<Record<DayName, string>>;
  notes: string[];
  flexNote?: string;
  rejected: string[];
  prep: PrepTask[];
  grocery: { stores: GroceryStore[]; pantryCheck: GroceryItem[]; bulkNotes: string[] };
  hasGrocery: boolean;
  log: LogRow[];
  reviewMd: string;
}

const stripMd = (s: string) => s.replace(/\*\*/g, '').trim();

/**
 * plans/TEMPLATE.md placeholders a run can copy verbatim (`- [ ] **Sat,
 * night:** ...`, `- [ ] ...`, `- [ ] ... (why not the primary store: ...)`): after a
 * colon-ended bold label and whitespace, the text is empty or starts with
 * `...` / `…`. Never a real prep task or grocery item. Only a `**Label:**` /
 * `**Label**:` is stripped, so a fully bold item (`**Rice: jasmine 1 cup …**`)
 * is still an item.
 */
export function isPlaceholder(text: string): boolean {
  return /^(?:\.{3}|…|$)/.test(stripMd(text.replace(/^\*\*[^*]+?(?::\*\*|\*\*:)\s*/, '')));
}

// The Plan table is read by HEADER, not position: files before 2026-10 have no
// Servings column (`| Day | Meal | Recipe | Active time | Cal/serving | Protein
// | Status |`), files after it put one after Recipe, and both must parse.
type PlanCol = 'day' | 'meal' | 'recipe' | 'servings' | 'time' | 'cal' | 'protein' | 'status';
export type PlanColumns = Partial<Record<PlanCol, number>>;
/** The pre-Servings layout — also the fallback when a table has no readable header. */
const LEGACY_COLUMNS: PlanColumns = { day: 0, meal: 1, recipe: 2, time: 3, cal: 4, protein: 5, status: 6 };

/** Column index per field from the header cells (case-insensitive, first match wins). */
export function planColumns(header: string[]): PlanColumns {
  const cols: PlanColumns = {};
  header.forEach((h, i) => {
    const t = stripMd(h).toLowerCase();
    const key: PlanCol | null = t === 'day' ? 'day'
      : t.startsWith('meal') ? 'meal'
      : t.startsWith('recipe') || t.startsWith('dish') ? 'recipe'
      : t.startsWith('serving') ? 'servings'
      : t.includes('time') ? 'time'
      : t.startsWith('cal') || t.includes('kcal') ? 'cal'
      : t.startsWith('protein') ? 'protein'
      : t.startsWith('status') ? 'status'
      : null;
    if (key && cols[key] === undefined) cols[key] = i;
  });
  return cols.day !== undefined && cols.recipe !== undefined ? cols : LEGACY_COLUMNS;
}

/** A Servings cell → its leading whole number (`6`, `~9`, `**8**`, `9 (3½ lb)`); empty / `—` → 4. */
export function servingsCell(cell: string | undefined): number {
  const m = (cell ?? '').match(/^[\s~≈*]*(\d+)/);
  const n = m ? Number(m[1]) : NaN;
  return Number.isInteger(n) && n > 0 ? n : DEFAULT_SERVINGS;
}

function parseMealRow(cells: string[], cols: PlanColumns): PlanMeal | null {
  const cell = (k: PlanCol) => { const i = cols[k]; return i === undefined ? undefined : cells[i]; };
  const day = (cell('day') ?? '').trim() as DayName;
  if (!DAYS.includes(day)) return null;
  const mealType = (cell('meal') ?? '').trim();
  const recipeCell = (cell('recipe') ?? '').trim();
  if (!recipeCell) return null;
  const link = recipeCell.match(/\[([^\]]+)\]\(\.\.\/recipes\/([^)]+?)\)/);
  const isNew = recipeCell.includes('🆕');
  const fav = recipeCell.match(/⭐\s*(\d(?:\.\d)?)/);
  let dish = link ? link[1]! : recipeCell.replace(/🆕|⭐\s*\d(?:\.\d)?/g, '').trim();
  dish = stripMd(dish);
  const flexible = mealType === '—' || /^flexible\b/i.test(dish);
  const num = (s: string | undefined) => {
    const m = (s ?? '').match(/(\d+)/);
    return m ? Number(m[1]) : undefined;
  };
  return {
    day,
    mealType,
    dish,
    recipeFile: link ? link[2] : undefined,
    isNew,
    favRating: fav ? Number(fav[1]) : undefined,
    ...(flexible ? {} : { servings: servingsCell(cell('servings')) }),
    timeMin: num(cell('time')),
    cal: num(cell('cal')),
    protein: num(cell('protein')),
    status: (cell('status') ?? '').trim() || '—',
    flexible,
  };
}

export function parsePlan(raw: string, file: string): ParsedPlan {
  const week = (file.match(/(\d{4}-W\d{2})/) ?? raw.match(/(\d{4}-W\d{2})/))?.[1] ?? '';
  const lines = raw.split('\n');
  const plan: ParsedPlan = {
    file, week,
    title: (lines.find((l) => l.startsWith('# ')) ?? '# ?').slice(2).trim(),
    status: 'unknown', statusLine: '',
    meals: [], whys: {}, notes: [], rejected: [],
    prep: [],
    grocery: { stores: [], pantryCheck: [], bulkNotes: [] },
    hasGrocery: false,
    log: [], reviewMd: '',
  };

  type Zone = 'top' | 'plan' | 'notes' | 'flex' | 'rejected' | 'prep' | 'grocery' | 'log' | 'review';
  let zone: Zone = 'top';
  let store: GroceryStore | null = null;
  let section: GrocerySection | null = null;
  let groceryMode: 'store' | 'pantry' | 'bulk' = 'store';
  let planCols: PlanColumns = LEGACY_COLUMNS; // replaced by the Plan table's header row
  const review: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const t = line.trim();

    const status = t.match(/^\*\*Status:\*\*\s*(.+)$/);
    if (status) {
      plan.statusLine = status[1]!.trim();
      const word = plan.statusLine.toLowerCase().match(/^(planning|locked|complete)/);
      plan.status = (word?.[1] as ParsedPlan['status']) ?? 'unknown';
      continue;
    }

    if (t.startsWith('## ')) {
      const h = t.slice(3).toLowerCase();
      zone = h.startsWith('plan') ? 'plan'
        : h.startsWith('prep') ? 'prep'
        : h.startsWith('grocery') ? 'grocery'
        : h.startsWith('log') ? 'log'
        : h.startsWith('week review') ? 'review'
        : 'top';
      continue;
    }
    if (t.startsWith('### ')) {
      const h = t.slice(4).toLowerCase();
      if (h.startsWith('planning notes')) { zone = 'notes'; continue; }
      if (h.startsWith('flexibility')) { zone = 'flex'; continue; }
      if (h.startsWith('rejected')) { zone = 'rejected'; continue; }
      if (zone === 'grocery' || zone === 'top') {
        // store headings live inside the grocery zone
        zone = 'grocery';
        if (h.startsWith('pantry check')) { groceryMode = 'pantry'; continue; }
        if (h.startsWith('bulk notes')) { groceryMode = 'bulk'; continue; }
        groceryMode = 'store';
        store = { name: t.slice(4).trim(), sections: [] };
        section = null;
        plan.grocery.stores.push(store);
        continue;
      }
      continue;
    }

    if (zone === 'review') { review.push(rawLine); continue; }
    if (!t || t.startsWith('<!--')) continue;

    if (zone === 'plan' && t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      if (/^:?-{3,}/.test(cells[0] ?? '')) continue;
      if (/^day$/i.test(stripMd(cells[0] ?? ''))) { planCols = planColumns(cells); continue; }
      const meal = parseMealRow(cells, planCols);
      if (meal) plan.meals.push(meal);
      continue;
    }

    if (zone === 'notes' && t.startsWith('- ')) {
      const b = t.slice(2).trim();
      const why = b.match(/^\*\*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^*]*\*\*:?\s*(.*)$/);
      if (why) plan.whys[why[1] as DayName] = stripMd(why[2] ?? '');
      else plan.notes.push(b);
      continue;
    }

    if (zone === 'flex') { plan.flexNote = (plan.flexNote ? plan.flexNote + ' ' : '') + t; continue; }
    if (zone === 'rejected' && t.startsWith('- ')) { plan.rejected.push(t.slice(2).trim()); continue; }

    if (zone === 'prep') {
      const m = t.match(/^- \[[ xX]\]\s+(.*)$/);
      if (!m) continue;
      const text = m[1]!.trim();
      if (isPlaceholder(text)) continue; // TEMPLATE.md placeholder ("- [ ] **Sat, night:** ..."), not a real task
      const label = text.match(/^\*\*([^*]+?):?\*\*:?/)?.[1]?.replace(/:$/, '') ?? '';
      plan.prep.push({
        key: prepKey(week, text),
        label,
        text: stripMd(text.replace(/^\*\*[^*]+\*\*:?\s*/, '')),
        dueDate: label ? prepDueDate(label, week) : undefined,
      });
      continue;
    }

    if (zone === 'grocery') {
      const bold = t.match(/^\*\*([^*]+)\*\*$/);
      if (bold && groceryMode === 'store' && store) {
        section = { name: bold[1]!.trim(), items: [] };
        store.sections.push(section);
        continue;
      }
      const item = t.match(/^- \[[ xX]\]\s+(.*)$/);
      if (item) {
        const text = item[1]!.trim();
        if (isPlaceholder(text)) continue; // TEMPLATE.md placeholder ("- [ ] ..."), not a real item
        const g: GroceryItem = { key: `${week}:shop:${slug(text)}`, text: stripMd(text) };
        if (groceryMode === 'pantry') plan.grocery.pantryCheck.push(g);
        else if (groceryMode === 'store' && store) {
          if (!section) { section = { name: '', items: [] }; store.sections.push(section); }
          section.items.push(g);
        }
        continue;
      }
      if (groceryMode === 'bulk' && (t.startsWith('- ') || t.length))
        plan.grocery.bulkNotes.push(stripMd(t.replace(/^- /, '')));
      continue;
    }

    if (zone === 'log' && t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      const day = (cells[0] ?? '') as DayName;
      if (!DAYS.includes(day)) continue;
      const ratingM = (cells[3] ?? '').match(/^([1-5])\b/);
      plan.log.push({
        day,
        planned: stripMd(cells[1] ?? ''),
        cooked: stripMd(cells[2] ?? ''),
        rating: ratingM ? Number(ratingM[1]) : undefined,
        notes: cells[4] ?? '',
      });
      continue;
    }
  }

  plan.hasGrocery = plan.grocery.stores.some((s) => s.sections.some((x) => x.items.length));
  plan.reviewMd = review.join('\n').trim();
  return plan;
}

// ---------- recipe parsing ----------
// Enough YAML for the recipe frontmatter this repo actually uses: scalars,
// inline arrays, one level of nested maps, and quoted list items.

export interface RecipeMeta {
  file: string;
  name: string;
  /** One sentence (≤ 160 chars) on what the dish is; `description: "…"` right after `name:`. */
  description?: string;
  /** URL of `recipes/images/<slug>.<ext>` when one exists; set by repo.ts, never by the parser. */
  image?: string;
  cuisine?: string;
  protein?: string;
  active_time_min?: number;
  total_time_min?: number;
  servings?: number;
  rating?: number;
  times_cooked?: number;
  last_cooked?: string;
  cadence?: string;
  nutrition?: Partial<Record<'calories' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g', number>>;
  prep_ahead: string[];
}

export function parseRecipe(raw: string, file: string): { meta: RecipeMeta; body: string } {
  const meta: RecipeMeta = { file, name: file.replace(/\.md$/, ''), prep_ahead: [] };
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta, body: raw };
  const head = raw.slice(4, end).split('\n');
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);

  let block: 'nutrition' | 'prep' | null = null;
  const unquote = (s: string) => s.replace(/^["']|["']$/g, '');
  // A whole quoted scalar as plain text: colons and commas inside the quotes
  // are just text, `\"` / `''` are unescaped. Unquoted values pass through.
  const scalar = (s: string) => {
    const dq = s.match(/^"((?:[^"\\]|\\.)*)"\s*(?:#.*)?$/);
    if (dq) return dq[1]!.replace(/\\(["\\])/g, '$1').trim();
    const sq = s.match(/^'((?:[^']|'')*)'\s*(?:#.*)?$/);
    if (sq) return sq[1]!.replace(/''/g, "'").trim();
    return s;
  };
  for (const line of head) {
    const indented = /^\s/.test(line);
    const t = line.trim();
    if (!t) continue;
    if (indented && block === 'nutrition') {
      const m = t.match(/^([a-z_]+):\s*(.+)$/);
      if (m) {
        meta.nutrition = meta.nutrition ?? {};
        const v = Number(m[2]);
        if (!Number.isNaN(v)) (meta.nutrition as Record<string, number>)[m[1]!] = v;
      }
      continue;
    }
    if (indented && block === 'prep' && t.startsWith('- ')) {
      meta.prep_ahead.push(unquote(t.slice(2).trim()));
      continue;
    }
    block = null;
    const kv = t.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    const v = (vRaw ?? '').trim();
    if (k === 'nutrition_per_serving') { block = 'nutrition'; continue; }
    if (k === 'prep_ahead') { block = 'prep'; continue; }
    if (!v || v === 'null' || v === '~') continue; // YAML null → absent, not the string "null"
    switch (k) {
      case 'name': meta.name = v; break;
      case 'description': { const d = scalar(v); if (d) meta.description = d; break; }
      case 'cuisine': meta.cuisine = v; break;
      case 'protein': meta.protein = v; break;
      case 'cadence': meta.cadence = v; break;
      case 'last_cooked': meta.last_cooked = v; break;
      case 'active_time_min': case 'total_time_min': case 'servings': case 'times_cooked': {
        const n = Number(v);
        if (!Number.isNaN(n)) (meta as unknown as Record<string, number>)[k!] = n;
        break;
      }
      case 'rating': {
        const n = Number(v);
        if (!Number.isNaN(n)) meta.rating = n;
        break;
      }
      default: break;
    }
  }
  return { meta, body };
}

/**
 * The `## Ingredients` section of a recipe body as prompt-ready lines: every
 * `- ` item plus bold-only group labels (`**Mash**`, `**Glaze:**`); comments
 * and blanks dropped. The section ends at the next `#`/`##` heading — the
 * same boundary scale.ts uses, so a scaled body reads back consistently.
 */
export function ingredientListLines(body: string): string[] {
  const out: string[] = [];
  let inSec = false;
  for (const raw of body.split('\n')) {
    const line = raw.replace(/\r$/, '');
    if (/^#{1,2}\s/.test(line)) { inSec = /^##\s+Ingredients\b/i.test(line); continue; }
    if (!inSec) continue;
    const t = line.trim();
    if (/^[-*]\s+\S/.test(t) || /^\*\*[^*]+\*\*:?$/.test(t)) out.push(t);
  }
  return out;
}

export const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;
