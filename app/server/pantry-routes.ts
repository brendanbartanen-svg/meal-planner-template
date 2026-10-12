// The Pantry sheet's API (public/js/70-pantry.js). Each edit is applied to
// profile/pantry.md deterministically by server/pantry.ts and committed by
// server/commit.ts: the one place the server writes the repo itself
// (CLAUDE.md, "The repo stays the only system of record").
//   GET    /api/pantry                     open      { pantry, git, gitDisabled, busy }
//   POST   /api/pantry/items               passcode  { section, text }  add a staple
//   DELETE /api/pantry/items/:id           passcode                     remove an item
//   PUT    /api/pantry/items/:id/low       passcode  { low: boolean }   mark / clear running low
//   POST   /api/pantry/freezer             passcode  { text }           add to the freezer inventory
//   POST   /api/pantry/freezer/:id/used    passcode  { note? }          strike a freezer item, dated
// Edits are rate-limited (30/min per device), attributed via whoFor, refused
// with 409 while a run/chain/Ask Claude holds the run lock, and serialized
// with commit.ts's repo lock so two taps can't interleave read-modify-write.
// The response comes back right after the commit with git.pushed: 'pending';
// the push finishes in the background, and its outcome is kept for the next
// GET and announced with another `pantry-updated` broadcast.
import { randomBytes } from 'node:crypto';
import type express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { allowHit, clientIp, requirePasscode, whoFor } from './auth.ts';
import { broadcast } from './bus.ts';
import { commitRepoFiles, repoLockBusy, withRepoLock, type CommitResult } from './commit.ts';
import { pullIfStale } from './git.ts';
import { addItem, freezerAdd, freezerUse, parsePantry, removeItem, setLow, type Pantry, type PantryItem } from './pantry.ts';
import { repoRoot } from './paths.ts';
import { busyLabel, NO_GIT, run, RunBusyError } from './runs.ts';
import { fmtISO, todayUTC } from './weeks.ts';

export const PANTRY_REL = 'profile/pantry.md';
const pantryPath = path.join(repoRoot, PANTRY_REL);
const PANTRY_PER_MIN = 30;
const TEXT_MAX = 200;
const NOTE_MAX = 120;
const BUSY_MSG = 'Claude is editing the repo right now; try after the run';

/** The latest edit's git outcome (pending until its background push settles). Null until the first edit since boot. */
let lastGit: CommitResult | null = null;

class HttpError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}

// ---------- commit subjects ----------

export type PantryAction = 'add' | 'remove' | 'low' | 'unlow' | 'freezer-add' | 'freezer-used';
const plain = (s: string, max = 60) => {
  // the app's own provenance suffix is noise in a subject: "Za'atar (added 2026-10-11 via app)" → "Za'atar"
  const t = s.replace(/ ?\(added \d{4}-\d{2}-\d{2} via app\)/g, '').replace(/\*\*|__|~~|`/g, '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t;
};
/** `Pantry: <action> <text>` (commit.ts adds ` (via app, <by>)`). `extra` = the section (add) or the note (freezer-used). */
export function pantrySubject(action: PantryAction, text: string, extra?: string): string {
  const t = plain(text);
  const x = extra ? plain(extra, 40) : '';
  switch (action) {
    case 'add': return `Pantry: add ${t}${x ? ` to ${x}` : ''}`;
    case 'remove': return `Pantry: remove ${t}`;
    case 'low': return `Pantry: mark low ${t}`;
    case 'unlow': return `Pantry: clear low ${t}`;
    case 'freezer-add': return `Pantry: freezer add ${t}`;
    case 'freezer-used': return `Pantry: freezer used ${t}${x ? ` (${x})` : ''}`;
  }
}

// ---------- helpers ----------

function textField(v: unknown, what: string, max: number, optional = false): string {
  if (optional && (v === undefined || v === null || v === '')) return '';
  if (typeof v !== 'string') throw new HttpError(400, `${what} must be text`);
  const t = v.replace(/\s+/g, ' ').trim();
  if (!t && !optional) throw new HttpError(400, `${what} can't be empty`);
  if (t.length > max) throw new HttpError(400, `${what} is too long (${max} characters max)`);
  return t;
}

function findItem(p: Pantry, id: string): { item: PantryItem; section: string; isFreezer: boolean } {
  for (const s of p.sections) {
    const item = s.items.find((i) => i.id === id);
    if (item) return { item, section: s.name, isFreezer: s.isFreezer };
  }
  throw new HttpError(404, 'That item isn’t in the pantry any more (the list changed). Refreshed.');
}

async function writeAtomic(file: string, text: string): Promise<void> {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`);
  const mode = await fs.stat(file).then((st) => st.mode & 0o777, () => 0o644);
  try {
    await fs.writeFile(tmp, text, { encoding: 'utf8', mode });
    await fs.rename(tmp, file);
  } catch (err) {
    await fs.unlink(tmp).catch(() => {});
    throw err;
  }
}

function rateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  if (allowHit('pantry', clientIp(req), PANTRY_PER_MIN)) return next();
  res.status(429).json({ error: `Easy there — ${PANTRY_PER_MIN} pantry edits per minute, tops.` });
}

function setGitFromPush(r: CommitResult) {
  // only the newest commit's push decides the status line (an older push settling late doesn't)
  if (!lastGit || !lastGit.sha || lastGit.sha === r.sha) lastGit = r;
  broadcast({ type: 'pantry-updated', git: lastGit });
}

type Build = (raw: string, pantry: Pantry, today: string) => { next: string; subject: string };

/**
 * One edit: refuse while a run is active, then — under the repo lock — read
 * pantry.md, apply `build`, write it atomically and commit it. A commit that
 * fails (or a run that started meanwhile) puts the file back, so pantry.md
 * never sits edited-but-uncommitted because of this route.
 */
async function applyEdit(req: express.Request, res: express.Response, build: Build) {
  if (run) return void res.status(409).json({ error: BUSY_MSG, busy: busyLabel(run) });
  try {
    const by = await whoFor(req);
    const out = await withRepoLock(async () => {
      if (run) throw new RunBusyError(busyLabel(run));
      const raw = await fs.readFile(pantryPath, 'utf8');
      const { next, subject } = build(raw, parsePantry(raw), fmtISO(todayUTC()));
      if (next === raw) {
        return { pantry: parsePantry(raw), git: { committed: false, pushed: false, reason: 'no change', at: Date.now() } as CommitResult, changed: false };
      }
      await writeAtomic(pantryPath, next);
      let git: CommitResult;
      try {
        git = await commitRepoFiles([PANTRY_REL], subject, { by, background: true, lockHeld: true, onSettled: setGitFromPush });
      } catch (err) {
        const now = await fs.readFile(pantryPath, 'utf8').catch(() => null);
        if (now === next) await writeAtomic(pantryPath, raw).catch((e) => console.log(`[mealapp] pantry restore failed: ${String(e)}`));
        throw err;
      }
      lastGit = git;
      return { pantry: parsePantry(next), git, changed: true };
    });
    if (out.changed) broadcast({ type: 'pantry-updated', git: out.git });
    res.json({ ok: true, pantry: out.pantry, git: out.git });
  } catch (err) {
    if (err instanceof RunBusyError) return void res.status(409).json({ error: BUSY_MSG, busy: err.busy });
    if (err instanceof HttpError) return void res.status(err.status).json({ error: err.message });
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.startsWith('pantry: ')) {
      return void res.status(/no item with id/.test(msg) ? 404 : 400).json({ error: msg.slice('pantry: '.length) });
    }
    console.log(`[mealapp] pantry edit failed: ${msg}`);
    res.status(500).json({ error: `Couldn’t save the pantry: ${msg}` });
  }
}

const body = (req: express.Request) => (req.body && typeof req.body === 'object' ? req.body : {}) as Record<string, unknown>;

// ---------- routes ----------

export function registerPantryRoutes(app: express.Express) {
  app.get('/api/pantry', async (_req, res) => {
    try {
      if (!NO_GIT && !repoLockBusy()) await pullIfStale();
      const raw = await fs.readFile(pantryPath, 'utf8');
      res.json({ pantry: parsePantry(raw), git: lastGit, gitDisabled: NO_GIT, busy: run ? busyLabel(run) : null });
    } catch (err) {
      res.status(500).json({ error: String(err) });
    }
  });

  app.post('/api/pantry/items', requirePasscode, rateLimit, (req, res) => {
    void applyEdit(req, res, (raw, p, today) => {
      const b = body(req);
      const section = textField(b.section, 'Section', 80);
      const text = textField(b.text, 'Item', TEXT_MAX);
      if (text.startsWith('~~')) throw new HttpError(400, 'An item can’t start with ~~ (that marks a used entry).');
      const sec = p.sections.find((s) => s.name.trim().toLowerCase() === section.toLowerCase());
      if (!sec) throw new HttpError(400, `No pantry section named “${section}”.`);
      return { next: addItem(raw, sec.name, text, today), subject: pantrySubject('add', text, sec.name) };
    });
  });

  app.delete('/api/pantry/items/:id', requirePasscode, rateLimit, (req, res) => {
    void applyEdit(req, res, (raw, p) => {
      const { item } = findItem(p, String(req.params.id));
      return { next: removeItem(raw, item.id), subject: pantrySubject('remove', item.text) };
    });
  });

  app.put('/api/pantry/items/:id/low', requirePasscode, rateLimit, (req, res) => {
    void applyEdit(req, res, (raw, p, today) => {
      const low = body(req).low;
      if (typeof low !== 'boolean') throw new HttpError(400, '`low` must be true or false');
      const { item } = findItem(p, String(req.params.id));
      return { next: setLow(raw, item.id, low, today), subject: pantrySubject(low ? 'low' : 'unlow', item.text) };
    });
  });

  app.post('/api/pantry/freezer', requirePasscode, rateLimit, (req, res) => {
    void applyEdit(req, res, (raw, _p, today) => {
      const text = textField(body(req).text, 'Item', TEXT_MAX);
      if (text.startsWith('~~')) throw new HttpError(400, 'An item can’t start with ~~ (that marks a used entry).');
      return { next: freezerAdd(raw, text, today), subject: pantrySubject('freezer-add', text) };
    });
  });

  app.post('/api/pantry/freezer/:id/used', requirePasscode, rateLimit, (req, res) => {
    void applyEdit(req, res, (raw, p, today) => {
      const note = textField(body(req).note, 'Note', NOTE_MAX, true);
      const { item, isFreezer } = findItem(p, String(req.params.id));
      if (!isFreezer) throw new HttpError(400, 'Only freezer items can be marked used.');
      return { next: freezerUse(raw, item.id, today, note || undefined), subject: pantrySubject('freezer-used', item.text, note) };
    });
  });
}
