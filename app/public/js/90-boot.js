/* 90-boot.js — runs last: view-state restore, tab wiring, PWA hooks, boot.
   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
*/
'use strict';

/* ---------- view-state restore (after the first state load) ---------- */
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

/* ---------- tab wiring ---------- */
for (const t of TABS) $(`tab-${t}`).onclick = () => showTab(t);

/* ---------- PWA: service worker, install prompt, share landing ----------
   sw.js exists for install + push only (it caches nothing). It needs a secure
   context — the Tailscale https:// address, or localhost — so the plain-http
   LAN fallback simply skips it. */
if ('serviceWorker' in navigator) {
  const registerSW = () => navigator.serviceWorker.register('/sw.js')
    .catch((e) => console.warn('[sw] registration failed:', e));
  if (document.readyState === 'complete') registerSW(); else addEventListener('load', registerSW);
}
// Hold Chrome's install prompt for Settings → This phone → Install app.
addEventListener('beforeinstallprompt', (e) => {
  e.preventDefault();
  installPromptEvt = e;
  if (settingsOpen()) renderSettings();
});
addEventListener('appinstalled', () => {
  installPromptEvt = null;
  if (settingsOpen()) renderSettings();
});
// POST /share (the manifest's share_target) 303s here as /?shared=<id>:
// acknowledge once, then drop the param so a reload doesn't repeat it.
{
  const qs = new URLSearchParams(location.search);
  if (qs.has('shared')) {
    qs.delete('shared');
    const rest = qs.toString();
    history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    toast('Shared item received — open Recipes → Add a recipe to import it');
  }
}

/* ---------- boot ---------- */
showTab(tab);
connectWS();
void refetchState();
