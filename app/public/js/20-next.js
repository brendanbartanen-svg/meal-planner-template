/* 20-next.js — the Next tab: propose, per-meal feedback, revise, lock.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- planning inputs: cook-night chips + constraints ----------
   Shared by the Week tab's close-and-plan card and this tab's Propose card:
   one draft per ahead week, so a chip tapped or a note typed on one shows on
   the other, and a re-render (any state update) never wipes it. The draft
   rides in viewState (sessionStorage) so a screen-lock reload keeps it; the
   last SUBMITTED nights go to localStorage as the next default, falling back
   to the cooking week's pattern (its non-flexible days). */
const PLAN_NOTE_PLACEHOLDER = 'Anything else to plan around? (“use the frozen shrimp”, “lighter week please”)';
let planDraft = null; // { week, nights: ['Sat', …], note }

function aheadDayOrder() {
  if (Array.isArray(state.aheadDays) && state.aheadDays.length) return state.aheadDays;
  if (state.ahead?.dates) return Object.keys(state.ahead.dates);
  return ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];
}
function defaultCookNights(order) {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem('mealapp-cook-nights') || 'null'); } catch { saved = null; }
  if (Array.isArray(saved) && saved.length) return order.filter((d) => saved.includes(d));
  const last = (state.cooking?.plan?.meals ?? []).filter((m) => !m.flexible).map((m) => m.day);
  return order.filter((d) => last.includes(d));
}
function planDraftFor(week) {
  if (planDraft && planDraft.week === week) return planDraft;
  const order = aheadDayOrder();
  const saved = viewState.planDraft;
  planDraft = saved && saved.week === week && Array.isArray(saved.nights)
    ? { week, nights: order.filter((d) => saved.nights.includes(d)), note: String(saved.note ?? '') }
    : { week, nights: defaultCookNights(order), note: '' };
  return planDraft;
}
const savePlanDraft = () => saveView({ planDraft });
function rememberCookNights(nights) {
  try { localStorage.setItem('mealapp-cook-nights', JSON.stringify(nights)); } catch { /* private mode — the default just falls back */ }
}
function nightsSummary(nights, order) {
  if (!nights.length) return 'No nights picked: Claude decides how many to cook';
  const off = order.filter((d) => !nights.includes(d));
  return `${nights.length} cook night${nights.length === 1 ? '' : 's'} · ${off.length ? `off ${off.join(', ')}` : 'every night'}`;
}
function planInputsHtml(week) {
  const d = planDraftFor(week);
  const order = aheadDayOrder();
  return `<div class="planinputs" data-plan-week="${esc(week)}">
    <div class="chipslabel">Cook nights</div>
    <div class="chips" role="group" aria-label="Cook nights for ${esc(weekName(week))}">${order.map((day) => {
      const on = d.nights.includes(day);
      return `<button type="button" class="chip${on ? ' on' : ''}" data-night="${esc(day)}" aria-pressed="${on}">${esc(day)}</button>`;
    }).join('')}</div>
    <div class="chipsum">${esc(nightsSummary(d.nights, order))}</div>
    <textarea class="plain" data-plannote aria-label="Constraints for ${esc(weekName(week))}" placeholder="${esc(PLAN_NOTE_PLACEHOLDER)}">${esc(d.note)}</textarea>
  </div>`;
}
// Patch every copy of the draft in place (Week and Next can both show it) —
// no re-render, so a half-typed note in the other copy survives.
function syncPlanInputs(week, except) {
  const d = planDraftFor(week);
  const order = aheadDayOrder();
  document.querySelectorAll(`.planinputs[data-plan-week="${CSS.escape(week)}"]`).forEach((box) => {
    box.querySelectorAll('[data-night]').forEach((b) => {
      const on = d.nights.includes(b.dataset.night);
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', String(on));
    });
    box.querySelector('.chipsum').textContent = nightsSummary(d.nights, order);
    const ta = box.querySelector('[data-plannote]');
    if (ta && ta !== except && ta.value !== d.note) ta.value = d.note;
  });
}
function wirePlanInputs(root) {
  root.querySelectorAll('.planinputs').forEach((box) => {
    const week = box.dataset.planWeek;
    box.querySelectorAll('[data-night]').forEach((b) => {
      b.onclick = () => {
        const d = planDraftFor(week);
        const day = b.dataset.night;
        const order = aheadDayOrder();
        d.nights = order.filter((x) => (x === day ? !d.nights.includes(x) : d.nights.includes(x)));
        savePlanDraft();
        syncPlanInputs(week);
      };
    });
    const ta = box.querySelector('[data-plannote]');
    if (ta) ta.addEventListener('input', () => { planDraftFor(week).note = ta.value; savePlanDraft(); syncPlanInputs(week, ta); });
  });
}

/* state.ahead.approval is a snapshot from the last /api/state, but feedback
   changes arrive faster (POST replies, WS 'feedback'), which never refresh it —
   so derive approval live from the plan + current feedback (same rule as the
   server's mealApproved). `decision` = this round's feedback, if any. */
function aheadApprovalNow() {
  const p = state.ahead?.plan;
  if (!p) return [];
  const meals = state.feedback?.meals ?? {};
  return p.meals.filter((m) => !m.flexible).map((m) => ({
    day: m.day,
    approved: m.status === 'approved' || meals[m.day]?.decision === 'approve',
    decision: meals[m.day]?.decision ?? null,
  }));
}

/* ---------- servings stepper ----------
   One segmented control per meal (4 · 6 · 8 · 10 · 12, plus the meal's own
   number when it is off that list, e.g. a 9). While planning a tap stores
   `servings` in this round's feedback (null = back to the file's value) —
   independent of the decision — and revise/lock write it into the Plan
   table's Servings column. On a locked week a tap (after a confirm) starts the
   light rescale run. The preview line is the recipe's first ingredient at that
   scale (GET /api/recipes/headline), cached per file + servings. */
const SERV_STEPS = [4, 6, 8, 10, 12];
const SERV_DAY_NAMES = { Sat: 'Saturday', Sun: 'Sunday', Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday', Fri: 'Friday' };
const servHeadlines = new Map(); // `${file}|${n}` → { headline } | { missing: true }
const servInflight = new Set();

const fileServings = (m) => (Number(m.servings) > 0 ? Number(m.servings) : 4);
function aheadServings(m) {
  const o = state.feedback?.meals?.[m.day]?.servings;
  return Number.isInteger(o) ? o : fileServings(m);
}
function servPreviewHtml(file, n) {
  if (!file) {
    return esc(state.ahead?.plan?.status === 'planning'
      ? `(new recipe: written at lock; shopped for ${n} servings)`
      : `(no recipe file linked; shopped for ${n} servings)`);
  }
  const c = servHeadlines.get(`${file}|${n}`);
  if (!c) return '…';
  if (c.missing) return esc(`(no recipe file yet; shopped for ${n} servings)`);
  return c.headline ? `→ <b>${esc(c.headline)}</b>` : esc(`→ ${n} servings`);
}
function servingsHtml(m, cur, mode) {
  const steps = [...new Set([...SERV_STEPS, cur])].sort((a, b) => a - b);
  const off = mode === 'locked' && runActive() ? ' disabled' : '';
  return `<div class="servings" data-serv-mode="${mode}" data-serv-day="${esc(m.day)}" data-serv-file="${esc(m.recipeFile ?? '')}" data-serv-cur="${cur}">
    <div class="chipslabel">Servings</div>
    <div class="chips servchips" role="group" aria-label="Servings for ${esc(SERV_DAY_NAMES[m.day] ?? m.day)}">${steps.map((n) =>
      `<button type="button" class="chip${n === cur ? ' on' : ''}" data-serv="${n}" aria-pressed="${n === cur}"${off}>${n}</button>`).join('')}</div>
    <div class="servprev" aria-live="polite">${servPreviewHtml(m.recipeFile, cur)}</div>
  </div>`;
}
// Patch the boxes showing this file at this count (no re-render: a half-typed
// note elsewhere on the tab survives the preview landing).
function patchServPreviews(file, n) {
  document.querySelectorAll('.servings').forEach((box) => {
    if (box.dataset.servFile === file && Number(box.dataset.servCur) === n) box.querySelector('.servprev').innerHTML = servPreviewHtml(file, n);
  });
}
async function loadServHeadline(file, n) {
  const k = `${file}|${n}`;
  if (!file || servHeadlines.has(k) || servInflight.has(k)) return;
  servInflight.add(k);
  try {
    const r = await fetch(`/api/recipes/headline?f=${encodeURIComponent(file)}&servings=${n}`);
    if (r.status === 404) servHeadlines.set(k, { missing: true });
    else if (r.ok) servHeadlines.set(k, { headline: (await r.json()).headline ?? null });
  } catch { /* offline: stays uncached, the next render retries */ }
  servInflight.delete(k);
  patchServPreviews(file, n);
}
function setServOn(box, n) {
  box.dataset.servCur = String(n);
  box.querySelectorAll('[data-serv]').forEach((b) => {
    const on = Number(b.dataset.serv) === n;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', String(on));
  });
  box.querySelector('.servprev').innerHTML = servPreviewHtml(box.dataset.servFile || undefined, n);
}
function wireServings(root, week, meals) {
  root.querySelectorAll('.servings').forEach((box) => {
    const day = box.dataset.servDay;
    const m = meals.find((x) => x.day === day);
    if (!m) return;
    // current count first, then the other steps (cached), so a tap previews
    // instantly (plan) or the rescale confirm can quote the new amount (locked)
    void loadServHeadline(m.recipeFile, Number(box.dataset.servCur)).then(() => {
      box.querySelectorAll('[data-serv]').forEach((b) => void loadServHeadline(m.recipeFile, Number(b.dataset.serv)));
    });
    box.querySelectorAll('[data-serv]').forEach((b) => {
      b.onclick = async () => {
        const n = Number(b.dataset.serv);
        if (n === Number(box.dataset.servCur)) return;
        if (box.dataset.servMode === 'plan') {
          setServOn(box, n); // optimistic; the reply re-renders with the stored value
          void loadServHeadline(m.recipeFile, n);
          const j = await expectOk(await opost('/api/feedback', { week, day, servings: n === fileServings(m) ? null : n }), 'Could not save the servings.');
          if (j) state.feedback = j.feedback;
          renderNext();
          return;
        }
        // locked: a light run rewrites that meal's Servings cell + grocery lines
        const hl = m.recipeFile ? servHeadlines.get(`${m.recipeFile}|${n}`)?.headline : null;
        if (!confirm(`Rescale ${SERV_DAY_NAMES[day] ?? day} to ${n} servings${hl ? ` (→ ${hl})` : ''}? Claude will update the grocery list.`)) return;
        box.querySelectorAll('[data-serv]').forEach((x) => { x.disabled = true; });
        const j = await expectOk(await jpost('/api/runs/rescale', { week, day, servings: n }), 'Could not start the rescale.');
        if (!j) box.querySelectorAll('[data-serv]').forEach((x) => { x.disabled = false; });
      };
    });
  });
}

/* ---------- NEXT ---------- */
function renderNext() {
  const v = $('view-next');
  const w = state.aheadWeekId;
  const p = state.ahead?.plan;
  let html = resultCard(['propose', 'revise', 'lock', 'rescale']);

  if (!p) {
    // The cooking week is fully logged: point at the one-tap close-and-plan card.
    const closeHint = state.cooking?.closeReady
      ? `<p class="hint">${esc(weekName(state.cooking.week, 'Rel'))} is fully logged. <a href="#" id="goto-closeplan">Close it out and plan ${esc(weekName(w))} in one go</a> from the Week tab.</p>`
      : '';
    html += `<div class="pending"><span class="when">planning</span>
      <h2>Plan ${esc(weekName(w))}</h2>
      <p>Claude reads your preferences, the pantry, and the last weeks' ratings, then proposes the week for you to approve meal by meal.</p>
      ${closeHint}
      ${planInputsHtml(w)}
      <button class="primary" id="btn-propose" ${runActive() ? 'disabled' : ''}>Propose ${esc(weekName(w))}${ico('arrow')}</button>
    </div>`;
    v.innerHTML = html;
    wirePlanInputs(v);
    const gc = $('goto-closeplan');
    if (gc) gc.onclick = (e) => { e.preventDefault(); goToCloseOut(); };
    const b = $('btn-propose');
    if (b) b.onclick = async () => {
      b.disabled = true;
      const d = planDraftFor(w);
      const j = await expectOk(await jpost('/api/runs/propose', { week: w, note: d.note, cookNights: d.nights }), 'Could not start the proposal.');
      if (j) rememberCookNights(d.nights); else b.disabled = false;
    };
    return;
  }

  const fb = state.feedback ?? { meals: {} };
  if (p.status === 'planning') {
    const approval = aheadApprovalNow();
    const notApproved = approval.filter((a) => !a.approved);
    // undecided = no decision this round and not approved in an earlier one
    const undecidedDays = notApproved.filter((a) => !a.decision).map((a) => a.day);
    html += `<p class="intro"><b>Decide each meal:</b> keep it, say no (and why: it teaches the planner), or ask for a swap. Then send changes, or lock when everything’s kept.</p>`;
    const DEC_WORD = { approve: 'Kept', reject: 'Said no', swap: 'Swap requested' };
    for (const m of p.meals) {
      if (m.flexible) continue;
      const d = fb.meals?.[m.day];
      const approvedInFile = m.status === 'approved';
      const decision = d?.decision ?? (approvedInFile ? 'approve' : null);
      const badge = m.isNew ? '<span class="tagnew">New</span>' : m.favRating ? `<span class="tagfav">★ ${m.favRating}</span>` : '';
      const meta = metaSpans([m.timeMin && `${m.timeMin} min`, m.cal && `~${m.cal} cal`, m.protein && `${m.protein} g protein`]);
      const date = state.ahead?.dates?.[m.day];
      const [head, side] = dishParts(m.dish);
      html += `<div class="day prop" data-day="${m.day}">
        <div class="prop-top"><span class="dow">${esc(SERV_DAY_NAMES[m.day] ?? m.day)}${date ? ` ${dpart(date).d}` : ''}</span>${badge}</div>
        <div class="daybody">
          <h3>${keepHyphens(head)}</h3>${side ? `<p class="with">${esc(side)}</p>` : ''}
          ${meta ? `<div class="meta">${m.timeMin ? ico('clock') : ''}${meta}</div>` : ''}
          ${p.whys[m.day] ? `<p class="why">${esc(p.whys[m.day])}</p>` : ''}
          ${servingsHtml(m, aheadServings(m), 'plan')}
          ${m.recipeFile ? `<a href="#" data-recipe="${esc(m.recipeFile)}">Recipe${ico('arrow')}</a>` : ''}
          <div class="decide">
            <button data-dec="approve" class="${decision === 'approve' ? 'on-approve' : ''}">${ico('check')}Keep</button>
            <button data-dec="reject" class="${decision === 'reject' ? 'on-reject' : ''}">${ico('x')}No</button>
            <button data-dec="swap" class="${decision === 'swap' ? 'on-swap' : ''}">${ico('swap')}Swap</button>
          </div>
          <div class="dnote" hidden>
            <textarea class="plain" placeholder=""></textarea>
            <button class="ghost" data-act="save-note">Save</button>
          </div>
          ${d?.decision ? `<div class="decidedby">${d.note ? `<q>${esc(d.note)}</q>` : ''}<span class="by">${esc(DEC_WORD[d.decision] ?? d.decision)}${d.by ? ` · ${esc(d.by)}` : ''}<button data-act="clear">Undo</button></span></div>`
        : approvedInFile ? '<div class="decidedby"><span class="by">Kept in an earlier round</span></div>' : ''}
        </div>
      </div>`;
    }
    const wk = fb.weekNote?.text ?? '';
    html += `<div class="card"><h2>Anything else?</h2>
      <textarea class="plain" id="week-note" placeholder="Week-level asks: reshuffle days, more vegetables, a different weekend project…">${esc(wk)}</textarea>
      <button class="ghost" id="btn-weeknote">Save note</button>
      <div class="statusline" id="weeknote-status"></div></div>`;
    // A servings-only entry (stepper, no decision) is neither: lock writes it.
    const hasFeedback = Object.values(fb.meals ?? {}).some((x) => x?.decision) || !!fb.weekNote;
    // something a revise would act on: a rejection, a swap, or a week note
    const actionable = Object.values(fb.meals ?? {}).some((x) => x?.decision && x.decision !== 'approve') || !!fb.weekNote;
    if (undecidedDays.length) {
      const all = undecidedDays.length === approval.length;
      html += `<button class="ghost approveall" id="btn-approve-all">${ico('check')}Approve ${all ? 'all' : `the other ${undecidedDays.length}`}</button>`;
    }
    if (notApproved.length === 0 && !actionable) {
      html += `<div class="approvebar">
        <button class="primary" id="btn-lock" ${runActive() ? 'disabled' : ''}>${ico('lock')}Lock ${esc(weekName(w))} + build the grocery list</button></div>`;
    } else if (hasFeedback) {
      // Two explicit buttons, no hidden mode. Send and lock = revise → lock in
      // one chain (replacements auto-approved); it needs a decision on every
      // meal, or the lock step would stop.
      const why = undecidedDays.length ? `<span class="sub">decide ${esc(undecidedDays.join(', '))} first</span>` : '';
      html += `<div class="approvebar two">
        <button class="primary outline" id="btn-revise" ${runActive() ? 'disabled' : ''}>Send changes</button>
        <button class="primary" id="btn-send-lock" ${runActive() || undecidedDays.length ? 'disabled' : ''}>${ico('lock')}Send and lock${why}</button>
      </div>`;
    } else {
      html += `<div class="approvebar">
        <button class="primary saffron" id="btn-revise" disabled>Send changes to Claude (mark meals first)</button></div>`;
    }
    if (p.rejected.length) {
      html += `<div class="card"><h2 class="minor">Rejected this round</h2><p class="hint">${p.rejected.map(esc).join('<br>')}</p></div>`;
    }
  } else {
    // locked (or complete) — summary + change requests
    const nights = p.meals.filter((m) => !m.flexible);
    html += `<div class="card"><h2>${esc(weekName(w, 'Rel'))} is locked</h2>
      <ul class="locked">` +
      nights.map((m) => `<li class="lockedrow">
        <span class="lockedday">${m.day}</span>
        <div class="lockedmeal"><span>${m.recipeFile ? `<a href="#" data-recipe="${esc(m.recipeFile)}">${esc(m.dish)}</a>` : esc(m.dish)}${m.isNew ? ' <span class="tagnew">New</span>' : ''}</span>
        ${p.status === 'locked' ? servingsHtml(m, fileServings(m), 'locked') : ''}</div></li>`).join('') +
      `</ul></div>
      <div class="card"><h2>Change something?</h2>
      <p class="hint">The plan is locked so shopping can happen, not because it's rigid — swaps that reuse the list are easy.</p>
      <textarea class="plain" id="revise-note" placeholder="“Swap Tuesday for something lighter”, “push the salmon to Thursday”…"></textarea>
      <button class="primary saffron" id="btn-revise-locked" ${runActive() ? 'disabled' : ''}>Request changes</button></div>`;
  }
  v.innerHTML = html;
  wireServings(v, w, p.meals);

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
  const baa = $('btn-approve-all');
  if (baa) baa.onclick = async () => {
    baa.disabled = true;
    const j = await expectOk(await opost('/api/feedback/approve-all', { week: w }), 'Could not approve.');
    if (j) { state.feedback = j.feedback; renderNext(); renderStrip(); } else baa.disabled = false;
  };
  const br = $('btn-revise');
  if (br) br.onclick = async () => { br.disabled = true;
    const j = await expectOk(await jpost('/api/runs/revise', { week: w }), 'Could not start the revision.');
    if (!j) br.disabled = false; };
  const bsl = $('btn-send-lock');
  if (bsl) bsl.onclick = async () => { bsl.disabled = true;
    const j = await expectOk(await jpost('/api/runs/revise', { week: w, lock: true }), 'Could not start send-and-lock.');
    if (!j) bsl.disabled = false; };
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
