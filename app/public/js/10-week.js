/* 10-week.js — the Week tab: day cards, carry cards, prep, logging, close-out, past weeks.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- WEEK ---------- */
function starsHtml(date, current) {
  let b = '';
  for (let i = 1; i <= 5; i++) {
    b += `<button data-star="${i}" class="${current >= i ? 'on' : ''}" aria-label="${i} star${i > 1 ? 's' : ''}">${ico('star')}</button>`;
  }
  return `<div class="stars" role="group" data-date="${esc(date)}">${b}</div>`;
}

/* ---------- logging: stars, took-about, Didn't cook, the record copy ----------
   A capture is saved instantly (captures.json) and the planner reads it from
   then on; a fold writes it into the week's Log table ("in the record ✓✓").
   "Didn't cook" stores dish "skipped — <reason>" (the fold prompt's existing
   `skipped — …` convention); "took about…" stores minutes, which the fold
   writes as a "(took ~N min)" note prefix and close-out uses to nudge the
   recipe's active_time_min. Wiring: wireLogExtras (called from wireCommon). */
const SKIP_REASONS = [['leftovers', 'Leftovers'], ['ate out', 'Ate out'], ['no time', 'No time']];
const TOOK_MIN = [30, 45, 60, 75, 90]; // the last chip reads "90+"
const isSkipDish = (d) => /^skipped\b/i.test(String(d ?? ''));
const skipReasonOf = (d) => String(d ?? '').replace(/^skipped\s*[—–:-]?\s*/i, '').trim();

/** One entry's record status: "saved ✓ · into the record in 4 min · the planner already reads this" → "in the record ✓✓ · 10:42". */
function recordCopy(cap) {
  if (cap.foldedAt) return `<span class="folded">${ico('check2')}In the record · ${esc(recordTime(cap.foldedAt))}</span>`;
  const f = state.fold ?? {};
  const at = foldCountdownAt();
  const r = state.run;
  let when;
  if (r?.active && (r.type === 'fold' || r.type === 'review')) when = 'going into the record now';
  else if (at) {
    const left = at - Date.now();
    when = left > 60000 ? `into the record in ${Math.ceil(left / 60000)} min`
      : left > 0 ? 'into the record in under a minute' : 'going into the record now';
  } else if (f.last && !f.last.ok) when = 'last sync failed · Retry is in the banner';
  else when = state.autoFold ? 'into the record when you tap Done logging' : 'into the record at the next sync';
  return `<span class="saved">saved ✓${cap.by ? ` by ${esc(cap.by)}` : ''}</span> · ${when} · the planner already reads this`;
}

// The strip's 1 s ticker calls this so each pending entry's "in 4 min" stays
// true without re-rendering the Week tab (which would yank a focused note).
const recordCopyShown = new WeakMap();
function patchRecordCopy() {
  if (tab !== 'week') return;
  document.querySelectorAll('#view-week .log[data-date]').forEach((log) => {
    const cap = state.captures[log.dataset.date];
    const ss = log.querySelector('.savestate');
    if (!cap || cap.foldedAt || !ss) return;
    const html = recordCopy(cap);
    if (recordCopyShown.get(ss) !== html) { ss.innerHTML = html; recordCopyShown.set(ss, html); }
  });
}

function tookHtml(minutes) {
  const chips = TOOK_MIN.map((m) => {
    const on = m === TOOK_MIN[TOOK_MIN.length - 1] ? minutes >= m : minutes === m;
    return `<button type="button" class="tchip${on ? ' on' : ''}" data-min="${m}" aria-pressed="${on}">${m === 90 ? '90+' : m}</button>`;
  }).join('');
  return `<div class="tookrow" role="group" aria-label="Took about how many minutes"><span class="lbl">Took about · minutes</span>${chips}</div>`;
}

function logBlock(date, plannedDish, fileRating, fileCooked) {
  const cap = state.captures[date];
  const rating = cap?.rating ?? fileRating;
  const note = cap?.note ?? '';
  const dish = cap?.dish ?? '';
  const capSkip = isSkipDish(dish);
  // a skip already in the week's log (no capture overriding it) shows the same way, minus Undo
  const fileSkip = !dish && cap?.rating === undefined && isSkipDish(fileCooked);
  let save = '';
  if (cap) save = recordCopy(cap);
  else if (fileRating !== undefined || fileSkip) save = `<span class="folded">${ico('check2')}In the record</span>`;
  const noteArea = (ph) => `<textarea ${note ? '' : 'hidden'} placeholder="${ph}">${esc(note)}</textarea>`;
  if (capSkip || fileSkip) {
    const reason = skipReasonOf(capSkip ? dish : fileCooked);
    return `<div class="log skipped" data-date="${esc(date)}" data-planned="${esc(plannedDish)}">
    <div class="loglabel">Didn't cook</div>
    <div class="logrow">
      <span class="skipchip">Skipped${reason ? ` · ${esc(reason)}` : ''}</span>
      ${capSkip ? `<button type="button" class="skipundo" data-skip-undo>${ico('undo')}Undo</button>` : ''}
      <button type="button" class="notebtn" data-act="note">${ico('pencil')}${note ? 'Note' : 'Anything to note?'}</button>
    </div>
    ${noteArea('Anything to note?')}
    <input class="dishin" hidden value="${esc(dish)}">
    <div class="savestate">${save}</div>
  </div>`;
  }
  const happened = date <= state.today; // only a night that has happened can be timed
  return `<div class="log" data-date="${esc(date)}" data-planned="${esc(plannedDish)}">
    <div class="loglabel">How was it?</div>
    <div class="logrow">
      ${starsHtml(date, rating)}
      <button type="button" class="notebtn" data-act="note">${ico('pencil')}Note</button>
      <button type="button" class="notebtn" data-act="dish">${ico('swap')}${dish ? esc(dish) : 'Dish changed'}</button>
      <button type="button" class="skipbtn" data-skip-open aria-expanded="false">${ico('x')}Didn't cook</button>
    </div>
    <div class="skiprow" role="group" aria-label="Why not?" hidden>
      ${SKIP_REASONS.map(([v, l]) => `<button type="button" class="tchip" data-skip="${v}">${l}</button>`).join('')}
      <button type="button" class="tchip" data-skip-other>Other…</button>
    </div>
    ${happened ? tookHtml(cap?.minutes) : ''}
    ${noteArea('Tweaks, verdicts, what to change next time')}
    <input class="dishin" ${dish ? '' : 'hidden'} placeholder="What got cooked instead? (or: skipped, takeout…)" value="${esc(dish)}">
    <div class="savestate">${save}</div>
  </div>`;
}

/** Week tab: "Done logging" under the last day card while anything is pending — folds now. */
function doneLoggingHtml() {
  const pend = pendingCaptureCount();
  if (!pend) return '';
  const r = state.run;
  const folding = r?.active && (r.type === 'fold' || r.type === 'review');
  const it = pend === 1 ? 'it' : 'them';
  return `<div class="donelog">
    <button class="ghost wide" id="btn-done-logging" ${runActive() ? 'disabled' : ''}>${folding ? 'Putting it in the record…' : 'Done logging'}</button>
    <p class="hint">${pend} saved ${pend === 1 ? 'entry' : 'entries'} · the planner already reads ${it}. Done logging writes ${it} into the week's log now instead of waiting.</p>
  </div>`;
}

async function logPost(date, body) {
  const j = await expectOk(await opost('/api/log', { date, ...body }), 'Could not save.');
  if (!j) return;
  if (j.entry) state.captures[date] = j.entry; else delete state.captures[date];
  setFoldState(j.fold);
  renderAll();
}

// Didn't cook → reason chips (Other… opens the dish input), Undo, took-about
// chips (tap the lit one to clear), and the Week tab's Done logging button.
function wireLogExtras(root) {
  root.querySelectorAll('.log[data-date]').forEach((log) => {
    const date = log.dataset.date;
    const row = log.querySelector('.skiprow');
    const open = log.querySelector('[data-skip-open]');
    if (open && row) {
      open.onclick = () => { row.hidden = !row.hidden; open.setAttribute('aria-expanded', String(!row.hidden)); };
    }
    log.querySelectorAll('[data-skip]').forEach((b) => { b.onclick = () => void logPost(date, { skipped: b.dataset.skip }); });
    const other = log.querySelector('[data-skip-other]');
    if (other) {
      other.onclick = () => {
        if (row) row.hidden = true;
        const din = log.querySelector('input.dishin');
        if (!din) return;
        din.placeholder = 'What happened instead? (skipped — sick, takeout…)';
        din.hidden = false;
        din.focus();
      };
    }
    const undo = log.querySelector('[data-skip-undo]');
    if (undo) undo.onclick = () => void logPost(date, { skipped: null });
    log.querySelectorAll('[data-min]').forEach((b) => {
      b.onclick = () => {
        const m = Number(b.dataset.min);
        const cur = state.captures[date]?.minutes;
        const lit = m === TOOK_MIN[TOOK_MIN.length - 1] ? cur >= m : cur === m;
        void logPost(date, { minutes: lit ? null : m });
      };
    });
  });
  const dl = root.querySelector('#btn-done-logging');
  if (dl) dl.onclick = foldNow;
}

function prepBlock(tasks) {
  if (!tasks.length) return '';
  return `<div class="prep"><div class="preplabel">Prep</div>` + tasks.map((p) => {
    const done = !!state.checks[p.key];
    return `<label class="item"><input type="checkbox" data-key="${esc(p.key)}" ${done ? 'checked' : ''}>
      <span class="box">✓</span><span class="txt"><span class="t">${esc(p.text)}</span></span></label>`;
  }).join('') + `</div>`;
}

// Tonight's rationale: its first sentence is the pull-quote, the rest reads as
// a normal paragraph (display only; rationales often run to a paragraph).
function whyParts(text) {
  const s = String(text ?? '');
  let depth = 0;
  for (let i = 20; i < s.length - 2; i++) {
    const c = s[i];
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    else if (!depth && (c === '.' || c === '!' || c === '?') && s[i + 1] === ' ' && /[A-Z“"‘(]/.test(s[i + 2])) {
      return [s.slice(0, i + 1), s.slice(i + 2)];
    }
  }
  return [s, ''];
}

// Consecutive flexible nights share one ruled index (.flexgroup) instead of a card each.
function joinRows(list) {
  let out = '';
  let open = false;
  for (const r of list) {
    if (r.flex && !open) { out += '<div class="flexgroup">'; open = true; }
    if (!r.flex && open) { out += '</div>'; open = false; }
    out += r.html;
  }
  return open ? `${out}</div>` : out;
}

/* Close-out readiness, re-derived live. state.cooking.closeReady/missing come
   from the last /api/state, but a capture (a star tap here, or the other
   phone's over WS) never refetches it — so rating the last night wouldn't
   show the close-out card until some later refetch. Same rule as buildState
   in server/state.ts (keep them in step): every non-flexible night with a date
   has a file log rating/cooked entry or a capture rating/dish. */
function syncCloseReady() {
  const c = state.cooking;
  if (!c) return false;
  c.missing = c.plan.meals.filter((m) => !m.flexible && c.dates[m.day]).filter((m) => {
    const l = c.plan.log.find((x) => x.day === m.day);
    if (l && (l.rating !== undefined || (l.cooked && l.cooked !== ''))) return false;
    const cap = state.captures[c.dates[m.day]];
    return !(cap && (cap.rating !== undefined || cap.dish));
  }).map((m) => m.day);
  c.closeReady = c.plan.status === 'locked' && c.missing.length === 0;
  return c.closeReady;
}

/* Rescale from the Week tab. On Saturday the week that locked Friday is the
   cooking week and the Next tab has moved on, so each tonight-or-later day card
   of a LOCKED cooking week carries the Next tab's locked-summary stepper
   (20-next.js servingsHtml/wireServings, mode 'locked': confirm → POST
   /api/runs/rescale), folded behind a small "4 servings ▾" toggle. */
const wkServOpen = new Set(); // `${week}|${day}` toggles left open, kept across re-renders
function weekServHtml(week, m) {
  const n = fileServings(m);
  const k = `${week}|${m.day}`;
  return `<details class="wkserv" data-wkserv="${esc(k)}"${wkServOpen.has(k) ? ' open' : ''}>
    <summary>${ico('people')}${n} servings <span class="caret" aria-hidden="true">${ico('down')}</span></summary>${servingsHtml(m, n, 'locked')}</details>`;
}

/* ---------- Get started (first-run onboarding; the template's fresh install) ----------
   Shown at the top of the Week tab until the profile is filled in AND a plan
   exists, unless hidden on this device. state.setup comes from buildState
   (server/state.ts): profileReady/pantryReady = no `_fill in_` left, counts of
   recipes and plans, and the starter library's remaining count. A household's
   own repo has all of that, so the card never renders there. */
const SETUP_HIDE_KEY = 'mealapp-setup-dismissed';
const INTERVIEW_ASK = 'Interview me to fill in profile/preferences.md and profile/pantry.md. Ask a few questions at a time (household, cadence, nutrition goals, hard-nos, tastes, logistics, stores, a standard pantry), then write both files, remove every `_fill in_` placeholder, and commit.';
const setupHidden = () => { try { return localStorage.getItem(SETUP_HIDE_KEY) === '1'; } catch { return false; } };

function setupCardHtml() {
  const su = state?.setup;
  if (!su || (su.profileReady && su.plans > 0) || setupHidden()) return '';
  const profileDone = su.profileReady && su.pantryReady;
  const starter = su.starter ?? { available: false, remaining: 0 };
  const recipesDone = starter.remaining === 0 || su.recipes > 0;
  const planDone = su.plans > 0;
  const busy = runActive() ? ' disabled' : '';
  const step = (done, title, body) => `<li class="sstep${done ? ' done' : ''}">
      <span class="smark" aria-label="${done ? 'done' : 'to do'}">${done ? ico('check') : ''}</span>
      <div class="sbody"><div class="stitle">${title}</div>${body}</div>
    </li>`;
  let steps = step(profileDone, 'Fill in your profile',
    `<p class="hint">Household, cooking nights, nutrition goals, hard-nos, tastes, stores, and what’s in the pantry. Claude reads it before every plan.</p>
     ${profileDone ? '' : `<button class="ghost q" data-setup="interview"${busy}>Ask Claude to interview me</button>
     <p class="hint small">or edit <code>profile/preferences.md</code> and <code>profile/pantry.md</code> by hand</p>`}`);
  if (starter.available) {
    steps += step(recipesDone, 'Add recipes <span class="opt">optional</span>',
      `<p class="hint">${recipesDone ? `${su.recipes} recipe${su.recipes === 1 ? '' : 's'} in the library.`
        : `Import some of the ${starter.remaining} starter recipes, or add your own from a link or photo.`}</p>
       ${recipesDone ? '' : '<button class="ghost" data-setup="recipes">Open Recipes</button>'}`);
  }
  steps += step(planDone, 'Propose your first week',
    `<p class="hint">${profileDone ? 'Claude proposes the week; you approve, swap, and lock it on the Next tab.'
      : 'Unlocks once the profile is filled in.'}</p>
     ${planDone ? '' : `<button class="ghost" data-setup="next"${profileDone ? '' : ' disabled'}>Go to Next</button>`}`);
  return `<div class="card setup" id="setup-card">
    <div class="setuphead"><h2>Get started</h2><button class="undo" data-setup="hide">Hide</button></div>
    <ol class="ssteps">${steps}</ol>
  </div>`;
}

function wireSetupCard(root) {
  const card = root.querySelector('#setup-card');
  if (!card) return;
  card.onclick = (e) => {
    const b = e.target.closest('[data-setup]');
    if (!b || b.disabled) return;
    switch (b.dataset.setup) {
      case 'hide':
        try { localStorage.setItem(SETUP_HIDE_KEY, '1'); } catch { /* private mode: hides until reload */ }
        card.remove();
        return;
      case 'interview':
        askSave({ draft: INTERVIEW_ASK }); // 80-ask.js: openAskSheet fills the composer from the draft
        openAskSheet();
        return;
      case 'recipes': showTab('recipes'); return;
      case 'next': showTab('next'); return;
    }
  };
}

function renderWeek() {
  const v = $('view-week');
  syncCloseReady();
  if (!state.cooking) {
    v.innerHTML = setupCardHtml() + resultCard(['fold', 'review']) + `<div class="pending"><h2>No active week</h2>
      <p>There's no locked plan covering today. Head to the <b>Next</b> tab to propose one.</p></div>`;
    wireSetupCard(v);
    return;
  }
  const { plan, dates, week, fallback } = state.cooking;
  let html = setupCardHtml() + resultCard(['fold', 'review', 'rescale']);
  if (fallback) html += `<div class="warnnote"><b>Showing ${esc(week)}</b> — the current week has no locked plan yet.</div>`;

  // carry: unlogged stragglers from the previous week, one dashed saffron card
  if (state.carry.length) {
    html += `<section class="carry" aria-label="Still unlogged from last week"><div class="carrylabel">Still unlogged from last week</div>` +
      state.carry.map((c) => `<div class="crow">
        <div class="dow">${esc(c.day)}<small>${dpart(c.date).d}</small></div>
        <div class="daybody">
          <h3>${esc(c.dish)}</h3>
          ${logBlock(c.date, c.dish, undefined)}
        </div>
      </div>`).join('') + '</section>';
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
    html += `<div class="card earlyprep"><h2 class="minor">Before the week</h2>${prepBlock(earlyPrep)}</div>`;
  }

  // While today is inside the week: tonight first (the hero), then "Coming
  // up", then "Earlier this week". Otherwise the days in order, unsectioned.
  const logByDay = new Map(plan.log.map((l) => [l.day, l]));
  const span = weekSpan(dates);
  const inWeek = !!span.first && state.today >= span.first && state.today <= span.last;
  const rows = { tonight: [], coming: [], earlier: [] };
  for (const m of plan.meals) {
    const date = dates[m.day];
    if (!date) continue; // row on a day this week doesn't have (a drifted file) — no date to card it under
    const tonight = date === state.today;
    const dnum = dpart(date).d;
    const bucket = !inWeek ? 'coming' : tonight ? 'tonight' : date > state.today ? 'coming' : 'earlier';
    const leaf = `<div class="dow">${m.day}<small>${dnum}</small></div>`;
    if (m.flexible) {
      rows[bucket].push({ flex: true, html: `<div class="flexrow${tonight ? ' tonight' : ''}">${leaf}
        <div class="daybody"><p class="ft">${tonight ? '<span class="tonightbadge">Tonight</span>' : ''}<b>Flexible</b><span class="flexnote">leftovers, out, or spontaneous</span></p>${prepBlock(prepByDate.get(date) ?? [])}</div>
      </div>` });
      continue;
    }
    const fileLog = logByDay.get(m.day);
    const badge = m.isNew ? '<span class="tagnew">New</span>'
      : m.favRating ? `<span class="tagfav">★ ${m.favRating}</span>` : '';
    // a locked week's tonight-and-later meals carry the rescale toggle, which names the servings itself
    const canRescale = plan.status === 'locked' && date >= state.today;
    const meta = metaSpans([m.timeMin && `${m.timeMin} min`, m.cal && `~${m.cal} cal`, m.protein && `${m.protein} g protein`,
      !canRescale && Number(m.servings) > 0 && Number(m.servings) !== 4 && `${m.servings} servings`]); // Plan table's Servings column; 4 = the default, unsaid
    const [head, side] = dishParts(m.dish);
    const title = `<h3>${keepHyphens(head)}</h3>${side ? `<p class="with">${esc(side)}</p>` : ''}`;
    const why = plan.whys[m.day] ?? '';
    const prepLog = prepBlock(prepByDate.get(date) ?? []) + logBlock(date, m.dish, fileLog?.rating, fileLog?.cooked);
    if (tonight) {
      const [pull, whyRest] = whyParts(why);
      rows.tonight.push({ flex: false, html: `<article class="day tonight hero" aria-label="Tonight">
        <div class="hero-top"><span class="tonightbadge">Tonight</span><span class="when">${m.day} ${dnum}</span>${badge}</div>
        ${title}
        ${meta ? `<div class="meta">${m.timeMin ? ico('clock') : ''}${meta}</div>` : ''}
        ${canRescale ? weekServHtml(week, m) : ''}
        ${pull ? `<blockquote class="pull">${esc(pull)}</blockquote>` : ''}${whyRest ? `<p class="why">${esc(whyRest)}</p>` : ''}
        ${m.recipeFile ? `<div class="hero-actions"><a class="btn btn-primary" href="#" data-cook="${esc(m.recipeFile)}">Cook${ico('arrow')}</a><a class="btn btn-ghost" href="#" data-recipe="${esc(m.recipeFile)}">Recipe</a></div>` : ''}
        ${prepLog}
      </article>` });
      continue;
    }
    rows[bucket].push({ flex: false, html: `<div class="day${bucket === 'earlier' ? ' past' : ''}">
      ${leaf}
      <div class="daybody">
        ${badge ? `<div class="chiprow">${badge}</div>` : ''}
        ${title}
        ${meta ? `<div class="meta">${meta}</div>` : ''}
        ${canRescale ? weekServHtml(week, m) : ''}
        ${why ? `<p class="why">${esc(why)}</p>` : ''}
        ${m.recipeFile ? `<div class="daylinks"><a href="#" data-recipe="${esc(m.recipeFile)}">Recipe${ico('arrow')}</a></div>` : ''}
        ${prepLog}
      </div>
    </div>` });
  }
  const section = (label, list) => (list.length ? `<div class="sect">${label}</div>${joinRows(list)}` : '');
  html += inWeek
    ? joinRows(rows.tonight) + section('Coming up', rows.coming) + section('Earlier this week', rows.earlier)
    : joinRows(rows.coming);
  html += doneLoggingHtml(); // pending entries → "Done logging" under the last day card

  if (plan.status === 'complete' && plan.reviewMd) {
    html += `<div class="card"><h2>Week review</h2><div class="mdbody" data-md-review></div></div>`;
  }
  if (state.cooking.closeReady) {
    const nextW = state.aheadWeekId;
    if (!state.ahead?.plan) {
      // Close out + plan in one tap: collect the planning inputs up front, then
      // one chained run (review → propose) while nobody has to watch it.
      const t = state.typical ?? {};
      const usual = t.review && t.propose ? ` Usually about ${mins(t.review + t.propose)} min for both.` : '';
      html += `<div class="card closeout" id="closeout-card"><h2>Close out ${esc(shortWeek(week))} and plan ${esc(shortWeek(nextW))}</h2>
        <p class="hint">Every night is logged. One tap closes ${esc(shortWeek(week))} (recipe stats, the week review, what it learned), then proposes ${esc(shortWeek(nextW))} around the nights and notes below.${esc(usual)}</p>
        ${planInputsHtml(nextW)}
        <button class="primary" id="btn-close-plan" ${runActive() ? 'disabled' : ''}>Close out and plan next week${ico('arrow')}</button>
        <button class="ghost wide" id="btn-review" ${runActive() ? 'disabled' : ''}>Close out only</button></div>`;
    } else {
      html += `<div class="card closeout" id="closeout-card"><h2>Close out ${esc(shortWeek(week))}</h2>
        <p class="hint">Every night is logged. Closing updates recipe stats, writes the week review, and feeds what it learned into the next plan.</p>
        <button class="primary" id="btn-review" ${runActive() ? 'disabled' : ''}>Close out the week</button></div>`;
    }
  }
  html += trendsCardHtml(); // 15-trends.js
  html += `<details class="hist" id="hist"><summary>Past weeks${ico('right')}</summary>
    <div id="hist-list" class="histlist"></div><div id="hist-body" class="mdbody"></div></details>`;
  v.innerHTML = html;
  wireSetupCard(v);
  wireTrends(v);

  if (plan.status === 'complete' && plan.reviewMd) {
    const el = v.querySelector('[data-md-review]');
    if (el) el.textContent = plan.reviewMd; // plain text is fine for the strip of prose
  }
  const btnR = $('btn-review');
  if (btnR) btnR.onclick = closeOutWeek;
  const btnCP = $('btn-close-plan');
  if (btnCP) btnCP.onclick = closeAndPlan;
  wirePlanInputs(v);
  wireServings(v, week, plan.meals); // the rescale chips folded into the day cards (weekServHtml)
  v.querySelectorAll('details.wkserv').forEach((d) => d.addEventListener('toggle', () => {
    if (d.open) wkServOpen.add(d.dataset.wkserv); else wkServOpen.delete(d.dataset.wkserv);
  }));
  const hist = $('hist');
  if (hist) hist.addEventListener('toggle', () => { if (hist.open) void loadHistory(); }, { once: true });
  wireCommon(v);
}

async function closeOutWeek() {
  if (!confirm(`Close out ${state.cooking.week}? This updates recipe stats and preferences.`)) return;
  await expectOk(await jpost('/api/runs/review', { week: state.cooking.week }), 'Could not start the close-out.');
}

// review(cooking week) → propose(ahead week), one chain, with the chips +
// constraints from the card (the same draft the Next tab's Propose card shows).
async function closeAndPlan() {
  const week = state.cooking.week;
  const nextWeek = state.aheadWeekId;
  const d = planDraftFor(nextWeek);
  if (!confirm(`Close out ${week}, then propose ${nextWeek}? Closing updates recipe stats and preferences.`)) return;
  const b = $('btn-close-plan');
  if (b) b.disabled = true;
  const j = await expectOk(await jpost('/api/runs/close-and-plan', { week, nextWeek, note: d.note, cookNights: d.nights }),
    'Could not start the close-out.');
  if (j) rememberCookNights(d.nights);
  else if (b) b.disabled = false;
}

// The strip's "Close out" (and the Next tab's hint) lands on the card instead
// of firing a run, so the planning inputs get seen before anything starts.
function goToCloseOut() {
  const jump = tab !== 'week'; // from another tab there's nothing to animate from: land instantly
  if (jump) showTab('week', true);
  requestAnimationFrame(() => {
    const el = $('closeout-card');
    if (el) el.scrollIntoView({ behavior: jump ? 'auto' : 'smooth', block: 'start' });
  });
}

async function loadHistory() {
  const list = $('hist-list');
  const r = await fetch('/api/plans');
  const j = await expectOk(r, 'Could not load past weeks.');
  if (!j) return;
  list.innerHTML = j.plans.map((p) =>
    `<button class="ghost" data-plan="${esc(p.file)}">${esc(p.week)} · ${esc(p.status)}</button>`).join('');
  list.querySelectorAll('[data-plan]').forEach((b) => {
    b.onclick = async () => {
      const rr = await fetch(`/api/plans/entry?f=${encodeURIComponent(b.dataset.plan)}`);
      const jj = await expectOk(rr, 'Could not load that week.');
      if (jj) $('hist-body').innerHTML = jj.html;
    };
  });
}
