// Recipe import (F-11): the Recipes tab's "Add a recipe". Three sources, all
// reduced here WITHOUT a model, then handed to one `import` run
// (app/prompts/import.md, plan model) as {{IMPORT_SOURCE}}:
//   url     fetched server-side (15 s, browser-like UA) and reduced to the
//           page's JSON-LD Recipe (name, ingredients, instructions, yield,
//           times; image ignored) or, failing that, its readable text
//           (scripts/styles/nav stripped, whitespace collapsed, 20k chars)
//   upload  photo(s)/PDF posted from the tab (busboy, 15 MB, images/PDF only,
//           sniffed by magic bytes — share.ts's conventions) into uploadsDir
//   share   an Android share-target item (share.ts): its files, else the URL
//           it carried, else its text
// Every import gets <dataDir>/imports/<id>.json (the record + extraction; URL
// text imports also keep <id>.txt with the raw readable text). The run reads
// image/PDF files itself with its Read tool. When an import run finishes, the
// record learns which recipes/ file it wrote (a new file since the run
// started, else a path named in the summary) for the tab's result card.
import busboy from 'busboy';
import type express from 'express';
import crypto from 'node:crypto';
import { createWriteStream, promises as fs } from 'node:fs';
import http2 from 'node:http2';
import path from 'node:path';
import { Transform, type Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import zlib from 'node:zlib';
import { marked } from 'marked';
import { broadcast } from './bus.ts';
import { dataDir, recipesDir, repoRoot } from './paths.ts';
import { onRunDone, run } from './runs.ts';
import { loadShares, placeFile, safeName, sniff, uploadsDir } from './share.ts';
import { fmtISO, todayUTC } from './weeks.ts';

export const importsDir = path.join(dataDir, 'imports');
const MAX_RECORDS = 30;
const MAX_FILES = 3;
const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_PAGE_BYTES = 6 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const TEXT_CAP = 20_000;
const MIN_TEXT_CHARS = 600; // less readable text than this is a paywall, a JS shell, or not a recipe
const UA = 'Mozilla/5.0 (Linux; Android 14; Pixel 8a) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const PAYWALL_HINT = 'Share the PDF or a screenshot instead (NYT Cooking: Print → Save as PDF, or screenshots of the recipe).';

export class ImportError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

export interface JsonLdRecipe {
  name: string;
  description?: string;
  author?: string;
  yield?: string;
  prepTimeMin?: number;
  cookTimeMin?: number;
  totalTimeMin?: number;
  cuisine?: string;
  category?: string;
  ingredients: string[];
  instructions: string[];
  nutrition?: Record<string, string>;
}

export interface ImportFile { abs: string; name: string; type: string; size: number }
export interface ImportRecord {
  id: string;
  at: number;
  by?: string;
  kind: 'url' | 'upload' | 'share';
  url?: string;          // the page fetched (url imports; shares that carried a link)
  title?: string;        // page <title> / share title
  text?: string;         // a text-only share's text
  shareId?: string;
  files?: ImportFile[];  // uploads and file shares
  extraction?: 'json-ld' | 'text';
  recipe?: JsonLdRecipe; // json-ld extraction
  textChars?: number;    // text extraction: length of <id>.txt
  status: 'saved' | 'running' | 'done' | 'failed';
  runAt?: number;
  doneAt?: number;
  recipeFile?: string;   // what the run wrote (recipes/<file>)
  recipeExists?: boolean;
  summaryHtml?: string;
  error?: string;
}

// ---------- HTML → text helpers ----------

const NAMED: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ndash: '–', mdash: '—', hellip: '…',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', deg: '°', frac12: '½', frac14: '¼', frac34: '¾',
  frac13: '⅓', frac23: '⅔', times: '×', eacute: 'é', egrave: 'è', ntilde: 'ñ', uuml: 'ü', ouml: 'ö',
  auml: 'ä', ccedil: 'ç', reg: '®', trade: '™', copy: '©', laquo: '«', raquo: '»', middot: '·',
  bull: '•', shy: '', ensp: ' ', emsp: ' ', thinsp: ' ', minus: '−',
};
export function decodeEntities(s: string): string {
  const once = (x: string) => x.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (m, e: string) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(cp) && cp > 0 && cp < 0x110000 ? String.fromCodePoint(cp) : m;
    }
    return NAMED[e.toLowerCase()] ?? m;
  });
  const a = once(s);
  return /&(?:#x?[0-9a-f]+|[a-z]+);/i.test(a) ? once(a) : a; // JSON-LD is often double-encoded
}
const clean = (v: unknown): string =>
  typeof v === 'string' ? decodeEntities(v.replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim()
    : typeof v === 'number' ? String(v) : '';
const cleanList = (v: unknown): string => (Array.isArray(v) ? v.map(clean).filter(Boolean).join(', ') : clean(v));

/** ISO-8601 duration (PT1H30M, P0DT45M, PT90M) → whole minutes; undefined when absent/zero/unparseable. */
export function durationMin(v: unknown): number | undefined {
  if (typeof v !== 'string') return undefined;
  const m = /^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(v.trim());
  if (!m) return undefined;
  const min = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0) + Number(m[4] ?? 0) / 60;
  return min > 0 ? Math.round(min) : undefined;
}

// ---------- JSON-LD ----------

const LD_SCRIPT = /<script\b[^>]*\btype\s*=\s*["']?application\/ld\+json["']?[^>]*>([\s\S]*?)<\/script\s*>/gi;

/** Escape raw control characters inside JSON strings (sites paste multi-line text unescaped). */
function escapeRawControls(s: string): string {
  let out = '';
  let inStr = false;
  let escaped = false;
  for (const ch of s) {
    if (!inStr) { if (ch === '"') inStr = true; out += ch; continue; }
    if (escaped) { escaped = false; out += ch; continue; }
    if (ch === '\\') { escaped = true; out += ch; continue; }
    if (ch === '"') { inStr = false; out += ch; continue; }
    if (ch.charCodeAt(0) < 0x20) { out += ch === '\n' ? '\\n' : ch === '\t' ? '\\t' : ch === '\r' ? '' : ' '; continue; }
    out += ch;
  }
  return out;
}

function parseLd(raw: string): unknown {
  const s = raw.trim().replace(/^<!\[CDATA\[|\]\]>$/g, '').replace(/^<!--|-->$/g, '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  try { return JSON.parse(escapeRawControls(s)); } catch { return null; }
}

const isRecipeType = (t: unknown) =>
  (Array.isArray(t) ? t : [t]).some((x) => typeof x === 'string' && /(^|[/:])Recipe$/i.test(x));

function findRecipeNode(node: unknown, depth = 0): Record<string, unknown> | null {
  if (depth > 8 || !node || typeof node !== 'object') return null;
  if (Array.isArray(node)) {
    for (const n of node) { const r = findRecipeNode(n, depth + 1); if (r) return r; }
    return null;
  }
  const o = node as Record<string, unknown>;
  if (isRecipeType(o['@type'])) return o;
  for (const k of ['@graph', 'mainEntity', 'mainEntityOfPage', 'itemListElement', 'item', 'about']) {
    if (k in o) { const r = findRecipeNode(o[k], depth + 1); if (r) return r; }
  }
  return null;
}

function instructionLines(v: unknown, out: string[] = [], depth = 0): string[] {
  if (depth > 6 || v === null || v === undefined) return out;
  if (typeof v === 'string') {
    out.push(...v.split(/<\/?(?:li|p|br|ol|ul)\b[^>]*>|\n+/i).map(clean).filter(Boolean));
    return out;
  }
  if (Array.isArray(v)) { for (const x of v) instructionLines(x, out, depth + 1); return out; }
  if (typeof v === 'object') {
    const o = v as Record<string, unknown>;
    if (/HowToSection/i.test(String(o['@type'] ?? ''))) {
      const name = clean(o.name);
      if (name) out.push(`**${name}**`);
      instructionLines(o.itemListElement, out, depth + 1);
      return out;
    }
    const text = clean(o.text) || clean(o.name) || clean(o.description);
    if (text) out.push(text);
    else if (o.itemListElement) instructionLines(o.itemListElement, out, depth + 1);
  }
  return out;
}

function authorName(v: unknown): string {
  if (Array.isArray(v)) return v.map(authorName).filter(Boolean).join(', ');
  if (v && typeof v === 'object') return clean((v as Record<string, unknown>).name);
  return clean(v);
}

/** The page's schema.org Recipe (first one found), or null. Image fields are ignored. */
export function extractJsonLdRecipe(html: string): JsonLdRecipe | null {
  for (const m of html.matchAll(LD_SCRIPT)) {
    const node = findRecipeNode(parseLd(m[1] ?? ''));
    if (!node) continue;
    const ingRaw = node.recipeIngredient ?? node.ingredients;
    const ingredients = (Array.isArray(ingRaw) ? ingRaw : typeof ingRaw === 'string' ? ingRaw.split(/\n+/) : []).map(clean).filter(Boolean);
    const instructions = instructionLines(node.recipeInstructions);
    const y = node.recipeYield;
    const yields = [...new Set((Array.isArray(y) ? y : [y]).map(clean).filter(Boolean))].join(' / ');
    let nutrition: Record<string, string> | undefined;
    if (node.nutrition && typeof node.nutrition === 'object' && !Array.isArray(node.nutrition)) {
      const n = Object.entries(node.nutrition as Record<string, unknown>)
        .filter(([k]) => !k.startsWith('@')).map(([k, v]) => [k, clean(v)] as const).filter(([, v]) => v);
      if (n.length) nutrition = Object.fromEntries(n);
    }
    const r: JsonLdRecipe = { name: clean(node.name) || clean(node.headline), ingredients, instructions };
    const desc = clean(node.description); if (desc) r.description = desc.slice(0, 600);
    const au = authorName(node.author); if (au) r.author = au;
    if (yields) r.yield = yields;
    const pt = durationMin(node.prepTime); if (pt) r.prepTimeMin = pt;
    const ct = durationMin(node.cookTime); if (ct) r.cookTimeMin = ct;
    const tt = durationMin(node.totalTime); if (tt) r.totalTimeMin = tt;
    const cu = cleanList(node.recipeCuisine); if (cu) r.cuisine = cu;
    const ca = cleanList(node.recipeCategory); if (ca) r.category = ca;
    if (nutrition) r.nutrition = nutrition;
    return r;
  }
  return null;
}

/** Readable text of a page: scripts/styles/nav/chrome stripped, block breaks kept, whitespace collapsed, capped. */
export function readableText(html: string, cap = TEXT_CAP): { title: string; text: string } {
  const title = clean(/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '');
  const flatten = (src: string) => {
    let s = src.replace(/<!--[\s\S]*?-->/g, ' ');
    s = s.replace(/<(script|style|noscript|svg|nav|header|footer|aside|form|iframe|template|button|select|dialog)\b[\s\S]*?<\/\1\s*>/gi, ' ');
    s = s.replace(/<(?:br|hr)\b[^>]*>/gi, '\n')
      .replace(/<\/?(?:p|div|li|ul|ol|h[1-6]|tr|td|th|section|article|main|table|blockquote|figure|figcaption|dd|dt|dl)\b[^>]*>/gi, '\n');
    s = decodeEntities(s.replace(/<[^>]+>/g, ' '));
    return s.split('\n').map((l) => l.replace(/[ \t ​]+/g, ' ').trim()).filter(Boolean).join('\n');
  };
  // prefer the article/main region when it carries real content
  let text = '';
  for (const tag of ['article', 'main']) {
    const a = html.search(new RegExp(`<${tag}\\b`, 'i'));
    const b = html.toLowerCase().lastIndexOf(`</${tag}>`);
    if (a >= 0 && b > a) {
      const t = flatten(html.slice(a, b));
      if (t.length >= MIN_TEXT_CHARS) { text = t; break; }
    }
  }
  if (!text) {
    const body = /<body\b[^>]*>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
    text = flatten(body);
  }
  return { title, text: text.length > cap ? `${text.slice(0, cap)}\n[…truncated at ${cap} characters]` : text };
}

const recipeComplete = (r: JsonLdRecipe | null): r is JsonLdRecipe => !!r && r.ingredients.length >= 2 && r.instructions.length >= 1;

// ---------- fetching ----------

function blockedHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!h || h === 'localhost' || /\.(localhost|local|internal|lan|home|test|ts\.net)$/.test(h)) return true;
  if (h.includes(':')) return true; // IPv6 literals: no recipe site needs one
  const v4 = /^(\d+)\.(\d+)\.(\d+)\.(\d+)$/.exec(h);
  if (v4) {
    const a = Number(v4[1]), b = Number(v4[2]);
    return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  return false;
}

export function checkUrl(raw: string): URL {
  let u: URL;
  try { u = new URL(raw.trim()); } catch { throw new ImportError(400, 'That doesn’t look like a web address.'); }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ImportError(400, 'Only http(s) links can be imported.');
  if (blockedHost(u.hostname)) throw new ImportError(400, 'That address is on a private network; only public recipe pages can be fetched.');
  return u;
}

// A phone Chrome navigation's headers. Some recipe sites (Dotdash Meredith:
// Serious Eats, Allrecipes, Simply Recipes) 403 a request without the
// sec-fetch-* set, AND any HTTP/1.1 request (seen 2026-10-11), which is all
// Node's built-in fetch speaks; so https pages go over node:http2 first and
// fall back to fetch only when the server has no HTTP/2. Cloudflare-fronted
// sites (Budget Bytes) may still block a non-browser client: the UI then says
// to share a PDF or screenshot.
const BROWSER_HEADERS: Record<string, string> = {
  'user-agent': UA,
  accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
  'sec-ch-ua': '"Chromium";v="129", "Not=A?Brand";v="8", "Google Chrome";v="129"',
  'sec-ch-ua-mobile': '?1',
  'sec-ch-ua-platform': '"Android"',
  'sec-fetch-dest': 'document',
  'sec-fetch-mode': 'navigate',
  'sec-fetch-site': 'none',
  'sec-fetch-user': '?1',
  'upgrade-insecure-requests': '1',
};

interface RawResponse { status: number; contentType: string; location?: string; body: Buffer }
class PageTooBig extends Error {}
const isTimeout = (e: unknown) => e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');

function decodeBody(buf: Buffer, enc: string): Buffer {
  const opts = { maxOutputLength: MAX_PAGE_BYTES * 4 };
  switch (enc.trim().toLowerCase()) {
    case 'gzip': case 'x-gzip': return zlib.gunzipSync(buf, opts);
    case 'deflate': return zlib.inflateSync(buf, opts);
    case 'br': return zlib.brotliDecompressSync(buf, opts);
    default: return buf;
  }
}

/** One GET over HTTP/2 (no redirect following). Rejects on connection-level failure, e.g. a server without h2. */
function h2Get(u: URL, signal: AbortSignal): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let session: http2.ClientHttp2Session | null = null;
    const settle = (err: Error | null, val?: RawResponse) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      session?.close();
      if (err) reject(err); else resolve(val!);
    };
    const onAbort = () => { session?.destroy(); settle(Object.assign(new Error('timed out'), { name: 'TimeoutError' })); };
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    session = http2.connect(u.origin);
    session.on('error', (e) => settle(e));
    const req = session.request({ ':method': 'GET', ':path': `${u.pathname}${u.search}`, ...BROWSER_HEADERS, 'accept-encoding': 'gzip, deflate, br' });
    req.on('error', (e) => settle(e));
    req.on('response', (h) => {
      const chunks: Buffer[] = [];
      let size = 0;
      req.on('data', (c: Buffer) => {
        size += c.length;
        if (size > MAX_PAGE_BYTES) { req.close(); settle(new PageTooBig()); return; }
        chunks.push(c);
      });
      req.on('end', () => {
        try {
          settle(null, {
            status: Number(h[':status']),
            contentType: String(h['content-type'] ?? ''),
            ...(typeof h.location === 'string' ? { location: h.location } : {}),
            body: decodeBody(Buffer.concat(chunks), String(h['content-encoding'] ?? '')),
          });
        } catch (e) { settle(e instanceof Error ? e : new Error(String(e))); }
      });
    });
    req.end();
  });
}

/** The HTTP/1.1 fallback (Node fetch), also without redirect following. */
async function fetchGet(u: URL, signal: AbortSignal): Promise<RawResponse> {
  const res = await fetch(u, { redirect: 'manual', signal, headers: BROWSER_HEADERS });
  const chunks: Uint8Array[] = [];
  let size = 0;
  const reader = res.body?.getReader();
  if (reader) {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PAGE_BYTES) { await reader.cancel().catch(() => {}); throw new PageTooBig(); }
      chunks.push(value);
    }
  }
  const location = res.headers.get('location');
  return { status: res.status, contentType: res.headers.get('content-type') ?? '', ...(location ? { location } : {}), body: Buffer.concat(chunks) };
}

async function fetchPage(u: URL): Promise<{ finalUrl: string; html: string }> {
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS); // covers every hop and body
  let cur = u;
  for (let hop = 0; hop < 6; hop++) {
    if (hop && blockedHost(cur.hostname)) throw new ImportError(400, 'That link redirects to a private address.');
    let res: RawResponse;
    try {
      res = cur.protocol === 'https:'
        ? await h2Get(cur, signal).catch((e) => { if (isTimeout(e) || e instanceof PageTooBig) throw e; return fetchGet(cur, signal); })
        : await fetchGet(cur, signal);
    } catch (e) {
      if (e instanceof PageTooBig) throw new ImportError(413, `That page is over ${MAX_PAGE_BYTES / 1024 / 1024} MB; it isn’t a recipe page.`);
      throw new ImportError(502, isTimeout(e) ? `That page took longer than ${FETCH_TIMEOUT_MS / 1000} s to answer.` : `Couldn’t reach that page (${e instanceof Error ? e.message : String(e)}).`);
    }
    if (res.status >= 300 && res.status < 400 && res.location) {
      try { cur = new URL(res.location, cur); } catch { throw new ImportError(502, 'That page redirects somewhere unreadable.'); }
      if (cur.protocol !== 'http:' && cur.protocol !== 'https:') throw new ImportError(502, 'That page redirects somewhere unreadable.');
      continue;
    }
    if (res.status < 200 || res.status >= 300) {
      const locked = res.status === 401 || res.status === 402 || res.status === 403;
      throw new ImportError(502, `That page answered ${res.status}${locked ? ' (it blocks automated fetches or needs a login)' : ''}. ${PAYWALL_HINT}`);
    }
    if (res.contentType && !/html|xml|text\/plain/i.test(res.contentType)) {
      throw new ImportError(415, `That link is ${res.contentType.split(';')[0]}, not a web page. If it’s a PDF or photo, save it and use “Choose a file”.`);
    }
    return { finalUrl: cur.href, html: res.body.toString('utf8') };
  }
  throw new ImportError(502, 'That link redirects too many times.');
}

/** Fetch + reduce a recipe page. Throws ImportError (with UI-ready copy) when nothing usable comes back. */
export async function extractFromUrl(raw: string): Promise<{ url: string; title: string; extraction: 'json-ld' | 'text'; recipe?: JsonLdRecipe; text?: string }> {
  const u = checkUrl(raw);
  const { finalUrl, html } = await fetchPage(u);
  const recipe = extractJsonLdRecipe(html);
  const { title, text } = readableText(html);
  if (recipeComplete(recipe)) return { url: finalUrl, title: recipe.name || title, extraction: 'json-ld', recipe };
  const nyt = /(^|\.)nytimes\.com$/i.test(new URL(finalUrl).hostname);
  if (nyt || text.length < MIN_TEXT_CHARS) {
    throw new ImportError(422, `Couldn’t read a full recipe from that page${nyt ? ' (NYT Cooking is paywalled to the server)' : ' (it may be paywalled or built with JavaScript)'}. ${PAYWALL_HINT}`);
  }
  return { url: finalUrl, title, extraction: 'text', text };
}

// ---------- records ----------

const recFile = (id: string) => path.join(importsDir, `${id}.json`);
const txtFile = (id: string) => path.join(importsDir, `${id}.txt`);
export const IMPORT_ID = /^[A-Za-z0-9_-]{6,24}$/;
const newId = () => crypto.randomBytes(6).toString('base64url');

async function writeAtomic(file: string, data: string) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try { await fs.writeFile(tmp, data); await fs.rename(tmp, file); }
  catch (e) { await fs.unlink(tmp).catch(() => {}); throw e; }
}

export async function saveRecord(rec: ImportRecord): Promise<void> {
  await writeAtomic(recFile(rec.id), JSON.stringify(rec, null, 2) + '\n');
}

export async function readRecord(id: string): Promise<ImportRecord | null> {
  if (!IMPORT_ID.test(id)) return null;
  try { return JSON.parse(await fs.readFile(recFile(id), 'utf8')) as ImportRecord; } catch { return null; }
}

/** Newest first. A record left `running` with no import run in flight (server restart) is marked failed. */
export async function listRecords(): Promise<ImportRecord[]> {
  let names: string[] = [];
  try { names = (await fs.readdir(importsDir)).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out: ImportRecord[] = [];
  for (const n of names) {
    try { out.push(JSON.parse(await fs.readFile(path.join(importsDir, n), 'utf8')) as ImportRecord); } catch { /* skip */ }
  }
  for (const r of out) {
    if (r.status === 'running' && active?.id !== r.id && !(run && run.type === 'import')) {
      r.status = 'failed';
      r.error = 'Interrupted (the server restarted mid-run).';
      await saveRecord(r).catch(() => {});
    }
  }
  return out.sort((a, b) => b.at - a.at);
}

const removeUploadFile = async (abs: string) => { if (path.dirname(abs) === uploadsDir) await fs.unlink(abs).catch(() => {}); };

/** Keep the newest MAX_RECORDS; older records go with their text and (upload-owned) files. Share files belong to shares. */
async function evict(): Promise<void> {
  const all = await listRecords();
  for (const r of all.slice(MAX_RECORDS)) {
    await fs.unlink(recFile(r.id)).catch(() => {});
    await fs.unlink(txtFile(r.id)).catch(() => {});
    if (r.kind === 'upload') await Promise.all((r.files ?? []).map((f) => removeUploadFile(f.abs)));
  }
}

async function newRecord(fields: Omit<ImportRecord, 'id' | 'at' | 'status'>, text?: string): Promise<ImportRecord> {
  const rec: ImportRecord = { id: newId(), at: Date.now(), status: 'saved', ...fields };
  if (text !== undefined) { await writeAtomic(txtFile(rec.id), text); rec.textChars = text.length; }
  await saveRecord(rec);
  void evict();
  return rec;
}

/** What the browser sees: no absolute paths, no inline page text. */
export function publicRecord(r: ImportRecord) {
  return {
    id: r.id, at: r.at, by: r.by, kind: r.kind, url: r.url, title: r.title, shareId: r.shareId,
    name: r.recipe?.name, extraction: r.extraction, textChars: r.textChars,
    files: (r.files ?? []).map((f) => ({ name: f.name, type: f.type, size: f.size })),
    status: r.status, runAt: r.runAt, doneAt: r.doneAt, error: r.error,
    recipeFile: r.recipeFile, recipeExists: r.recipeExists, summaryHtml: r.summaryHtml,
  };
}

export async function recordFromUrl(raw: string, by?: string): Promise<ImportRecord> {
  const ex = await extractFromUrl(raw);
  return newRecord({
    kind: 'url', url: ex.url, title: ex.title, extraction: ex.extraction,
    ...(ex.recipe ? { recipe: ex.recipe } : {}), ...(by ? { by } : {}),
  }, ex.text);
}

const firstUrl = (s?: string) => /https?:\/\/[^\s<>"')\]]+/i.exec(s ?? '')?.[0];

export async function recordFromShare(shareId: string, by?: string): Promise<ImportRecord> {
  const share = (await loadShares()).find((s) => s.id === shareId);
  if (!share) throw new ImportError(404, 'That shared item is gone (deleted, or pushed out by newer shares).');
  const base = { kind: 'share' as const, shareId, ...(share.title ? { title: share.title } : {}), ...(by ? { by } : {}) };
  if (share.files.length) {
    const files: ImportFile[] = [];
    for (const f of share.files) {
      const abs = path.resolve(repoRoot, f.path);
      try { await fs.access(abs); } catch { throw new ImportError(410, 'The shared file is missing from the uploads folder; share it again.'); }
      files.push({ abs, name: path.basename(abs), type: f.type, size: f.size });
    }
    return newRecord({ ...base, files, ...(share.text ? { text: share.text } : {}), ...(share.url ? { url: share.url } : {}) });
  }
  const link = share.url ?? firstUrl(share.text);
  if (link) {
    const ex = await extractFromUrl(link);
    return newRecord({
      ...base, url: ex.url, title: share.title || ex.title, extraction: ex.extraction, ...(ex.recipe ? { recipe: ex.recipe } : {}),
    }, ex.text);
  }
  if (share.text && share.text.trim().length >= 80) return newRecord({ ...base, text: share.text.trim() });
  throw new ImportError(400, 'That share has no file, link, or recipe text to import.');
}

// ---------- uploads (multipart, from the tab) ----------

interface Incoming { tmp: string; name: string; type: string; size: number; ext: string }

/** Receive 1–3 images/PDFs (field name `files`) into uploadsDir; all-or-nothing. Resolves to the new record. */
export function receiveUpload(req: express.Request, by?: string): Promise<ImportRecord> {
  return new Promise((resolve, reject) => {
    if (!req.is('multipart/form-data')) return reject(new ImportError(415, 'Expected a multipart/form-data upload.'));
    let bb: busboy.Busboy;
    try {
      bb = busboy({ headers: req.headers, limits: { files: MAX_FILES, fileSize: MAX_FILE_BYTES, fields: 4, fieldSize: 8 * 1024, parts: MAX_FILES + 4 } });
    } catch { return reject(new ImportError(400, 'That upload was malformed.')); }

    const incoming: Incoming[] = [];
    const temps: string[] = [];
    const writes: Promise<void>[] = [];
    let failure: ImportError | null = null;
    const fail = (status: number, msg: string) => { failure ??= new ImportError(status, msg); };
    const ready = fs.mkdir(uploadsDir, { recursive: true });

    const receive = async (stream: Readable, info: busboy.FileInfo): Promise<void> => {
      const shown = info.filename || 'that file';
      const mime = (info.mimeType || '').toLowerCase();
      if (mime && !(mime.startsWith('image/') || mime === 'application/pdf' || mime === 'application/octet-stream')) {
        fail(415, `${shown}: only photos and PDFs can be imported.`);
        stream.resume();
        return;
      }
      await ready;
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
      try { await pipeline(stream, sniffer, createWriteStream(tmp, { flags: 'wx' })); }
      catch { fail(400, `${shown} didn’t arrive in full; try again.`); return; }
      if (truncated) return fail(413, `${shown} is over ${MAX_FILE_BYTES / 1024 / 1024} MB.`);
      if (!size) return fail(400, `${shown} is empty.`);
      const kind = sniff(head);
      if (!kind) return fail(415, `${shown}: only photos and PDFs can be imported.`);
      incoming.push({ tmp, name: safeName(info.filename || 'recipe', kind), type: kind.type, size, ext: kind.ext[0]! });
    };

    let finished = false;
    const finish = async () => {
      if (finished) return;
      finished = true;
      await Promise.all(writes);
      const dropTemps = () => Promise.all(temps.map((t) => fs.unlink(t).catch(() => {})));
      if (!failure && !incoming.length) fail(400, 'Pick a photo or PDF first.');
      if (failure) { await dropTemps(); return reject(failure); }
      const placed: string[] = [];
      try {
        const d = new Date();
        const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}-${String(d.getHours()).padStart(2, '0')}${String(d.getMinutes()).padStart(2, '0')}${String(d.getSeconds()).padStart(2, '0')}`;
        const files: ImportFile[] = [];
        for (const f of incoming) {
          const abs = await placeFile(f.tmp, `import-${stamp}-${f.name}`);
          placed.push(abs);
          files.push({ abs, name: path.basename(abs), type: f.type, size: f.size });
        }
        const rec = await newRecord({ kind: 'upload', files, title: incoming.map((f) => f.name).join(', '), ...(by ? { by } : {}) });
        console.log(`[import] upload ${rec.id}${by ? ` from ${by}` : ''}: ${files.length} file(s)`);
        resolve(rec);
      } catch (e) {
        await dropTemps();
        await Promise.all(placed.map((p) => fs.unlink(p).catch(() => {})));
        console.error('[import] upload save failed:', e);
        reject(new ImportError(500, 'The server couldn’t save that upload.'));
      }
    };

    bb.on('file', (_name, stream, info) => {
      if (failure) { stream.resume(); return; }
      writes.push(receive(stream, info));
    });
    bb.on('filesLimit', () => fail(413, `At most ${MAX_FILES} files per import.`));
    bb.on('partsLimit', () => fail(413, 'Too many parts in that upload.'));
    bb.on('error', () => { fail(400, 'That upload was malformed.'); req.unpipe(bb); req.resume(); void finish(); });
    bb.on('close', () => { void finish(); });
    req.pipe(bb);
  });
}

// ---------- the run's {{IMPORT_SOURCE}} ----------

const mb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const dayOf = (at: number) => {
  const d = new Date(at);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/**
 * The block the import prompt receives. First line is always `Title: …` (the
 * mock summary reads it). URL imports carry the extraction inline; file
 * imports name absolute paths for the run's Read tool.
 */
export async function sourceBlock(rec: ImportRecord): Promise<string> {
  const day = dayOf(rec.at);
  const title = rec.recipe?.name || rec.title || rec.files?.[0]?.name || 'Untitled recipe';
  const lines = [`Title: ${title}`];
  if (rec.by) lines.push(`Imported by: ${rec.by}`);
  if (rec.files?.length) {
    const what = rec.files.every((f) => f.type === 'application/pdf') ? 'PDF' : rec.files.every((f) => f.type.startsWith('image/')) ? (rec.files.length > 1 ? 'photos' : 'photo') : 'files';
    const how = rec.kind === 'share' ? 'shared to the app from the phone' : 'uploaded in the app';
    lines.push(`Kind: user-supplied ${what}, ${how} on ${day}. Frontmatter source line starts: \`user-supplied ${what === 'PDF' ? 'PDF' : 'photo'}, imported ${fmtISO(todayUTC())}\` (add the publication/author if the file shows one).`);
    lines.push(`Read ${rec.files.length > 1 ? 'these files, in order, as one recipe' : 'this file'} with your Read tool (it reads images and PDFs):`);
    for (const f of rec.files) lines.push(`- ${f.abs} (${f.type}, ${mb(f.size)})`);
    if (rec.text) lines.push(`Text that came with the share: ${rec.text.slice(0, 1000)}`);
    if (rec.url) lines.push(`Link that came with the share: ${rec.url}`);
    return lines.join('\n');
  }
  if (rec.url && rec.extraction === 'json-ld' && rec.recipe) {
    lines.push(`Kind: web page, reduced server-side (no model) to its schema.org JSON-LD Recipe data. Frontmatter source line starts with the URL.`);
    lines.push(`URL: ${rec.url}`, `Fetched: ${day}`, 'Extraction:', '```json', JSON.stringify(rec.recipe, null, 2), '```');
    return lines.join('\n');
  }
  if (rec.url && rec.extraction === 'text') {
    let text = '';
    try { text = await fs.readFile(txtFile(rec.id), 'utf8'); } catch { /* missing text file: say so below */ }
    lines.push('Kind: web page with no structured recipe data; below is its readable text (scripts, styles and navigation stripped, whitespace collapsed, capped at 20,000 characters). It can include ads, comments and related-recipe teasers: use only the recipe itself. Frontmatter source line starts with the URL.');
    lines.push(`URL: ${rec.url}`, `Fetched: ${day}`, '--- page text ---', text || '(the saved page text is missing)', '--- end page text ---');
    return lines.join('\n');
  }
  lines.push(`Kind: recipe text shared to the app on ${day}. Frontmatter source line starts: \`user-supplied text, imported ${fmtISO(todayUTC())}\`.`);
  lines.push('--- shared text ---', rec.text ?? '', '--- end shared text ---');
  return lines.join('\n');
}

// ---------- run bookkeeping ----------

let active: { id: string; before: Set<string> } | null = null;

export async function recipeFiles(): Promise<Set<string>> {
  try { return new Set((await fs.readdir(recipesDir)).filter((f) => f.endsWith('.md') && f !== 'README.md')); }
  catch { return new Set(); }
}

/** Synchronous so the route can mark + start the run in one tick after its last guard. */
export function markRunning(rec: ImportRecord, before: Set<string>): void {
  active = { id: rec.id, before };
  rec.status = 'running';
  rec.runAt = Date.now();
  delete rec.error;
  delete rec.recipeFile;
  delete rec.recipeExists;
  delete rec.summaryHtml;
  void saveRecord(rec).catch((e) => console.error('[import] could not save record:', e));
}

let inited = false;
/** Subscribe once to run completions: record what the import run wrote. */
export function initImports(): void {
  if (inited) return;
  inited = true;
  onRunDone(async (info) => {
    if (info.type !== 'import' || !active) return;
    const { id, before } = active;
    active = null;
    const rec = await readRecord(id);
    if (!rec) return;
    const now = await recipeFiles();
    const fresh = [...now].filter((f) => !before.has(f));
    let file: string | undefined;
    if (fresh.length) {
      const stamped = await Promise.all(fresh.map(async (f) => ({ f, t: (await fs.stat(path.join(recipesDir, f)).catch(() => null))?.mtimeMs ?? 0 })));
      file = stamped.sort((a, b) => b.t - a.t)[0]!.f;
    } else {
      file = /recipes\/([A-Za-z0-9][A-Za-z0-9._-]*\.md)/.exec(info.summaryMd)?.[1];
    }
    rec.status = info.ok ? 'done' : 'failed';
    rec.doneAt = Date.now();
    if (file) { rec.recipeFile = file; rec.recipeExists = now.has(file); }
    if (!info.ok) rec.error = info.summaryMd.slice(0, 500);
    rec.summaryHtml = String(marked.parse(info.summaryMd));
    await saveRecord(rec);
    broadcast({ type: 'state-updated' }); // the record usually lands after the run's own state-updated
  });
}
