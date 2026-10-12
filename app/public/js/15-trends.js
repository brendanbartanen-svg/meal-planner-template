// Week tab · Trends card (workstream J). The last 12 locked/complete weeks as
// inline-SVG small multiples on one shared x scale: calories and protein per
// serving over the dinners actually cooked, nights cooked vs planned, average
// rating, and a protein-lane dot matrix. Numbers come from GET /api/trends
// (server/trends.ts) — the same ones the close-out prompt gets.
//
// renderWeek() inlines trendsCardHtml() and calls wireTrends(v) after every
// render. The payload is cached here, so a WS-driven re-render repaints from
// memory (no flicker, no refetch); it refetches when the cooking week's log
// changes or the copy is >2 min old. Tap / hover / arrow keys pick a week:
// a hairline marks it in every panel and the panel readouts show its values
// (the readouts and the "Numbers by week" table carry every value, so nothing
// is hover-only). Colors are the app tokens only, so dark mode follows.

let trendsData = null;   // last /api/trends payload
let trendsKey = '';      // state key at the last fetch
let trendsAt = 0;        // last fetch attempt (ms)
let trendsBusy = false;
let trendsErr = false;   // last fetch failed and there is no cached copy
let trendsSel = null;    // selected week id (null = latest logged week)
let trendsW = 0;         // plot width in px = the SVG viewBox width (1 unit = 1 px)
let trendsOpen = false;  // "Numbers by week" details open
let trendsRO = null;
const TRENDS_TTL = 120000;
const TR_GL = 50;        // left gutter: y ticks + lane labels
const TR_GR = 8;
const TR_PH = 52;        // plot height of a line/dot panel
const TR_LANES = ['chicken', 'fish', 'plant', 'red', 'other'];
const TR_LANE_LABEL = { chicken: 'chicken', fish: 'fish', plant: 'plant', red: 'red meat', other: 'other' };

// Weeks are named by their dates (each trends week carries start/end), plus
// "this week" / "last week" when state.weeks knows the id — never by id.
const trStart = (w) => fmtDay(w.start); // "Oct 10": a week's short name in labels and the table
const trRel = (w) => (state?.weeks?.[w.week]?.rel ? weekName(w.week) : '');
const trF = (n) => Math.round(n * 10) / 10;
function trRange(a, b) {
  const pa = dpart(a), pb = dpart(b);
  return pa.m === pb.m ? `${MONTHS[pa.m - 1]} ${pa.d}–${pb.d}` : `${MONTHS[pa.m - 1]} ${pa.d}–${MONTHS[pb.m - 1]} ${pb.d}`;
}
const trLogged = (w) => w.cooked + w.skipped > 0;

function trendsStateKey() {
  const c = state && state.cooking;
  return c ? `${c.week}|${c.plan.status}|${JSON.stringify(c.plan.log)}` : 'none';
}

function trendsCardHtml() {
  const inner = trendsData ? trendsBodyHtml(trendsData, trendsW || 320)
    : `<p class="tr-empty">${trendsErr ? 'Trends are unavailable right now.' : 'Loading trends…'}</p>`;
  return `<section class="card trends" id="trends-card" aria-labelledby="trends-h">
    <div class="tr-head"><h2 id="trends-h">Trends</h2><span class="tr-sub">last 12 weeks</span></div>
    <div class="tr-body" id="trends-body">${inner}</div>
  </section>`;
}

function wireTrends(root) {
  const body = root && root.querySelector('#trends-body');
  if (!body) return;
  const w = Math.round(body.clientWidth);
  if (w > 0 && trendsData && Math.abs(w - (trendsW || 320)) > 1) { trendsW = w; trendsPaint(body); }
  if (w > 0) trendsW = w;
  trendsWireBody(body);
  trendsObserve(body);
  const key = trendsStateKey();
  if (!trendsData || key !== trendsKey || Date.now() - trendsAt > TRENDS_TTL) void trendsFetch(key);
}

async function trendsFetch(key) {
  if (trendsBusy) return;
  trendsBusy = true;
  trendsAt = Date.now();
  trendsKey = key;
  try {
    const r = await fetch('/api/trends?weeks=12');
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    const j = await r.json();
    const changed = JSON.stringify(j) !== JSON.stringify(trendsData);
    trendsData = j;
    trendsErr = false;
    const b = $('trends-body');
    if (b && changed) trendsPaint(b);
  } catch {
    if (!trendsData) {
      trendsErr = true;
      const b = $('trends-body');
      if (b) b.innerHTML = '<p class="tr-empty">Trends are unavailable right now.</p>';
    }
  } finally { trendsBusy = false; }
}

function trendsPaint(body) {
  if (body.clientWidth > 0) trendsW = Math.round(body.clientWidth);
  body.innerHTML = trendsBodyHtml(trendsData, trendsW || 320);
}

// The plot width tracks the card (rotation, desktop resize, or the Week view
// first becoming visible after a boot on another tab).
function trendsObserve(body) {
  if (typeof ResizeObserver === 'undefined') return;
  if (!trendsRO) {
    trendsRO = new ResizeObserver((entries) => {
      for (const e of entries) {
        const w = Math.round(e.contentRect.width);
        if (w > 0 && trendsData && e.target.isConnected && Math.abs(w - trendsW) > 1) { trendsW = w; trendsPaint(e.target); }
      }
    });
  }
  trendsRO.disconnect();
  trendsRO.observe(body);
}

function trSelIndex(weeks) {
  const i = trendsSel ? weeks.findIndex((w) => w.week === trendsSel) : -1;
  if (i >= 0) return i;
  for (let k = weeks.length - 1; k >= 0; k--) if (!weeks[k].inProgress && trLogged(weeks[k])) return k;
  return weeks.length - 1;
}

function trendsSelect(i) {
  const weeks = trendsData && trendsData.weeks;
  if (!weeks || !weeks[i]) return;
  if (weeks[trSelIndex(weeks)].week === weeks[i].week) return;
  trendsSel = weeks[i].week;
  const body = $('trends-body');
  if (!body) return;
  const sel = body.querySelector('.tr-sel');
  const plots = body.querySelector('.tr-plots');
  if (sel) sel.innerHTML = trSelHtml(weeks, i);
  if (plots) plots.innerHTML = trPlotsHtml(weeks, trendsW || 320, i);
}

function trendsWireBody(body) {
  if (body.dataset.trWired) return;
  body.dataset.trWired = '1';
  const pick = (ev) => {
    const plots = ev.target.closest && ev.target.closest('.tr-plots');
    const weeks = trendsData && trendsData.weeks;
    if (!plots || !weeks || !weeks.length) return;
    const rect = plots.getBoundingClientRect();
    if (!rect.width) return;
    const W = trendsW || 320;
    const x = (ev.clientX - rect.left) * (W / rect.width);
    const band = (W - TR_GL - TR_GR) / weeks.length;
    trendsSelect(Math.max(0, Math.min(weeks.length - 1, Math.floor((x - TR_GL) / band))));
  };
  body.addEventListener('pointerdown', pick);
  body.addEventListener('pointermove', (ev) => { if (ev.pointerType === 'mouse' || ev.buttons) pick(ev); });
  body.addEventListener('keydown', (ev) => {
    if (!ev.target.classList || !ev.target.classList.contains('tr-plots') || !trendsData) return;
    const d = ev.key === 'ArrowLeft' ? -1 : ev.key === 'ArrowRight' ? 1 : 0;
    if (!d) return;
    ev.preventDefault();
    trendsSelect(trSelIndex(trendsData.weeks) + d);
  });
  body.addEventListener('toggle', (ev) => {
    if (ev.target.classList && ev.target.classList.contains('tr-more')) trendsOpen = ev.target.open;
  }, true); // toggle doesn't bubble
}

// ---------- rendering ----------

function trendsBodyHtml(d, W) {
  const weeks = (d && d.weeks) || [];
  if (weeks.length < 2 || weeks.filter(trLogged).length < 2) {
    return '<p class="tr-empty">Trends fill in once two weeks have logged dinners.</p>';
  }
  const si = trSelIndex(weeks);
  return `<p class="tr-sum">${esc(d.summary || '')}</p>
    <div class="tr-sel">${trSelHtml(weeks, si)}</div>
    <div class="tr-plots" tabindex="0" role="group"
      aria-label="Weekly trend charts. Use the left and right arrow keys to pick a week; the readouts above each chart show its values.">${trPlotsHtml(weeks, W, si)}</div>
    <details class="tr-more"${trendsOpen ? ' open' : ''}><summary>Numbers by week</summary>${trTableHtml(weeks)}</details>`;
}

function trSelHtml(weeks, si) {
  const w = weeks[si];
  const bits = [trRel(w), w.inProgress ? 'in progress' : ''].filter(Boolean);
  return `<span><b>${esc(trRange(w.start, w.end))}</b>${bits.length ? ` · ${esc(bits.join(' · '))}` : ''}</span>
    <span class="tr-hint">tap a week</span>`;
}

const trSvg = (W, H, label, inner) =>
  `<svg viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(label)}">${inner}</svg>`;

function trGeom(n, W) {
  const band = (W - TR_GL - TR_GR) / n;
  return { band, X: (i) => TR_GL + band * (i + 0.5) };
}

const trCross = (x, H) => `<line class="tr-cross" x1="${trF(x)}" x2="${trF(x)}" y1="1" y2="${H - 1}"/>`;
const trGrid = (W, y, label) =>
  `<line class="tr-grid" x1="${TR_GL}" x2="${W - TR_GR}" y1="${trF(y)}" y2="${trF(y)}"/>`
  + `<text class="tr-tick" x="${TR_GL - 6}" y="${trF(y + 3.5)}" text-anchor="end">${esc(label)}</text>`;

function trPanelHead(title, value) {
  return `<div class="tr-ph"><span class="tr-pt">${esc(title)}</span><span class="tr-pv">${esc(value)}</span></div>`;
}

// One measure per week on its own y range (no dual axes): hairlines at the
// rounded min/max, a 2px line broken at weeks with no number, dots with a
// surface ring. The in-progress week's mark and the segment into it fade.
function trLinePanel(weeks, W, si, opt) {
  const n = weeks.length;
  const { X } = trGeom(n, W);
  const H = TR_PH, top = 7, bot = H - 7;
  const vals = weeks.map(opt.get);
  const known = vals.filter((v) => v !== null);
  let lo = opt.min, hi = opt.max;
  if (lo === undefined) {
    lo = known.length ? Math.floor(Math.min(...known) / opt.step) * opt.step : 0;
    hi = known.length ? Math.ceil(Math.max(...known) / opt.step) * opt.step : opt.step * 2;
    while (hi - lo < opt.minSpan) { lo = Math.max(0, lo - opt.step); hi += opt.step; }
  }
  const Y = (v) => bot - ((v - lo) / (hi - lo)) * (bot - top);
  let s = (opt.ticks || [lo, hi]).map((t) => trGrid(W, Y(t), String(t))).join('');
  s += trCross(X(si), H);
  if (opt.line) {
    let run = '';
    const flush = () => { if (run.includes('L')) s += `<path class="tr-line" d="${run}"/>`; run = ''; };
    for (let i = 0; i < n; i++) {
      const v = vals[i];
      if (v === null) { flush(); continue; }
      const prevOk = i > 0 && vals[i - 1] !== null;
      if (weeks[i].inProgress && prevOk) {
        s += `<line class="tr-line tr-ip" x1="${trF(X(i - 1))}" y1="${trF(Y(vals[i - 1]))}" x2="${trF(X(i))}" y2="${trF(Y(v))}"/>`;
        flush();
        continue;
      }
      run += `${run ? 'L' : 'M'}${trF(X(i))} ${trF(Y(v))}`;
    }
    flush();
  }
  let lastKnown = -1;
  vals.forEach((v, i) => { if (v !== null) lastKnown = i; });
  vals.forEach((v, i) => {
    if (v === null) return;
    const isolated = (i === 0 || vals[i - 1] === null) && (i === n - 1 || vals[i + 1] === null);
    if (!(opt.dots === 'all' || isolated || i === si || i === lastKnown)) return;
    const cls = `tr-dot${opt.dotCls ? ` ${opt.dotCls}` : ''}${weeks[i].inProgress ? ' tr-ip' : ''}`;
    s += `<circle class="${cls}" cx="${trF(X(i))}" cy="${trF(Y(v))}" r="${i === si ? 5 : 4}"/>`;
  });
  const label = `${opt.title}, by week starting: ${weeks.map((w, i) => `${trStart(w)} ${vals[i] === null ? 'no data' : opt.fmt(vals[i])}`).join(', ')}`;
  const sv = vals[si];
  return trPanelHead(opt.title, sv === null ? '—' : opt.fmt(sv)) + trSvg(W, H, label, s);
}

// Unit dots per week, bottom up: cooked (filled), skipped (ring), not logged
// (faint). A 10px pitch leaves the 2px surface gap between 8px dots.
function trNightsPanel(weeks, W, si) {
  const n = weeks.length;
  const { X } = trGeom(n, W);
  const totals = weeks.map((w) => Math.max(w.planned, w.cooked + w.skipped + w.unlogged));
  const maxT = Math.max(4, ...totals);
  const H = Math.max(TR_PH, maxT * 10 + 6);
  let s = trCross(X(si), H);
  weeks.forEach((w, i) => {
    const kinds = [];
    for (let k = 0; k < w.cooked; k++) kinds.push('c');
    for (let k = 0; k < w.skipped; k++) kinds.push('s');
    while (kinds.length < totals[i]) kinds.push('u');
    kinds.forEach((kind, k) => {
      const cy = trF(H - 3 - 10 * (k + 0.5));
      s += kind === 's'
        ? `<circle class="tr-s" cx="${trF(X(i))}" cy="${cy}" r="3.25"/>`
        : `<circle class="${kind === 'c' ? 'tr-c' : 'tr-u'}" cx="${trF(X(i))}" cy="${cy}" r="4"/>`;
    });
  });
  const w = weeks[si];
  const extra = [w.skipped && `${w.skipped} skipped`, w.unlogged && `${w.unlogged} ${w.inProgress ? 'to go' : 'not logged'}`]
    .filter(Boolean).join(', ');
  const value = `${w.cooked} of ${w.planned}${extra ? ` · ${extra}` : ''}`;
  const label = `Nights cooked of planned, by week starting: ${weeks.map((x) => `${trStart(x)} ${x.cooked} of ${x.planned}${x.skipped ? `, ${x.skipped} skipped` : ''}${x.unlogged ? `, ${x.unlogged} not logged` : ''}`).join('; ')}`;
  return trPanelHead('Nights cooked', value) + trSvg(W, H, label, s);
}

// Protein lanes: one row per lane, a dot per cooked dinner (a numeral past 3).
// Identity is the row, not a hue — the app palette has no four colors that
// pass the colorblind checks side by side, and position needs none.
function trLanesPanel(weeks, W, si) {
  const n = weeks.length;
  const { X } = trGeom(n, W);
  const rows = TR_LANES.filter((l) => l !== 'other' || weeks.some((w) => w.lanes.other > 0));
  const RH = 14;
  const H = rows.length * RH + 2;
  let s = trCross(X(si), H);
  rows.forEach((lane, j) => {
    const cy = 1 + RH * (j + 0.5);
    s += `<text class="tr-tick" x="${TR_GL - 6}" y="${trF(cy + 3.5)}" text-anchor="end">${esc(TR_LANE_LABEL[lane])}</text>`;
    weeks.forEach((w, i) => {
      const c = w.lanes[lane] || 0;
      if (c > 3) { s += `<text class="tr-tick tr-num" x="${trF(X(i))}" y="${trF(cy + 3.5)}" text-anchor="middle">${c}</text>`; return; }
      for (let k = 0; k < c; k++) s += `<circle class="tr-ld" cx="${trF(X(i) + (k - (c - 1) / 2) * 6)}" cy="${trF(cy)}" r="2.25"/>`;
    });
  });
  const w = weeks[si];
  const mix = rows.filter((l) => w.lanes[l]).map((l) => `${TR_LANE_LABEL[l]} ${w.lanes[l]}`).join(' · ') || 'none cooked';
  const label = `Protein lanes, dinners cooked by week starting: ${weeks.map((x) => `${trStart(x)} ${rows.filter((l) => x.lanes[l]).map((l) => `${TR_LANE_LABEL[l]} ${x.lanes[l]}`).join(', ') || 'none'}`).join('; ')}`;
  return trPanelHead('Protein lanes', mix) + trSvg(W, H, label, s);
}

// The x-axis is a calendar strip: each week's first day-of-month under its
// band, and on a second line the month's name under the first labeled week
// of each month ("5 12 19 26 3 10" over "Sep … Oct"). Thins to every other
// (or third) week only when a band is too narrow for two digits.
function trAxis(weeks, W, si) {
  const n = weeks.length;
  const { band, X } = trGeom(n, W);
  const every = band >= 16 ? 1 : band >= 9 ? 2 : 3;
  let s = '';
  const months = []; // [x, name] where the month changes
  let lastM = null;
  weeks.forEach((w, i) => {
    if ((n - 1 - i) % every) return;
    const p = dpart(w.start);
    s += `<text class="tr-tick${i === si ? ' tr-on' : ''}" x="${trF(X(i))}" y="11" text-anchor="middle">${p.d}</text>`;
    if (p.m !== lastM) { months.push([X(i), MONTHS[p.m - 1]]); lastM = p.m; }
  });
  // a month that only covers the first labeled week would crowd the next name: drop it
  months.forEach(([x, name], k) => {
    if (months[k + 1] && months[k + 1][0] - x < 26) return;
    s += `<text class="tr-tick" x="${trF(x)}" y="25" text-anchor="middle">${name}</text>`;
  });
  return `<svg class="tr-axis" viewBox="0 0 ${W} 29" width="${W}" height="29" aria-hidden="true">${s}</svg>`;
}

function trPlotsHtml(weeks, W, si) {
  const ip = weeks.find((w) => w.inProgress);
  const sw = (cls, r) => `<svg viewBox="0 0 10 10" aria-hidden="true"><circle class="${cls}" cx="5" cy="5" r="${r}"/></svg>`;
  const totals = TR_LANES.map((l) => [l, weeks.reduce((a, w) => a + (w.lanes[l] || 0), 0)]).filter(([, c]) => c);
  return trLinePanel(weeks, W, si, {
      title: 'Calories / serving', get: (w) => (w.avg && w.avg.calories != null ? w.avg.calories : null),
      step: 100, minSpan: 200, line: true, dots: 'all', fmt: (v) => String(Math.round(v)),
    })
    + trLinePanel(weeks, W, si, {
      title: 'Protein / serving', get: (w) => (w.avg && w.avg.protein_g != null ? w.avg.protein_g : null),
      step: 10, minSpan: 20, line: true, dots: 'sparse', fmt: (v) => `${Math.round(v)} g`,
    })
    + trNightsPanel(weeks, W, si)
    + trLinePanel(weeks, W, si, {
      title: 'Average rating', get: (w) => w.avgRating, min: 1, max: 5, ticks: [1, 3, 5],
      line: false, dots: 'all', dotCls: 'tr-r', fmt: (v) => `${v.toFixed(1)} of 5`,
    })
    + trLanesPanel(weeks, W, si)
    + trAxis(weeks, W, si)
    + `<div class="tr-legend">
        <span>${sw('tr-c', 4)}cooked</span><span>${sw('tr-s', 3.25)}skipped</span><span>${sw('tr-u', 4)}not logged</span>
        ${ip ? `<span>${esc(trRel(ip) ? weekName(ip.week, 'Rel') : `Week of ${trStart(ip)}`)} in progress (faded)</span>` : ''}
      </div>`
    + (totals.length ? `<p class="tr-foot">${esc(weeks.length)} weeks: ${totals.map(([l, c]) => `${esc(TR_LANE_LABEL[l])} ${c}`).join(' · ')}</p>` : '');
}

// The table twin: every charted value, newest week first.
function trTableHtml(weeks) {
  const num = (v) => (v === null || v === undefined ? '—' : String(Math.round(v)));
  const abbr = { chicken: 'C', fish: 'F', plant: 'P', red: 'R', other: 'O' };
  const rows = weeks.slice().reverse().map((w) => {
    const a = w.avg || {};
    const lanes = TR_LANES.filter((l) => w.lanes[l]).map((l) => `${abbr[l]}${w.lanes[l]}`).join(' ') || '—';
    return `<tr><th scope="row">${esc(trStart(w))}${w.inProgress ? '*' : ''}</th>
      <td>${w.cooked}/${w.planned}</td><td>${num(a.calories)}</td><td>${num(a.protein_g)}</td><td>${num(a.carbs_g)}</td>
      <td>${num(a.fat_g)}</td><td>${num(a.fiber_g)}</td><td>${w.avgRating === null ? '—' : w.avgRating.toFixed(1)}</td><td>${esc(lanes)}</td></tr>`;
  }).join('');
  return `<div class="tr-tablewrap"><table class="tr-table">
    <caption>Per serving, averaged over the dinners cooked (recipe nutrition, else the plan's estimate). Lanes: C chicken · F fish · P plant · R red meat · O other.${weeks.some((w) => w.inProgress) ? ' * in progress.' : ''}</caption>
    <thead><tr><th scope="col">Week of</th><th scope="col">Cooked</th><th scope="col">Cal</th><th scope="col">Prot g</th><th scope="col">Carb g</th><th scope="col">Fat g</th><th scope="col">Fiber g</th><th scope="col">Rating</th><th scope="col">Lanes</th></tr></thead>
    <tbody>${rows}</tbody></table></div>`;
}
