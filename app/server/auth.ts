// Passcode gate, per-device rate limits, and tailscale attribution.
import { execFile } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import type express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { dataDir } from './paths.ts';

// ---------- passcode gate ----------
// GETs and captures stay open; run triggers, stop, and deletes require the
// shared passcode. Configured in app/data/passcode.txt (gitignored) or
// MEALAPP_PASSCODE; with neither the gate is off (set one at install, see
// README). Read per-request so rotating the file needs no restart.
const passcodeFile = path.join(dataDir, 'passcode.txt');

export async function configuredPasscode(): Promise<string | null> {
  const env = process.env.MEALAPP_PASSCODE?.trim();
  if (env) return env;
  try { return (await fs.readFile(passcodeFile, 'utf8')).trim() || null; } catch { return null; }
}

export async function requirePasscode(req: express.Request, res: express.Response, next: express.NextFunction) {
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
export const CAPTURES_PER_MIN = 12; // ratings, notes, feedback, extras
export const CHECKS_PER_MIN = 90;   // checkbox toggles — a big shop is many taps

const recentHits = new Map<string, number[]>();
export function allowHit(bucket: string, ip: string, perMin: number): boolean {
  const key = `${bucket}:${ip}`;
  const now = Date.now();
  const times = (recentHits.get(key) ?? []).filter((t) => now - t < 60_000);
  if (times.length >= perMin) { recentHits.set(key, times); return false; }
  times.push(now);
  recentHits.set(key, times);
  return true;
}

// ---------- client identity behind Tailscale Serve ----------
// The app is reached two ways: directly (http://…:4316, the socket peer IS the
// client) and through Tailscale Serve (https://<mac-hostname>.<tailnet>.ts.net),
// which terminates TLS and proxies from 127.0.0.1 with X-Forwarded-For and,
// for tailnet users, Tailscale-User-Login / -Name headers. index.ts sets
// `trust proxy` to 'loopback', so Express only honors X-Forwarded-For when the
// hop is local; a remote peer's forwarded/identity headers are ignored.

const LOOPBACK = /^(127\.\d{1,3}\.\d{1,3}\.\d{1,3}|::1)$/;
const bare = (ip: string) => ip.replace(/^::ffff:/, '');

/** The client's address: the X-Forwarded-For hop via a loopback proxy, else the socket peer. Rate-limit key. */
export function clientIp(req: express.Request): string {
  return bare(String(req.ip ?? req.socket.remoteAddress ?? ''));
}

/** True when the request's socket peer is this machine (i.e. it came through Tailscale Serve, or a local tool). */
function fromLoopback(req: express.Request): boolean {
  return LOOPBACK.test(bare(String(req.socket.remoteAddress ?? '')));
}

/**
 * Who made this request, for `by` attribution. Through the loopback proxy,
 * Tailscale Serve's identity headers win (login local-part, else display
 * name); otherwise — or when Serve sent none (tagged devices) — ask tailscaled
 * who owns the client IP.
 */
export async function whoFor(req: express.Request): Promise<string | undefined> {
  if (fromLoopback(req)) {
    const login = String(req.get('tailscale-user-login') ?? '').trim();
    if (login) return (login.split('@')[0] || login).slice(0, 120);
    const name = String(req.get('tailscale-user-name') ?? '').trim();
    if (name) return name.slice(0, 120);
  }
  return tailscaleWho(clientIp(req));
}

export function tailscaleWho(ip: string): Promise<string | undefined> {
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
