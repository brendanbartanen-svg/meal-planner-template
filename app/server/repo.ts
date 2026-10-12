// Readers for the repo's plans/ and recipes/ directories (parsed via parse.ts).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parsePlan, parseRecipe, type ParsedPlan, type RecipeMeta } from './parse.ts';
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
