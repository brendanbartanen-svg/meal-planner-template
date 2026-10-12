/* 70-pantry.js — the Pantry sheet: profile/pantry.md as collapsible sections
   of staples (add · mark running low · remove) and the freezer inventory
   (add · Used, with an optional note). Opened from the Shop tab's "Pantry"
   button and Settings → "Open the pantry": both carry [data-open-pantry] and
   are wired here by one delegated listener, so those files only render a tag.
   Every edit is a passcode-gated API call (server/pantry-routes.ts). The
   server applies it to pantry.md deterministically (server/pantry.ts) and
   commits it (server/commit.ts); the push runs in the background, so the
   status line goes "saved · push pending" → "saved · pushed" when the
   follow-up `pantry-updated` WS message arrives. Edits are refused while a
   run holds the repo (the agent owns git then). Other devices refresh on the
   same WS message: 00-core.js owns the socket, so this file adds its own
   message listener to whichever socket is current while the sheet is open.
   The sheet is built once on <body>, outside .wrap, like the Ask sheet.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

const PANTRY_BUSY_MSG = 'Claude is editing the repo right now; try after the run.';
let pantryData = null;        // GET /api/pantry: { pantry: { sections }, git, gitDisabled, busy }
let pantryLoadErr = '';
let pantrySaving = false;     // an edit in flight
let pantryReloadAfter = false; // a pantry-updated arrived mid-edit
let pantryDelArm = '';        // item id armed for removal (two-tap ✕)
let pantryUseFor = '';        // freezer item id whose "Used" note row is open
let pantryExpanded = new Set(); // long items shown in full
const pantryUsedOpen = new Set(); // sections whose "Used (N)" list is open
let pantryTick = null;
let pantryReturnFocus = null;
let pantryRunWas = false;
const pantryWsSeen = new WeakSet();
// expanded sections, remembered for this browser tab (null = first two open)
let pantryOpenSecs = Array.isArray(viewState.pantryOpenSecs) ? new Set(viewState.pantryOpenSecs) : null;

/* ---------- the sheet (built once) ---------- */
const pantrySheet = (() => {
  const el = document.createElement('div');
  el.className = 'sheet pansheet';
  el.id = 'pantry-sheet';
  el.hidden = true;
  el.innerHTML = `<div class="sheet-backdrop" data-close></div>
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="pantry-title" aria-describedby="pantry-hint">
      <div class="sheet-head">
        <div class="grow"><h2 id="pantry-title">Pantry</h2>
          <p class="pan-status" id="pantry-status" role="status" aria-live="polite"></p></div>
        <button class="sheet-x" type="button" aria-label="Close the pantry" data-close>✕</button>
      </div>
      <div class="sheet-body" id="pantry-body">
        <p class="pan-hint" id="pantry-hint">Staples are subtracted from grocery lists; mark what's running low.</p>
        <p class="pan-busy" id="pantry-busy" hidden></p>
        <form class="pan-pass" id="pantry-pass" hidden>
          <label for="pantry-pass-in" id="pantry-pass-lbl">Editing the pantry needs the household passcode (once per device).</label>
          <div class="pan-passrow">
            <input id="pantry-pass-in" type="password" autocomplete="current-password" placeholder="Passcode">
            <button class="primary" type="submit">Save</button>
          </div>
        </form>
        <div id="pantry-secs"><p class="pan-hint">loading…</p></div>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
})();
const pantryOpen = () => !pantrySheet.hidden;

/* ---------- data ---------- */
async function loadPantry() {
  try {
    const r = await fetch('/api/pantry');
    const j = await r.json().catch(() => null);
    if (!r.ok || !j || !j.pantry) throw new Error((j && j.error) || `pantry ${r.status}`);
    pantryData = j;
    pantryLoadErr = '';
  } catch (err) {
    pantryLoadErr = `Couldn’t load the pantry (${err instanceof Error ? err.message : String(err)}).`;
  }
  if (pantryOpen()) renderPantry();
}

// Light inline markdown: escaped, `**` dropped (the file bolds warnings inside items).
const pantryInline = (s) => esc(s).replace(/\*\*(.+?)\*\*/g, '$1').replace(/\*\*/g, '');

function pantryNeedPass() { return !!state?.passcodeGate && !passcode; }
function pantryRunOn() { return !!state?.run?.active; }

/* ---------- status line ---------- */
function pantryStatusText() {
  if (pantrySaving) return 'saving…';
  const d = pantryData;
  if (!d) return '';
  const g = d.git;
  const when = g && typeof agoText === 'function' ? ` · ${agoText(Date.now() - g.at)}` : '';
  if (!g) return d.gitDisabled ? 'git disabled (dev)' : '';
  if (!g.committed) {
    if (g.reason === 'git disabled' || d.gitDisabled) return `saved · git disabled (dev)${when}`;
    return g.reason === 'nothing to commit' ? `saved · nothing new to commit${when}` : '';
  }
  if (g.pushed === true) return `saved · pushed${when}`;
  if (g.pushed === 'pending') return 'saved · push pending';
  return `saved · push failed: ${g.error || 'unknown error'}`;
}
function paintPantryStatus() {
  const el = $('pantry-status');
  const t = pantryStatusText();
  if (el.textContent !== t) el.textContent = t;
  const g = pantryData?.git;
  el.className = 'pan-status' + (g && g.committed && g.pushed === false ? ' bad' : g && g.pushed === true ? ' ok' : '');
}

// Passcode form + run-busy line + disabled controls; every second while open.
function paintPantryGate() {
  const need = pantryNeedPass();
  $('pantry-pass').hidden = !need && !$('pantry-pass').dataset.retry;
  const runOn = pantryRunOn();
  const bl = $('pantry-busy');
  bl.hidden = !runOn;
  if (runOn && bl.textContent !== PANTRY_BUSY_MSG) bl.textContent = PANTRY_BUSY_MSG;
  // inputs stay enabled while a save is in flight: disabling the focused box
  // would drop focus and close the phone keyboard between two additions
  const lockInputs = runOn || need;
  const lockButtons = lockInputs || pantrySaving;
  pantrySheet.querySelectorAll('#pantry-secs button').forEach((c) => { c.disabled = lockButtons; });
  pantrySheet.querySelectorAll('#pantry-secs input').forEach((c) => { c.disabled = lockInputs; });
  if (runOn !== pantryRunWas) {
    pantryRunWas = runOn;
    if (!runOn) void loadPantry(); // the run may have edited pantry.md
  }
  paintPantryStatus();
  pantryHookWS();
}

/* ---------- render ---------- */
function pantryItemHtml(it, sec) {
  const id = esc(it.id);
  const armed = pantryDelArm === it.id;
  const full = pantryExpanded.has(it.id);
  const long = it.text.length > 110;
  const txt = `<span class="pan-txt${long ? ' long' : ''}${full ? ' full' : ''}"${long ? ` data-act="expand" data-id="${id}" role="button" tabindex="0" aria-expanded="${full}"` : ''}>${pantryInline(it.text)}</span>`;
  const lowPill = `<button type="button" class="pan-low${it.low ? ' on' : ''}" data-act="low" data-id="${id}" aria-pressed="${it.low}"
    aria-label="${it.low ? `Running low${it.lowSince ? ` since ${fmtDay(it.lowSince)}` : ''}: tap to clear` : 'Mark running low'}">${it.low ? `⚠️ low${it.lowSince ? ` · ${fmtDay(it.lowSince)}` : ''}` : 'low'}</button>`;
  const del = `<button type="button" class="delx${armed ? ' armed' : ''}" data-act="del" data-id="${id}" aria-label="${armed ? 'Tap again to remove' : 'Remove'}">${armed ? 'Remove' : '✕'}</button>`;
  // freezer rows: Used + remove (a low marker already on one still shows, and clears)
  const acts = sec.isFreezer
    ? `${it.low ? lowPill : ''}<button type="button" class="pan-use" data-act="use" data-id="${id}" aria-expanded="${pantryUseFor === it.id}">Used</button>${del}`
    : `${lowPill}${del}`;
  const useRow = pantryUseFor === it.id
    ? `<form class="pan-useform" data-useform="${id}">
        <input class="plain" name="note" maxlength="120" placeholder="Note (optional), e.g. Tue gochujang" aria-label="Note for this freezer item (optional)">
        <button class="primary" type="submit">Mark used</button>
        <button class="ghost" type="button" data-act="use-cancel">Cancel</button>
      </form>` : '';
  return `<li class="pan-item${it.low ? ' low' : ''}"><div class="pan-row">${txt}<span class="pan-acts">${acts}</span></div>${useRow}</li>`;
}

function pantryUsedHtml(it) {
  const armed = pantryDelArm === it.id;
  return `<li class="pan-item used"><div class="pan-row"><span class="pan-txt"><s>${pantryInline(it.text)}</s>${it.usedNote ? ` <small>${pantryInline(it.usedNote)}</small>` : ''}</span>
    <span class="pan-acts"><button type="button" class="delx${armed ? ' armed' : ''}" data-act="del" data-id="${esc(it.id)}" aria-label="${armed ? 'Tap again to remove' : 'Remove'}">${armed ? 'Remove' : '✕'}</button></span></div></li>`;
}

function pantrySecHtml(sec, i) {
  const open = pantryOpenSecs ? pantryOpenSecs.has(sec.name) : i < 2;
  const active = sec.items.filter((x) => !x.used);
  const used = sec.items.filter((x) => x.used);
  const lowN = active.filter((x) => x.low).length;
  const name = esc(sec.name);
  return `<details class="pan-sec${sec.isFreezer ? ' freezer' : ''}" data-sec="${name}"${open ? ' open' : ''}>
    <summary><span class="pan-name">${name}</span><span class="pan-count">${active.length}${lowN ? ` · <b>${lowN} low</b>` : ''}</span></summary>
    <ul class="pan-list">${active.map((x) => pantryItemHtml(x, sec)).join('') || '<li class="pan-empty">Nothing here yet.</li>'}</ul>
    ${used.length ? `<details class="pan-used"${pantryUsedOpen.has(sec.name) ? ' open' : ''}><summary>Used (${used.length})</summary><ul class="pan-list">${used.map(pantryUsedHtml).join('')}</ul></details>` : ''}
    <form class="pan-add" data-add="${name}"${sec.isFreezer ? ' data-freezer="1"' : ''}>
      <input class="plain" name="text" maxlength="200" enterkeyhint="done"
        placeholder="${sec.isFreezer ? 'Add to freezer (2 lb shrimp…)' : `Add to ${name}`}" aria-label="${sec.isFreezer ? 'Add to freezer' : `Add to ${name}`}">
      <button class="ghost" type="submit">Add</button>
    </form>
  </details>`;
}

function renderPantry() {
  const box = $('pantry-secs');
  // keep half-typed additions and focus across re-renders (another device's edit, a push landing)
  const drafts = {};
  box.querySelectorAll('form.pan-add').forEach((f) => { const v = f.elements.text.value; if (v) drafts[f.dataset.add] = v; });
  const noteDraft = box.querySelector('form.pan-useform input')?.value || '';
  const act = document.activeElement;
  const focusAdd = act && act.closest && act.closest('form.pan-add') && pantrySheet.contains(act) ? act.closest('form.pan-add').dataset.add : null;
  const focusNote = !!(act && act.closest && act.closest('form.pan-useform'));

  if (!pantryData) {
    box.innerHTML = `<p class="pan-hint">${esc(pantryLoadErr || 'loading…')}</p>`;
  } else {
    const secs = pantryData.pantry.sections;
    box.innerHTML = (pantryLoadErr ? `<p class="pan-err">${esc(pantryLoadErr)}</p>` : '')
      + (secs.length ? secs.map(pantrySecHtml).join('') : '<p class="pan-hint">profile/pantry.md has no ## sections yet.</p>');
    box.querySelectorAll('form.pan-add').forEach((f) => { if (drafts[f.dataset.add]) f.elements.text.value = drafts[f.dataset.add]; });
    const nf = box.querySelector('form.pan-useform input');
    if (nf && noteDraft) nf.value = noteDraft;
    if (focusAdd !== null) {
      const f = [...box.querySelectorAll('form.pan-add')].find((x) => x.dataset.add === focusAdd);
      if (f) { const inp = f.elements.text; inp.focus({ preventScroll: true }); inp.setSelectionRange(inp.value.length, inp.value.length); }
    } else if (focusNote && nf) nf.focus({ preventScroll: true });
  }
  paintPantryGate();
}

/* ---------- edits ---------- */
async function pantryEdit(method, url, body) {
  if (pantrySaving) return null;
  if (pantryRunOn()) { toast(PANTRY_BUSY_MSG); return null; }
  if (pantryNeedPass()) { paintPantryGate(); $('pantry-pass-in').focus(); return null; }
  pantrySaving = true;
  paintPantryGate();
  try {
    const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(passcode ? { 'x-mealapp-passcode': passcode } : {}) };
    const r = await fetch(url, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const j = await r.json().catch(() => null);
    if (r.status === 401) {
      $('pantry-pass').dataset.retry = '1';
      $('pantry-pass-lbl').textContent = 'That passcode didn’t work here. Enter the current household passcode.';
      return null;
    }
    if (r.status === 404) { toast((j && j.error) || 'That item changed. Refreshed.'); void loadPantry(); return null; }
    if (!r.ok || !j) { toast((j && j.error) || `Couldn’t save the pantry (${r.status}).`); return null; }
    const git = j.git && j.git.reason === 'no change' ? pantryData?.git ?? null : j.git;
    pantryData = { ...(pantryData || {}), pantry: j.pantry, git };
    return j;
  } catch {
    toast('Server unreachable. Try again.');
    return null;
  } finally {
    pantrySaving = false;
    renderPantry();
    if (pantryReloadAfter) { pantryReloadAfter = false; void loadPantry(); }
  }
}

function pantryDisarm() {
  if (pantryDelArm) { pantryDelArm = ''; renderPantry(); }
}

/* ---------- open / close ---------- */
function openPantry(opener) {
  if (typeof settingsOpen === 'function' && settingsOpen()) {
    closeSettings();
    pantryReturnFocus = $('btn-settings');
  } else {
    pantryReturnFocus = opener || document.activeElement;
  }
  if (pantryOpen()) return;
  pantrySheet.hidden = false;
  document.body.classList.add('sheet-open');
  document.querySelector('.wrap').inert = true;
  document.querySelector('nav.tabs').inert = true;
  saveView({ pantrySheet: true });
  pantryRunWas = pantryRunOn();
  renderPantry();
  fitPantrySheet();
  pantrySheet.querySelector('.sheet-x').focus();
  clearInterval(pantryTick);
  pantryTick = setInterval(paintPantryGate, 1000);
  void loadPantry();
}
function closePantry() {
  if (!pantryOpen()) return;
  pantrySheet.hidden = true;
  clearInterval(pantryTick);
  pantryTick = null;
  pantryUseFor = '';
  pantryDelArm = '';
  const others = [...document.querySelectorAll('.sheet')].some((s) => s !== pantrySheet && !s.hidden);
  if (!others) {
    document.body.classList.remove('sheet-open');
    document.querySelector('.wrap').inert = false;
    document.querySelector('nav.tabs').inert = false;
  }
  saveView({ pantrySheet: false });
  if (pantryReturnFocus && pantryReturnFocus.focus && document.contains(pantryReturnFocus)) pantryReturnFocus.focus({ preventScroll: true });
}
pantrySheet.querySelectorAll('[data-close]').forEach((el) => { el.onclick = closePantry; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && pantryOpen()) { e.preventDefault(); closePantry(); } });
document.addEventListener('click', (e) => {
  const b = e.target.closest && e.target.closest('[data-open-pantry]');
  if (!b) return;
  e.preventDefault();
  openPantry(b);
});

// Android Chrome overlays the keyboard: pad the list so the add box being
// typed in can scroll above it (same --kb measure as the Ask sheet).
function fitPantrySheet() {
  const panel = pantrySheet.querySelector('.sheet-panel');
  const vv = window.visualViewport;
  if (!vv || !pantryOpen() || vv.scale > 1.05) { panel.style.removeProperty('--kb'); return; }
  panel.style.setProperty('--kb', `${Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop))}px`);
}
window.visualViewport?.addEventListener('resize', fitPantrySheet);

/* ---------- live updates ---------- */
function pantryHookWS() {
  if (typeof ws === 'undefined' || !ws || pantryWsSeen.has(ws)) return;
  pantryWsSeen.add(ws);
  ws.addEventListener('message', (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (!m || m.type !== 'pantry-updated' || !pantryOpen()) return;
    if (pantrySaving) { pantryReloadAfter = true; return; }
    void loadPantry();
  });
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && pantryOpen()) void loadPantry(); });

/* ---------- wiring (delegated on the sheet) ---------- */
pantrySheet.addEventListener('toggle', (e) => {
  const d = e.target;
  if (!(d instanceof HTMLDetailsElement)) return;
  if (d.classList.contains('pan-used')) {
    const name = d.closest('details.pan-sec')?.dataset.sec;
    if (name !== undefined) { if (d.open) pantryUsedOpen.add(name); else pantryUsedOpen.delete(name); }
    return;
  }
  if (!d.classList.contains('pan-sec')) return;
  pantryOpenSecs = new Set([...pantrySheet.querySelectorAll('details.pan-sec[open]')].map((x) => x.dataset.sec));
  saveView({ pantryOpenSecs: [...pantryOpenSecs] });
}, true);

pantrySheet.addEventListener('click', async (e) => {
  const t = e.target.closest('[data-act]');
  if (!t || !pantrySheet.contains(t)) { if (pantryDelArm && !e.target.closest('.delx')) pantryDisarm(); return; }
  const id = t.dataset.id || '';
  const act = t.dataset.act;
  if (act !== 'del' && pantryDelArm) pantryDelArm = '';
  if (act === 'expand') {
    if (pantryExpanded.has(id)) pantryExpanded.delete(id); else pantryExpanded.add(id);
    renderPantry();
  } else if (act === 'low') {
    const on = t.getAttribute('aria-pressed') !== 'true';
    const j = await pantryEdit('PUT', `/api/pantry/items/${encodeURIComponent(id)}/low`, { low: on });
    if (j) toast(on ? 'Marked running low · it goes on the next Pantry check' : 'Running-low mark cleared');
  } else if (act === 'del') {
    // same two-tap pattern as the Recipes tab's shares: armed until the next tap anywhere in the sheet
    if (pantryDelArm !== id) { pantryDelArm = id; renderPantry(); return; }
    pantryDelArm = '';
    const j = await pantryEdit('DELETE', `/api/pantry/items/${encodeURIComponent(id)}`);
    if (j) toast('Removed from the pantry');
  } else if (act === 'use') {
    pantryUseFor = pantryUseFor === id ? '' : id;
    renderPantry();
    if (pantryUseFor) pantrySheet.querySelector('form.pan-useform input')?.focus();
  } else if (act === 'use-cancel') {
    pantryUseFor = '';
    renderPantry();
  }
});
pantrySheet.addEventListener('keydown', (e) => {
  const t = e.target.closest && e.target.closest('[data-act="expand"]');
  if (t && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); t.click(); }
});

pantrySheet.addEventListener('submit', async (e) => {
  const f = e.target;
  if (!(f instanceof HTMLFormElement)) return;
  e.preventDefault();
  if (f.id === 'pantry-pass') { void pantrySavePass(); return; }
  if (f.matches('form.pan-add')) {
    const inp = f.elements.text;
    const text = inp.value.trim();
    if (!text) { inp.focus(); return; }
    const j = f.dataset.freezer
      ? await pantryEdit('POST', '/api/pantry/freezer', { text })
      : await pantryEdit('POST', '/api/pantry/items', { section: f.dataset.add, text });
    if (j) {
      const again = [...$('pantry-secs').querySelectorAll('form.pan-add')].find((x) => x.dataset.add === f.dataset.add);
      if (again) { again.elements.text.value = ''; again.elements.text.focus({ preventScroll: true }); }
      toast(`Added to ${f.dataset.freezer ? 'the freezer' : f.dataset.add}`);
    }
  } else if (f.matches('form.pan-useform')) {
    const id = f.dataset.useform;
    const note = f.elements.note.value.trim();
    const j = await pantryEdit('POST', `/api/pantry/freezer/${encodeURIComponent(id)}/used`, note ? { note } : {});
    if (j) { pantryUseFor = ''; renderPantry(); toast('Marked used · moved to Used'); }
  }
});
pantrySheet.addEventListener('focusin', (e) => {
  // bring the box being typed in above the keyboard once it has opened — only
  // when it's actually hidden, so a refocus after an add doesn't jump the list
  const el = e.target;
  if (!(el.matches && el.matches('#pantry-secs input'))) return;
  setTimeout(() => {
    if (document.activeElement !== el) return;
    const r = el.getBoundingClientRect();
    const vh = window.visualViewport ? window.visualViewport.height : window.innerHeight;
    const top = pantrySheet.querySelector('.sheet-head').getBoundingClientRect().bottom;
    if (r.bottom > vh - 12 || r.top < top) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  }, 320);
});

// Same check as Settings → Set passcode: an empty PUT still hits the gate.
async function pantrySavePass() {
  const inp = $('pantry-pass-in');
  const p = inp.value.trim();
  if (!p) return;
  try {
    const r = await fetch('/api/settings', {
      method: 'PUT', headers: { 'content-type': 'application/json', 'x-mealapp-passcode': p }, body: '{}',
    });
    if (r.status === 401) { toast('That passcode didn’t work.'); return; }
    if (!r.ok) { toast(`Couldn’t check the passcode (${r.status}).`); return; }
  } catch { toast('Server unreachable. Try again.'); return; }
  passcode = p;
  try { localStorage.setItem('mealapp-passcode', p); } catch { /* ignore */ }
  inp.value = '';
  delete $('pantry-pass').dataset.retry;
  $('pantry-pass-lbl').textContent = 'Editing the pantry needs the household passcode (once per device).';
  toast('Passcode saved on this device.');
  renderPantry();
}

/* ---------- boot ---------- */
if (viewState.pantrySheet) openPantry(null); // screen-lock reload: back where they were
