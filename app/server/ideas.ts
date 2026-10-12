// Recipe ideas (F-10). An `ideas` run (app/prompts/ideas.md, plan model)
// writes profile/ideas.md: batches of eight dishes NOT in the library, newest
// batch first. The Recipes tab lists them with Queue / Not for me. The file is
// the run's (repo, git-synced); the per-idea decisions are app state in
// <dataDir>/ideas-state.json (gitignored, like captures), keyed by slug. An
// imported recipe queued from its result card ("Queue for next week") lives in
// the same map under its recipe slug (recipes/<slug>.md).
//
// Two prompt blocks come from here (filled by runs.ts buildPrompt):
//   {{IDEAS_STATE}}   ideas run: queued, dismissed, already-suggested and
//                     already-filed names, so the new batch repeats none of them
//   {{QUEUED_IDEAS}}  propose run: queued ideas not yet in a plan
// A queued idea counts as scheduled (and drops out of {{QUEUED_IDEAS}}) once a
// plan for the week it was queued in or later carries it: an imported recipe
// by its recipe file, an idea by name (every word of the idea's name appears
// in the plan's dish name; the prompt asks the planner to keep the name).
//
// profile/ideas.md format (the contract app/prompts/ideas.md writes to):
//
//   # Ideas
//
//   Suggestions from the app's ideas run, newest batch first. …(optional line)
//
//   ## Batch 2026-10-11
//   - **Kerala Fish Curry** · white fish · Indian · ~35 min active — one-line pitch. Why you: one sentence tied to ratings/notes.
//   - …eight items per batch
//
//   ## Batch 2026-09-27
//   - …
//
// One item per line. The idea's id is slugify(dish name). Anything else in the
// file (intro prose, other headings) is ignored by the parser.
import { promises as fs } from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
import { dataDir, recipesDir, repoRoot } from './paths.ts';
import { readAllPlans, readRecipes } from './repo.ts';
import { weekIdForDate } from './weeks.ts';

export const ideasFile = path.join(repoRoot, 'profile', 'ideas.md');
const stateFile = path.join(dataDir, 'ideas-state.json');

export interface Idea {
  id: string;
  name: string;
  protein: string;
  cuisine: string;
  activeMin: number | null;
  pitch: string;
  why: string;
}
export interface IdeaBatch { date: string; items: Idea[] }

export type IdeaStatus = 'queued' | 'dismissed';
export interface IdeaState {
  status: IdeaStatus;
  at: number;
  by?: string;
  note?: string;
  /** Display name at decision time, so a queued item still reads right if ideas.md changes. */
  name?: string;
}

// ---------- parsing ----------

/** URL/file-safe id from a dish name: "Kerala Fish Curry" → "kerala-fish-curry". */
export function slugify(s: string): string {
  return s.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/&/g, ' and ').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80).replace(/-+$/, '');
}
export const IDEA_ID = /^[a-z0-9][a-z0-9-]{0,79}$/;

const BATCH_HEAD = /^##\s+Batch\s+(\d{4}-\d{2}-\d{2})\b/i;
const ITEM = /^\s*[-*]\s+\*\*(.+?)\*\*\s*(.*)$/;

/** One `- **Name** · protein · cuisine · ~N min active — pitch. Why you: …` line, leniently. */
function parseItem(line: string): Idea | null {
  const m = ITEM.exec(line);
  if (!m) return null;
  const name = m[1]!.trim();
  const id = slugify(name);
  if (!id) return null;
  let rest = m[2]!.trim();
  let why = '';
  const whyAt = rest.search(/\bWhy you:/i);
  if (whyAt >= 0) {
    why = rest.slice(whyAt).replace(/^Why you:\s*/i, '').trim();
    rest = rest.slice(0, whyAt).trim();
  }
  // the first spaced em/en dash (or spaced hyphen) separates the meta from the pitch
  let meta = rest;
  let pitch = '';
  const dash = rest.search(/\s[—–-]\s/);
  if (dash >= 0) {
    meta = rest.slice(0, dash);
    pitch = rest.slice(dash).replace(/^\s*[—–-]\s*/, '').trim();
  }
  let protein = '';
  let cuisine = '';
  let activeMin: number | null = null;
  for (const part of meta.split('·').map((s) => s.trim()).filter(Boolean)) {
    const t = /^~?\s*(\d+)\s*(?:min|minutes)\b/i.exec(part);
    if (t) { activeMin = Number(t[1]); continue; }
    if (!protein) protein = part;
    else if (!cuisine) cuisine = part;
  }
  return { id, name, protein, cuisine, activeMin, pitch, why };
}

/** profile/ideas.md → batches, newest first; items keep file order. Empty batches are dropped. */
export function parseIdeas(raw: string): IdeaBatch[] {
  const batches: IdeaBatch[] = [];
  let cur: IdeaBatch | null = null;
  for (const line of raw.split(/\r?\n/)) {
    const h = BATCH_HEAD.exec(line);
    if (h) { cur = { date: h[1]!, items: [] }; batches.push(cur); continue; }
    if (/^#{1,2}\s/.test(line)) { cur = null; continue; } // any other heading ends the batch
    if (!cur) continue;
    const it = parseItem(line);
    if (it && !cur.items.some((x) => x.id === it.id)) cur.items.push(it);
  }
  return batches.filter((b) => b.items.length).sort((a, b) => b.date.localeCompare(a.date));
}

export async function readIdeas(): Promise<{ exists: boolean; batches: IdeaBatch[] }> {
  try { return { exists: true, batches: parseIdeas(await fs.readFile(ideasFile, 'utf8')) }; }
  catch { return { exists: false, batches: [] }; }
}

// ---------- state (ideas-state.json) ----------

let stateLoad: Promise<Record<string, IdeaState>> | null = null;
export function loadIdeasState(): Promise<Record<string, IdeaState>> {
  stateLoad ??= (async () => {
    try {
      const j = JSON.parse(await fs.readFile(stateFile, 'utf8')) as unknown;
      return j && typeof j === 'object' && !Array.isArray(j) ? (j as Record<string, IdeaState>) : {};
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[ideas] ideas-state.json unreadable, starting empty:', String(e));
      return {};
    }
  })();
  return stateLoad;
}

// Chained atomic writes (temp + rename) so overlapping saves land in order.
let saveChain: Promise<void> = Promise.resolve();
function saveIdeasState(s: Record<string, IdeaState>): Promise<void> {
  const next = saveChain.then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${stateFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(s, null, 2) + '\n');
      await fs.rename(tmp, stateFile);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  });
  saveChain = next.catch(() => {});
  return next;
}

/** Set (or with null, clear) one idea's decision. Returns the new entry (null when cleared). */
export async function setIdeaState(id: string, next: Omit<IdeaState, 'at'> | null): Promise<IdeaState | null> {
  const s = await loadIdeasState();
  if (!next) { delete s[id]; await saveIdeasState(s); return null; }
  const entry: IdeaState = { ...next, at: Date.now() };
  s[id] = entry;
  await saveIdeasState(s);
  return entry;
}

// ---------- what an id refers to ----------

export interface IdeaTarget { kind: 'idea'; idea: Idea; batch: string }
export interface RecipeTarget { kind: 'recipe'; file: string; name: string }

/** An id is an idea in profile/ideas.md, or the slug of a recipe file (imported recipes). */
export async function resolveIdeaId(id: string): Promise<IdeaTarget | RecipeTarget | null> {
  if (!IDEA_ID.test(id)) return null;
  const { batches } = await readIdeas();
  for (const b of batches) {
    const idea = b.items.find((i) => i.id === id);
    if (idea) return { kind: 'idea', idea, batch: b.date };
  }
  const file = `${id}.md`;
  try {
    await fs.access(path.join(recipesDir, file));
    const meta = (await readRecipes()).find((r) => r.file === file);
    return { kind: 'recipe', file, name: meta?.name ?? id };
  } catch { return null; }
}

// ---------- scheduled? ----------

const STOP = new Set(['with', 'and', 'the', 'a', 'an', 'of', 'in', 'on', 'style', 'over']);
const words = (s: string) => slugify(s.replace(/🆕|⭐\d(?:\.\d)?/g, '')).split('-').filter((w) => w && !STOP.has(w));

const localWeek = (at: number) => {
  const d = new Date(at);
  return weekIdForDate(new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate())));
};

/**
 * Queued ids already carried by a plan for the week they were queued in or
 * later → that plan's week. A queued imported recipe matches by recipe file;
 * an idea matches when every word of its name is in a dish name.
 */
export async function scheduledQueued(state: Record<string, IdeaState>): Promise<Record<string, string>> {
  const queued = Object.entries(state).filter(([, s]) => s.status === 'queued');
  if (!queued.length) return {};
  const plans = [...(await readAllPlans()).values()].sort((a, b) => a.week.localeCompare(b.week));
  const out: Record<string, string> = {};
  for (const [id, s] of queued) {
    const from = localWeek(s.at);
    const want = words(s.name ?? id.replace(/-/g, ' '));
    for (const p of plans) {
      if (p.week < from) continue;
      const hit = p.meals.some((m) => {
        if (m.flexible) return false;
        if (m.recipeFile === `${id}.md`) return true;
        if (!want.length) return false;
        const have = new Set(words(m.dish));
        return want.every((w) => have.has(w));
      });
      if (hit) { out[id] = p.week; break; }
    }
  }
  return out;
}

// ---------- prompt blocks ----------

const fmtLocalDate = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

function ideaLine(i: Idea): string {
  const meta = [i.protein, i.cuisine, i.activeMin ? `~${i.activeMin} min active` : ''].filter(Boolean).join(' · ');
  return `**${i.name}**${meta ? ` · ${meta}` : ''}${i.pitch ? ` — ${i.pitch}` : ''}`;
}

/** {{QUEUED_IDEAS}} for propose: queued and not yet in a plan, or "none". */
export async function queuedIdeasBlock(): Promise<string> {
  const state = await loadIdeasState();
  const sched = await scheduledQueued(state);
  const { batches } = await readIdeas();
  const byId = new Map<string, Idea>();
  for (const b of [...batches].reverse()) for (const i of b.items) byId.set(i.id, i); // newest wins
  const recipes = await readRecipes();
  const lines: string[] = [];
  const queued = Object.entries(state)
    .filter(([id, s]) => s.status === 'queued' && !sched[id])
    .sort((a, b) => a[1].at - b[1].at);
  for (const [id, s] of queued) {
    const when = `queued ${fmtLocalDate(s.at)}${s.by ? ` by ${s.by}` : ''}${s.note ? `, note: "${s.note}"` : ''}`;
    const rec = recipes.find((r) => r.file === `${id}.md`);
    if (rec) {
      lines.push(`- [${rec.name}](../recipes/${rec.file}): already filed (user-imported, times_cooked ${rec.times_cooked ?? 0}). Link this existing file as a 🆕 and do not recreate it at lock (${when}).`);
      continue;
    }
    const idea = byId.get(id);
    if (idea) lines.push(`- ${ideaLine(idea)} (${when})`);
    else if (s.name) lines.push(`- **${s.name}** (${when})`);
  }
  if (!lines.length) return 'none';
  return 'User queued these ideas; schedule them when they fit the week\'s rules, as 🆕 dishes '
    + '(keep each idea\'s name in the dish name, adding a side if you like, so the app can tell it was scheduled; '
    + 'one that does not fit this week stays queued for a later one, so say so in the Planning notes):\n'
    + lines.join('\n');
}

/** {{IDEAS_STATE}} for the ideas run: everything the new batch must not repeat. */
export async function ideasStateBlock(): Promise<string> {
  const state = await loadIdeasState();
  const sched = await scheduledQueued(state);
  const { batches } = await readIdeas();
  const nameOf = new Map<string, string>();
  for (const b of batches) for (const i of b.items) if (!nameOf.has(i.id)) nameOf.set(i.id, i.name);
  const label = (id: string, s: IdeaState) => nameOf.get(id) ?? s.name ?? id.replace(/-/g, ' ');

  const entries = Object.entries(state);
  const queued = entries.filter(([, s]) => s.status === 'queued')
    .map(([id, s]) => `- ${label(id, s)}${sched[id] ? ` (scheduled in ${sched[id]})` : ' (waiting for a plan)'}`);
  const dismissed = entries.filter(([, s]) => s.status === 'dismissed')
    .map(([id, s]) => `- ${label(id, s)}${s.note ? `: "${s.note}"` : ''}`);
  const undecided: string[] = [];
  for (const b of batches) {
    for (const i of b.items) if (!state[i.id]) undecided.push(`- ${i.name} (batch ${b.date})`);
  }
  const library = (await readRecipes()).map((r) => r.name).sort((a, b) => a.localeCompare(b));

  const sec = (title: string, xs: string[]) => `${title}\n${xs.length ? xs.join('\n') : '- none'}`;
  return [
    sec('Queued by the household (they already want these; do not suggest them again):', queued),
    sec('Dismissed with "Not for me" (never suggest these or close variants; a quoted reason is a preference signal):', dismissed),
    sec('Suggested in earlier batches with no decision yet (do not repeat these):', undecided),
    sec(`Already in the recipe library (${library.length} files; never suggest these or near-duplicates):`, library.map((n) => `- ${n}`)),
  ].join('\n\n');
}
