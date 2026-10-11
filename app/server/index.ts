// Meal Planner app server.
// One Express process: static UI, the repo's plans/recipes parsed into
// structured state, capture APIs (ratings, checkboxes, plan feedback), and a
// Claude Agent SDK bridge that runs the weekly workflows inside the repo
// (cwd = repo root, so CLAUDE.md's planning/sync rules bind).
//
// Trust model: every GET is open; capture endpoints are open but
// rate-limited and attributed via tailscale whois; anything that spends
// tokens or destroys state needs the shared passcode. The repo's markdown is
// the only system of record — this server parses it and never writes it;
// agent runs are the only writers.
import { query, type Options, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import express from 'express';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { marked } from 'marked';
import { WebSocketServer, WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(here, '..');
const repoRoot = path.resolve(appDir, '..');
const plansDir = path.join(repoRoot, 'plans');
const recipesDir = path.join(repoRoot, 'recipes');
const promptsDir = path.join(appDir, 'prompts');
const dataDir = path.join(appDir, 'data');

const PORT = Number(process.env.MEALAPP_PORT || 4316);
const SERVER_STARTED_AT = Date.now();

// ---------- settings (gear panel) ----------
// Tunables live in app/data/settings.json (gitignored), edited from the gear
// panel. Effective value = settings.json > env var > built-in default. Every
// use site calls a getter, so a change applies to the NEXT run / cook chat
// with no restart — an in-flight run keeps the options it started with.
export const MODEL_OPTIONS = [
  { id: 'claude-fable-5-1', label: 'Fable 5.1' },
  { id: 'claude-fable-5', label: 'Fable 5' },
  { id: 'claude-opus-5-5', label: 'Opus 5.5' },
  { id: 'claude-sonnet-5', label: 'Sonnet 5' },
  { id: 'claude-haiku-4-5-20251001', label: 'Haiku 4.5' },
] as const;
export const EFFORT_OPTIONS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;
export const FOLD_QUIET_OPTIONS = [5, 15, 30, 60] as const;
type Effort = (typeof EFFORT_OPTIONS)[number];

interface Settings {
  planModel?: string;   // propose / revise / lock / review
  lightModel?: string;  // fold / shop-adjust
  cookModel?: string;   // sous-chef chat
  planEffort?: Effort;
  lightEffort?: Effort;
  cookEffort?: Effort;
  autoFold?: boolean;
  foldQuietMin?: number;
}
const SETTING_KEYS = ['planModel', 'lightModel', 'cookModel', 'planEffort', 'lightEffort', 'cookEffort', 'autoFold', 'foldQuietMin'] as const;
type SettingKey = (typeof SETTING_KEYS)[number];

let settings: Settings = {};

/** One value checked against its enum; returns an error string or null. */
function settingError(key: SettingKey, v: unknown): string | null {
  switch (key) {
    case 'planModel': case 'lightModel': case 'cookModel':
      return MODEL_OPTIONS.some((m) => m.id === v) ? null : `${key} must be one of ${MODEL_OPTIONS.map((m) => m.id).join(', ')}`;
    case 'planEffort': case 'lightEffort': case 'cookEffort':
      return (EFFORT_OPTIONS as readonly unknown[]).includes(v) ? null : `${key} must be one of ${EFFORT_OPTIONS.join(', ')}`;
    case 'autoFold':
      return typeof v === 'boolean' ? null : 'autoFold must be true or false';
    case 'foldQuietMin':
      return (FOLD_QUIET_OPTIONS as readonly unknown[]).includes(v) ? null : `foldQuietMin must be one of ${FOLD_QUIET_OPTIONS.join(', ')}`;
  }
}

/** Env / built-in fallbacks — what each key resolves to when settings.json lacks it. */
function settingDefaults() {
  const lightModel = process.env.MEALAPP_LIGHT_MODEL || 'claude-sonnet-5';
  return {
    planModel: process.env.MEALAPP_MODEL || 'claude-fable-5',
    lightModel,
    // the sous-chef follows the EFFECTIVE light model unless env pins it
    cookModel: process.env.MEALAPP_COOK_MODEL || settings.lightModel || lightModel,
    planEffort: null as Effort | null,  // null = don't pass effort; the model's own default
    lightEffort: null as Effort | null,
    cookEffort: null as Effort | null,
    autoFold: (process.env.MEALAPP_AUTOFOLD || 'on') !== 'off',
    foldQuietMin: 15,
  };
}

function effectiveSettings() {
  const d = settingDefaults();
  return {
    planModel: settings.planModel ?? d.planModel,
    lightModel: settings.lightModel ?? d.lightModel,
    cookModel: settings.cookModel ?? d.cookModel,
    planEffort: settings.planEffort ?? d.planEffort,
    lightEffort: settings.lightEffort ?? d.lightEffort,
    cookEffort: settings.cookEffort ?? d.cookEffort,
    autoFold: settings.autoFold ?? d.autoFold,
    foldQuietMin: settings.foldQuietMin ?? d.foldQuietMin,
  };
}

const autoFoldOn = () => effectiveSettings().autoFold;
const foldDebounceMs = () => effectiveSettings().foldQuietMin * 60_000;
/** Model + optional effort for a run type or the cook chat, resolved now. */
function modelFor(kind: 'plan' | 'light' | 'cook'): Pick<Options, 'model' | 'effort'> {
  const e = effectiveSettings();
  const model = kind === 'plan' ? e.planModel : kind === 'light' ? e.lightModel : e.cookModel;
  const effort = kind === 'plan' ? e.planEffort : kind === 'light' ? e.lightEffort : e.cookEffort;
  return effort ? { model, effort } : { model };
}

// ---------- passcode gate ----------
// GETs and captures stay open; run triggers, stop, and deletes require the
// shared passcode. Configured in app/data/passcode.txt (gitignored) or
// MEALAPP_PASSCODE; with neither the gate is off (set one during install —
// see README.md). Read per-request so rotating the file needs no restart.
const passcodeFile = path.join(dataDir, 'passcode.txt');

async function configuredPasscode(): Promise<string | null> {
  const env = process.env.MEALAPP_PASSCODE?.trim();
  if (env) return env;
  try { return (await fs.readFile(passcodeFile, 'utf8')).trim() || null; } catch { return null; }
}

async function requirePasscode(req: express.Request, res: express.Response, next: express.NextFunction) {
  const want = await configuredPasscode();
  if (!want) return next();
  const got = String(req.get('x-mealapp-passcode') ?? '');
  const a = createHash('sha256').update(got).digest();
  const b = createHash('sha256').update(want).digest();
  if (timingSafeEqual(a, b)) return next();
  res.status(401).json({ error: 'This needs the passcode — you’ll be asked once per device.' });
}

// ---------- rate limits + attribution ----------
// Captures are open to anyone who can reach the app (tailnet/LAN reachability
// is the identity). Contained by per-device rate limits; writes are attributed
// by asking tailscaled who owns the source IP.
const TS_CLI = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
const CAPTURES_PER_MIN = 12; // ratings, notes, feedback, extras
const CHECKS_PER_MIN = 90;   // checkbox toggles — a big shop is many taps

const recentHits = new Map<string, number[]>();
function allowHit(bucket: string, ip: string, perMin: number): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const times = (recentHits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= perMin) { recentHits.set(key, times); return false; }
  times.push(now);
  recentHits.set(key, times);
  return true;
}

function tailscaleWho(ip: string): Promise<string | undefined> {
  return new Promise((resolve) => {
    const addr = ip.replace(/^::ffff:/, '');
    if (!/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)) return resolve(undefined);
    execFile(TS_CLI, ['whois', '--json', addr], { timeout: 2000 }, (err, stdout) => {
      if (err) return resolve(undefined);
      try {
        const j = JSON.parse(stdout) as { UserProfile?: { DisplayName?: string; LoginName?: string } };
        resolve(j.UserProfile?.DisplayName || j.UserProfile?.LoginName || undefined);
      } catch { resolve(undefined); }
    });
  });
}

// ---------- ISO weeks ----------
// All week math on UTC dates that carry the *local* calendar date, so "today"
// means the kitchen's today regardless of the server's TZ offset.

// MEMBERSHIP SET, NOT AN ORDER. Since the Saturday cutover (see the week
// scheme block below) each week carries its own day order, so nothing may
// derive a date offset from an index into DAYS — use weekDays(week) for the
// per-week order and weekDates(week) for the dates. This list is only "is this
// string a day name?" (parser guards, planning-notes regex, feedback
// validation).
export const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'] as const;
export type DayName = (typeof DAYS)[number];

// Week-start-agnostic day-name lookup: index by Date#getUTCDay() (0 = Sunday).
const DOW_NAME = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const satisfies readonly DayName[];

export function todayUTC(): Date {
  const n = new Date();
  return new Date(Date.UTC(n.getFullYear(), n.getMonth(), n.getDate()));
}

export function isoWeekId(d: Date): string {
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const dayNum = (t.getUTCDay() + 6) % 7; // Mon=0
  t.setUTCDate(t.getUTCDate() - dayNum + 3); // ISO week is the week of its Thursday
  const year = t.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((t.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

// The ISO Monday *contained in* the week — the anchor week ids are derived
// from. Since the 2026-08-08 cutover this is no longer the week's first day
// (Saturday-start weeks begin two days earlier); use startOfWeek() for that.
export function mondayOf(weekId: string): Date {
  const m = weekId.match(/^(\d{4})-W(\d{2})$/);
  if (!m) throw new Error(`bad week id: ${weekId}`);
  const jan4 = new Date(Date.UTC(Number(m[1]), 0, 4));
  const w1Monday = new Date(jan4);
  w1Monday.setUTCDate(jan4.getUTCDate() - ((jan4.getUTCDay() + 6) % 7));
  w1Monday.setUTCDate(w1Monday.getUTCDate() + (Number(m[2]) - 1) * 7);
  return w1Monday;
}

// Pure ISO id-sequence arithmetic. Week ids stay consecutive ISO numbers
// across the Saturday cutover (…W32, W33, W34…), so this needs no scheme
// awareness — it only ever walks the id sequence.
export function addWeeks(weekId: string, n: number): string {
  const d = mondayOf(weekId);
  d.setUTCDate(d.getUTCDate() + n * 7);
  return isoWeekId(d);
}

const fmtISO = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (d: Date, n: number): Date => {
  const x = new Date(d);
  x.setUTCDate(x.getUTCDate() + n);
  return x;
};

// ---------- week scheme (the Monday→Saturday cutover) ----------
// THE ONLY PLACE THE CUTOVER EXISTS. Everything above is ISO primitives;
// everything below (and every caller) goes through this layer.
//
// From 2026-08-08 the household's week runs Saturday → Friday, because
// Saturday morning is shopping day and should be day 1 of the week it stocks.
// Week ids keep their shape and their sequence:
//   • id = `YYYY-Wnn` of the ISO week containing the week's Monday, so
//     Sat 2026-08-08 → Fri 2026-08-14 is 2026-W33 (its Monday is Aug 10).
//     For a date d in the Saturday era, Sat+2 and Fri+2 both land inside that
//     Monday's ISO week, hence weekIdForDate's `isoWeekId(d + 2 days)`.
//   • ids stay consecutive, so addWeeks() is untouched.
// Three eras, in this order:
//   2026-W33 and later — Sat…Fri (7 days)
//   2026-W32           — truncated to Mon 08-03 … Fri 08-07 (5 days); the
//                        old Sat/Sun tail was absorbed by W33
//   2026-W31 and older — Mon…Sun (7 days), frozen history
const SAT_ERA_START = '2026-08-08';       // first Saturday-start calendar date
const SAT_ERA_FIRST_WEEK = '2026-W33';    // first Saturday-start week id
const TRUNCATED_WEEK = '2026-W32';        // last Monday-start week, cut to Mon–Fri

// Week-id string comparison is safe throughout: ids are zero-padded and
// year-first, so lexical order is chronological order.
const isSatEra = (weekId: string) => weekId >= SAT_ERA_FIRST_WEEK;

/** The week id a calendar date belongs to, under whichever scheme covers it. */
export function weekIdForDate(d: Date): string {
  return fmtISO(d) >= SAT_ERA_START ? isoWeekId(addDays(d, 2)) : isoWeekId(d);
}

/** The week's days in order, first day first. Length is the week's length. */
export function weekDays(weekId: string): DayName[] {
  if (isSatEra(weekId)) return ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  if (weekId === TRUNCATED_WEEK) return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
  return ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
}

/** First calendar date of the week. */
export function startOfWeek(weekId: string): Date {
  const mon = mondayOf(weekId);
  return isSatEra(weekId) ? addDays(mon, -2) : mon;
}

/** Last calendar date of the week (inclusive). */
export function endOfWeek(weekId: string): Date {
  return addDays(startOfWeek(weekId), weekDays(weekId).length - 1);
}

// Day name → ISO date for one week. Declared as a full Record because every
// caller indexes it by a parsed day name; in practice it is PARTIAL (W32 has
// only 5 keys), and `noUncheckedIndexedAccess` keeps callers honest about that.
export function weekDates(weekId: string): Record<DayName, string> {
  const start = startOfWeek(weekId);
  const out = {} as Record<DayName, string>;
  weekDays(weekId).forEach((day, i) => { out[day] = fmtISO(addDays(start, i)); });
  return out;
}

// Day-of-week labels come from the actual endpoints, so this reads
// "Mon Jul 27 – Sun Aug 2, 2026" for an old week and
// "Sat Aug 8 – Fri Aug 14, 2026" for a Saturday-start one.
export function humanRange(weekId: string): string {
  const a = startOfWeek(weekId);
  const b = endOfWeek(weekId);
  const f = (d: Date) => d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
  return `${DOW_NAME[a.getUTCDay()]} ${f(a)} – ${DOW_NAME[b.getUTCDay()]} ${f(b)}, ${weekId.slice(0, 4)}`;
}

// ---------- keys ----------
// Checkbox keys are week-scoped so stale state can't bleed across weeks, and
// content-hashed so a reworded item is a fresh box.
function slug(text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${base || 'item'}-${(h >>> 0).toString(36)}`;
}

const CHECK_KEY = /^\d{4}-W\d{2}:(prep|shop|extra):[a-z0-9][a-z0-9-]{0,79}$/;

// ---------- plan parsing ----------
// The plan files' structure comes from plans/TEMPLATE.md and is pinned by the
// run prompts; this parser is deliberately tolerant of the small drift the
// selftest fixtures show (missing sections, status prose, '—' cells).

export interface PlanMeal {
  day: DayName;
  mealType: string;
  dish: string;
  recipeFile?: string;
  isNew: boolean;
  favRating?: number;
  timeMin?: number;
  cal?: number;
  protein?: number;
  status: string; // proposed | approved | rejected | cooked | skipped | substituted | —
  flexible: boolean;
}

export interface PrepTask { key: string; label: string; text: string; dueDate?: string }
export interface GroceryItem { key: string; text: string }
export interface GrocerySection { name: string; items: GroceryItem[] }
export interface GroceryStore { name: string; sections: GrocerySection[] }
export interface LogRow { day: DayName; planned: string; cooked: string; rating?: number; notes: string }

export interface ParsedPlan {
  file: string;
  week: string;
  title: string;
  status: 'planning' | 'locked' | 'complete' | 'unknown';
  statusLine: string;
  meals: PlanMeal[];
  whys: Partial<Record<DayName, string>>;
  notes: string[];
  flexNote?: string;
  rejected: string[];
  prep: PrepTask[];
  grocery: { stores: GroceryStore[]; pantryCheck: GroceryItem[]; bulkNotes: string[] };
  hasGrocery: boolean;
  log: LogRow[];
  reviewMd: string;
}

const stripMd = (s: string) => s.replace(/\*\*/g, '').trim();

function parseMealRow(cells: string[], week: string): PlanMeal | null {
  const day = (cells[0] ?? '').trim() as DayName;
  if (!DAYS.includes(day)) return null;
  const mealType = (cells[1] ??'').trim();
  const recipeCell = (cells[2] ?? '').trim();
  if (!recipeCell) return null;
  const link = recipeCell.match(/\[([^\]]+)\]\(\.\.\/recipes\/([^)]+?)\)/);
  const isNew = recipeCell.includes('🆕');
  const fav = recipeCell.match(/⭐\s*(\d(?:\.\d)?)/);
  let dish = link ? link[1]! : recipeCell.replace(/🆕|⭐\s*\d(?:\.\d)?/g, '').trim();
  dish = stripMd(dish);
  const flexible = mealType === '—' || /^flexible\b/i.test(dish);
  const num = (s: string | undefined) => {
    const m = (s ?? '').match(/(\d+)/);
    return m ? Number(m[1]) : undefined;
  };
  return {
    day,
    mealType,
    dish,
    recipeFile: link ? link[2] : undefined,
    isNew,
    favRating: fav ? Number(fav[1]) : undefined,
    timeMin: num(cells[3]),
    cal: num(cells[4]),
    protein: num(cells[5]),
    status: (cells[6] ?? '').trim() || '—',
    flexible,
  };
}

// Prep labels look like "Sun 26, night" / "Thu 30, morning" / "Mon, night".
// Resolve day-of-month within [start of week − 7, end of week] (thaws are
// often due before the week starts); a bare weekday resolves inside the week.
// The alternation below is a membership test — its order is irrelevant.
export function prepDueDate(label: string, week: string): string | undefined {
  const m = label.match(/^(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[a-z]*\s*(\d{1,2})?/i);
  if (!m) return undefined;
  const dayName = (m[1]![0]!.toUpperCase() + m[1]!.slice(1, 3).toLowerCase()) as DayName;
  const dom = m[2] ? Number(m[2]) : undefined;
  const dates = weekDates(week);
  if (dom === undefined) return dates[dayName];
  const start = startOfWeek(week);
  const lastOff = weekDays(week).length - 1;
  for (let off = -7; off <= lastOff; off++) {
    const d = addDays(start, off);
    if (d.getUTCDate() === dom && DOW_NAME[d.getUTCDay()] === dayName) return fmtISO(d);
  }
  return dates[dayName]; // day-of-month didn't resolve; trust the weekday
}

export function parsePlan(raw: string, file: string): ParsedPlan {
  const week = (file.match(/(\d{4}-W\d{2})/) ?? raw.match(/(\d{4}-W\d{2})/))?.[1] ?? '';
  const lines = raw.split('\n');
  const plan: ParsedPlan = {
    file, week,
    title: (lines.find((l) => l.startsWith('# ')) ?? '# ?').slice(2).trim(),
    status: 'unknown', statusLine: '',
    meals: [], whys: {}, notes: [], rejected: [],
    prep: [],
    grocery: { stores: [], pantryCheck: [], bulkNotes: [] },
    hasGrocery: false,
    log: [], reviewMd: '',
  };

  type Zone = 'top' | 'plan' | 'notes' | 'flex' | 'rejected' | 'prep' | 'grocery' | 'log' | 'review';
  let zone: Zone = 'top';
  let store: GroceryStore | null = null;
  let section: GrocerySection | null = null;
  let groceryMode: 'store' | 'pantry' | 'bulk' = 'store';
  const review: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();
    const t = line.trim();

    const status = t.match(/^\*\*Status:\*\*\s*(.+)$/);
    if (status) {
      plan.statusLine = status[1]!.trim();
      const word = plan.statusLine.toLowerCase().match(/^(planning|locked|complete)/);
      plan.status = (word?.[1] as ParsedPlan['status']) ?? 'unknown';
      continue;
    }

    if (t.startsWith('## ')) {
      const h = t.slice(3).toLowerCase();
      zone = h.startsWith('plan') ? 'plan'
        : h.startsWith('prep') ? 'prep'
        : h.startsWith('grocery') ? 'grocery'
        : h.startsWith('log') ? 'log'
        : h.startsWith('week review') ? 'review'
        : 'top';
      continue;
    }
    if (t.startsWith('### ')) {
      const h = t.slice(4).toLowerCase();
      if (h.startsWith('planning notes')) { zone = 'notes'; continue; }
      if (h.startsWith('flexibility')) { zone = 'flex'; continue; }
      if (h.startsWith('rejected')) { zone = 'rejected'; continue; }
      if (zone === 'grocery' || zone === 'top') {
        // store headings live inside the grocery zone
        zone = 'grocery';
        if (h.startsWith('pantry check')) { groceryMode = 'pantry'; continue; }
        if (h.startsWith('bulk notes')) { groceryMode = 'bulk'; continue; }
        groceryMode = 'store';
        store = { name: t.slice(4).trim(), sections: [] };
        section = null;
        plan.grocery.stores.push(store);
        continue;
      }
      continue;
    }

    if (zone === 'review') { review.push(rawLine); continue; }
    if (!t || t.startsWith('<!--')) continue;

    if (zone === 'plan' && t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      if ((cells[0] ?? '').startsWith('---') || (cells[0] ?? '') === 'Day') continue;
      const meal = parseMealRow(cells, week);
      if (meal) plan.meals.push(meal);
      continue;
    }

    if (zone === 'notes' && t.startsWith('- ')) {
      const b = t.slice(2).trim();
      const why = b.match(/^\*\*(Mon|Tue|Wed|Thu|Fri|Sat|Sun)[^*]*\*\*:?\s*(.*)$/);
      if (why) plan.whys[why[1] as DayName] = stripMd(why[2] ?? '');
      else plan.notes.push(b);
      continue;
    }

    if (zone === 'flex') { plan.flexNote = (plan.flexNote ? plan.flexNote + ' ' : '') + t; continue; }
    if (zone === 'rejected' && t.startsWith('- ')) { plan.rejected.push(t.slice(2).trim()); continue; }

    if (zone === 'prep') {
      const m = t.match(/^- \[[ xX]\]\s+(.*)$/);
      if (!m) continue;
      const text = m[1]!.trim();
      const label = text.match(/^\*\*([^*]+?):?\*\*:?/)?.[1]?.replace(/:$/, '') ?? '';
      plan.prep.push({
        key: `${week}:prep:${slug(text)}`,
        label,
        text: stripMd(text.replace(/^\*\*[^*]+\*\*:?\s*/, '')),
        dueDate: label ? prepDueDate(label, week) : undefined,
      });
      continue;
    }

    if (zone === 'grocery') {
      const bold = t.match(/^\*\*([^*]+)\*\*$/);
      if (bold && groceryMode === 'store' && store) {
        section = { name: bold[1]!.trim(), items: [] };
        store.sections.push(section);
        continue;
      }
      const item = t.match(/^- \[[ xX]\]\s+(.*)$/);
      if (item) {
        const text = item[1]!.trim();
        if (/^\.{3}/.test(text)) continue; // TEMPLATE.md placeholder ("- [ ] ..."), not a real item
        const g: GroceryItem = { key: `${week}:shop:${slug(text)}`, text: stripMd(text) };
        if (groceryMode === 'pantry') plan.grocery.pantryCheck.push(g);
        else if (groceryMode === 'store' && store) {
          if (!section) { section = { name: '', items: [] }; store.sections.push(section); }
          section.items.push(g);
        }
        continue;
      }
      if (groceryMode === 'bulk' && (t.startsWith('- ') || t.length))
        plan.grocery.bulkNotes.push(stripMd(t.replace(/^- /, '')));
      continue;
    }

    if (zone === 'log' && t.startsWith('|')) {
      const cells = t.split('|').slice(1, -1).map((c) => c.trim());
      const day = (cells[0] ?? '') as DayName;
      if (!DAYS.includes(day)) continue;
      const ratingM = (cells[3] ?? '').match(/^([1-5])\b/);
      plan.log.push({
        day,
        planned: stripMd(cells[1] ?? ''),
        cooked: stripMd(cells[2] ?? ''),
        rating: ratingM ? Number(ratingM[1]) : undefined,
        notes: cells[4] ?? '',
      });
      continue;
    }
  }

  plan.hasGrocery = plan.grocery.stores.some((s) => s.sections.some((x) => x.items.length));
  plan.reviewMd = review.join('\n').trim();
  return plan;
}

// ---------- recipe parsing ----------
// Enough YAML for the recipe frontmatter this repo actually uses: scalars,
// inline arrays, one level of nested maps, and quoted list items.

export interface RecipeMeta {
  file: string;
  name: string;
  cuisine?: string;
  protein?: string;
  active_time_min?: number;
  total_time_min?: number;
  servings?: number;
  rating?: number;
  times_cooked?: number;
  last_cooked?: string;
  cadence?: string;
  nutrition?: Partial<Record<'calories' | 'protein_g' | 'carbs_g' | 'fat_g' | 'fiber_g', number>>;
  prep_ahead: string[];
}

export function parseRecipe(raw: string, file: string): { meta: RecipeMeta; body: string } {
  const meta: RecipeMeta = { file, name: file.replace(/\.md$/, ''), prep_ahead: [] };
  if (!raw.startsWith('---')) return { meta, body: raw };
  const end = raw.indexOf('\n---', 3);
  if (end === -1) return { meta, body: raw };
  const head = raw.slice(4, end).split('\n');
  const body = raw.slice(raw.indexOf('\n', end + 1) + 1);

  let block: 'nutrition' | 'prep' | null = null;
  const unquote = (s: string) => s.replace(/^["']|["']$/g, '');
  for (const line of head) {
    const indented = /^\s/.test(line);
    const t = line.trim();
    if (!t) continue;
    if (indented && block === 'nutrition') {
      const m = t.match(/^([a-z_]+):\s*(.+)$/);
      if (m) {
        meta.nutrition = meta.nutrition ?? {};
        const v = Number(m[2]);
        if (!Number.isNaN(v)) (meta.nutrition as Record<string, number>)[m[1]!] = v;
      }
      continue;
    }
    if (indented && block === 'prep' && t.startsWith('- ')) {
      meta.prep_ahead.push(unquote(t.slice(2).trim()));
      continue;
    }
    block = null;
    const kv = t.match(/^([A-Za-z_]+):\s*(.*)$/);
    if (!kv) continue;
    const [, k, vRaw] = kv;
    const v = (vRaw ?? '').trim();
    if (k === 'nutrition_per_serving') { block = 'nutrition'; continue; }
    if (k === 'prep_ahead') { block = 'prep'; continue; }
    if (!v || v === 'null' || v === '~') continue; // YAML null → absent, not the string "null"
    switch (k) {
      case 'name': meta.name = v; break;
      case 'cuisine': meta.cuisine = v; break;
      case 'protein': meta.protein = v; break;
      case 'cadence': meta.cadence = v; break;
      case 'last_cooked': meta.last_cooked = v; break;
      case 'active_time_min': case 'total_time_min': case 'servings': case 'times_cooked': {
        const n = Number(v);
        if (!Number.isNaN(n)) (meta as unknown as Record<string, number>)[k!] = n;
        break;
      }
      case 'rating': {
        const n = Number(v);
        if (!Number.isNaN(n)) meta.rating = n;
        break;
      }
      default: break;
    }
  }
  return { meta, body };
}

const SAFE_FILE = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

// ---------- repo readers ----------

async function readAllPlans(): Promise<Map<string, ParsedPlan>> {
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

async function readRecipes(): Promise<RecipeMeta[]> {
  let files: string[] = [];
  try { files = (await fs.readdir(recipesDir)).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return []; }
  const out: RecipeMeta[] = [];
  for (const file of files) {
    try { out.push(parseRecipe(await fs.readFile(path.join(recipesDir, file), 'utf8'), file).meta); }
    catch { /* skip unreadable */ }
  }
  return out;
}

// ---------- app state (gitignored JSON) ----------

interface Capture {
  date: string; // ISO date, keys the entry — deliberately not week-scoped
  dish?: string;
  rating?: number;
  note?: string;
  by?: string;
  at: number;
  foldedAt?: number;
}
interface CheckMark { by?: string; at: number }
interface MealDecision { decision: 'approve' | 'reject' | 'swap'; note?: string; by?: string; at: number }
interface WeekFeedback { meals: Partial<Record<DayName, MealDecision>>; weekNote?: { text: string; by?: string; at: number } }
interface ExtraItem { id: string; text: string; by?: string; at: number }

let captures: Record<string, Capture> = {};
let checks: Record<string, CheckMark> = {};
let feedback: Record<string, WeekFeedback> = {};
let extras: Record<string, ExtraItem[]> = {};
let runStats: Partial<Record<RunType, number[]>> = {};

const storeFile = (name: string) => path.join(dataDir, name);
async function loadJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(storeFile(name), 'utf8')) as T; } catch { return fallback; }
}
async function saveJson(name: string, value: unknown) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(storeFile(name), JSON.stringify(value, null, 2));
}

const saveCaptures = () => saveJson('captures.json', captures);
const saveChecks = () => saveJson('checks.json', checks);
const saveFeedback = () => saveJson('plan-feedback.json', feedback);
const saveExtras = () => saveJson('extras.json', extras);
const saveRunStats = () => saveJson('runstats.json', runStats);

const pendingCaptures = () => Object.values(captures).filter((c) => !c.foldedAt);

function typicalMs(type: RunType): number | null {
  const arr = runStats[type] ?? [];
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}
async function recordDuration(type: RunType, ms: number) {
  runStats[type] = [...(runStats[type] ?? []).slice(-19), ms];
  await saveRunStats();
}

// ---------- ws hub ----------

const clients = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}

// ---------- claude bridge ----------

type RunType = 'propose' | 'revise' | 'lock' | 'fold' | 'shop-adjust' | 'review';

type RunEvent =
  | { kind: 'status'; text: string }
  | { kind: 'activity'; text: string }
  | { kind: 'error'; text: string }
  | { kind: 'done'; ok: boolean; summaryHtml: string; durationMs: number };

interface Run {
  type: RunType;
  week: string;
  startedAt: number;
  events: RunEvent[];
  abort: AbortController;
}

let run: Run | null = null;
let lastResult: { type: RunType; week: string; ok: boolean; summaryHtml: string; at: number } | null = null;

const clip = (s: string, n = 110) => (s.length > n ? s.slice(0, n - 1) + '…' : s);
const rel = (p: string) => path.relative(repoRoot, path.resolve(repoRoot, p)) || '.';

function activityLabel(tool: string, input: Record<string, unknown>): string | null {
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

// Everything a run is allowed to do, as permission RULES the CLI enforces
// in-process. canUseTool below covers the same ground, but it rides the SDK's
// bidirectional control channel, which some CLI builds close mid-session —
// every Bash call then dies with a permission-prompt "Stream closed" error
// while acceptEdits keeps edits working (seen 2026-08: fold runs edited files
// but couldn't commit). Rules don't need the channel, so git keeps working
// even on an affected build; canUseTool stays as the deny-by-default backstop.
const RUN_ALLOWED_TOOLS = [
  'Read', 'Grep', 'Glob',
  'WebSearch', 'WebFetch',
  'Skill', 'TodoWrite', 'Task',
  ...GIT_VERBS.flatMap((v) => [`Bash(git ${v})`, `Bash(git ${v}:*)`]),
];

function canUseTool() {
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
        if (GIT_OK.test(cmd) && !SHELL_META.test(cmd)) return allow;
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
Your FINAL message must be a short markdown summary for the app to display — a few sentences or bullets, no preamble, no code fences around the whole message.`;

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

async function buildPrompt(type: RunType, week: string, note: string): Promise<string> {
  const template = await fs.readFile(path.join(promptsDir, `${type}.md`), 'utf8');
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
    ? JSON.stringify(pend.map(({ date, dish, rating, note: n, by }) => ({ date, dish, rating, note: n, by })), null, 2)
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
    .replaceAll('{{ROUTING}}', routing);
}

function runPublic() {
  return {
    active: !!run,
    type: run?.type ?? null,
    week: run?.week ?? null,
    startedAt: run?.startedAt ?? null,
    typicalMs: run ? typicalMs(run.type) : null,
    lastResult,
  };
}

async function startRun(type: RunType, week: string, note = '') {
  const abort = new AbortController();
  run = { type, week, startedAt: Date.now(), events: [], abort };
  const pushEvent = (ev: RunEvent) => { run?.events.push(ev); broadcast({ type: 'event', ev }); };
  broadcast({ type: 'run-state', run: runPublic() });
  pushEvent({ kind: 'status', text: `${type} run started${week ? ` for ${week}` : ''}` });

  // Entries pending when the run starts get stamped foldedAt on success; a
  // capture edited mid-run keeps its newer `at` and stays pending.
  const foldSnapshot = (type === 'fold' || type === 'review')
    ? pendingCaptures().map((c) => ({ date: c.date, at: c.at }))
    : [];

  const options: Options = {
    cwd: repoRoot,
    abortController: abort,
    permissionMode: 'acceptEdits',
    allowedTools: RUN_ALLOWED_TOOLS,
    canUseTool: canUseTool(),
    settingSources: ['project'],
    systemPrompt: { type: 'preset', preset: 'claude_code', append: SYSTEM_APPEND },
    maxTurns: type === 'fold' ? 50 : type === 'shop-adjust' ? 40 : 120,
    // resolved once, here: settings changes mid-run apply to the next run
    ...modelFor(type === 'fold' || type === 'shop-adjust' ? 'light' : 'plan'),
  };

  let summaryMd = '';
  let isError = false;
  const started = Date.now();
  let durationMs = 0;

  try {
    const prompt = await buildPrompt(type, week, note);
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
  } catch (err) {
    isError = true;
    const message = err instanceof Error ? err.message : String(err);
    summaryMd = abort.signal.aborted ? 'Stopped by user.' : `Claude error: ${message}`;
    if (/401|invalid.*credential|authenticat/i.test(message)) {
      summaryMd = 'Claude authentication failed. Run `claude` in a terminal on the Mac, complete /login once, then try again.';
    }
  }
  if (!durationMs) durationMs = Date.now() - started;

  if (isError) {
    pushEvent({ kind: 'error', text: summaryMd });
    lastResult = { type, week, ok: false, summaryHtml: String(marked.parse(summaryMd)), at: Date.now() };
  } else {
    const summaryHtml = String(marked.parse(summaryMd));
    lastResult = { type, week, ok: true, summaryHtml, at: Date.now() };
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

  run = null;
  broadcast({ type: 'run-state', run: runPublic() });
  broadcast({ type: 'state-updated' });
}

// ---------- auto-fold ----------
// Captures land instantly in captures.json; a cheap fold run writes them into
// the plan files' Log tables once things have been quiet for a while. Never
// fires while another run is active. Toggle + quiet delay are settings
// (gear panel; MEALAPP_AUTOFOLD=off is the env fallback).

let lastCaptureAt = 0;
const AUTOFOLD_TICK_MS = 60_000;

// Started from boot() — module level would leak a timer into the selftest.
function startAutoFold() {
  setInterval(() => {
    if (!autoFoldOn() || run) return;
    if (!pendingCaptures().length) return;
    if (!lastCaptureAt || Date.now() - lastCaptureAt < foldDebounceMs()) return;
    void startRun('fold', '');
  }, AUTOFOLD_TICK_MS);
}

// ---------- git ----------
// Phone/desktop Claude sessions push to GitHub; pull (throttled, never during
// a run — the agent owns git then) so their changes appear here.

let lastPull = 0;
// Outcome of the most recent pull (boot or throttled), for the Status panel.
let lastPullResult: { at: number; ok: boolean; message: string } | null = null;
function recordPull(err: Error | null, stdout: string, stderr: string) {
  const out = (stdout || '').trim();
  lastPullResult = err
    ? { at: Date.now(), ok: false, message: ((stderr || '').trim() || err.message).split('\n').slice(0, 3).join(' ').slice(0, 300) }
    : { at: Date.now(), ok: true, message: out.split('\n')[0] || 'ok' };
}
function pullIfStale(): Promise<void> {
  if (run || Date.now() - lastPull < 60_000) return Promise.resolve();
  lastPull = Date.now();
  return new Promise((resolve) => {
    execFile('git', ['pull', '--ff-only'], { cwd: repoRoot }, (err, stdout, stderr) => {
      recordPull(err, String(stdout), String(stderr));
      resolve();
    });
  });
}

// ---------- state assembly ----------

function carryEntries(prevPlan: ParsedPlan | null, today: string) {
  if (!prevPlan) return [];
  const dates = weekDates(prevPlan.week);
  // show stragglers for 3 days after the week ends
  const cutoff = addDays(endOfWeek(prevPlan.week), 3);
  if (today > fmtISO(cutoff)) return [];
  const logged = new Map(prevPlan.log.map((l) => [l.day, l]));
  return prevPlan.meals
    .filter((m) => !m.flexible)
    .filter((m) => !!dates[m.day]) // a row on a day the week doesn't have (drifted file) has no date to show
    .filter((m) => {
      const l = logged.get(m.day);
      return !(l && (l.rating !== undefined || (l.cooked && l.cooked !== '')));
    })
    .map((m) => ({ date: dates[m.day]!, day: m.day, week: prevPlan.week, dish: m.dish, recipeFile: m.recipeFile }));
}

function mealApproved(plan: ParsedPlan, fb: WeekFeedback | undefined, m: PlanMeal): boolean {
  if (m.flexible) return true;
  if (m.status === 'approved') return true;
  return fb?.meals[m.day]?.decision === 'approve';
}

// The week the Next tab plans and the propose route targets. Normally next
// week — but when the current week itself has no usable plan (no file, or one
// still in planning) the week to plan IS the current one. Without that, the
// Saturday cutover would show cooking = last week's fallback and ahead = the
// week after next, skipping the unplanned current week entirely. Shared by
// buildState and POST /api/runs/propose so there is only one derivation.
function aheadWeekIdFor(plans: Map<string, ParsedPlan>, curId: string): string {
  const cur = plans.get(curId);
  return (!cur || cur.status === 'planning') ? curId : addWeeks(curId, 1);
}

async function buildState() {
  await pullIfStale();
  const plans = await readAllPlans();
  const t = todayUTC();
  const today = fmtISO(t);
  const curId = weekIdForDate(t);
  const nextId = aheadWeekIdFor(plans, curId);

  let cooking = plans.get(curId) ?? null;
  let fallback = false;
  if (!cooking || cooking.status === 'planning') {
    const candidates = [...plans.keys()].filter((w) => w < curId && plans.get(w)!.status !== 'planning').sort();
    const latest = candidates[candidates.length - 1];
    if (latest) { cooking = plans.get(latest)!; fallback = true; }
  }
  const cookingWeek = cooking?.week ?? curId;
  const prevPlan = plans.get(addWeeks(cookingWeek, -1)) ?? null;
  const ahead = plans.get(nextId) ?? null;

  const fb = feedback[nextId];
  const aheadApproval = ahead
    ? ahead.meals.filter((m) => !m.flexible).map((m) => ({ day: m.day, approved: mealApproved(ahead, fb, m) }))
    : [];

  // close-out readiness: every planned night rated, in the file or in captures.
  // A row on a day the week doesn't contain (a drifted file — e.g. a Sat/Sun
  // row left in the truncated 2026-W32) is skipped: it has no date, so the UI
  // can't card it and the user can't rate it — counting it would deadlock
  // close-out with no way out from the app.
  const cookDates = cooking ? weekDates(cooking.week) : null;
  const missing = cooking
    ? cooking.meals.filter((m) => !m.flexible).filter((m) => !!cookDates![m.day]).filter((m) => {
        const l = cooking.log.find((x) => x.day === m.day);
        if (l && (l.rating !== undefined || (l.cooked && l.cooked !== ''))) return false;
        const c = captures[cookDates![m.day]!];
        return !(c && (c.rating !== undefined || c.dish));
      }).map((m) => m.day)
    : [];

  // Shop tab targeting. Normally the ahead week's list. But once weeks start on
  // shopping day, Saturday morning's live list belongs to the week being cooked
  // (locked the night before) while `ahead` has already rolled to the next one —
  // so fall back to the cooking week's list when it is a Saturday-era week and
  // ahead has none. Failing both, show ahead's empty state. Checkbox keys ride
  // along inside the parsed plan, so they are already scoped to whichever week
  // this picks.
  // A plan still in planning never owns the Shop tab — its list is built at
  // lock, so anything grocery-shaped before that is skeleton or drift.
  const shopPlan = (ahead?.hasGrocery && ahead.status !== 'planning') ? ahead
    : (cooking?.hasGrocery && isSatEra(cooking.week)) ? cooking
    : (ahead ?? null);
  const shopWeek = shopPlan?.week ?? nextId;

  return {
    now: Date.now(),
    today,
    passcodeGate: !!(await configuredPasscode()),
    autoFold: autoFoldOn(),
    run: runPublic(),
    typical: Object.fromEntries((['propose', 'revise', 'lock', 'fold', 'shop-adjust', 'review'] as RunType[])
      .map((k) => [k, typicalMs(k)])),
    cooking: cooking ? {
      week: cooking.week, dates: weekDates(cooking.week), fallback,
      plan: cooking, closeReady: cooking.status === 'locked' && missing.length === 0, missing,
    } : null,
    currentWeekId: curId,
    aheadWeekId: nextId,
    ahead: ahead ? { week: ahead.week, dates: weekDates(ahead.week), plan: ahead, approval: aheadApproval } : null,
    // The Shop tab renders exactly this — which week's list is live, whether
    // that week is planned at all, and the list itself. The client does no
    // week picking of its own. (Extras stay keyed to aheadWeekId above:
    // they're "for the next plan", consumed by the lock run.)
    shop: {
      week: shopWeek,                                              // list + checkbox scope
      planned: !!shopPlan,                                         // is that week planned at all?
      grocery: shopPlan?.hasGrocery ? shopPlan.grocery : null,     // null → render the empty state
    },
    carry: carryEntries(prevPlan, today),
    captures,
    checks,
    feedback: fb ?? null,
    extras: extras[nextId] ?? [],
  };
}

// ---------- http ----------

const app = express();
app.use(express.json());
// no-cache = revalidate every load (ETag 304s keep it cheap); a phone must
// never run yesterday's app.js against today's state shape.
app.use(express.static(path.join(appDir, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

app.get('/api/state', async (_req, res) => {
  try { res.json(await buildState()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/recipes', async (_req, res) => {
  try {
    await pullIfStale();
    res.json({ recipes: await readRecipes() });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/recipes/entry', async (req, res) => {
  const f = String(req.query.f ?? '');
  if (!SAFE_FILE.test(f)) return res.status(400).json({ error: 'bad filename' });
  try {
    const { meta, body } = parseRecipe(await fs.readFile(path.join(recipesDir, f), 'utf8'), f);
    res.json({ meta, html: String(marked.parse(body)) });
  } catch { res.status(404).json({ error: 'not found' }); }
});

app.get('/api/plans', async (_req, res) => {
  try {
    const plans = await readAllPlans();
    const list = [...plans.values()]
      .sort((a, b) => b.week.localeCompare(a.week))
      .map((p) => ({ file: p.file, week: p.week, title: p.title, status: p.status }));
    res.json({ plans: list });
  } catch (err) { res.status(500).json({ error: String(err) }); }
});

app.get('/api/plans/entry', async (req, res) => {
  const f = String(req.query.f ?? '');
  if (!SAFE_FILE.test(f)) return res.status(400).json({ error: 'bad filename' });
  try {
    const raw = await fs.readFile(path.join(plansDir, f), 'utf8');
    res.json({ html: String(marked.parse(raw)) });
  } catch { res.status(404).json({ error: 'not found' }); }
});

// --- captures (open, rate-limited, attributed) ---

app.post('/api/log', async (req, res) => {
  const date = String(req.body?.date ?? '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
  const ip = String(req.socket.remoteAddress ?? '');
  if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} updates per minute, tops.` });

  const prev = captures[date];
  const entry: Capture = prev ? { ...prev } : { date, at: 0 };
  if ('rating' in (req.body ?? {})) {
    const r = req.body.rating;
    if (r === null) delete entry.rating;
    else if (Number.isInteger(r) && r >= 1 && r <= 5) entry.rating = r;
    else return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
  }
  if ('note' in (req.body ?? {})) {
    const n = String(req.body.note ?? '').trim();
    if (n.length > 600) return res.status(400).json({ error: 'Keep notes under 600 characters.' });
    if (n) entry.note = n; else delete entry.note;
  }
  if ('dish' in (req.body ?? {})) {
    const d = String(req.body.dish ?? '').trim();
    if (d.length > 200) return res.status(400).json({ error: 'Keep that under 200 characters.' });
    if (d) entry.dish = d; else delete entry.dish;
  }
  if (entry.rating === undefined && !entry.note && !entry.dish) {
    delete captures[date]; // everything cleared → drop the entry
  } else {
    entry.at = Date.now();
    delete entry.foldedAt; // edits re-open the entry for the next fold
    entry.by = (await tailscaleWho(ip)) ?? entry.by;
    captures[date] = entry;
  }
  lastCaptureAt = Date.now();
  await saveCaptures();
  broadcast({ type: 'capture', date, entry: captures[date] ?? null });
  res.json({ ok: true, entry: captures[date] ?? null });
});

app.post('/api/check', async (req, res) => {
  const key = String(req.body?.key ?? '');
  const done = !!req.body?.done;
  if (!CHECK_KEY.test(key)) return res.status(400).json({ error: 'bad key' });
  const ip = String(req.socket.remoteAddress ?? '');
  if (!allowHit('chk', ip, CHECKS_PER_MIN)) return res.status(429).json({ error: 'Too many taps — give it a minute.' });
  if (done) checks[key] = { by: await tailscaleWho(ip), at: Date.now() };
  else delete checks[key];
  await saveChecks();
  broadcast({ type: 'check', key, done, by: checks[key]?.by });
  res.json({ ok: true });
});

app.post('/api/feedback', async (req, res) => {
  const week = String(req.body?.week ?? '');
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  const ip = String(req.socket.remoteAddress ?? '');
  if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} updates per minute, tops.` });
  const by = await tailscaleWho(ip);
  const fb: WeekFeedback = feedback[week] ?? { meals: {} };

  if ('weekNote' in (req.body ?? {})) {
    const text = String(req.body.weekNote ?? '').trim();
    if (text.length > 1000) return res.status(400).json({ error: 'Keep the note under 1000 characters.' });
    if (text) fb.weekNote = { text, by, at: Date.now() };
    else delete fb.weekNote;
  }
  const day = req.body?.day as DayName | undefined;
  if (day !== undefined) {
    if (!DAYS.includes(day)) return res.status(400).json({ error: 'bad day' });
    const decision = String(req.body?.decision ?? '');
    const note = String(req.body?.note ?? '').trim().slice(0, 500);
    if (decision === 'clear') delete fb.meals[day];
    else if (decision === 'approve' || decision === 'reject' || decision === 'swap') {
      if (decision !== 'approve' && !note) {
        return res.status(400).json({ error: decision === 'reject' ? 'Give a reason — rejections teach the planner.' : 'Say what you want instead.' });
      }
      fb.meals[day] = { decision, note: note || undefined, by, at: Date.now() };
    } else return res.status(400).json({ error: 'bad decision' });
  }
  if (!fb.weekNote && !Object.keys(fb.meals).length) delete feedback[week];
  else feedback[week] = fb;
  await saveFeedback();
  broadcast({ type: 'feedback', week, feedback: feedback[week] ?? null });
  res.json({ ok: true, feedback: feedback[week] ?? null });
});

app.post('/api/extras', async (req, res) => {
  const week = String(req.body?.week ?? '');
  const text = String(req.body?.text ?? '').trim();
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  if (!text) return res.status(400).json({ error: 'Type an item first.' });
  if (text.length > 200) return res.status(400).json({ error: 'Keep items under 200 characters.' });
  const ip = String(req.socket.remoteAddress ?? '');
  if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} adds per minute, tops.` });
  const list = extras[week] ?? [];
  if (list.length >= 30) return res.status(429).json({ error: 'That’s a lot of extras — fold some into the plan first.' });
  const item: ExtraItem = { id: Math.random().toString(36).slice(2, 10), text, by: await tailscaleWho(ip), at: Date.now() };
  extras[week] = [...list, item];
  await saveExtras();
  broadcast({ type: 'state-updated' });
  res.json({ ok: true, item });
});

app.delete('/api/extras/:week/:id', requirePasscode, async (req, res) => {
  const week = String(req.params.week);
  const before = extras[week]?.length ?? 0;
  extras[week] = (extras[week] ?? []).filter((e) => e.id !== req.params.id);
  if (extras[week]!.length === before) return res.status(404).json({ error: 'No such item.' });
  if (!extras[week]!.length) delete extras[week];
  await saveExtras();
  broadcast({ type: 'state-updated' });
  res.json({ ok: true });
});

app.delete('/api/log/:date', requirePasscode, async (req, res) => {
  const date = String(req.params.date);
  if (!captures[date]) return res.status(404).json({ error: 'No capture for that date.' });
  delete captures[date];
  await saveCaptures();
  broadcast({ type: 'capture', date, entry: null });
  res.json({ ok: true });
});

// --- runs (passcode) ---

function guardNoRun(res: express.Response): boolean {
  if (run) { res.status(409).json({ error: `A ${run.type} run is already in progress.` }); return false; }
  return true;
}

app.post('/api/runs/propose', requirePasscode, async (req, res) => {
  if (!guardNoRun(res)) return;
  const plans = await readAllPlans();
  // Same derivation buildState uses, so the default here can never disagree
  // with the week the Next tab is showing.
  const week = String(req.body?.week ?? aheadWeekIdFor(plans, weekIdForDate(todayUTC())));
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  if (plans.has(week)) return res.status(409).json({ error: `${week} already has a plan file — use revise.` });
  void startRun('propose', week, String(req.body?.note ?? ''));
  res.json({ ok: true });
});

app.post('/api/runs/revise', requirePasscode, async (req, res) => {
  if (!guardNoRun(res)) return;
  const week = String(req.body?.week ?? '');
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  const plans = await readAllPlans();
  const plan = plans.get(week);
  if (!plan) return res.status(404).json({ error: `No plan file for ${week} yet — propose first.` });
  const note = String(req.body?.note ?? '').trim();
  const fb = feedback[week];
  const hasFeedback = !!fb && (Object.keys(fb.meals).length > 0 || !!fb.weekNote);
  if (!hasFeedback && !note) return res.status(400).json({ error: 'Nothing to send — mark some meals or write a note first.' });
  void startRun('revise', week, note);
  res.json({ ok: true });
});

app.post('/api/runs/lock', requirePasscode, async (req, res) => {
  if (!guardNoRun(res)) return;
  const week = String(req.body?.week ?? '');
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  const plans = await readAllPlans();
  const plan = plans.get(week);
  if (!plan) return res.status(404).json({ error: `No plan file for ${week}.` });
  if (plan.status !== 'planning') return res.status(409).json({ error: `${week} is ${plan.status}, not in planning.` });
  const fb = feedback[week];
  const unapproved = plan.meals.filter((m) => !mealApproved(plan, fb, m)).map((m) => m.day);
  if (unapproved.length) return res.status(400).json({ error: `Not everything is approved yet: ${unapproved.join(', ')}.` });
  void startRun('lock', week);
  res.json({ ok: true });
});

app.post('/api/runs/fold', requirePasscode, (_req, res) => {
  if (!guardNoRun(res)) return;
  if (!pendingCaptures().length) return res.status(400).json({ error: 'Nothing pending — every capture is already in the record.' });
  void startRun('fold', '');
  res.json({ ok: true });
});

app.post('/api/runs/shop-adjust', requirePasscode, async (req, res) => {
  if (!guardNoRun(res)) return;
  const week = String(req.body?.week ?? '');
  const note = String(req.body?.note ?? '').trim();
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  if (!note) return res.status(400).json({ error: 'Say what to change.' });
  const plans = await readAllPlans();
  const plan = plans.get(week);
  if (!plan || plan.status === 'planning') return res.status(409).json({ error: `${week} isn’t locked yet.` });
  void startRun('shop-adjust', week, note);
  res.json({ ok: true });
});

app.post('/api/runs/review', requirePasscode, async (req, res) => {
  if (!guardNoRun(res)) return;
  const state = await buildState();
  const week = String(req.body?.week ?? state.cooking?.week ?? '');
  if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
  if (state.cooking?.week === week) {
    if (state.cooking.plan.status !== 'locked') return res.status(409).json({ error: `${week} is ${state.cooking.plan.status} — nothing to close.` });
    if (!state.cooking.closeReady) return res.status(400).json({ error: `Still unlogged: ${state.cooking.missing.join(', ')}. Rate those nights first.` });
  }
  void startRun('review', week);
  res.json({ ok: true });
});

app.post('/api/stop', requirePasscode, (_req, res) => {
  if (!run) return res.status(409).json({ error: 'No active run.' });
  run.abort.abort();
  res.json({ ok: true });
});

app.get('/api/run', (_req, res) => {
  res.json({ ...runPublic(), events: run?.events ?? [] });
});

// --- settings (GET open; PUT passcode + rate limit) ---
// app/data/settings.json holds only the keys someone changed; absent = env /
// built-in fallback. `null` in a PUT deletes the key (reset to default).

function sanitizeSettings(raw: unknown): Settings {
  const out: Record<string, unknown> = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  for (const [k, v] of Object.entries(raw)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) { console.log(`[mealapp] settings.json: ignoring unknown key ${k}`); continue; }
    const err = settingError(k as SettingKey, v);
    if (err) { console.log(`[mealapp] settings.json: ignoring ${k} (${err})`); continue; }
    out[k] = v;
  }
  return out as Settings;
}

async function saveSettings() {
  await fs.mkdir(dataDir, { recursive: true });
  const file = storeFile('settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n');
  await fs.rename(tmp, file); // atomic on the same filesystem
}

let sdkVersion: string | null = null;
async function readSdkVersion(): Promise<string> {
  if (sdkVersion) return sdkVersion;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(appDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { version?: string };
    sdkVersion = pkg.version ?? 'unknown';
  } catch { sdkVersion = 'unknown'; }
  return sdkVersion;
}

function gitHead(): Promise<{ sha: string; subject: string; at: string } | null> {
  return new Promise((resolve) => {
    execFile('git', ['log', '-1', '--format=%h%x1f%s%x1f%cI'], { cwd: repoRoot, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const [sha = '', subject = '', at = ''] = String(stdout).trim().split('\x1f');
      resolve({ sha, subject, at });
    });
  });
}

async function settingsPayload() {
  const pend = pendingCaptures();
  const eff = effectiveSettings();
  // The tick fires once a minute, so the fold lands within a minute after this.
  const nextFoldAt = eff.autoFold && pend.length && lastCaptureAt ? lastCaptureAt + foldDebounceMs() : null;
  return {
    values: eff,
    stored: settings,
    defaults: settingDefaults(),
    options: { models: MODEL_OPTIONS, efforts: EFFORT_OPTIONS, foldQuietMin: FOLD_QUIET_OPTIONS },
    status: {
      passcodeGate: !!(await configuredPasscode()),
      startedAt: SERVER_STARTED_AT,
      uptimeMs: Date.now() - SERVER_STARTED_AT,
      git: await gitHead(),
      sdkVersion: await readSdkVersion(),
      node: process.version,
      lastPull: lastPullResult,
      pendingCaptures: pend.length,
      autoFold: {
        on: eff.autoFold,
        nextEligibleAt: nextFoldAt,
        // pending entries but no capture since boot: the debounce has no anchor,
        // so auto-fold waits for the next capture (or a manual Sync now)
        waitingForCapture: eff.autoFold && pend.length > 0 && !lastCaptureAt,
      },
      run: { active: !!run, type: run?.type ?? null, startedAt: run?.startedAt ?? null },
      typicalMs: Object.fromEntries((['propose', 'revise', 'lock', 'fold', 'shop-adjust', 'review'] as RunType[])
        .map((k) => [k, typicalMs(k)])),
    },
  };
}

app.get('/api/settings', async (_req, res) => {
  try { res.json(await settingsPayload()); }
  catch (err) { res.status(500).json({ error: String(err) }); }
});

const SETTINGS_PER_MIN = 20;
function settingsRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = String(req.socket.remoteAddress ?? '');
  if (!allowHit('settings', ip, SETTINGS_PER_MIN)) return res.status(429).json({ error: `Easy there — ${SETTINGS_PER_MIN} settings changes per minute, tops.` });
  next();
}

app.put('/api/settings', settingsRateLimit, requirePasscode, async (req, res) => {
  const body: unknown = req.body;
  if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Send a JSON object of settings.' });
  const patch = body as Record<string, unknown>;
  for (const [k, v] of Object.entries(patch)) {
    if (!(SETTING_KEYS as readonly string[]).includes(k)) return res.status(400).json({ error: `Unknown setting: ${k}` });
    if (v === null) continue;
    const err = settingError(k as SettingKey, v);
    if (err) return res.status(400).json({ error: err });
  }
  // An empty PUT is a no-op that still proves the passcode — the panel uses
  // it to check a passcode before storing it on a device.
  if (!Object.keys(patch).length) return res.json(await settingsPayload());

  const next: Record<string, unknown> = { ...settings };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) delete next[k]; else next[k] = v;
  }
  settings = next as Settings;
  try { await saveSettings(); }
  catch (err) { return res.status(500).json({ error: `Could not save settings: ${String(err)}` }); }
  const ip = String(req.socket.remoteAddress ?? '');
  const who = (await tailscaleWho(ip)) ?? ip.replace(/^::ffff:/, '');
  console.log(`[mealapp] settings changed by ${who}: ${JSON.stringify(patch)}`);
  broadcast({ type: 'settings-updated' });
  // /api/state carries autoFold, which may have just flipped
  if ('autoFold' in patch) broadcast({ type: 'state-updated' });
  res.json(await settingsPayload());
});

// --- cook chat (passcode; streams plain text) ---
// The Cook tab's sous-chef: kitchen Q&A about the recipe being cooked.
// Deliberately NOT a run — read-only, never touches git, and allowed while a
// run is active (a fold shouldn't block "can I sub shallots?"). Answers on the
// cook model (sonnet) with the recipe, preferences, and pantry embedded, so
// most questions need zero tool calls.

const COOK_PER_MIN = 10;
const COOK_SYSTEM = `You are the sous-chef inside the Meal Planner app. Someone in the household is at the stove, phone propped up, asking mid-cook. Household size and the usual serving count are in the preferences (provided).
- Lead with the answer, then only what changes their next move. Short paragraphs or tight bullets. No headers, no tables, no restating the recipe.
- Substitutions and technique: be decisive — best option first with amounts, temps, and times; at most one fallback.
- Respect the household's preferences, allergies, and hard-nos (provided) without being asked. Prefer suggesting what the pantry (provided) already holds.
- The recipe, preferences, and pantry are in the prompt. For anything else in the repo (past plans, other recipes) you may Read/Grep/Glob, but you can never write or run commands.
- Plain text only — no markdown syntax at all (no **bold**, no #headers, no tables). Bullets as plain "- " lines are fine. Answers should almost always fit on a phone screen without scrolling.`;

let cookActive = 0;

function cookCanUseTool() {
  return async (toolName: string, input: Record<string, unknown>): Promise<PermissionResult> => {
    const allow: PermissionResult = { behavior: 'allow', updatedInput: input };
    if (toolName === 'Grep' || toolName === 'Glob') return allow;
    if (toolName === 'Read') {
      const p = path.resolve(repoRoot, String(input.file_path ?? ''));
      if (p === repoRoot || p.startsWith(repoRoot + path.sep)) return allow;
      return { behavior: 'deny', message: 'Cook chat can only read inside the meal-planner repo.' };
    }
    return { behavior: 'deny', message: 'Cook chat is read-only — answer from the provided context.' };
  };
}

app.post('/api/cook/ask', requirePasscode, async (req, res) => {
  const file = String(req.body?.file ?? '');
  if (!SAFE_FILE.test(file)) return res.status(400).json({ error: 'bad filename' });
  const rawMsgs: unknown[] = Array.isArray(req.body?.messages) ? req.body.messages : [];
  if (!rawMsgs.length || rawMsgs.length > 40) return res.status(400).json({ error: 'bad conversation' });
  const messages = rawMsgs.map((m) => {
    const o = (m ?? {}) as Record<string, unknown>;
    return { role: o.role === 'assistant' ? 'assistant' : 'user', text: String(o.text ?? '').slice(0, 4000) };
  });
  const last = messages[messages.length - 1]!;
  if (last.role !== 'user' || !last.text.trim()) return res.status(400).json({ error: 'Ask something first.' });
  const ip = String(req.socket.remoteAddress ?? '');
  if (!allowHit('cook', ip, COOK_PER_MIN)) return res.status(429).json({ error: `Easy there — ${COOK_PER_MIN} questions per minute, tops.` });
  if (cookActive >= 2) return res.status(409).json({ error: 'The sous-chef is mid-answer — give it a second.' });

  let recipe = '';
  try { recipe = await fs.readFile(path.join(recipesDir, file), 'utf8'); }
  catch { return res.status(404).json({ error: 'That recipe file doesn’t exist yet.' }); }
  const readOpt = async (p: string) => { try { return await fs.readFile(p, 'utf8'); } catch { return '(missing)'; } };
  const prefs = await readOpt(path.join(repoRoot, 'profile', 'preferences.md'));
  const pantry = await readOpt(path.join(repoRoot, 'profile', 'pantry.md'));

  const convo = messages.map((m) => `${m.role === 'user' ? 'Cook' : 'Sous-chef'}: ${m.text}`).join('\n\n');
  const prompt = `<recipe file="${file}">\n${recipe}\n</recipe>\n\n<preferences>\n${prefs}\n</preferences>\n\n<pantry>\n${pantry}\n</pantry>\n\nConversation so far (answer the cook's last message):\n\n${convo}`;

  cookActive++;
  const abort = new AbortController();
  let finished = false;
  let wrote = false;
  res.on('close', () => { if (!finished) abort.abort(); });

  const options: Options = {
    cwd: repoRoot,
    abortController: abort,
    // Grep/Glob as rules for the same control-channel reason as RUN_ALLOWED_TOOLS;
    // Read stays behind canUseTool for its inside-the-repo path check.
    allowedTools: ['Grep', 'Glob'],
    canUseTool: cookCanUseTool(),
    systemPrompt: COOK_SYSTEM,
    maxTurns: 8,
    ...modelFor('cook'),
    includePartialMessages: true,
  };

  try {
    let finalText = '';
    let failed: string | null = null;
    const q = query({ prompt, options });
    for await (const msg of q) {
      if (msg.type === 'stream_event' && msg.parent_tool_use_id === null) {
        const ev = msg.event as { type?: string; delta?: { type?: string; text?: string } };
        if (ev.type === 'message_start' && wrote) res.write('\n\n');
        if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta' && ev.delta.text) {
          if (!wrote) {
            res.status(200).set({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' });
            wrote = true;
          }
          res.write(ev.delta.text);
        }
      } else if (msg.type === 'result') {
        if (msg.subtype === 'success' && !msg.is_error) finalText = msg.result;
        else if (msg.subtype !== 'success') failed = `Claude run failed (${msg.subtype}).`;
      }
    }
    finished = true;
    if (wrote) res.end();
    else if (finalText) res.status(200).set({ 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' }).send(finalText);
    else res.status(502).json({ error: failed ?? 'The sous-chef came up empty — ask again.' });
  } catch (err) {
    finished = true;
    const message = err instanceof Error ? err.message : String(err);
    if (wrote) { res.write('\n\n[connection to Claude dropped — ask again for the rest]'); res.end(); }
    else if (!abort.signal.aborted) {
      const friendly = /401|invalid.*credential|authenticat/i.test(message)
        ? 'Claude authentication failed. Run `claude` in a terminal on the Mac, complete /login once, then try again.'
        : `Claude error: ${message}`;
      res.status(502).json({ error: friendly });
    }
  } finally {
    finished = true;
    cookActive--;
  }
});

// ---------- boot ----------

async function boot() {
  captures = await loadJson('captures.json', {});
  checks = await loadJson('checks.json', {});
  feedback = await loadJson('plan-feedback.json', {});
  extras = await loadJson('extras.json', {});
  runStats = await loadJson('runstats.json', {});
  settings = sanitizeSettings(await loadJson<unknown>('settings.json', {}));
  if (Object.keys(settings).length) console.log(`[mealapp] settings.json overrides: ${JSON.stringify(settings)}`);
  startAutoFold();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  lastPull = Date.now();
  execFile('git', ['pull', '--ff-only'], { cwd: repoRoot }, (err, stdout, stderr) => {
    recordPull(err, String(stdout), String(stderr));
    if (err) console.log(`[mealapp] git pull skipped: ${err.message.split('\n')[0]}`);
    else console.log(`[mealapp] git pull: ${stdout.trim() || 'ok'}`);
  });

  server.listen(PORT, () => {
    console.log(`[mealapp] Meal Planner app on http://localhost:${PORT} (repo: ${repoRoot})`);
  });
}

// Importable for selftest without booting the server.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void boot();
}
