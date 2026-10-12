# Web Push + PWA: wiring guide

**Status (2026-10-11):** routes, boot, the PWA shell, the Settings UI, the share-target receiver, and the sends (`server/notify.ts`, see "Sending" below) are wired. Verified in dry-run only; the first real push to the phone is still to be seen.

## What's here

| File | What it is |
|---|---|
| `server/push.ts` | VAPID keys, subscription store, `sendPush` fan-out, and the `dailyAt` scheduler. Nothing runs on import. |
| `server/push-routes.ts` | `registerPushRoutes(app)`: the five `/api/push` routes below. |
| `server/notify.ts` | The sends: run-done, record-updated, and the two daily notices (see "Sending"). `startNotify()` from boot. |
| `server/share.ts` | `registerShareRoutes(app)`: `POST /share` (the share target), `GET /api/shares`, `DELETE /api/shares/:id`. |
| `public/js/60-settings.js` | Settings → **This phone**: install row, "Notify this phone", per-type toggles, "Stop notifying"; Status → Address. |
| `public/js/90-boot.js` | Registers `/sw.js`, captures `beforeinstallprompt`, handles the `/?shared=<id>` landing. |
| `public/sw.js` | The service worker. It caches nothing (GET passthrough), handles `push` → notification and `notificationclick` → focus/navigate. |
| `public/manifest.json` | The install manifest ("Meal Planner" / "Meals", standalone, cream theme) with an Android `share_target` → `POST /share`. |
| `public/icons/` | `icon.svg` (source), `icon-maskable.svg`, `badge.svg`, plus the rendered `icon-192.png`, `icon-512.png`, `icon-512-maskable.png`, `badge-96.png`. |
| `app/data/vapid.json` | Created on the first `initPush`, with mode 0600. Never delete it: a new key orphans every phone's subscription. |
| `app/data/push.json` | `{ subscriptions: [...] }`, written atomically. |

**HTTPS only.** Service workers and push need a secure origin, so this only works at `https://<mac-hostname>.<tailnet>.ts.net` (Tailscale Serve). The plain-HTTP `:4316` fallback still loads the app, but without install or push. Subscriptions belong to an origin, so a phone has to subscribe from the HTTPS URL.

## Server (wired)

- **Boot** (`index.ts` `boot()`): `await initPush(dataDir)` right after `loadStore()`, log-and-continue. A malformed `vapid.json` leaves push off (`pushReady()` false, every push route answers 503) but the app still boots.
- **Routes** (`push-routes.ts`):

| Route | Gate | Notes |
|---|---|---|
| `GET /api/push/key` | open | `{ publicKey }`, the client's `applicationServerKey` |
| `GET /api/push` | open | `{ ready, subscriptions, labels }`: public records (no keys, no endpoint, just `service`) + `PUSH_TYPE_LABELS` |
| `POST /api/push/subscribe` | open, `allowHit('push', clientIp)` 12/min, attributed via `whoFor` | body `{ subscription, label? }`; upserts by endpoint, so a device keeps its `{ id, types }` |
| `PUT /api/push/:id/types` | open, `allowHit('push-types', …)` 12/min | body `{ types: { tonight: false } }`; strict (400 on unknown type), 404 on unknown id |
| `DELETE /api/push/:id` | passcode | SPEC §9: deletes need the passcode |

- **VAPID contact** (`subject` on every send, resolved once in `initPush`): env `MEALAPP_PUSH_CONTACT` (must be a `mailto:` or `https:` URL; anything else is ignored with a console warning) → `mailto:<git config user.email>` read from the repo → `mailto:mealplanner@localhost`. Push services use it only to reach the sender about abuse or errors.
- **Behind Tailscale Serve** (`https://<mac-hostname>.<tailnet>.ts.net`, `tailscale serve --bg 4316`): `index.ts` sets `trust proxy` to `'loopback'`; `auth.ts` `clientIp(req)` (rate-limit key: the `X-Forwarded-For` client when the hop is local) and `whoFor(req)` (`Tailscale-User-Login` local-part, else `Tailscale-User-Name`, only when the socket peer is loopback; else `tailscaleWho`). A remote peer's forwarded/identity headers are ignored.

## Sending (wired: `server/notify.ts`)

`boot()` calls `startNotify()` after `initPush` and `startAutoFold` (`stopNotify()` is the teardown). Nothing runs on import. The copy is built by pure functions (`runDonePayload`, `recordPayload`, `prepTodayPayload`, `tonightPayload`), unit-tested in the selftest against synthetic state; the I/O around them reads `buildState()` after the event.

| Type | When | Title · body · tap opens | Tag |
|---|---|---|---|
| `run-done` | `onRunDone`, once per user-visible completion: a single run, or a whole chain combined at its last step (or at the step that failed). `fold` and `ask` never send it. | propose: `W43 proposal ready` · `4 meals to decide` · Next. revise: `W43 revised` · summary's first line · Next. lock: `W43 locked` · `Warehouse club 2 items · Supermarket 11` · Shop. review: `W42 closed out` · first line · Week. close-and-plan: `W42 closed out · W43 proposal ready` · the propose body · Next. send-and-lock: `W43 revised and locked` · the lock body · Shop. rescale / shop-adjust: `List updated for W43` · first line · Shop. ideas: `New ideas ready` · `8 dishes to browse` · Recipes. import: `Recipe imported` · the recipe's name · Recipes. Failure: `Run failed: <type> W43` (`Run stopped:` after Stop) · the error's first line, prefixed with the chain steps that finished · that type's tab. | `run-<type>-<week>` (the final or failed step) |
| `record-updated` | after a fold or close-out step that stamped captures, once `foldPublic().last` lands | `In the record ✓✓` · `Sat Coconut-Dill Salmon — 5, noted and 2 more` (the client toast's wording, `foldedLabel` ported) · Week | `record` |
| `prep-today` | daily at `pushPrepTime` (default 08:00) | `Prep today` · unchecked prep tasks due today (the cooking week's, plus the week ahead's "before the week" tasks), each cut to its first sentence, joined ` · `, ≤ 180 chars with `+N more` · Week. Nothing due: no send. | `prep-<date>` |
| `tonight` | daily at `pushTonightTime` (default 16:30) | `Tonight: <dish head>` · `30 min · 4 servings · prep: <unchecked tasks due today, or none>` · Cook. A flexible night, no plan, or a night already rated or marked "Didn't cook": no send. | `tonight-<date>` |

- **Times** are server settings `pushPrepTime` / `pushTonightTime` (`"HH:MM"`, validated; env fallbacks `MEALAPP_PUSH_PREP_TIME` / `MEALAPP_PUSH_TONIGHT_TIME`; in `GET /api/settings`, changed with `PUT /api/settings`; edited in Settings → This phone once the phone is subscribed). **Re-arming:** a 15 s watcher in `notify.ts` compares the effective times with what is armed and re-arms `dailyAt` when they differ (`rearmNotify()`), so a change applies within 15 s with no route hook. `dailyAt` follows the wall clock, so it handles Mac sleep and DST; a slot the Mac slept through fires on wake within 120 minutes, later than that it is skipped.
- **Safety:** every send goes through `deliver()`, which never throws. It skips when `!pushReady()` or when no subscription has that type on, and never sends the same dedupe key twice within 10 minutes. The key is the tag for the daily notices; for event sends it is the tag plus the event (run or chain start, fold stamp), so a second revise five minutes after the first still notifies but a double-fired listener cannot. The `onRunDone` listener does only synchronous bookkeeping and hands off to try/catch'd async work, so nothing reaches run completion. Every outcome is a `[notify]` log line.
- **Dry run:** `MEALAPP_PUSH_DRYRUN=1` logs each would-be payload (`[notify] dry-run <type> → N device(s): {…}`) instead of calling `sendPush`. With it, `MEALAPP_PUSH_DRYRUN_TODAY=YYYY-MM-DD` stands in for today's date in the two daily notices, so they can be exercised on any day.

Pushes with the same `tag` replace each other on the phone (and still buzz, because `sw.js` sets `renotify`): the latest revise of a week replaces the previous one, and a dated tag keeps yesterday's prep notice from being replaced by today's.

## Client (wired)

- `index.html` links `/manifest.json` (theme-color metas unchanged).
- `90-boot.js` registers `/sw.js` on load when `'serviceWorker' in navigator` (failures go to `console.warn` only), holds `beforeinstallprompt` in `installPromptEvt` (declared in `60-settings.js`), and on `/?shared=<id>` strips the param and toasts.
- `60-settings.js` → **This phone**: *Install* ("Installed ✓" in standalone; "Install app" when a prompt was captured; else "In Chrome: ⋮ → Add to Home screen", or "open the https:// address" on plain http). *Notifications*: unsupported/insecure, server-off, and permission-denied each get one line; otherwise "Notify this phone" (`enablePush`: permission first, while the tap still counts; then the key; unsubscribe-and-resubscribe if the existing subscription's key differs; POST with a best-effort label from UA Client Hints, e.g. "Pixel 8a · Chrome"), then the four `PUSH_TYPE_LABELS` toggles (`PUT …/types`) and "Stop notifying" (`DELETE`, passcode, then unsubscribes the browser). The device keeps only its id (`localStorage['mealapp-push-id']`); `loadPushInfo()` reconciles on every sheet open and drops the id if the server no longer has it, so the button comes back. Status → *Address*: https (installable) / http · localhost / http (LAN fallback).
- **No silent re-subscribe at boot** (unlike the original recipe): it would resurrect a device that was stopped from another phone. A pruned or rotated subscription shows "Notify this phone" again the next time the sheet opens.

## Share target (wired)

`POST /share` (busboy 1.6.0, pinned): at most 3 files, 15 MB each, images and PDFs only. That is decided by magic bytes; the extension and declared type must also look like an image or PDF, so `.exe`, renamed binaries, and `.mp4` are refused. Any bad part rejects the whole share (413/415/400): a small HTML page for the share sheet, JSON for `Accept: application/json`. Files go to `app/data/uploads/<yyyymmdd-hhmmss>-<safe-name>`. Records `{ id, at, by, title, text, url, files: [{ path (repo-relative), type, size }] }` go to `app/data/shares.json` (newest first, cap 20; evicted records' files are deleted), then the route **303s to `/?shared=<id>`**. Open, `allowHit('share', clientIp)` 10/min, attributed. `GET /api/shares` → `{ shares }` (open); `DELETE /api/shares/:id` (passcode) removes the record and its files. `import.ts` reuses `loadShares`/`sniff`/`safeName`/`placeFile`/`uploadsDir`.

## Notes

- `sw.js` passes GETs through via `respondWith(fetch())`. If that ever causes trouble, deleting the `fetch` listener gives the same no-cache behavior, and current Chrome no longer requires a fetch handler to install.
- The Claude desktop app's built-in browser pane can't register service workers (every SW script fetch fails with "unknown error"), so verify PWA behavior in real Chrome, e.g. headless Chrome over CDP.
