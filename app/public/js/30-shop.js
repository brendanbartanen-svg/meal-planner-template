/* 30-shop.js — the Shop tab: the live grocery list, extras, shop-adjust.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- SHOP ----------
   Which week's list is live is the server's call (state.shop) — on a Saturday
   the active list belongs to the week being cooked, which locked the night
   before, while `ahead` has already rolled forward. Checkbox keys come baked
   into that plan's items, so they follow the same week automatically.
   Extras are the exception: they're "for the next plan", so they stay keyed to
   aheadWeekId and are consumed by the lock run. */
/** Display-only split of a list line into the item (struck through when
 *  checked) and its note: the first " (…)" aside or " — " clause. Keys and
 *  the stored text are untouched. */
function itemTxt(text) {
  const s = String(text ?? '');
  const i = s.search(/\s(?:\(|[—–]\s)/);
  if (i < 3) return `<span class="t">${esc(s)}</span>`;
  let rest = s.slice(i + 1).trim();
  if (/^[—–]\s/.test(rest)) rest = rest.slice(1).trim();
  else if (rest[0] === '(') {
    let depth = 0;
    let end = -1;
    for (let k = 0; k < rest.length; k++) {
      if (rest[k] === '(') depth++;
      else if (rest[k] === ')' && --depth === 0) { end = k; break; }
    }
    if (end > 0) {
      const after = rest.slice(end + 1).trim().replace(/^[—–·]\s*/, '');
      rest = rest.slice(1, end) + (after ? ` · ${after}` : '');
    }
  }
  return `<span class="t">${esc(s.slice(0, i))}</span>${rest ? `<small>${esc(rest)}</small>` : ''}`;
}

function renderShop() {
  const v = $('view-shop');
  const shop = state.shop ?? { week: state.aheadWeekId, planned: false, grocery: null };
  const g = shop.grocery;
  const w = shop.week;             // the list's week — checkboxes, adjust runs
  const xw = state.aheadWeekId;    // extras' week
  // list-changing runs: a rescale rewrites a meal's grocery lines; a lock (or send-and-lock) builds the list
  let html = resultCard(['shop-adjust', 'rescale', 'lock']);
  html += `<div class="shoptools"><button type="button" class="ghost" data-open-pantry aria-haspopup="dialog">Pantry</button></div>`; // 70-pantry.js wires [data-open-pantry]

  if (!g) {
    html += `<div class="pending"><span class="when">waiting on the plan</span>
      <h2>No list yet for ${esc(shortWeek(w))}</h2>
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
          <span class="box">✓</span><span class="txt">${itemTxt(it.text)}</span><span class="who">${c?.by ? esc(c.by) : ''}</span></label>`;
      }
    }
    html += `</div>`;
  }

  if (g.pantryCheck.length) {
    html += `<div class="store pantrychk"><div class="shead"><h2>Check the pantry</h2><span class="count">before you go</span></div>` +
      g.pantryCheck.map((it) => {
        const c = state.checks[it.key];
        return `<label class="item"><input type="checkbox" data-key="${esc(it.key)}" ${c ? 'checked' : ''}>
          <span class="box">✓</span><span class="txt">${itemTxt(it.text)}</span></label>`;
      }).join('') + `</div>`;
  }
  if (g.bulkNotes.length) {
    html += `<div class="weeknote"><b>Bulk math:</b> ${g.bulkNotes.map(esc).join(' · ')}</div>`;
  }

  // extras
  html += `<div class="store"><div class="shead"><h2>Extras</h2><span class="count">${state.extras.length}</span></div>
    <p class="hint">One-off items for this trip — either of you can add. They join the real list at the next plan update.</p>` +
    state.extras.map((e) => {
      const key = `${xw}:extra:${e.id}`;
      const c = state.checks[key];
      return `<label class="item"><input type="checkbox" data-key="${esc(key)}" ${c ? 'checked' : ''}>
        <span class="box">✓</span><span class="txt"><span class="t">${esc(e.text)}</span>${e.by ? `<small>${esc(e.by)}</small>` : ''}</span>
        <button class="delx" data-del-extra="${esc(e.id)}" aria-label="Remove">✕</button></label>`;
    }).join('') +
    `<div class="formline">
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
