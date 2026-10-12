// Android share target: manifest.json's share_target POSTs multipart
// (title, text, url, files[]) to /share when the user shares a page, photo, or
// PDF to the installed app. Files land in app/data/uploads/ (gitignored); the
// share is recorded in app/data/shares.json (newest first, capped) for the
// Recipes tab's "Add a recipe" import to pick up. Like other captures it is
// open (tailnet reachability is the identity), rate-limited, and attributed;
// deleting a share needs the passcode.
//
// Only images and PDFs are accepted, decided by the file's leading bytes (the
// declared type and extension must also look like one). Oversized, extra, or
// unrecognised files reject the whole share — nothing is half-saved.
import busboy from 'busboy';
import type express from 'express';
import crypto from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { allowHit, clientIp, requirePasscode, whoFor } from './auth.ts';
import { dataDir, repoRoot } from './paths.ts';

export const uploadsDir = path.join(dataDir, 'uploads');
const sharesFile = path.join(dataDir, 'shares.json');

const MAX_FILES = 3;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_SHARES = 20;
const SHARES_PER_MIN = 10;

export interface SharedFile { path: string; type: string; size: number } // path is repo-relative
export interface Share {
  id: string;
  at: number;
  by?: string;
  title?: string;
  text?: string;
  url?: string;
  files: SharedFile[];
}

// ---------- file kinds (magic bytes) ----------

interface Kind { type: string; ext: string[] }
const HEIF_BRANDS = new Set(['heic', 'heix', 'hevc', 'hevx', 'heim', 'heis', 'hevm', 'hevs', 'mif1', 'msf1']);
const AVIF_BRANDS = new Set(['avif', 'avis']);
const ALLOWED_EXTS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.gif', '.webp', '.heic', '.heif', '.avif']);

// sniff / safeName / placeFile / loadShares are also used by import.ts (Recipes → Add a recipe).
export function sniff(b: Buffer): Kind | null {
  const ascii = (from: number, to: number) => b.subarray(from, to).toString('latin1');
  if (ascii(0, 5) === '%PDF-') return { type: 'application/pdf', ext: ['.pdf'] };
  if (b.length >= 8 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { type: 'image/png', ext: ['.png'] };
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: ['.jpg', '.jpeg'] };
  if (ascii(0, 4) === 'GIF8') return { type: 'image/gif', ext: ['.gif'] };
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return { type: 'image/webp', ext: ['.webp'] };
  if (ascii(4, 8) === 'ftyp') { // ISO-BMFF: only still-image brands (an .mp4 is ftyp too)
    const brand = ascii(8, 12);
    if (AVIF_BRANDS.has(brand)) return { type: 'image/avif', ext: ['.avif'] };
    if (HEIF_BRANDS.has(brand)) return { type: 'image/heic', ext: ['.heic', '.heif'] };
  }
  return null;
}

const declaredOk = (mime: string) =>
  !mime || mime.startsWith('image/') || mime === 'application/pdf' || mime === 'application/octet-stream';

// ---------- names ----------

const pad = (n: number) => String(n).padStart(2, '0');
function stampNow(d = new Date()): string {
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** A filesystem-safe version of the sender's file name, with an extension that matches what the bytes are. */
export function safeName(orig: string, kind: Kind): string {
  const base = path.basename(orig).normalize('NFKD').replace(/[̀-ͯ]/g, '');
  const origExt = path.extname(base);
  const stem = base.slice(0, base.length - origExt.length)
    .replace(/[^A-Za-z0-9._-]+/g, '-').replace(/-{2,}/g, '-').replace(/^[-.]+|[-.]+$/g, '').slice(0, 60) || 'file';
  const ext = kind.ext.includes(origExt.toLowerCase()) ? origExt.toLowerCase() : kind.ext[0]!;
  return stem + ext;
}

/** Hard-link tmp into place under a free name (EEXIST-safe, never overwrites), then drop tmp. */
export async function placeFile(tmp: string, name: string): Promise<string> {
  const ext = path.extname(name);
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 1; i < 50; i++) {
    const abs = path.join(uploadsDir, i === 1 ? name : `${stem}-${i}${ext}`);
    try {
      await fs.link(tmp, abs);
      await fs.unlink(tmp).catch(() => {});
      return abs;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not find a free upload name');
}

const repoRel = (abs: string) => path.relative(repoRoot, abs).split(path.sep).join('/');

/** Remove a recorded file — only ever directly inside app/data/uploads/. */
async function removeUpload(rel: string): Promise<void> {
  const abs = path.resolve(repoRoot, rel);
  if (path.dirname(abs) !== uploadsDir) return;
  await fs.unlink(abs).catch(() => {});
}

// Temp files from an upload the client abandoned mid-stream (busboy never
// closes) — swept opportunistically on the next share.
async function sweepStaleTemps(): Promise<void> {
  let names: string[] = [];
  try { names = await fs.readdir(uploadsDir); } catch { return; }
  const cutoff = Date.now() - 60 * 60_000;
  await Promise.all(names.filter((n) => n.startsWith('.incoming-')).map(async (n) => {
    const abs = path.join(uploadsDir, n);
    try { if ((await fs.stat(abs)).mtimeMs < cutoff) await fs.unlink(abs); } catch { /* gone */ }
  }));
}

// ---------- shares.json ----------

let sharesLoad: Promise<Share[]> | null = null;
export function loadShares(): Promise<Share[]> {
  sharesLoad ??= (async () => {
    try {
      const j = JSON.parse(await fs.readFile(sharesFile, 'utf8')) as unknown;
      return Array.isArray(j) ? (j as Share[]) : [];
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') console.error('[share] shares.json unreadable, starting empty:', String(e));
      return [];
    }
  })();
  return sharesLoad;
}

// Chained atomic writes (temp + rename), so overlapping saves land in order.
let saveChain: Promise<void> = Promise.resolve();
function saveShares(list: Share[]): Promise<void> {
  const next = saveChain.then(async () => {
    await fs.mkdir(dataDir, { recursive: true });
    const tmp = `${sharesFile}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    try {
      await fs.writeFile(tmp, JSON.stringify(list, null, 2) + '\n');
      await fs.rename(tmp, sharesFile);
    } catch (e) {
      await fs.unlink(tmp).catch(() => {});
      throw e;
    }
  });
  saveChain = next.catch(() => {});
  return next;
}

// ---------- responses ----------

const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// The share sheet navigates the app window to the POST's response, so a
// browser gets a readable page with a way back; API clients get JSON.
function reject(req: express.Request, res: express.Response, status: number, msg: string) {
  if (res.headersSent) return;
  if (req.accepts(['html', 'json']) === 'json') { res.status(status).json({ error: msg }); return; }
  res.status(status).type('html').send(`<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1"><title>Share not saved</title></head>
<body style="font:17px/1.5 Charter,Georgia,serif;margin:24px;max-width:34em">
<h1 style="font-size:22px">Couldn’t take that share</h1><p>${escHtml(msg)}</p>
<p><a href="/">Back to Meal Planner</a></p></body></html>`);
}

const clip = (v: string | undefined, n: number) => (v && v.trim() ? v.trim().slice(0, n) : undefined);
function cleanUrl(v: string | undefined): string | undefined {
  const s = clip(v, 2048);
  if (!s) return undefined;
  try { const u = new URL(s); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : undefined; } catch { return undefined; }
}

// ---------- routes ----------

interface Incoming { tmp: string; name: string; kind: Kind; size: number }

export function registerShareRoutes(app: express.Express) {
  app.post('/share', async (req, res) => {
    if (!allowHit('share', clientIp(req), SHARES_PER_MIN)) return reject(req, res, 429, 'Too many shares — try again in a minute.');
    if (!req.is('multipart/form-data')) return reject(req, res, 415, 'Expected a multipart/form-data share.');

    let bb: busboy.Busboy;
    try {
      bb = busboy({
        headers: req.headers,
        limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 10, fieldSize: 64 * 1024, parts: MAX_FILES + 10 },
      });
    } catch {
      return reject(req, res, 400, 'That upload was malformed.');
    }
    await fs.mkdir(uploadsDir, { recursive: true });
    void sweepStaleTemps();

    const fields: Record<string, string> = {};
    const incoming: Incoming[] = [];
    const temps: string[] = [];
    const writes: Promise<void>[] = [];
    let failure: { status: number; msg: string } | null = null;
    const fail = (status: number, msg: string) => { failure ??= { status, msg }; };

    const receive = async (stream: Readable, info: busboy.FileInfo): Promise<void> => {
      const shown = info.filename || 'that file';
      const ext = path.extname(info.filename || '').toLowerCase();
      if ((ext && !ALLOWED_EXTS.has(ext)) || !declaredOk((info.mimeType || '').toLowerCase())) {
        fail(415, `${shown}: only images and PDFs can be shared here.`);
        stream.resume();
        return;
      }
      const tmp = path.join(uploadsDir, `.incoming-${crypto.randomBytes(6).toString('hex')}`);
      temps.push(tmp);
      let head = Buffer.alloc(0);
      let size = 0;
      let truncated = false;
      stream.on('limit', () => { truncated = true; });
      const sniffer = new Transform({
        transform(chunk: Buffer, _enc, cb) {
          if (head.length < 16) head = Buffer.concat([head, chunk]).subarray(0, 16);
          size += chunk.length;
          cb(null, chunk);
        },
      });
      try {
        await pipeline(stream, sniffer, createWriteStream(tmp, { flags: 'wx' }));
      } catch {
        fail(400, `${shown} didn’t arrive in full — try sharing it again.`);
        return;
      }
      if (truncated) return fail(413, `${shown} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      if (!size) return fail(400, `${shown} is empty.`);
      const kind = sniff(head);
      if (!kind) return fail(415, `${shown}: only images and PDFs can be shared here.`);
      incoming.push({ tmp, name: safeName(info.filename || 'file', kind), kind, size });
    };

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      await Promise.all(writes);
      const dropTemps = () => Promise.all(temps.map((t) => fs.unlink(t).catch(() => {})));
      const title = clip(fields.title, 300);
      const text = clip(fields.text, 5000);
      const url = cleanUrl(fields.url);
      if (!failure && !incoming.length && !title && !text && !url) fail(400, 'Nothing came through with that share.');
      if (failure) {
        await dropTemps();
        return reject(req, res, failure.status, failure.msg);
      }
      const placed: string[] = [];
      try {
        const stamp = stampNow();
        const files: SharedFile[] = [];
        for (const f of incoming) {
          const abs = await placeFile(f.tmp, `${stamp}-${f.name}`);
          placed.push(abs);
          files.push({ path: repoRel(abs), type: f.kind.type, size: f.size });
        }
        const rec: Share = {
          id: crypto.randomBytes(6).toString('base64url'),
          at: Date.now(),
          ...(await whoFor(req).then((by) => (by ? { by } : {}))),
          ...(title ? { title } : {}),
          ...(text ? { text } : {}),
          ...(url ? { url } : {}),
          files,
        };
        const list = await loadShares();
        list.unshift(rec);
        const evicted = list.splice(MAX_SHARES);
        await saveShares(list);
        await Promise.all(evicted.flatMap((s) => s.files.map((f) => removeUpload(f.path))));
        console.log(`[share] ${rec.id} from ${rec.by ?? clientIp(req)}: ${files.length} file(s)${url ? ` · ${url}` : ''}`);
        res.redirect(303, `/?shared=${encodeURIComponent(rec.id)}`);
      } catch (e) {
        await dropTemps();
        await Promise.all(placed.map((p) => fs.unlink(p).catch(() => {})));
        console.error('[share] save failed:', e);
        reject(req, res, 500, 'The server couldn’t save that share.');
      }
    };

    bb.on('field', (name, val, info) => {
      if (info.valueTruncated) fail(413, `The ${name} field is too long.`);
      else if (name === 'title' || name === 'text' || name === 'url') fields[name] = val;
    });
    bb.on('file', (_name, stream, info) => {
      if (failure) { stream.resume(); return; }
      writes.push(receive(stream, info));
    });
    bb.on('filesLimit', () => fail(413, `At most ${MAX_FILES} files per share.`));
    bb.on('fieldsLimit', () => fail(413, 'Too many fields in that share.'));
    bb.on('partsLimit', () => fail(413, 'Too many parts in that share.'));
    bb.on('error', () => {
      fail(400, 'That upload was malformed.');
      req.unpipe(bb);
      req.resume();
      void finish();
    });
    bb.on('close', () => { void finish(); });
    req.pipe(bb);
  });

  app.get('/api/shares', async (_req, res) => {
    res.json({ shares: await loadShares() });
  });

  app.delete('/api/shares/:id', requirePasscode, async (req, res) => {
    const list = await loadShares();
    const i = list.findIndex((s) => s.id === String(req.params.id));
    if (i < 0) return res.status(404).json({ error: 'No such share.' });
    const [gone] = list.splice(i, 1);
    try { await saveShares(list); } catch (e) { return res.status(500).json({ error: `Could not save shares: ${String(e)}` }); }
    await Promise.all(gone!.files.map((f) => removeUpload(f.path)));
    res.json({ ok: true });
  });
}
