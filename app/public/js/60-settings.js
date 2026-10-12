/* 60-settings.js — the gear / settings sheet.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- SETTINGS (gear sheet) ----------
   Server settings (models, effort, auto-fold) live in app/data/settings.json
   via GET/PUT /api/settings and apply to the next run — never an in-flight
   one. "This device" rows are localStorage/sessionStorage only. The sheet's
   open state deliberately doesn't survive a reload. */
let settingsData = null;
let settingsReturnFocus = null;
const settingsOpen = () => !$('settings').hidden;
// Chrome's beforeinstallprompt, captured by 90-boot.js for "This phone → Install".
let installPromptEvt = null;

const RUN_LABELS = { propose: 'Propose', revise: 'Revise', lock: 'Lock', fold: 'Fold', 'shop-adjust': 'Shop tweak', review: 'Close out',
  rescale: 'Rescale', move: 'Move', ideas: 'Ideas', import: 'Import', ask: 'Ask Claude' };
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
    const sys = (m.getAttribute('media') || '').includes('dark') ? '#1D1A17' : '#F4EDE1';
    m.content = t === 'dark' ? '#1D1A17' : t === 'light' ? '#F4EDE1' : sys;
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
  void loadPushInfo();
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

async function putSettings(patch, okMsg = 'Saved — applies from the next run.') {
  const r = await authedFetch('/api/settings', {
    method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch),
  });
  const j = await expectOk(r, 'Could not save that setting.');
  if (j) {
    settingsData = j;
    toast(okMsg);
    if (state && 'autoFold' in patch) { state.autoFold = j.values.autoFold; renderStrip(); }
  }
  renderSettings(); // success shows the new value; failure snaps the control back
  return j;
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
  rows.push(['Address', location.protocol === 'https:'
    ? '<span class="set-ok">https</span> (installable)'
    : isSecureContext ? 'http · localhost (secure context)' : 'http (LAN fallback) — no install or notifications']);
  rows.push(['Server', `up ${esc(durText(s.uptimeMs))} · since ${esc(stamp(s.startedAt))}`]);
  if (s.run.active) rows.push(['Run', `${esc(RUN_LABELS[s.run.type] || s.run.type)} in progress · ${esc(agoText(now - s.run.startedAt).replace(' ago', ''))}`]);
  rows.push(['Code', s.git ? `<code>${esc(s.git.sha)}</code> ${esc(s.git.subject)}` : 'unknown']);
  rows.push(['Agent SDK', `${esc(s.sdkVersion)} · node ${esc(s.node)}`]);
  rows.push(['Last git pull', s.lastPull
    ? `${s.lastPull.ok ? '<span class="set-ok">ok</span>' : '<span class="set-bad">failed</span>'} · ${esc(agoText(now - s.lastPull.at))}${s.lastPull.ok ? ` · ${esc(s.lastPull.message)}` : ''}`
    : esc(s.lastPullLabel ?? 'not yet')]);
  // Record: the fold state the strip reads (state.fold, fresher than this payload; 00-core.js)
  const f = state?.fold;
  let rec;
  if (f?.pending && f.last && !f.last.ok && !f.nextAt) {
    rec = `<span class="set-bad">last sync failed</span> · ${esc(recordTime(f.last.at))} · ${esc(f.last.message)} · ${f.pending} pending`;
  } else if (f?.pending) {
    rec = `${f.pending} pending · ${f.nextAt ? (f.nextAt <= now ? 'folding now' : `folds at ${esc(clock(f.nextAt))}`)
      : s.autoFold.on ? 'waiting for Done logging' : 'auto-fold off — Sync now from the banner'}`;
  } else if (f?.last) {
    rec = `<span class="set-ok">everything folded</span> · last ${esc(recordTime(f.last.at))}`;
  } else {
    rec = s.pendingCaptures ? `${s.pendingCaptures} pending` : '<span class="set-ok">everything folded</span>';
  }
  rows.push(['Record', rec]);
  const typ = Object.entries(s.typicalMs).filter(([, v]) => v)
    .map(([k, v]) => `${esc(RUN_LABELS[k] || k)} ~${Math.max(1, Math.round(v / 60000))} min`).join(' · ');
  rows.push(['Typical runs', typ || 'no runs recorded yet']);
  html += `<dl class="set-stat">${rows.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
  return html;
}

/* ---------- This phone: install + push notifications ----------
   Push needs a secure origin (the Tailscale https:// address, or localhost);
   the plain-http LAN fallback gets neither install nor push. The server is the
   record of which devices get what (GET /api/push); this device only keeps its
   own subscription id, reconciled against the server whenever the sheet opens. */
const PUSH_ID_KEY = 'mealapp-push-id';
let pushInfo = null;   // GET /api/push: { ready, subscriptions, labels } | { error: true }
let pushBusy = false;  // subscribe / stop in flight

const storedPushId = () => { try { return localStorage.getItem(PUSH_ID_KEY) || ''; } catch { return ''; } };
function setStoredPushId(id) {
  try { if (id) localStorage.setItem(PUSH_ID_KEY, id); else localStorage.removeItem(PUSH_ID_KEY); } catch { /* ignore */ }
}
const isStandalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const pushSupported = () => isSecureContext && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

// This device's server record — only while the browser still grants permission.
function myPushSub() {
  const id = storedPushId();
  if (!id || !pushInfo?.subscriptions || window.Notification?.permission !== 'granted') return null;
  return pushInfo.subscriptions.find((s) => s.id === id) ?? null;
}

async function loadPushInfo() {
  try {
    const r = await fetch('/api/push');
    if (!r.ok) throw new Error(String(r.status));
    pushInfo = await r.json();
    // the server dropped this device (pruned as expired, or stopped from another
    // device) → forget the id so the sheet offers "Notify this phone" again
    const id = storedPushId();
    if (id && !pushInfo.subscriptions.some((s) => s.id === id)) setStoredPushId('');
  } catch {
    if (!pushInfo) pushInfo = { error: true };
  }
  if (settingsOpen()) renderSettings();
}

function b64urlToBytes(s) {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (s.length % 4)) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}
const sameKey = (buf, bytes) => !!buf && buf.byteLength === bytes.length && new Uint8Array(buf).every((v, i) => v === bytes[i]);

// "Pixel 8a · Chrome", best effort. Chrome's reduced UA hides the model ("K"),
// so ask User-Agent Client Hints first.
async function deviceLabel() {
  const ua = navigator.userAgent;
  let model = '';
  try { model = ((await navigator.userAgentData?.getHighEntropyValues?.(['model']))?.model || '').trim(); } catch { /* not offered */ }
  if (!model) {
    const m = /Android [\d.]+; ([^;)]+)\)/.exec(ua);
    const guess = m ? m[1].replace(/\s*Build\/.*$/, '').trim() : '';
    if (guess && guess !== 'K') model = guess;
  }
  if (!model) {
    model = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) ? 'iPad' : /Android/.test(ua) ? 'Android phone'
      : /Macintosh|Mac OS X/.test(ua) ? 'Mac' : /Windows/.test(ua) ? 'Windows PC' : 'This device';
  }
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /Firefox\//.test(ua) ? 'Firefox' : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : '';
  return browser ? `${model} · ${browser}` : model;
}

async function enablePush() {
  if (pushBusy || !pushSupported()) return;
  pushBusy = true;
  renderSettings();
  try {
    // ask first, while the tap still counts as a user gesture
    const perm = await Notification.requestPermission();
    if (perm !== 'granted') {
      toast(perm === 'denied' ? 'Notifications are blocked for this site — allow them in Chrome’s site settings.' : 'Notifications weren’t allowed.');
      return;
    }
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise((_, rej) => setTimeout(() => rej(new Error('The service worker didn’t start — reload and try again.')), 8000)),
    ]);
    const kr = await fetch('/api/push/key');
    const kj = await kr.json().catch(() => ({}));
    if (!kr.ok || !kj.publicKey) throw new Error(kj.error || 'Push is off on the server.');
    const key = b64urlToBytes(kj.publicKey);
    let sub = await reg.pushManager.getSubscription();
    if (sub && !sameKey(sub.options.applicationServerKey, key)) { await sub.unsubscribe(); sub = null; } // server key changed
    if (!sub) sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: key });
    const r = await fetch('/api/push/subscribe', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ subscription: sub.toJSON(), label: await deviceLabel() }),
    });
    const j = await expectOk(r, 'Couldn’t register this phone.');
    if (!j) return;
    setStoredPushId(j.id);
    toast('Notifications are on for this phone.');
    await loadPushInfo();
  } catch (e) {
    console.warn('[push] enable failed:', e);
    toast((e && e.message) || 'Couldn’t turn on notifications.');
  } finally {
    pushBusy = false;
    if (settingsOpen()) renderSettings();
  }
}

async function stopPush() {
  const id = storedPushId();
  if (!id || pushBusy) return;
  pushBusy = true;
  renderSettings();
  try {
    const r = await authedFetch(`/api/push/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (r.status !== 404 && !(await expectOk(r, 'Couldn’t stop notifications.'))) return;
    setStoredPushId('');
    try {
      const reg = await navigator.serviceWorker.getRegistration();
      const sub = await reg?.pushManager.getSubscription();
      await sub?.unsubscribe();
    } catch { /* the server record is gone either way */ }
    toast('This phone won’t get notifications any more.');
    await loadPushInfo();
  } finally {
    pushBusy = false;
    if (settingsOpen()) renderSettings();
  }
}

async function setPushType(type, on) {
  const id = storedPushId();
  if (!id) return;
  try {
    const r = await fetch(`/api/push/${encodeURIComponent(id)}/types`, {
      method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ types: { [type]: on } }),
    });
    if (r.status === 404) {
      setStoredPushId('');
      toast('The server forgot this phone — turn notifications on again.');
      await loadPushInfo();
      return;
    }
    const j = await expectOk(r, 'Couldn’t save that.');
    if (j && pushInfo?.subscriptions) {
      pushInfo.subscriptions = pushInfo.subscriptions.map((s) => (s.id === j.id ? j : s));
      return; // the switch already shows the new value
    }
  } catch { toast('Server unreachable — try again.'); }
  renderSettings(); // failure snaps the switch back
}

async function promptInstall() {
  const evt = installPromptEvt;
  if (!evt) return;
  installPromptEvt = null; // a captured prompt can only be shown once
  try {
    await evt.prompt();
    const { outcome } = await evt.userChoice;
    if (outcome === 'accepted') toast('Installing — look for “Meals” on your home screen.');
  } catch (e) { console.warn('[pwa] install prompt failed:', e); }
  if (settingsOpen()) renderSettings();
}

function phoneHtml() {
  // Install
  let install;
  if (isStandalone()) {
    install = `<div class="set-row set-inline"><span class="lbl">Home-screen app<small>you’re in the installed app</small></span><span class="set-ok">Installed ✓</span></div>`;
  } else if (installPromptEvt) {
    install = `<div class="set-row set-inline"><span class="lbl">Home-screen app<small>opens full-screen with its own icon</small></span><button class="ghost" id="set-install">Install app</button></div>`;
  } else {
    install = `<div class="set-row"><span class="lbl">Home-screen app<small>${isSecureContext
      ? 'In Chrome: ⋮ → Add to Home screen'
      : 'Open the https:// address to install it as an app'}</small></span></div>`;
  }

  // Notifications
  const head = (sub) => `<span class="lbl">Notifications<small>${sub}</small></span>`;
  let notif;
  const mine = myPushSub();
  if (!pushSupported()) {
    notif = `<div class="set-row">${head('Not available here — needs the https:// address.')}</div>`;
  } else if (!pushInfo) {
    notif = `<div class="set-row">${head('checking…')}</div>`;
  } else if (pushInfo.error) {
    notif = `<div class="set-row">${head('Couldn’t check with the server — reopen to retry.')}</div>`;
  } else if (!pushInfo.ready) {
    notif = `<div class="set-row">${head('Push is off on the server (see the Mac’s log).')}</div>`;
  } else if (Notification.permission === 'denied') {
    notif = `<div class="set-row">${head('Blocked for this site — allow notifications in Chrome’s site settings, then reopen this.')}</div>`;
  } else if (!mine) {
    notif = `<div class="set-row">${head('A buzz when a run finishes, when your log reaches the record, when prep is due, and before dinner.')}
      <div class="set-actions"><button class="primary" id="set-push-on" ${pushBusy ? 'disabled' : ''}>${pushBusy ? 'Turning on…' : 'Notify this phone'}</button></div></div>`;
  } else {
    notif = `<div class="set-row">${head(`on for this phone${mine.label ? ` (${esc(mine.label)})` : ''}`)}</div>`
      + Object.entries(pushInfo.labels).map(([t, raw]) => { const label = pushTypeLabel(t, raw); return `<div class="set-row set-inline"><span class="lbl">${esc(label)}</span>
        <span class="switch"><input type="checkbox" data-push-type="${esc(t)}" aria-label="${esc(label)}" ${mine.types[t] ? 'checked' : ''}><span class="track"></span></span></div>`; }).join('')
      + pushTimeRow('pushPrepTime', 'Prep reminder', 'daily, only when prep is due')
      + pushTimeRow('pushTonightTime', 'Tonight’s dinner', 'daily, on cook nights')
      + `<div class="set-row"><div class="set-actions"><button class="ghost" id="set-push-off" ${pushBusy ? 'disabled' : ''}>Stop notifying</button></div></div>`;
  }
  const others = (pushInfo?.subscriptions ?? []).filter((s) => s.id !== mine?.id);
  const othersHtml = others.length
    ? `<p class="set-hint set-foot">Also notified: ${others.map((s) => esc(s.label || s.service) + (s.by ? ` (${esc(s.by)})` : '')).join(' · ')}</p>`
    : '';
  return `<section class="set-sec">
    <h3>This phone</h3>
    ${install}
    ${notif}
    ${othersHtml}
  </section>`;
}

function wirePhone(body) {
  const ins = $('set-install');
  if (ins) ins.onclick = promptInstall;
  const on = $('set-push-on');
  if (on) on.onclick = enablePush;
  const off = $('set-push-off');
  if (off) off.onclick = stopPush;
  body.querySelectorAll('input[data-push-type]').forEach((cb) => {
    cb.onchange = () => { void setPushType(cb.dataset.pushType, cb.checked); };
  });
  // Daily notice times (server settings; notify.ts re-arms within 15 s). Debounced:
  // desktop Chrome fires change per edited segment of a time field.
  body.querySelectorAll('input[data-set-time]').forEach((inp) => {
    let t = null;
    inp.onchange = () => {
      clearTimeout(t);
      t = setTimeout(() => {
        const key = inp.dataset.setTime;
        const v = inp.value;
        if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(v)) { renderSettings(); return; }
        if (v === settingsData?.values?.[key]) return;
        const what = key === 'pushPrepTime' ? 'Prep reminder' : 'Tonight’s dinner';
        void putSettings({ [key]: v === settingsData?.defaults?.[key] ? null : v }, `Saved — ${what} at ${v.replace(/^0/, '')}.`);
      }, 700);
    };
  });
}

// The daily types' labels carry their time ("Prep tasks due today (8:00)");
// show the effective setting instead of the built-in default.
const PUSH_TIME_KEYS = { 'prep-today': 'pushPrepTime', tonight: 'pushTonightTime' };
function pushTypeLabel(type, label) {
  const v = settingsData?.values?.[PUSH_TIME_KEYS[type]];
  return v ? label.replace(/\(\d{1,2}:\d{2}\)/, `(${v.replace(/^0/, '')})`) : label;
}
function pushTimeRow(key, label, hint) {
  const v = settingsData?.values?.[key];
  if (!v) return ''; // a server without the setting (older build): nothing to bind
  const custom = settingsData.stored?.[key] !== undefined;
  const style = `background:${custom ? 'var(--acc-soft)' : 'var(--bg)'};color:var(--ink);border:1px solid ${custom ? 'var(--acc)' : 'var(--line)'};`
    + 'border-radius:10px;padding:7px 8px;font-family:inherit;font-size:15px;flex:0 0 auto';
  return `<div class="set-row set-inline"><span class="lbl">${esc(label)}<small>${esc(hint)}${custom ? '' : ' (default)'}</small></span>
    <input type="time" data-set-time="${esc(key)}" value="${esc(v)}" aria-label="${esc(label)} time" style="${style}"></div>`;
}

function renderSettings() {
  const body = $('settings-body');
  if (!settingsData) { body.innerHTML = '<p class="set-hint">loading…</p>'; return; }
  // a re-render (loadSettings / loadPushInfo landing) must not drop a place search being typed
  const act = document.activeElement;
  const keepQ = act && act.id === 'set-wx-q' ? [act.selectionStart, act.selectionEnd] : null;
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

  ${windowSettingsHtml()}

  ${phoneHtml()}

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
    <div class="set-row"><span class="lbl">Pantry<small>staples, running-low marks, freezer inventory</small></span><div class="set-actions"><button class="ghost" type="button" data-open-pantry aria-haspopup="dialog">Open the pantry</button></div></div>
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
  wirePhone(body);
  wireWindowSettings(body);
  if (keepQ) {
    const q = $('set-wx-q');
    if (q) { q.focus({ preventScroll: true }); try { q.setSelectionRange(keepQ[0], keepQ[1]); } catch { /* type=search */ } }
  }
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
  // openSettingsAt(): scroll to a section once it exists (after the first load)
  if (settingsScrollTo) {
    const target = $(settingsScrollTo);
    if (target) {
      settingsScrollTo = null;
      target.scrollIntoView({ block: 'start' });
    }
  }
}

/* ---------- Kitchen window (05-window.js draws it) ----------
   The place and the unit are server settings (PUT /api/settings, passcode),
   so every device shows the same window; the place comes from GET
   /api/geocode (Open-Meteo, called by the server). "Show the window" is this
   device only (localStorage, 05-window.js). The search state lives here so a
   full re-render of the sheet keeps what's typed and found. */
let wxSearch = { open: false, q: '', results: null, busy: false, error: '' };
let wxSearchT = null;
let wxSearchSeq = 0;
let settingsScrollTo = null;
const WX_SEARCH_IDLE = { open: false, q: '', results: null, busy: false, error: '' };

/** Open the sheet at a section (the window's caption → 'set-window'). */
function openSettingsAt(id) {
  settingsScrollTo = id;
  if (settingsOpen()) renderSettings(); else openSettings();
}

function wxResultsHtml() {
  const s = wxSearch;
  if (s.busy) return '<p class="set-hint wx-status">Searching…</p>';
  if (s.error) return `<p class="set-hint wx-status set-bad">${esc(s.error)}</p>`;
  if (!s.results) return '';
  if (!s.results.length) return `<p class="set-hint wx-status">No place called “${esc(s.q.trim())}”. Try the town’s name on its own.</p>`;
  return `<ul class="wx-results">${s.results.map((r, i) => `<li><button type="button" data-wx-pick="${i}"><b>${esc(r.name)}</b><small>${esc([r.admin1, r.country].filter(Boolean).join(', '))}</small></button></li>`).join('')}</ul>`;
}
function wxRenderResults() {
  const el = $('set-wx-results');
  if (!el) return;
  el.innerHTML = wxResultsHtml();
  el.querySelectorAll('[data-wx-pick]').forEach((b) => { b.onclick = () => { void wxPick(Number(b.dataset.wxPick)); }; });
}

function wxRunSearch() {
  clearTimeout(wxSearchT);
  const query = wxSearch.q.trim();
  const seq = ++wxSearchSeq;
  if (query.length < 2) { Object.assign(wxSearch, { results: null, busy: false, error: '' }); wxRenderResults(); return; }
  Object.assign(wxSearch, { busy: true, error: '' });
  wxRenderResults();
  fetch(`/api/geocode?q=${encodeURIComponent(query)}`)
    .then(async (r) => {
      const j = await r.json().catch(() => ({}));
      if (seq !== wxSearchSeq) return; // a newer search owns the list
      Object.assign(wxSearch, r.ok ? { busy: false, results: j.results ?? [] } : { busy: false, results: null, error: j.error || `Search failed (${r.status}).` });
      wxRenderResults();
    })
    .catch(() => {
      if (seq !== wxSearchSeq) return;
      Object.assign(wxSearch, { busy: false, results: null, error: 'Server unreachable — try again.' });
      wxRenderResults();
    });
}

async function wxPick(i) {
  const r = wxSearch.results?.[i];
  if (!r) return;
  const loc = { name: r.name, lat: r.lat, lon: r.lon, tz: r.tz || '' };
  if (r.admin1) loc.admin1 = r.admin1;
  if (r.country) loc.country = r.country;
  const where = r.admin1 || r.country;
  const ok = await putSettings({ location: loc }, `Saved — the window looks out on ${r.name}${where ? `, ${where}` : ''}.`);
  if (!ok) return; // keep the results for another try
  wxSearch = { ...WX_SEARCH_IDLE };
  renderSettings();
  void refreshWeather(true);
}

function windowSettingsHtml() {
  const d = settingsData;
  const loc = d.values.location;
  const unit = d.values.tempUnit === 'C' ? 'C' : 'F';
  const where = loc ? (loc.admin1 || loc.country || '') : '';
  const searching = !loc || wxSearch.open;
  return `<section class="set-sec" id="set-window">
    <h3>Kitchen window</h3>
    <p class="set-hint">The view over the sink at the top of the Week tab: the real sky, weather and season outside.</p>
    <div class="set-row"><span class="lbl">Location<small>${loc ? 'weather from Open-Meteo, fetched by the Mac for every device' : 'not set — the window shows a clear sky on this device’s clock'}</small></span>
      ${loc ? `<p class="wx-cur"><b>${esc(loc.name)}</b>${where ? `, ${esc(where)}` : ''}${wxSearch.open ? '' : ' · <button type="button" id="set-wx-change">change</button>'}</p>` : ''}
      ${searching ? `<div class="wx-search">
        <div class="formline"><input class="plain" type="search" id="set-wx-q" value="${esc(wxSearch.q)}" placeholder="Town or city" autocomplete="off" autocapitalize="words" spellcheck="false" enterkeyhint="search" aria-label="Search for a town or city"><button class="ghost" type="button" id="set-wx-go">Search</button></div>
        <div id="set-wx-results" aria-live="polite">${wxResultsHtml()}</div>
        ${loc ? '<div class="set-actions"><button class="ghost" type="button" id="set-wx-cancel">Cancel</button><button class="ghost" type="button" id="set-wx-clear">Remove location</button></div>' : ''}
      </div>` : ''}
    </div>
    <div class="set-row"><span class="lbl">Temperatures</span>
      <div class="seg" role="radiogroup" aria-label="Temperature unit">
        ${['F', 'C'].map((u) => `<label><input type="radio" name="set-wx-unit" value="${u}" ${unit === u ? 'checked' : ''}><span>°${u}</span></label>`).join('')}
      </div></div>
    <div class="set-row set-inline"><span class="lbl">Show the window<small>on this device</small></span>
      <span class="switch"><input type="checkbox" id="set-wx-show" aria-label="Show the window" ${windowEnabled() ? 'checked' : ''}><span class="track"></span></span></div>
  </section>`;
}

function wireWindowSettings(body) {
  const q = $('set-wx-q');
  if (q) {
    q.oninput = () => {
      wxSearch.q = q.value;
      clearTimeout(wxSearchT);
      wxSearchT = setTimeout(wxRunSearch, 450);
    };
    q.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); wxRunSearch(); } };
  }
  const go = $('set-wx-go');
  if (go) go.onclick = () => { if (q) wxSearch.q = q.value; wxRunSearch(); };
  wxRenderResults();
  const change = $('set-wx-change');
  if (change) change.onclick = () => { wxSearch = { ...WX_SEARCH_IDLE, open: true }; renderSettings(); $('set-wx-q')?.focus(); };
  const cancel = $('set-wx-cancel');
  if (cancel) cancel.onclick = () => { wxSearchSeq++; wxSearch = { ...WX_SEARCH_IDLE }; renderSettings(); };
  const clear = $('set-wx-clear');
  if (clear) clear.onclick = async () => {
    const ok = await putSettings({ location: null }, 'Location removed — the window shows a clear sky on each device’s clock.');
    if (!ok) return;
    wxSearch = { ...WX_SEARCH_IDLE };
    renderSettings();
    void refreshWeather(true);
  };
  body.querySelectorAll('input[name="set-wx-unit"]').forEach((r) => {
    r.onchange = async () => {
      const v = r.value;
      const ok = await putSettings({ tempUnit: v === settingsData.defaults.tempUnit ? null : v }, `Saved — temperatures in °${v}.`);
      if (ok) void refreshWeather(true);
    };
  });
  const show = $('set-wx-show');
  if (show) show.onchange = () => setWindowEnabled(show.checked);
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
