// Export this household's recipes/ as the shareable template's starter
// library (docs/2026-10-12-template-refresh.md). Text-level only — the
// frontmatter is edited line by line, never round-tripped through YAML — so
// every recipe keeps its exact house format:
//   - frontmatter: `rating:`, `last_cooked:` and `cadence:` (the household's
//     own rhythm) removed, `times_cooked: 0`;
//   - `source:` sentences that name a person dropped, and clauses (split on
//     sentences, `; ` or ` — `) about this household's cooks ("first cook",
//     "confirmed correct", "household favorite"; a "DRAFT" piece drops the
//     rest of the line); nothing left → `original`;
//   - Ingredients / Prep / Steps: a parenthetical aside naming a week id
//     (`(frozen from W29 — …)`) removed, every other paren stays; inside a
//     `[C — …]` source tag, clauses (split on `; ` / ` — `) naming a week id
//     dropped, leaving the plain `[C]` if nothing else is left;
//   - `## Notes`: the `<!-- … -->` comment line and only technique bullets
//     survive (no dates, no week ids, no ratings, no people, no rotation
//     rules: "Standing ask", "household", "rotate it in", "cadence", or a
//     link to another recipe file);
//   - source tags and store names genericized: [C …] → [1 …], [K …] → [2 …],
//     Costco → "the warehouse club", Kroger → "the supermarket", and the
//     legend comment → the template's `[1] primary store, [2] secondary store`.
// Each exported recipe's picture (recipes/images/<slug>.<jpg|jpeg|png|webp>,
// the RECIPE_IMAGE pattern from server/repo.ts) is copied byte-for-byte to
// <out dir>/images/; importing a starter recipe copies it along
// (server/starter.ts).
// Usage (from app/):
//   npx tsx scripts/starter-export.ts <out dir>               export recipes/*.md + images/ + a README
//   npx tsx scripts/starter-export.ts --genericize <in> <out>  tags/stores only (recipes/README.md for the template)
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { RECIPE_IMAGE } from '../server/repo.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const recipesDir = path.join(repoRoot, 'recipes');
const imagesDir = path.join(recipesDir, 'images');

export const LEAK_RE = /Costco|Kroger|Brendan|wife|Esme/;
const PERSON_RE = /Brendan|\bwife\b|Esme/;
const DATE_RE = /\d{4}-\d{2}(?:-\d{2})?/;
const WEEK_RE = /\bW\d{2}\b/;
const RATING_RE = /\b[1-5]\b(?= —|\/5)|\brated\s+[1-5]\b|\b[1-5]\s+rated\b/;
const HOUSE_NOTE_RE = /Standing ask|household|rotate it in|cadence|\]\([^)]*\.md\)/i;
const HOUSE_SOURCE_RE = /first cook|confirmed correct|household favorite/i;
const WEEK_PAREN_RE = /\s*\([^()]*\bW\d{2}\b[^()]*\)/g;

const TAG_MAP: Record<string, string> = { C: '1', K: '2', P: 'P' };

/** Source tags + store names + people → the template's generic wording. Safe on any house-format text. */
export function genericize(text: string): string {
  let s = text
    // the legend comments (recipes and recipes/README.md)
    .replace(/\[C\] Costco, \[K\] Kroger, \[P\] pantry/g, '[1] primary store, [2] secondary store, [P] pantry')
    // tags: [C], [K — …], [C/K], [K/P …] (same lookahead as the Cook tab's tag regex)
    .replace(/\[([CKP](?:\/[CKP])*)(?=[\]\s—–,;:])/g, (_m, codes: string) => `[${codes.split('/').map((c) => TAG_MAP[c]).join('/')}`)
    // the README's rule text names the old codes
    .replace(/`\[C\/K\/P …\]`/g, '`[1/2/P …]`')
    .replace(/Costco’s|Costco's/g, "the warehouse club's")
    .replace(/Costco/g, 'the warehouse club')
    .replace(/Kroger’s|Kroger's/g, "the supermarket's")
    .replace(/Kroger/g, 'the supermarket')
    .replace(/\bthe the /g, 'the ')
    .replace(/\bThe the /g, 'The ')
    .replace(/\bat the the\b/g, 'at the')
    .replace(/(-lb|-oz|-pack|-count|the|my|our|your) the (warehouse club|supermarket)/g, '$1 $2') // "the 6-lb the warehouse club pack"
    .replace(/\b([Aa]n?) the (warehouse club|supermarket)/g, (_m, a: string, store: string) => `${a === 'an' || a === 'An' ? a.slice(0, 1) : a} ${store}`)
    .replace(/Brendan’s NYT Cooking PDF|Brendan's NYT Cooking PDF/g, 'a NYT Cooking PDF')
    .replace(/Brendan’s|Brendan's/g, "the cook's")
    .replace(/Brendan/g, 'the cook');
  // sentence starts: "- the warehouse club sells" → "- The warehouse club sells"
  s = s.replace(/(\n[-*] |(?<=[a-z0-9)\]]{2}[.!?]) )the (warehouse club|supermarket|cook)\b/g, (_m, pre: string, w: string) => `${pre}The ${w}`);
  return s;
}

function keepNote(line: string): boolean {
  return !(DATE_RE.test(line) || WEEK_RE.test(line) || RATING_RE.test(line) || PERSON_RE.test(line) || HOUSE_NOTE_RE.test(line));
}

/** Source tags on one body line → without clauses that name a week id. */
function cleanWeekTags(line: string): string {
  return line.replace(/\[([CKP](?:\/[CKP])*)([^\]]*)\]/g, (m, code: string, body: string) => {
    if (!WEEK_RE.test(body)) return m;
    // [lead, sep, clause, sep, clause]: lead is whatever follows the code before the first separator
    const parts = body.split(/(; | — )/);
    let kept = '';
    for (let i = 0; i < parts.length; i += 2) {
      const clause = parts[i]!;
      if (!clause.trim() || WEEK_RE.test(clause)) continue;
      kept += i === 0 ? clause : (kept ? parts[i - 1]! : ' — ') + clause;
    }
    return `[${code}${kept}]`;
  });
}

/** `source:` value → without person sentences or household clauses; '' when nothing is left. */
function cleanSource(v: string): string {
  // [clause, sep, clause, sep, clause]: sentences (". ", "; ") and " — " clauses
  const parts = v.split(/((?<=[.;])\s+| — )/);
  let kept = '';
  for (let i = 0; i < parts.length; i += 2) {
    const clause = parts[i]!;
    if (/DRAFT/.test(clause)) break; // a draft caveat runs to the end of the line ("…; correct to match how you make it")
    if (!clause.trim() || PERSON_RE.test(clause) || HOUSE_SOURCE_RE.test(clause)) continue;
    kept += (kept ? parts[i - 1]! : '') + clause;
  }
  return kept.trim().replace(/[.;]\s*$/, '').replace(/\s+—\s*$/, '');
}

interface FileReport { file: string; removed: string[]; notesKept: number; notesDropped: number }

/** One recipe → its starter version (see the header for what changes). */
export function exportRecipe(raw: string, file = ''): { text: string; report: FileReport } {
  const report: FileReport = { file, removed: [], notesKept: 0, notesDropped: 0 };
  const nl = raw.includes('\r\n') ? '\r\n' : '\n';
  const lines = raw.split(/\r?\n/);
  const out: string[] = [];
  let fm = lines[0] === '---' ? 1 : 0; // 1 = inside frontmatter, 2 = past it
  let inNotes = false;
  let inBody = false; // Ingredients / Prep / Steps
  let sawTimes = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (fm === 1 && i > 0 && line === '---') {
      if (!sawTimes) out.push('times_cooked: 0');
      fm = 2;
      out.push(line);
      continue;
    }
    if (fm === 1) {
      const key = /^([A-Za-z_]+):/.exec(line)?.[1];
      if (key === 'rating' || key === 'last_cooked' || key === 'cadence') { report.removed.push(key); continue; }
      if (key === 'times_cooked') { sawTimes = true; out.push('times_cooked: 0'); continue; }
      if (key === 'source') {
        const v = line.slice('source:'.length).trim();
        const kept = cleanSource(v);
        if (kept !== v) report.removed.push('source clause');
        out.push(`source: ${kept || 'original'}`);
        continue;
      }
      out.push(line);
      continue;
    }
    if (/^## /.test(line)) {
      inNotes = /^## Notes\b/.test(line);
      inBody = /^## (Ingredients|Prep|Steps)\b/.test(line);
    } else if (inBody && WEEK_RE.test(line)) {
      const cleaned = cleanWeekTags(line.replace(WEEK_PAREN_RE, '')).replace(/(\S) {2,}/g, '$1 ').replace(/\s+$/, '');
      if (cleaned !== line) report.removed.push('week aside');
      out.push(cleaned);
      continue;
    } else if (inNotes) {
      if (/^\s*<!--/.test(line) || !line.trim()) { out.push(line); continue; }
      if (/^[-*] /.test(line)) {
        if (keepNote(line)) { report.notesKept++; out.push(line); } else report.notesDropped++;
        continue;
      }
      // anything else in Notes (no recipe has any today) goes the same way as a bullet
      if (keepNote(line)) out.push(line); else report.notesDropped++;
      continue;
    }
    out.push(line);
  }
  // no blank runs where dropped bullets used to be; one trailing newline
  const text = genericize(out.join('\n').replace(/\n{3,}/g, '\n\n').replace(/\n*$/, '\n'));
  return { text: nl === '\n' ? text : text.replace(/\n/g, nl), report };
}

const STARTER_README = `# Starter recipes

A starter library for a fresh install: tested dinners from the template author's kitchen, written in the
house format (\`recipes/README.md\`). Ratings, cook counts and cook-by-cook history were stripped; Notes keep
only technique. Source tags use the template's codes: \`[1]\` primary store, \`[2]\` secondary store,
\`[P]\` pantry.

**Importing.** While any of these is not yet in \`recipes/\`, the app's Recipes tab shows a **Starter
library** card: tick what suits you and import. Importing copies the files into \`recipes/\` unchanged and
commits them; anything already in \`recipes/\` is skipped, never overwritten. Without the app, from \`app/\`:

    npm run starter              # list them
    npm run starter -- --all     # import everything not yet in recipes/
    npm run starter -- goulash red-lentil-dal

**Pictures.** \`images/\` holds each recipe's picture (\`images/<slug>.jpg\`, the recipe's file name without
\`.md\`). Importing a recipe also copies its picture to \`recipes/images/\`, where the app shows it; an
existing picture there is left alone.

Imported recipes are yours: edit or delete them like any other recipe.

**Delete this folder when you are done with it.** The app never reads it for planning (only \`recipes/\`
is the library), and once it is gone the Starter library card goes away.
`;

async function main() {
  const args = process.argv.slice(2);
  if (args[0] === '--genericize') {
    const [, input, output] = args;
    if (!input || !output) throw new Error('usage: starter-export.ts --genericize <in> <out>');
    const text = genericize(await fs.readFile(input, 'utf8'));
    await fs.writeFile(output, text);
    const leaks = text.split('\n').filter((l) => LEAK_RE.test(l));
    console.log(`genericized ${input} → ${output}${leaks.length ? `\nstill mentions: ${leaks.join('\n')}` : ''}`);
    return;
  }
  const outDir = args[0];
  if (!outDir) throw new Error('usage: starter-export.ts <out dir>');
  await fs.mkdir(outDir, { recursive: true });
  const files = (await fs.readdir(recipesDir)).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  for (const f of files) {
    const { text, report } = exportRecipe(await fs.readFile(path.join(recipesDir, f), 'utf8'), f);
    await fs.writeFile(path.join(outDir, f), text);
    console.log(`  ${f.padEnd(44)} notes kept ${String(report.notesKept).padStart(2)}, dropped ${String(report.notesDropped).padStart(2)}${report.removed.length ? ` · removed ${report.removed.join(', ')}` : ''}`);
  }
  await fs.writeFile(path.join(outDir, 'README.md'), STARTER_README);
  // each exported recipe's picture, byte-for-byte (first match per slug, same order as repo.ts recipeImages)
  const slugs = new Set(files.map((f) => f.replace(/\.md$/, '')));
  const copied = new Set<string>();
  let imageFiles: string[] = [];
  try { imageFiles = (await fs.readdir(imagesDir)).sort(); } catch { /* no images folder: none to copy */ }
  for (const img of imageFiles) {
    const slug = RECIPE_IMAGE.exec(img)?.[1];
    if (!slug || !slugs.has(slug) || copied.has(slug)) continue;
    if (!copied.size) await fs.mkdir(path.join(outDir, 'images'), { recursive: true });
    await fs.copyFile(path.join(imagesDir, img), path.join(outDir, 'images', img));
    copied.add(slug);
  }
  console.log(`\nexported ${files.length} recipes + ${copied.size} image${copied.size === 1 ? '' : 's'} + README.md → ${outDir}`);
  // final leak check over everything written (text only; images/ is binary and skipped)
  const leaks: string[] = [];
  for (const f of [...files, 'README.md']) {
    const lines = (await fs.readFile(path.join(outDir, f), 'utf8')).split('\n');
    lines.forEach((l, i) => { if (LEAK_RE.test(l)) leaks.push(`${f}:${i + 1}: ${l.slice(0, 160)}`); });
  }
  if (leaks.length) {
    console.error(`\nLEAK CHECK FAILED (Costco|Kroger|Brendan|wife|Esme):\n${leaks.join('\n')}`);
    process.exit(1);
  }
  console.log('leak check (Costco|Kroger|Brendan|wife|Esme): clean');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => { console.error(err instanceof Error ? err.message : String(err)); process.exit(1); });
}
