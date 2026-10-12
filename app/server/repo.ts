// Readers for the repo's plans/ and recipes/ directories (parsed via parse.ts).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePlan, parseRecipe, SAFE_FILE, type ParsedPlan, type RecipeMeta } from './parse.ts';
import { plansDir, recipesDir } from './paths.ts';

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

export async function readRecipes(): Promise<RecipeMeta[]> {
  let files: string[] = [];
  try { files = (await fs.readdir(recipesDir)).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return []; }
  const out: RecipeMeta[] = [];
  for (const file of files) {
    try { out.push(parseRecipe(await fs.readFile(path.join(recipesDir, file), 'utf8'), file).meta); }
    catch { /* skip unreadable */ }
  }
  return out;
}

/**
 * Join each meal of the given plans to its recipe file, by `recipeFile`: the
 * dish `description`, and the recipe's own active time and per-serving
 * calories/protein in place of the plan row's. The plan row is a snapshot
 * from lock day; the recipe file is what the Recipes and Cook tabs show (and
 * what close-out recalibrates), so the Week and Next tabs must not disagree
 * with it. Reads only the recipe files those plans link; a meal whose file is
 * missing (a 🆕 not written yet) keeps its plan-row numbers and gets no
 * description. In-memory only: the plan files are never touched.
 */
export async function addRecipeMeta(...plans: (ParsedPlan | null | undefined)[]): Promise<void> {
  const seen = new Map<string, RecipeMeta | undefined>();
  const pos = (n: number | undefined) => (typeof n === 'number' && n > 0 ? n : undefined);
  for (const plan of plans) {
    for (const m of plan?.meals ?? []) {
      const f = m.recipeFile;
      if (!f || !SAFE_FILE.test(f)) continue;
      if (!seen.has(f)) {
        try { seen.set(f, parseRecipe(await fs.readFile(path.join(recipesDir, f), 'utf8'), f).meta); }
        catch { seen.set(f, undefined); /* 🆕 with no file yet, or unreadable */ }
      }
      const r = seen.get(f);
      if (!r) continue;
      if (r.description) m.description = r.description;
      m.timeMin = pos(r.active_time_min) ?? m.timeMin;
      m.cal = pos(r.nutrition?.calories) ?? m.cal;
      m.protein = pos(r.nutrition?.protein_g) ?? m.protein;
    }
  }
}
