/* 50-cook.js — the Cook tab, built for the stove: dish picker, a header card
   with a servings stepper and a wake-lock pill, scaled Ingredients, a Prep
   (mise en place) checklist, numbered Steps with a tap-to-mark current step,
   Notes, and the sous-chef chat in a bottom sheet behind a floating button.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- COOK ----------
   The recipe comes from GET /api/recipes/entry?f=…&servings=N, which returns
   `sections` (scaled ingredient texts, prep, steps, notes HTML, group heads)
   and `scale`. Everything a screen-lock reload needs lives in viewState
   (sessionStorage): the dish, servings per recipe, today's prep checks and
   current step per recipe, the sous-chef transcripts and drafts, and whether
   the sheet was open. The chat lives in its own sheet DOM (built once, below),
   so re-rendering the recipe never touches a streaming answer. */
let cookStreaming = false;

// The sous-chef is told plain-text-only, but bold slips through; render just
// that, on already-escaped text.
const mdLite = (s) => esc(s).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>');

const COOK_SERV_MIN = 1;
const COOK_SERV_MAX = 24;
const clampServ = (n) => Math.min(COOK_SERV_MAX, Math.max(COOK_SERV_MIN, Math.round(n)));

/* ---------- inline markdown for recipe text ----------
   Escaped first, so recipe text never becomes markup. Then **bold**, *italic*,
   `code`; links show their text only (recipe-relative links go nowhere here);
   source tags (any 1–2 character uppercase/digit code per the legend in
   recipes/README.md, slash-joined allowed: [C], [2 — …], [C/K], [P]; they
   nest: `[2 — …; honey [P] works]`) are wrapped dimmed; continuation lines become <br>. */
const SRC_TAG_RE = /^\[[A-Z0-9]{1,2}(?:\/[A-Z0-9]{1,2})*(?=[\]\s—–,;:])/;
function cookInline(src) {
  const s = esc(src)
    .replace(/\[([^\]\n]+)\]\([^)\s]+\)/g, '$1')
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>')
    .replace(/(^|[\s(])_(?!\s)([^_\n]+?)_(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
  let out = '';
  let i = 0;
  while (i < s.length) {
    const j = s.indexOf('[', i);
    if (j === -1) { out += s.slice(i); break; }
    let end = -1;
    if (SRC_TAG_RE.test(s.slice(j, j + 8))) {
      for (let k = j, depth = 0; k < s.length; k++) {
        if (s[k] === '[') depth++;
        else if (s[k] === ']' && --depth === 0) { end = k; break; }
      }
    }
    if (end === -1) { out += s.slice(i, j + 1); i = j + 1; continue; }
    out += `${s.slice(i, j)}<span class="src">${s.slice(j, end + 1)}</span>`;
    i = end + 1;
  }
  return out.replace(/\n/g, '<br>');
}

/* ---------- which dish, which week meal ---------- */
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
// This week's plan entry for the dish (tonight's if it appears twice).
function cookWeekMeal(file) {
  const c = state?.cooking;
  const ms = (c?.plan.meals ?? []).filter((m) => !m.flexible && m.recipeFile === file);
  return ms.find((m) => c.dates[m.day] === state.today) ?? ms[0] ?? null;
}

/* ---------- servings ----------
   Default: the plan's servings for that meal (4 when the plan file has no
   Servings column yet); a library dish defaults to the recipe as written
   (null here = no ?servings=, the server reports the base). An explicit
   stepper pick persists per recipe; stepping back to the default drops it,
   so a later plan change flows through. */
function cookDefaultServings(file) {
  const wk = cookWeekMeal(file);
  if (!wk) return null;
  const n = Number(wk.servings);
  return clampServ(n > 0 ? n : 4);
}
function cookServingsWanted(file) {
  const pick = (viewState.cookServ ?? {})[file];
  return Number.isInteger(pick) ? clampServ(pick) : cookDefaultServings(file);
}
function setCookServings(file, n, base) {
  const all = { ...(viewState.cookServ ?? {}) };
  if (n === (cookDefaultServings(file) ?? base)) delete all[file]; else all[file] = n;
  saveView({ cookServ: all });
}
function factorText(f) {
  const w = Math.floor(f + 1e-9);
  const r = f - w;
  const g = [[0, ''], [0.25, '¼'], [1 / 3, '⅓'], [0.5, '½'], [2 / 3, '⅔'], [0.75, '¾'], [1, '']].find(([v]) => Math.abs(r - v) < 0.02);
  if (!g) return String(Math.round(f * 10) / 10);
  if (g[0] === 1) return String(w + 1);
  return w ? `${w}${g[1]}` : (g[1] || '0');
}

/* ---------- per-day stove state (prep checks, current step) ----------
   Keyed recipe + today, so tomorrow starts clean; other days are pruned on
   every write. */
function cookDayGet(field, file) {
  return (viewState[field] ?? {})[`${file}|${state.today}`];
}
function cookDaySet(field, file, value) {
  const suffix = `|${state.today}`;
  const all = {};
  for (const [k, v] of Object.entries(viewState[field] ?? {})) if (k.endsWith(suffix)) all[k] = v;
  const key = file + suffix;
  if (value === null || value === undefined || (Array.isArray(value) && !value.length)) delete all[key];
  else all[key] = value;
  saveView({ [field]: all });
}

/* ---------- recipe entries ----------
   Cached per dish + servings. 00-core flushes recipeBodies on `state-updated`
   (a run may have rewritten a recipe file); piggyback on that so cook entries
   go stale too. A stale entry keeps rendering while a fresh one loads, so the
   page never collapses to "loading…" and jumps at the stove. */
const cookEntries = new Map(); // key -> { gen, data } | { gen, missing: true }
const cookInflight = new Map();
let cookGen = 0;
let cookShown = null; // { file, data } last painted — stays up while a re-scale loads
const cookKey = (file, serv) => `${file}|${serv ?? ''}`;
{
  const flush = recipeBodies.clear.bind(recipeBodies);
  recipeBodies.clear = () => { flush(); cookGen++; };
}
function loadCookEntry(file, serv) {
  const key = cookKey(file, serv);
  if (cookInflight.has(key)) return cookInflight.get(key);
  const p = (async () => {
    try {
      const r = await fetch(`/api/recipes/entry?f=${encodeURIComponent(file)}${serv ? `&servings=${serv}` : ''}`);
      if (r.status === 404 || r.status === 400) { cookEntries.set(key, { gen: cookGen, missing: true }); return; }
      if (!r.ok) return; // transient: the next render asks again
      cookEntries.set(key, { gen: cookGen, data: await r.json() });
    } catch { /* offline: keep whatever is cached */ }
    finally { cookInflight.delete(key); }
  })();
  cookInflight.set(key, p);
  return p;
}

/* ---------- chat transcripts + drafts ---------- */
function cookChatFor(file) {
  const all = viewState.cookChats ?? {};
  return Array.isArray(all[file]) ? all[file] : [];
}
function saveCookChat(file, msgs) {
  const all = viewState.cookChats ?? {};
  if (msgs.length) all[file] = msgs.slice(-40); else delete all[file];
  saveView({ cookChats: all });
}
function saveCookDraft(file, text) {
  const all = { ...(viewState.cookDrafts ?? {}) };
  if (text.trim()) all[file] = text; else delete all[file];
  saveView({ cookDrafts: all });
}

/* ---------- small formatters ---------- */
const fmtMin = (n) => (n >= 90 ? `${Math.floor(n / 60)} h${n % 60 ? ` ${n % 60} min` : ''}` : `${n} min`);
// "15 min prep + 25 min cooking" once recipes carry prep_min (cooking = the
// rest of the total, i.e. time to the table); before that "20 min active · 40 total".
function cookTimeText(m) {
  if (m.prep_min) {
    const total = m.total_time_min ?? m.active_time_min;
    const rest = total ? Math.max(0, total - m.prep_min) : 0;
    return rest ? `${fmtMin(m.prep_min)} prep + ${fmtMin(rest)} cooking` : `${fmtMin(m.prep_min)} prep`;
  }
  const total = m.total_time_min ? (m.total_time_min >= 90 ? `${fmtMin(m.total_time_min)} total` : `${m.total_time_min} total`) : null;
  return [m.active_time_min ? `${fmtMin(m.active_time_min)} active` : null, total].filter(Boolean).join(' · ');
}
function withInserts(items, inserts, item, insert) {
  const ins = inserts ?? [];
  let out = '';
  let k = 0;
  items.forEach((it, i) => {
    while (k < ins.length && ins[k].before <= i) out += insert(ins[k++]);
    out += item(it, i);
  });
  while (k < ins.length) out += insert(ins[k++]);
  return out;
}

const SUN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="4"/><path d="M12 2.5v2M12 19.5v2M4.6 4.6l1.4 1.4M18 18l1.4 1.4M2.5 12h2M19.5 12h2M4.6 19.4 6 18M18 6l1.4-1.4"/></svg>';
const CHAT_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.5 11.5a8 8 0 0 1-11.7 7.1L4 20l1.4-4.6a8 8 0 1 1 15.1-3.9z"/><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01"/></svg>';

/* ---------- render ---------- */
// Scroll position to re-apply once the async recipe lands after a reload
// (restoreBoot's own restore runs before the scaled entry has its height).
let cookBootScroll = tab === 'cook' ? ((viewState.scroll ?? {}).cook ?? 0) : 0;
let cookSheetRestored = false;

function renderCook() {
  if (!state) return;
  const v = $('view-cook');
  const file = cookFile();
  const refocus = document.activeElement && v.contains(document.activeElement) ? document.activeElement.dataset?.serv : undefined;

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
  let html = `<div class="cookpickrow"><span>Cooking</span><select id="cook-pick" aria-label="What are you cooking?"${cookStreaming ? ' disabled' : ''}>${picker}</select></div>`;

  if (!file) {
    html += `<div class="pending"><span class="when">cook mode</span>
      <h2>What are you cooking?</h2>
      <p>Pick a dish above. The recipe opens here, scaled to the servings you want, with a prep checklist, big numbered steps, and the sous-chef one tap away.</p></div>`;
    v.innerHTML = html;
    wireCookPick();
    renderCookChat();
    void syncWakeLock();
    return;
  }

  const serv = cookServingsWanted(file);
  const key = cookKey(file, serv);
  const ent = cookEntries.get(key);
  if (!ent || ent.gen !== cookGen) {
    void loadCookEntry(file, serv).then(() => {
      const now = cookEntries.get(key);
      if (now && now.gen === cookGen && cookFile() === file && cookKey(file, cookServingsWanted(file)) === key) renderCook();
    });
  }
  const data = ent?.data ?? (cookShown?.file === file ? cookShown.data : null);
  const updating = !ent?.data && !!data; // painting the previous scale while this one loads
  const wk = cookWeekMeal(file);
  const libMeta = (recipesCache?.recipes ?? []).find((r) => r.file === file);
  const name = data?.meta?.name ?? libMeta?.name ?? wk?.dish ?? file.replace(/\.md$/, '');
  // Where the dish sits in the week (Tonight · Tue 13) is the header eyebrow's
  // job (renderHead); the recipe head carries its rating chip.
  const rating = data?.meta?.rating ?? libMeta?.rating;
  const chips = `<span class="cookchips">${rating != null ? `<span class="tagfav">★ ${esc(rating)}</span>`
    : data?.meta?.times_cooked === 0 ? '<span class="tagnew">New</span>' : ''}</span>`;
  const [head, side] = dishParts(name);
  const title = `<h2>${keepHyphens(head)}</h2>${side ? `<p class="with">${esc(side)}</p>` : ''}`;
  // the recipe's picture: the entry's meta, else the library's or the week's while it loads
  const heroImg = dishImg(data?.meta?.image ?? libMeta?.image ?? wk?.image, 'hero');

  if (!data) {
    html += `<div class="card cookhead">
      ${heroImg}
      <div class="cookhead-top">${chips}${wakePillHtml()}</div>
      ${title}
      ${ent?.missing ? NOT_YET : '<p class="cookloading">loading…</p>'}
    </div>`;
    v.innerHTML = html;
    wireCookView(v, file, null);
    return;
  }
  if (ent?.data) cookShown = { file, data: ent.data };

  const m = data.meta;
  const sc = data.scale;
  const sec = data.sections;
  const base = sc.baseServings;
  const servShown = serv ?? sc.servings;
  const scaled = servShown !== base;
  const metaBits = [cookTimeText(m) || null, `serves ${base}`].filter(Boolean).join(' · ');
  const n = m.nutrition ?? {};
  // non-breaking inside each figure, so "24 g fat" never splits across lines
  const nutr = [
    n.calories ? `${n.calories} cal` : null, n.protein_g ? `${n.protein_g} g protein` : null,
    n.carbs_g ? `${n.carbs_g} g carbs` : null, n.fat_g ? `${n.fat_g} g fat` : null, n.fiber_g ? `${n.fiber_g} g fiber` : null,
  ].filter(Boolean).map((x) => x.replace(/ /g, '\u00a0')).join(' · ');
  html += `<div class="card cookhead">
    ${heroImg}
    <div class="cookhead-top">${chips}${wakePillHtml()}</div>
    ${title}
    ${metaBits ? `<div class="cookmeta">${esc(metaBits)}</div>` : ''}
    ${nutr ? `<div class="cooknutr">Per serving · ${esc(nutr)}</div>` : ''}
    <div class="cookscale${scaled ? ' scaled' : ''}">
      <div class="grow" aria-live="polite">${cookScaleText(servShown, base)}</div>
      <div class="servstep" role="group" aria-label="Servings">
        <button type="button" data-serv="-1" aria-label="Fewer servings"${servShown <= COOK_SERV_MIN ? ' disabled' : ''}>−</button>
        <output aria-label="Servings">${servShown}</output>
        <button type="button" data-serv="1" aria-label="More servings"${servShown >= COOK_SERV_MAX ? ' disabled' : ''}>+</button>
      </div>
    </div>
  </div>`;

  // Ingredients — scaled texts; lines with nothing to scale are tagged
  html += `<section class="cooksec" aria-labelledby="ck-ing-h">
    <div class="cooksec-h"><h3 id="ck-ing-h">Ingredients</h3><span class="aside" id="ck-ing-for">for ${servShown}</span></div>
    <ul class="cookingr${updating ? ' updating' : ''}" id="ck-ing">${cookIngredientsHtml(data)}</ul>
  </section>`;

  // Prep — mise en place checklist (only when the recipe has a ## Prep section)
  if (sec.prep.length) {
    const done = new Set(cookDayGet('cookPrep', file) ?? []);
    const nDone = sec.prep.filter((t) => done.has(t)).length;
    html += `<section class="cooksec" aria-labelledby="ck-prep-h">
      <div class="cooksec-h"><h3 id="ck-prep-h">Prep</h3><span class="aside"><span id="ck-prep-count">${nDone} of ${sec.prep.length}</span><button type="button" class="linkbtn" id="ck-prep-reset"${nDone ? '' : ' hidden'}>reset</button></span></div>
      <div class="cookprep">${withInserts(sec.prep, sec.inserts?.prep, (t, i) =>
        `<label class="cookchk"><input type="checkbox" data-prep="${i}"${done.has(t) ? ' checked' : ''}><span class="box" aria-hidden="true">✓</span><span class="txt"><span class="t">${cookInline(t)}</span></span></label>`,
      (x) => `<div class="${x.head ? 'grp' : 'aside'}">${cookInline(x.text)}</div>`)}</div>
    </section>`;
  }

  // Steps — tap the one you're on
  const cur = cookDayGet('cookStep', file);
  const hasNow = Number.isInteger(cur) && cur >= 0 && cur < sec.steps.length;
  html += `<section class="cooksec" aria-labelledby="ck-steps-h">
    <div class="cooksec-h"><h3 id="ck-steps-h">Steps</h3><span class="aside"><span class="stepnote"${scaled ? '' : ' hidden'}>amounts here are for ${base}</span><span class="stephint"${hasNow ? ' hidden' : ''}>tap the one you’re on</span><button type="button" class="linkbtn" id="ck-step-clear"${hasNow ? '' : ' hidden'}>clear</button></span></div>
    <ol class="cooksteps${hasNow ? ' has-now' : ''}">${withInserts(sec.steps, sec.inserts?.steps, (t, i) =>
      `<li><button type="button" class="step${hasNow && cur === i ? ' now' : ''}" data-step="${i}"${hasNow && cur === i ? ' aria-current="step"' : ''}><span class="num">${i + 1}</span><span class="txt">${cookInline(t)}</span></button></li>`,
    (x) => `<li class="${x.head ? 'grp' : 'aside'}">${cookInline(x.text)}</li>`)}</ol>
  </section>`;

  if (sec.notesHtml) {
    html += `<details class="cooknotes"${viewState.cookNotesOpen ? ' open' : ''}><summary>Notes</summary><div class="notesbody">${sec.notesHtml}</div></details>`;
  }
  if (wk) html += '<p class="cookend">Rate it on the Week tab after dinner.</p>';
  html += cookFabHtml(file);

  v.innerHTML = html;
  wireCookView(v, file, { sec, base, servShown });
  if (refocus) v.querySelector(`[data-serv="${refocus}"]`)?.focus({ preventScroll: true });

  if (cookBootScroll && ent?.data && tab === 'cook') {
    const y = cookBootScroll;
    cookBootScroll = 0;
    // a timer, not rAF: rAF never fires while the page is hidden, and the
    // innerHTML above already has its height (scrollTo forces layout)
    setTimeout(() => { if (tab === 'cook' && window.scrollY < y - 2) window.scrollTo(0, y); }, 0);
  }
  if (!cookSheetRestored && ent?.data) {
    cookSheetRestored = true;
    if (viewState.cookSheet && tab === 'cook') openCookSheet(true);
  }
}

function cookScaleText(servShown, base) {
  return servShown !== base
    ? `<b>Scaled ×${esc(factorText(servShown / base))} for ${servShown} servings</b> <span class="was">Written for ${base}. The ingredients below are scaled.</span>`
    : `<b>${servShown} serving${servShown === 1 ? '' : 's'}, as written</b> <span class="was">Step up for leftovers or company.</span>`;
}
// The ingredient <li>s of one entry; "as written" / flag notes follow that
// entry's own scale.
function cookIngredientsHtml(data) {
  const sc = data.scale;
  const sec = data.sections;
  const scaled = sc.factor !== 1;
  const unscaled = new Set(sc.unscaled ?? []);
  const flagged = new Map((sc.flagged ?? []).map((f) => [f.line, f.notes]));
  return withInserts(sec.ingredients, sec.inserts?.ingredients, (t) => {
    const asWritten = scaled && unscaled.has(t);
    const notes = scaled && !asWritten ? flagged.get(t) : null;
    return `<li>${cookInline(t)}${asWritten ? ' <span class="aw">as written</span>' : ''}${notes ? `<small class="flag">${esc(notes.join(' · '))}</small>` : ''}</li>`;
  }, (x) => `<li class="${x.head ? 'grp' : 'aside'}">${cookInline(x.text)}</li>`);
}
// Servings changes patch in place: replacing the stepper between a finger's
// down and up would swallow the tap, so the buttons themselves never re-render.
function patchCookServings(file, base) {
  const v = $('view-cook');
  const out = v.querySelector('.servstep output');
  if (!out || cookFile() !== file) { renderCook(); return; }
  const serv = cookServingsWanted(file);
  const shown = serv ?? base;
  out.textContent = String(shown);
  const [minus, plus] = v.querySelectorAll('.servstep button');
  if (minus) minus.disabled = shown <= COOK_SERV_MIN;
  if (plus) plus.disabled = shown >= COOK_SERV_MAX;
  const box = v.querySelector('.cookscale');
  box.classList.toggle('scaled', shown !== base);
  box.querySelector('.grow').innerHTML = cookScaleText(shown, base);
  $('ck-ing-for').textContent = `for ${shown}`;
  const note = v.querySelector('.stepnote');
  if (note) note.hidden = shown === base;
  const key = cookKey(file, serv);
  const ent = cookEntries.get(key);
  const ul = $('ck-ing');
  if (ent?.data && ent.gen === cookGen) {
    cookShown = { file, data: ent.data };
    ul.innerHTML = cookIngredientsHtml(ent.data);
    ul.classList.remove('updating');
  } else {
    ul.classList.add('updating');
    void loadCookEntry(file, serv).then(() => {
      if (cookFile() === file && cookKey(file, cookServingsWanted(file)) === key && cookEntries.get(key)?.data) patchCookServings(file, base);
    });
  }
  paintCookSheetSub();
}

function cookFabHtml(file) {
  const unread = viewState.cookUnread === file;
  return `<button type="button" class="cookfab" id="cook-fab" aria-haspopup="dialog" aria-controls="cook-sheet"${unread ? ' aria-describedby="cook-fab-new"' : ''}>${CHAT_SVG}<span>Sous-chef</span>${unread ? '<span class="fabdot" id="cook-fab-new" role="img" aria-label="new answer"></span>' : ''}</button>`;
}

function wireCookPick() {
  const s = $('cook-pick');
  if (s) s.onchange = () => { if (s.value) setCookRecipe(s.value, false); };
}

function wireCookView(v, file, ctx) {
  wireCookPick();
  const wake = $('cook-wake');
  if (wake) wake.onclick = tapWake;
  const fab = $('cook-fab');
  if (fab) fab.onclick = () => openCookSheet(false);
  renderCookChat();
  void syncWakeLock();
  if (!ctx) return;
  const { sec, base } = ctx;

  v.querySelectorAll('[data-serv]').forEach((b) => {
    b.onclick = () => {
      const cur = cookServingsWanted(file) ?? base;
      const next = clampServ(cur + Number(b.dataset.serv));
      if (next === cur) return;
      setCookServings(file, next, base);
      patchCookServings(file, base);
    };
  });

  // prep: patch in place (no re-render, so nothing moves under a wet finger)
  const prepCount = () => {
    const done = new Set(cookDayGet('cookPrep', file) ?? []);
    const k = sec.prep.filter((t) => done.has(t)).length;
    const c = $('ck-prep-count');
    if (c) c.textContent = `${k} of ${sec.prep.length}`;
    const r = $('ck-prep-reset');
    if (r) r.hidden = !k;
  };
  v.querySelectorAll('input[data-prep]').forEach((box) => {
    box.onchange = () => {
      const t = sec.prep[Number(box.dataset.prep)];
      const done = new Set(cookDayGet('cookPrep', file) ?? []);
      if (box.checked) done.add(t); else done.delete(t);
      cookDaySet('cookPrep', file, [...done]);
      prepCount();
    };
  });
  const reset = $('ck-prep-reset');
  if (reset) reset.onclick = () => {
    cookDaySet('cookPrep', file, null);
    v.querySelectorAll('input[data-prep]').forEach((b) => { b.checked = false; });
    prepCount();
  };

  // steps: tap marks current; patched in place
  const paintSteps = (cur) => {
    const ol = v.querySelector('ol.cooksteps');
    if (!ol) return;
    ol.classList.toggle('has-now', cur !== null);
    ol.querySelectorAll('button.step').forEach((b) => {
      const on = cur !== null && Number(b.dataset.step) === cur;
      b.classList.toggle('now', on);
      if (on) b.setAttribute('aria-current', 'step'); else b.removeAttribute('aria-current');
    });
    const clr = $('ck-step-clear');
    if (clr) clr.hidden = cur === null;
    const hint = v.querySelector('.stephint');
    if (hint) hint.hidden = cur !== null;
  };
  v.querySelectorAll('button.step').forEach((b) => {
    b.onclick = () => {
      const i = Number(b.dataset.step);
      cookDaySet('cookStep', file, i);
      paintSteps(i);
    };
  });
  const clr = $('ck-step-clear');
  if (clr) clr.onclick = () => { cookDaySet('cookStep', file, null); paintSteps(null); };

  const notes = v.querySelector('details.cooknotes');
  if (notes) notes.addEventListener('toggle', () => saveView({ cookNotesOpen: notes.open }));
}

/* ---------- screen wake-lock ----------
   Held while the Cook tab shows a recipe; the browser drops it whenever the
   page is hidden, so it is re-requested on visibilitychange → visible. Tab
   switches are caught by watching #view-cook's class (showTab toggles .on),
   so 00-core needs no hook. Needs a secure context: on the plain-http LAN
   address the pill shows disabled. Preference: localStorage mealapp-wake. */
const WAKE_KEY = 'mealapp-wake';
let wakeSentinel = null;
let wakeBusy = false;
let wakeAgain = false;
// Set when the browser refuses (battery saver, permission policy); cleared by
// the next visibilitychange or a pill tap, so renders don't re-ask every time.
let wakeErr = null;
const wakeSupported = () => 'wakeLock' in navigator && window.isSecureContext !== false;
function wakePref() { try { return localStorage.getItem(WAKE_KEY) !== 'off'; } catch { return true; } }
function setWakePref(on) {
  try { localStorage.setItem(WAKE_KEY, on ? 'on' : 'off'); } catch { /* storage blocked — session only */ }
  wakeErr = null;
  paintWake();
  void syncWakeLock();
}
const cookViewOn = () => $('view-cook').classList.contains('on');
function wakeWanted() {
  return wakeSupported() && wakePref() && cookViewOn() && !!cookFile() && document.visibilityState === 'visible';
}
async function syncWakeLock() {
  if (wakeBusy) { wakeAgain = true; return; }
  wakeBusy = true;
  try {
    if (wakeWanted()) {
      if (!wakeSentinel && !wakeErr) {
        try {
          const s = await navigator.wakeLock.request('screen');
          s.addEventListener('release', () => { if (wakeSentinel === s) wakeSentinel = null; paintWake(); });
          wakeSentinel = s;
        } catch (err) { wakeSentinel = null; wakeErr = err instanceof Error ? err.message : String(err); }
      }
    } else if (wakeSentinel) {
      const s = wakeSentinel;
      wakeSentinel = null;
      try { await s.release(); } catch { /* already released */ }
    }
  } finally {
    wakeBusy = false;
    paintWake();
    if (wakeAgain) { wakeAgain = false; void syncWakeLock(); }
  }
}
function wakeTitle() {
  if (!wakeSupported()) return 'Keeping the screen on needs the https:// address';
  if (!wakePref()) return 'The screen may sleep. Tap to keep it on while cooking';
  if (wakeSentinel) return 'The screen stays on while this recipe is open. Tap to allow sleep';
  if (wakeErr) return `The browser declined to keep the screen on (${wakeErr}). Battery saver can do this. Tap to try again`;
  return 'Screen stays on while a recipe is open. Tap to allow sleep';
}
// The pill's words follow the lock's real state, not just the preference.
const wakeDeclined = () => wakeSupported() && wakePref() && !wakeSentinel && !!wakeErr;
function wakeLabel() {
  if (!wakeSupported()) return 'Needs the https:// address';
  if (!wakePref()) return 'Screen may sleep';
  if (wakeDeclined()) return 'Screen may sleep · tap to retry';
  return 'Screen stays on';
}
// A tap toggles the preference, except after a refusal: then it asks again.
function tapWake() {
  if (!wakeDeclined()) { setWakePref(!wakePref()); return; }
  wakeErr = null;
  paintWake();
  void syncWakeLock();
}
function wakePillHtml() {
  const ok = wakeSupported();
  const on = ok && wakePref();
  return `<button type="button" class="wakepill${on && wakeSentinel ? ' held' : ''}${wakeDeclined() ? ' declined' : ''}" id="cook-wake" aria-pressed="${on}"${ok ? '' : ' disabled'} title="${esc(wakeTitle())}">${SUN_SVG}<span>${esc(wakeLabel())}</span></button>`;
}
function paintWake() {
  const b = $('cook-wake');
  if (!b) return;
  const ok = wakeSupported();
  const on = ok && wakePref();
  b.disabled = !ok;
  b.setAttribute('aria-pressed', String(on));
  b.classList.toggle('held', on && !!wakeSentinel);
  b.classList.toggle('declined', wakeDeclined());
  b.title = wakeTitle();
  b.querySelector('span').textContent = wakeLabel();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') wakeErr = null; // a fresh chance after every unlock
  void syncWakeLock();
});
new MutationObserver(() => {
  void syncWakeLock();
  if (!cookViewOn()) closeCookSheet(true);
}).observe($('view-cook'), { attributes: true, attributeFilter: ['class'] });

/* ---------- sous-chef sheet ----------
   Built once and appended to <body>, outside .wrap: renderCook replaces the
   recipe view freely and never touches the chat, so a streaming answer, the
   draft, and the sheet's scroll survive any re-render. Same .sheet pattern as
   Settings: backdrop + Escape close, everything behind is inert, focus goes
   back to the floating button. */
const cookSheet = (() => {
  const el = document.createElement('div');
  el.className = 'sheet cooksheet';
  el.id = 'cook-sheet';
  el.hidden = true;
  el.innerHTML = `<div class="sheet-backdrop" data-close></div>
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="cook-sheet-title">
      <div class="sheet-head">
        <div class="grow"><h2 id="cook-sheet-title">Sous-chef</h2><p class="cooksheet-sub" id="cook-sheet-sub"></p></div>
        <button class="ghost cooksheet-new" type="button" id="cook-clear" hidden>New chat</button>
        <button class="sheet-x" type="button" aria-label="Close sous-chef" data-close>✕</button>
      </div>
      <div class="cookchat-scroll" id="cook-chat-scroll"><div id="cook-msgs"></div></div>
      <div class="chatline cookchat-line">
        <textarea id="cook-in" rows="1" placeholder="Can I use shallots instead?" enterkeyhint="send" aria-label="Ask the sous-chef"></textarea>
        <button class="primary" type="button" id="cook-send">Ask</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
})();
let cookChatFile = null; // whose transcript + draft the sheet currently shows
let cookDraftT = null;
const cookSheetOpen = () => !cookSheet.hidden;

function cookGrow() {
  if (cookSheet.hidden) return; // display:none measures 0; openCookSheet re-runs this
  const ta = $('cook-in');
  ta.style.height = 'auto';
  const h = ta.scrollHeight + 2; // border-box: scrollHeight leaves out the 1px borders
  ta.style.height = Math.min(h, 132) + 'px';
  ta.style.overflowY = h > 132 ? 'auto' : 'hidden';
}
function cookChatScrollEnd() {
  const sc = $('cook-chat-scroll');
  sc.scrollTop = sc.scrollHeight;
}

function renderCookChat() {
  if (cookStreaming) return; // never yank the DOM out from under a live answer
  const file = cookFile();
  if (!file) { if (cookSheetOpen()) closeCookSheet(true); return; }
  const msgs = cookChatFor(file);
  $('cook-msgs').innerHTML = msgs.length
    ? msgs.map((m) => `<div class="msg ${m.role === 'user' ? 'user' : 'assistant'}">${m.role === 'user' ? esc(m.text) : mdLite(m.text)}</div>`).join('')
    : '<p class="cookchat-empty">Substitutions, timing, doneness, technique. Ask mid-cook; answers fit on a phone screen.</p>';
  $('cook-clear').hidden = !msgs.length;
  $('cook-send').disabled = false;
  $('cook-send').textContent = 'Ask';
  paintCookSheetSub();
  if (cookChatFile !== file) {
    cookChatFile = file;
    $('cook-in').value = (viewState.cookDrafts ?? {})[file] ?? '';
    cookGrow();
  }
}

// "Knows this recipe at ×2 (8 servings)…" — the question carries the same servings.
function paintCookSheetSub() {
  const file = cookFile();
  const sc = file && cookShown?.file === file ? cookShown.data.scale : null;
  const serv = file ? (cookServingsWanted(file) ?? sc?.servings) : null;
  $('cook-sheet-sub').textContent = sc && serv && serv !== sc.baseServings
    ? `Knows this recipe at ×${factorText(serv / sc.baseServings)} (${serv} servings), your preferences, and the pantry.`
    : 'Knows this recipe, your preferences, and the pantry.';
}

function openCookSheet(restoring) {
  const file = cookFile();
  if (cookSheetOpen() || !file) return;
  cookSheet.hidden = false;
  document.body.classList.add('sheet-open');
  document.querySelector('.wrap').inert = true;
  document.querySelector('nav.tabs').inert = true;
  if (viewState.cookUnread) {
    saveView({ cookUnread: null });
    $('cook-fab')?.querySelector('.fabdot')?.remove();
  }
  saveView({ cookSheet: true });
  renderCookChat();
  cookGrow();
  fitCookSheet();
  cookChatScrollEnd();
  if (!restoring) {
    // empty chat → straight to typing; otherwise read first (no keyboard over the answer)
    if (!cookChatFor(file).length) $('cook-in').focus();
    else cookSheet.querySelector('.sheet-x').focus();
  }
}
function closeCookSheet(quiet) {
  if (!cookSheetOpen()) return;
  cookSheet.hidden = true;
  document.body.classList.remove('sheet-open');
  document.querySelector('.wrap').inert = false;
  document.querySelector('nav.tabs').inert = false;
  saveView({ cookSheet: false });
  if (!quiet) $('cook-fab')?.focus({ preventScroll: true });
}
cookSheet.querySelectorAll('[data-close]').forEach((el) => { el.onclick = () => closeCookSheet(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && cookSheetOpen()) { e.preventDefault(); closeCookSheet(false); } });

// Android Chrome overlays the keyboard on the page (only the visual viewport
// shrinks), which would bury the input of a fixed bottom sheet: lift the panel
// by however much of the layout viewport the keyboard covers.
function fitCookSheet() {
  const panel = cookSheet.querySelector('.sheet-panel');
  const vv = window.visualViewport;
  if (!vv || !cookSheetOpen() || vv.scale > 1.05) { panel.style.removeProperty('--kb'); return; }
  const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  panel.style.setProperty('--kb', `${covered}px`);
}
window.visualViewport?.addEventListener('resize', fitCookSheet);
window.visualViewport?.addEventListener('scroll', fitCookSheet);

{
  const ta = $('cook-in');
  ta.addEventListener('input', () => {
    cookGrow();
    const file = cookChatFile;
    clearTimeout(cookDraftT);
    if (file) cookDraftT = setTimeout(() => saveCookDraft(file, ta.value), 400);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); void cookSend(cookChatFile ?? cookFile()); }
  });
  $('cook-send').onclick = () => void cookSend(cookChatFile ?? cookFile());
  $('cook-clear').onclick = () => {
    if (cookStreaming) return;
    const file = cookChatFile ?? cookFile();
    if (file) saveCookChat(file, []);
    renderCookChat();
    $('cook-in').focus();
  };
}

async function cookSend(file) {
  if (cookStreaming || !file) return;
  const ta = $('cook-in');
  const q = ta.value.trim();
  if (!q) return;
  const before = cookChatFor(file);
  const sent = [...before, { role: 'user', text: q }].slice(-40);
  saveCookChat(file, sent);
  ta.value = '';
  cookGrow();
  clearTimeout(cookDraftT);
  saveCookDraft(file, '');
  renderCookChat();

  const scroller = $('cook-chat-scroll');
  const bubble = document.createElement('div');
  bubble.className = 'msg assistant thinking';
  bubble.textContent = 'thinking…';
  $('cook-msgs').appendChild(bubble);
  cookChatScrollEnd();

  cookStreaming = true;
  const sendBtn = $('cook-send');
  sendBtn.disabled = true;
  sendBtn.textContent = '…';
  $('cook-clear').hidden = true;
  const pick = $('cook-pick');
  if (pick) pick.disabled = true;
  // follow the growing answer unless the cook scrolled up to re-read
  const nearEnd = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  let acc = '';
  let restore = '';
  let ok = false;
  try {
    const servings = cookServingsWanted(file);
    const r = await authedFetch('/api/cook/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ file, messages: sent, ...(servings ? { servings } : {}) }),
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
      const follow = nearEnd();
      bubble.classList.remove('thinking');
      bubble.textContent = acc;
      if (follow) cookChatScrollEnd();
    }
    acc = (acc + dec.decode()).trim();
    if (!acc) throw new Error('Empty answer — ask again.');
    saveCookChat(file, [...sent, { role: 'assistant', text: acc }]);
    ok = true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
    if (acc.trim()) {
      saveCookChat(file, [...sent, { role: 'assistant', text: acc.trim() + '\n\n⚠︎ answer got cut off — ask again for the rest' }]);
    } else {
      saveCookChat(file, before); // the question goes back in the box instead
      restore = q;
    }
  } finally {
    cookStreaming = false;
    if (ok && !cookSheetOpen()) saveView({ cookUnread: file }); // dot on the button
    const atEnd = nearEnd();
    renderCook();
    if (atEnd) cookChatScrollEnd();
    if (restore) { ta.value = restore; cookGrow(); saveCookDraft(file, restore); }
  }
}
