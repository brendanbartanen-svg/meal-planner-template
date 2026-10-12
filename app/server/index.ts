// Meal Planner app server.
// One Express process: static UI, the repo's plans/recipes parsed into
// structured state, capture APIs (ratings, checkboxes, plan feedback), and a
// Claude Agent SDK bridge that runs the weekly workflows inside the repo
// (cwd = repo root, so CLAUDE.md's planning/sync rules bind).
//
// Trust model: every GET is open; capture endpoints are
// open but rate-limited and attributed via tailscale whois; anything that
// spends tokens or destroys state needs the shared passcode. The repo's
// markdown is the only system of record — this server parses it and never
// writes it; agent runs are the only writers.
//
// This file is the composition root only: it wires the modules below into
// one Express + WS server and boots it. It also re-exports the original
// public surface (parsers, week math, option lists, types) so
// scripts/selftest.ts keeps importing from ../server/index.ts.
//   paths.ts   repo/app/data directory anchors
//   weeks.ts   week/date math + the Saturday cutover
//   parse.ts   plan/recipe parsers, keys, filename guards
//   repo.ts    plans/ + recipes/ readers
//   store.ts   app/data JSON state + settings
//   bus.ts     WS broadcast seam
//   auth.ts    passcode gate, rate limits, tailscale whois
//   runs.ts    Claude Agent SDK runs + auto-fold
//   git.ts     pulls, HEAD, SDK version
//   state.ts   /api/state assembly
//   move.ts    moving a dinner to another day: pure eligibility (checkMove) + the move prompt's fills
//   routes.ts  HTTP routes (all but cook)
//   cook.ts    the sous-chef chat route
//   ask.ts     the Ask Claude chat (/api/ask; holds the run lock)
//   push.ts   Web Push: VAPID, subscriptions, sendPush, dailyAt
//   push-routes.ts  /api/push/* routes
//   notify.ts  the push sends: run-done, record-updated, prep-today, tonight
//   share.ts   POST /share (PWA share target) + /api/shares
//   ideas.ts, import.ts, recipes-routes.ts  Recipes tab: Ideas (profile/ideas.md) + Add a recipe
//   trends.ts  pure 12-week trends; trends-routes.ts = GET /api/trends + {{TRENDS}}
//   weather.ts the kitchen window's Open-Meteo client + cache; weather-routes.ts = GET /api/weather, /api/geocode
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { registerAskRoutes } from './ask.ts';
import { setBroadcaster } from './bus.ts';
import { registerCookRoutes } from './cook.ts';
import { bootPull } from './git.ts';
import { startNotify } from './notify.ts';
import { appDir, dataDir, repoRoot } from './paths.ts';
import { registerPantryRoutes } from './pantry-routes.ts';
import { initPush } from './push.ts';
import { registerPushRoutes } from './push-routes.ts';
import { registerRecipesRoutes } from './recipes-routes.ts';
import { registerRoutes } from './routes.ts';
import { startAutoFold } from './runs.ts';
import { registerShareRoutes } from './share.ts';
import { loadStore } from './store.ts';
import { registerTrendsRoutes } from './trends-routes.ts';
import { registerWeatherRoutes } from './weather-routes.ts';

// ---------- public surface (unchanged from the single-file server) ----------
export { EFFORT_OPTIONS, FOLD_QUIET_OPTIONS, MODEL_OPTIONS } from './store.ts';
export {
  addWeeks, DAYS, endOfWeek, humanRange, isoWeekId, mondayOf, prepDueDate, startOfWeek,
  todayUTC, weekDates, weekDays, weekIdForDate,
} from './weeks.ts';
export type { DayName } from './weeks.ts';
export { parsePlan, parseRecipe } from './parse.ts';
export type {
  GroceryItem, GroceryStore, GrocerySection, LogRow, ParsedPlan, PlanMeal, PrepTask, RecipeMeta,
} from './parse.ts';

const PORT = Number(process.env.MEALAPP_PORT || 4316);

// ---------- ws hub ----------

const clients = new Set<WebSocket>();
function broadcast(msg: unknown) {
  const s = JSON.stringify(msg);
  for (const ws of clients) if (ws.readyState === WebSocket.OPEN) ws.send(s);
}
setBroadcaster(broadcast);

// ---------- http ----------

const app = express();
// Tailscale Serve (https://<mac-hostname>.<tailnet>.ts.net) proxies from
// 127.0.0.1: trust X-Forwarded-* only from a loopback hop, so req.ip is the
// phone behind Serve but a remote peer can't spoof it (auth.ts clientIp/whoFor).
app.set('trust proxy', 'loopback');
app.use(express.json());
// no-cache = revalidate every load (ETag 304s keep it cheap); a phone must
// never run yesterday's app.js against today's state shape.
app.use(express.static(path.join(appDir, 'public'), {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
}));

registerRoutes(app);
registerCookRoutes(app);
registerAskRoutes(app);    // /api/ask, /api/ask/last (ask.ts)
registerPushRoutes(app);  // /api/push/* (push-routes.ts)
registerShareRoutes(app);  // POST /share (manifest share_target) + /api/shares
registerRecipesRoutes(app); // /api/ideas, /api/imports, /api/runs/{ideas,import} (recipes-routes.ts)
registerTrendsRoutes(app); // GET /api/trends (trends-routes.ts)
registerWeatherRoutes(app); // GET /api/weather + /api/geocode — the Week tab's kitchen window (weather-routes.ts)
registerPantryRoutes(app); // /api/pantry* — the server's one repo writer: pantry.md via pantry.ts, committed by commit.ts

// ---------- boot ----------

async function boot() {
  await loadStore();
  // A malformed vapid.json leaves push off (routes 503) but the app still boots.
  await initPush(dataDir).catch((e) => console.error('[push] disabled:', e));
  startAutoFold();
  // After initPush + startAutoFold: run-done/record-updated listeners and the
  // two daily notices (stopNotify() is the matching teardown, for tests).
  startNotify();

  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: '/ws' });
  wss.on('connection', (ws) => {
    clients.add(ws);
    ws.on('close', () => clients.delete(ws));
  });

  bootPull();

  server.listen(PORT, () => {
    console.log(`[mealapp] Meal Planner app on http://localhost:${PORT} (repo: ${repoRoot})`);
  });
}

// Importable for selftest without booting the server.
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  void boot();
}
