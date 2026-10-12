// Local app state in app/data/*.json (gitignored, Mac-only): captures, shared
// checks, plan feedback, shop extras, run-duration stats, and the gear-panel
// settings. The mutable state lives here and is imported (live ES module
// bindings) by the modules that use it; whole-object replacement goes through
// loadStore() / setSettings() because importers cannot assign a binding.
import type { Options } from '@anthropic-ai/claude-agent-sdk';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.ts';
import type { DayName } from './weeks.ts';

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
export const FOLD_QUIET_OPTIONS = [5, 10, 15, 30, 60] as const;
export type Effort = (typeof EFFORT_OPTIONS)[number];
export type TempUnit = 'F' | 'C';
/** The kitchen window's place (weather.ts): one Open-Meteo geocoding result, as saved from the gear panel. */
export interface WeatherLocation {
  name: string;
  admin1?: string;  // state / province
  country?: string;
  lat: number;
  lon: number;
  tz: string;       // IANA zone from the geocoder ('' when it gave none); the forecast itself asks timezone=auto
}

export interface Settings {
  planModel?: string;   // propose / revise / lock / review
  lightModel?: string;  // fold / shop-adjust / rescale / move
  cookModel?: string;   // sous-chef chat
  planEffort?: Effort;
  lightEffort?: Effort;
  cookEffort?: Effort;
  autoFold?: boolean;
  foldQuietMin?: number;
  pushPrepTime?: string;    // "HH:MM" local — the prep-today notice (notify.ts)
  pushTonightTime?: string; // "HH:MM" local — the tonight's-dinner notice
  location?: WeatherLocation; // the kitchen window's weather (weather.ts); absent = no weather, device clock only
  tempUnit?: TempUnit;        // the window caption's temperatures
}
export const SETTING_KEYS = ['planModel', 'lightModel', 'cookModel', 'planEffort', 'lightEffort', 'cookEffort', 'autoFold', 'foldQuietMin', 'pushPrepTime', 'pushTonightTime', 'location', 'tempUnit'] as const;
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
export type SettingKey = (typeof SETTING_KEYS)[number];

export let settings: Settings = {};

/** One value checked against its enum; returns an error string or null. */
export function settingError(key: SettingKey, v: unknown): string | null {
  switch (key) {
    case 'planModel': case 'lightModel': case 'cookModel':
      return MODEL_OPTIONS.some((m) => m.id === v) ? null : `${key} must be one of ${MODEL_OPTIONS.map((m) => m.id).join(', ')}`;
    case 'planEffort': case 'lightEffort': case 'cookEffort':
      return (EFFORT_OPTIONS as readonly unknown[]).includes(v) ? null : `${key} must be one of ${EFFORT_OPTIONS.join(', ')}`;
    case 'autoFold':
      return typeof v === 'boolean' ? null : 'autoFold must be true or false';
    case 'foldQuietMin':
      return (FOLD_QUIET_OPTIONS as readonly unknown[]).includes(v) ? null : `foldQuietMin must be one of ${FOLD_QUIET_OPTIONS.join(', ')}`;
    case 'pushPrepTime': case 'pushTonightTime':
      return typeof v === 'string' && HHMM_RE.test(v) ? null : `${key} must be a 24-hour "HH:MM" time`;
    case 'location':
      return locationError(v);
    case 'tempUnit':
      return v === 'F' || v === 'C' ? null : 'tempUnit must be "F" or "C"';
  }
}

const LOCATION_FIELDS = ['name', 'admin1', 'country', 'lat', 'lon', 'tz'];
const LOCATION_TEXT_MAX = 80;
/** A saved place: exactly the geocoder's fields, finite coordinates, short strings. */
function locationError(v: unknown): string | null {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return 'location must be an object { name, admin1?, country?, lat, lon, tz }';
  const o = v as Record<string, unknown>;
  const extra = Object.keys(o).filter((k) => !LOCATION_FIELDS.includes(k));
  if (extra.length) return `location has unknown field(s): ${extra.join(', ')}`;
  if (typeof o.name !== 'string' || !o.name.trim() || o.name.length > LOCATION_TEXT_MAX) return `location.name must be text of 1–${LOCATION_TEXT_MAX} characters`;
  for (const k of ['admin1', 'country'] as const) {
    if (o[k] !== undefined && (typeof o[k] !== 'string' || (o[k] as string).length > LOCATION_TEXT_MAX)) return `location.${k} must be text of at most ${LOCATION_TEXT_MAX} characters`;
  }
  if (typeof o.tz !== 'string' || o.tz.length > LOCATION_TEXT_MAX) return `location.tz must be text of at most ${LOCATION_TEXT_MAX} characters`;
  if (typeof o.lat !== 'number' || !Number.isFinite(o.lat) || o.lat < -90 || o.lat > 90) return 'location.lat must be a number from -90 to 90';
  if (typeof o.lon !== 'number' || !Number.isFinite(o.lon) || o.lon < -180 || o.lon > 180) return 'location.lon must be a number from -180 to 180';
  return null;
}

/** Env / built-in fallbacks — what each key resolves to when settings.json lacks it. */
export function settingDefaults() {
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
    foldQuietMin: 5, // was 15 until 2026-10 (UI round C): short enough that "into the record" feels prompt
    pushPrepTime: hhmmEnv('MEALAPP_PUSH_PREP_TIME', '08:00'),
    pushTonightTime: hhmmEnv('MEALAPP_PUSH_TONIGHT_TIME', '16:30'),
    location: null as WeatherLocation | null, // no built-in place: the window runs on the device clock until one is set
    tempUnit: (process.env.MEALAPP_TEMP_UNIT || '').trim().toUpperCase() === 'C' ? 'C' as TempUnit : 'F' as TempUnit,
  };
}
/** An "HH:MM" env var, or the built-in time when it is unset or malformed. */
function hhmmEnv(name: string, fallback: string): string {
  const v = (process.env[name] ?? '').trim();
  return HHMM_RE.test(v) ? v : fallback;
}

export function effectiveSettings() {
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
    pushPrepTime: settings.pushPrepTime ?? d.pushPrepTime,
    pushTonightTime: settings.pushTonightTime ?? d.pushTonightTime,
    location: settings.location ?? d.location,
    tempUnit: settings.tempUnit ?? d.tempUnit,
  };
}

export const autoFoldOn = () => effectiveSettings().autoFold;
export const foldDebounceMs = () => effectiveSettings().foldQuietMin * 60_000;
/** Model + optional effort for a run type or the cook chat, resolved now. */
export function modelFor(kind: 'plan' | 'light' | 'cook'): Pick<Options, 'model' | 'effort'> {
  const e = effectiveSettings();
  const model = kind === 'plan' ? e.planModel : kind === 'light' ? e.lightModel : e.cookModel;
  const effort = kind === 'plan' ? e.planEffort : kind === 'light' ? e.lightEffort : e.cookEffort;
  return effort ? { model, effort } : { model };
}

// ---------- app state (gitignored JSON) ----------

// The run kinds. Declared here rather than in runs.ts because runStats is
// keyed by them; runs.ts and everything else import it from this module.
export type RunType = 'propose' | 'revise' | 'lock' | 'fold' | 'shop-adjust' | 'review' | 'rescale' | 'move' | 'ideas' | 'import' | 'ask';

export interface Capture {
  date: string; // ISO date, keys the entry — deliberately not week-scoped
  dish?: string;   // override; "skipped — <reason>" for a night that wasn't cooked (POST /api/log { skipped })
  rating?: number;
  note?: string;
  minutes?: number; // "took about…" chip, 5–300; the fold prefixes the Log note with "(took ~N min)"
  by?: string;
  at: number;
  foldedAt?: number;
}
export interface CheckMark { by?: string; at: number }
// Per-meal Next-tab input for one planning round. `decision` and `servings`
// are set independently (the servings stepper never touches the decision), so
// either may be absent; an entry with neither is deleted.
export interface MealDecision { decision?: 'approve' | 'reject' | 'swap'; note?: string; servings?: number; by?: string; at: number }
export interface WeekFeedback { meals: Partial<Record<DayName, MealDecision>>; weekNote?: { text: string; by?: string; at: number } }
export interface ExtraItem { id: string; text: string; by?: string; at: number }

export let captures: Record<string, Capture> = {};
export let checks: Record<string, CheckMark> = {};
export let feedback: Record<string, WeekFeedback> = {};
export let extras: Record<string, ExtraItem[]> = {};
export let runStats: Partial<Record<RunType, number[]>> = {};

const storeFile = (name: string) => path.join(dataDir, name);
async function loadJson<T>(name: string, fallback: T): Promise<T> {
  try { return JSON.parse(await fs.readFile(storeFile(name), 'utf8')) as T; } catch { return fallback; }
}
async function saveJson(name: string, value: unknown) {
  await fs.mkdir(dataDir, { recursive: true });
  await fs.writeFile(storeFile(name), JSON.stringify(value, null, 2));
}

export const saveCaptures = () => saveJson('captures.json', captures);
export const saveChecks = () => saveJson('checks.json', checks);
export const saveFeedback = () => saveJson('plan-feedback.json', feedback);
export const saveExtras = () => saveJson('extras.json', extras);
const saveRunStats = () => saveJson('runstats.json', runStats);

export const pendingCaptures = () => Object.values(captures).filter((c) => !c.foldedAt);

export function typicalMs(type: RunType): number | null {
  const arr = runStats[type] ?? [];
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)] ?? null;
}
export async function recordDuration(type: RunType, ms: number) {
  runStats[type] = [...(runStats[type] ?? []).slice(-19), ms];
  await saveRunStats();
}

// ---------- settings persistence ----------

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

export async function saveSettings() {
  await fs.mkdir(dataDir, { recursive: true });
  const file = storeFile('settings.json');
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(settings, null, 2) + '\n');
  await fs.rename(tmp, file); // atomic on the same filesystem
}

/** Replace the stored settings wholesale (PUT /api/settings). */
export function setSettings(next: Settings) {
  settings = next;
}

// ---------- boot-time load ----------

/** Load every app/data JSON file into memory (called once from boot()). */
export async function loadStore() {
  captures = await loadJson('captures.json', {});
  checks = await loadJson('checks.json', {});
  feedback = await loadJson('plan-feedback.json', {});
  extras = await loadJson('extras.json', {});
  runStats = await loadJson('runstats.json', {});
  settings = sanitizeSettings(await loadJson<unknown>('settings.json', {}));
  if (Object.keys(settings).length) console.log(`[mealapp] settings.json overrides: ${JSON.stringify(settings)}`);
}
