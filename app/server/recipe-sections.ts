// Split a recipe body (house format, recipes/README.md) into the pieces the
// Cook tab renders: Ingredients / Prep / Steps item texts plus the Notes
// markdown, optionally after deterministic scaling (scale.ts). Pure: no I/O,
// no markdown rendering — the route renders `notesMd` to HTML.
//
// Recognized `## ` sections (case-insensitive): Ingredients · Prep (or
// "Mise en place"; never "Prep ahead") · Steps (or Method / Instructions /
// Directions) · Notes. Any other `## ` section, and loose text before the
// first section, is folded into the notes markdown under its own heading so
// nothing silently disappears. `# ` lines are dropped; HTML comments too.
//
// Inside Ingredients / Prep / Steps:
//   - a top-level item (`- `, `* `, `+ `, `1. `, `1) `; indent 0–1) starts an
//     item; its text is kept as raw inline markdown with the marker stripped
//     (`**Sauce:** whisk the soy and honey` stays exactly that);
//   - indented lines (2+ spaces or a tab, nested bullets included) join the
//     item with "\n"; a non-indented line directly under an item (markdown's
//     lazy continuation) joins it with a space;
//   - a line that is only bold (`**Filling**`, `**Whipped feta:**`) or a
//     `### ` heading is a group head; any other loose text is an aside. Both
//     land in `inserts[section]` with `before` = the index of the item they
//     precede (= items.length when they trail the list).
//
// The Prep format the migration writes (and this reads): `## Prep` between
// Ingredients and Steps, one `- ` bullet per task done before heat, optionally
// opened by a bold component label — `- **Glaze:** grate the garlic and
// ginger, whisk everything together`. Bold-only head lines also work.
import { factorFor, formatQty, scaleIngredients, type ScaledBody } from './scale.ts';

export type ListSection = 'ingredients' | 'prep' | 'steps';
export interface SectionInsert { before: number; text: string; head: boolean }
export interface RecipeSections {
  ingredients: string[];
  prep: string[];
  steps: string[];
  /** Notes section (plus any unrecognized sections) as markdown; '' when empty. */
  notesMd: string;
  inserts: Record<ListSection, SectionInsert[]>;
}
export interface RecipeScale {
  baseServings: number;
  servings: number;
  factor: number;
  /** `formatQty(factor)`: "2", "1½", "¾" — for "Scaled ×2" banners. */
  factorText: string;
  /** Present only when factor ≠ 1: ingredient texts (marker stripped) with no scalable amount, as written. */
  unscaled?: string[];
  /** Present only when factor ≠ 1: ingredient texts carrying numbers left as written, with why. */
  flagged?: Array<{ line: string; notes: string[] }>;
}

const H1_RE = /^#\s/;
const H2_RE = /^##\s+(.*?)\s*#*\s*$/;
const H3_RE = /^#{3,6}\s+(.*?)\s*#*\s*$/;
const ITEM_RE = /^([ \t]*)(?:[-*+]|\d{1,3}[.)])\s+(.*)$/;
const BOLD_HEAD_RE = /^\*\*([^*]+?)\*\*\s*:?\s*$/;
const INDENTED_RE = /^(?: {2,}|\t)/;

function sectionOf(heading: string): ListSection | 'notes' | null {
  if (/^ingredients\b/i.test(heading)) return 'ingredients';
  if (/^prep\b(?![\s_-]*ahead)/i.test(heading) || /^mise en place\b/i.test(heading)) return 'prep';
  if (/^(?:steps|method|instructions|directions)\b/i.test(heading)) return 'steps';
  if (/^notes\b/i.test(heading)) return 'notes';
  return null;
}

/** Strip a leading `---` frontmatter block, if any (lets callers pass a whole file). */
function stripFrontmatter(src: string): string {
  if (!src.startsWith('---')) return src;
  const end = src.indexOf('\n---', 3);
  if (end === -1) return src;
  const nl = src.indexOf('\n', end + 1);
  return nl === -1 ? '' : src.slice(nl + 1);
}

/** The bullet text an item line carries (marker and outer whitespace stripped). */
export function itemText(line: string): string {
  const m = ITEM_RE.exec(line);
  return (m ? m[2]! : line).trim();
}

function parseList(lines: string[]): { items: string[]; inserts: SectionInsert[] } {
  const items: string[] = [];
  const inserts: SectionInsert[] = [];
  let cur: string[] | null = null;
  let blank = false;
  const flush = () => { if (cur) { items.push(cur.join('\n')); cur = null; } };
  for (const line of lines) {
    if (!line.trim()) { blank = true; continue; }
    const m = ITEM_RE.exec(line);
    const indent = m ? m[1]!.replace(/\t/g, '    ').length : 0;
    if (m && indent < 2) { flush(); cur = [m[2]!.trim()]; blank = false; continue; }
    const h3 = H3_RE.exec(line);
    const bold = BOLD_HEAD_RE.exec(line.trim());
    if (cur && !h3 && !bold && INDENTED_RE.test(line)) { cur.push(line.trim()); blank = false; continue; }
    if (cur && !h3 && !bold && !blank) { cur[cur.length - 1] += ` ${line.trim()}`; continue; }
    flush();
    blank = false;
    if (h3) inserts.push({ before: items.length, text: h3[1]!, head: true });
    else if (bold) inserts.push({ before: items.length, text: bold[1]!.trim().replace(/\s*:$/, ''), head: true });
    else inserts.push({ before: items.length, text: line.trim(), head: false });
  }
  flush();
  return { items, inserts };
}

/** Section a recipe body (or a whole file — frontmatter is skipped). */
export function recipeSections(src: string): RecipeSections {
  const body = stripFrontmatter(src.replace(/\r\n?/g, '\n')).replace(/<!--[\s\S]*?-->/g, '');
  const buckets: Record<ListSection, string[]> = { ingredients: [], prep: [], steps: [] };
  const notes: string[] = [];
  const extra: string[] = [];
  let where: ListSection | 'notes' | 'extra' = 'extra';
  for (const line of body.split('\n')) {
    const h2 = H2_RE.exec(line);
    if (h2) {
      const s = sectionOf(h2[1]!);
      // a repeated section heading appends; an unknown one is kept under its name
      where = s ?? 'extra';
      if (!s) extra.push('', `### ${h2[1]}`, '');
      continue;
    }
    if (H1_RE.test(line)) continue;
    if (where === 'notes') notes.push(line);
    else if (where === 'extra') extra.push(line);
    else buckets[where].push(line);
  }
  const ing = parseList(buckets.ingredients);
  const prep = parseList(buckets.prep);
  const steps = parseList(buckets.steps);
  const notesMd = [notes.join('\n').trim(), extra.join('\n').trim()].filter(Boolean).join('\n\n');
  return {
    ingredients: ing.items,
    prep: prep.items,
    steps: steps.items,
    notesMd,
    inserts: { ingredients: ing.inserts, prep: prep.inserts, steps: steps.inserts },
  };
}

/**
 * Sections at a target servings count. `targetServings` null/undefined (or
 * equal to the base) → no scaling: factor 1, no `unscaled`/`flagged`.
 * `baseServings` is the recipe's frontmatter `servings` (default 4, as factorFor).
 * Throws RangeError for a non-positive target — callers validate first.
 */
export function scaledSections(body: string, recipeServings: number | undefined, targetServings?: number | null): {
  sections: RecipeSections; scale: RecipeScale; body: string;
} {
  const base = typeof recipeServings === 'number' && Number.isFinite(recipeServings) && recipeServings > 0 ? recipeServings : 4;
  const servings = targetServings ?? base;
  const factor = factorFor(base, servings);
  if (factor === 1) {
    return { sections: recipeSections(body), scale: { baseServings: base, servings, factor: 1, factorText: '1' }, body };
  }
  const scaled: ScaledBody = scaleIngredients(body, factor);
  return {
    sections: recipeSections(scaled.body),
    scale: {
      baseServings: base, servings, factor, factorText: formatQty(factor),
      unscaled: scaled.unscaled.map(itemText),
      flagged: scaled.flagged.map((f) => ({ line: itemText(f.line), notes: f.notes })),
    },
    body: scaled.body,
  };
}

/** A plain numeric frontmatter scalar (e.g. `prep_min: 15`) that RecipeMeta may not carry yet. */
export function frontmatterNumber(raw: string, key: string): number | undefined {
  if (!/^[a-z_]+$/i.test(key) || !raw.startsWith('---')) return undefined;
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return undefined;
  const m = new RegExp(`^${key}:[ \\t]*([0-9]+(?:\\.[0-9]+)?)[ \\t]*(?:#.*)?$`, 'm').exec(raw.slice(0, end));
  return m ? Number(m[1]) : undefined;
}
