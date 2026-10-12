// Web Push foundation: VAPID keys, device subscriptions, fan-out send, and a
// daily wall-clock scheduler. Standalone: nothing here runs on import (the
// selftest imports server modules); the server calls initPush(dataDir) at boot.
//
// State lives beside the rest of the app state in app/data/ (gitignored):
//   vapid.json  — the VAPID key pair. Generated once, NEVER rotated
//                 automatically: a new key silently orphans every existing
//                 browser subscription. Written 0600 (holds the private key).
//   push.json   — { subscriptions: SubscriptionRecord[] }.
// Both are written atomically (temp file + rename), like saveSettings().
//
// See push.README.md for how to wire routes + the client.

import webpush from 'web-push';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { repoRoot } from './paths.ts';

// ---------- types ----------

export type PushType = 'run-done' | 'record-updated' | 'prep-today' | 'tonight';

export const PUSH_TYPES = ['run-done', 'record-updated', 'prep-today', 'tonight'] as const satisfies readonly PushType[];

export const PUSH_TYPE_LABELS: Record<PushType, string> = {
  'run-done': 'When a run finishes',
  'record-updated': 'When your log is in the record',
  'prep-today': 'Prep tasks due today (8:00)',
  'tonight': "Tonight's dinner (16:30)",
};

export interface PushKeys { p256dh: string; auth: string }

export interface SubscriptionRecord {
  id: string;
  endpoint: string;
  keys: PushKeys;
  label?: string;
  by?: string;   // tailscale whois display name, when known
  at: number;    // ms epoch of subscribe / last re-subscribe
  ua?: string;
  types: Record<PushType, boolean>;
}

/** What GET routes may expose: no keys, and only the push service host instead of the endpoint URL. */
export type PublicSubscription = Omit<SubscriptionRecord, 'keys' | 'endpoint'> & { service: string };

/** The browser's PushSubscription.toJSON() shape (expirationTime is ignored). */
export interface BrowserSubscription {
  endpoint: string;
  keys: PushKeys;
  expirationTime?: number | null;
}

export interface SubscriptionMeta { label?: string; by?: string; ua?: string }

export interface PushPayload { title: string; body: string; url?: string; tag?: string }

export interface SendResult {
  sent: number;
  pruned: number;
  errors: Array<{ id: string; status?: number; message: string }>;
}

interface VapidFile { publicKey: string; privateKey: string; createdAt: string }

// ---------- module state (set by initPush) ----------

// VAPID subject (the push service's contact for this sender), resolved once at
// initPush: MEALAPP_PUSH_CONTACT (a mailto: or https: URL) → mailto:<the repo's
// git config user.email> → a placeholder.
const VAPID_SUBJECT_FALLBACK = 'mailto:mealplanner@localhost';
let vapidSubject = VAPID_SUBJECT_FALLBACK;
const TTL_SECONDS = 60 * 60; // a push older than ~1 h is stale news; let the push service drop it

let dataDir: string | null = null;
let vapid: VapidFile | null = null;
let subs: SubscriptionRecord[] = [];

const subsFile = () => path.join(requireInit(), 'push.json');

function requireInit(): string {
  if (!dataDir || !vapid) throw new Error('push: not initialised (initPush(dataDir) not called or failed)');
  return dataDir;
}

// ---------- persistence ----------

async function writeJsonAtomic(file: string, value: unknown, mode = 0o644): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    await fs.writeFile(tmp, JSON.stringify(value, null, 2) + '\n', { mode });
    await fs.rename(tmp, file); // atomic on the same filesystem
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

// Saves are chained so two overlapping mutations can't land out of order
// (an older snapshot renamed over a newer one). The snapshot is taken when the
// save actually runs, so the last save always writes the latest state.
let saveChain: Promise<void> = Promise.resolve();
function saveSubs(): Promise<void> {
  const file = subsFile();
  const next = saveChain.then(() => writeJsonAtomic(file, { subscriptions: subs }));
  saveChain = next.catch(() => {}); // keep the chain alive after a failed write
  return next;
}

const isB64url = (s: unknown, min: number, max: number): s is string =>
  typeof s === 'string' && s.length >= min && s.length <= max && /^[A-Za-z0-9_-]+=*$/.test(s);

function defaultTypes(): Record<PushType, boolean> {
  return Object.fromEntries(PUSH_TYPES.map((t) => [t, true])) as Record<PushType, boolean>;
}

/** Repair a record read from disk; null if it can't be used to send. */
function reviveRecord(raw: unknown): SubscriptionRecord | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<SubscriptionRecord>;
  if (typeof r.id !== 'string' || typeof r.endpoint !== 'string') return null;
  if (!r.keys || !isB64url(r.keys.p256dh, 40, 200) || !isB64url(r.keys.auth, 8, 64)) return null;
  const types = defaultTypes(); // a type added after this device subscribed defaults on
  for (const t of PUSH_TYPES) if (typeof r.types?.[t] === 'boolean') types[t] = r.types[t];
  return {
    id: r.id,
    endpoint: r.endpoint,
    keys: { p256dh: r.keys.p256dh, auth: r.keys.auth },
    ...(typeof r.label === 'string' ? { label: r.label } : {}),
    ...(typeof r.by === 'string' ? { by: r.by } : {}),
    at: typeof r.at === 'number' ? r.at : 0,
    ...(typeof r.ua === 'string' ? { ua: r.ua } : {}),
    types,
  };
}

function toPublic(r: SubscriptionRecord): PublicSubscription {
  const { keys: _keys, endpoint, ...rest } = r;
  let service = 'unknown';
  try { service = new URL(endpoint).host; } catch { /* keep 'unknown' */ }
  return { ...rest, service, types: { ...r.types } };
}

// ---------- init ----------

/**
 * Load (or generate once) the VAPID key pair and load stored subscriptions.
 * State is committed only on success: if this throws (e.g. a malformed
 * vapid.json), a first call leaves push disabled (pushReady() === false) and a
 * repeat call keeps the previous state. Safe to call again (tests re-init).
 */
async function resolveVapidSubject(): Promise<string> {
  const env = process.env.MEALAPP_PUSH_CONTACT?.trim();
  if (env) {
    if (/^(mailto:\S+@\S+|https:\/\/\S+)$/i.test(env)) return env;
    console.warn(`[push] MEALAPP_PUSH_CONTACT ignored: must be a mailto: or https: URL (got ${JSON.stringify(env)})`);
  }
  try {
    const { stdout } = await promisify(execFile)('git', ['config', 'user.email'], { cwd: repoRoot, timeout: 5000 });
    const email = stdout.trim();
    if (/^[^\s@]+@[^\s@]+$/.test(email)) return `mailto:${email}`;
  } catch { /* no git, or no user.email: fall through */ }
  return VAPID_SUBJECT_FALLBACK;
}

export async function initPush(dir: string): Promise<void> {
  const root = path.resolve(dir);
  const subject = await resolveVapidSubject();
  const vFile = path.join(root, 'vapid.json');
  const sFile = path.join(root, 'push.json');

  // VAPID: generate only when the file is absent. A present-but-unreadable
  // file throws instead — regenerating would orphan every subscription.
  let raw: string | null = null;
  try { raw = await fs.readFile(vFile, 'utf8'); }
  catch (err) { if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; }
  let nextVapid: VapidFile;
  if (raw === null) {
    const keys = webpush.generateVAPIDKeys();
    nextVapid = { publicKey: keys.publicKey, privateKey: keys.privateKey, createdAt: new Date().toISOString() };
    await writeJsonAtomic(vFile, nextVapid, 0o600);
    console.log('[push] generated a new VAPID key pair (vapid.json)');
  } else {
    let v: Partial<VapidFile> = {};
    try { v = JSON.parse(raw) as Partial<VapidFile>; } catch { /* reported below */ }
    if (!isB64url(v.publicKey, 80, 100) || !isB64url(v.privateKey, 40, 50)) {
      throw new Error(`push: ${vFile} is malformed — fix or restore it (deleting it rotates the key and orphans all subscriptions)`);
    }
    nextVapid = { publicKey: v.publicKey, privateKey: v.privateKey, createdAt: v.createdAt ?? '' };
  }

  // Subscriptions: a missing file is an empty list. A corrupt file is moved
  // aside (devices re-subscribe on their next app load) rather than blocking boot.
  let nextSubs: SubscriptionRecord[] = [];
  try {
    const parsed = JSON.parse(await fs.readFile(sFile, 'utf8')) as { subscriptions?: unknown[] };
    const list = Array.isArray(parsed?.subscriptions) ? parsed.subscriptions : [];
    nextSubs = list.map(reviveRecord).filter((r): r is SubscriptionRecord => r !== null);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      const aside = `${sFile}.corrupt-${Date.now()}`;
      await fs.rename(sFile, aside).catch(() => {});
      console.error(`[push] push.json unreadable (${String(err)}); moved to ${path.basename(aside)}, starting empty`);
    }
  }

  dataDir = root;
  vapidSubject = subject;
  vapid = nextVapid;
  subs = nextSubs;
}

/** True once initPush has succeeded. Routes can 503 and senders can skip when false. */
export function pushReady(): boolean {
  return dataDir !== null && vapid !== null;
}

// ---------- public API ----------

/** The VAPID public key (base64url) — the client's applicationServerKey. */
export function publicKey(): string {
  requireInit();
  return vapid!.publicKey;
}

/**
 * Store a browser subscription. Upserts by endpoint: a device that re-subscribes
 * (e.g. on every app load) keeps its id and type toggles, with fresh keys/meta.
 * Throws TypeError on a malformed subscription (map to HTTP 400).
 */
export async function addSubscription(sub: BrowserSubscription, meta: SubscriptionMeta = {}): Promise<PublicSubscription> {
  requireInit();
  const endpoint = sub?.endpoint;
  let url: URL;
  try { url = new URL(String(endpoint)); } catch { throw new TypeError('subscription.endpoint must be a URL'); }
  if (url.protocol !== 'https:' || String(endpoint).length > 2048) throw new TypeError('subscription.endpoint must be an https URL');
  if (!isB64url(sub.keys?.p256dh, 40, 200) || !isB64url(sub.keys?.auth, 8, 64)) {
    throw new TypeError('subscription.keys.p256dh / auth must be base64url strings');
  }
  const clip = (s: unknown, n: number) => (typeof s === 'string' && s.trim() ? s.trim().slice(0, n) : undefined);
  const label = clip(meta.label, 60);
  const by = clip(meta.by, 120);
  const ua = clip(meta.ua, 300);

  const existing = subs.find((r) => r.endpoint === endpoint);
  const rec: SubscriptionRecord = {
    id: existing?.id ?? crypto.randomBytes(6).toString('base64url'),
    endpoint: String(endpoint),
    keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth },
    ...((label ?? existing?.label) ? { label: label ?? existing?.label } : {}),
    ...((by ?? existing?.by) ? { by: by ?? existing?.by } : {}),
    at: Date.now(),
    ...((ua ?? existing?.ua) ? { ua: ua ?? existing?.ua } : {}),
    types: existing ? { ...existing.types } : defaultTypes(),
  };
  subs = existing ? subs.map((r) => (r === existing ? rec : r)) : [...subs, rec];
  await saveSubs();
  return toPublic(rec);
}

/** Remove a subscription by id. Resolves false if there was no such id. */
export async function removeSubscription(id: string): Promise<boolean> {
  requireInit();
  const before = subs.length;
  subs = subs.filter((r) => r.id !== id);
  if (subs.length === before) return false;
  await saveSubs();
  return true;
}

/**
 * Merge per-type toggles into a subscription. Strict: unknown types or
 * non-boolean values throw TypeError (map to HTTP 400). Resolves null for an unknown id.
 */
export async function setTypes(id: string, types: Partial<Record<PushType, boolean>>): Promise<PublicSubscription | null> {
  requireInit();
  if (!types || typeof types !== 'object' || Array.isArray(types)) throw new TypeError('types must be an object');
  for (const [k, v] of Object.entries(types)) {
    if (!(PUSH_TYPES as readonly string[]).includes(k)) throw new TypeError(`unknown push type: ${k}`);
    if (typeof v !== 'boolean') throw new TypeError(`types.${k} must be true or false`);
  }
  const rec = subs.find((r) => r.id === id);
  if (!rec) return null;
  rec.types = { ...rec.types, ...types };
  await saveSubs();
  return toPublic(rec);
}

/** All subscriptions, safe for an open GET (no keys, no endpoint URL). */
export function listSubscriptions(): PublicSubscription[] {
  requireInit();
  return subs.map(toPublic);
}

/**
 * Send one notification to every subscription with `type` enabled. Never
 * throws for per-device failures: 404/410 (subscription gone) prunes the
 * record, anything else is reported in `errors`.
 */
export async function sendPush(type: PushType, payload: PushPayload): Promise<SendResult> {
  requireInit();
  if (!(PUSH_TYPES as readonly string[]).includes(type)) throw new TypeError(`unknown push type: ${type}`);
  const tag = payload.tag ?? type;
  const body = JSON.stringify({
    title: String(payload.title).slice(0, 120),
    body: String(payload.body ?? '').slice(0, 1000), // payloads cap at ~4 KB after encryption
    url: payload.url ?? '/',
    tag,
  });
  const options: webpush.RequestOptions = {
    TTL: TTL_SECONDS,
    vapidDetails: { subject: vapidSubject, publicKey: vapid!.publicKey, privateKey: vapid!.privateKey },
    // Topic lets the push service replace an undelivered older message with
    // the same tag (phone offline overnight → only the latest "tonight").
    ...(/^[A-Za-z0-9_-]{1,32}$/.test(tag) ? { topic: tag } : {}),
  };

  const targets = subs.filter((r) => r.types[type]);
  const result: SendResult = { sent: 0, pruned: 0, errors: [] };
  const gone = new Set<string>();
  await Promise.all(targets.map(async (r) => {
    try {
      await webpush.sendNotification({ endpoint: r.endpoint, keys: r.keys }, body, options);
      result.sent++;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) { gone.add(r.id); return; }
      result.errors.push({ id: r.id, ...(status ? { status } : {}), message: String((err as Error).message ?? err).slice(0, 300) });
    }
  }));
  if (gone.size) {
    subs = subs.filter((r) => !gone.has(r.id));
    result.pruned = gone.size;
    await saveSubs();
  }
  return result;
}

// ---------- daily scheduler ----------

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

/**
 * The first local wall-clock moment at hh:mm strictly after `from`.
 * Built with the local Date constructor, so DST shifts are handled by the runtime.
 */
export function nextOccurrence(hhmm: string, from: Date = new Date()): Date {
  const m = HHMM.exec(hhmm);
  if (!m) throw new TypeError(`dailyAt: expected "HH:MM" (24 h), got ${JSON.stringify(hhmm)}`);
  const h = Number(m[1]), min = Number(m[2]);
  const t = new Date(from.getFullYear(), from.getMonth(), from.getDate(), h, min, 0, 0);
  if (t.getTime() <= from.getTime()) t.setDate(t.getDate() + 1);
  return t;
}

/**
 * Run `fn` once a day at local `hhmm` (the Mac's TZ). Starting after today's
 * time schedules tomorrow's — it never fires immediately on start.
 *
 * Polls the wall clock (every 15 s, unref'd) instead of one long setTimeout:
 * Node timers run on a monotonic clock that stops while a Mac sleeps, so a
 * long timeout would fire hours late. If the Mac slept through the slot, the
 * job still fires on wake within `graceMin` (default 120) of the slot;
 * later than that it is skipped (no 16:30 dinner nudge at 2 a.m.).
 * Returns a cancel function.
 */
export function dailyAt(hhmm: string, fn: () => void | Promise<void>, opts: { graceMin?: number } = {}): () => void {
  const graceMs = (opts.graceMin ?? 120) * 60_000;
  let next = nextOccurrence(hhmm);
  const timer = setInterval(() => {
    const now = Date.now();
    if (now < next.getTime()) return;
    const late = now - next.getTime();
    next = nextOccurrence(hhmm, new Date(now)); // re-arm first: fn can't double-fire
    if (late > graceMs) {
      console.log(`[push] dailyAt ${hhmm}: skipped (woke ${Math.round(late / 60_000)} min late)`);
      return;
    }
    Promise.resolve().then(fn).catch((err) => console.error(`[push] dailyAt ${hhmm} job failed:`, err));
  }, 15_000);
  timer.unref();
  return () => clearInterval(timer);
}
