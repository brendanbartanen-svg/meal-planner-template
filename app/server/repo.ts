// Readers for the repo's plans/ and recipes/ directories (parsed via parse.ts).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePlan, parseRecipe, SAFE_FILE, type ParsedPlan, type RecipeMeta } from './parse.ts';
import { plansDir, recipeImagesDir, recipesDir } from './paths.ts';

// ---------- repo readers ----------

export async function readAllPlans(): Promise<Map<string, ParsedPlan>> {
  const out = new Map<string, ParsedPlan>();
  let files: string[] = [];
  try { files = (await fs.readdir(plansDir)).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)); } catch { return out; }
  for (const file of files) {
    try {
      const plan = parsePlan(await fs.readFile(path.join(plansDir, file), 'utf8'), file);
      if (plan.week) out.set(plan.week, plan);
    } catch { /* one bad file shouldn't hide the rest */ }
  }
  return out;
}

/** recipes/images/<slug>.<ext> — the picture a recipe's slug (file minus .md) owns. */
export const RECIPE_IMAGE = /^([a-z0-9-]+)\.(jpe?g|png|webp)$/i;

/**
 * slug → URL path (`/recipe-images/<filename>`) for every picture in
 * recipes/images/ (discovered by filename; frontmatter never points at one).
 * Missing folder → empty map. A readdir per call: cheap, so no cache.
 */
export async function recipeImages(): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let files: string[] = [];
  try { files = await fs.readdir(recipeImagesDir); } catch { return out; }
  for (const f of files.sort()) {
    const m = RECIPE_IMAGE.exec(f);
    const slug = m?.[1];
    if (slug && !out.has(slug)) out.set(slug, `/recipe-images/${encodeURIComponent(f)}`);
  }
  return out;
}

export const recipeSlug = (file: string) => file.replace(/\.md$/, '');

export async function readRecipes(): Promise<RecipeMeta[]> {
  let files: string[] = [];
  try { files = (await fs.readdir(recipesDir)).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return []; }
  const images = await recipeImages();
  const out: RecipeMeta[] = [];
  for (const file of files) {
    try {
      const meta = parseRecipe(await fs.readFile(path.join(recipesDir, file), 'utf8'), file).meta;
      const image = images.get(recipeSlug(file));
      if (image) meta.image = image;
      out.push(meta);
    } catch { /* skip unreadable */ }
  }
  return out;
}

/** A recipe with no picture yet (the app's /recipe-images reminders). */
export interface ImageMissing { file: string; name: string }

/**
 * Every recipes/*.md (not README) whose slug has no picture in recipes/images/,
 * sorted by name. A readdir plus the images map; only the files it reports are
 * parsed (for their names), so on a fully pictured library nothing is read.
 * The app only reminds: pictures are made on the Mac by /recipe-images.
 */
export async function recipesWithoutImage(): Promise<ImageMissing[]> {
  let files: string[] = [];
  try { files = (await fs.readdir(recipesDir)).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return []; }
  const images = await recipeImages();
  const out: ImageMissing[] = [];
  for (const file of files) {
    if (images.has(recipeSlug(file))) continue;
    let name = recipeSlug(file);
    try { name = parseRecipe(await fs.readFile(path.join(recipesDir, file), 'utf8'), file).meta.name; } catch { /* keep the slug */ }
    out.push({ file, name });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Join each meal of the given plans to its recipe file, by `recipeFile`: the
 * dish `description`, and the recipe's own active time and per-serving
 * calories/protein in place of the plan row's. The plan row is a snapshot
 * from lock day; the recipe file is what the Recipes and Cook tabs show (and
 * what close-out recalibrates), so the Week and Next tabs must not disagree
 * with it. Reads only the recipe files those plans link; a meal whose file is
 * missing (a 🆕 not written yet) keeps its plan-row numbers and gets no
 * description. The recipe's picture (`image`, recipes/images/<slug>.jpg) rides
 * along too. In-memory only: the plan files are never touched.
 */
export async function addRecipeMeta(...plans: (ParsedPlan | null | undefined)[]): Promise<void> {
  const seen = new Map<string, RecipeMeta | undefined>();
  const images = await recipeImages();
  const pos = (n: number | undefined) => (typeof n === 'number' && n > 0 ? n : undefined);
  for (const plan of plans) {
    for (const m of plan?.meals ?? []) {
      const f = m.recipeFile;
      if (!f || !SAFE_FILE.test(f)) continue;
      if (!seen.has(f)) {
        try { seen.set(f, parseRecipe(await fs.readFile(path.join(recipesDir, f), 'utf8'), f).meta); }
        catch { seen.set(f, undefined); /* 🆕 with no file yet, or unreadable */ }
      }
      const image = images.get(recipeSlug(f));
      if (image) m.image = image;
      const r = seen.get(f);
      if (!r) continue;
      if (r.description) m.description = r.description;
      m.timeMin = pos(r.active_time_min) ?? m.timeMin;
      m.cal = pos(r.nutrition?.calories) ?? m.cal;
      m.protein = pos(r.nutrition?.protein_g) ?? m.protein;
    }
  }
}
