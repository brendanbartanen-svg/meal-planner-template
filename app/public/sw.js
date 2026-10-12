// Meal Planner service worker — push notifications + installability only.
// Deliberately caches NOTHING: a phone must never run yesterday's app.js
// against today's state shape. Registered at the root (/sw.js) so its scope
// covers the whole app. Push needs a secure origin (the Tailscale HTTPS URL).

// Take over as soon as a new version is installed — no waiting for old tabs.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

// Network passthrough for GETs (no cache, ever). Non-GETs (captures, runs,
// the share-target POST) are left untouched and go straight to the network.
self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  if (req.cache === 'only-if-cached' && req.mode !== 'same-origin') return; // DevTools quirk: fetch() would throw
  event.respondWith(fetch(req));
});

// Server payload: {title, body, url, tag} as JSON (see server/push.ts).
self.addEventListener('push', (event) => {
  let msg = {};
  try { msg = event.data ? event.data.json() : {}; }
  catch { msg = { body: event.data ? event.data.text() : '' }; }
  const title = msg.title || 'Meal Planner';
  const options = {
    body: msg.body || '',
    icon: '/icons/icon-192.png',
    badge: '/icons/badge-96.png', // white-on-transparent; Android uses only its alpha
    data: { url: msg.url || '/' },
  };
  if (msg.tag) {
    options.tag = msg.tag;    // same tag replaces the old notification (e.g. yesterday's "tonight")…
    options.renotify = true;  // …but still buzzes instead of swapping in silently
  }
  event.waitUntil(self.registration.showNotification(title, options));
});

// Tap: focus an open app window and send it to the notification's URL,
// or open a new window if none is open.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL((event.notification.data && event.notification.data.url) || '/', self.location.origin);
  event.waitUntil((async () => {
    if (target.origin !== self.location.origin) return self.clients.openWindow(target.href);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((c) => new URL(c.url).origin === self.location.origin);
    if (!win) return self.clients.openWindow(target.href);
    await win.focus();
    if (win.url === target.href) return;
    try { await win.navigate(target.href); } // only works on windows this SW controls
    catch { await self.clients.openWindow(target.href); }
  })());
});
