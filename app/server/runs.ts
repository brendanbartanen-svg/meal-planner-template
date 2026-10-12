// The Claude bridge: one run at a time, tool-gated to writes-inside-repo +
// plain git, with in-memory run state + event log broadcast over WS, plus the
// auto-fold timer that turns quiet captures into a fold run. Runs can be
// chained (startChain: close-and-plan, send-and-lock) under the same one-run
// lock, and MEALAPP_MOCK_RUNS=1 swaps the SDK call for canned output (dev).
import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { broadcast } from './bus.ts';
import { ideasStateBlock, queuedIdeasBlock } from './ideas.ts';
import { DEFAULT_SERVINGS, ingredientListLines, parseRecipe, SAFE_FILE, type PlanMeal } from './parse.ts';
import { promptsDir, recipesDir, repoRoot } from './paths.ts';
import { readAllPlans } from './repo.ts';
import { factorFor, formatQty, scaleIngredients } from './scale.ts';
import {
  autoFoldOn, captures, extras, feedback, foldDebounceMs, modelFor, pendingCaptures,
  recordDuration, saveCaptures, saveExtras, saveFeedback, typicalMs, type RunType,
} from './store.ts';
import { trendsForPrompt } from './trends-routes.ts';
import { addWeeks, fmtISO, humanRange, todayUTC, weekDates, weekDays, weekIdForDate, type DayName } from './weeks.ts';

// ---------- claude bridge ----------

export type RunEvent =
  | { kind: 'status'; text: string }
  | { kind: 'activity'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; ok: boolean; summaryHtml: string; durationMs: number };

/** One step of a chain (a single run is a one-step chain). */
export interface ChainStep {
  type: RunType;
  week: string;
  note?: string;
  /** revise only: fill {{AUTO_APPROVE}} so replacements come back `approved` for the lock that follows. */
  autoApprove?: boolean;
  /** rescale only: the meal (day) and its new servings — fills rescale.md's placeholders. */
  rescale?: { day: DayName; servings: number };
  /** Checked right before this step starts; a string stops the chain there (the step never runs). */
  guard?: () => Promise<string | null>;
}

interface RunChain { step: number; of: number; types: RunType[]; weeks: string[]; startedAt: number }

export interface Run {
  type: RunType;           // the step running now — a chain advances type/week/startedAt
  week: string;
  startedAt: number;       // this step's start (the chain's start is chain.startedAt)
  events: RunEvent[];      // every step's events, in order
  abort: AbortController;  // one per chain: Stop ends the whole chain
  chain: RunChain | null;  // null for a single run
}

export interface StepResult { type: RunType; week: string; summaryHtml: string }
export interface LastResult {
  type: RunType;
  week: string;
  ok: boolean;
  summaryHtml: string;
  at: number;
  // Chains only. Success: every step's summary in order, and the fields above
  // are the final step's, so single-run result cards keep working. Failure:
  // the fields above are the failed step's, results = the steps that finished.
  chain?: true;
  results?: StepResult[];
}

export let run: Run | null = null;
export let lastResult: LastResult | null = null;

// ---------- run-complete hook ----------
// Called after every run — each step of a chain separately, with `chain` set —
// including mock runs and chain steps a guard stopped before they started
// (ok: false). For the run-complete notifications; a throwing listener is
// logged and never affects the run.
export interface RunDoneInfo {
  type: RunType;
  week: string;
  ok: boolean;
  summaryMd: string;
  chain?: { step: number; of: number; types: RunType[] };
}
type RunDoneListener = (info: RunDoneInfo) => void | Promise<void>;
const runDoneListeners: RunDoneListener[] = [];
/** Subscribe to run completions; returns an unsubscribe function. */
export function onRunDone(cb: RunDoneListener): () => void {
  runDoneListeners.push(cb);
  return () => {
    const i = runDoneListeners.indexOf(cb);
    if (i >= 0) runDoneListeners.splice(i, 1);
  };
}
function emitRunDone(info: RunDoneInfo) {
  for (const cb of [...runDoneListeners]) {
    try {
      void Promise.resolve(cb(info)).catch((err) => console.log(`[mealapp] onRunDone listener failed: ${String(err)}`));
    } catch (err) {
      console.log(`[mealapp] onRunDone listener failed: ${String(err)}`);
    }
  }
}

// ---------- mock runs (dev) ----------
// MEALAPP_MOCK_RUNS=1 swaps the SDK call inside each step for ~4 s of canned
// activity events and a canned summary per run type: no Claude, no file
// writes, no git. Everything around that call is the real code path — the
// one-run lock, events, lastResult, duration stats, fold stamping,
// feedback/extras clearing, chains, guards, onRunDone — so the browser sees
// real behavior without spending runs. The prompt is still built (and
// logged to stdout) so template filling is exercised too. Because mock steps
// write nothing, a chain guard that fails in mock mode is reported as an
// activity note and the chain continues. Dev knobs: MEALAPP_MOCK_MS (per-step
// duration, default 4000) and MEALAPP_MOCK_FAIL=<type>[,<type>] (those run
// types fail, to exercise the failure path).
// MEALAPP_NO_GIT=1 (dev instances doing REAL runs against a worktree): git
// commands are denied with "git is disabled on this dev instance" (other Bash
// gets the usual plain-git-only denial), the git allow-rules are dropped, and
// the system append tells the model not to commit or push, so a real run
// leaves its edits uncommitted for inspection.
export const NO_GIT = /^(1|true|on|yes)$/i.test(process.env.MEALAPP_NO_GIT ?? '');
export const MOCK_RUNS =/^(1|true|on|yes)$/i.test(process.env.MEALAPP_MOCK_RUNS ?? '');
const MOCK_MS = Math.max(400, Number(process.env.MEALAPP_MOCK_MS) || 4000);
const MOCK_FAIL = new Set((process.env.MEALAPP_MOCK_FAIL ?? '').split(',').map((s) => s.trim()).filter(Boolean));

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('aborted'));
    const onAbort = () => { clearTimeout(t); reject(new Error('aborted')); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}

function mockActivity(type: RunType, week: string): string[] {
  const prev = week ? addWeeks(week, -1) : '';
  switch (type) {
    case 'propose': return ['Reading: profile/preferences.md', 'Reading: profile/pantry.md', `Reading: plans/${prev}.md`, `Writing: plans/${week}.md`];
    case 'revise': return [`Reading: plans/${week}.md`, 'Reading: profile/preferences.md', `Editing: plans/${week}.md`, '$ git commit'];
    case 'lock': return [`Reading: plans/${week}.md`, 'Reading: profile/pantry.md', `Editing: plans/${week}.md`, '$ git push'];
    case 'fold': return ['Reading: plans/', 'Editing: Log tables', '$ git commit'];
    case 'shop-adjust': return [`Reading: plans/${week}.md`, `Editing: plans/${week}.md`, '$ git push'];
    case 'review': return [`Reading: plans/${week}.md`, 'Editing: recipes/ frontmatter', 'Editing: profile/preferences.md', '$ git push'];
    case 'rescale': return [`Reading: plans/${week}.md`, `Editing: plans/${week}.md`, '$ git push'];
    case 'ask': return []; // never a chain step; ask.ts has its own mock
    case 'ideas': return ['Reading: profile/preferences.md', 'Scanning files', 'Reading: profile/ideas.md', 'Editing: profile/ideas.md'];
    case 'import': return ['Reading: recipes/red-lentil-soup.md', 'Writing: recipes/(new).md', 'Editing: profile/preferences.md'];
  }
}

// Read BEFORE the success bookkeeping clears feedback / stamps captures, so a
// mock summary can echo what the run received (handy for checking the UI).
function mockSummary(type: RunType, week: string, note: string, autoApprove: boolean, rescale?: ChainStep['rescale']): string {
  const head = '_Mock run (MEALAPP_MOCK_RUNS): nothing was written or committed._';
  const n = note.trim().replace(/\n+/g, ' · ');
  switch (type) {
    case 'propose':
      return `${head}\n\n- Proposed ${week}: three cook nights, one new dish and two proven favorites.\n- Constraints received: ${n || 'none'}`;
    case 'revise': {
      const fb = feedback[week];
      const decs = fb ? Object.entries(fb.meals).map(([d, m]) => `${d} ${m?.decision ?? '?'}`).join(', ') : '';
      return `${head}\n\n- Revised ${week}: ${decs || 'no per-meal decisions'}${fb?.weekNote ? '; week note applied' : ''}.\n`
        + `- Replacements come back ${autoApprove ? '**approved** (send-and-lock)' : 'proposed'}.${n ? `\n- Note: ${n}` : ''}`;
    }
    case 'lock':
      return `${head}\n\n- Locked ${week} and built its grocery list (13 items across two stores). First prep task due on day 1.`;
    case 'fold':
      return `${head}\n\n- Would fold ${pendingCaptures().length} pending capture(s) into the Log tables.`;
    case 'shop-adjust':
      return `${head}\n\n- Would adjust the ${week} list: ${n || '(no note)'}`;
    case 'review':
      return `${head}\n\n- Closed out ${week}: recipe stats, the week review and learned preferences would be written.`;
    case 'rescale':
      return `${head}\n\n- Would rescale ${rescale ? `${rescale.day} to ${rescale.servings} servings` : '(no meal given)'} in ${week}: its Servings cell, grocery lines and bulk notes.`;
    case 'ask': return head; // never a chain step; ask.ts has its own mock
    case 'ideas': return `${head}\n\n- Would add a batch of 8 new dishes to the top of profile/ideas.md.`;
    case 'import': { // `note` carries the {{IMPORT_SOURCE}} block; its "Title:" line names the dish
      const t = /^Title: (.+)$/m.exec(note)?.[1]?.trim() || 'Imported recipe';
      const slug = t.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'imported-recipe';
      return `${head}\n\n- Would write recipes/${slug}.md (house format, 4 servings) from: ${t}.`;
    }
  }
}

const clip = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const rel = (p: string) => path.relative(repoRoot, path.resolve(repoRoot, p)) || '.';

export function activityLabel(tool: string, input: Record<string, unknown>): string | null {
  switch (tool) {
    case 'WebSearch': return `Searching: ${clip(String(input.query ?? ''))}`;
    case 'WebFetch': return `Fetching: ${clip(String(input.url ?? ''))}`;
    case 'Read': return `Reading: ${rel(String(input.file_path ?? ''))}`;
    case 'Write': return `Writing: ${rel(String(input.file_path ?? ''))}`;
    case 'Edit': return `Editing: ${rel(String(input.file_path ?? ''))}`;
    case 'Glob': case 'Grep': return 'Scanning files';
    case 'Bash': return `$ ${clip(String(input.command ?? ''))}`;
    case 'Skill': return `Skill: ${String(input.skill ?? '')}`;
    case 'Task': return `Subagent: ${clip(String(input.description ?? ''))}`;
    case 'TodoWrite': return null;
    default: return tool;
  }
}

const GIT_VERBS = ['status', 'diff', 'log', 'show', 'add', 'commit', 'push', 'pull', 'fetch', 'branch', 'ls-files', 'rev-parse', 'remote'] as const;
const GIT_OK = new RegExp(`^\\s*git\\s+(${GIT_VERBS.join('|')})\\b`);
const SHELL_META = /[;&|<>`]|\$\(/;
const GIT_ANY = /(?:^|[\s;&|(`])git(?:\s|$)/; // `git` as a command word anywhere (`cd x && git push` too)

// Everything a run is allowed to do, as permission RULES the CLI enforces
// in-process. canUseTool below covers the same ground, but it rides the SDK's
// bidirectional control channel, which some CLI builds close mid-session —
// every Bash call then dies with a permission-prompt "Stream closed" error
// while acceptEdits keeps edits working (seen 2026-08: fold runs edited files
// but couldn't commit). Rules don't need the channel, so git keeps working
// even on an affected build; canUseTool stays as the deny-by-default backstop.
export const RUN_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'WebSearch', 'WebFetch',
  'Skill', 'TodoWrite', 'Task',
  ...(NO_GIT ? [] : GIT_VERBS.flatMap((v) => [`Bash(git ${v})`, `Bash(git ${v}:*)`])),
];

/** `noGit` overrides MEALAPP_NO_GIT (selftest). */
export function canUseTool(noGit = NO_GIT) {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    const deny = (message: string): PermissionResult => ({ behavior: 'deny', message });
    switch (toolName) {
      case 'Read': case 'Grep': case 'Glob':
      case 'WebSearch': case 'WebFetch':
      case 'Skill': case 'TodoWrite': case 'Task':
        return allow;
      case 'Edit': case 'Write': case 'MultiEdit': case 'NotebookEdit': {
        const p = String(input.file_path ?? input.notebook_path ?? '');
        const resolved = path.resolve(repoRoot, p);
        if (resolved === repoRoot || resolved.startsWith(repoRoot + path.sep)) return allow;
        return deny(`This app only permits writes inside the meal-planner repo (${repoRoot}).`);
      }
      case 'Bash': {
        const cmd = String(input.command ?? '');
        // Only a command that invokes git hears that git is off; anything else
        // gets the normal denial, so a dev run isn't told a lie about why.
        if (noGit && GIT_ANY.test(cmd)) return deny('git is disabled on this dev instance');
        if (!noGit && GIT_OK.test(cmd) && !SHELL_META.test(cmd)) return allow;
        return deny('This app only permits plain git commands (status/diff/log/add/commit/push/pull), no shell operators.');
      }
      default:
        return deny(`Tool ${toolName} is not enabled in the Meal Planner app.`);
    }
  };
}

const SYSTEM_APPEND = `

You are running inside the Meal Planner app (a local web UI). The user sees only a progress indicator and your final message — intermediate output is not displayed, and no interaction is possible mid-run. Never ask questions; when something is ambiguous, make the best call by the rules in CLAUDE.md and note it in the file you write.
The app parses plan files mechanically: keep the exact structures from plans/TEMPLATE.md and the existing week files (table columns, '- [ ] ' checkbox lines, '### Store' / '**Section**' grocery headings, '**Status:**' line).
Commit and push any repo changes (pull --rebase and retry once if the push is rejected).
Your FINAL message must be a short markdown summary for the app to display — a few sentences or bullets, no preamble, no code fences around the whole message.${NO_GIT
  ? '\nGit is disabled on this dev instance: do not run git, commit, or push, whatever CLAUDE.md or the task says; leave your changes uncommitted.' : ''}`;

// Fold/review runs get told, per capture date, exactly which plan file the
// entry belongs in. The model must never derive that itself: "the ISO week
// containing the date" is wrong for Saturdays and Sundays under the Saturday
// scheme, and a fold that guesses writes a log row into the wrong week.
async function foldRoutingBlock(): Promise<string> {
  const pend = pendingCaptures();
  if (!pend.length) return '(no pending captures)';
  const plans = await readAllPlans();
  return pend
    .map((c) => c.date)
    .sort()
    .map((date) => {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `${date} → (unparseable date — leave this capture pending)`;
      const id = weekIdForDate(new Date(date + 'T00:00:00Z'));
      const file = `plans/${id}.md`;
      return plans.has(id)
        ? `${date} → ${file} (exists)`
        : `${date} → ${file} (missing — leave this capture pending)`;
    })
    .join('\n');
}

// The {{AUTO_APPROVE}} block of revise.md, filled only for send-and-lock
// (revise → lock with no look in between). Without it the lock step's guard
// would stop the chain on every replacement meal, which comes back `proposed`.
export const AUTO_APPROVE_TEXT = 'The user asked to lock the week right after this revision without another look. '
  + 'Set the Status of every replacement meal you propose to `approved` as well (not `proposed`), so the lock that follows can proceed. '
  + 'Prefer proven ⭐4–5 recipes for replacements in this mode.';

/**
 * Cook-night chips → a structured first line of the propose {{NOTE}}, in the
 * week's own day order, e.g. "Cook nights: Sat, Tue, Thu (3 nights). No
 * cooking: Sun, Mon, Wed, Fri." Spelled out both ways so a day can't be
 * mis-slotted. No nights picked = no line (the planner decides).
 */
export function withCookNights(week: string, nights: readonly DayName[], note: string): string {
  const order = weekDays(week);
  const on = order.filter((d) => nights.includes(d));
  const rest = note.trim();
  if (!on.length) return rest;
  const off = order.filter((d) => !nights.includes(d));
  const line = `Cook nights: ${on.join(', ')} (${on.length} night${on.length === 1 ? '' : 's'}). No cooking: ${off.length ? off.join(', ') : 'none'}.`;
  return rest ? `${line}\n${rest}` : line;
}

// ---------- scaled ingredients (lock + rescale prompts) ----------
// The grocery list is aggregated from these lines instead of being re-derived
// by the model: each meal's recipe Ingredients, scaled deterministically
// (scale.ts) to the servings the meal is planned at.

/** Servings a meal of `week` is planned at: the Next-tab override, else the Plan table's cell, else 4. */
export function effectiveServings(week: string, m: PlanMeal): number {
  return feedback[week]?.meals[m.day]?.servings ?? m.servings ?? DEFAULT_SERVINGS;
}

/** One meal: `### Sat — <dish> — 8 servings (×2)` + its scaled ingredient lines. */
async function scaledMealBlock(m: PlanMeal, servings: number): Promise<string> {
  const head = `### ${m.day} — ${m.dish} — ${servings} servings`;
  const file = m.recipeFile && SAFE_FILE.test(m.recipeFile) ? m.recipeFile : null;
  let raw: string | null = null;
  if (file) { try { raw = await fs.readFile(path.join(recipesDir, file), 'utf8'); } catch { raw = null; } }
  if (raw === null) {
    const f = formatQty(factorFor(DEFAULT_SERVINGS, servings));
    return `${head} (×${f} of the recipe you write at ${DEFAULT_SERVINGS})\n`
      + `${file ? `recipes/${file} is linked but does not exist yet. ` : ''}No recipe file yet: write it at ${DEFAULT_SERVINGS} servings, then shop its ingredients ×${f}.`;
  }
  const { meta, body } = parseRecipe(raw, file!);
  const factor = factorFor(meta.servings, servings);
  const scaled = scaleIngredients(body, factor);
  const lines = ingredientListLines(scaled.body);
  let out = `${head} (×${formatQty(factor)})\n(recipes/${file}, written for ${meta.servings ?? DEFAULT_SERVINGS})\n`
    + (lines.length ? lines.join('\n') : '(no `## Ingredients` list found: read the recipe file)');
  if (factor !== 1 && scaled.flagged.length) {
    const left = scaled.flagged.flatMap((x) => x.notes.map((n) => n.replace(/^left as written:\s*/, '')));
    out += `\nLeft as written by the scaler (scale ×${formatQty(factor)} yourself where it matters for shopping): ${[...new Set(left)].join(' · ')}`;
  }
  return out;
}

/** {{SCALED_INGREDIENTS}}: every non-flexible meal at its effective servings, or just `only.day` at `only.servings`. */
async function scaledIngredientsBlock(week: string, only?: { day: DayName; servings: number }): Promise<string> {
  const plan = (await readAllPlans()).get(week);
  if (!plan) return `(plans/${week}.md not found)`;
  const meals = plan.meals.filter((m) => !m.flexible && (!only || m.day === only.day));
  if (!meals.length) return only ? `(no cook night on ${only.day} in plans/${week}.md)` : '(no cook nights in the plan)';
  const blocks: string[] = [];
  for (const m of meals) blocks.push(await scaledMealBlock(m, only ? only.servings : effectiveServings(week, m)));
  return blocks.join('\n\n');
}

export async function buildPrompt(
  type: RunType, week: string, note: string,
  opts: { autoApprove?: boolean; rescale?: ChainStep['rescale'] } = {},
): Promise<string> {
  const template = await fs.readFile(path.join(promptsDir, `${type}.md`), 'utf8');
  // rescale: the one meal, at the new servings (and at the old, which the list was built from)
  let rescaleMeal: PlanMeal | undefined;
  if (opts.rescale) rescaleMeal = (await readAllPlans()).get(week)?.meals.find((m) => m.day === opts.rescale!.day && !m.flexible);
  const oldServings = rescaleMeal?.servings ?? DEFAULT_SERVINGS;
  const scaledBlock = template.includes('{{SCALED_INGREDIENTS}}') ? await scaledIngredientsBlock(week, opts.rescale) : '';
  const oldScaledBlock = opts.rescale && template.includes('{{OLD_SCALED_INGREDIENTS}}')
    ? await scaledIngredientsBlock(week, { day: opts.rescale.day, servings: oldServings })
    : '';
  const dates = week ? weekDates(week) : null;
  const fb = feedback[week];
  const fbLines = fb
    ? JSON.stringify({
        perMeal: fb.meals,
        weekNote: fb.weekNote?.text,
      }, null, 2)
    : 'none';
  const pend = pendingCaptures();
  const capLines = pend.length
    ? JSON.stringify(pend.map(({ date, dish, rating, note: n, minutes, by }) => ({ date, dish, rating, note: n, minutes, by })), null, 2)
    : 'none';
  const extraLines = (extras[week] ?? []).map((e) => `- ${e.text}${e.by ? ` (added by ${e.by})` : ''}`).join('\n') || 'none';
  const routing = (type === 'fold' || type === 'review') ? await foldRoutingBlock() : '';
  return template
    .replaceAll('{{WEEK}}', week)
    // Day→date table follows the week's own order (Sat-first from 2026-W33,
    // five entries for the truncated 2026-W32).
    .replaceAll('{{DATES}}', week ? `${humanRange(week)} · ${weekDays(week).map((d) => `${d}=${dates![d]}`).join(' ')}` : '')
    .replaceAll('{{TODAY}}', fmtISO(todayUTC()))
    .replaceAll('{{NOTE}}', note.trim() || 'none')
    .replaceAll('{{FEEDBACK}}', fbLines)
    .replaceAll('{{CAPTURES}}', capLines)
    .replaceAll('{{EXTRAS}}', extraLines)
    // lock.md + rescale.md: pre-scaled ingredient lines per meal (rescale: that meal at old + new servings)
    .replaceAll('{{SCALED_INGREDIENTS}}', scaledBlock)
    .replaceAll('{{OLD_SCALED_INGREDIENTS}}', oldScaledBlock)
    .replaceAll('{{RESCALE_DAY}}', opts.rescale?.day ?? '')
    .replaceAll('{{RESCALE_DISH}}', rescaleMeal?.dish ?? '(no cook night on that day)')
    .replaceAll('{{OLD_SERVINGS}}', String(oldServings))
    .replaceAll('{{NEW_SERVINGS}}', String(opts.rescale?.servings ?? ''))
    .replaceAll('{{ROUTING}}', routing)
    // review.md: computed 6-week trends through the closing week (trends-routes.ts)
    .replaceAll('{{TRENDS}}', type === 'review' ? await trendsForPrompt(week) : '')
    // ideas.ts: queued/dismissed/filed names (ideas run), queued ideas (propose); import's source block rides in `note`
    .replaceAll('{{IDEAS_STATE}}', type === 'ideas' ? await ideasStateBlock() : '')
    .replaceAll('{{QUEUED_IDEAS}}', type === 'propose' ? await queuedIdeasBlock() : '')
    .replaceAll('{{IMPORT_SOURCE}}', type === 'import' ? note.trim() : '')
    // its own paragraph when on; '' leaves revise.md's surrounding blank line
    .replaceAll('{{AUTO_APPROVE}}', opts.autoApprove ? `\n${AUTO_APPROVE_TEXT}\n` : '');
}

/** Summed typical duration of a chain's steps; null until every type has history. */
function chainTypicalMs(types: RunType[]): number | null {
  let sum = 0;
  for (const t of types) {
    const ms = typicalMs(t);
    if (ms === null) return null;
    sum += ms;
  }
  return sum;
}

export function runPublic() {
  const ch = run?.chain ?? null;
  return {
    active: !!run,
    type: run?.type ?? null,
    week: run?.week ?? null,
    startedAt: run?.startedAt ?? null,
    typicalMs: run ? typicalMs(run.type) : null,
    // Multi-step chains only (null for a single run): which step is running,
    // the whole sequence, and the chain's start + summed typical time for the strip.
    chain: ch ? {
      step: ch.step, of: ch.of, types: ch.types, weeks: ch.weeks,
      startedAt: ch.startedAt, typicalMs: chainTypicalMs(ch.types),
    } : null,
    lastResult,
    fold: foldPublic(), // pending count, auto-fold countdown, last fold outcome (auto-fold section)
  };
}

interface StepOutcome { ok: boolean; summaryMd: string; summaryHtml: string; durationMs: number }

// One run's work: the SDK call (or the mock), then — on success only — the
// per-run bookkeeping. Never touches the global `run` lock; startChain owns it.
async function executeStep(step: ChainStep, abort: AbortController, pushEvent: (ev: RunEvent) => void): Promise<StepOutcome> {
  const { type, week } = step;
  const note = step.note ?? '';
  const autoApprove = !!step.autoApprove;

  // Entries pending when the run starts get stamped foldedAt on success; a
  // capture edited mid-run keeps its newer `at` and stays pending.
  const foldSnapshot = (type === 'fold' || type === 'review')
    ? pendingCaptures().map((c) => ({ date: c.date, at: c.at }))
    : [];

  let summaryMd = '';
  let isError = false;
  const started = Date.now();
  let durationMs = 0;

  try {
    const prompt = await buildPrompt(type, week, note, { autoApprove, rescale: step.rescale });
    if (MOCK_RUNS) {
      console.log(`[mealapp] mock ${type} run${week ? ` for ${week}` : ''} — prompt:\n${prompt}\n[mealapp] (end of mock prompt)`);
      const acts = mockActivity(type, week);
      for (const a of acts) {
        pushEvent({ kind: 'activity', text: `mock · ${a}` });
        await abortableSleep(MOCK_MS / acts.length, abort.signal);
      }
      if (MOCK_FAIL.has(type)) { isError = true; summaryMd = `Mock ${type} failure (MEALAPP_MOCK_FAIL).`; }
      else summaryMd = mockSummary(type, week, note, autoApprove, step.rescale);
    } else {
      const options: Options = {
        cwd: repoRoot,
        abortController: abort,
        permissionMode: 'acceptEdits',
        allowedTools: RUN_ALLOWED_TOOLS,
        canUseTool: canUseTool(),
        settingSources: ['project'],
        systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
        maxTurns: type === 'fold' ? 50 : type === 'shop-adjust' || type === 'rescale' ? 40 : 120,
        // resolved once, here: settings changes mid-run apply to the next run
        ...modelFor(type === 'fold' || type === 'shop-adjust' || type === 'rescale' ? 'light' : 'plan'),
      };
      const q = query({ prompt, options });
      for await (const msg of q) {
        if (msg.type === 'assistant' && msg.parent_tool_use_id === null) {
          for (const block of msg.message.content) {
            if (block.type === 'tool_use') {
              const label = activityLabel(block.name, (block.input ?? {}) as Record<string, unknown>);
              if (label) pushEvent({ kind: 'activity', text: label });
            }
          }
        } else if (msg.type === 'result') {
          durationMs = msg.duration_ms;
          if (msg.subtype === 'success') {
            summaryMd = msg.result;
            isError = msg.is_error;
          } else {
            isError = true;
            summaryMd = `Claude run failed (${msg.subtype}).`;
          }
        }
      }
    }
  } catch (err) {
    isError = true;
    const message = err instanceof Error ? err.message : String(err);
    summaryMd = abort.signal.aborted ? 'Stopped by user.' : `Claude error: ${message}`;
    if (/401|invalid.*credential|authenticat/i.test(message)) {
      summaryMd = 'Claude authentication failed. Run `claude` in a terminal on the Mac, complete /login once, then try again.';
    }
  }
  if (!durationMs) durationMs = Date.now() - started;
  const summaryHtml = String(marked.parse(summaryMd));

  if (isError) {
    pushEvent({ kind: 'error', text: summaryMd });
  } else {
    void recordDuration(type, durationMs);
    // Post-run bookkeeping on success: stamp folded captures; clear consumed
    // feedback/extras so the next round starts clean.
    if (foldSnapshot.length) {
      const now = Date.now();
      for (const s of foldSnapshot) {
        const c = captures[s.date];
        if (c && c.at === s.at) c.foldedAt = now;
      }
      await saveCaptures();
    }
    if (type === 'propose' || type === 'revise' || type === 'lock') {
      if (feedback[week]) { delete feedback[week]; await saveFeedback(); }
    }
    if (type === 'lock' && extras[week]?.length) { delete extras[week]; await saveExtras(); }
    pushEvent({ kind: 'done', ok: true, summaryHtml, durationMs });
  }
  return { ok: !isError, summaryMd, summaryHtml, durationMs };
}

// "close out 2026-W42", "propose 2026-W43" — how chain messages name a step.
const STEP_VERB: Record<RunType, string> = {
  propose: 'propose', revise: 'revise', lock: 'lock', fold: 'fold the log',
  'shop-adjust': 'adjust the list for', review: 'close out', ask: 'answer an Ask Claude question',
  ideas: 'suggest new recipe ideas', import: 'import a recipe', rescale: 'rescale a meal in',
};
const stepLabel = (s: ChainStep) => `${STEP_VERB[s.type]}${s.week ? ` ${s.week}` : ''}`;

/** A single run — a one-step chain, so it shares every code path below. */
export async function startRun(type: RunType, week: string, note = '') {
  await startChain([{ type, week, note }]);
}

/**
 * Run steps back to back under the one-run lock (close-and-plan =
 * review → propose; send-and-lock = revise → lock). `run` stays set from the
 * first step's start to the last step's end, so no other run, auto-fold, or
 * git pull can slip in between steps. Stop aborts the whole chain. A failed
 * (or stopped, or guard-blocked) step ends it with an error event naming what
 * did not run. Routes check guardNoRun first; the `run` check here is the
 * backstop, done before the first await so it is race-free.
 */
export async function startChain(steps: ChainStep[]): Promise<void> {
  if (!steps.length) return;
  if (run) { console.log(`[mealapp] startChain refused: a ${run.type} run is already active`); return; }
  const first = steps[0]!;
  const n = steps.length;
  const abort = new AbortController();
  const t0 = Date.now();
  const cur: Run = {
    type: first.type, week: first.week, startedAt: t0, events: [], abort,
    chain: n > 1 ? { step: 1, of: n, types: steps.map((s) => s.type), weeks: steps.map((s) => s.week), startedAt: t0 } : null,
  };
  run = cur;
  const pushEvent = (ev: RunEvent) => { cur.events.push(ev); broadcast({ type: 'event', ev }); };

  const done: StepResult[] = [];
  let last: StepOutcome | null = null;
  let failure: { index: number; outcome: StepOutcome | null; notStartedWhy?: string } | null = null;

  for (let i = 0; i < n; i++) {
    const step = steps[i]!;
    cur.type = step.type;
    cur.week = step.week;
    cur.startedAt = Date.now();
    if (cur.chain) cur.chain.step = i + 1;
    const chainInfo = cur.chain ? { step: i + 1, of: n, types: cur.chain.types } : undefined;
    broadcast({ type: 'run-state', run: runPublic() });

    // A Stop between steps, or a precheck that no longer holds, ends the chain
    // before this step spends anything.
    let why: string | null = abort.signal.aborted ? 'stopped by user' : null;
    if (!why && step.guard) {
      try { why = await step.guard(); } catch (err) { why = `precheck failed: ${String(err)}`; }
      if (why && MOCK_RUNS) {
        pushEvent({ kind: 'activity', text: `mock · precheck would stop here (${why}); continuing, mock steps write no files` });
        why = null;
      }
    }
    if (why) {
      failure = { index: i, outcome: null, notStartedWhy: why };
      emitRunDone({ type: step.type, week: step.week, ok: false, summaryMd: `Not started: ${why}.`, ...(chainInfo ? { chain: chainInfo } : {}) });
      break;
    }

    const tag = cur.chain ? `Step ${i + 1} of ${n}: ` : '';
    pushEvent({ kind: 'status', text: `${tag}${step.type} run started${step.week ? ` for ${step.week}` : ''}` });
    const out = await executeStep(step, abort, pushEvent);
    emitRunDone({ type: step.type, week: step.week, ok: out.ok, summaryMd: out.summaryMd, ...(chainInfo ? { chain: chainInfo } : {}) });
    if (!out.ok) { failure = { index: i, outcome: out }; break; }
    done.push({ type: step.type, week: step.week, summaryHtml: out.summaryHtml });
    last = out;
    // let the UI show this step's effects (e.g. the week now closed) while the next one runs
    if (i < n - 1) broadcast({ type: 'state-updated' });
  }

  const at = Date.now();
  if (!cur.chain) {
    // single run: exactly the pre-chain result shape
    const out = failure?.outcome ?? last;
    if (out) lastResult = { type: first.type, week: first.week, ok: out.ok, summaryHtml: out.summaryHtml, at };
  } else if (!failure && last) {
    const fin = steps[n - 1]!;
    lastResult = { type: fin.type, week: fin.week, ok: true, summaryHtml: last.summaryHtml, at, chain: true, results: done };
  } else if (failure) {
    const step = steps[failure.index]!;
    const head = `Step ${failure.index + 1} of ${n} (${stepLabel(step)})`;
    const rest = steps.slice(failure.index + 1).map((s, j) => `step ${failure!.index + 2 + j} (${stepLabel(s)})`);
    const restTxt = rest.length ? `; ${rest.join(', ')} not started` : '';
    const msg = failure.notStartedWhy !== undefined
      ? `${head} not started: ${failure.notStartedWhy}${restTxt}`
      : `${head} ${abort.signal.aborted ? 'stopped' : 'failed'}${restTxt}`;
    pushEvent({ kind: 'error', text: msg });
    let html = String(marked.parse(`**${msg}.**`)) + (failure.outcome?.summaryHtml ?? '');
    for (const r of done) {
      html += String(marked.parse(`**Finished before that: ${STEP_VERB[r.type]}${r.week ? ` ${r.week}` : ''}.**`)) + r.summaryHtml;
    }
    lastResult = { type: step.type, week: step.week, ok: false, summaryHtml: html, at, chain: true, results: done };
  }

  run = null;
  broadcast({ type: 'run-state', run: runPublic() });
  broadcast({ type: 'state-updated' });
}

// ---------- the run lock, borrowed (Ask Claude) ----------
// Work that may write the repo but isn't a prompt-file run (the Ask Claude
// chat, ask.ts) holds the one-run lock as a pseudo-run: `run` is set while
// `fn` works, so runPublic().active is true (the strip shows it and its Stop
// aborts `signal` via POST /api/stop), no run or chain can start on top of
// it, and auto-fold and the throttled git pull stay out. Not a run otherwise:
// no duration stats, no lastResult, no onRunDone.

export class RunBusyError extends Error {
  constructor(readonly busy: string) {
    super(`Claude is busy: ${busy}`);
    this.name = 'RunBusyError';
  }
}

/** What the active run is doing, for "Claude is busy with …" messages. */
export function busyLabel(r: Run): string {
  if (r.type === 'ask') return 'another Ask Claude answer';
  const ch = r.chain;
  if (ch) return `the ${ch.types.map((t, i) => `${t}${ch.weeks[i] ? ` ${ch.weeks[i]}` : ''}`).join(' → ')} chain`;
  return `the ${r.type} run${r.week ? ` for ${r.week}` : ''}`;
}

/**
 * Run `fn` under the one-run lock as a pseudo-run of `type`; throws
 * RunBusyError (route → 409) when a run or chain is active. `label` is the
 * first strip line (e.g. the question); `pushEvent` adds activity lines.
 */
export async function withRunLock<T>(
  type: RunType,
  label: string,
  fn: (signal: AbortSignal, pushEvent: (ev: RunEvent) => void) => Promise<T>,
): Promise<T> {
  if (run) throw new RunBusyError(busyLabel(run)); // sync check + set: race-free
  const abort = new AbortController();
  const cur: Run = { type, week: '', startedAt: Date.now(), events: [], abort, chain: null };
  run = cur;
  const pushEvent = (ev: RunEvent) => { cur.events.push(ev); broadcast({ type: 'event', ev }); };
  broadcast({ type: 'run-state', run: runPublic() });
  if (label) pushEvent({ kind: 'status', text: label });
  try {
    return await fn(abort.signal, pushEvent);
  } finally {
    if (run === cur) run = null;
    broadcast({ type: 'run-state', run: runPublic() });
  }
}

// ---------- auto-fold ----------
// Captures land instantly in captures.json; a cheap fold run writes them into
// the plan files' Log tables once things have been quiet for a while. Never
// fires while another run is active. Toggle + quiet delay are settings
// (gear panel; MEALAPP_AUTOFOLD=off is the env fallback).

export let lastCaptureAt = 0;
/** Stamp "a capture just landed" for the auto-fold debounce (POST /api/log). */
export function markCapture() {
  lastCaptureAt = Date.now();
}
// 5 s rather than a minute: the strip counts down to fold.nextAt, so the fold
// should start within seconds of the countdown reaching zero. A tick is a few
// comparisons.
const AUTOFOLD_TICK_MS = 5_000;

// ---- fold state, for the UI ----
// "Is my note in the record yet?" — the strip's countdown, the per-entry
// "in the record ✓✓ · 10:42", the confirmation toast on every tab, the failure
// strip with Retry, and Settings → Status all read foldPublic(), shipped in
// /api/state (top-level `fold`), in every run-state broadcast (runPublic), in
// capture broadcasts, and as its own `fold-state` message when `last` changes.
// In memory like run state; boot rebuilds `last` from the newest foldedAt stamp.

type CaptureRow = ReturnType<typeof pendingCaptures>[number];
export interface FoldedEntry { date: string; dish?: string; rating?: number; noted?: true; minutes?: number }
export interface FoldLast {
  at: number;            // ok: the foldedAt stamp of this fold; failed: when it failed
  ok: boolean;
  message: string;       // failure text ('' on success)
  folded: FoldedEntry[]; // what this fold (or close-out) put in the record, by date
}
export let foldLast: FoldLast | null = null;

/** A failed fold parks auto-fold until a newer capture lands or someone retries — no retry every tick. */
const foldParked = () => !!foldLast && !foldLast.ok && foldLast.at >= lastCaptureAt;

export function foldPublic() {
  const pending = pendingCaptures().length;
  // null = no auto-fold coming: off, nothing pending, no capture since boot, or parked after a failure
  const nextAt = autoFoldOn() && pending && lastCaptureAt && !foldParked() ? lastCaptureAt + foldDebounceMs() : null;
  return { pending, nextAt, quietMin: Math.round(foldDebounceMs() / 60_000), last: foldLast };
}

const broadcastFold = () => broadcast({ type: 'fold-state', fold: foldPublic() });

// The planned dish per folded date, so a confirmation reads "Sat · Coconut-dill
// salmon — 5" rather than a bare date. A capture's own dish (an override, or
// "skipped — …") wins. Labels are cosmetic: a read failure leaves them off.
async function labelFolded(caps: CaptureRow[]): Promise<FoldedEntry[]> {
  let plans: Awaited<ReturnType<typeof readAllPlans>> | null = null;
  try { plans = await readAllPlans(); } catch { /* unlabeled is fine */ }
  return [...caps].sort((a, b) => a.date.localeCompare(b.date)).map((c) => {
    let dish = c.dish;
    if (!dish && plans && /^\d{4}-\d{2}-\d{2}$/.test(c.date)) {
      const plan = plans.get(weekIdForDate(new Date(c.date + 'T00:00:00Z')));
      if (plan) {
        const dates = weekDates(plan.week);
        dish = plan.meals.find((m) => !m.flexible && dates[m.day] === c.date)?.dish;
      }
    }
    return {
      date: c.date,
      ...(dish ? { dish } : {}),
      ...(c.rating !== undefined ? { rating: c.rating } : {}),
      ...(c.note ? { noted: true as const } : {}),
      ...(c.minutes !== undefined ? { minutes: c.minutes } : {}),
    };
  });
}

// Record each fold, and each close-out (which folds pending captures first),
// as foldLast. Runs synchronously inside emitRunDone, while `run` still holds
// this step's start, so "stamped foldedAt since then" is exactly what this
// step put in the record (executeStep stamps the snapshot it took at start).
function recordFold(info: RunDoneInfo) {
  if (info.type !== 'fold' && info.type !== 'review') return;
  const since = run?.startedAt ?? 0;
  if (!info.ok) {
    // a close-out that failed with nothing pending wasn't a sync; its own card says what happened
    if (info.type === 'review' && !pendingCaptures().length) return;
    foldLast = { at: Date.now(), ok: false, message: clip(info.summaryMd.replace(/\s+/g, ' ').trim(), 220), folded: [] };
    broadcastFold();
    return;
  }
  const stamped = Object.values(captures).filter((c) => c.foldedAt && c.foldedAt >= since).map((c) => ({ ...c }));
  if (!stamped.length) return; // a close-out with nothing pending: the record line is unchanged
  const at = Math.max(...stamped.map((c) => c.foldedAt!));
  void labelFolded(stamped).then((folded) => {
    if (foldLast && foldLast.at > at) return; // something newer already landed
    foldLast = { at, ok: true, message: '', folded };
    broadcastFold();
  });
}

// Started from boot() — module level would leak a timer into the selftest.
export function startAutoFold() {
  onRunDone(recordFold);
  // After a restart, anchor the quiet delay on the newest pending capture, so
  // entries saved before the restart still fold on schedule instead of waiting
  // for some later capture; and rebuild `last` from the newest foldedAt stamp.
  const pend = pendingCaptures();
  if (!lastCaptureAt && pend.length) lastCaptureAt = Math.max(...pend.map((c) => c.at));
  const newest = Math.max(0, ...Object.values(captures).map((c) => c.foldedAt ?? 0));
  if (newest) {
    void labelFolded(Object.values(captures).filter((c) => c.foldedAt === newest)).then((folded) => {
      foldLast ??= { at: newest, ok: true, message: '', folded };
    });
  }
  setInterval(() => {
    if (!autoFoldOn() || run) return;
    if (!pendingCaptures().length) return;
    if (!lastCaptureAt || foldParked() || Date.now() - lastCaptureAt < foldDebounceMs()) return;
    void startRun('fold', '');
  }, AUTOFOLD_TICK_MS);
}
