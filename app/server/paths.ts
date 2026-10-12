// Filesystem anchors shared by every server module. The server lives in
// app/server/, the repo root is two levels up, and app/data/ holds the
// gitignored local state.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
export const appDir = path.resolve(here, '..');
export const repoRoot = path.resolve(appDir, '..');
export const plansDir = path.join(repoRoot, 'plans');
export const recipesDir = path.join(repoRoot, 'recipes');
// The shareable template's starter library (absent in a household's own repo).
export const starterDir = path.join(repoRoot, 'starter-recipes');
export const promptsDir = path.join(appDir, 'prompts');
// MEALAPP_DATA_DIR overrides the state folder (dev instances on other ports
// get their own captures/checks/push state instead of sharing app/data).
export const dataDir = process.env.MEALAPP_DATA_DIR
  ? path.resolve(process.env.MEALAPP_DATA_DIR)
  : path.join(appDir, 'data');
