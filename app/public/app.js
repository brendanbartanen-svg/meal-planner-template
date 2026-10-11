/* Meal Planner app frontend: four tabs (Week · Recipes · Next · Shop), live
   shared state over WS, capture-first logging, and run triggers for the
   Claude bridge. Vanilla JS, no build step. */
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
  el.textContent = msg;
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

let booted = false;
async function restoreBoot() {
  if (booted) return;
  booted = true;
  // recipe bodies load async — pull the open ones in before restoring scroll,
  // so the page height is right when we jump back to where the user was
  if (tab === 'recipes' || tab === 'cook') {
    await loadRecipes();
    await Promise.all([...openRecipes].map((f) => loadRecipeBody(f)));
    const cf = cookFile();
    if (cf) await loadRecipeBody(cf);
    renderAll();
  }
  const y = (viewState.scroll ?? {})[tab];
  if (y) requestAnimationFrame(() => requestAnimationFrame(() => window.scrollTo(0, y)));
}

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
  renderHead();
  renderStrip();
  if (booted && !keepScroll) requestAnimationFrame(() => window.scrollTo(0, (viewState.scroll ?? {})[tab] ?? 0));
}
for (const t of TABS) $(`tab-${t}`).onclick = () => showTab(t);

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
      runEventsLatest = '';
      renderStrip();
      renderSoon(); // run gating on buttons
    } else if (m.type === 'event') {
      if (m.ev && (m.ev.kind === 'activity' || m.ev.kind === 'status')) { runEventsLatest = m.ev.text; renderStrip(); }
      if (m.ev && m.ev.kind === 'error') toast(m.ev.text);
    } else if (m.type === 'state-updated') {
      recipeBodies.clear(); // a run may have written/created recipe files
      void refetchState();
    } else if (m.type === 'check') {
      if (m.done) state.checks[m.key] = { by: m.by, at: Date.now() };
      else delete state.checks[m.key];
      patchCheck(m.key, m.done, m.by);
    } else if (m.type === 'capture') {
      if (m.entry) state.captures[m.date] = m.entry; else delete state.captures[m.date];
      renderSoon();
    } else if (m.type === 'feedback') {
      if (state.aheadWeekId === m.week) { state.feedback = m.feedback; renderSoon(); }
    } else if (m.type === 'settings-updated') {
      if (settingsOpen()) void loadSettings();
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

function renderHead() {
  if (!state) return;
  const H = {
    week: () => {
      if (!state.cooking) return ['No week yet', 'propose one from the Next tab'];
      const n = state.cooking.plan.meals.filter((m) => !m.flexible).length;
      return [
        `Week of ${fmtRange(state.cooking.dates)}`,
        `${n} dinners · plan ${state.cooking.week}${state.cooking.fallback ? ' · showing the last locked week' : ''}`,
      ];
    },
    cook: () => {
      const f = cookFile();
      if (!f) return ['Cook mode', 'pick a dish, then ask the sous-chef anything'];
      const meta = (recipesCache?.recipes ?? []).find((r) => r.file === f);
      return [meta?.name ?? f.replace(/\.md$/, ''), 'recipe up top · sous-chef below'];
    },
    recipes: () => {
      const n = recipesCache?.recipes?.length;
      return ['Recipe library', n ? `${n} recipes · ratings update at each week's close` : 'the rotation so far'];
    },
    next: () => {
      const w = state.aheadWeekId;
      const p = state.ahead?.plan;
      // Usually next week — but when the current week has no locked plan the
      // server points `ahead` at the current week, so don't mislabel it.
      const lbl = w === state.currentWeekId ? 'This week' : 'Next week';
      if (!p) return [`${lbl} · ${w}`, 'not planned yet'];
      if (p.status === 'planning') return [`${lbl} · ${w}`, 'proposal ready — approve, adjust, then lock'];
      return [`${lbl} · ${w}`, `locked · ${p.meals.filter((m) => !m.flexible).length} dinners · changes still easy`];
    },
    shop: () => {
      // state.shop is the server's decision about which week's list is live.
      const w = state.shop?.week ?? state.aheadWeekId;
      const g = state.shop?.grocery;
      if (!g) return [`Shopping · ${w}`, 'list appears when the week locks'];
      const total = g.stores.reduce((a, s) => a + s.sections.reduce((x, y) => x + y.items.length, 0), 0);
      const done = g.stores.reduce((a, s) => a + s.sections.reduce((x, y) => x + y.items.filter((i) => state.checks[i.key]).length, 0), 0);
      return [`Shopping for ${w}`, `${done}/${total} across ${g.stores.map((s) => s.name.split(' ')[0]).join(' + ')}`];
    },
  };
  const [t, s] = H[tab]();
  $('head-title').textContent = t;
  $('head-sub').textContent = s;
}

function pendingCaptureCount() {
  return Object.values(state?.captures ?? {}).filter((c) => !c.foldedAt).length;
}

function renderStrip() {
  if (!state) return;
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
      fold: 'Recording your log', 'shop-adjust': 'Adjusting the list for', review: 'Closing out' }[run.type] || 'Working on';
    const el = run.startedAt ? mmss(Date.now() - run.startedAt) : '';
    const typ = run.typicalMs ? ` · usually ~${mins(run.typicalMs)} min` : '';
    const doing = runEventsLatest ? ` — ${runEventsLatest}` : '';
    text.innerHTML = `<b>${esc(verb)} ${esc(run.week || '')}</b> · ${el}${esc(typ)}${esc(doing)}`;
    btn.hidden = false;
    btn.textContent = 'Stop';
    btn.className = 'stop';
    btn.onclick = async () => { await expectOk(await jpost('/api/stop'), 'Could not stop.'); };
    if (!tickInt) tickInt = setInterval(renderStrip, 1000);
    return;
  }
  if (tickInt) { clearInterval(tickInt); tickInt = null; }

  const pend = pendingCaptureCount();
  if (pend) {
    strip.className = 'strip';
    text.innerHTML = `<b>${pend} log ${pend === 1 ? 'entry' : 'entries'} saved</b> — ${state.autoFold ? 'folds into the record automatically' : 'waiting for a manual sync'}`;
    btn.hidden = false;
    btn.textContent = 'Sync now';
    btn.className = '';
    btn.onclick = async () => { await expectOk(await jpost('/api/runs/fold'), 'Could not start the sync.'); };
    return;
  }
  if (state.cooking?.closeReady) {
    strip.className = 'strip';
    text.innerHTML = `<b>${esc(state.cooking.week)} is fully logged</b> — close it out when you're ready`;
    btn.hidden = tab !== 'week';
    btn.textContent = 'Close out';
    btn.className = '';
    btn.onclick = closeOutWeek;
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
      ? `<b>${esc(state.aheadWeekId)} isn't planned yet</b> — ${tab === 'next' ? 'hit Propose below' : 'start it on the Next tab'}`
      : `${esc(state.aheadWeekId)} gets planned Friday`;
    return;
  }
  if (state.ahead.plan.status === 'planning') {
    const undecided = state.ahead.approval.filter((a) => !a.approved).length;
    strip.className = 'strip';
    text.innerHTML = undecided
      ? `<b>${esc(state.ahead.week)} proposal is waiting</b> — ${undecided} meal${undecided === 1 ? '' : 's'} to decide`
      : `<b>${esc(state.ahead.week)} fully approved</b> — lock it to build the grocery list`;
    return;
  }
  strip.className = 'strip quiet';
  text.textContent = `${state.ahead.week} locked · shop from the Shop tab`;
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
  if (!lr || !forTypes.includes(lr.type)) return '';
  if (localStorage.getItem('mealapp-result-dismissed') === String(lr.at)) return '';
  const label = { propose: 'Proposal ready', revise: 'Plan revised', lock: 'Week locked',
    fold: 'Log recorded', 'shop-adjust': 'List adjusted', review: 'Week closed out' }[lr.type] || 'Done';
  return `<div class="result ${lr.ok ? '' : 'err'}" id="result-card">
    <button class="dismiss" aria-label="Dismiss" onclick="dismissResult(${lr.at})">✕</button>
    <div class="rlabel">${esc(lr.ok ? label : 'Run failed')} · ${esc(lr.week || '')}</div>
    <div class="rbodytext">${lr.summaryHtml}</div>
  </div>`;
}
window.dismissResult = (at) => { localStorage.setItem('mealapp-result-dismissed', String(at)); renderAll(); };

const runActive = () => !!(state?.run?.active);

/* ---------- WEEK ---------- */
function starsHtml(date, current) {
  let b = '';
  for (let i = 1; i <= 5; i++) {
    b += `<button data-star="${i}" class="${current >= i ? 'on' : ''}" aria-label="${i} star${i > 1 ? 's' : ''}">★</button>`;
  }
  return `<div class="stars" role="group" data-date="${esc(date)}">${b}</div>`;
}

function logBlock(date, plannedDish, fileRating) {
  const cap = state.captures[date];
  const rating = cap?.rating ?? fileRating;
  const note = cap?.note ?? '';
  const dish = cap?.dish ?? '';
  let save = '';
  if (cap) {
    save = cap.foldedAt
      ? `<span class="folded">✓✓ in the record</span>`
      : `✓ saved${cap.by ? ` · ${esc(cap.by)}` : ''} — ${state.autoFold ? 'folds automatically' : 'sync from the banner above'}`;
  } else if (fileRating !== undefined) {
    save = `<span class="folded">✓✓ in the record</span>`;
  }
  return `<div class="log" data-date="${esc(date)}" data-planned="${esc(plannedDish)}">
    <div class="loglabel">How was it?</div>
    <div class="logrow">
      ${starsHtml(date, rating)}
      <button type="button" class="notebtn" data-act="note">${note ? '✎ note' : '＋ note'}</button>
      <button type="button" class="notebtn" data-act="dish">${dish ? '≠ ' + esc(dish) : '≠ cooked something else?'}</button>
    </div>
    <textarea ${note ? '' : 'hidden'} placeholder="Tweaks, verdicts, what to change next time">${esc(note)}</textarea>
    <input class="dishin" ${dish ? '' : 'hidden'} placeholder="What got cooked instead? (or: skipped, takeout…)" value="${esc(dish)}">
    <div class="savestate">${save}</div>
  </div>`;
}

function prepBlock(tasks) {
  if (!tasks.length) return '';
  return `<div class="prep"><div class="preplabel">Prep</div>` + tasks.map((p) => {
    const done = !!state.checks[p.key];
    return `<label class="item"><input type="checkbox" data-key="${esc(p.key)}" ${done ? 'checked' : ''}>
      <span class="box">✓</span><span class="txt">${esc(p.text)}</span></label>`;
  }).join('') + `</div>`;
}

function renderWeek() {
  const v = $('view-week');
  if (!state.cooking) {
    v.innerHTML = resultCard(['fold', 'review']) + `<div class="pending"><h2>No active week</h2>
      <p>There's no locked plan covering today. Head to the <b>Next</b> tab to propose one.</p></div>`;
    return;
  }
  const { plan, dates, week, fallback } = state.cooking;
  let html = resultCard(['fold', 'review']);
  if (fallback) html += `<div class="warnnote"><b>Showing ${esc(week)}</b> — the current week has no locked plan yet.</div>`;

  // carry cards: unlogged stragglers from the previous week
  for (const c of state.carry) {
    html += `<div class="day carry">
      <div class="dow">${esc(c.day)}<small>${dpart(c.date).d}</small></div>
      <div class="daybody">
        <div class="carrylabel">Still unlogged · ${esc(fmtDay(c.date))}</div>
        <h3>${esc(c.dish)}</h3>
        ${logBlock(c.date, c.dish, undefined)}
      </div>
    </div>`;
  }

  const prepByDate = new Map();
  const earlyPrep = [];
  const weekStart = weekSpan(dates).first; // "before the week" = before day 1, whatever day that is
  for (const p of plan.prep) {
    if (p.dueDate && weekStart && p.dueDate >= weekStart) {
      if (!prepByDate.has(p.dueDate)) prepByDate.set(p.dueDate, []);
      prepByDate.get(p.dueDate).push(p);
    } else earlyPrep.push(p);
  }
  if (earlyPrep.length) {
    html += `<div class="card"><h2 style="font-size:16px">Before the week</h2>${prepBlock(earlyPrep)}</div>`;
  }

  const logByDay = new Map(plan.log.map((l) => [l.day, l]));
  for (const m of plan.meals) {
    const date = dates[m.day];
    if (!date) continue; // row on a day this week doesn't have (a drifted file) — no date to card it under
    const tonight = date === state.today;
    const dnum = dpart(date).d;
    if (m.flexible) {
      html += `<div class="day${tonight ? ' tonight' : ''}">
        <div class="dow">${m.day}<small>${dnum}</small></div>
        <div class="daybody">${tonight ? '<span class="tonightbadge">Tonight</span> ' : ''}<span class="flexnote">flexible — leftovers, out, or spontaneous</span></div>
      </div>`;
      continue;
    }
    const fileLog = logByDay.get(m.day);
    const badge = m.isNew ? '<span class="tagnew">NEW</span>'
      : m.favRating ? `<span class="tagfav">★ ${m.favRating}</span>` : '';
    const meta = [m.timeMin && `${m.timeMin} min`, m.cal && `~${m.cal} cal`, m.protein && `${m.protein} g protein`]
      .filter(Boolean).join(' · ');
    const why = plan.whys[m.day] ? `<p class="why">${esc(plan.whys[m.day])}</p>` : '';
    const rlink = [
      m.recipeFile ? `<a href="#" data-recipe="${esc(m.recipeFile)}">Open recipe →</a>` : '',
      tonight && m.recipeFile ? `<a href="#" data-cook="${esc(m.recipeFile)}">Cook mode →</a>` : '',
    ].filter(Boolean).join(' &nbsp;·&nbsp; ');
    html += `<div class="day${tonight ? ' tonight' : ''}">
      <div class="dow">${m.day}<small>${dnum}</small></div>
      <div class="daybody">
        ${tonight ? '<span class="tonightbadge">Tonight</span>' : ''}
        <h3>${esc(m.dish)} ${badge}</h3>
        <div class="meta">${esc(meta)}</div>
        ${why}
        ${rlink}
        ${prepBlock(prepByDate.get(date) ?? [])}
        ${logBlock(date, m.dish, fileLog?.rating)}
      </div>
    </div>`;
  }

  if (plan.status === 'complete' && plan.reviewMd) {
    html += `<div class="card"><h2>Week review</h2><div class="mdbody" data-md-review></div></div>`;
  }
  if (state.cooking.closeReady) {
    html += `<div class="card"><h2>Close out ${esc(week)}</h2>
      <p class="hint">Every night is logged. Closing updates recipe stats, writes the week review, and feeds what it learned into the next plan.</p>
      <button class="primary" id="btn-review" ${runActive() ? 'disabled' : ''}>Close out the week</button></div>`;
  }
  html += `<details class="card" id="hist" style="padding:12px 16px"><summary style="cursor:pointer;font-weight:700">Past weeks</summary>
    <div id="hist-list" style="margin-top:10px"></div><div id="hist-body" class="mdbody" style="margin-top:10px"></div></details>`;
  v.innerHTML = html;

  if (plan.status === 'complete' && plan.reviewMd) {
    const el = v.querySelector('[data-md-review]');
    if (el) el.textContent = plan.reviewMd; // plain text is fine for the strip of prose
  }
  const btnR = $('btn-review');
  if (btnR) btnR.onclick = closeOutWeek;
  const hist = $('hist');
  if (hist) hist.addEventListener('toggle', () => { if (hist.open) void loadHistory(); }, { once: true });
  wireCommon(v);
}

async function closeOutWeek() {
  if (!confirm(`Close out ${state.cooking.week}? This updates recipe stats and preferences.`)) return;
  await expectOk(await jpost('/api/runs/review', { week: state.cooking.week }), 'Could not start the close-out.');
}

async function loadHistory() {
  const list = $('hist-list');
  const r = await fetch('/api/plans');
  const j = await expectOk(r, 'Could not load past weeks.');
  if (!j) return;
  list.innerHTML = j.plans.map((p) =>
    `<button class="ghost" style="margin:0 6px 6px 0" data-plan="${esc(p.file)}">${esc(p.week)} · ${esc(p.status)}</button>`).join('');
  list.querySelectorAll('[data-plan]').forEach((b) => {
    b.onclick = async () => {
      const rr = await fetch(`/api/plans/entry?f=${encodeURIComponent(b.dataset.plan)}`);
      const jj = await expectOk(rr, 'Could not load that week.');
      if (jj) $('hist-body').innerHTML = jj.html;
    };
  });
}

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
        if (j) { if (j.entry) state.captures[date] = j.entry; else delete state.captures[date]; renderAll(); }
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
      const j = await expectOk(await opost('/api/log', { date, [field]: value }), 'Could not save.');
      if (j) {
        if (j.entry) state.captures[date] = j.entry; else delete state.captures[date];
        const ss = log.querySelector('.savestate');
        if (ss) ss.innerHTML = j.entry ? `✓ saved — ${state.autoFold ? 'folds automatically' : 'sync from the banner above'}` : '';
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

/* ---------- NEXT ---------- */
function renderNext() {
  const v = $('view-next');
  const w = state.aheadWeekId;
  const p = state.ahead?.plan;
  let html = resultCard(['propose', 'revise', 'lock']);

  if (!p) {
    html += `<div class="pending"><span class="when">planning</span>
      <h2>Plan ${esc(w)}</h2>
      <p>Claude reads your preferences, the pantry, and the last weeks' ratings, then proposes the week for you to approve meal by meal.</p>
      <textarea class="plain" id="propose-note" placeholder="Anything to plan around? (“we're out Wed–Thu”, “use the frozen shrimp”, “lighter week please”)"></textarea>
      <button class="primary" id="btn-propose" ${runActive() ? 'disabled' : ''}>Propose ${esc(w)}</button>
    </div>`;
    v.innerHTML = html;
    const b = $('btn-propose');
    if (b) b.onclick = async () => {
      b.disabled = true;
      const j = await expectOk(await jpost('/api/runs/propose', { week: w, note: $('propose-note').value }), 'Could not start the proposal.');
      if (!j) b.disabled = false;
    };
    return;
  }

  const fb = state.feedback ?? { meals: {} };
  if (p.status === 'planning') {
    const undecided = state.ahead.approval.filter((a) => !a.approved).length;
    html += `<div class="weeknote"><b>Decide each meal</b> — approve ✓, reject ✗ (say why — it teaches the planner), or ask for a swap ↻. Then send changes, or lock when everything's approved.</div>`;
    for (const m of p.meals) {
      if (m.flexible) continue;
      const d = fb.meals?.[m.day];
      const approvedInFile = m.status === 'approved';
      const decision = d?.decision ?? (approvedInFile ? 'approve' : null);
      const badge = m.isNew ? '<span class="tagnew">NEW</span>' : m.favRating ? `<span class="tagfav">★ ${m.favRating}</span>` : '';
      const meta = [m.timeMin && `${m.timeMin} min`, m.cal && `~${m.cal} cal`, m.protein && `${m.protein} g protein`].filter(Boolean).join(' · ');
      html += `<div class="day prop" data-day="${m.day}">
        <div class="dow">${m.day}</div>
        <div class="daybody">
          <h3>${esc(m.dish)} ${badge}</h3>
          <div class="meta">${esc(meta)}</div>
          ${p.whys[m.day] ? `<p class="why">${esc(p.whys[m.day])}</p>` : ''}
          ${m.recipeFile ? `<a href="#" data-recipe="${esc(m.recipeFile)}">Open recipe →</a>` : ''}
          <div class="decide">
            <button data-dec="approve" class="${decision === 'approve' ? 'on-approve' : ''}">✓ Keep</button>
            <button data-dec="reject" class="${decision === 'reject' ? 'on-reject' : ''}">✗ No</button>
            <button data-dec="swap" class="${decision === 'swap' ? 'on-swap' : ''}">↻ Swap</button>
          </div>
          <div class="dnote" hidden>
            <textarea class="plain" placeholder=""></textarea>
            <button class="ghost" data-act="save-note">Save</button>
          </div>
          ${d ? `<div class="decidedby">${esc(d.decision)}${d.note ? ` — “${esc(d.note)}”` : ''}${d.by ? ` · ${esc(d.by)}` : ''}<button data-act="clear">undo</button></div>`
        : approvedInFile ? `<div class="decidedby">approved in an earlier round</div>` : ''}
        </div>
      </div>`;
    }
    const wk = fb.weekNote?.text ?? '';
    html += `<div class="card"><h2>Anything else?</h2>
      <textarea class="plain" id="week-note" placeholder="Week-level asks: reshuffle days, more vegetables, a different weekend project…">${esc(wk)}</textarea>
      <button class="ghost" id="btn-weeknote">Save note</button>
      <div class="statusline" id="weeknote-status"></div></div>`;
    const hasFeedback = Object.keys(fb.meals ?? {}).length > 0 || !!fb.weekNote;
    html += `<div class="approvebar">`;
    if (undecided === 0) {
      html += `<button class="primary" id="btn-lock" ${runActive() ? 'disabled' : ''}>Lock ${esc(w)} + build the grocery list</button>`;
    } else {
      html += `<button class="primary saffron" id="btn-revise" ${runActive() || !hasFeedback ? 'disabled' : ''}>Send changes to Claude${hasFeedback ? '' : ' (mark meals first)'}</button>`;
    }
    html += `</div>`;
    if (p.rejected.length) {
      html += `<div class="card"><h2 style="font-size:16px">Rejected this round</h2><p class="hint">${p.rejected.map(esc).join('<br>')}</p></div>`;
    }
  } else {
    // locked (or complete) — summary + change requests
    const nights = p.meals.filter((m) => !m.flexible);
    html += `<div class="card"><h2>${esc(w)} is locked ✓</h2>
      <ul class="locked" style="list-style:none;margin:0;padding:0">` +
      nights.map((m) => `<li style="display:flex;gap:10px;padding:8px 0;border-top:1px solid var(--line)">
        <span style="min-width:40px;font-weight:700;color:var(--mut);font-size:13px;text-transform:uppercase;padding-top:2px">${m.day}</span>
        <span>${m.recipeFile ? `<a href="#" data-recipe="${esc(m.recipeFile)}">${esc(m.dish)}</a>` : esc(m.dish)}${m.isNew ? ' <span class="tagnew">NEW</span>' : ''}</span></li>`).join('') +
      `</ul></div>
      <div class="card"><h2>Change something?</h2>
      <p class="hint">The plan is locked so shopping can happen, not because it's rigid — swaps that reuse the list are easy.</p>
      <textarea class="plain" id="revise-note" placeholder="“Swap Tuesday for something lighter”, “push the salmon to Thursday”…"></textarea>
      <button class="primary saffron" id="btn-revise-locked" ${runActive() ? 'disabled' : ''}>Request changes</button></div>`;
  }
  v.innerHTML = html;

  // wire decisions
  v.querySelectorAll('.prop').forEach((card) => {
    const day = card.dataset.day;
    const noteBox = card.querySelector('.dnote');
    const ta = noteBox.querySelector('textarea');
    let pendingDec = null;
    card.querySelectorAll('[data-dec]').forEach((b) => {
      b.onclick = async () => {
        const dec = b.dataset.dec;
        if (dec === 'approve') {
          const j = await expectOk(await opost('/api/feedback', { week: w, day, decision: 'approve' }), 'Could not save.');
          if (j) { state.feedback = j.feedback; renderNext(); renderStrip(); }
          return;
        }
        pendingDec = dec;
        noteBox.hidden = false;
        ta.placeholder = dec === 'reject' ? 'Why not? (required — rejections teach the planner)' : 'Swap it for / toward what?';
        ta.focus();
      };
    });
    noteBox.querySelector('[data-act="save-note"]').onclick = async () => {
      const j = await expectOk(await opost('/api/feedback', { week: w, day, decision: pendingDec, note: ta.value.trim() }), 'Could not save.');
      if (j) { state.feedback = j.feedback; renderNext(); renderStrip(); }
    };
    const clearBtn = card.querySelector('[data-act="clear"]');
    if (clearBtn) clearBtn.onclick = async () => {
      const j = await expectOk(await opost('/api/feedback', { week: w, day, decision: 'clear' }), 'Could not save.');
      if (j) { state.feedback = j.feedback; renderNext(); renderStrip(); }
    };
  });
  const bw = $('btn-weeknote');
  if (bw) bw.onclick = async () => {
    const j = await expectOk(await opost('/api/feedback', { week: w, weekNote: $('week-note').value.trim() }), 'Could not save.');
    if (j) { state.feedback = j.feedback; $('weeknote-status').textContent = 'Saved ✓'; renderStrip(); }
  };
  const br = $('btn-revise');
  if (br) br.onclick = async () => { br.disabled = true;
    const j = await expectOk(await jpost('/api/runs/revise', { week: w }), 'Could not start the revision.');
    if (!j) br.disabled = false; };
  const bl = $('btn-lock');
  if (bl) bl.onclick = async () => { bl.disabled = true;
    const j = await expectOk(await jpost('/api/runs/lock', { week: w }), 'Could not start the lock.');
    if (!j) bl.disabled = false; };
  const brl = $('btn-revise-locked');
  if (brl) brl.onclick = async () => {
    const note = $('revise-note').value.trim();
    if (!note) { toast('Say what to change first.'); return; }
    brl.disabled = true;
    const j = await expectOk(await jpost('/api/runs/revise', { week: w, note }), 'Could not start the revision.');
    if (!j) brl.disabled = false;
  };
  v.querySelectorAll('a[data-recipe]').forEach((a) => {
    a.onclick = (e) => { e.preventDefault(); void openRecipe(a.dataset.recipe); };
  });
}

/* ---------- SHOP ----------
   Which week's list is live is the server's call (state.shop) — on a Saturday
   the active list belongs to the week being cooked, which locked the night
   before, while `ahead` has already rolled forward. Checkbox keys come baked
   into that plan's items, so they follow the same week automatically.
   Extras are the exception: they're "for the next plan", so they stay keyed to
   aheadWeekId and are consumed by the lock run. */
function renderShop() {
  const v = $('view-shop');
  const shop = state.shop ?? { week: state.aheadWeekId, planned: false, grocery: null };
  const g = shop.grocery;
  const w = shop.week;             // the list's week — checkboxes, adjust runs
  const xw = state.aheadWeekId;    // extras' week
  let html = resultCard(['shop-adjust']);

  if (!g) {
    html += `<div class="pending"><span class="when">waiting on the plan</span>
      <h2>No list yet for ${esc(w)}</h2>
      <p>${shop.planned ? 'The list is built when the plan locks — finish approvals on the Next tab.' : 'Plan it on the Next tab; the grocery list is generated when the week locks.'}</p></div>`;
    v.innerHTML = html;
    return;
  }

  for (const store of g.stores) {
    const items = store.sections.flatMap((s) => s.items);
    const done = items.filter((i) => state.checks[i.key]).length;
    html += `<div class="store" data-store><div class="shead"><h2>${esc(store.name)}</h2>
      <span class="count ${done === items.length && items.length ? 'alldone' : ''}">${done}/${items.length}</span></div>`;
    for (const sec of store.sections) {
      if (sec.name) html += `<div class="sec">${esc(sec.name)}</div>`;
      for (const it of sec.items) {
        const c = state.checks[it.key];
        html += `<label class="item"><input type="checkbox" data-key="${esc(it.key)}" ${c ? 'checked' : ''}>
          <span class="box">✓</span><span class="txt">${esc(it.text)}</span><span class="who">${c?.by ? esc(c.by) : ''}</span></label>`;
      }
    }
    html += `</div>`;
  }

  if (g.pantryCheck.length) {
    html += `<div class="store"><div class="shead"><h2>Pantry check</h2><span class="count">verify before you go</span></div>` +
      g.pantryCheck.map((it) => {
        const c = state.checks[it.key];
        return `<label class="item"><input type="checkbox" data-key="${esc(it.key)}" ${c ? 'checked' : ''}>
          <span class="box">✓</span><span class="txt">${esc(it.text)}</span></label>`;
      }).join('') + `</div>`;
  }
  if (g.bulkNotes.length) {
    html += `<div class="weeknote"><b>Bulk math:</b> ${g.bulkNotes.map(esc).join(' · ')}</div>`;
  }

  // extras
  html += `<div class="store"><div class="shead"><h2>Extras</h2><span class="count">${state.extras.length}</span></div>
    <p class="hint" style="color:var(--mut);font-size:13px;margin:0 0 8px">One-off items for this trip — either of you can add. They join the real list at the next plan update.</p>` +
    state.extras.map((e) => {
      const key = `${xw}:extra:${e.id}`;
      const c = state.checks[key];
      return `<label class="item"><input type="checkbox" data-key="${esc(key)}" ${c ? 'checked' : ''}>
        <span class="box">✓</span><span class="txt">${esc(e.text)}${e.by ? `<small>${esc(e.by)}</small>` : ''}</span>
        <button class="delx" data-del-extra="${esc(e.id)}" aria-label="Remove">✕</button></label>`;
    }).join('') +
    `<div class="formline" style="margin-top:8px">
      <input class="plain" id="extra-in" placeholder="Add an item (paper towels, limes…)">
      <button class="ghost" id="extra-add">Add</button>
    </div></div>`;

  html += `<div class="card"><h2>Ask for changes</h2>
    <textarea class="plain" id="shop-note" placeholder="“We already have feta”, “add stuff for guests Saturday”, “swap the salmon for cod”…"></textarea>
    <button class="primary saffron" id="btn-shop-adjust" ${runActive() ? 'disabled' : ''}>Send to Claude</button></div>`;

  v.innerHTML = html;
  wireCommon(v);
  const add = $('extra-add'), input = $('extra-in');
  const doAdd = async () => {
    const text = input.value.trim();
    if (!text) return;
    const j = await expectOk(await opost('/api/extras', { week: xw, text }), 'Could not add.');
    if (j) { input.value = ''; void refetchState(); }
  };
  add.onclick = doAdd;
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); doAdd(); } });
  v.querySelectorAll('[data-del-extra]').forEach((b) => {
    b.onclick = async (e) => {
      e.preventDefault();
      const r = await authedFetch(`/api/extras/${encodeURIComponent(xw)}/${encodeURIComponent(b.dataset.delExtra)}`, { method: 'DELETE' });
      const j = await expectOk(r, 'Could not remove.');
      if (j) void refetchState();
    };
  });
  const bs = $('btn-shop-adjust');
  if (bs) bs.onclick = async () => {
    const note = $('shop-note').value.trim();
    if (!note) { toast('Say what to change first.'); return; }
    bs.disabled = true;
    const j = await expectOk(await jpost('/api/runs/shop-adjust', { week: w, note }), 'Could not start the adjustment.');
    if (!j) bs.disabled = false;
  };
}

function updateShopCounts() {
  const g = state?.shop?.grocery;
  if (!g) return;
  document.querySelectorAll('#view-shop .store[data-store]').forEach((el, idx) => {
    const store = g.stores[idx];
    if (!store) return;
    const items = store.sections.flatMap((s) => s.items);
    const done = items.filter((i) => state.checks[i.key]).length;
    const c = el.querySelector('.count');
    if (c) { c.textContent = `${done}/${items.length}`; c.classList.toggle('alldone', done === items.length && items.length > 0); }
  });
}

/* ---------- RECIPES ---------- */
let recipeSort = localStorage.getItem('mealapp-recipe-sort') || 'rating';
// Expanded cards survive re-renders and screen-lock reloads.
const openRecipes = new Set(Array.isArray(viewState.openRecipes) ? viewState.openRecipes : []);
const recipeBodies = new Map(); // file -> rendered html

async function loadRecipes(force = false) {
  if (!force && recipesCache && Date.now() - recipesCache.at < 60_000) { renderRecipes(); return; }
  const j = await expectOk(await fetch('/api/recipes'), 'Could not load recipes.');
  if (!j) return;
  recipesCache = { recipes: j.recipes, at: Date.now() };
  renderRecipes();
  renderHead();
  if (tab === 'cook' && !cookStreaming) renderCook();
}

// Returns html, false (file doesn't exist — cached so we don't re-ask), or
// null (transient failure — retried on the next render).
async function loadRecipeBody(file) {
  if (recipeBodies.has(file)) return recipeBodies.get(file);
  try {
    const r = await fetch(`/api/recipes/entry?f=${encodeURIComponent(file)}`);
    if (r.status === 404 || r.status === 400) { recipeBodies.set(file, false); return false; }
    if (!r.ok) return null;
    const j = await r.json();
    recipeBodies.set(file, j.html);
    return j.html;
  } catch { return null; }
}
const NOT_YET = '<p style="color:var(--mut)">This recipe file hasn’t been written yet — it appears when the plan locks.</p>';

async function fillRecipeBody(d) {
  const html = await loadRecipeBody(d.dataset.file);
  const slot = d.querySelector('.rmd');
  if (html === null || !slot || !d.isConnected) return;
  slot.innerHTML = html === false ? NOT_YET : html;
}

function renderRecipes() {
  const v = $('view-recipes');
  const rs = [...(recipesCache?.recipes ?? [])];
  const thisWeekFiles = new Set((state?.cooking?.plan?.meals ?? []).map((m) => m.recipeFile).filter(Boolean));
  const sorters = {
    rating: (a, b) => (b.rating ?? -1) - (a.rating ?? -1) || (b.times_cooked ?? 0) - (a.times_cooked ?? 0),
    recent: (a, b) => String(b.last_cooked ?? '').localeCompare(String(a.last_cooked ?? '')),
    cooked: (a, b) => (b.times_cooked ?? 0) - (a.times_cooked ?? 0),
    name: (a, b) => a.name.localeCompare(b.name),
  };
  rs.sort(sorters[recipeSort] ?? sorters.rating);

  let html = `<div class="sortrow">Sort
    <select id="recipe-sort">
      <option value="rating" ${recipeSort === 'rating' ? 'selected' : ''}>by rating</option>
      <option value="recent" ${recipeSort === 'recent' ? 'selected' : ''}>recently cooked</option>
      <option value="cooked" ${recipeSort === 'cooked' ? 'selected' : ''}>most cooked</option>
      <option value="name" ${recipeSort === 'name' ? 'selected' : ''}>by name</option>
    </select></div>`;
  for (const r of rs) {
    const bits = [
      r.rating !== undefined ? `★ ${r.rating}` : 'unrated',
      r.times_cooked ? `${r.times_cooked}× cooked` : 'not yet cooked',
      r.last_cooked ? `last ${r.last_cooked}` : null,
      r.active_time_min ? `${r.active_time_min} min active` : null,
      r.nutrition?.calories ? `~${r.nutrition.calories} cal` : null,
    ].filter(Boolean).join(' · ');
    const open = openRecipes.has(r.file);
    const body = open ? recipeBodies.get(r.file) : undefined;
    html += `<details class="recipe" data-file="${esc(r.file)}"${open ? ' open' : ''}>
      <summary><h3>${esc(r.name)} ${thisWeekFiles.has(r.file) ? '<span class="tagfav">this week</span>' : ''}</h3>
      <div class="meta">${esc(bits)}</div></summary>
      <div class="rbody">
        <div class="ractions"><button class="ghost" data-cookthis="${esc(r.file)}">Cook this →</button></div>
        <div class="rmd">${body ?? '<p style="color:var(--mut)">loading…</p>'}</div>
      </div>
    </details>`;
  }
  v.innerHTML = html;
  $('recipe-sort').onchange = (e) => {
    recipeSort = e.target.value;
    localStorage.setItem('mealapp-recipe-sort', recipeSort);
    renderRecipes();
  };
  v.querySelectorAll('details.recipe').forEach((d) => {
    d.addEventListener('toggle', () => {
      const f = d.dataset.file;
      if (d.open) { openRecipes.add(f); void fillRecipeBody(d); }
      else openRecipes.delete(f);
      saveView({ openRecipes: [...openRecipes] });
    });
    if (d.open) void fillRecipeBody(d);
  });
  v.onclick = (e) => {
    const b = e.target.closest('[data-cookthis]');
    if (b) setCookRecipe(b.dataset.cookthis, true);
  };
}

async function openRecipe(file) {
  await loadRecipes();
  let known = (recipesCache?.recipes ?? []).some((r) => r.file === file);
  if (!known) { await loadRecipes(true); known = (recipesCache?.recipes ?? []).some((r) => r.file === file); }
  if (!known) { toast('That recipe file gets written when the plan locks — the card shows everything so far.'); return; }
  openRecipes.add(file);
  saveView({ openRecipes: [...openRecipes] });
  showTab('recipes', true);
  renderRecipes();
  // instant, not smooth: a state refetch can re-render this list mid-animation,
  // which cancels a smooth scroll and strands the page at the top
  const d = document.querySelector(`details.recipe[data-file="${CSS.escape(file)}"]`);
  if (d) requestAnimationFrame(() => d.scrollIntoView({ block: 'start' }));
}

/* ---------- COOK ---------- */
/* The at-the-stove tab: the recipe being cooked, with a sous-chef chat under
   it (POST /api/cook/ask, streamed). Chat transcripts are per-recipe and live
   in sessionStorage, so a screen lock mid-answer costs nothing. */
let cookStreaming = false;

// The sous-chef is told plain-text-only, but bold slips through; render just
// that, on already-escaped text.
const mdLite = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

function defaultCookFile() {
  const c = state?.cooking;
  if (!c) return null;
  const meals = c.plan.meals.filter((m) => !m.flexible && m.recipeFile);
  if (!meals.length) return null;
  const tonight = meals.find((m) => c.dates[m.day] === state.today);
  if (tonight) return tonight.recipeFile;
  const upcoming = meals.find((m) => c.dates[m.day] > state.today);
  return (upcoming ?? meals[meals.length - 1]).recipeFile;
}
// Explicit picks persist; otherwise follow the week (tonight's dinner, else
// the next one coming up).
function cookFile() {
  return viewState.cook?.file ?? defaultCookFile();
}
function setCookRecipe(file, jump) {
  saveView({ cook: { file } });
  if (jump && tab !== 'cook') {
    showTab('cook', true);
    requestAnimationFrame(() => window.scrollTo(0, 0)); // start at the top of the recipe
  } else renderCook();
  renderHead();
}
function cookChatFor(file) {
  const all = viewState.cookChats ?? {};
  return Array.isArray(all[file]) ? all[file] : [];
}
function saveCookChat(file, msgs) {
  const all = viewState.cookChats ?? {};
  if (msgs.length) all[file] = msgs.slice(-40); else delete all[file];
  saveView({ cookChats: all });
}

function renderCook() {
  if (cookStreaming) return; // never yank the DOM out from under a live answer
  if (!state) return;
  const v = $('view-cook');
  const file = cookFile();
  const draft = $('cook-in')?.value ?? '';

  const weekMeals = (state.cooking?.plan.meals ?? []).filter((m) => !m.flexible && m.recipeFile);
  const weekFiles = new Set(weekMeals.map((m) => m.recipeFile));
  const lib = [...(recipesCache?.recipes ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  const picker = [
    file ? '' : '<option value="" selected disabled>pick a dish…</option>',
    weekMeals.length ? '<optgroup label="This week">' + weekMeals.map((m) =>
      `<option value="${esc(m.recipeFile)}"${m.recipeFile === file ? ' selected' : ''}>${m.day} · ${esc(m.dish)}</option>`).join('') + '</optgroup>' : '',
    lib.length ? '<optgroup label="Recipe library">' + lib.filter((r) => !weekFiles.has(r.file)).map((r) =>
      `<option value="${esc(r.file)}"${r.file === file ? ' selected' : ''}>${esc(r.name)}</option>`).join('') + '</optgroup>' : '',
  ].join('');
  let html = `<div class="cookpickrow"><span>Cooking</span><select id="cook-pick" aria-label="What are you cooking?">${picker}</select></div>`;

  if (!file) {
    html += `<div class="pending"><span class="when">cook mode</span>
      <h2>What are you cooking?</h2>
      <p>Pick a dish above — the recipe opens here with a sous-chef underneath for substitutions, timing, and technique questions.</p></div>`;
    v.innerHTML = html;
    wireCookPick();
    return;
  }

  const meta = (recipesCache?.recipes ?? []).find((r) => r.file === file);
  const wk = weekMeals.find((m) => m.recipeFile === file);
  const tonight = wk && state.cooking.dates[wk.day] === state.today;
  const bits = [
    meta?.rating != null ? `★ ${meta.rating}` : null,
    meta?.active_time_min ? `${meta.active_time_min} min active` : null,
    meta?.servings ? `${meta.servings} servings` : null,
    meta?.nutrition?.calories ? `~${meta.nutrition.calories} cal` : null,
  ].filter(Boolean).join(' · ');
  const body = recipeBodies.get(file);
  html += `<div class="card">
    <h2>${esc(meta?.name ?? wk?.dish ?? file.replace(/\.md$/, ''))}${tonight ? ' <span class="tonightbadge">Tonight</span>' : ''}</h2>
    ${bits ? `<div class="cookmeta">${esc(bits)}</div>` : ''}
    <div class="rbody cookbody" style="padding:0">${body === false ? NOT_YET : (body ?? '<p style="color:var(--mut)">loading…</p>')}</div>
  </div>`;

  const msgs = cookChatFor(file);
  html += `<div class="card">
    <div class="shead"><h2>Sous-chef</h2>${msgs.length ? '<button class="ghost" id="cook-clear">New chat</button>' : ''}</div>
    <p class="hint">Substitutions, timing, technique. It knows this recipe, your preferences, and the pantry.</p>
    <div id="cook-msgs">${msgs.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${m.role === 'user' ? esc(m.text) : mdLite(m.text)}</div>`).join('')}</div>
    <div class="chatline">
      <textarea id="cook-in" rows="1" placeholder="Can I use shallots instead?" enterkeyhint="send"></textarea>
      <button class="primary" id="cook-send">Ask</button>
    </div>
  </div>`;

  v.innerHTML = html;
  wireCookPick();
  if (body === undefined) {
    void loadRecipeBody(file).then((h) => {
      if (h !== null && !cookStreaming && !typingNow()) renderCook();
    });
  }
  const ta = $('cook-in');
  ta.value = draft;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 132) + 'px'; };
  ta.addEventListener('input', grow);
  grow();
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void cookSend(file); }
  });
  $('cook-send').onclick = () => void cookSend(file);
  const clr = $('cook-clear');
  if (clr) clr.onclick = () => { saveCookChat(file, []); renderCook(); };
}

function wireCookPick() {
  const s = $('cook-pick');
  if (s) s.onchange = () => { if (s.value) setCookRecipe(s.value, false); };
}

async function cookSend(file) {
  if (cookStreaming) return;
  const ta = $('cook-in');
  const q = (ta?.value ?? '').trim();
  if (!q) return;
  const before = cookChatFor(file);
  const sent = [...before, { role: 'user', text: q }].slice(-40);
  saveCookChat(file, sent);
  if (ta) ta.value = '';
  renderCook();

  const bubble = document.createElement('div');
  bubble.className = 'msg assistant thinking';
  bubble.textContent = 'thinking…';
  $('cook-msgs').appendChild(bubble);
  bubble.scrollIntoView({ block: 'nearest' });

  cookStreaming = true;
  const sendBtn = $('cook-send');
  if (sendBtn) { sendBtn.disabled = true; sendBtn.textContent = '…'; }
  const pick = $('cook-pick');
  if (pick) pick.disabled = true;
  // follow the growing answer, but stop if the user scrolls up to the recipe
  const follow = () => {
    if (window.innerHeight + window.scrollY > document.documentElement.scrollHeight - 260) {
      bubble.scrollIntoView({ block: 'nearest' });
    }
  };
  let acc = '';
  let restore = '';
  try {
    const r = await authedFetch('/api/cook/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, messages: sent }),
    });
    if (!r.ok || !r.body) {
      let j = null; try { j = await r.json(); } catch { /* no body */ }
      throw new Error((j && j.error) || `The sous-chef didn't answer (${r.status}).`);
    }
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
      bubble.classList.remove('thinking');
      bubble.textContent = acc;
      follow();
    }
    acc = (acc + dec.decode()).trim();
    if (!acc) throw new Error('Empty answer — ask again.');
    saveCookChat(file, [...sent, { role: 'assistant', text: acc }]);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    if (acc.trim()) {
      saveCookChat(file, [...sent, { role: 'assistant', text: acc.trim() + '\n\n⚠︎ answer got cut off — ask again for the rest' }]);
    } else {
      saveCookChat(file, before); // question goes back in the box instead
      restore = q;
    }
  } finally {
    cookStreaming = false;
    renderCook();
    if (restore) { const t = $('cook-in'); if (t) t.value = restore; }
  }
}

/* ---------- SETTINGS (gear sheet) ----------
   Server settings (models, effort, auto-fold) live in app/data/settings.json
   via GET/PUT /api/settings and apply to the next run — never an in-flight
   one. "This device" rows are localStorage/sessionStorage only. The sheet's
   open state deliberately doesn't survive a reload. */
let settingsData = null;
let settingsReturnFocus = null;
const settingsOpen = () => !$('settings').hidden;

const RUN_LABELS = { propose: 'Propose', revise: 'Revise', lock: 'Lock', fold: 'Fold', 'shop-adjust': 'Shop tweak', review: 'Close out' };
const modelLabel = (id) => (settingsData?.options.models ?? []).find((m) => m.id === id)?.label ?? id;

function agoText(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60} min ago`;
  return `${Math.floor(h / 24)} days ago`;
}
function durText(ms) {
  const m = Math.floor(ms / 60000);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  return h < 48 ? `${h} h ${m % 60} min` : `${Math.floor(h / 24)} d ${h % 24} h`;
}
const clock = (t) => new Date(t).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
const stamp = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

function applyTheme(t) {
  const root = document.documentElement;
  if (t === 'light' || t === 'dark') root.setAttribute('data-theme', t);
  else root.removeAttribute('data-theme');
  // forced theme → both theme-color metas match it; system → restore the pair
  document.querySelectorAll('meta[name="theme-color"]').forEach((m) => {
    const sys = (m.getAttribute('media') || '').includes('dark') ? '#151813' : '#F6F6F1';
    m.content = t === 'dark' ? '#151813' : t === 'light' ? '#F6F6F1' : sys;
  });
}
const storedTheme = () => { try { return localStorage.getItem('mealapp-theme') || 'system'; } catch { return 'system'; } };

function openSettings() {
  settingsReturnFocus = document.activeElement;
  $('settings').hidden = false;
  document.body.classList.add('sheet-open');
  // everything behind the sheet is inert: no tabbing or screen-reader wander
  document.querySelector('.wrap').inert = true;
  document.querySelector('nav.tabs').inert = true;
  renderSettings();
  $('settings').querySelector('.sheet-x').focus();
  void loadSettings();
}
function closeSettings() {
  if (!settingsOpen()) return;
  $('settings').hidden = true;
  document.body.classList.remove('sheet-open');
  document.querySelector('.wrap').inert = false;
  document.querySelector('nav.tabs').inert = false;
  if (settingsReturnFocus && settingsReturnFocus.focus) settingsReturnFocus.focus();
}
$('btn-settings').onclick = openSettings;
$('settings').querySelectorAll('[data-close]').forEach((el) => { el.onclick = closeSettings; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && settingsOpen()) { e.preventDefault(); closeSettings(); } });

async function loadSettings() {
  try {
    const r = await fetch('/api/settings');
    if (!r.ok) throw new Error(String(r.status));
    settingsData = await r.json();
  } catch {
    if (!settingsData) { $('settings-body').innerHTML = '<p class="set-hint">Couldn’t reach the server — is the Mac awake?</p>'; return; }
  }
  if (settingsOpen()) renderSettings();
}

async function putSettings(patch) {
  const r = await authedFetch('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const j = await expectOk(r, 'Could not save that setting.');
  if (j) {
    settingsData = j;
    toast('Saved — applies from the next run.');
    if (state && 'autoFold' in patch) { state.autoFold = j.values.autoFold; renderStrip(); }
  }
  renderSettings(); // success shows the new value; failure snaps the control back
}

function modelSelect(key, fallbackId) {
  const d = settingsData;
  const cur = d.stored[key] ?? '';
  const opts = [`<option value=""${cur ? '' : ' selected'}>Default (${esc(modelLabel(fallbackId))})</option>`]
    .concat(d.options.models.map((m) => `<option value="${esc(m.id)}"${cur === m.id ? ' selected' : ''}>${esc(m.label)}</option>`));
  return `<select data-set="${key}" aria-label="Model"${cur ? ' class="custom"' : ''}>${opts.join('')}</select>`;
}
function effortSelect(key) {
  const d = settingsData;
  const cur = d.stored[key] ?? '';
  const opts = [`<option value=""${cur ? '' : ' selected'}>Default (auto)</option>`]
    .concat(d.options.efforts.map((e) => `<option value="${e}"${cur === e ? ' selected' : ''}>Effort: ${e}</option>`));
  return `<select data-set="${key}" aria-label="Effort"${cur ? ' class="custom"' : ''}>${opts.join('')}</select>`;
}

function statusHtml() {
  const s = settingsData.status;
  const now = Date.now();
  let html = '';
  if (s.lastPull && !s.lastPull.ok) {
    html += `<div class="set-alert"><b>Git pull failed</b> ${esc(agoText(now - s.lastPull.at))} — the app may be showing stale plans.<br><code>${esc(s.lastPull.message)}</code></div>`;
  }
  const rows = [];
  rows.push(['Passcode gate', s.passcodeGate ? '<span class="set-ok">armed</span>' : '<span class="set-bad">off — anyone on the network can spend runs</span>']);
  rows.push(['Server', `up ${esc(durText(s.uptimeMs))} · since ${esc(stamp(s.startedAt))}`]);
  if (s.run.active) rows.push(['Run', `${esc(RUN_LABELS[s.run.type] || s.run.type)} in progress · ${esc(agoText(now - s.run.startedAt).replace(' ago', ''))}`]);
  rows.push(['Code', s.git ? `<code>${esc(s.git.sha)}</code> ${esc(s.git.subject)}` : 'unknown']);
  rows.push(['Agent SDK', `${esc(s.sdkVersion)} · node ${esc(s.node)}`]);
  rows.push(['Last git pull', s.lastPull
    ? `${s.lastPull.ok ? '<span class="set-ok">ok</span>' : '<span class="set-bad">failed</span>'} · ${esc(agoText(now - s.lastPull.at))}${s.lastPull.ok ? ` · ${esc(s.lastPull.message)}` : ''}`
    : 'not yet']);
  let fold = `${s.pendingCaptures} pending`;
  if (s.pendingCaptures) {
    if (!s.autoFold.on) fold += ' · auto-fold off — use Sync now';
    else if (s.autoFold.waitingForCapture) fold += ' · auto-fold waits for the next capture (or Sync now)';
    else if (s.autoFold.nextEligibleAt) fold += s.autoFold.nextEligibleAt <= now ? ' · folding within a minute' : ` · auto-folds ~${esc(clock(s.autoFold.nextEligibleAt))}`;
  }
  rows.push(['Log captures', fold]);
  const typ = Object.entries(s.typicalMs).filter(([, v]) => v)
    .map(([k, v]) => `${esc(RUN_LABELS[k] || k)} ~${Math.max(1, Math.round(v / 60000))} min`).join(' · ');
  rows.push(['Typical runs', typ || 'no runs recorded yet']);
  html += `<dl class="set-stat">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  return html;
}

function renderSettings() {
  const body = $('settings-body');
  if (!settingsData) { body.innerHTML = '<p class="set-hint">loading…</p>'; return; }
  const d = settingsData;
  const chats = Object.keys(viewState.cookChats ?? {}).length;
  const theme = storedTheme();
  const hasPass = !!passcode;
  const quietCur = d.stored.foldQuietMin ?? '';

  body.innerHTML = `
  <section class="set-sec">
    <h3>Models</h3>
    <p class="set-hint">Changes apply to the next run or question — never one already running. Planning runs on Fable are the expensive ones; “auto” effort leaves it to the model.</p>
    <div class="set-row"><span class="lbl">Planning &amp; review<small>propose · revise · lock · close out</small></span>
      <div class="set-pair">${modelSelect('planModel', d.defaults.planModel)}${effortSelect('planEffort')}</div></div>
    <div class="set-row"><span class="lbl">Light runs<small>fold the log · shop tweaks</small></span>
      <div class="set-pair">${modelSelect('lightModel', d.defaults.lightModel)}${effortSelect('lightEffort')}</div></div>
    <div class="set-row"><span class="lbl">Sous-chef<small>Cook tab chat${d.stored.cookModel ? '' : ' · default follows the light model'}</small></span>
      <div class="set-pair">${modelSelect('cookModel', d.defaults.cookModel)}${effortSelect('cookEffort')}</div></div>
  </section>

  <section class="set-sec">
    <h3>Log folding</h3>
    <p class="set-hint">Stars and notes save instantly; a light run writes them into the plan files once things go quiet.</p>
    <div class="set-row set-inline"><span class="lbl">Auto-fold<small>${d.values.autoFold ? 'on' : 'off — Sync now from the banner'}${d.stored.autoFold === undefined ? ' (default)' : ''}</small></span>
      <span class="switch"><input type="checkbox" id="set-autofold" aria-label="Auto-fold" ${d.values.autoFold ? 'checked' : ''}><span class="track"></span></span></div>
    <div class="set-row set-inline"><span class="lbl">Quiet time before folding</span>
      <select data-set="foldQuietMin" aria-label="Quiet time before folding"${quietCur ? ' class="custom"' : ''}>
        <option value=""${quietCur ? '' : ' selected'}>Default (${d.defaults.foldQuietMin} min)</option>
        ${d.options.foldQuietMin.map((n) => `<option value="${n}"${quietCur === n ? ' selected' : ''}>${n} min</option>`).join('')}
      </select></div>
  </section>

  <section class="set-sec">
    <h3>This device</h3>
    <div class="set-row"><span class="lbl">Passcode<small>${hasPass ? 'saved on this device' : 'not saved here — you’ll be asked when needed'} · server gate ${d.status.passcodeGate ? 'armed' : 'off'}</small></span>
      <div class="set-actions">
        <button class="ghost" id="set-pass">${hasPass ? 'Change passcode' : 'Set passcode'}</button>
        ${hasPass ? '<button class="ghost" id="set-forget">Forget passcode</button>' : ''}
      </div></div>
    <div class="set-row"><span class="lbl">Theme</span>
      <div class="seg" role="radiogroup" aria-label="Theme">
        ${['system', 'light', 'dark'].map((t) => `<label><input type="radio" name="set-theme" value="${t}" ${theme === t ? 'checked' : ''}><span>${t[0].toUpperCase() + t.slice(1)}</span></label>`).join('')}
      </div></div>
    <div class="set-row"><span class="lbl">Sous-chef chats<small>${chats ? `${chats} saved in this browser tab` : 'none saved'}</small></span>
      <div class="set-actions"><button class="ghost" id="set-clearchats" ${chats && !cookStreaming ? '' : 'disabled'}>Clear sous-chef chats</button></div></div>
  </section>

  <section class="set-sec">
    <h3>Status</h3>
    ${statusHtml()}
  </section>`;

  body.querySelectorAll('select[data-set]').forEach((sel) => {
    sel.onchange = () => {
      const key = sel.dataset.set;
      const v = sel.value;
      void putSettings({ [key]: v === '' ? null : key === 'foldQuietMin' ? Number(v) : v });
    };
  });
  $('set-autofold').onchange = (e) => {
    const on = e.target.checked;
    // matching the env/built-in default → drop the override instead of pinning it
    void putSettings({ autoFold: on === d.defaults.autoFold ? null : on });
  };
  $('set-pass').onclick = setPasscode;
  const fg = $('set-forget');
  if (fg) fg.onclick = () => {
    passcode = '';
    try { localStorage.removeItem('mealapp-passcode'); } catch { /* ignore */ }
    toast('Passcode forgotten on this device.');
    renderSettings();
  };
  body.querySelectorAll('input[name="set-theme"]').forEach((r) => {
    r.onchange = () => {
      try { if (r.value === 'system') localStorage.removeItem('mealapp-theme'); else localStorage.setItem('mealapp-theme', r.value); } catch { /* ignore */ }
      applyTheme(r.value);
    };
  });
  $('set-clearchats').onclick = () => {
    if (cookStreaming) return;
    saveView({ cookChats: {} });
    renderCook();
    toast(`Cleared ${chats} sous-chef chat${chats === 1 ? '' : 's'}.`);
    renderSettings();
  };
}

// Checks a passcode with an empty PUT (a no-op that still hits the gate)
// before storing it, so a typo doesn't get saved as "the" passcode.
async function setPasscode() {
  const entered = prompt('Passcode for the meal planner:');
  if (entered === null) return;
  const p = entered.trim();
  if (!p) return;
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-mealapp-passcode': p }, body: '{}',
    });
    if (r.status === 401) { toast('That passcode didn’t work.'); return; }
    if (!r.ok) { toast(`Couldn’t check the passcode (${r.status}).`); return; }
  } catch { toast('Server unreachable — try again.'); return; }
  passcode = p;
  try { localStorage.setItem('mealapp-passcode', p); } catch { /* ignore */ }
  toast('Passcode saved on this device.');
  renderSettings();
}

/* ---------- boot ---------- */
showTab(tab);
connectWS();
void refetchState();
