// Git + build provenance: throttled pull (never during a run), the boot pull,
// HEAD and SDK version for the Status panel.
import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { appDir, repoRoot } from './paths.ts';
import { NO_GIT, run } from './runs.ts';

// ---------- git ----------
// Phone/desktop Claude sessions push to GitHub; pull (throttled, never during
// a run — the agent owns git then) so their changes appear here.
// MEALAPP_NO_GIT=1 (dev instances): no boot pull and no throttled pulls either.

let lastPull = 0;
// Outcome of the most recent pull (boot or throttled), for the Status panel.
export let lastPullResult: { at: number; ok: boolean; message: string } | null = null;
function recordPull(err: Error | null, stdout: string, stderr: string) {
  const out = (stdout || '').trim();
  lastPullResult = err
    ? { at: Date.now(), ok: false, message: ((stderr || '').trim() || err.message).split('\n').slice(0, 3).join(' ').slice(0, 300) }
    : { at: Date.now(), ok: true, message: out.split('\n')[0] || 'ok' };
}
export function pullIfStale(): Promise<void> {
  if (NO_GIT || run || Date.now() - lastPull < 60_000) return Promise.resolve();
  lastPull = Date.now();
  return new Promise((resolve) => {
    execFile('git', ['pull', '--ff-only'], { cwd: repoRoot }, (err, stdout, stderr) => {
      recordPull(err, String(stdout), String(stderr));
      resolve();
    });
  });
}

/** The boot-time pull: unthrottled, logs its outcome (called once from boot()). */
export function bootPull() {
  if (NO_GIT) { console.log('[mealapp] git disabled (MEALAPP_NO_GIT): no boot pull, no throttled pulls'); return; }
  lastPull = Date.now();
  execFile('git', ['pull', '--ff-only'], { cwd: repoRoot }, (err, stdout, stderr) => {
    recordPull(err, String(stdout), String(stderr));
    if (err) console.log(`[mealapp] git pull skipped: ${err.message.split('\n')[0]}`);
    else console.log(`[mealapp] git pull: ${stdout.trim() || 'ok'}`);
  });
}

let sdkVersion: string | null = null;
export async function readSdkVersion(): Promise<string> {
  if (sdkVersion) return sdkVersion;
  try {
    const pkg = JSON.parse(await fs.readFile(path.join(appDir, 'node_modules', '@anthropic-ai', 'claude-agent-sdk', 'package.json'), 'utf8')) as { version?: string };
    sdkVersion = pkg.version ?? 'unknown';
  } catch { sdkVersion = 'unknown'; }
  return sdkVersion;
}

export function gitHead(): Promise<{ sha: string; subject: string; at: string } | null> {
  return new Promise((resolve) => {
    execFile('git', ['log', '-1', '--format=%h%x1f%s%x1f%cI'], { cwd: repoRoot, timeout: 3000 }, (err, stdout) => {
      if (err) return resolve(null);
      const [sha = '', subject = '', at = ''] = String(stdout).trim().split('\x1f');
      resolve({ sha, subject, at });
    });
  });
}
