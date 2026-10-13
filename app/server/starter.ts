// The starter library: the shareable template ships `starter-recipes/` (a
// household's library exported by scripts/starter-export.ts, stats stripped)
// so a new install can fill `recipes/` in one tap. A household's own repo has
// no such folder, so everything here reports `available: false` and the
// Recipes tab never shows the card.
//
// Importing copies the chosen files byte-for-byte into recipes/ (never
// overwriting one that is already there) and commits just those paths through
// commit.ts, the same narrow server-side write path as the Pantry sheet:
// refused (RunBusyError) while a run, chain or Ask Claude holds the run lock,
// serialized with the repo lock, MEALAPP_NO_GIT honored (files stay
// uncommitted). The planner never reads starter-recipes/; only this module does.
//
// Pictures ride along: starter-recipes/images/<slug>.<ext> (RECIPE_IMAGE, as in
// repo.ts) is copied to recipes/images/ with the recipe, unless recipes/images/
// already has a picture for that slug (left alone, not an error), and is
// committed and rolled back together with it.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { broadcast } from './bus.ts';
import { commitRepoFiles, withRepoLock, type CommitResult } from './commit.ts';
import { parseRecipe } from './parse.ts';
import { recipeImagesDir, recipesDir, starterDir } from './paths.ts';
import { RECIPE_IMAGE } from './repo.ts';
import { busyLabel, run, RunBusyError } from './runs.ts';

export const STARTER_FILE = /^[a-z0-9-]+\.md$/;

export interface StarterRecipe {
  file: string;
  name: string;
  protein?: string;
  cuisine?: string;
  method: string[];
  active_time_min?: number;
  total_time_min?: number;
  /** A file of the same name already exists in recipes/. */
  inLibrary: boolean;
  /** starter-recipes/images/ has a picture for it (copied along on import). */
  image: boolean;
}

export interface StarterList { available: boolean; recipes: StarterRecipe[] }

export class StarterError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException)?.code === 'ENOENT';

async function listMd(dir: string): Promise<string[] | null> {
  try {
    return (await fs.readdir(dir)).filter((f) => STARTER_FILE.test(f)).sort();
  } catch (err) {
    if (isMissing(err) || (err as NodeJS.ErrnoException)?.code === 'ENOTDIR') return null;
    throw err;
  }
}

const starterImagesDir = path.join(starterDir, 'images');

/** slug → image file name (first match per slug, sorted, as repo.ts recipeImages); missing folder → empty. */
async function imagesBySlug(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  let files: string[];
  try { files = (await fs.readdir(dir)).sort(); } catch { return out; }
  for (const f of files) {
    const slug = RECIPE_IMAGE.exec(f)?.[1];
    if (slug && !out.has(slug)) out.set(slug, f);
  }
  return out;
}

const slugOf = (file: string) => file.replace(/\.md$/, '');

/** `method: [a, b]` (inline YAML array) or a bare scalar, from the frontmatter. */
function methodOf(raw: string): string[] {
  if (!raw.startsWith('---')) return [];
  const end = raw.indexOf('\n---', 3);
  const m = (end === -1 ? '' : raw.slice(4, end)).match(/^method:\s*(.+)$/m);
  if (!m) return [];
  const v = m[1]!.trim();
  const inner = v.startsWith('[') && v.endsWith(']') ? v.slice(1, -1) : v;
  return inner.split(',').map((s) => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
}

/** The starter folder's recipes (README excluded), each marked whether recipes/ already has it. */
export async function listStarter(): Promise<StarterList> {
  const files = await listMd(starterDir);
  if (files === null) return { available: false, recipes: [] };
  const have = new Set((await listMd(recipesDir)) ?? []);
  const images = await imagesBySlug(starterImagesDir);
  const recipes: StarterRecipe[] = [];
  for (const file of files) {
    let raw: string;
    try { raw = await fs.readFile(path.join(starterDir, file), 'utf8'); } catch { continue; }
    const { meta } = parseRecipe(raw, file);
    recipes.push({
      file,
      name: meta.name,
      ...(meta.protein ? { protein: meta.protein } : {}),
      ...(meta.cuisine ? { cuisine: meta.cuisine } : {}),
      method: methodOf(raw),
      ...(meta.active_time_min !== undefined ? { active_time_min: meta.active_time_min } : {}),
      ...(meta.total_time_min !== undefined ? { total_time_min: meta.total_time_min } : {}),
      inLibrary: have.has(file),
      image: images.has(slugOf(file)),
    });
  }
  return { available: true, recipes };
}

/** Cheap counts for the Get started card (directory listings only, no parsing). */
export async function starterCounts(): Promise<{ available: boolean; remaining: number }> {
  const files = await listMd(starterDir).catch(() => null);
  if (files === null) return { available: false, remaining: 0 };
  const have = new Set((await listMd(recipesDir).catch(() => null)) ?? []);
  return { available: true, remaining: files.filter((f) => !have.has(f)).length };
}

export interface StarterImportResult {
  imported: string[];
  skipped: string[];
  /** recipes/images/ files copied along with the imported recipes. */
  images: string[];
  git: CommitResult | null;
}

/**
 * Copy the named starter recipes into recipes/ and commit them. Unknown or
 * malformed names → StarterError 400; files already in recipes/ are skipped
 * (reported, never overwritten). Throws RunBusyError while the run lock is held.
 * The push runs in the background by default (the route answers right after
 * the commit); the CLI passes background: false to wait for it.
 */
export async function importStarter(files: string[], by?: string, opts: { background?: boolean } = {}): Promise<StarterImportResult> {
  if (!Array.isArray(files) || !files.length) throw new StarterError(400, 'Pick at least one recipe.');
  const names = [...new Set(files.map(String))];
  const bad = names.filter((f) => !STARTER_FILE.test(f));
  if (bad.length) throw new StarterError(400, `Not a starter recipe file name: ${bad.slice(0, 3).join(', ')}`);
  const available = await listMd(starterDir);
  if (available === null) throw new StarterError(404, 'There is no starter-recipes folder in this repo.');
  const missing = names.filter((f) => !available.includes(f));
  if (missing.length) throw new StarterError(400, `Not in the starter library: ${missing.slice(0, 3).join(', ')}`);
  if (run) throw new RunBusyError(busyLabel(run));

  const out = await withRepoLock(async () => {
    if (run) throw new RunBusyError(busyLabel(run));
    const imported: string[] = [];
    const skipped: string[] = [];
    const images: string[] = []; // image file names copied into recipes/images/
    const starterImages = await imagesBySlug(starterImagesDir);
    const haveImages = await imagesBySlug(recipeImagesDir);
    const rollback = () => Promise.all([
      ...imported.map((g) => fs.unlink(path.join(recipesDir, g)).catch(() => {})),
      ...images.map((g) => fs.unlink(path.join(recipeImagesDir, g)).catch(() => {})),
    ]);
    await fs.mkdir(recipesDir, { recursive: true });
    for (const f of names) {
      try {
        // COPYFILE_EXCL: never overwrite a recipe that is already in the library
        await fs.copyFile(path.join(starterDir, f), path.join(recipesDir, f), fs.constants.COPYFILE_EXCL);
        imported.push(f);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') { skipped.push(f); continue; }
        await rollback();
        throw err;
      }
      // its picture, unless recipes/images/ already has one for this slug (left alone)
      const slug = slugOf(f);
      const img = starterImages.get(slug);
      if (!img || haveImages.has(slug)) continue;
      try {
        await fs.mkdir(recipeImagesDir, { recursive: true });
        await fs.copyFile(path.join(starterImagesDir, img), path.join(recipeImagesDir, img), fs.constants.COPYFILE_EXCL);
        images.push(img);
      } catch (err) {
        if ((err as NodeJS.ErrnoException)?.code === 'EEXIST') continue;
        await rollback();
        throw err;
      }
    }
    if (!imported.length) return { imported, skipped, images, git: null };
    const n = imported.length;
    let git: CommitResult;
    try {
      git = await commitRepoFiles(
        [...imported.map((f) => `recipes/${f}`), ...images.map((g) => `recipes/images/${g}`)],
        `Recipes: import ${n} starter recipe${n === 1 ? '' : 's'}`,
        { by, background: opts.background ?? true, lockHeld: true });
    } catch (err) {
      // a failed commit (or a run that started meanwhile) takes the copies back out
      await rollback();
      throw err;
    }
    return { imported, skipped, images, git };
  });
  if (out.imported.length) broadcast({ type: 'state-updated' }); // Recipes tab + Get started card refetch
  return out;
}
