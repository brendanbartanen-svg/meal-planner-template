// Server-side commits for the app's own deterministic repo edits — today only
// the Pantry sheet (pantry-routes.ts applies a server/pantry.ts edit to
// profile/pantry.md and commits it here). This is the one exception to "agent
// runs are the only writers" (CLAUDE.md), so it is deliberately narrow:
//
// - Never while a run, chain or Ask Claude answer holds the run lock: the
//   agent owns git then. That throws RunBusyError (routes answer 409).
// - Only the named paths go into the commit (`git commit --only -- <paths>`):
//   anything else dirty or staged in the checkout stays out of it.
// - Plain execFile('git', …) with cwd = repo root, 60 s timeouts, never a
//   shell, GIT_TERMINAL_PROMPT=0 so a push can't hang on a credential prompt.
//   The configured git identity authors the commit (these are the user's own
//   edits): no --author, no Co-Authored-By trailer.
// - Push: plain `git push` to the branch's upstream, and only when one exists
//   (a branch without one is never published by accident). A rejected push
//   (the remote moved) gets ONE `git pull --rebase` (under the repo lock, and
//   only while no run is active) and one more push; a rebase that fails is
//   aborted, and the commit stays local, so the next run's push carries it.
// - Push failures never throw ({ pushed: false, error }); commit failures do.
// - MEALAPP_NO_GIT=1 (dev instances): no git at all; returns
//   { committed: false, pushed: false, reason: 'git disabled' }.
//
// withRepoLock serializes this module's working-tree work (a caller's
// read-modify-write + commit, and the rebase step of a push retry) so two
// edits can't interleave. Pushes run one at a time on their own queue, so a
// slow push never blocks the next edit's commit.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { repoRoot } from './paths.ts';
import { busyLabel, NO_GIT, run, RunBusyError } from './runs.ts';

const GIT_TIMEOUT_MS = 60_000;
const MESSAGE_MAX = 120;

export interface CommitResult {
  committed: boolean;
  /** 'pending' = committed, push running in the background (opts.background). */
  pushed: boolean | 'pending';
  /** Short sha of the new commit. */
  sha?: string;
  /** Why a push failed (committed: true, pushed: false). */
  error?: string;
  /** Why nothing was committed: 'git disabled' | 'nothing to commit'. */
  reason?: string;
  /** The full commit message. */
  message?: string;
  at: number;
}

export interface CommitOptions {
  /** Who made the edit (whoFor); goes into the message as "(via app, <by>)". */
  by?: string;
  /** Return right after the commit with pushed: 'pending'; onSettled gets the final outcome. */
  background?: boolean;
  onSettled?: (r: CommitResult) => void;
  /** The caller already holds withRepoLock (its read-modify-write and this commit are one critical section). */
  lockHeld?: boolean;
  /** Overrides MEALAPP_NO_GIT (selftest). */
  noGit?: boolean;
}

// ---------- message ----------

const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();

/** `<subject> (via app[, <by>])`, one line, at most 120 chars (the subject is clipped with …, the tail kept). */
export function commitMessage(subject: string, by?: string): string {
  const who = by ? oneLine(by).slice(0, 60) : '';
  const tail = ` (via app${who ? `, ${who}` : ''})`;
  const s = oneLine(subject) || 'App edit';
  const room = MESSAGE_MAX - tail.length;
  return (s.length > room ? `${s.slice(0, room - 1).trimEnd()}…` : s) + tail;
}

// ---------- the repo lock ----------

let lockTail: Promise<unknown> = Promise.resolve();
let lockDepth = 0;

/** Run fn after every earlier holder finishes. Not re-entrant: inside it, pass lockHeld: true to commitRepoFiles. */
export function withRepoLock<T>(fn: () => Promise<T>): Promise<T> {
  const go = async () => {
    lockDepth++;
    try { return await fn(); } finally { lockDepth--; }
  };
  const p = lockTail.then(go, go);
  lockTail = p.then(() => undefined, () => undefined);
  return p;
}
/** True while a caller is inside the repo lock (GET /api/pantry skips its pull then). */
export const repoLockBusy = () => lockDepth > 0;

// ---------- git ----------

interface GitOut { ok: boolean; code: number | string | null; stdout: string; stderr: string; err?: Error }

function git(args: string[]): Promise<GitOut> {
  return new Promise((resolve) => {
    execFile('git', args, {
      cwd: repoRoot, timeout: GIT_TIMEOUT_MS, maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
    }, (err, stdout, stderr) => {
      const code = err ? ((err as NodeJS.ErrnoException & { code?: number | string }).code ?? null) : 0;
      resolve({ ok: !err, code, stdout: String(stdout ?? ''), stderr: String(stderr ?? ''), ...(err ? { err } : {}) });
    });
  });
}

/** The useful part of a git failure, one line. */
function gitText(r: GitOut): string {
  if (r.err && (r.err as { killed?: boolean }).killed) return `git ${r.err.message.includes('timed out') ? 'timed out' : 'was killed'} after ${GIT_TIMEOUT_MS / 1000} s`;
  const lines = (r.stderr || r.stdout || r.err?.message || 'git failed').split('\n').map((l) => l.trim()).filter(Boolean);
  return lines.slice(0, 2).join(' ').slice(0, 300);
}

/** Run git; one retry after a short wait when another git process holds index.lock (a throttled pull). */
async function gitMust(args: string[], what: string): Promise<GitOut> {
  let r = await git(args);
  if (!r.ok && /index\.lock/.test(r.stderr)) {
    await new Promise((res) => setTimeout(res, 600));
    r = await git(args);
  }
  if (!r.ok) throw new Error(`${what} failed: ${gitText(r)}`);
  return r;
}

function checkPaths(paths: string[]): string[] {
  if (!Array.isArray(paths) || !paths.length) throw new Error('commitRepoFiles: no paths given');
  return paths.map((p) => {
    const abs = path.resolve(repoRoot, String(p));
    const rel = path.relative(repoRoot, abs);
    if (!rel || rel.startsWith('..') || path.isAbsolute(rel) || rel.split(path.sep).includes('.git')) {
      throw new Error(`commitRepoFiles: ${JSON.stringify(p)} is not a file inside the repo`);
    }
    return rel.split(path.sep).join('/');
  });
}

// ---------- push (serial, with one rebase retry) ----------

const REJECTED_RE = /\[rejected\]|non-fast-forward|fetch first|Updates were rejected/i;

async function rebaseInProgress(): Promise<boolean> {
  for (const name of ['rebase-merge', 'rebase-apply']) {
    const r = await git(['rev-parse', '--git-path', name]);
    if (!r.ok) continue;
    const p = path.resolve(repoRoot, r.stdout.trim());
    if (await fs.stat(p).then(() => true, () => false)) return true;
  }
  return false;
}

async function pushOnce(): Promise<{ pushed: boolean; error?: string }> {
  const up = await git(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  if (!up.ok) {
    const br = await git(['rev-parse', '--abbrev-ref', 'HEAD']);
    return { pushed: false, error: `branch ${br.ok ? br.stdout.trim() : '(unknown)'} has no upstream; not pushing` };
  }
  const first = await git(['push']);
  if (first.ok) return { pushed: true };
  const why = gitText(first);
  if (!REJECTED_RE.test(first.stderr)) return { pushed: false, error: why };
  if (run) return { pushed: false, error: `${why} (a run is active; its push will carry this commit)` };

  // the remote moved: one pull --rebase, then one more push
  const rebased = await withRepoLock(async () => {
    if (run) return 'a run started; not rebasing (its push will carry this commit)';
    const before = await rebaseInProgress();
    const r = await git(['pull', '--rebase']);
    if (r.ok) return null;
    if (!before && await rebaseInProgress()) await git(['rebase', '--abort']);
    return `pull --rebase failed: ${gitText(r)}`;
  });
  if (rebased) return { pushed: false, error: rebased };
  const second = await git(['push']);
  return second.ok ? { pushed: true } : { pushed: false, error: gitText(second) };
}

let pushTail: Promise<unknown> = Promise.resolve();
function queuePush(): Promise<{ pushed: boolean; error?: string }> {
  const go = () => pushOnce().catch((e: unknown) => ({ pushed: false, error: e instanceof Error ? e.message : String(e) }));
  const p = pushTail.then(go, go);
  pushTail = p.then(() => undefined, () => undefined);
  return p;
}

// ---------- commit ----------

/**
 * Commit exactly `paths` (repo-relative) with `<subject> (via app[, <by>])`,
 * then push. Throws RunBusyError while a run holds the lock, and Error when
 * the paths are bad or git add/commit fails. Never throws for a push failure.
 */
export async function commitRepoFiles(paths: string[], subject: string, opts: CommitOptions = {}): Promise<CommitResult> {
  if (run) throw new RunBusyError(busyLabel(run));
  const rel = checkPaths(paths);
  const message = commitMessage(subject, opts.by);
  if (opts.noGit ?? NO_GIT) return { committed: false, pushed: false, reason: 'git disabled', message, at: Date.now() };

  const doCommit = async (): Promise<string | null> => {
    if (run) throw new RunBusyError(busyLabel(run)); // re-check: a run may have started while we waited
    await gitMust(['add', '--', ...rel], 'git add');
    const diff = await git(['diff', '--cached', '--quiet', '--', ...rel]);
    if (diff.ok) return null; // the paths match HEAD: nothing to commit
    if (diff.code !== 1) throw new Error(`git diff failed: ${gitText(diff)}`);
    await gitMust(['commit', '-m', message, '--only', '--', ...rel], 'git commit');
    const head = await git(['rev-parse', '--short', 'HEAD']);
    return head.ok ? head.stdout.trim() : '';
  };
  const sha = opts.lockHeld ? await doCommit() : await withRepoLock(doCommit);
  if (sha === null) return { committed: false, pushed: false, reason: 'nothing to commit', message, at: Date.now() };

  const base = { committed: true as const, sha, message };
  if (opts.background) {
    void queuePush().then((p) => {
      const final: CommitResult = { ...base, ...p, at: Date.now() };
      if (!p.pushed) console.log(`[mealapp] push after "${message}" failed: ${p.error ?? 'unknown'}`);
      try { opts.onSettled?.(final); } catch (err) { console.log(`[mealapp] commit onSettled failed: ${String(err)}`); }
    });
    return { ...base, pushed: 'pending', at: Date.now() };
  }
  const p = await queuePush();
  return { ...base, ...p, at: Date.now() };
}
