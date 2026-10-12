// Deterministic ingredient scaling for the house recipe format — the single
// source of truth for scaled quantities (Cook tab rendering, lock-run prompt).
// Pure and dependency-free: no I/O, no imports, same input → same output.
//
// Format (recipes/*.md): a `## Ingredients` section of `- ` lines; source tags
// per the legend in recipes/README.md, e.g. `[2 …]` / `[P]` (may nest:
// `[2 — …; honey [P] works at 1½ tbsp]`);
// sub-ingredients joined with ` · `; an optional `**Label:**` (or plain
// `Marinade:`) before the first quantity.
//
// WHAT SCALES (only outside tags, parens and the label):
//   (a) the leading quantity of the line and of each ` · ` segment — a `**`
//       bold opener in front is fine (`**1 tsp red pepper flakes**`);
//   (b) a quantity right after a connector: `+`, `plus`, `or`, `of`, `from`
//       (`2 tbsp + 1 tsp`, `1 shallot or ½ yellow onion`, `Juice of 1 lemon`,
//       `zest of 1 lemon + 2 tbsp juice`, `from 2 ears`, `plus 1 more`);
//   (c) a quantity right after `, ` (comma lists: `1 tsp turmeric, 2 tsp
//       coriander`); inside an ` — ` aside only unit-bearing amounts do
//       (`— use half, ~1¾ cups`);
//   (d) an ` — ` breakdown whose bare numbers sum to the lead
//       (`6 cloves garlic — 4 minced, 2 thinly sliced`): the parts scale with
//       the lead, and the lead keeps its unit so the parts still read in it.
// NEVER SCALES: anything inside `[...]` or `(...)`; sizes, temperatures, times
// (`13.5-oz`, `2-lb`, `1"`, `450°F`, `15 min`, `½ inch`, `%`); per-unit
// amounts (`~6 oz each`, `3 per serving`); multipliers (`4 × 6 oz`). Numbers
// left as written that probably should move are reported in `notes`.
// Units are tidied only when the result is exact (see `tidy`); count nouns
// flip singular/plural when the amount crosses 1.

export interface ParsedQty { value: number; hi?: number; raw: string; approx?: boolean }
export interface ScaledLine { text: string; scaled: boolean; notes?: string[] }
export interface ScaledBody {
  body: string;
  /** Ingredient lines with no scalable quantity (to-taste items, `Big handful …`), as written. */
  unscaled: string[];
  /** Lines carrying numbers left as written (ScaledLine.notes) — scaled or not — as written. */
  flagged: Array<{ line: string; notes: string[] }>;
}

// ---------------------------------------------------------------- quantities

const VULGAR: Record<string, number> = {
  '¼': 1 / 4, '½': 1 / 2, '¾': 3 / 4, '⅓': 1 / 3, '⅔': 2 / 3, '⅛': 1 / 8, '⅜': 3 / 8, '⅝': 5 / 8, '⅞': 7 / 8,
  '⅕': 1 / 5, '⅖': 2 / 5, '⅗': 3 / 5, '⅘': 4 / 5, '⅙': 1 / 6, '⅚': 5 / 6,
};
const FR = '[¼½¾⅓⅔⅛⅜⅝⅞⅕⅖⅗⅘⅙⅚]';
// one number: mixed `1 1/2`, compact `1½` / `1 ½`, `1/2`, `2.5`, `½`
const NUM = `(?:\\d+ +\\d+/\\d+|\\d+ ?${FR}|\\d+/\\d+|\\d+(?:\\.\\d+)?|${FR})`;
// groups: 1 approx marker, 2 number, 3 range separator, 4 range high end.
// Ranges: `2–3`, `2-3`, `2—3`, `2 – 3`, `2 to 3` (no spaced hyphen/em dash —
// those are asides, not ranges).
const QTY = `(~ ?|(?:about|approximately|approx\\.?) +)?(${NUM})(?:( ?– ?|[—-]| +to +)(${NUM}))?`;
const QTY_FULL_RE = new RegExp(`^${QTY}$`, 'iu');
const QTY_LEAD_RE = new RegExp(`^${QTY}`, 'iu');
const qtyScanRe = () => new RegExp(`(?<![\\p{L}\\p{N}./])${QTY}`, 'giu');

function parseNum(t: string): number | null {
  let m: RegExpExecArray | null;
  if ((m = /^(\d+) +(\d+)\/(\d+)$/.exec(t))) return Number(m[3]) ? Number(m[1]) + Number(m[2]) / Number(m[3]) : null;
  if ((m = new RegExp(`^(\\d+) ?(${FR})$`, 'u').exec(t))) return Number(m[1]) + (VULGAR[m[2]!] ?? 0);
  if ((m = /^(\d+)\/(\d+)$/.exec(t))) return Number(m[2]) ? Number(m[1]) / Number(m[2]) : null;
  if (/^\d+(?:\.\d+)?$/.test(t)) return parseFloat(t);
  return VULGAR[t] ?? null;
}

function qtyFromMatch(m: RegExpExecArray): ParsedQty | null {
  const value = parseNum(m[2]!);
  if (value === null) return null;
  const q: ParsedQty = { value, raw: m[0] };
  if (m[4] !== undefined) {
    const hi = parseNum(m[4]);
    if (hi === null || hi < value) return null;
    q.hi = hi;
  }
  if (m[1]) q.approx = true;
  return q;
}

/** Parse one quantity token (the whole string must be the quantity). */
export function parseQty(s: string): ParsedQty | null {
  const raw = s.trim();
  const m = QTY_FULL_RE.exec(raw);
  return m ? qtyFromMatch(m) : null;
}

// Snap targets for the fractional part: [value, glyph, tolerance]. Halves,
// quarters and thirds snap within 0.03 (the spec'd tolerance); odd eighths
// only within 0.01 — they come out of exact arithmetic (¾ × ½ = ⅜), and a
// looser snap would turn 2.4 into 2⅜.
const SNAPS: Array<[number, string, number]> = [
  [0, '', 0.03], [1 / 8, '⅛', 0.01], [1 / 4, '¼', 0.03], [1 / 3, '⅓', 0.03], [3 / 8, '⅜', 0.01], [1 / 2, '½', 0.03],
  [5 / 8, '⅝', 0.01], [2 / 3, '⅔', 0.03], [3 / 4, '¾', 0.03], [7 / 8, '⅞', 0.01], [1, '', 0.03],
];

/** Clean cooking number: `3`, `1½`, `2⅓`, `⅜`; otherwise one decimal (`2.4`). With `hi`, a range `4–6`. */
export function formatQty(n: number, hi?: number): string {
  if (hi !== undefined) return `${formatQty(n)}–${formatQty(hi)}`;
  if (!Number.isFinite(n)) return String(n);
  if (n < 0) return `-${formatQty(-n)}`;
  const whole = Math.floor(n);
  const frac = n - whole;
  let best: [number, string, number] | undefined;
  let bestD = Infinity;
  for (const s of SNAPS) {
    const d = Math.abs(frac - s[0]);
    if (d <= s[2] + 1e-9 && d < bestD) { best = s; bestD = d; }
  }
  if (best) {
    if (best[0] === 1) return String(whole + 1);
    if (best[0] === 0) return String(whole);
    return whole ? `${whole}${best[1]}` : best[1];
  }
  const r = Math.round(n * 10) / 10;
  return r === 0 ? String(Number(n.toPrecision(1))) : String(r);
}

/** Plural iff the rendered amount is more than one (`1 cup`, `½ cup`, `1½ cups`). */
const isPlural = (v: number) => v > 1 && formatQty(v) !== '1';

// --------------------------------------------------------------------- units

type Fam = 'tsp' | 'tbsp' | 'cup' | 'oz' | 'lb';
const EPS = 1e-6;
const isMult = (x: number, m: number) => Math.abs(x / m - Math.round(x / m)) < EPS;
const NICE = [0, 1 / 8, 1 / 4, 1 / 3, 3 / 8, 1 / 2, 5 / 8, 2 / 3, 3 / 4, 7 / 8, 1];
const isNice = (x: number) => { const f = x - Math.floor(x); return NICE.some((v) => Math.abs(f - v) < EPS); };
const quarterOrThird = (x: number) => isMult(x, 1 / 4) || isMult(x, 1 / 3);

/**
 * Exact unit tidy-ups (both range ends must qualify):
 *   tsp → tbsp   at ≥ 3 tsp in half-tbsp steps     (3 tsp → 1 tbsp, 4½ tsp → 1½ tbsp; 4 tsp stays)
 *   tbsp → cup   at ≥ 4 tbsp in quarter-cup steps  (4/8/12/16 tbsp → ¼/½/¾/1 cup; 6 tbsp stays)
 *   oz → lb      at ≥ 16 oz in quarter-lb steps    (16 → 1 lb, 24 → 1½ lb, 28 → 1¾ lb; 18 oz stays)
 * and downward, only to avoid unmeasurable amounts:
 *   tbsp < 1                         → tsp  (½ tbsp → 1½ tsp)
 *   cup < ½, not a quarter/third     → tbsp (⅛ cup → 2 tbsp, ⅜ → 6 tbsp, ⅙ → 2⅔ tbsp)
 *   lb < 1, not a quarter/third      → oz   (⅜ lb → 6 oz)
 * Anything else keeps its unit.
 */
function tidy(fam: Fam, lo: number, hi?: number): { fam: Fam; lo: number; hi?: number } {
  const all = hi === undefined ? [lo] : [lo, hi];
  const top = hi ?? lo;
  const to = (f: Fam, k: number) => tidy(f, lo * k, hi === undefined ? undefined : hi * k);
  switch (fam) {
    case 'tsp':
      if (lo >= 3 - EPS && all.every((x) => isMult(x, 1.5))) return to('tbsp', 1 / 3);
      break;
    case 'tbsp':
      if (lo >= 4 - EPS && all.every((x) => isMult(x, 4))) return to('cup', 1 / 16);
      if (top < 1 - EPS && all.every((x) => isNice(x * 3))) return to('tsp', 3);
      break;
    case 'cup':
      if (top < 0.5 - EPS && !all.every(quarterOrThird) && all.every((x) => isNice(x * 16))) return to('tbsp', 16);
      break;
    case 'oz':
      if (lo >= 16 - EPS && all.every((x) => isMult(x, 4))) return to('lb', 1 / 16);
      break;
    case 'lb':
      if (top < 1 - EPS && !all.every(quarterOrThird) && all.every((x) => isNice(x * 16))) return to('oz', 16);
      break;
  }
  return { fam, lo, hi };
}
const FAM_WORD: Record<Fam, (plural: boolean) => string> = {
  tsp: () => 'tsp', tbsp: () => 'tbsp', cup: (p) => (p ? 'cups' : 'cup'), oz: () => 'oz', lb: () => 'lb',
};

interface UnitDef { singular: string; plural: string; fam?: Fam; invariant?: boolean }
const inv = (w: string, fam?: Fam): UnitDef => ({ singular: w, plural: w, fam, invariant: true });
const word = (singular: string, plural = `${singular}s`, fam?: Fam): UnitDef => ({ singular, plural, fam });
const UNIT_TABLE: Array<[string[], UnitDef]> = [
  [['tsp', 'tsps'], inv('tsp', 'tsp')],
  [['teaspoon', 'teaspoons'], word('teaspoon', undefined, 'tsp')],
  [['tbsp', 'tbsps', 'tbs'], inv('tbsp', 'tbsp')],
  [['tablespoon', 'tablespoons'], word('tablespoon', undefined, 'tbsp')],
  [['cup', 'cups'], word('cup', undefined, 'cup')],
  [['oz'], inv('oz', 'oz')],
  [['ounce', 'ounces'], word('ounce', undefined, 'oz')],
  [['lb'], inv('lb', 'lb')],
  [['lbs'], word('lb', 'lbs', 'lb')], // "2 lbs" ×½ → "1 lb"; house style "2 lb" stays as written
  [['pound', 'pounds'], word('pound', undefined, 'lb')],
  [['g'], inv('g')], [['kg'], inv('kg')], [['ml'], inv('ml')],
  [['pint', 'pints'], word('pint')], [['quart', 'quarts'], word('quart')], [['gallon', 'gallons'], word('gallon')],
  // containers / countable measures — "2 cans (15 oz) chickpeas", "1 large head broccoli"
  ...(['can', 'jar', 'head', 'clove', 'block', 'bag', 'package', 'sprig', 'stalk', 'rib', 'ear', 'slice',
    'stick', 'tin', 'handful', 'knob', 'bulb', 'piece', 'sheet', 'tub', 'bottle', 'carton'] as const)
    .map((w): [string[], UnitDef] => [[w, `${w}s`], word(w)]),
  ...(['bunch', 'box', 'pinch', 'dash'] as const).map((w): [string[], UnitDef] => [[w, `${w}es`], word(w, `${w}es`)]),
];
const UNIT_FORMS = new Map<string, UnitDef>();
for (const [forms, def] of UNIT_TABLE) for (const f of forms) UNIT_FORMS.set(f, def);
const UNIT_SRC = [...UNIT_FORMS.keys()].sort((a, b) => b.length - a.length).join('|');
const SIZE_ADJ = 'small|medium|large|big|heaping|heaped|scant|generous|level|packed|extra-large|good';
const UNIT_RE = new RegExp(`^(\\s+)((?:(?:${SIZE_ADJ})\\s+)?)(${UNIT_SRC})(?![\\p{L}-])`, 'iu');

function matchUnit(s: string, end: number) {
  const m = UNIT_RE.exec(s.slice(end));
  if (!m) return null;
  const w = m[3]!;
  const start = end + m[1]!.length + m[2]!.length;
  return { word: w, def: UNIT_FORMS.get(w.toLowerCase())!, start, end: start + w.length };
}

// Words that make the number a size/time/temperature rather than an amount.
const SIZE_WORDS = new Set([
  'min', 'mins', 'minute', 'minutes', 'hr', 'hrs', 'hour', 'hours', 'h', 'sec', 'secs', 'second', 'seconds',
  'day', 'days', 'inch', 'inches', 'cm', 'mm', 'degrees', 'degree', '°f', '°c', 'f', 'percent', 'am', 'pm',
]);
type Guard = 'ok' | 'size' | 'attached' | 'mult' | 'each';
/** What follows a quantity decides whether it is an amount at all. */
function guardAt(s: string, end: number): Guard {
  const c = s[end] ?? '';
  const c2 = s[end + 1] ?? '';
  if (/[-‑]/.test(c) && /\p{L}/u.test(c2)) return 'size'; // 2-lb, 13.5-oz, 1-inch, 2026-W40
  if (/[°%"”″]/.test(c)) return 'size'; // 450°F, 1", 90%
  if (c === '×') return 'mult';
  if (/[\p{L}\p{N}]/u.test(c)) return 'attached'; // 12oz, 1st, 4x
  const rest = s.slice(end);
  if (new RegExp(`^\\s*[×x]\\s*(?:\\d|${FR})`, 'u').test(rest)) return 'mult'; // 4 × 6 oz
  const w = /^\s+([\p{L}°]+)/u.exec(rest);
  if (w && SIZE_WORDS.has(w[1]!.toLowerCase())) return 'size';
  const u = matchUnit(s, end);
  if (/^\s+(?:each|apiece|per)\b/i.test(u ? s.slice(u.end) : rest)) return 'each'; // ~6 oz each, 3 per serving
  return 'ok';
}

// ----------------------------------------------------------------- nouns

// Count nouns whose number follows the amount (1 lemon → 2 lemons). Irregular
// plurals in IRREGULAR, invariant ones in INVARIANT, default +s/+es/-ies.
// Unknown words are never inflected (no "2 more sliceds").
const COUNT_NOUNS = new Set([
  'lemon', 'lime', 'orange', 'egg', 'onion', 'shallot', 'scallion', 'leek', 'clove', 'ear', 'can', 'jar', 'bunch',
  'head', 'pita', 'tortilla', 'flatbread', 'naan', 'bun', 'roll', 'serrano', 'jalapeño', 'jalapeno', 'habanero',
  'chipotle', 'bonnet', 'chile', 'chili', 'pepper', 'carrot', 'potato', 'tomato', 'tomatillo', 'cucumber', 'avocado',
  'zucchini', 'cabbage', 'beet', 'radish', 'turnip', 'parsnip', 'apple', 'pear', 'peach', 'leaf', 'sprig', 'stalk',
  'rib', 'fillet', 'filet', 'thigh', 'breast', 'drumstick', 'wing', 'cutlet', 'steak', 'chop', 'shank', 'sausage',
  'anchovy', 'block', 'bag', 'package', 'pod', 'bulb', 'knob', 'slice', 'piece', 'stick', 'tin', 'box', 'wedge',
]);
const IRREGULAR: Record<string, string> = {
  potato: 'potatoes', tomato: 'tomatoes', leaf: 'leaves', anchovy: 'anchovies', chili: 'chilies',
};
const INVARIANT = new Set(['zucchini', 'naan']);
const regularPlural = (w: string) =>
  /(?:s|x|z|ch|sh)$/.test(w) ? `${w}es` : /[^aeiou]y$/.test(w) ? `${w.slice(0, -1)}ies` : `${w}s`;
const pluralOf = (w: string) => (INVARIANT.has(w) ? w : IRREGULAR[w] ?? regularPlural(w));
const SINGULAR_OF = new Map<string, string>();
for (const n of COUNT_NOUNS) SINGULAR_OF.set(pluralOf(n), n);

function nounForms(w0: string): { sing: string; plural: string } | null {
  const w = w0.toLowerCase();
  if (COUNT_NOUNS.has(w)) return { sing: w, plural: pluralOf(w) };
  const sing = SINGULAR_OF.get(w);
  return sing ? { sing, plural: w } : null;
}
const matchCase = (src: string, out: string) =>
  src[0] && src[0] !== src[0].toLowerCase() ? out[0]!.toUpperCase() + out.slice(1) : out;

interface Edit { start: number; end: number; text: string }

// Where the noun phrase after a count ends.
const HEAD_STOP_RE = /[,;(\[·+]|\s[—–]\s|\s(?:in|with|for|from|to|into|of|at|on|plus|and)\s/i;
/**
 * Fix the number of the counted noun after a count: the last known count noun
 * before the phrase ends (`2 serrano chiles` → chiles), and the same for each
 * bare ` or ` alternative (`1 serrano or jalapeño` → both). An alternative that
 * carries its own amount (`or ½ yellow onion`) is its own site.
 */
function nounEdits(s: string, from: number, segEnd: number, plural: boolean): Edit[] {
  const tail = s.slice(from, segEnd);
  const stop = HEAD_STOP_RE.exec(tail);
  const head = stop ? tail.slice(0, stop.index) : tail;
  const parts: Array<[number, string]> = [];
  let last = 0;
  for (const m of head.matchAll(/\s+or\s+/g)) { parts.push([last, head.slice(last, m.index)]); last = m.index! + m[0].length; }
  parts.push([last, head.slice(last)]);
  const edits: Edit[] = [];
  for (const [off, part] of parts) {
    if (new RegExp(`\\d|${FR}`, 'u').test(part)) break;
    let pick: { idx: number; w: string; forms: { sing: string; plural: string } } | null = null;
    for (const m of part.matchAll(/[\p{L}'’-]+/gu)) {
      const forms = nounForms(m[0]);
      if (forms) pick = { idx: m.index!, w: m[0], forms };
    }
    if (!pick) continue;
    const target = plural ? pick.forms.plural : pick.forms.sing;
    if (target !== pick.w.toLowerCase()) {
      const at = from + off + pick.idx;
      edits.push({ start: at, end: at + pick.w.length, text: matchCase(pick.w, target) });
    }
  }
  return edits;
}

// --------------------------------------------------------------- structure

interface Group { start: number; end: number; kind: '[' | '(' }
/** Outermost `[...]` / `(...)` groups (nesting-aware; an unclosed group runs to the end). */
function groupsOf(s: string, from = 0): Group[] {
  const out: Group[] = [];
  const stack: string[] = [];
  let start = -1;
  for (let i = from; i < s.length; i++) {
    const c = s[i]!;
    if (c === '[' || c === '(') {
      if (!stack.length) start = i;
      stack.push(c);
    } else if ((c === ']' && stack[stack.length - 1] === '[') || (c === ')' && stack[stack.length - 1] === '(')) {
      stack.pop();
      if (!stack.length) out.push({ start, end: i + 1, kind: s[start] as '[' | '(' });
    }
  }
  if (stack.length) out.push({ start, end: s.length, kind: s[start] as '[' | '(' });
  return out;
}
function stripGroups(s: string): string {
  let out = '';
  let pos = 0;
  for (const g of groupsOf(s)) { out += s.slice(pos, g.start); pos = g.end; }
  return out + s.slice(pos);
}

const LIST_RE = /^(\s*[-*]\s+)/;
/** `**Coconut-dill dressing:** `, `**Chile oil (the finish):** `, `Marinade: `, `Optional: `. */
function labelLength(s: string): number {
  const b = /^\*\*[^*\n]+?(?::\*\*|\*\*:)\s*/.exec(s);
  if (b) return b[0].length;
  const p = /^[A-Z][A-Za-z'’ -]{0,40}:\s+/.exec(s);
  return p ? p[0].length : 0;
}

const CONTAINER_BEFORE_RE = /\b(?:cans?|jars?|blocks?|tins?|bags?|packages?|pkgs?|box(?:es)?|bottles?|cartons?|tubs?)\s*$/i;
const clip = (t: string, n: number) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);
function snippetAt(s: string, start: number): string {
  const t = s.slice(start);
  const m = /[,;(\[·]|\s[—–]\s/.exec(t);
  return clip((m ? t.slice(0, m.index) : t).trim(), 40);
}

function assertFactor(factor: number) {
  if (!Number.isFinite(factor) || factor <= 0) throw new RangeError(`scale factor must be a positive number, got ${factor}`);
}

interface Site { start: number; end: number; q: ParsedQty; approx: string; sep: string; segEnd: number; breakdown?: boolean; noTidy?: boolean }

// ------------------------------------------------------------------ lines

/** Scale one ingredient line (with or without its `- ` prefix). */
export function scaleIngredientLine(line: string, factor: number): ScaledLine {
  assertFactor(factor);
  const lm = LIST_RE.exec(line);
  const prefix = lm ? lm[1]! : '';
  const s = line.slice(prefix.length);
  const labelEnd = labelLength(s);
  const groups = groupsOf(s, labelEnd);
  const mask = new Uint8Array(s.length); // 0 free text, 1 tag, 2 paren, 3 label
  for (const g of groups) mask.fill(g.kind === '[' ? 1 : 2, g.start, g.end);
  mask.fill(3, 0, labelEnd);

  // segments split at depth-0 ` · `; each remembers its first spaced em/en dash
  const segs: Array<{ a: number; b: number; em: number }> = [];
  let a = labelEnd;
  for (let i = labelEnd; i <= s.length; i++) {
    if (i === s.length || (s[i] === '·' && mask[i] === 0)) { segs.push({ a, b: i, em: -1 }); a = i + 1; }
  }
  for (const seg of segs) {
    for (let i = seg.a + 1; i < seg.b - 1; i++) {
      if ((s[i] === '—' || s[i] === '–') && mask[i] === 0 && /\s/.test(s[i - 1]!) && /\s/.test(s[i + 1]!)) { seg.em = i; break; }
    }
  }

  const sites: Site[] = [];
  const notes: string[] = [];
  const cands = new Map<number, Site[]>(); // segment index → bare numbers in its ` — ` aside
  for (const m of s.matchAll(qtyScanRe())) {
    const start = m.index!;
    if (start < labelEnd || mask[start] !== 0) continue;
    const q = qtyFromMatch(m);
    if (!q) continue;
    const end = start + m[0].length;
    const si = segs.findIndex((g) => start >= g.a && start < g.b);
    const seg = segs[si]!;
    const site: Site = { start, end, q, approx: m[1] ?? '', sep: m[3] ?? '', segEnd: seg.b };
    const pre = s.slice(seg.a, start);
    if (/(?:×|\bx)\s*$/.test(pre)) continue; // right operand of `4 × 6 oz` is a per-unit size
    const guard = guardAt(s, end);
    if (guard === 'mult') { notes.push(`left as written: ${snippetAt(s, start)}`); continue; }
    if (guard !== 'ok') continue; // sizes, times, temperatures, per-unit amounts
    const inEm = seg.em >= 0 && start > seg.em;
    if (/^[\s*]*$/.test(pre) || /(?:\+|\b(?:plus|or|of|from))\s+$/i.test(pre)) sites.push(site);
    else if (/,\s+$/.test(pre) && !inEm) sites.push(site);
    else if (inEm && /(?:,|[—–])\s+$/.test(pre)) {
      if (matchUnit(s, end)) sites.push(site);
      else cands.set(si, [...(cands.get(si) ?? []), site]);
    } else notes.push(`left as written: ${snippetAt(s, start)}`);
  }
  // (d) breakdown asides: bare parts that sum to the segment's lead scale with it
  for (const [si, parts] of cands) {
    const seg = segs[si]!;
    const lead = sites.find((x) => x.start >= seg.a && x.start < seg.b && /^[\s*]*$/.test(s.slice(seg.a, x.start)));
    const sum = parts.reduce((t, p) => t + p.q.value, 0);
    if (lead && lead.q.hi === undefined && parts.length >= 2 && parts.every((p) => p.q.hi === undefined) && Math.abs(sum - lead.q.value) < EPS) {
      lead.noTidy = true;
      for (const p of parts) sites.push({ ...p, breakdown: true });
    } else for (const p of parts) notes.push(`left as written: ${snippetAt(s, p.start)}`);
  }
  // parenthesised amounts that look like they should move — never touched, only reported
  for (const g of groups) {
    if (g.kind !== '(' || CONTAINER_BEFORE_RE.test(s.slice(0, g.start))) continue;
    const inner = stripGroups(s.slice(g.start + 1, s[g.end - 1] === ')' ? g.end - 1 : g.end));
    for (const m of inner.matchAll(qtyScanRe())) {
      const end = m.index! + m[0].length;
      if (guardAt(inner, end) === 'ok' && /^\s+\p{L}/u.test(inner.slice(end))) {
        notes.push(`left as written: ${clip(s.slice(g.start, g.end), 60)}`);
        break;
      }
    }
  }

  const edits: Edit[] = [];
  for (const st of sites) {
    const { q } = st;
    let lo = q.value * factor;
    let hi = q.hi === undefined ? undefined : q.hi * factor;
    const wasPlural = isPlural(q.hi ?? q.value);
    const unit = st.breakdown ? null : matchUnit(s, st.end);
    if (unit) {
      let unitText: string | null = null;
      if (unit.def.fam && !st.noTidy) {
        const t = tidy(unit.def.fam, lo, hi);
        if (t.fam !== unit.def.fam) { lo = t.lo; hi = t.hi; unitText = FAM_WORD[t.fam](isPlural(hi ?? lo)); }
      }
      const nowPlural = isPlural(hi ?? lo);
      if (unitText === null && !unit.def.invariant && wasPlural !== nowPlural) {
        unitText = matchCase(unit.word, nowPlural ? unit.def.plural : unit.def.singular);
      }
      if (unitText !== null) edits.push({ start: unit.start, end: unit.end, text: unitText });
    } else if (!st.breakdown) {
      const nowPlural = isPlural(hi ?? lo);
      if (wasPlural !== nowPlural) edits.push(...nounEdits(s, st.end, st.segEnd, nowPlural));
    }
    edits.push({ start: st.start, end: st.end, text: st.approx + formatQty(lo) + (hi === undefined ? '' : st.sep + formatQty(hi)) });
  }

  const uniqNotes = [...new Set(notes)];
  const out: ScaledLine = { text: line, scaled: sites.length > 0 };
  if (uniqNotes.length) out.notes = uniqNotes;
  if (factor === 1 || !edits.length) return out;
  edits.sort((x, y) => x.start - y.start);
  let text = '';
  let pos = 0;
  for (const e of edits) {
    if (e.start < pos) continue; // defensive: never overlap
    text += s.slice(pos, e.start) + e.text;
    pos = e.end;
  }
  out.text = prefix + text + s.slice(pos);
  return out;
}

// ------------------------------------------------------------------ bodies

const INGREDIENTS_RE = /^##\s+Ingredients\b/i;
const HEADING_RE = /^#{1,2}\s/;
const ITEM_RE = /^\s*[-*]\s+\S/;

/** The `- ` lines of the `## Ingredients` section (until the next `#`/`##` heading). */
function ingredientLines(body: string): string[] {
  const out: string[] = [];
  let inSec = false;
  for (const raw of body.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (HEADING_RE.test(line)) { inSec = INGREDIENTS_RE.test(line); continue; }
    if (inSec && ITEM_RE.test(line)) out.push(line);
  }
  return out;
}

/**
 * Scale the `## Ingredients` list lines of a recipe body (or whole file);
 * every other byte is untouched — including frontmatter `servings:`.
 */
export function scaleIngredients(body: string, factor: number): ScaledBody {
  assertFactor(factor);
  const lines = body.split('\n');
  const unscaled: string[] = [];
  const flagged: ScaledBody['flagged'] = [];
  let inSec = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const cr = raw.endsWith('\r');
    const line = cr ? raw.slice(0, -1) : raw;
    if (HEADING_RE.test(line)) { inSec = INGREDIENTS_RE.test(line); continue; }
    if (!inSec || !ITEM_RE.test(line)) continue;
    const r = scaleIngredientLine(line, factor);
    if (!r.scaled) unscaled.push(line);
    if (r.notes) flagged.push({ line, notes: r.notes });
    if (r.text !== line) lines[i] = r.text + (cr ? '\r' : '');
  }
  return { body: lines.join('\n'), unscaled, flagged };
}

/** A line's first ` · ` segment (list marker, label and leading `**` dropped) and its lead quantity, if it has one. */
function leadOf(line: string): { s: string; m: RegExpExecArray } | null {
  let s = line.replace(LIST_RE, '');
  s = s.slice(labelLength(s));
  const dot = (() => {
    let depth = 0;
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '[' || c === '(') depth++;
      else if ((c === ']' || c === ')') && depth > 0) depth--;
      else if (c === '·' && depth === 0) return i;
    }
    return s.length;
  })();
  s = s.slice(0, dot).replace(/^[\s*]+/, '');
  const m = QTY_LEAD_RE.exec(s);
  if (!m || !qtyFromMatch(m) || guardAt(s, m[0].length) !== 'ok') return null;
  return { s, m };
}

/** Loose singular form so `lentils` = `lentil`, `thighs` = `thigh`, `anchovies` = `anchovy` (applied to both sides). */
function stem(w: string): string {
  const t = w.toLowerCase();
  if (t.length > 4 && t.endsWith('ies')) return `${t.slice(0, -3)}y`;
  if (t.length > 4 && /(?:ches|shes|sses|xes|zes|oes)$/.test(t)) return t.slice(0, -2);
  if (t.length > 3 && t.endsWith('s') && !t.endsWith('ss')) return t.slice(0, -1);
  return t;
}
const stems = (s: string) => (s.match(/\p{L}+/gu) ?? []).map(stem);

/**
 * The recipe's main ingredient line, for the headline. Without a `protein`
 * value: the first line (house rule: the main ingredient comes first). With
 * one: the first line with a lead amount whose ingredient name (after the
 * amount; tags, parens and ` — ` asides dropped) contains every word of it,
 * else any of its words (`chicken-thigh` → chicken / thigh, plural-tolerant),
 * else (the protein is named differently, `white-fish` vs `cod`) the first
 * unlabeled line bought by weight (lb/oz/g/kg) or by the piece as a cut
 * (`4 cod fillets`, `2 NY strip steaks`), else the first line.
 * Every-word first so `chicken thighs` beats an earlier `chicken stock`;
 * labeled lines (`**Smashed potatoes:** 1½ lb …`) are components and sides, so
 * they never win on weight alone.
 */
const CUT_NOUNS = new Set(['fillet', 'filet', 'steak', 'thigh', 'breast', 'drumstick', 'cutlet', 'chop', 'shank']);
function mainLine(lines: string[], protein?: string): string | undefined {
  const want = [...new Set(stems(protein ?? ''))];
  if (!want.length) return lines[0];
  const leads = lines.map(leadOf);
  const names = leads.map((l) => {
    if (!l) return null;
    const name = stripGroups(l.s.slice(l.m[0].length));
    const aside = /\s[—–]\s/.exec(name);
    return new Set(stems(aside ? name.slice(0, aside.index) : name));
  });
  const every = names.findIndex((n) => n !== null && want.every((w) => n.has(w)));
  if (every >= 0) return lines[every];
  const some = names.findIndex((n) => n !== null && want.some((w) => n.has(w)));
  if (some >= 0) return lines[some];
  const bulk = leads.findIndex((l, i) => {
    if (!l || labelLength(lines[i]!.replace(LIST_RE, ''))) return false;
    const u = matchUnit(l.s, l.m[0].length);
    if (u) return u.def.fam === 'lb' || u.def.fam === 'oz' || u.def.singular === 'g' || u.def.singular === 'kg';
    return [...names[i]!].some((w) => CUT_NOUNS.has(w));
  });
  return lines[bulk >= 0 ? bulk : 0];
}

/**
 * The main ingredient's scaled amount + unit + short name (`3 lb salmon
 * fillet`, `3 cups red lentils`, `4 pitas`); null if that line has no amount.
 * `protein` is the recipe's frontmatter value; see `mainLine` for the pick.
 */
export function headline(body: string, factor: number, protein?: string): string | null {
  assertFactor(factor);
  const pick = mainLine(ingredientLines(body), protein);
  if (pick === undefined) return null;
  const lead = leadOf(scaleIngredientLine(pick, factor).text);
  if (!lead) return null;
  const { s, m } = lead;
  let rest = stripGroups(s.slice(m[0].length)).replace(/\*+/g, '').replace(/\s+/g, ' ');
  const cut = /\s*(?:[,;]|\s[—–]\s|\s\+\s|\s(?:in|with|for|from|to|into|plus|at)\s)/i.exec(rest);
  if (cut) rest = rest.slice(0, cut.index);
  const words = rest.trim().split(' ').filter(Boolean).slice(0, 6);
  return [m[0], ...words].join(' ');
}

/** Scale factor from the recipe's `servings` (default 4) to the target. */
export function factorFor(recipeServings: number | undefined, targetServings: number): number {
  const base = typeof recipeServings === 'number' && Number.isFinite(recipeServings) && recipeServings > 0 ? recipeServings : 4;
  if (!Number.isFinite(targetServings) || targetServings <= 0) {
    throw new RangeError(`target servings must be a positive number, got ${targetServings}`);
  }
  return targetServings / base;
}
