// Pantry editor core: parse profile/pantry.md into something the UI can render,
// and apply deterministic edits to the file's text. Pure functions on strings —
// no fs, no git, no routes. The server reads the file, applies ONE edit, writes
// it back and commits; every byte the edit doesn't own is preserved.
//
// ---------------------------------------------------------------------------
// File model (profile/pantry.md is the spec)
// ---------------------------------------------------------------------------
// - Everything before the first `## ` heading (title, intro prose, the
//   blockquote) is preamble: opaque, never parsed into items, never touched.
// - A `## Name` line starts a section, which runs until the next `#` or `##`
//   heading (or EOF). Inside a section, `###`+ headings, HTML comments (incl.
//   multi-line), fenced code, blockquotes, ordered lists, thematic breaks,
//   blank lines and prose are opaque and preserved untouched.
// - An item is a top-level bullet (`- `, `* ` or `+ ` at column 0) plus its
//   continuation lines: indented lines and lazy (unindented plain-text) lines
//   directly below it, and indented blocks after a blank line (a loose list
//   item's second paragraph). Nested sub-bullets therefore belong to their
//   parent item. Every item in the real file is a single line.
// - Edits only rewrite the lines of the targeted item, or insert new lines.
//   CRLF files stay CRLF; the trailing-newline state is kept.
//
// ---------------------------------------------------------------------------
// Conventions (exact strings: prompts and humans can rely on them)
// ---------------------------------------------------------------------------
// added  `- <text> (added YYYY-MM-DD via app)`             addItem, freezerAdd
//        Appended as the last item of its section; a missing section is
//        created at the end of the file as `## <name>`.
// low    `<item's last line> ⚠️ low (YYYY-MM-DD)`          setLow(…, true, date)
//        The date is the day it was marked. One space, U+26A0 U+FE0F, ` low (`,
//        the date, `)`, at the very end of the item (trailing whitespace after
//        it is tolerated). Parsing also accepts it without U+FE0F. Clearing
//        removes exactly ` ⚠️ low (YYYY-MM-DD)` and nothing else. A `**⚠️ …**`
//        warning elsewhere in an item is just prose, never a low marker.
// used   `- ~~<text>~~ — used YYYY-MM-DD` [+ ` (<note>)`]   freezerUse
//        The same shape as the hand-written
//        `~~…~~ — cooked 2026-07-27 (W31 Mon rice bowl)` entries. An item
//        whose content starts with `~~` and has a closing `~~` parses as
//        used; whatever follows the closing `~~` (minus one leading `—`/`–`)
//        is `usedNote`, kept verbatim (`cooked …`, `eaten …`, `retired …`).
//        A low marker is dropped when an item is marked used.
//
// ---------------------------------------------------------------------------
// Ids
// ---------------------------------------------------------------------------
// id = slug(text), the server's djb2 checkbox-key scheme (lowercase slug of
// the text + base36 hash). `text` is the item's raw markdown with the
// app-managed state (low marker, used strikethrough + note) taken out. Bold,
// provenance parens and warnings all stay in. So:
//   - toggling low or marking used keeps the id, which makes retries no-ops
//     (setLow twice = once, freezerUse twice = once);
//   - any change to the item's words gives a new id, so an edit from a stale
//     UI fails with "no item with id" and can't hit the wrong line;
//   - identical texts get `-2`, `-3`, … in file order (stable unless an
//     earlier duplicate is removed).

export interface PantryItem {
  id: string;
  /** Item markdown with the strikethrough, low marker and used-note removed. Inline markdown is kept. */
  text: string;
  used: boolean;
  /** What follows `~~…~~ —`, verbatim markdown (e.g. `cooked 2026-07-27 (W31 Mon rice bowl)`). */
  usedNote?: string;
  low: boolean;
  /** YYYY-MM-DD from the low marker. */
  lowSince?: string;
  /** 1-based line number of the item's bullet line. */
  line: number;
}
export interface PantrySection { name: string; items: PantryItem[]; isFreezer: boolean }
export interface Pantry { sections: PantrySection[] }

const LOW_MARK = '⚠️ low';
/** The exact suffix setLow appends. */
export function lowSuffix(dateISO: string): string { return ` ${LOW_MARK} (${dateISO})`; }
/** The exact suffix addItem/freezerAdd append to the new item's text. */
export function addedSuffix(dateISO: string): string { return ` (added ${dateISO} via app)`; }
/** The exact tail freezerUse puts after the closing `~~`. */
export function usedSuffix(dateISO: string, note?: string): string {
  return ` — used ${dateISO}${note ? ` (${note})` : ''}`;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// Matched against one line's body (CR stripped); only one match position is possible.
const LOW_RE = /[ \t]⚠️? low \((\d{4}-\d{2}-\d{2})\)(?=[ \t]*$)/;
const BULLET_RE = /^[-*+][ \t]+(?=\S)/;
const HR_RE = /^ {0,3}([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const FENCE_RE = /^(`{3,}|~{3,})/;
const HEADING_RE = /^(#{1,6})(?:[ \t]|$)/;
// A line that would start a new block, so it can't lazily continue an item.
const BLOCK_START_RE = /^(?:[#>|<]|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$)|`{3,}|~{3,})/;

// Same as the server's checkbox-key slug (server/index.ts); copied, not imported.
function slug(text: string): string {
  const base = text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  let h = 5381;
  for (let i = 0; i < text.length; i++) h = ((h << 5) + h + text.charCodeAt(i)) | 0;
  return `${base || 'item'}-${(h >>> 0).toString(36)}`;
}

// ---------- scanning ----------

interface RawItem { start: number; end: number; prefix: string; parsed: PantryItem }
interface RawSection { name: string; heading: number; end: number; isFreezer: boolean; items: RawItem[] }
interface Scan {
  lines: string[];
  cr: '' | '\r';
  sections: RawSection[];
  /** The file ends inside an unclosed fence or HTML comment. */
  unclosed: boolean;
}

function body(line: string): string { return line.endsWith('\r') ? line.slice(0, -1) : line; }
function crOf(line: string): string { return line.endsWith('\r') ? '\r' : ''; }
const isBlank = (line: string) => body(line).trim() === '';

function headingName(b: string): string {
  return b.replace(/^##[ \t]*/, '').replace(/[ \t]+#+[ \t]*$/, '').trim();
}

/** The low marker on an item, if any: always on the item's last line, after some real content. */
function lowMatch(lines: string[], it: { start: number; end: number; prefix: string }): RegExpExecArray | null {
  const b = body(lines[it.end]!);
  const m = LOW_RE.exec(b);
  if (!m) return null;
  const from = it.end === it.start ? it.prefix.length : 0;
  return b.slice(from, m.index).trim() ? m : null;
}

function readItem(lines: string[], it: { start: number; end: number; prefix: string }) {
  const low = lowMatch(lines, it);
  const parts: string[] = [];
  for (let i = it.start; i <= it.end; i++) {
    let b = body(lines[i]!);
    if (i === it.end && low) b = b.slice(0, low.index) + b.slice(low.index + low[0].length);
    if (i === it.start) b = b.slice(it.prefix.length);
    if (b.trim()) parts.push(b.trim());
  }
  const joined = parts.join(' ');
  const u = /^~~([\s\S]+?)~~([\s\S]*)$/.exec(joined);
  const used = !!u && u[1]!.trim() !== '';
  const text = used ? u![1]!.trim() : joined;
  const usedNote = used ? u![2]!.replace(/^\s*(?:[—–]|-(?=\s))\s*/, '').trim() || undefined : undefined;
  return { text, used, usedNote, low: !!low, lowSince: low?.[1] };
}

function scan(raw: string): Scan {
  const lines = raw.split('\n');
  const cr: '' | '\r' = raw.includes('\r\n') ? '\r' : '';
  const sections: RawSection[] = [];
  let sec: RawSection | null = null;
  let item: Omit<RawItem, 'parsed'> | null = null;
  let afterBlank = false; // blank line(s) since the open item's last line
  let fence: string | null = null;
  let inComment = false;
  const bare: Array<{ sec: RawSection; it: Omit<RawItem, 'parsed'> }> = [];

  for (let i = 0; i < lines.length; i++) {
    const b = body(lines[i]!);
    if (fence !== null) {
      const close = FENCE_RE.exec(b);
      if (close && close[1]![0] === fence[0] && close[1]!.length >= fence.length && b.slice(close[1]!.length).trim() === '') fence = null;
      continue;
    }
    if (inComment) { if (b.includes('-->')) inComment = false; continue; }
    if (b.trim() === '') { if (item) afterBlank = true; continue; }

    if (item) {
      const indent = /^[ \t]+/.exec(b)?.[0] ?? '';
      if (!afterBlank && indent) { item.end = i; continue; }
      if (afterBlank && (indent.includes('\t') || indent.length >= item.prefix.length)) { item.end = i; afterBlank = false; continue; }
      if (!afterBlank && !BLOCK_START_RE.test(b) && !HR_RE.test(b)) { item.end = i; continue; } // lazy continuation
      item = null;
      afterBlank = false;
    }

    const f = FENCE_RE.exec(b);
    if (f) { fence = f[1]!; continue; }
    if (b.startsWith('<!--')) { if (!b.includes('-->', 4)) inComment = true; continue; }
    const h = HEADING_RE.exec(b);
    if (h) {
      const level = h[1]!.length;
      if (level <= 2 && sec) { sec.end = i; sec = null; }
      if (level === 2) {
        const name = headingName(b);
        sec = { name, heading: i, end: lines.length, isFreezer: /\bfreezer\b/i.test(name), items: [] };
        sections.push(sec);
      }
      continue;
    }
    if (sec && !HR_RE.test(b)) {
      const m = BULLET_RE.exec(b);
      if (m) { item = { start: i, end: i, prefix: m[0] }; bare.push({ sec, it: item }); continue; }
    }
    // anything else is opaque
  }

  const seen = new Map<string, number>();
  for (const { sec: s, it } of bare) {
    const r = readItem(lines, it);
    const base = slug(r.text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    const parsed: PantryItem = { id: n === 1 ? base : `${base}-${n}`, text: r.text, used: r.used, low: r.low, line: it.start + 1 };
    if (r.usedNote !== undefined) parsed.usedNote = r.usedNote;
    if (r.lowSince !== undefined) parsed.lowSince = r.lowSince;
    s.items.push({ ...it, parsed });
  }
  return { lines, cr, sections, unclosed: fence !== null || inComment };
}

// ---------- public: parse ----------

export function parsePantry(raw: string): Pantry {
  return {
    sections: scan(raw).sections.map((s) => ({ name: s.name, isFreezer: s.isFreezer, items: s.items.map((i) => i.parsed) })),
  };
}

// ---------- edit helpers ----------

function assertDate(dateISO: string): void {
  if (typeof dateISO !== 'string' || !DATE_RE.test(dateISO)) {
    throw new Error(`pantry: date must be YYYY-MM-DD, got ${JSON.stringify(dateISO)}`);
  }
}

function oneLine(value: string, what: string): string {
  const v = typeof value === 'string' ? value.trim() : '';
  if (!v || /[\r\n]/.test(v)) throw new Error(`pantry: ${what} must be a non-empty single line, got ${JSON.stringify(value)}`);
  return v;
}

const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();

function locate(raw: string, id: string) {
  const s = scan(raw);
  for (const sec of s.sections) {
    for (const it of sec.items) if (it.parsed.id === id) return { s, sec, it };
  }
  throw new Error(`pantry: no item with id ${JSON.stringify(id)} (the file may have changed — re-read it)`);
}

/** Insert line bodies at index k, giving them the file's line ending. */
function insertAt(s: Scan, k: number, bodies: string[]): string {
  const lines = s.lines.slice();
  if (k === lines.length) {
    // after an unterminated last line: it gains a terminator, the new last line has none
    lines[k - 1] = lines[k - 1]! + s.cr;
    lines.push(...bodies.map((b, j) => (j === bodies.length - 1 ? b : b + s.cr)));
  } else {
    lines.splice(k, 0, ...bodies.map((b) => b + s.cr));
  }
  return lines.join('\n');
}

// ---------- public: edits ----------

/**
 * Append `- <text> (added <date> via app)` as the last item of the section
 * (matched by name, case- and whitespace-insensitive). It goes right after
 * the section's last item, so blank lines before the next heading stay put;
 * in a section with no items it goes after the last non-blank line. A missing
 * section is created at the end of the file. Idempotent: if that exact item
 * line is already in the section (same text, same date), raw comes back unchanged.
 */
export function addItem(raw: string, sectionName: string, text: string, dateISO: string): string {
  const name = oneLine(sectionName, 'section name');
  const t = oneLine(text, 'item text');
  assertDate(dateISO);
  const itemText = t + addedSuffix(dateISO);
  const line = `- ${itemText}`;
  const s = scan(raw);
  const sec = s.sections.find((x) => norm(x.name) === norm(name));

  if (!sec) {
    if (s.unclosed) throw new Error('pantry: file ends inside an unclosed code fence or HTML comment; refusing to append a section');
    let last = s.lines.length - 1;
    while (last >= 0 && isBlank(s.lines[last]!)) last--;
    if (last < 0) return insertAt(s, 0, [`## ${name}`, line]); // blank file: '' → "## name\n- item\n"
    return insertAt(s, last + 1, ['', `## ${name}`, line]);
  }

  if (sec.items.some((i) => i.parsed.text === itemText)) return raw;
  const lastItem = sec.items[sec.items.length - 1];
  if (lastItem) return insertAt(s, lastItem.end + 1, [line]);

  if (s.unclosed && sec === s.sections[s.sections.length - 1]) {
    throw new Error(`pantry: section ${JSON.stringify(sec.name)} ends inside an unclosed code fence or HTML comment`);
  }
  let k = sec.end;
  while (k - 1 > sec.heading && isBlank(s.lines[k - 1]!)) k--;
  const prev = body(s.lines[k - 1]!);
  const tight = HEADING_RE.test(prev) || prev.trimEnd().endsWith('-->');
  return insertAt(s, k, tight ? [line] : ['', line]);
}

/** Add to the freezer section (the first section whose name contains "freezer"; created as "Freezer inventory" if none). */
export function freezerAdd(raw: string, text: string, dateISO: string): string {
  const f = scan(raw).sections.find((x) => x.isFreezer);
  return addItem(raw, f ? f.name : 'Freezer inventory', text, dateISO);
}

/** Delete the item's line(s), continuation lines included. */
export function removeItem(raw: string, id: string): string {
  const { s, it } = locate(raw, id);
  const lines = s.lines.slice();
  const atEnd = it.end === lines.length - 1;
  lines.splice(it.start, it.end - it.start + 1);
  // removed the unterminated last line: the new last line must not keep a dangling CR
  if (atEnd && lines.length) lines[lines.length - 1] = body(lines[lines.length - 1]!);
  return lines.join('\n');
}

/**
 * Mark (low=true) or clear (low=false) the running-low marker. Idempotent: marking an
 * already-low item keeps its original date; clearing an unmarked item is a no-op.
 * A used item can't be marked low (throws). dateISO is only required when marking.
 */
export function setLow(raw: string, id: string, low: boolean, dateISO: string): string {
  if (low) assertDate(dateISO);
  const { s, it } = locate(raw, id);
  if (it.parsed.low === low) return raw;
  if (low && it.parsed.used) throw new Error(`pantry: ${JSON.stringify(it.parsed.text)} is marked used; it can't be marked low`);
  const lines = s.lines.slice();
  const b = body(lines[it.end]!);
  const cr = crOf(lines[it.end]!);
  if (low) {
    lines[it.end] = b + lowSuffix(dateISO) + cr;
  } else {
    const m = lowMatch(lines, it)!;
    lines[it.end] = b.slice(0, m.index) + b.slice(m.index + m[0].length) + cr;
  }
  return lines.join('\n');
}

/**
 * Mark a freezer item used: `- ~~<text>~~ — used <date>[ (<note>)]`, dropping any low
 * marker. Only items in a freezer section (throws otherwise). Idempotent: an already-used
 * item comes back unchanged (its existing note wins).
 */
export function freezerUse(raw: string, id: string, dateISO: string, note?: string): string {
  assertDate(dateISO);
  const n = note === undefined || note.trim() === '' ? undefined : oneLine(note, 'note');
  const { s, sec, it } = locate(raw, id);
  if (!sec.isFreezer) throw new Error(`pantry: ${JSON.stringify(it.parsed.text)} is in "${sec.name}", not a freezer section`);
  if (it.parsed.used) return raw;
  const lines = s.lines.slice();
  const low = lowMatch(lines, it);
  if (low) {
    const b = body(lines[it.end]!);
    lines[it.end] = b.slice(0, low.index) + b.slice(low.index + low[0].length) + crOf(lines[it.end]!);
  }
  const first = lines[it.start]!;
  lines[it.start] = it.prefix + '~~' + body(first).slice(it.prefix.length) + crOf(first);
  const last = lines[it.end]!; // re-read: same line as `first` for a one-line item
  lines[it.end] = body(last).trimEnd() + '~~' + usedSuffix(dateISO, n) + crOf(last);
  return lines.join('\n');
}
