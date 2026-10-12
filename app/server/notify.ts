// Notification sends: what the phone buzzes for, built on push.ts.
//
//   run-done        one per user-visible completion: a single run, or a whole
//                   chain (close-and-plan, send-and-lock) combined into one.
//                   fold and ask never send it.
//   record-updated  a fold (or a close-out that folded entries) put captures
//                   in the record: the same wording as the client's toast.
//   prep-today      daily at pushPrepTime (default 08:00): unchecked prep
//                   tasks due today. Nothing due, no send.
//   tonight         daily at pushTonightTime (default 16:30): tonight's
//                   dinner. A flexible night or no plan, no send.
//
// Copy is built by the pure functions below (unit-tested in the selftest with
// synthetic state); the I/O around them gathers state after the event.
// Safety: nothing here throws into run completion (the onRunDone listener only
// does synchronous bookkeeping and hands off to try/catch'd async work); every
// send is skipped when push is off or no device wants that type; a 10-minute
// dedupe guards against double sends. MEALAPP_PUSH_DRYRUN=1 logs the would-be
// payloads instead of sending (MEALAPP_PUSH_DRYRUN_TODAY=YYYY-MM-DD then also
// stands in for today's date in the daily notices, to exercise them on any day).
//
// Daily times re-arm by polling: a 15 s watcher compares the effective
// settings with what is armed and re-arms dailyAt when they differ, so a
// PUT /api/settings applies within 15 s with no route hook.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { readIdeas } from './ideas.ts';
import { importsDir, type ImportRecord } from './import.ts';
import { DEFAULT_SERVINGS, parseRecipe, SAFE_FILE, type ParsedPlan } from './parse.ts';
import { recipesDir } from './paths.ts';
import { dailyAt, listSubscriptions, nextOccurrence, pushReady, sendPush, type PushType } from './push.ts';
import { foldPublic, onRunDone, run, type FoldedEntry, type RunDoneInfo } from './runs.ts';
import { buildState } from './state.ts';
import { captures, effectiveSettings, type RunType, type WeekFeedback } from './store.ts';
import { humanizeWeekIds, weekDates, weekIdForDate, weekInfo, weekPhrase } from './weeks.ts';

// ---------- types ----------

export interface NotifyPayload { title: string; body: string; url: string; tag: string }

type PlanLike = Pick<ParsedPlan, 'week' | 'status' | 'meals' | 'prep' | 'grocery' | 'log'>;

/** The slice of buildState() the copy needs; buildState()'s result fits it. */
export interface NotifyState {
  today: string;
  cooking: { week: string; plan: PlanLike } | null;
  ahead: { week: string; plan: PlanLike } | null;
  checks: Record<string, unknown>;
  captures: Record<string, { rating?: number; dish?: string }>;
  feedback: WeekFeedback | null; // the ahead week's Next-tab feedback
}

/** Facts read from disk for a few run types (ideas count, imported recipe name). */
export interface RunExtras { ideasCount?: number | null; importName?: string | null }

// ---------- text helpers ----------

/**
 * How a title names a week, relative to `today` (ISO date): "next week",
 * "this week", "last week", else its dates ("Oct 17–23"). Capitalised with cap.
 */
export function weekWords(week: string, today: string, cap = false): string {
  if (!week) return '';
  const info = weekInfo(week, weekIdForDate(new Date(`${today}T00:00:00Z`)));
  if (info.rel) return weekPhrase(info, { cap });
  return info.range;
}

/** Clip at a word boundary to at most `max` chars, with an ellipsis. */
export function clipText(s: string, max: number): string {
  const t = s.replace(/\s+/g, ' ').trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max - 1);
  const sp = cut.lastIndexOf(' ');
  return `${(sp > max * 0.6 ? cut.slice(0, sp) : cut).replace(/[\s,;:·—–-]+$/, '')}…`;
}

/**
 * First meaningful line of a run summary as plain text (≤ max chars): markdown
 * marks, bullets and headings stripped; the mock-run header and rules skipped.
 */
export function firstLine(md: string, max = 120): string {
  for (const raw of String(md ?? '').split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed || /^([-*_=])\1{2,}$/.test(trimmed)) continue;
    const t = trimmed
      .replace(/^#{1,6}\s+/, '').replace(/^>\s*/, '').replace(/^[-*+]\s+/, '').replace(/^\d+[.)]\s+/, '')
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/`([^`]*)`/g, '$1')
      .replace(/(\*\*|__)(.+?)\1/g, '$2')
      .replace(/(^|[\s(])[*_](\S(?:.*?\S)?)[*_](?=$|[\s).,:;!?])/g, '$1$2')
      .replace(/<[^>]+>/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!t || /^Mock run \(MEALAPP_MOCK_RUNS\)/.test(t)) continue;
    return clipText(t, max);
  }
  return '';
}

/** The dish's head, as the client shows it: "Coconut-Dill Salmon with Green Beans, …" → "Coconut-Dill Salmon". */
export function dishHead(dish: string, max = 40): string {
  const d = String(dish ?? '').trim();
  const head = d.split(/\s+(?:with|over|on|and|&|\+)\s+|,\s*|\s+[—–-]\s+/i)[0] || d;
  return head.length > max ? `${head.slice(0, max - 1)}…` : head;
}

/**
 * One prep task as a notification line: its first sentence, trailing period
 * dropped; a long one loses its parenthetical or dash tail, then is clipped.
 */
export function shortTask(text: string, max = 100): string {
  let t = String(text ?? '').replace(/\s+/g, ' ').trim();
  const sentence = /^(.+?[.!?])(?=\s|$)/.exec(t)?.[1];
  if (sentence && sentence.length >= 12) t = sentence;
  t = t.replace(/\.+$/, '');
  if (t.length > max) {
    const cut = t.search(/\s\(|\s[—–]\s/);
    if (cut >= 20) t = t.slice(0, cut);
  }
  return clipText(t, max);
}

/** Join parts with " · " in order while they fit in `limit`, then "· +N more". */
export function joinLimited(parts: string[], limit: number): string {
  const more = (n: number) => (n > 0 ? ` · +${n} more` : '');
  const out: string[] = [];
  for (let i = 0; i < parts.length; i++) {
    const next = [...out, parts[i]!].join(' · ');
    if (next.length + more(parts.length - i - 1).length > limit) break;
    out.push(parts[i]!);
  }
  if (!out.length && parts.length) {
    const tail = more(parts.length - 1);
    return clipText(parts[0]!, Math.max(10, limit - tail.length)) + tail;
  }
  return out.join(' · ') + more(parts.length - out.length);
}

const cap1 = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

// ---------- run-done copy ----------

const TAB_FOR: Record<RunType, string> = {
  propose: '/?tab=next', revise: '/?tab=next', lock: '/?tab=next',
  review: '/?tab=week', fold: '/?tab=week', move: '/?tab=week',
  'shop-adjust': '/?tab=shop', rescale: '/?tab=shop',
  ideas: '/?tab=recipes', import: '/?tab=recipes', ask: '/',
};

const runTag = (type: RunType, week: string) => `run-${type}${week ? `-${week}` : ''}`;

/** The plan a run of `week` touched: ahead or cooking, whichever it is now. */
function planFor(state: NotifyState, week: string): PlanLike | null {
  if (state.ahead?.week === week) return state.ahead.plan;
  if (state.cooking?.week === week) return state.cooking.plan;
  return null;
}

/** "4 meals to decide" (non-flexible meals neither approved in the file nor decided on the Next tab). */
export function proposeBody(state: NotifyState, week: string): string {
  const plan = planFor(state, week);
  if (!plan) return 'Ready to review on the Next tab';
  const fb = state.ahead?.week === week ? state.feedback : null;
  const meals = plan.meals.filter((m) => !m.flexible);
  const open = meals.filter((m) => m.status !== 'approved' && !fb?.meals[m.day]?.decision).length;
  if (!meals.length) return 'Ready to review on the Next tab';
  if (!open) return 'Everything approved: ready to lock';
  return `${open} meal${open === 1 ? '' : 's'} to decide`;
}

/** "Warehouse club 2 items · Supermarket 11" from the parsed grocery list (stores with no items left out). */
export function lockBody(state: NotifyState, week: string): string {
  const plan = planFor(state, week);
  const counts = (plan?.grocery.stores ?? [])
    .map((s) => ({ name: s.name, n: s.sections.reduce((a, sec) => a + sec.items.length, 0) }))
    .filter((s) => s.n > 0);
  if (!counts.length) return 'The grocery list is on the Shop tab';
  return counts.map((s, i) => (i === 0 ? `${s.name} ${s.n} item${s.n === 1 ? '' : 's'}` : `${s.name} ${s.n}`)).join(' · ');
}

/** Title/body/url for one successful step; null for types that never notify. */
function stepCopy(info: RunDoneInfo, state: NotifyState, extras: RunExtras): Omit<NotifyPayload, 'tag'> | null {
  const w = weekWords(info.week, state.today);
  const W = weekWords(info.week, state.today, true);
  const line = firstLine(humanizeWeekIds(info.summaryMd));
  switch (info.type) {
    case 'propose': return { title: `Proposal ready for ${w}`, body: proposeBody(state, info.week), url: '/?tab=next' };
    case 'revise': return { title: `${W} revised`, body: line || 'The updated proposal is on the Next tab', url: '/?tab=next' };
    case 'lock': return { title: `${W} locked`, body: lockBody(state, info.week), url: '/?tab=shop' };
    case 'review': return { title: `${W} closed out`, body: line || 'Stats and the week review are in the record', url: '/?tab=week' };
    case 'shop-adjust':
    case 'rescale': return { title: `List updated for ${w}`, body: line || 'The new list is on the Shop tab', url: '/?tab=shop' };
    case 'move': return { title: 'Dinner moved', body: line || 'The plan and its prep are updated on the Week tab', url: '/?tab=week' };
    case 'ideas': {
      const n = extras.ideasCount;
      return { title: 'New ideas ready', body: n ? `${n} dish${n === 1 ? '' : 'es'} to browse` : 'Fresh dishes to browse on the Recipes tab', url: '/?tab=recipes' };
    }
    case 'import': return { title: 'Recipe imported', body: extras.importName || line || 'It is on the Recipes tab', url: '/?tab=recipes' };
    case 'fold':
    case 'ask': return null;
  }
}

/**
 * The run-done notification for one user-visible completion: `steps` is a
 * single run, or every finished step of a chain in order (the last one may
 * have failed, ending the chain). null when nothing should be sent.
 */
export function runDonePayload(steps: RunDoneInfo[], state: NotifyState, extras: RunExtras = {}): NotifyPayload | null {
  const visible = steps.filter((s) => s.type !== 'fold' && s.type !== 'ask');
  const last = visible[visible.length - 1];
  if (!last) return null;
  const tag = runTag(last.type, last.week);

  if (!last.ok) {
    const before = visible.slice(0, -1).filter((s) => s.ok)
      .map((s) => stepCopy(s, state, extras)?.title).filter((t): t is string => !!t);
    const stopped = /\bstopped by user\b/i.test(last.summaryMd);
    const err = firstLine(humanizeWeekIds(last.summaryMd), 140) || 'No details: open the app';
    return {
      title: `Run ${stopped ? 'stopped' : 'failed'}: ${last.type}${last.week ? `, ${weekWords(last.week, state.today)}` : ''}`,
      body: clipText(before.length ? `${before.join(' · ')} ✓. ${err}` : err, 180),
      url: TAB_FOR[last.type],
      tag,
    };
  }

  const copies = visible.map((s) => stepCopy(s, state, extras)).filter((c): c is Omit<NotifyPayload, 'tag'> => !!c);
  const fin = copies[copies.length - 1];
  if (!fin) return null;
  const sendAndLock = visible.length === 2 && visible[0]!.type === 'revise' && visible[1]!.type === 'lock' && visible[0]!.week === visible[1]!.week;
  // close-and-plan: the two steps' own titles joined run past ~40 chars, so
  // it reads like the app's result card ("Closed out this week · proposed next week")
  const closeAndPlan = visible.length === 2 && visible[0]!.type === 'review' && visible[1]!.type === 'propose';
  const title = sendAndLock ? `${weekWords(last.week, state.today, true)} revised and locked`
    : closeAndPlan ? `Closed out ${weekWords(visible[0]!.week, state.today)} · proposed ${weekWords(visible[1]!.week, state.today)}`
    : copies.map((c) => c.title).join(' · ');
  return { title, body: fin.body, url: fin.url, tag };
}

// ---------- record-updated copy ----------

/** One folded entry, worded exactly like the client's foldedLabel (00-core.js). */
export function foldedLabel(e: FoldedEntry): string {
  const d = String(e?.dish ?? '');
  const skip = d.match(/^skipped\s*[—–:-]?\s*(.*)$/i);
  const dow = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'][new Date(`${e.date}T00:00:00Z`).getUTCDay()] ?? e.date;
  let s = dow;
  if (skip) s += skip[1] ? ` skipped (${skip[1]})` : ' skipped';
  else if (d) s += ` ${dishHead(d, 40)}`;
  const bits = [e.rating ? String(e.rating) : '', e.minutes ? `took ~${e.minutes} min` : '', e.noted ? 'noted' : ''].filter(Boolean);
  return bits.length ? `${s} — ${bits.join(', ')}` : s;
}

/** "In the record ✓✓" · "Sat Coconut-Dill Salmon — 5, noted and 2 more" (the client toast's wording). */
export function recordPayload(folded: FoldedEntry[]): NotifyPayload | null {
  const [first, ...rest] = folded;
  if (!first) return null;
  return {
    title: 'In the record ✓✓',
    body: `${foldedLabel(first)}${rest.length ? ` and ${rest.length} more` : ''}`,
    url: '/?tab=week',
    tag: 'record',
  };
}

// ---------- daily copy ----------

/** Unchecked prep tasks due `today`: the cooking week's, then the week ahead's (tasks due before it starts). */
export function dueTasks(state: NotifyState, today: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const plan of [state.cooking?.plan, state.ahead?.plan]) {
    for (const t of plan?.prep ?? []) {
      if (t.dueDate !== today || state.checks[t.key] || seen.has(t.key)) continue;
      seen.add(t.key);
      out.push(t.text);
    }
  }
  return out;
}

/** "Prep today" · the tasks joined with " · " (≤ 180, "+N more"); null when nothing is due. */
export function prepTodayPayload(state: NotifyState, today = state.today): NotifyPayload | null {
  const tasks = dueTasks(state, today);
  if (!tasks.length) return null;
  return {
    title: 'Prep today',
    body: joinLimited(tasks.map((t) => cap1(shortTask(t))), 180),
    url: '/?tab=week',
    tag: `prep-${today}`,
  };
}

/**
 * "Tonight: <dish>" · "<active> min · <servings> servings · prep: <due today or none>".
 * null on a flexible night, a day with no plan, or a night already logged (rated or skipped).
 */
export function tonightPayload(state: NotifyState, today = state.today): NotifyPayload | null {
  const c = state.cooking;
  if (!c) return null;
  const dates = weekDates(c.week);
  const meal = c.plan.meals.find((m) => dates[m.day] === today);
  if (!meal || meal.flexible || /^(rejected|skipped)$/i.test(meal.status)) return null;
  const cap = state.captures[today];
  if (cap && (cap.rating !== undefined || cap.dish)) return null;
  const row = c.plan.log.find((l) => l.day === meal.day);
  if (row && (row.rating !== undefined || (row.cooked && row.cooked !== ''))) return null;
  const head = `${meal.timeMin ? `${meal.timeMin} min · ` : ''}${meal.servings ?? DEFAULT_SERVINGS} servings · prep: `;
  const tasks = dueTasks(state, today).map((t) => shortTask(t));
  return {
    title: `Tonight: ${dishHead(meal.dish, 48)}`,
    body: head + (tasks.length ? joinLimited(tasks, 180 - head.length) : 'none'),
    url: '/?tab=cook',
    tag: `tonight-${today}`,
  };
}

// ---------- delivery ----------

const DEDUPE_MS = 10 * 60_000;
const sentAt = new Map<string, number>();
const dryRun = () => /^(1|true|on|yes)$/i.test(process.env.MEALAPP_PUSH_DRYRUN ?? '');
const log = (msg: string) => console.log(`[notify] ${msg}`);

export type DeliverOutcome = 'not-ready' | 'no-devices' | 'duplicate' | 'dry-run' | 'sent' | 'error';

/**
 * Send one notification, never throwing. Skips when push is off, when no
 * device has `type` on, and when `key` (default: the tag) went out in the last
 * 10 minutes. Event-driven sends pass a key that names the event (tag + run
 * start / fold stamp), so a back-to-back second revise still notifies while a
 * double-fired listener cannot; the daily ones dedupe on their dated tag.
 */
export async function deliver(type: PushType, p: NotifyPayload, key = p.tag): Promise<DeliverOutcome> {
  try {
    if (!pushReady()) { log(`skip ${type} "${p.title}": push is not initialised`); return 'not-ready'; }
    const devices = listSubscriptions().filter((s) => s.types[type]).length;
    if (!devices) { log(`skip ${type} "${p.title}": no subscribed device has ${type} on`); return 'no-devices'; }
    const now = Date.now();
    for (const [k, t] of sentAt) if (now - t >= DEDUPE_MS) sentAt.delete(k);
    if (sentAt.has(key)) { log(`skip ${type} "${p.title}": already sent ${key} within 10 min`); return 'duplicate'; }
    sentAt.set(key, now);
    if (dryRun()) { log(`dry-run ${type} → ${devices} device(s): ${JSON.stringify(p)}`); return 'dry-run'; }
    const r = await sendPush(type, p);
    log(`sent ${type} "${p.title}" → ${r.sent} delivered, ${r.pruned} pruned, ${r.errors.length} failed`
      + (r.errors.length ? ` (${r.errors.map((e) => `${e.status ?? '?'} ${e.message}`).join('; ').slice(0, 300)})` : ''));
    return 'sent';
  } catch (err) {
    log(`${type} send failed: ${String(err)}`);
    return 'error';
  }
}

/** Test seam: forget the dedupe window. */
export function resetNotifyDedupe() { sentAt.clear(); }

// ---------- gatherers (I/O) ----------

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Size of the newest ideas batch when it is dated today (a fresh run's), else null. */
async function freshIdeasCount(today: string): Promise<number | null> {
  try {
    const b = (await readIdeas()).batches[0];
    return b && b.date === today ? b.items.length : null;
  } catch { return null; }
}

/** The import record with the latest runAt, read straight from disk (listRecords() can rewrite records). */
async function newestRunImport(): Promise<ImportRecord | null> {
  let names: string[] = [];
  try { names = (await fs.readdir(importsDir)).filter((n) => n.endsWith('.json')); } catch { return null; }
  let best: ImportRecord | null = null;
  for (const n of names) {
    try {
      const r = JSON.parse(await fs.readFile(path.join(importsDir, n), 'utf8')) as ImportRecord;
      if (r.runAt && (!best || r.runAt > (best.runAt ?? 0))) best = r;
    } catch { /* skip unreadable */ }
  }
  return best;
}

/**
 * The imported recipe's name. import.ts's own onRunDone listener records which
 * file the run wrote, asynchronously, so wait (≤ 15 s) for the record to leave
 * 'running'; then read the recipe's frontmatter name.
 */
async function importedRecipeName(summaryMd: string): Promise<string | null> {
  const deadline = Date.now() + 15_000;
  let rec = await newestRunImport();
  while (rec?.status === 'running' && Date.now() < deadline) {
    await sleep(300);
    rec = await newestRunImport();
  }
  const file = rec?.recipeFile ?? /recipes\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)/.exec(summaryMd)?.[1];
  if (file && SAFE_FILE.test(file)) {
    try { return parseRecipe(await fs.readFile(path.join(recipesDir, file), 'utf8'), file).meta.name; } catch { /* not written */ }
  }
  return rec?.recipe?.name ?? rec?.title ?? null;
}

async function sendRunDone(steps: RunDoneInfo[], key: string): Promise<void> {
  try {
    // Called inside emitRunDone, while `run` is still set: buildState's
    // throttled pull checks `run` before its first await, so it never pulls here.
    const state = await buildState();
    const last = steps[steps.length - 1]!;
    const extras: RunExtras = {};
    if (last.ok && last.type === 'ideas') extras.ideasCount = await freshIdeasCount(state.today);
    if (last.ok && last.type === 'import') extras.importName = await importedRecipeName(last.summaryMd);
    const p = runDonePayload(steps, state, extras);
    if (p) await deliver('run-done', p, `${p.tag}#${key}`);
  } catch (err) {
    log(`run-done notice failed: ${String(err)}`);
  }
}

/**
 * After a successful fold/close-out step. recordFold (runs.ts) stamps the
 * captures synchronously but sets foldPublic().last only after labelling them
 * (async), so wait for that newer `last`, then send its folded list.
 */
function watchRecord(since: number) {
  const stamped = Object.values(captures).some((c) => c.foldedAt && c.foldedAt >= since);
  if (!stamped) return; // nothing went into the record: no notice
  const prev = foldPublic().last;
  void (async () => {
    const deadline = Date.now() + 15_000;
    while (Date.now() < deadline) {
      const last = foldPublic().last;
      if (last && last !== prev && last.ok && last.at >= since) {
        const p = recordPayload(last.folded);
        if (p) await deliver('record-updated', p, `record#${last.at}`);
        return;
      }
      await sleep(250);
    }
    log('skip record-updated: the fold state never updated');
  })().catch((err) => log(`record-updated notice failed: ${String(err)}`));
}

// A chain's finished steps, collected until its last step (or its failure).
let chainSteps: RunDoneInfo[] = [];

function onRunDoneListener(info: RunDoneInfo) {
  try {
    // `run` still holds this step (emitRunDone fires before the lock is released)
    const stepStart = run?.startedAt ?? Date.now();
    const instance = String(run?.chain?.startedAt ?? stepStart);
    if (info.ok && (info.type === 'fold' || info.type === 'review')) watchRecord(stepStart);
    if (info.chain) {
      if (info.chain.step === 1) chainSteps = [];
      chainSteps.push(info);
      if (info.ok && info.chain.step < info.chain.of) return; // more steps to come
      const steps = chainSteps;
      chainSteps = [];
      void sendRunDone(steps, instance);
      return;
    }
    if (info.type === 'fold' || info.type === 'ask') return;
    void sendRunDone([info], instance);
  } catch (err) {
    log(`run listener failed: ${String(err)}`);
  }
}

// ---------- daily notices ----------

/** MEALAPP_PUSH_DRYRUN_TODAY (dry runs only) stands in for today's date. */
function todayFor(state: { today: string }): string {
  const fake = process.env.MEALAPP_PUSH_DRYRUN_TODAY ?? '';
  return dryRun() && /^\d{4}-\d{2}-\d{2}$/.test(fake) ? fake : state.today;
}

async function firePrep(): Promise<void> {
  try {
    const state = await buildState();
    const today = todayFor(state);
    const p = prepTodayPayload(state, today);
    if (!p) { log(`prep-today: nothing due ${today} (cooking ${state.cooking?.week ?? 'none'}) → no send`); return; }
    await deliver('prep-today', p);
  } catch (err) { log(`prep-today failed: ${String(err)}`); }
}

async function fireTonight(): Promise<void> {
  try {
    const state = await buildState();
    const today = todayFor(state);
    const p = tonightPayload(state, today);
    if (!p) { log(`tonight: no cook night to announce ${today} (flexible, logged, or unplanned) → no send`); return; }
    await deliver('tonight', p);
  } catch (err) { log(`tonight failed: ${String(err)}`); }
}

type Slot = 'prep' | 'tonight';
const armed: Record<Slot, { hhmm: string; cancel: () => void } | null> = { prep: null, tonight: null };

function arm(slot: Slot, hhmm: string, fn: () => Promise<void>) {
  if (armed[slot]?.hhmm === hhmm) return;
  armed[slot]?.cancel();
  armed[slot] = null;
  try {
    armed[slot] = { hhmm, cancel: dailyAt(hhmm, fn) };
    log(`${slot === 'prep' ? 'prep-today' : 'tonight'} armed for ${hhmm} daily (next ${nextOccurrence(hhmm).toLocaleString()})`);
  } catch (err) {
    log(`could not arm ${slot} at ${JSON.stringify(hhmm)}: ${String(err)}`);
  }
}

/** Re-read the two daily times and re-arm whichever changed. The watcher calls it every 15 s. */
export function rearmNotify() {
  const e = effectiveSettings();
  arm('prep', e.pushPrepTime, firePrep);
  arm('tonight', e.pushTonightTime, fireTonight);
}

let started = false;
let unsubscribe: (() => void) | null = null;
let watcher: ReturnType<typeof setInterval> | null = null;

/** Called once from boot() (never on import: the selftest imports this module). */
export function startNotify() {
  if (started) return;
  started = true;
  unsubscribe = onRunDone(onRunDoneListener);
  rearmNotify();
  watcher = setInterval(rearmNotify, 15_000);
  watcher.unref();
  log(`started${dryRun() ? ' — DRY RUN: payloads are logged, never sent' : ''}${pushReady() ? '' : ' (push is off: every send will be skipped)'}`);
}

export function stopNotify() {
  unsubscribe?.();
  unsubscribe = null;
  if (watcher) clearInterval(watcher);
  watcher = null;
  for (const slot of ['prep', 'tonight'] as const) { armed[slot]?.cancel(); armed[slot] = null; }
  chainSteps = [];
  started = false;
}
