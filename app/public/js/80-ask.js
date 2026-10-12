/* 80-ask.js — Ask Claude: a chat reachable from the header on every tab.
   Claude can read the whole repo and change it (recipes, pantry, preferences),
   committing like a run, so the server holds the run lock while it answers:
   the strip shows "Asking Claude", and other runs wait. POST /api/ask
   (passcode, 10/min) streams plain text; after a turn that changed files the
   text ends with a `Changed: a, b` (or server `[changed] a, b`) line and a
   `[git] pushed|committed|uncommitted` line, rendered here as chips under the
   answer (recipe chips open the recipe).
   The sheet is built once on <body>, outside .wrap, so it sits above the tabs
   and survives tab switches and re-renders. The transcript, draft, and
   open/closed state live in sessionStorage (`mealapp-ask`, 40 messages); a
   question whose stream dropped (phone locked, page reloaded) stays `pending`
   and is filled in from GET /api/ask/last when the server finishes it.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

const ASK_KEY = 'mealapp-ask';
const ASK_MAX = 40;
const ASK_MAX_CHARS = 6000;
const ASK_ICON = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 11.5a8.5 8.5 0 0 1-12.4 7.6L3.5 20.5l1.5-4.7A8.5 8.5 0 1 1 21 11.5z"/><path d="M8.5 11.5h.01M12.5 11.5h.01M16.5 11.5h.01"/></svg>';
const ASK_GIT = { pushed: 'pushed', committed: 'committed, not pushed', uncommitted: 'not committed' };
const ASK_SUGGEST = [
  'Out of an ingredient tonight? What can I swap in?',
  'Change a recipe for good (more garlic, less salt…)',
  'Add or remove something in the pantry',
];

let askStreaming = false;
let askLiveTurn = null;     // the turn this tab is streaming right now (not "pending")
let askOwnUntil = 0;        // just finished our own ask: its lock may still show for a moment
let askRecovering = false;
let askBusyMsg = '';        // from a 409, until the run it names is over
let askBusyAt = 0;
let askTick = null;
let askDraftT = null;

/* ---------- transcript (sessionStorage) ---------- */
let askStore = { msgs: [], draft: '', open: false, unread: false };
try {
  const s = JSON.parse(sessionStorage.getItem(ASK_KEY) || 'null');
  if (s && Array.isArray(s.msgs)) {
    askStore = { msgs: s.msgs.filter((m) => m && typeof m.text === 'string').slice(-ASK_MAX), draft: String(s.draft || ''), open: !!s.open, unread: !!s.unread };
  }
} catch { /* storage blocked or corrupt — start empty */ }
function askSave(patch) {
  Object.assign(askStore, patch);
  askStore.msgs = askStore.msgs.slice(-ASK_MAX);
  try { sessionStorage.setItem(ASK_KEY, JSON.stringify(askStore)); } catch { /* quota — the live chat still works */ }
}
const askLast = () => askStore.msgs[askStore.msgs.length - 1];
const askPending = () => { const l = askLast(); return !!(l && l.role === 'user' && l.pending); };

/* ---------- header button (injected left of the gear) ---------- */
const askBtn = (() => {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'askbtn';
  b.id = 'btn-ask';
  b.setAttribute('aria-label', 'Ask Claude');
  b.setAttribute('aria-haspopup', 'dialog');
  b.setAttribute('aria-controls', 'ask-sheet');
  b.innerHTML = ASK_ICON;
  const head = document.querySelector('header.top');
  head.insertBefore(b, $('btn-settings') || head.firstChild);
  return b;
})();

/* ---------- the sheet (built once) ---------- */
const askSheet = (() => {
  const el = document.createElement('div');
  el.className = 'sheet asksheet';
  el.id = 'ask-sheet';
  el.hidden = true;
  el.innerHTML = `<div class="sheet-backdrop" data-close></div>
    <div class="sheet-panel" role="dialog" aria-modal="true" aria-labelledby="ask-title" aria-describedby="ask-hint">
      <div class="sheet-head">
        <div class="grow"><h2 id="ask-title">Ask Claude</h2>
          <p class="ask-hint" id="ask-hint">Knows every recipe, the pantry, your preferences and the plans. Can change them.</p></div>
        <button class="ghost ask-new" type="button" id="ask-clear" hidden>New chat</button>
        <button class="sheet-x" type="button" aria-label="Close Ask Claude" data-close>✕</button>
      </div>
      <div class="ask-scroll" id="ask-scroll"><div class="ask-msgs" id="ask-msgs"></div></div>
      <p class="ask-busy" id="ask-busy" role="status" hidden></p>
      <form class="ask-pass" id="ask-pass" hidden>
        <label for="ask-pass-in">Asking Claude needs the household passcode (once per device).</label>
        <div class="ask-passrow">
          <input id="ask-pass-in" type="password" autocomplete="current-password" placeholder="Passcode">
          <button class="primary" type="submit">Save</button>
        </div>
      </form>
      <div class="ask-line">
        <textarea id="ask-in" rows="1" maxlength="${ASK_MAX_CHARS}" placeholder="Ask, or ask for a change…" enterkeyhint="send" aria-label="Message Claude"></textarea>
        <button class="primary" type="button" id="ask-send">Send</button>
      </div>
    </div>`;
  document.body.appendChild(el);
  return el;
})();
const askOpen = () => !askSheet.hidden;

/* ---------- light markdown (escaped first) ---------- */
function askInline(s) {
  return s
    .replace(/`([^`\n]+)`/g, '<code>$1</code>')
    .replace(/\*\*([^*\n]+?)\*\*/g, '<b>$1</b>')
    .replace(/(^|[\s(])\*(?!\s)([^*\n]+?)\*(?=[\s).,;:!?]|$)/g, '$1<i>$2</i>');
}
function askMd(text) {
  let html = '';
  let list = null;
  let para = [];
  const flush = () => { if (para.length) { html += `<p>${para.map(askInline).join('<br>')}</p>`; para = []; } };
  const close = () => { if (list) { html += `</${list}>`; list = null; } };
  for (const ln of esc(text).split('\n')) {
    const ul = ln.match(/^\s*[-*•]\s+(.*)$/);
    const ol = ul ? null : ln.match(/^\s*\d+[.)]\s+(.*)$/);
    if (ul || ol) {
      flush();
      const tag = ul ? 'ul' : 'ol';
      if (list !== tag) { close(); html += `<${tag}>`; list = tag; }
      html += `<li>${askInline((ul || ol)[1])}</li>`;
      continue;
    }
    if (!ln.trim()) { flush(); close(); continue; }
    close();
    const h = ln.match(/^\s*#{1,6}\s+(.*)$/); // headers slip through: a bold line
    para.push(h ? `**${h[1]}**` : ln);
  }
  flush();
  close();
  return html;
}

/* The trailer: `Changed: a, b` / `[changed] a, b` and `[git] pushed`. */
function askSplit(text) {
  const keep = [];
  let changed = [];
  let git = null;
  for (const ln of String(text).split('\n')) {
    const g = ln.match(/^\s*\[git\]\s*([a-z]+)\s*$/i);
    if (g) { git = g[1].toLowerCase(); continue; }
    const c = ln.match(/^\s*[*_`]*(?:Changed:|\[changed\])[*_`]*\s*(.*)$/i);
    if (c) {
      const paths = c[1].split(/,\s*/)
        .map((p) => p.replace(/[`*_"“”]/g, '').replace(/[.;]+$/, '').trim())
        .filter((p) => p.includes('/') || /\.[A-Za-z0-9]+$/.test(p));
      if (paths.length) { changed = [...new Set([...changed, ...paths])]; continue; }
    }
    keep.push(ln);
  }
  return { body: keep.join('\n').trim(), changed, git };
}

function askChipsHtml(changed, git) {
  if (!changed.length) return '';
  const chips = changed.map((p) => {
    const m = p.match(/^recipes\/([^/]+\.md)$/);
    return m && m[1] !== 'README.md'
      ? `<button type="button" class="ask-chip" data-recipe="${esc(m[1])}" aria-label="Open ${esc(p)}">${esc(p)}</button>`
      : `<span class="ask-chip">${esc(p)}</span>`;
  }).join('');
  const g = git ? `<span class="ask-git ${esc(git)}">· ${esc(ASK_GIT[git] || git)}</span>` : '';
  return `<div class="ask-changed"><span class="ask-changed-lbl">Changed</span>${chips}${g}</div>`;
}

function askMsgHtml(m) {
  if (m.role === 'user') return `<div class="ask-msg user">${esc(m.text)}</div>`;
  const s = askSplit(m.text);
  return `<div class="ask-msg assistant">${askMd(s.body) || '<p>(no text)</p>'}</div>${askChipsHtml(s.changed, s.git)}`;
}

/* ---------- render ---------- */
function askGrow() {
  const ta = $('ask-in');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 132) + 'px';
}
function askScrollEnd() {
  const sc = $('ask-scroll');
  sc.scrollTop = sc.scrollHeight;
}

function renderAsk() {
  if (askStreaming) return; // never yank the DOM out from under a live answer
  const msgs = askStore.msgs;
  let html = msgs.map(askMsgHtml).join('');
  if (askPending() && askLast().turn !== askLiveTurn) {
    const l = askLast();
    html += `<div class="ask-msg assistant thinking">${l.partial ? askMd(askSplit(l.partial).body) : ''}`
      + '<p class="ask-note">Claude is still on this one. The answer appears here when it finishes.</p></div>';
  }
  $('ask-msgs').innerHTML = html || `<div class="ask-empty"><p>Substitutions, recipe changes, pantry updates, questions about past weeks.</p>
    <div class="ask-suggest">${ASK_SUGGEST.map((s) => `<button type="button" class="ghost" data-suggest="${esc(s)}">${esc(s)}</button>`).join('')}</div></div>`;
  $('ask-clear').hidden = !msgs.length;
  paintAskGate();
}

// Mirrors busyLabel in server/runs.ts: "the propose run for next week",
// "the revise → lock chain for next week", "the review → propose chain (this week → next week)".
function askRunLabel(r) {
  if (r.type === 'ask') return 'another Ask Claude answer';
  const ch = r.chain;
  if (ch) {
    const ws = ch.weeks.filter(Boolean);
    const words = ws.every((w) => w === ws[0]) ? (ws[0] ? ` for ${weekName(ws[0])}` : '')
      : ` (${ws.map((w) => weekName(w)).join(' → ')})`;
    return `the ${ch.types.join(' → ')} chain${words}`;
  }
  return `the ${r.type} run${r.week ? ` for ${weekName(r.week)}` : ''}`;
}

// Passcode form, busy line, Send/Stop state. Also runs every second while the
// sheet is open (state.run is kept live by the WS handler in 00-core.js).
function paintAskGate() {
  const needPass = !!state?.passcodeGate && !passcode;
  $('ask-pass').hidden = !needPass;
  const r = state?.run;
  const runOn = !!r?.active && !(r.type === 'ask' && !askStreaming && Date.now() < askOwnUntil);
  if (askBusyMsg && !runOn && Date.now() - askBusyAt > 3000) askBusyMsg = '';
  // our own ask (streaming here, or a pending turn after a reload) is not "busy"
  const busy = askStreaming || askPending() ? '' : runOn ? `Claude is busy with ${askRunLabel(r)} · try after it finishes` : askBusyMsg;
  const bl = $('ask-busy');
  bl.hidden = !busy;
  if (bl.textContent !== busy) bl.textContent = busy;
  const send = $('ask-send');
  if (askStreaming) {
    send.textContent = 'Stop';
    send.classList.add('stop');
    send.disabled = !(runOn && r.type === 'ask');
  } else {
    send.textContent = 'Send';
    send.classList.remove('stop');
    send.disabled = needPass || !!busy || askPending();
  }
  $('ask-clear').disabled = askStreaming || askPending();
  // "thinking…" shows what Claude is reading/editing until text arrives
  const th = $('ask-msgs').querySelector('.ask-msg.thinking.live');
  if (th) {
    const act = /^(Reading|Editing|Writing|Scanning|Searching|Fetching|mock|\$ )/.test(runEventsLatest) ? runEventsLatest : '';
    const t = act ? `thinking… · ${act}` : 'thinking…';
    if (th.textContent !== t) th.textContent = t;
  }
}

/* ---------- open / close ---------- */
function openAskSheet(restoring) {
  if (askOpen()) return;
  askSheet.hidden = false;
  document.body.classList.add('sheet-open');
  document.querySelector('.wrap').inert = true;
  document.querySelector('nav.tabs').inert = true;
  askBtn.classList.remove('unread');
  askSave({ open: true, unread: false });
  if ($('ask-in').value !== askStore.draft && !askStreaming) $('ask-in').value = askStore.draft;
  renderAsk();
  askGrow();
  fitAskSheet();
  askScrollEnd();
  clearInterval(askTick);
  askTick = setInterval(paintAskGate, 1000);
  void askRecover();
  if (!restoring) {
    // empty chat → straight to typing; otherwise read first (no keyboard over the answer)
    if (!askStore.msgs.length && !(state?.passcodeGate && !passcode)) $('ask-in').focus();
    else askSheet.querySelector('.sheet-x').focus();
  }
}
function closeAskSheet(quiet) {
  if (!askOpen()) return;
  askSheet.hidden = true;
  clearInterval(askTick);
  askTick = null;
  // another sheet (sous-chef, settings) may still be open underneath
  const others = [...document.querySelectorAll('.sheet')].some((s) => s !== askSheet && !s.hidden);
  if (!others) {
    document.body.classList.remove('sheet-open');
    document.querySelector('.wrap').inert = false;
    document.querySelector('nav.tabs').inert = false;
  }
  askSave({ open: false });
  if (!quiet) askBtn.focus({ preventScroll: true });
}
askBtn.onclick = () => openAskSheet(false);
askSheet.querySelectorAll('[data-close]').forEach((el) => { el.onclick = () => closeAskSheet(false); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && askOpen()) { e.preventDefault(); closeAskSheet(false); } });

// Android Chrome overlays the keyboard (only the visual viewport shrinks):
// lift the panel by however much of the layout viewport the keyboard covers.
function fitAskSheet() {
  const panel = askSheet.querySelector('.sheet-panel');
  const vv = window.visualViewport;
  if (!vv || !askOpen() || vv.scale > 1.05) { panel.style.removeProperty('--kb'); return; }
  const covered = Math.max(0, Math.round(window.innerHeight - vv.height - vv.offsetTop));
  panel.style.setProperty('--kb', `${covered}px`);
}
window.visualViewport?.addEventListener('resize', fitAskSheet);
window.visualViewport?.addEventListener('scroll', fitAskSheet);

/* ---------- input wiring ---------- */
{
  const ta = $('ask-in');
  ta.value = askStore.draft;
  ta.addEventListener('input', () => {
    askGrow();
    clearTimeout(askDraftT);
    askDraftT = setTimeout(() => askSave({ draft: ta.value }), 400);
  });
  ta.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); if (!askStreaming) void askSend(); }
  });
  $('ask-send').onclick = () => {
    if (!askStreaming) { void askSend(); return; }
    // Stop = the strip's Stop, scoped: only while the active run is this ask
    if (state?.run?.active && state.run.type === 'ask') void jpost('/api/stop').then((r) => expectOk(r, 'Could not stop.'));
  };
  $('ask-clear').onclick = () => {
    if (askStreaming || askPending()) return;
    askSave({ msgs: [] });
    renderAsk();
    ta.focus();
  };
  $('ask-msgs').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-recipe]');
    if (chip) { closeAskSheet(true); void openRecipe(chip.dataset.recipe); return; }
    const sug = e.target.closest('[data-suggest]');
    if (sug) { ta.value = sug.dataset.suggest; askGrow(); askSave({ draft: ta.value }); ta.focus(); }
  });
  $('ask-pass').addEventListener('submit', async (e) => {
    e.preventDefault();
    const inp = $('ask-pass-in');
    const p = inp.value.trim();
    if (!p) return;
    // same check as Settings → Set passcode: an empty PUT still hits the gate
    try {
      const r = await fetch('/api/settings', {
        method: 'PUT', headers: { 'content-type': 'application/json', 'x-mealapp-passcode': p }, body: '{}',
      });
      if (r.status === 401) { toast('That passcode didn’t work.'); return; }
      if (!r.ok) { toast(`Couldn’t check the passcode (${r.status}).`); return; }
    } catch { toast('Server unreachable — try again.'); return; }
    passcode = p;
    try { localStorage.setItem('mealapp-passcode', p); } catch { /* ignore */ }
    inp.value = '';
    toast('Passcode saved on this device.');
    paintAskGate();
    ta.focus();
  });
}

/* ---------- send + stream ---------- */
const askTurnId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 10);

async function askSend() {
  const ta = $('ask-in');
  const q = ta.value.trim().slice(0, ASK_MAX_CHARS);
  if (!q || askPending()) return;
  if (state?.passcodeGate && !passcode) { paintAskGate(); $('ask-pass-in').focus(); return; }
  if (state?.run?.active) { paintAskGate(); return; }
  const before = askStore.msgs;
  const turn = askTurnId();
  const sent = [...before, { role: 'user', text: q, turn, pending: true }].slice(-ASK_MAX);
  askSave({ msgs: sent, draft: '' });
  askLiveTurn = turn;
  ta.value = '';
  askGrow();
  clearTimeout(askDraftT);
  renderAsk();

  const scroller = $('ask-scroll');
  const bubble = document.createElement('div');
  bubble.className = 'ask-msg assistant thinking live';
  bubble.textContent = 'thinking…';
  $('ask-msgs').appendChild(bubble);
  askScrollEnd();
  askStreaming = true;
  paintAskGate();

  // follow the growing answer unless the reader scrolled up
  const nearEnd = () => scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 80;
  let acc = '';
  let accepted = false; // the server took the question (200, streaming)
  let refused = false;  // the server answered with an error status
  let restore = '';
  let raf = 0;
  const paint = () => {
    raf = 0;
    const follow = nearEnd();
    bubble.classList.remove('thinking', 'live');
    bubble.innerHTML = askMd(askSplit(acc).body) || '…';
    if (follow) askScrollEnd();
  };
  try {
    const r = await authedFetch('/api/ask', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ turn, messages: sent.map((m) => ({ role: m.role, text: m.text.slice(0, ASK_MAX_CHARS) })) }),
    });
    if (!r.ok || !r.body) {
      refused = true;
      let j = null; try { j = await r.json(); } catch { /* no body */ }
      if (r.status === 409) {
        askBusyMsg = `Claude is busy with ${(j && j.busy) || 'a run'} · try after it finishes`;
        askBusyAt = Date.now();
        throw Object.assign(new Error(askBusyMsg), { quiet: true });
      }
      throw new Error((j && j.error) || `Claude didn’t answer (${r.status}).`);
    }
    accepted = true;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      acc += dec.decode(value, { stream: true });
      if (!raf) raf = requestAnimationFrame(paint);
    }
    acc = (acc + dec.decode()).trim();
    if (!acc) { refused = true; throw new Error('Empty answer — ask again.'); }
    askSave({ msgs: [...sent.slice(0, -1), { role: 'user', text: q, turn }, { role: 'assistant', text: acc }] });
    if (!askOpen()) { askSave({ unread: true }); askBtn.classList.add('unread'); }
  } catch (err) {
    if (refused) {
      // the server said no (busy, rate limit, error): the question goes back in the box
      if (!err || !err.quiet) toast(err instanceof Error ? err.message : String(err));
      askSave({ msgs: before });
      restore = q;
    } else {
      // The connection dropped (network, phone locked, page reloading) before
      // or during the answer. The server doesn't abort on a dropped client and
      // keeps the full text, so stay pending; askRecover fetches it when it's
      // done, or puts the question back if the server never got it.
      toast('Connection dropped. The answer appears here when Claude finishes.');
      askSave({ msgs: [...sent.slice(0, -1), { role: 'user', text: q, turn, pending: true, partial: acc.trim() }] });
    }
  } finally {
    if (raf) cancelAnimationFrame(raf);
    askStreaming = false;
    askLiveTurn = null;
    if (accepted) askOwnUntil = Date.now() + 4000;
    const atEnd = nearEnd();
    renderAsk();
    if (atEnd) askScrollEnd();
    if (restore) { ta.value = restore; askGrow(); askSave({ draft: restore }); }
    if (askPending()) void askRecover();
  }
}

/* ---------- recovery: a pending question whose stream dropped ---------- */
const askWait = (ms) => new Promise((res) => setTimeout(res, ms));
async function askRecover() {
  if (askStreaming || askRecovering || !askPending()) return;
  askRecovering = true;
  try {
    for (let i = 0; i < 400 && askPending(); i++) { // ~20 min ceiling
      const l = askLast();
      let r = null;
      try { r = await authedFetch(`/api/ask/last?turn=${encodeURIComponent(l.turn || '')}`); } catch { r = null; }
      if (r && (r.status === 404 || r.status === 400)) {
        askFinishPending(l.partial ? `${l.partial}\n\n(The connection dropped and the rest of this answer was lost. Ask again for the rest.)` : null);
        return;
      }
      if (r && r.ok) {
        const j = await r.json().catch(() => null);
        if (j && !j.active) { askFinishPending(j.text || '(Claude came up empty — ask again.)'); return; }
      }
      if (r && r.status === 401) return; // passcode refused; try again on the next open
      await askWait(3000);
    }
  } finally {
    askRecovering = false;
  }
}
function askFinishPending(text) {
  const msgs = askStore.msgs.slice();
  const l = msgs[msgs.length - 1];
  if (!l || !l.pending) return;
  if (text) {
    msgs[msgs.length - 1] = { role: 'user', text: l.text, turn: l.turn };
    msgs.push({ role: 'assistant', text });
  } else {
    msgs.pop(); // nothing recorded: the question goes back in the box
    if (!$('ask-in').value.trim()) { $('ask-in').value = l.text; askSave({ draft: l.text }); askGrow(); }
  }
  askSave({ msgs });
  if (text && !askOpen()) { askSave({ unread: true }); askBtn.classList.add('unread'); }
  if (askOpen()) { renderAsk(); askScrollEnd(); }
}
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') void askRecover(); });

/* ---------- boot ---------- */
if (askStore.unread) askBtn.classList.add('unread');
if (askStore.open) openAskSheet(true); // screen-lock reload: back where they were
else if (askPending()) void askRecover();
