/* 40-recipes.js — the Recipes tab: library list, recipe bodies, deep links,
   plus collapsible cards above the library: Starter library (template only:
   starter-recipes/ via /api/starter, shown while any of it isn't in recipes/
   yet), Ideas (profile/ideas.md via /api/ideas: Queue / Not for me, "New
   ideas" run), Add a recipe (import from a link, a photo/PDF upload, or an
   Android share; one import run each) and Pictures to make (state.imagesMissing:
   recipes with no recipes/images/<slug>.jpg yet; a to-do for /recipe-images on
   the Mac, never a run).
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- RECIPES ---------- */
let recipeSort = localStorage.getItem('mealapp-recipe-sort') || 'rating';
// Expanded cards survive re-renders and screen-lock reloads.
const openRecipes = new Set(Array.isArray(viewState.openRecipes) ? viewState.openRecipes : []);
const recipeBodies = new Map(); // file -> rendered html

/* Ideas + Add a recipe: side data for the top of the tab (refetched when a
   run starts/ends, throttled otherwise). */
let ideasData = null;   // GET /api/ideas  { exists, batches, state, scheduled, typicalMs }
let importsData = null; // GET /api/imports { imports, typicalMs }
let sharesData = null;  // GET /api/shares { shares }
let starterData = null; // GET /api/starter { available, recipes: [{ file, name, protein, cuisine, method, active_time_min, inLibrary }] }
const starterOff = new Set(); // starter files unchecked on this device (everything starts checked)
let starterBusy = false;
let sideAt = 0, sideKey = '', sideSig = '', sidePolls = 0, sideLoading = false;
let impUrlDraft = '';
let impPicked = [];         // File objects chosen for import (kept off the DOM so re-renders keep them)
let impPendingUpload = null; // { id, names } uploaded but its run didn't start: offer a retry
let impBusy = false;
let impStatus = null;       // { text, err } shown under the Add a recipe card
// The share target 303s to /?shared=<id>: land on Recipes with Add a recipe
// open and that item highlighted (90-boot.js strips the param and toasts).
let landedShareId = new URLSearchParams(location.search).get('shared');
if (landedShareId) { tab = 'recipes'; saveView({ addOpen: true }); }
let shareDelArm = null; // share id whose ✕ was tapped once (second tap deletes)

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

  refreshRecipesTop();
  let html = starterCardHtml() + ideasCardHtml() + addRecipeCardHtml() + picturesCardHtml() + `<div class="sortrow">Sort
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
    const [head, side] = dishParts(r.name);
    html += `<details class="recipe" data-file="${esc(r.file)}"${open ? ' open' : ''}>
      <summary${r.image ? ' class="hasimg"' : ''}>${r.image ? `${dishImg(r.image, 'thumb')}<div class="sumtext">` : ''}<h3>${keepHyphens(head)} ${thisWeekFiles.has(r.file) ? '<span class="tagfav">this week</span>' : ''}</h3>${side ? `<p class="with">${esc(side)}</p>` : ''}
      <div class="meta">${esc(bits)}</div>${r.image ? '</div>' : ''}</summary>
      <div class="rbody">
        <div class="ractions"><button class="ghost" data-cookthis="${esc(r.file)}">Cook this${ico('arrow')}</button></div>
        <div class="rmd">${body ?? '<p style="color:var(--mut)">loading…</p>'}</div>
      </div>
    </details>`;
  }
  v.innerHTML = html;
  wireRecipesTop(v);
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
    if (b) { setCookRecipe(b.dataset.cookthis, true); return; }
    const r = e.target.closest('[data-recipe]');
    if (r) { e.preventDefault(); void openRecipe(r.dataset.recipe); return; }
    void recipesTopClick(e);
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

/* ---------- Ideas + Add a recipe (top of the tab) ---------- */

const usually = (ms) => (ms ? `usually ~${mins(ms)} min` : '');
const kbs = (n) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
const hostOf = (u) => { try { return new URL(u).hostname.replace(/^www\./, ''); } catch { return ''; } };
function shareAgo(at) {
  const s = Math.max(0, (Date.now() - at) / 1000);
  if (s < 90) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86400) return `${Math.round(s / 3600)} h ago`;
  return `${Math.round(s / 86400)} d ago`;
}
async function getJson(url) {
  try { const r = await fetch(url); return r.ok ? await r.json() : null; } catch { return null; }
}

// Every renderRecipes calls this: a run starting/ending (or a new result)
// forces a refetch; otherwise at most every few seconds. Re-renders only when
// the data changed, so it can't loop.
function refreshRecipesTop() {
  const lr = state?.run?.lastResult;
  const sig = `${runActive() ? 1 : 0}:${lr?.at ?? 0}`;
  const force = sig !== sideSig;
  sideSig = sig;
  void loadRecipesTop(force);
}
let sideAgain = false;
async function loadRecipesTop(force = false) {
  if (sideLoading) { if (force) sideAgain = true; return; }
  if (!force && Date.now() - sideAt < 5000) return;
  sideLoading = true;
  try {
    const [i, m, s, st] = await Promise.all([getJson('/api/ideas'), getJson('/api/imports'), getJson('/api/shares'), getJson('/api/starter')]);
    sideAt = Date.now();
    if (i) ideasData = i;
    if (m) importsData = m;
    if (s) sharesData = s;
    if (st) starterData = st;
    // An import run's record is written just after the run's own state-updated
    // broadcast: poll briefly until it settles.
    const settling = !runActive() && (importsData?.imports ?? []).some((r) => r.status === 'running');
    if (settling && sidePolls < 6) { sidePolls++; setTimeout(() => void loadRecipesTop(true), 1500); }
    if (!settling) sidePolls = 0;
    const key = JSON.stringify([i, m, s, st]);
    if (key !== sideKey) { sideKey = key; if (tab === 'recipes' && recipesCache) renderRecipes(); }
  } finally {
    sideLoading = false;
    if (sideAgain) { sideAgain = false; void loadRecipesTop(true); }
  }
}

/* Starter library: only when the repo has starter-recipes/ AND some of it isn't
   in recipes/ yet (a household's own repo has no such folder, so never there).
   Open by default while the library is empty; the open state then persists. */
const starterLeft = () => (starterData?.available ? starterData.recipes.filter((r) => !r.inLibrary) : []);
const starterPicked = () => starterLeft().filter((r) => !starterOff.has(r.file));
const starterBtnText = (n) => (starterBusy ? 'Importing…' : `Import ${n} recipe${n === 1 ? '' : 's'}`);

function starterCardHtml() {
  const left = starterLeft();
  if (!left.length) return '';
  const open = viewState.starterOpen ?? !(recipesCache?.recipes ?? []).length;
  const n = starterPicked().length;
  const rows = left.map((r) => {
    const meta = [r.protein, r.cuisine, r.active_time_min ? `~${r.active_time_min} min active` : ''].filter(Boolean).join(' · ');
    return `<label class="item"><input type="checkbox" data-starter="${esc(r.file)}"${starterOff.has(r.file) ? '' : ' checked'}>
      <span class="box">✓</span><span class="txt">${esc(r.name)}${meta ? `<small>${esc(meta)}</small>` : ''}</span></label>`;
  }).join('');
  return `<details class="rcard starter" id="starter-card"${open ? ' open' : ''}>
    <summary><span class="rcardtitle">Starter library</span><span class="rcardmeta">${left.length} to import</span></summary>
    <div class="rcardbody">
      <p class="hint lead">Thirty-odd tested recipes from the template author’s kitchen, written in the house format. Pick what suits you; everything can be edited or deleted later.</p>
      <div class="selrow"><button class="undo" data-act="starter-all">Select all</button><span aria-hidden="true">·</span><button class="undo" data-act="starter-none">None</button></div>
      <div class="starterlist">${rows}</div>
      <button class="ghost wide q" id="starter-go" data-act="starter-import"${runActive() || starterBusy || !n ? ' disabled' : ''}>${starterBtnText(n)}</button>
      ${runActive() ? '<p class="hint">Waiting for Claude to finish the current run.</p>' : ''}
      <p class="hint small">Done with it? Delete the starter-recipes folder from the repo and this card goes away.</p>
    </div>
  </details>`;
}

function syncStarterButton() {
  const b = $('starter-go');
  if (!b) return;
  const n = starterPicked().length;
  b.textContent = starterBtnText(n);
  b.disabled = runActive() || starterBusy || !n;
}

async function importStarterPicked() {
  const files = starterPicked().map((r) => r.file);
  if (!files.length || starterBusy) return;
  starterBusy = true;
  syncStarterButton();
  try {
    const j = await expectOk(await jpost('/api/starter/import', { files }), 'Could not import the starter recipes.');
    if (!j) return;
    const n = j.imported?.length ?? 0;
    toast(n ? `Imported ${n} recipe${n === 1 ? '' : 's'}` : 'Nothing new to import: those are already in the library.');
    for (const f of [...(j.imported ?? []), ...(j.skipped ?? [])]) starterOff.delete(f);
    const st = await getJson('/api/starter');
    if (st) starterData = st;
    recipesCache = null;
  } catch {
    toast('The server didn’t answer; try again.');
  } finally {
    starterBusy = false;
    await loadRecipes(true); // re-renders the tab (the card hides once nothing is left)
  }
}

function ideaHtml(it, s, week) {
  const meta = [it.protein, it.cuisine, it.activeMin ? `~${it.activeMin} min active` : ''].filter(Boolean).join(' · ');
  const who = s?.by ? ` · ${s.by}` : '';
  const id = esc(it.id);
  let badge = '';
  let acts;
  if (s?.status === 'queued') {
    // a scheduled idea names its week: "Next week" / "Scheduled for next week"
    badge = `<span class="tagfav">${week ? esc(weekName(week, 'Rel')) : 'Queued'}</span>`;
    acts = `<span class="idone">${week ? `Scheduled for ${esc(weekName(week))}` : 'Queued for the next plan'}${esc(who)}</span>
      <button class="undo" data-idea="${id}" data-st="">Undo</button>`;
  } else if (s?.status === 'dismissed') {
    badge = '<span class="tagno">Not for me</span>';
    acts = `<span class="idone">Skipped${esc(who)}</span><button class="undo" data-idea="${id}" data-st="">Undo</button>
      <input class="plain inote" type="text" data-ideanote="${id}" maxlength="300" placeholder="Why not? (optional, shapes the next batch)" value="${esc(s.note ?? '')}">`;
  } else {
    acts = `<button class="ghost q" data-idea="${id}" data-st="queued">Queue</button>
      <button class="ghost" data-idea="${id}" data-st="dismissed">Not for me</button>`;
  }
  return `<div class="idea ${esc(s?.status ?? '')}">
    <div class="ihead"><span class="iname">${esc(it.name)}</span>${badge}</div>
    ${meta ? `<div class="imeta">${esc(meta)}</div>` : ''}
    ${it.pitch ? `<p class="ipitch">${esc(it.pitch)}</p>` : ''}
    ${it.why ? `<p class="iwhy"><b>Why you:</b> ${esc(it.why)}</p>` : ''}
    <div class="iacts">${acts}</div>
  </div>`;
}

function ideasResultHtml() {
  const lr = state?.run?.lastResult;
  if (!lr || lr.type !== 'ideas' || localStorage.getItem('mealapp-ideas-result-dismissed') === String(lr.at)) return '';
  return `<div class="result ${lr.ok ? '' : 'err'}">
    <button class="dismiss" aria-label="Dismiss" data-act="ideas-result-x" data-at="${lr.at}">✕</button>
    <div class="rlabel">${lr.ok ? 'New ideas' : 'Ideas run failed'}</div>
    <div class="rbodytext">${lr.summaryHtml}</div>
  </div>`;
}

// Collapsed by default and never surfaced by the strip: it's there when wanted.
function ideasCardHtml() {
  const d = ideasData;
  const st = d?.state ?? {};
  const sched = d?.scheduled ?? {};
  const batches = d?.batches ?? [];
  const latest = batches[0];
  const queuedN = Object.values(st).filter((x) => x.status === 'queued').length;
  const running = runActive() && state.run.type === 'ideas';
  const meta = !d ? '' : latest
    ? `${latest.items.length} dishes · ${fmtDay(latest.date)}${queuedN ? ` · ${queuedN} queued` : ''}`
    : 'dishes you could queue for a future week';
  let body = ideasResultHtml();
  if (!d) body += '<p class="hint">loading…</p>';
  else if (!latest) {
    body += '<p class="hint">No ideas yet. Claude can suggest eight dishes you don’t have, picked from what you’ve rated well. Queue one and the next proposal schedules it when it fits.</p>';
  } else {
    body += latest.items.map((it) => ideaHtml(it, st[it.id], sched[it.id])).join('');
    const older = batches.slice(1);
    if (older.length) {
      body += `<details class="older" id="ideas-older"${viewState.ideasOlderOpen ? ' open' : ''}>
        <summary>Earlier ideas · ${older.length} batch${older.length === 1 ? '' : 'es'}</summary>
        ${older.map((b) => `<div class="batchdate">${esc(fmtDay(b.date))}</div>${b.items.map((it) => ideaHtml(it, st[it.id], sched[it.id])).join('')}`).join('')}
      </details>`;
    }
  }
  const typ = usually(d?.typicalMs);
  body += running
    ? `<p class="statusline">Finding new ideas…${typ ? ` ${esc(typ)}` : ''}</p>`
    : `<button class="ghost wide" data-act="ideas-run"${runActive() ? ' disabled' : ''}>${latest ? 'New ideas' : 'Suggest ideas'}${typ ? ` <span class="sub">· ${esc(typ)}</span>` : ''}</button>`;
  return `<details class="rcard ideas" id="ideas-card"${viewState.ideasOpen ? ' open' : ''}>
    <summary><span class="rcardtitle">Ideas</span><span class="rcardmeta">${esc(meta)}</span></summary>
    <div class="rcardbody">${body}</div>
  </details>`;
}

/* Pictures to make: recipes with no picture yet (state.imagesMissing). A to-do,
   not an action: pictures are made on the Mac by /recipe-images, never here. */
const imageMissing = (file) => !!file && (state?.imagesMissing ?? []).some((m) => m.file === file);

function picturesCardHtml() {
  const list = state?.imagesMissing ?? [];
  if (!list.length) return '';
  const rows = list.map((m) => `<div class="share"><div class="stext"><b>${esc(m.name)}</b></div>
    <button class="ghost" data-recipe="${esc(m.file)}">Open${ico('arrow')}</button></div>`).join('');
  return `<details class="rcard pics" id="pics-card"${viewState.picsOpen ? ' open' : ''}>
    <summary><span class="rcardtitle">Pictures to make</span><span class="rcardmeta">${list.length} recipe${list.length === 1 ? '' : 's'}</span></summary>
    <div class="rcardbody">${rows}
      <p class="hint">Made on the Mac with <code>/recipe-images</code> after the grocery list is final — one ChatGPT chat per picture. Shopping doesn’t need them.</p>
    </div>
  </details>`;
}

// The newest import that ran (by run start, so a re-imported upload counts).
function lastImportRun(imports) {
  return imports.filter((r) => r.runAt).sort((a, b) => b.runAt - a.runAt)[0] ?? null;
}

function importResultHtml(imports) {
  const rec = lastImportRun(imports);
  if (!rec || (rec.status !== 'done' && rec.status !== 'failed')) return '';
  const key = `${rec.id}:${rec.doneAt ?? 0}`;
  if (localStorage.getItem('mealapp-import-dismissed') === key) return '';
  const ok = rec.status === 'done';
  const title = rec.name || rec.title || '';
  const slug = rec.recipeFile ? rec.recipeFile.replace(/\.md$/, '') : '';
  const q = slug ? ideasData?.state?.[slug] : null;
  let acts = '';
  if (ok && rec.recipeFile && rec.recipeExists) {
    acts = `<div class="racts"><button class="ghost" data-act="imp-open" data-file="${esc(rec.recipeFile)}">Open recipe</button>${q?.status === 'queued'
      ? `<span class="idone ok">Queued for next week</span><button class="undo" data-idea="${esc(slug)}" data-st="">Undo</button>`
      : `<button class="ghost q" data-idea="${esc(slug)}" data-st="queued">Queue for next week</button>`}</div>`;
  } else if (ok && rec.recipeFile) {
    acts = `<p class="hint">recipes/${esc(rec.recipeFile)} wasn’t written (a mock run, or the run stopped short).</p>`;
  }
  // gone once the picture exists (state-updated re-renders the tab)
  if (ok && rec.recipeExists && imageMissing(rec.recipeFile)) {
    acts += '<p class="hint">Last step: run <code>/recipe-images</code> on the Mac for its picture.</p>';
  }
  return `<div class="result ${ok ? '' : 'err'}">
    <button class="dismiss" aria-label="Dismiss" data-act="imp-result-x" data-key="${esc(key)}">✕</button>
    <div class="rlabel">${ok ? 'Recipe imported' : 'Import failed'}${title ? ` · ${esc(title)}` : ''}</div>
    <div class="rbodytext">${rec.summaryHtml || esc(rec.error || '')}</div>${acts}
  </div>`;
}

function shareHtml(s, imports) {
  const done = imports.find((r) => r.shareId === s.id && r.status === 'done' && r.recipeExists);
  const link = s.url || (/(https?:\/\/[^\s<>"]+)/.exec(s.text || '') || [])[1] || '';
  const fileName = (f) => f.path.split('/').pop().replace(/^\d{8}-\d{6}-/, '');
  const title = s.title || (s.files[0] ? fileName(s.files[0]) : '') || (link ? hostOf(link) : '') || (s.text || '').slice(0, 60) || 'Shared item';
  const what = s.files.length
    ? s.files.map((f) => `${f.type === 'application/pdf' ? 'PDF' : 'photo'} ${kbs(f.size)}`).join(', ')
    : link ? hostOf(link) : 'text';
  const busy = runActive() || impBusy;
  const armed = shareDelArm === s.id;
  return `<div class="share${s.id === landedShareId ? ' landed' : ''}">
    <div class="stext"><b>${esc(title)}</b><small>${esc([what, shareAgo(s.at), s.by].filter(Boolean).join(' · '))}</small>
      ${done ? `<small class="ok">Imported as ${esc(done.recipeFile)}</small>` : ''}</div>
    <button class="ghost" data-act="imp-share" data-id="${esc(s.id)}"${busy ? ' disabled' : ''}>${done ? 'Again' : 'Import'}</button>
    <button class="delx${armed ? ' armed' : ''}" data-act="share-del" data-id="${esc(s.id)}" aria-label="Delete shared item">${armed ? 'Delete' : '✕'}</button>
  </div>`;
}

function addRecipeCardHtml() {
  const shares = sharesData?.shares ?? [];
  const imports = importsData?.imports ?? [];
  const importing = runActive() && state.run.type === 'import';
  const waiting = shares.filter((s) => !imports.some((r) => r.shareId === s.id && r.status === 'done')).length;
  const meta = importing ? 'importing…' : waiting ? `${waiting} shared item${waiting === 1 ? '' : 's'} to import` : 'link, photo, PDF, or share';
  const typ = usually(importsData?.typicalMs);
  const dis = runActive() || impBusy ? ' disabled' : '';
  let body = importResultHtml(imports);
  body += `<div class="addlabel">From a link</div>
    <div class="formline"><input class="plain" id="imp-url" type="text" inputmode="url" autocomplete="off" autocapitalize="off" spellcheck="false"
      placeholder="Paste a recipe page link" value="${esc(impUrlDraft)}"><button class="ghost" data-act="imp-url"${dis}>Import</button></div>
    <p class="hint">Most recipe sites work. NYT Cooking is paywalled to the app: share its PDF (Print → Save as PDF) or screenshots instead.</p>
    <div class="addlabel">From a photo or PDF</div>
    <div class="filebtns"><button class="ghost" data-act="imp-pick">Choose a file</button><button class="ghost" data-act="imp-snap">Snap a photo</button></div>
    <input type="file" id="imp-file" accept="image/*,application/pdf" multiple hidden>
    <input type="file" id="imp-cam" accept="image/*" capture="environment" hidden>`;
  if (impPicked.length) {
    body += `<div class="picked"><span class="grow">${impPicked.map((f) => `${esc(f.name || 'photo')} · ${kbs(f.size)}`).join('<br>')}</span>
      <button class="ghost" data-act="imp-file"${dis}>Import</button><button class="delx" data-act="imp-file-x" aria-label="Clear">✕</button></div>`;
  } else if (impPendingUpload) {
    body += `<div class="picked"><span class="grow">Uploaded, not imported yet: ${esc(impPendingUpload.names)}</span>
      <button class="ghost" data-act="imp-retry"${dis}>Import</button><button class="delx" data-act="imp-retry-x" aria-label="Clear">✕</button></div>`;
  }
  body += '<div class="addlabel">Shared with the app</div>';
  body += shares.length
    ? shares.map((s) => shareHtml(s, imports)).join('')
    : '<p class="hint">Share a recipe page, photo, or PDF from another app to Meal Planner (install the app from Settings first) and it shows up here.</p>';
  const status = impStatus?.text ?? (importing ? `Importing…${typ ? ` ${typ}` : ''}` : '');
  body += `<div class="statusline${impStatus?.err ? ' err' : ''}" id="imp-status">${esc(status)}</div>`;
  return `<details class="rcard addrec" id="add-card"${viewState.addOpen ? ' open' : ''}>
    <summary><span class="rcardtitle">Add a recipe</span><span class="rcardmeta">${esc(meta)}</span></summary>
    <div class="rcardbody">${body}</div>
  </details>`;
}

function wireRecipesTop(v) {
  const keep = (id, key) => {
    const d = $(id);
    if (d) d.addEventListener('toggle', () => saveView({ [key]: d.open }));
  };
  keep('ideas-card', 'ideasOpen');
  keep('ideas-older', 'ideasOlderOpen');
  keep('add-card', 'addOpen');
  keep('pics-card', 'picsOpen');
  keep('starter-card', 'starterOpen');
  v.querySelectorAll('input[data-starter]').forEach((box) => {
    box.onchange = () => {
      if (box.checked) starterOff.delete(box.dataset.starter); else starterOff.add(box.dataset.starter);
      syncStarterButton();
    };
  });
  const url = $('imp-url');
  if (url) {
    url.addEventListener('input', () => { impUrlDraft = url.value; });
    url.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); void importFromUrl(); } });
  }
  const file = $('imp-file');
  if (file) file.onchange = () => pickImportFiles(file.files, false);
  const cam = $('imp-cam');
  if (cam) cam.onchange = () => pickImportFiles(cam.files, true);
  v.querySelectorAll('input[data-ideanote]').forEach((inp) => {
    inp.addEventListener('change', () => void setIdea(inp.dataset.ideanote, 'dismissed', inp.value.trim()));
  });
}

async function recipesTopClick(e) {
  const el = e.target.closest('[data-act],[data-idea]');
  if (!el || el.disabled) return;
  if (el.dataset.idea !== undefined) { await setIdea(el.dataset.idea, el.dataset.st || null); return; }
  const act = el.dataset.act;
  if (act !== 'share-del' && shareDelArm) { shareDelArm = null; renderRecipes(); }
  switch (act) {
    case 'ideas-run': return startIdeasRun(el);
    case 'ideas-result-x': localStorage.setItem('mealapp-ideas-result-dismissed', el.dataset.at); return renderRecipes();
    case 'imp-result-x': localStorage.setItem('mealapp-import-dismissed', el.dataset.key); return renderRecipes();
    case 'imp-url': return importFromUrl();
    case 'imp-pick': return $('imp-file')?.click();
    case 'imp-snap': return $('imp-cam')?.click();
    case 'imp-file': return importPicked();
    case 'imp-file-x': impPicked = []; setImpStatus(''); return renderRecipes();
    case 'imp-retry': return impPendingUpload && startImport({ uploadId: impPendingUpload.id }, 'Starting the import…');
    case 'imp-retry-x': impPendingUpload = null; return renderRecipes();
    case 'imp-share': return startImport({ shareId: el.dataset.id }, 'Reading the shared item…');
    case 'share-del': return deleteShare(el.dataset.id);
    case 'imp-open': return openRecipe(el.dataset.file);
    case 'starter-import': return importStarterPicked();
    case 'starter-all': starterOff.clear(); return renderRecipes();
    case 'starter-none': for (const r of starterLeft()) starterOff.add(r.file); return renderRecipes();
  }
}

function setImpStatus(text, err = false) {
  impStatus = text ? { text, err } : null;
  const el = $('imp-status');
  if (el) { el.textContent = text || ''; el.classList.toggle('err', !!err); }
}

async function setIdea(id, status, note) {
  const body = { status: status || null };
  if (note !== undefined) body.note = note;
  const j = await expectOk(await opost(`/api/ideas/${encodeURIComponent(id)}`, body), 'Could not save that.');
  if (!j) return;
  if (!ideasData) { void loadRecipesTop(true); return; }
  ideasData.state = { ...(ideasData.state ?? {}) };
  if (j.entry) ideasData.state[id] = j.entry; else delete ideasData.state[id];
  if (note !== undefined) return; // a reason edit: leave the field as typed
  if (status === 'queued') toast('Queued: the next proposal schedules it when it fits the week.');
  renderRecipes();
}

async function startIdeasRun(btn) {
  btn.disabled = true;
  const j = await expectOk(await jpost('/api/runs/ideas'), 'Could not start the ideas run.');
  if (!j) { btn.disabled = false; return; }
  saveView({ ideasOpen: true });
  toast('Finding new ideas; they appear here when the run finishes.');
}

async function importFromUrl() {
  const url = ($('imp-url')?.value ?? impUrlDraft).trim();
  impUrlDraft = url;
  if (!/^https?:\/\/\S+$/i.test(url)) { setImpStatus('Paste a full link, starting with https://', true); return; }
  if (await startImport({ url }, 'Fetching the page…')) { impUrlDraft = ''; renderRecipes(); }
}

/** POST /api/runs/import; true when the run started. */
async function startImport(source, busyText) {
  if (impBusy) return false;
  impBusy = true;
  setImpStatus(busyText);
  renderRecipes(); // disable the Import buttons while the server fetches
  try {
    const r = await jpost('/api/runs/import', { source });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { setImpStatus(j.error || `Couldn’t start the import (${r.status}).`, true); return false; }
    if (source.shareId && source.shareId === landedShareId) landedShareId = null;
    if (source.uploadId) impPendingUpload = null;
    setImpStatus(''); // the strip and this card show progress from here
    saveView({ addOpen: true });
    toast('Importing: Claude is writing it up in house format.');
    void loadRecipesTop(true);
    return true;
  } catch {
    setImpStatus('The server didn’t answer; try again.', true);
    return false;
  } finally {
    impBusy = false;
    renderRecipes();
  }
}

function pickImportFiles(list, append) {
  const files = [...(list || [])];
  if (!files.length) return;
  const bad = files.find((f) => f.type && !(f.type.startsWith('image/') || f.type === 'application/pdf'));
  if (bad) { setImpStatus(`${bad.name}: only photos and PDFs can be imported.`, true); return; }
  const big = files.find((f) => f.size > 15 * 1024 * 1024);
  if (big) { setImpStatus(`${big.name} is over 15 MB.`, true); return; }
  const all = append ? [...impPicked, ...files] : files;
  impPicked = all.slice(0, 3);
  impPendingUpload = null;
  setImpStatus(all.length > 3 ? 'Up to 3 files per recipe; the first 3 are kept.' : '');
  renderRecipes();
}

async function importPicked() {
  if (!impPicked.length || impBusy) return;
  impBusy = true;
  setImpStatus('Uploading…');
  renderRecipes();
  let up = null;
  try {
    const fd = new FormData();
    for (const f of impPicked) fd.append('files', f, f.name || 'photo.jpg');
    const r = await fetch('/api/imports/upload', { method: 'POST', body: fd });
    up = await r.json().catch(() => ({}));
    if (!r.ok) { setImpStatus(up.error || `Upload failed (${r.status}).`, true); up = null; }
  } catch {
    setImpStatus('Upload failed; check the connection and try again.', true);
    up = null;
  }
  impBusy = false;
  if (!up?.import) { renderRecipes(); return; }
  impPicked = [];
  impPendingUpload = { id: up.import.id, names: up.import.files.map((f) => f.name).join(', ') };
  await startImport({ uploadId: impPendingUpload.id }, 'Starting the import…');
}

// Two taps: ✕ arms, "Delete" deletes (the passcode is asked once per device).
async function deleteShare(id) {
  if (shareDelArm !== id) { shareDelArm = id; renderRecipes(); return; }
  shareDelArm = null;
  const j = await expectOk(await authedFetch(`/api/shares/${encodeURIComponent(id)}`, { method: 'DELETE' }), 'Could not delete it.');
  if (j && sharesData) sharesData.shares = sharesData.shares.filter((s) => s.id !== id);
  if (landedShareId === id) landedShareId = null;
  renderRecipes();
}
