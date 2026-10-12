/* Meal Planner app frontend: four tabs (Week · Recipes · Next · Shop), live
   shared state over WS, capture-first logging, and run triggers for the
   Claude bridge. Vanilla JS, no build step. */
/* 00-core.js — shared helpers, state vars, fetch wrappers, toast, dates,
   view-state persistence, tabs, render scheduling, WS, the shared header /
   strip / nav-dot renders, the run result card, and capture wiring.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

let state = null;          // /api/state payload
let recipesCache = null;   // /api/recipes payload + fetchedAt
let runEventsLatest = '';  // newest activity line for the strip
let tickInt = null;

/* ---------- passcode ---------- */
let passcode = localStorage.getItem('mealapp-passcode') || '';
async function authedFetch(url, opts = {}) {
  const send = () => fetch(url, passcode
    ? { ...opts, headers: { ...(opts.headers || {}), 'x-mealapp-passcode': passcode } }
    : opts);
  let r = await send();
  if (r.status === 401) {
    const entered = prompt('Passcode for the meal planner (asked once on this device):');
    if (entered === null) return r;
    passcode = entered.trim();
    localStorage.setItem('mealapp-passcode', passcode);
    r = await send();
  }
  return r;
}
const jpost = (url, body) => authedFetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});
// open endpoints — no passcode header needed, so no prompt on 401 either
const opost = (url, body) => fetch(url, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body ?? {}),
});

async function expectOk(r, fallbackMsg) {
  let j = null;
  try { j = await r.json(); } catch { /* no body */ }
  if (!r.ok) { toast((j && j.error) || fallbackMsg || `Request failed (${r.status})`); return null; }
  return j ?? {};
}

/* ---------- toast ---------- */
let toastT = null;
function toast(msg) {
  const el = $('toast');
  el.textContent = humanizeWeekIds(msg); // server errors can name a week by id
  el.classList.add('on');
  clearTimeout(toastT);
  toastT = setTimeout(() => el.classList.remove('on'), 4200);
}

/* ---------- dates ----------
   The client never computes weeks — the server ships each week's day→date map
   and its own day order. So: no day-name literals as endpoints. Endpoints are
   the min and max of the map's ISO dates, which sort lexicographically. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const dpart = (iso) => ({ y: +iso.slice(0, 4), m: +iso.slice(5, 7), d: +iso.slice(8, 10) });
const weekSpan = (dates) => {
  const all = Object.values(dates ?? {}).filter(Boolean).sort();
  return { first: all[0], last: all[all.length - 1] };
};
function fmtRange(dates) {
  const { first, last } = weekSpan(dates);
  if (!first) return '';
  const a = dpart(first), b = dpart(last);
  const left = `${MONTHS[a.m - 1]} ${a.d}`;
  const right = a.m === b.m ? `${b.d}` : `${MONTHS[b.m - 1]} ${b.d}`;
  return `${left} – ${right}`;
}
const fmtDay = (iso) => { const p = dpart(iso); return `${MONTHS[p.m - 1]} ${p.d}`; };
/** "Oct 10–16" / "Sep 27–Oct 3": the header's tight form of fmtRange. */
const tightRange = (dates) => fmtRange(dates).replace(' – ', '–');
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
/* Week names. Ids (2026-W43) are identifiers — files, APIs, feedback and check
   keys — and never reach the screen. People name a week relative to today
   when they can, by its dates otherwise; the server ships both for every id
   the state references (state.weeks: { start, end, range, rel }).
     weekName(id, 'rel')   → "next week" (no relative name: "the week of Oct 17")
     weekName(id, 'Rel')   → "Next week" / "The week of Oct 17"
     weekName(id, 'range') → "Oct 17–23"
     weekName(id, 'of')    → "the week of Oct 17–23"
   An id missing from state.weeks falls back to "W43", so nothing breaks. */
function weekName(id, form = 'rel') {
  const i = state?.weeks?.[id];
  if (!i) return String(id ?? '').replace(/^\d{4}-/, '');
  if (form === 'range') return i.range;
  if (form === 'of') return `the week of ${i.range}`;
  const s = i.rel ? `${i.rel} week` : `the week of ${fmtDay(i.start)}`;
  return form === 'Rel' ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}
/** Ids inside server text (errors, run summaries) → dates: "2026-W43 already has a plan file" →
    "Oct 17–23 already has …". Paths (plans/2026-W43.md) and keys (2026-W43:shop:…) keep theirs. */
const humanizeWeekIds = (text) => String(text ?? '')
  .replace(/(^|[^\w/.-])(\d{4}-W\d{2})(?![\w-]|[.:]\w)/g, (_m, pre, id) => pre + weekName(id, 'range'));
/** An icon from index.html's inline sprite. */
const ico = (name) => `<svg class="i" aria-hidden="true"><use href="#i-${name}"/></svg>`;
/** "Dish with Sides" → ['Dish', 'with Sides']: serif title + italic second line (display only). */
function dishParts(dish) {
  const s = String(dish ?? '');
  const m = s.match(/^(.{6,}?)\s+(with\s.+)$/i);
  return m ? [m[1], m[2].replace(/^With\b/, 'with')] : [s, ''];
}
/** Escaped dish title whose hyphenated words never break at the hyphen ("Gochujang-Glazed"). */
const keepHyphens = (s) => esc(s).replace(/[^\s-]+(?:-[^\s-]+)+/g, (w) => (w.length <= 22 ? `<span class="nw">${w}</span>` : w));
/** Meta bits as "30 min · 570 cal · 40 g protein" spans with quiet separators. */
const metaSpans = (bits) => bits.filter(Boolean).map((b) => `<span>${esc(b)}</span>`).join('<span class="sep">·</span>');
const mins = (ms) => Math.max(1, Math.round(ms / 60000));
function mmss(ms) {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/* ---------- view state (survives screen lock) ----------
   Phones discard backgrounded tabs; the page cold-boots on return and used to
   dump you at the top of the last tab, losing whatever was open. Everything
   needed to rebuild the exact view — active tab, expanded recipes, scroll
   position per tab, the cook tab's dish and chat — lives in sessionStorage
   and is restored on boot. */
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; // we restore scroll ourselves
let viewState = {};
try { viewState = JSON.parse(sessionStorage.getItem('mealapp-view') || '{}') ?? {}; } catch { viewState = {}; }
function saveView(patch) {
  Object.assign(viewState, patch);
  try { sessionStorage.setItem('mealapp-view', JSON.stringify(viewState)); } catch { /* quota — live view still works */ }
}
function saveScroll() {
  viewState.scroll = { ...(viewState.scroll ?? {}), [tab]: Math.round(window.scrollY) };
  saveView({ scroll: viewState.scroll });
}
let scrollT = null;
addEventListener('scroll', () => { clearTimeout(scrollT); scrollT = setTimeout(saveScroll, 250); }, { passive: true });
addEventListener('pagehide', saveScroll);
// The one that matters for screen lock: fires when the phone locks or the
// app is backgrounded — before iOS can discard the tab (pagehide never fires
// on a process kill).
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { saveScroll(); return; }
  // Back to the foreground: iOS can resume the page with a zombie socket that
  // never fires onclose, leaving the UI frozen on pre-lock state. Always pull
  // fresh state over HTTP, and rebuild the WS if it isn't open.
  if (state) void refetchState();
  if (ws && ws.readyState > WebSocket.OPEN) connectWS();
});

/* ---------- tabs ---------- */
const TABS = ['week', 'cook', 'recipes', 'next', 'shop'];
// ?tab= is honored once, then stripped — a stale URL param on a
// restore-reload must not override the remembered view.
const urlTab = new URLSearchParams(location.search).get('tab');
if (urlTab !== null) history.replaceState(null, '', location.pathname);
let tab = TABS.includes(urlTab) ? urlTab
  : TABS.includes(viewState.tab) ? viewState.tab
  : (localStorage.getItem('mealapp-tab') || 'week');
if (!TABS.includes(tab)) tab = 'week';

// keepScroll: deep links (open-recipe, cook-mode jumps) position the page
// themselves — the per-tab restore would stomp their scrollIntoView.
function showTab(name, keepScroll) {
  // booted guard: the boot-time call runs at scrollY 0 and must not clobber
  // the position we're about to restore
  if (booted && TABS.includes(tab)) saveScroll();
  tab = TABS.includes(name) ? name : 'week';
  localStorage.setItem('mealapp-tab', tab);
  saveView({ tab });
  for (const t of TABS) {
    $(`tab-${t}`).setAttribute('aria-selected', String(t === tab));
    $(`view-${t}`).classList.toggle('on', t === tab);
  }
  if (tab === 'recipes') void loadRecipes();
  if (tab === 'cook') { void loadRecipes(); renderCook(); }
  if (typeof renderWindow === 'function') renderWindow(); // the kitchen window: Week tab only (05-window.js)
  renderHead();
  renderStrip();
  if (booted && !keepScroll) requestAnimationFrame(() => window.scrollTo(0, (viewState.scroll ?? {})[tab] ?? 0));
}

/* ---------- render scheduling ----------
   Full re-renders replace DOM; never yank it out from under someone typing.
   While a text control is focused we defer and re-render on blur. */
let renderPending = false;
let renderT = null;
function typingNow() {
  const el = document.activeElement;
  return !!el && (el.tagName === 'TEXTAREA' || (el.tagName === 'INPUT' && el.type === 'text'));
}
function renderSoon() {
  clearTimeout(renderT);
  renderT = setTimeout(() => {
    if (typingNow()) { renderPending = true; return; }
    renderAll();
  }, 200);
}
document.addEventListener('focusout', () => {
  if (renderPending) setTimeout(() => {
    if (!typingNow() && renderPending) { renderPending = false; renderAll(); }
  }, 120);
});

/* ---------- state ---------- */
async function refetchState() {
  try {
    const r = await fetch('/api/state');
    if (!r.ok) throw new Error(`state ${r.status}`);
    state = await r.json();
    noteFoldState(); // "In the record ✓✓" toast if a fold landed since this device last looked
    renderAll();
    void restoreBoot();
  } catch {
    $('head-sub').textContent = 'server unreachable — is the Mac awake?';
  }
}

/* ---------- websocket ---------- */
let ws = null;
let wsRetry = 800;
let wsRetryT = null;
function connectWS() {
  clearTimeout(wsRetryT); // callable from visibilitychange without stacking sockets
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.onopen = () => { wsRetry = 800; void refetchState(); };
  ws.onclose = () => { wsRetryT = setTimeout(connectWS, wsRetry = Math.min(wsRetry * 1.6, 15000)); };
  ws.onmessage = (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (!state) return;
    if (m.type === 'run-state') {
      state.run = m.run;
      if (m.run?.fold) setFoldState(m.run.fold);
      runEventsLatest = '';
      renderStrip();
      renderSoon(); // run gating on buttons
    } else if (m.type === 'event') {
      if (m.ev && (m.ev.kind === 'activity' || m.ev.kind === 'status')) { runEventsLatest = m.ev.text; renderStrip(); }
      if (m.ev && m.ev.kind === 'error') toast(m.ev.text);
      // A close-out's own confirmation; when it also folded entries, the
      // fold-state that follows replaces this with "In the record ✓✓ · …".
      if (m.ev && m.ev.kind === 'done' && state.run?.type === 'review') toast(`${state.run.week ? weekName(state.run.week, 'Rel') : 'Week'} closed out ✓ · stats and the review are in the record`);
    } else if (m.type === 'fold-state') {
      setFoldState(m.fold); // a fold's outcome, with what it put in the record
      renderStrip();
      renderSoon();
    } else if (m.type === 'state-updated') {
      recipeBodies.clear(); // a run may have written/created recipe files
      void refetchState();
    } else if (m.type === 'check') {
      if (m.done) state.checks[m.key] = { by: m.by, at: Date.now() };
      else delete state.checks[m.key];
      patchCheck(m.key, m.done, m.by);
    } else if (m.type === 'capture') {
      if (m.entry) state.captures[m.date] = m.entry; else delete state.captures[m.date];
      if (m.fold) setFoldState(m.fold); // the countdown restarts with every capture
      renderStrip();
      renderSoon();
    } else if (m.type === 'feedback') {
      if (state.aheadWeekId === m.week) { state.feedback = m.feedback; renderSoon(); }
    } else if (m.type === 'settings-updated') {
      if (settingsOpen()) void loadSettings();
      void refetchState(); // auto-fold on/off or quiet delay moves the strip's countdown
    }
  };
}

/* ---------- shared render ---------- */
function renderAll() {
  if (!state) return;
  renderHead();
  renderStrip();
  renderWeek();
  renderNext();
  renderShop();
  renderCook();
  renderNavDots();
  if (tab === 'recipes' && recipesCache) renderRecipes();
}

/* The header is a triple: a small uppercase eyebrow (it shares its row with
   the Ask + gear buttons), the serif title, and an optional sub line. A title
   given as [lead, accent] renders the accent in the olive italic. Shop adds a
   fourth element, the fraction checked off, for the progress bar. */
function renderHead() {
  if (!state) return;
  const H = {
    week: () => {
      const today = state.today ? `${DOW_LONG[new Date(`${state.today}T00:00:00Z`).getUTCDay()]}, ${fmtDay(state.today)}` : '';
      if (!state.cooking) return [today, 'No week yet', 'Propose one from the Next tab'];
      const nights = state.cooking.plan.meals.filter((m) => !m.flexible);
      const n = nights.length;
      // per-meal Servings column (4 when absent): "4 servings each", or the range "4–9 servings"
      const sv = nights.map((m) => (Number(m.servings) > 0 ? Number(m.servings) : 4));
      const lo = Math.min(...sv), hi = Math.max(...sv);
      const serv = !n ? '' : lo === hi ? ` · ${lo} servings each` : ` · ${lo}–${hi} servings`;
      return [
        today,
        ['Week of', tightRange(state.cooking.dates)],
        `${n} dinners${serv}${state.cooking.fallback ? ' · showing the last locked week' : ''}`,
      ];
    },
    cook: () => {
      const f = cookFile();
      if (!f) return ['Cook mode', 'Cook', 'Pick a dish, then ask the sous-chef anything'];
      // The dish name is the card's job (it can run four lines); the page
      // header stays short so the recipe is on screen immediately.
      const wk = cookWeekMeal(f);
      const date = wk ? state.cooking?.dates?.[wk.day] : null;
      const when = date ? `${wk.day} ${dpart(date).d}` : wk?.day;
      return [!wk ? 'From the library' : date === state.today ? `Tonight · ${when}` : `${when} · this week`, 'Cook', ''];
    },
    recipes: () => {
      const n = recipesCache?.recipes?.length;
      return [n ? `${n} recipes` : 'The rotation so far', 'Recipe library', n ? 'Ratings update at each week’s close' : ''];
    },
    next: () => {
      const w = state.aheadWeekId;
      const p = state.ahead?.plan;
      // Usually next week — but when the current week has no locked plan the
      // server points `ahead` at the current week, and weekName says so.
      const lbl = weekName(w, 'Rel');
      const eb = weekName(w, 'range');
      if (!p) return [eb, lbl, 'Not planned yet'];
      const n = p.meals.filter((m) => !m.flexible).length;
      if (p.status === 'planning') return [eb, lbl, `Proposal ready · ${n} dinners · approve, adjust, then lock`];
      return [eb, lbl, `Locked · ${n} dinners · changes still easy`];
    },
    shop: () => {
      // state.shop is the server's decision about which week's list is live.
      const w = state.shop?.week ?? state.aheadWeekId;
      const g = state.shop?.grocery;
      const eb = weekName(w, 'range');
      const title = ['Shopping for', weekName(w, 'rel')]; // "this week" / "next week" / "the week of Oct 24"
      if (!g) return [eb, title, 'The list appears when the week locks'];
      const total = g.stores.reduce((a, s) => a + s.sections.reduce((x, y) => x + y.items.length, 0), 0);
      const done = g.stores.reduce((a, s) => a + s.sections.reduce((x, y) => x + y.items.filter((i) => state.checks[i.key]).length, 0), 0);
      return [eb, title, `${done} of ${total} · ${g.stores.map((s) => s.name.split(' ')[0]).join(' + ')}`, total ? done / total : 0];
    },
  };
  const [eb, t, s, prog] = H[tab]();
  $('head-eyebrow').textContent = eb || '';
  if (Array.isArray(t)) $('head-title').innerHTML = `${esc(t[0])} <em>${esc(t[1])}</em>`;
  else $('head-title').textContent = t;
  $('head-sub').textContent = s || '';
  const pb = $('head-progress');
  pb.hidden = prog === undefined;
  if (prog !== undefined) pb.firstElementChild.style.width = `${Math.round(prog * 100)}%`;
}

function pendingCaptureCount() {
  return Object.values(state?.captures ?? {}).filter((c) => !c.foldedAt).length;
}

/* ---------- the record: fold state, countdown, confirmations ----------
   Answers "did my note make it into the record?". state.fold = { pending,
   nextAt, quietMin, last: { at, ok, message, folded: [{ date, dish?, rating?,
   noted? }] } | null } comes with /api/state, every run-state (run.fold),
   capture broadcasts and /api/log replies, and a `fold-state` message when a
   fold's outcome lands; the newest copy wins. Pending captures are already
   passed to propose and close-out runs, so the copy says the planner reads
   them before they are folded. */
const FOLD_SEEN_KEY = 'mealapp-fold-seen';
let foldSeenAt = null; // newest fold.last.at this device has confirmed

function setFoldState(f) {
  if (!state || !f) return;
  state.fold = f;
  // Mirror the server's foldedAt stamps right away, so entries flip to
  // "in the record ✓✓" without waiting on the post-run refetch (whose git pull
  // can take a second or two). The refetch that follows is authoritative.
  const last = f.last;
  if (last?.ok) {
    for (const e of last.folded ?? []) {
      const c = state.captures?.[e.date];
      if (c && !c.foldedAt && c.at <= last.at) c.foldedAt = last.at;
    }
  }
  noteFoldState();
}

// A fold newer than this device has seen → "In the record ✓✓ · Sat Coconut-dill
// salmon — 5, noted and 2 more", on whatever tab is showing. On a device's
// first look, a fold already on the books is acknowledged silently unless it
// is fresh (a cold boot right after one, say: under 15 min old).
function noteFoldState() {
  if (!state?.fold) return;
  const last = state.fold.last;
  if (foldSeenAt === null) {
    let stored = 0;
    try { stored = Number(localStorage.getItem(FOLD_SEEN_KEY)) || 0; } catch { /* storage blocked */ }
    const at = last?.at ?? 0;
    foldSeenAt = (!stored || Date.now() - at > 15 * 60000) ? Math.max(stored, at) : stored;
  }
  if (last && last.at > foldSeenAt) {
    foldSeenAt = last.at;
    if (last.ok && last.folded?.length) {
      const [first, ...rest] = last.folded;
      toast(`In the record ✓✓ · ${foldedLabel(first)}${rest.length ? ` and ${rest.length} more` : ''}`);
    }
    // a failure already toasted via its error event; the strip keeps it visible
  }
  try { localStorage.setItem(FOLD_SEEN_KEY, String(foldSeenAt)); } catch { /* storage blocked */ }
}

const DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const dowOf = (iso) => DOW[new Date(`${iso}T00:00:00Z`).getUTCDay()] ?? iso;
/** "Sat Coconut-dill salmon — 5, noted" / "Tue skipped (ate out)" for one folded entry. */
function foldedLabel(e) {
  const d = String(e?.dish ?? '');
  const skip = d.match(/^skipped\s*[—–:-]?\s*(.*)$/i);
  let s = dowOf(e.date);
  if (skip) s += skip[1] ? ` skipped (${skip[1]})` : ' skipped';
  else if (d) {
    // the dish's head: "Coconut-Dill Salmon with Green Beans, Corn & Tomatoes" → "Coconut-Dill Salmon"
    const head = d.split(/\s+(?:with|over|on|and|&|\+)\s+|,\s*|\s+[—–-]\s+/i)[0] || d;
    s += ` ${head.length > 40 ? `${head.slice(0, 39)}…` : head}`;
  }
  const bits = [e.rating ? String(e.rating) : '', e.minutes ? `took ~${e.minutes} min` : '', e.noted ? 'noted' : ''].filter(Boolean);
  return bits.length ? `${s} — ${bits.join(', ')}` : s;
}

const clockAt = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
/** "10:42 AM" today, "Oct 9, 10:42 AM" otherwise. */
function recordTime(t) {
  const d = new Date(t);
  return d.toDateString() === new Date().toDateString() ? clockAt(t) : `${MONTHS[d.getMonth()]} ${d.getDate()}, ${clockAt(t)}`;
}

/** When auto-fold will put the pending entries in the record; null = no countdown (off, parked after a failure, nothing pending). */
const foldCountdownAt = () => (state?.autoFold && state.fold?.nextAt && state.fold.pending && pendingCaptureCount()) ? state.fold.nextAt : null;

// "Done logging" / "Sync now" / "Retry": all fold now (passcode-gated, like any run).
let foldNowBusy = false;
async function foldNow() {
  if (foldNowBusy) return;
  foldNowBusy = true;
  try { await expectOk(await jpost('/api/runs/fold'), 'Could not start the sync.'); } finally { foldNowBusy = false; }
}

// The strip while entries are pending: a live countdown to auto-fold, "waiting
// for you" (auto-fold on, no countdown yet), "tap Sync now" when auto-fold is
// off, or the last failure with Retry (a failed fold
// parks auto-fold until the next entry, so it never retries every few seconds).
function recordStrip(pend, strip, text, btn) {
  const f = state.fold ?? {};
  const saved = `${pend} ${pend === 1 ? 'entry' : 'entries'} saved`;
  const then = state.cooking && syncCloseReady() ? ' · then close out' : '';
  const failedBefore = !!(f.last && !f.last.ok);
  const at = foldCountdownAt();
  btn.hidden = false;
  btn.className = '';
  btn.onclick = foldNow;
  if (failedBefore && !at) {
    strip.className = 'strip bad';
    text.innerHTML = `<b>Last sync failed:</b> ${esc(f.last.message || 'no details')} · ${esc(saved)}, and the planner already reads ${pend === 1 ? 'it' : 'them'}`;
    btn.textContent = 'Retry';
    return;
  }
  strip.className = 'strip';
  if (at) {
    const left = at - Date.now();
    const when = left > 0 ? `into the record in <span class="cd">${mmss(left)}</span>` : 'going into the record now';
    text.innerHTML = `<b>${esc(saved)}</b> · ${when}${esc(then)}${failedBefore ? ' · <span class="lastfail">last try failed</span>' : ''}`;
    btn.textContent = 'Done logging';
  } else {
    const ask = state.autoFold ? 'waiting for you' : `tap Sync now to record ${pend === 1 ? 'it' : 'them'}`;
    text.innerHTML = `<b>${esc(saved)}</b> · ${esc(ask)}${esc(then)}`;
    btn.textContent = state.autoFold ? 'Done logging' : 'Sync now';
  }
}

// The fold's result card, above every tab (a fold can finish while you're on
// Cook or Next). Single fold runs only; close-outs keep their Week-tab card.
// Same dismissal rule as resultCard. Created on first use, right under the strip.
let recordSlotHtml = null;
function renderRecordSlot() {
  let slot = $('record-slot');
  if (!slot) {
    slot = document.createElement('div');
    slot.id = 'record-slot';
    $('strip').after(slot);
    recordSlotHtml = null;
  }
  const html = foldResultCard();
  if (html !== recordSlotHtml) { slot.innerHTML = html; recordSlotHtml = html; }
}
function foldResultCard() {
  const lr = state?.run?.lastResult;
  if (!lr || lr.chain || lr.type !== 'fold') return '';
  if (localStorage.getItem('mealapp-result-dismissed') === String(lr.at)) return '';
  const x = `<button class="dismiss" aria-label="Dismiss" onclick="dismissResult(${lr.at})">✕</button>`;
  if (!lr.ok) {
    return `<div class="result err" id="record-card">${x}
      <div class="rlabel">Sync failed · ${esc(recordTime(lr.at))}</div>
      <div class="rbodytext">${lr.summaryHtml}</div>
      <p class="rnote">Your entries are still saved, and the planner already reads them. Retry from the banner above.</p>
    </div>`;
  }
  return `<div class="result" id="record-card">${x}
    <div class="rlabel">In the record ✓✓ · ${esc(recordTime(lr.at))}</div>
    <div class="rbodytext">${lr.summaryHtml}</div>
  </div>`;
}

function renderStrip() {
  if (!state) return;
  renderRecordSlot(); // the fold result card sits above every tab, not just Week
  const strip = $('strip'), text = $('strip-text'), btn = $('strip-action'), pulse = $('strip-pulse');
  strip.hidden = false;
  btn.hidden = true;
  pulse.hidden = true;
  strip.className = 'strip quiet';
  btn.onclick = null;

  const run = state.run;
  if (run && run.active) {
    strip.className = 'strip busy';
    pulse.hidden = false;
    const verb = { propose: 'Proposing', revise: 'Revising', lock: 'Locking + building the list for',
      fold: 'Recording your log', 'shop-adjust': 'Adjusting the list for', review: 'Closing out', ask: 'Asking Claude',
      ideas: 'Finding new recipe ideas', import: 'Importing a recipe', rescale: 'Rescaling a meal for', move: 'Moving a dinner in' }[run.type] || 'Working on';
    // week-less runs (fold, ask, ideas, import) have no week: no trailing space before the " · "
    const head = [verb, run.week && weekName(run.week)].filter(Boolean).join(' ');
    const doing = runEventsLatest ? ` — ${humanizeWeekIds(runEventsLatest)}` : '';
    const ch = run.chain;
    if (ch) {
      // "Closing out this week · step 1 of 2, then proposing next week · 1:12 · usually ~5 min total"
      const thenVerb = { propose: 'proposing', revise: 'revising', lock: 'locking', fold: 'recording the log',
        'shop-adjust': 'adjusting the list for', review: 'closing out', rescale: 'rescaling a meal for', move: 'moving a dinner in',
        ideas: 'finding new recipe ideas', import: 'importing a recipe' };
      const later = ch.types.slice(ch.step).map((t, i) => {
        const wk = ch.weeks[ch.step + i];
        return `${thenVerb[t] || t} ${wk ? weekName(wk) : ''}`.trim();
      });
      const el = mmss(Date.now() - ch.startedAt);
      const typ = ch.typicalMs ? ` · usually ~${mins(ch.typicalMs)} min total` : '';
      text.innerHTML = `<b>${esc(head)}</b>${esc(` · step ${ch.step} of ${ch.of}${later.length ? `, then ${later.join(', then ')}` : ''}`)} · ${el}${esc(typ)}${esc(doing)}`;
    } else {
      const el = run.startedAt ? mmss(Date.now() - run.startedAt) : '';
      const typ = run.typicalMs ? ` · usually ~${mins(run.typicalMs)} min` : '';
      text.innerHTML = `<b>${esc(head)}</b> · ${el}${esc(typ)}${esc(doing)}`;
    }
    btn.hidden = false;
    btn.textContent = 'Stop';
    btn.className = 'stop';
    btn.onclick = async () => { await expectOk(await jpost('/api/stop'), 'Could not stop.'); };
    if (!tickInt) tickInt = setInterval(renderStrip, 1000);
    return;
  }
  // captures can trail the server's own count by a refetch after a fold; the
  // smaller is right (every capture reply and broadcast carries a fresh fold)
  const pend = Math.min(pendingCaptureCount(), state.fold?.pending ?? Infinity);
  // the 1 s ticker also drives the record countdown while entries wait on auto-fold
  const countdown = !!(pend && foldCountdownAt());
  if (tickInt && !countdown) { clearInterval(tickInt); tickInt = null; }

  if (pend) {
    recordStrip(pend, strip, text, btn);
    patchRecordCopy(); // per-entry "into the record in 4 min" on the Week tab, in place
    if (countdown && !tickInt) tickInt = setInterval(renderStrip, 1000);
    return;
  }
  if (state.cooking && syncCloseReady()) { // live: captures don't refetch /api/state
    strip.className = 'strip';
    const andPlan = !state.ahead?.plan;
    text.innerHTML = `<b>${esc(weekName(state.cooking.week, 'Rel'))} is fully logged</b> — ${andPlan
      ? `close it out and plan ${esc(weekName(state.aheadWeekId))} in one go` : 'close it out when you\'re ready'}`;
    // navigates to the Week tab's close-out card (planning inputs live there); never fires a run
    btn.hidden = false;
    btn.textContent = 'Close out';
    btn.className = '';
    btn.onclick = goToCloseOut;
    return;
  }
  if (!state.ahead?.plan) {
    // Friday is planning day under both schemes: on an old Mon–Sun week this
    // fires Fri–Sun, and on a Saturday-start week Friday IS the last day, so it
    // fires exactly on planning day. Truncated 2026-W32 ends Fri Aug 7 — same.
    const friday = state.cooking ? state.cooking.dates.Fri : null;
    const isPlanningTime = !friday || state.today >= friday;
    strip.className = isPlanningTime ? 'strip' : 'strip quiet';
    text.innerHTML = isPlanningTime
      ? `<b>${esc(weekName(state.aheadWeekId, 'Rel'))} isn't planned yet</b> — ${tab === 'next' ? 'hit Propose below' : 'start it on the Next tab'}`
      : `${esc(weekName(state.aheadWeekId, 'Rel'))} gets planned Friday`;
    return;
  }
  if (state.ahead.plan.status === 'planning') {
    // live, not the /api/state snapshot; a rejected/swapped meal counts as decided
    const appr = aheadApprovalNow();
    const undecided = appr.filter((a) => !a.approved && !a.decision).length;
    const changes = appr.some((a) => a.decision === 'reject' || a.decision === 'swap') || !!state.feedback?.weekNote;
    strip.className = 'strip';
    const W = esc(weekName(state.ahead.week, 'Rel'));
    text.innerHTML = undecided
      ? `<b>${W}’s proposal is waiting</b> — ${undecided} meal${undecided === 1 ? '' : 's'} to decide`
      : changes
        ? `<b>${W} has changes marked</b> — send them, or send and lock`
        : `<b>${W} is fully approved</b> — lock it to build the grocery list`;
    return;
  }
  strip.className = 'strip quiet';
  text.textContent = `${weekName(state.ahead.week, 'Rel')} locked · shop from the Shop tab`;
}

function renderNavDots() {
  document.querySelectorAll('nav.tabs .dot').forEach((d) => d.remove());
  const dot = () => { const s = document.createElement('span'); s.className = 'dot'; return s; };
  if (state.ahead?.plan?.status === 'planning') $('tab-next').appendChild(dot());
  if (state.cooking?.closeReady) $('tab-week').appendChild(dot());
}

/* ---------- run result card ---------- */
function resultCard(forTypes) {
  const lr = state.run?.lastResult;
  if (!lr) return '';
  if (lr.type === 'fold' && !lr.chain) return ''; // a fold's card sits above every tab instead (renderRecordSlot)
  // a chain's card shows on the tabs of every step it ran (close-and-plan: Week + Next)
  const types = lr.chain ? [...(lr.results ?? []).map((r) => r.type), lr.type] : [lr.type];
  if (!types.some((t) => forTypes.includes(t))) return '';
  if (localStorage.getItem('mealapp-result-dismissed') === String(lr.at)) return '';
  const LABEL = { propose: 'Proposal ready', revise: 'Plan revised', lock: 'Week locked',
    fold: 'Log recorded', 'shop-adjust': 'List adjusted', review: 'Week closed out', rescale: 'Meal rescaled', move: 'Dinner moved',
    ideas: 'Ideas ready', import: 'Recipe imported' };
  // A single run's label names its week the way a person would:
  // "Proposal ready for next week", "Next week locked", "This week closed out".
  const named = (type, week) => {
    if (!week) return LABEL[type] || 'Done';
    const w = weekName(week), W = weekName(week, 'Rel');
    return { propose: `Proposal ready for ${w}`, revise: `${W} revised`, lock: `${W} locked`,
      review: `${W} closed out`, 'shop-adjust': `List adjusted for ${w}`, rescale: `Meal rescaled for ${w}` }[type]
      || `${LABEL[type] || 'Done'} · ${w}`;
  };
  if (lr.chain && lr.ok && lr.results?.length) {
    // "Closed out last week · proposed this week" / "Revised and locked next week"
    const PAST = { propose: 'proposed', revise: 'revised', lock: 'locked', fold: 'recorded the log',
      'shop-adjust': 'adjusted the list for', review: 'closed out', rescale: 'rescaled a meal in', move: 'moved a dinner in',
      ideas: 'found new recipe ideas', import: 'imported a recipe' };
    const rs = lr.results;
    let title = rs.every((r) => r.week === rs[0].week)
      ? `${rs.map((r) => PAST[r.type] || r.type).join(' and ')} ${weekName(rs[0].week)}`
      : rs.map((r) => `${PAST[r.type] || r.type} ${weekName(r.week)}`).join(' · ');
    title = title.charAt(0).toUpperCase() + title.slice(1);
    return `<div class="result" id="result-card">
      <button class="dismiss" aria-label="Dismiss" onclick="dismissResult(${lr.at})">✕</button>
      <div class="rlabel">${esc(title)}</div>
      ${rs.map((r) => `<div class="rstep"><div class="rsteplabel">${esc([LABEL[r.type] || r.type, r.week && weekName(r.week, 'range')].filter(Boolean).join(' · '))}</div>
        <div class="rbodytext">${humanizeWeekIds(r.summaryHtml)}</div></div>`).join('')}
    </div>`;
  }
  return `<div class="result ${lr.ok ? '' : 'err'}" id="result-card">
    <button class="dismiss" aria-label="Dismiss" onclick="dismissResult(${lr.at})">✕</button>
    <div class="rlabel">${esc(lr.ok ? named(lr.type, lr.week) : ['Run failed', lr.week && weekName(lr.week)].filter(Boolean).join(' · '))}</div>
    <div class="rbodytext">${humanizeWeekIds(lr.summaryHtml)}</div>
  </div>`;
}
window.dismissResult = (at) => { localStorage.setItem('mealapp-result-dismissed', String(at)); renderAll(); };

const runActive = () => !!(state?.run?.active);

/* ---------- capture wiring (Week + carry) ---------- */
function wireCommon(root) {
  // stars
  root.querySelectorAll('.stars[data-date]').forEach((grp) => {
    grp.querySelectorAll('button[data-star]').forEach((b) => {
      b.onclick = async () => {
        const date = grp.dataset.date;
        const n = Number(b.dataset.star);
        const cur = state.captures[date]?.rating;
        const next = cur === n ? null : n; // tap the same star to clear
        const j = await expectOk(await opost('/api/log', { date, rating: next }), 'Could not save the rating.');
        if (j) { if (j.entry) state.captures[date] = j.entry; else delete state.captures[date]; setFoldState(j.fold); renderAll(); }
      };
    });
  });
  // note / dish reveals + debounced saves
  root.querySelectorAll('.log').forEach((log) => {
    const date = log.dataset.date;
    const ta = log.querySelector('textarea');
    const din = log.querySelector('input.dishin');
    log.querySelectorAll('.notebtn').forEach((btn) => {
      btn.onclick = () => {
        const el = btn.dataset.act === 'note' ? ta : din;
        el.hidden = !el.hidden;
        if (!el.hidden) el.focus();
      };
    });
    const save = async (field, value) => {
      // unchanged (a field opened and closed, a blur after the debounce saved it):
      // no POST, so an entry already in the record isn't re-opened for nothing
      if (value === (state.captures[date]?.[field] ?? '')) return;
      const j = await expectOk(await opost('/api/log', { date, [field]: value }), 'Could not save.');
      if (j) {
        if (j.entry) state.captures[date] = j.entry; else delete state.captures[date];
        setFoldState(j.fold);
        const ss = log.querySelector('.savestate');
        if (ss) ss.innerHTML = j.entry ? recordCopy(j.entry) : ''; // in place: a re-render would yank the focused field
        renderStrip();
      }
    };
    let t = null;
    const arm = (field, el) => {
      el.addEventListener('input', () => { clearTimeout(t); t = setTimeout(() => save(field, el.value.trim()), 1200); });
      el.addEventListener('blur', () => { clearTimeout(t); void save(field, el.value.trim()); });
    };
    if (ta) arm('note', ta);
    if (din) arm('dish', din);
  });
  // shared checkboxes
  root.querySelectorAll('input[data-key]').forEach((box) => {
    box.onchange = async () => {
      const done = box.checked;
      const j = await expectOk(await opost('/api/check', { key: box.dataset.key, done }), 'Could not save the check.');
      if (!j) { box.checked = !done; return; }
      if (done) state.checks[box.dataset.key] = { at: Date.now() };
      else delete state.checks[box.dataset.key];
      renderHead();
      updateShopCounts();
    };
  });
  // recipe deep links
  root.querySelectorAll('a[data-recipe]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); void openRecipe(a.dataset.recipe); };
  });
  // cook-mode jumps
  root.querySelectorAll('a[data-cook]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); setCookRecipe(a.dataset.cook, true); };
  });
  // Didn't cook + reason chips, took-about chips, Week-tab "Done logging" (10-week.js)
  wireLogExtras(root);
}

function patchCheck(key, done, by) {
  document.querySelectorAll(`input[data-key="${CSS.escape(key)}"]`).forEach((box) => {
    box.checked = !!done;
    const who = box.closest('label')?.querySelector('.who');
    if (who) who.textContent = done && by ? by : '';
  });
  renderHead();
  updateShopCounts();
}
