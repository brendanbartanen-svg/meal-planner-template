# Meal Planner App — Architecture overview

A local, always-on web app with the Claude Agent SDK inside it, so the whole weekly loop — propose, approve, lock, shop, log, review — happens from any device's browser. The repo's markdown stays the system of record; the app is a *view + capture layer + run trigger*. Claude agent runs write the repo files, with two small deterministic exceptions (the pantry editor and the starter-recipe import) that the server commits itself.

Operational rules (restart discipline, sync, file formats) live in `CLAUDE.md`. Install steps live in `README.md`. This file explains how the pieces fit.

---

## 1. Goals and non-goals

**Goals**

1. Claude lives *in* the app. Every workflow that would otherwise need a Claude Code session is a button or a chat: propose the week, revise it, lock it + build the grocery list, fold logs into the record, close out the week, import a recipe, change the pantry or a preference.
2. Capture is instant and needs no hand-off: ratings and notes post to the server the moment they're tapped; per-meal approve/reject/swap feedback triggers a revise run and the page re-renders itself when the run finishes.
3. Shared live state where it matters: grocery and prep checkboxes sync over WebSocket, so two people can split up in a store and watch each other's checks land.
4. The repo stays the system of record: `plans/`, `recipes/`, `profile/` markdown, git-synced.
5. A normal Saturday is two waits, not five: the steps that always follow each other are chained.

**Non-goals**

- No third-party calls from the phone: the one outside service (Open-Meteo, for the kitchen window) is reached by the server, and only when a place is saved.
- No public hosting, no accounts. Reachability on the home network (or a private tailnet) is the identity; one shared passcode guards anything that spends tokens or changes the repo.
- No multi-household support, no configurable week start day, no native apps (the PWA covers home-screen install and push).
- Desktop Claude Code sessions keep working via the slash commands — the app is the primary interface, not the only one.

---

## 2. Architecture

- **`app/` directory in the repo.** Express + `@anthropic-ai/claude-agent-sdk` (runs on the machine's Claude Code login — no API key) + `ws` + `marked` + `web-push` + `busboy`, TypeScript via `tsx`, no build step. Vanilla JS frontend (`public/index.html`, `public/js/*.js` loaded in filename order as classic scripts sharing one global scope, `style.css`, self-hosted fonts and an inline SVG icon sprite). The server is a composition root (`server/index.ts`) over small modules: `paths` · `weeks` · `parse` · `repo` · `store` · `bus` · `auth` · `runs` · `git` · `commit` · `state` · `routes` · `cook` · `ask` · `push` + `push-routes` · `notify` · `share` · `ideas` · `import` · `recipes-routes` · `trends` + `trends-routes` · `pantry` + `pantry-routes` · `scale` · `recipe-sections` · `starter`.
- **Agent runs execute with `cwd` = repo root**, `settingSources: ['project']`, and the `claude_code` system-prompt preset with an app-mode append — so CLAUDE.md's planning/sync rules bind automatically.
- **Tool gate**: allow Read/Grep/Glob/WebSearch/WebFetch/Skill/TodoWrite/Task; Edit/Write only inside the repo; Bash only for plain git commands (no shell metacharacters); deny everything else. Granted twice over — as `allowedTools` rules enforced by the CLI, and as a `canUseTool` callback that denies by default.
- **One run at a time** (409 otherwise), in-memory run state + event log, AbortController stop, WS broadcast of run events. The UI shows a pulse + elapsed + "usually ~N min" (median of recent successful runs of *that run type*). Ask Claude takes the same lock while it answers.
- **Persistent app state** in `app/data/` (gitignored, lives only on the host Mac). Survives restarts; run state does not — check `GET /api/run` for `active: false` before restarting.
- **Passcode gate**: every GET is open; mutations split into *capture* (open, rate-limited, attributed via `tailscale whois` when available) and *spend/change* (passcode header, prompted once per device, kept in localStorage). Passcode in `app/data/passcode.txt` or env, read per-request. With no passcode configured the gate is off.
- **Reachability**: the server binds all interfaces on port **4316** (`MEALAPP_PORT`). `http://localhost:4316` on the host; `http://<mac-hostname>.local:4316` on the home network; `http://<mac-hostname>.<tailnet-name>.ts.net:4316` over Tailscale. Optionally `tailscale serve --bg 4316` adds `https://<mac-hostname>.<tailnet-name>.ts.net`: TLS ends in Tailscale, the server trusts `X-Forwarded-*` / `Tailscale-User-*` only from the loopback hop, and that origin is the PWA (home-screen install, Web Push, Android share target).
- **Always-on**: LaunchAgent `com.mealplanner.app` (template + `install.sh` in `app/launchd/`), sources nvm, logs to `~/Library/Logs/meal-planner.log`, auto-restarts on crash. Never `npm start` alongside the agent.
- **Git**: the server does `git pull --ff-only` at boot and throttled before reads, never during a run (the agent owns git then). Agent runs commit + push per CLAUDE.md sync rules; the server's own two writers (§5) commit through `server/commit.ts` under a repo lock, with one `pull --rebase` retry on a rejected push.
- **Env**: `MEALAPP_PORT` (4316), `MEALAPP_MODEL` (plan/review runs), `MEALAPP_LIGHT_MODEL` (fold/adjust/rescale runs), `MEALAPP_COOK_MODEL` (default = light model; the Cook tab's sous-chef chat), `MEALAPP_PASSCODE`, `MEALAPP_AUTOFOLD` (`off` to disable the fold debounce), `MEALAPP_PUSH_CONTACT` (VAPID contact; defaults to git `user.email`), `MEALAPP_PUSH_PREP_TIME` / `MEALAPP_PUSH_TONIGHT_TIME`, `MEALAPP_TEMP_UNIT`. Dev-only: `MEALAPP_MOCK_RUNS`, `MEALAPP_MOCK_MS`, `MEALAPP_MOCK_FAIL`, `MEALAPP_NO_GIT`, `MEALAPP_DATA_DIR`, `MEALAPP_PUSH_DRYRUN`, `MEALAPP_WEATHER_FAKE` (see CLAUDE.md → Dev knobs). Built-in model defaults and the selectable list are in `server/store.ts` (`MODEL_OPTIONS`, `settingDefaults`).
- **Settings panel** (gear in the header): `app/data/settings.json` overrides the env for `planModel`/`lightModel`/`cookModel`, `planEffort`/`lightEffort`/`cookEffort` (absent = model default), `autoFold`, `foldQuietMin` (5/10/15/30/60), `pushPrepTime`, `pushTonightTime`, `location` (the kitchen window's place), `tempUnit` (`F`|`C`). Effective value = settings.json > env > built-in; read at use time, so changes hit the next run/chat (never an in-flight one) with no restart. `GET /api/settings` (open) returns values/stored/defaults/options plus read-only status; `PUT` (passcode, rate-limited) validates strictly, `null` resets a key. The panel also holds the per-phone push toggles.
- **Notifications** (Web Push over the https origin; `server/push.ts`, `server/notify.ts`, `server/push.README.md`): `run-done` once per run or whole chain (never fold/ask), `record-updated` when a fold or close-out puts captures in the record, `prep-today` at `pushPrepTime` (08:00) and `tonight` at `pushTonightTime` (16:30), each sent only when there is something to say. The VAPID key pair is generated once into `app/data/vapid.json`; subscriptions live beside it.

---

## 3. Surfaces — five tabs, two chats

**Week · Cook · Recipes · Next · Shop.** Week/Recipes show the week being *cooked*, Next/Shop show the *week ahead*, and Cook is the at-the-stove view. Header retitles per tab. A thin **status strip** under the header on every tab says where the week stands and the one next action; a round **Ask Claude** button sits left of the gear on every tab.

**View-state persistence:** phones discard backgrounded tabs, so everything needed to rebuild the exact view — active tab, expanded recipe cards, per-tab scroll position, the cook tab's dish and chat transcripts, the Ask Claude transcript — lives in sessionStorage and is restored on boot. A `?tab=` URL param is honored once, then stripped.

### Week (default tab)
- **Kitchen window** above the header: a drawn window showing the real sky, weather, time of day, season and moon for the household's place (`public/js/05-window.js`). Weather comes from Open-Meteo through the server only (`server/weather.ts`, `GET /api/weather`, 10-minute cache, stale-for-3-h fallback, no key); the place is picked in Settings → Kitchen window (`GET /api/geocode?q=`). Without a saved place it runs on the device clock with a clear sky; a per-device toggle hides it.
- **Get started card** (new installs only): three steps with live checkmarks — fill in the profile (a button opens Ask Claude with the interview request typed in), import starter recipes (optional), propose the first week. Driven by `state.setup` (`profileReady`, `pantryReady`, recipe and plan counts, starter availability); hides once the profile is complete and a plan exists, or when dismissed.
- Day cards for the cooking week, parsed from its plan file: dish, servings, active time, cal/protein, NEW/⭐ badge, per-meal rationale, TONIGHT highlight on today's card. The recipe's picture, when it has one: a hero on tonight's card, a small thumb on the others.
- **Prep checkboxes** on the day they're due (parsed from the Prep timeline) — shared state, WS-live.
- **Rating (1–5 stars) + note + "what actually got cooked"** control per day — POSTs immediately (open endpoint). "Didn't cook" with a reason (leftovers, ate out, no time, free text) logs `skipped — reason`; "took about N min" chips feed the recipe's active time at close-out. Shows "recorded ✓ / in the record ✓✓" so it's visible when an entry has reached the markdown (§6).
- **Move a dinner**: on a locked week being cooked, a folded Move toggle on any unlogged cook night offers one chip per target day (a flexible night, or a swap with another unlogged dinner); confirming starts the light `move` run (`server/move.ts` decides eligibility, shipped as `moveTo` per meal).
- **Carry cards**: unlogged days from the previous week render as dashed cards above the week's first day so a stranded final day can still be rated after the flip.
- **Close out the week** (passcode) runs `review`; when next week isn't planned yet the card offers **Close out and plan next week**, a chain that collects cook nights + constraints first (§4).
- **Trends · last 12 weeks** card: SVG small multiples on one shared x scale — calories and protein per serving over cooked dinners, nights cooked vs planned, average rating, a protein-lane dot matrix — plus a one-line summary and a numbers table. `GET /api/trends?weeks=12` (open), computed by pure `server/trends.ts` from Log tables joined to recipe frontmatter; `review` receives the same numbers as `{{TRENDS}}`.
- "‹ past weeks" link → read-only rendered view of any historical plan file.

### Cook
- A dish picker (defaults to tonight's dinner, else the next one coming up this week; explicit picks persist), a **servings stepper** (1–24, defaulting to the plan's servings for that meal), and the recipe rendered in sections: ingredients scaled deterministically to the chosen servings (`server/scale.ts` via `server/recipe-sections.ts`, with a "Scaled ×2 for 8" banner), the `## Prep` mise-en-place checklist, tap-to-mark numbered steps, notes; the recipe's picture as a hero above it when it has one. Screen Wake Lock while a recipe is open (https only).
- The **sous-chef chat** opens as a bottom sheet from a floating button: `POST /api/cook/ask` (passcode, rate-limited 10/min) streams plain text from the cook model with the recipe, `profile/preferences.md`, and `profile/pantry.md` embedded in the prompt, plus the current servings. Read-only tool gate (Read/Grep/Glob inside the repo only), custom system prompt, max 2 concurrent. **Deliberately not a run**: it doesn't touch the run lock, so it works while a fold or lock is in flight.
- Transcripts are per-recipe, client-side (sessionStorage, capped at 40 messages) — the server keeps no chat state; the client sends the whole conversation each turn.

### Recipes
- The full library from `recipes/`: list with a thumbnail of each recipe's picture (when it has one), rating, times cooked, last cooked; sortable (rating / recency / name); tap → rendered recipe. This week's dishes pinned on top.
- Three collapsible cards above the library:
  - **Starter library** — only while `starter-recipes/` holds recipes not yet in `recipes/`. A checklist (name · protein · cuisine · active minutes) and an Import button (passcode): `GET /api/starter`, `POST /api/starter/import {files}`; the server copies the chosen files byte-for-byte into `recipes/` (never overwriting), plus each one's picture from `starter-recipes/images/` into `recipes/images/` (an existing picture is left alone), and commits them (`server/starter.ts`). Also available as `npm run starter -- --all` in `app/`.
  - **Ideas** — `profile/ideas.md`, written by the `ideas` run: batches of eight dishes not in the library, each with a pitch and a "why you" tied to your ratings. **Queue** sends an idea into the next propose (`{{QUEUED_IDEAS}}`); **Not for me** keeps it out of future batches. Decisions live in `app/data/ideas-state.json`.
  - **Add a recipe** — the `import` run from a pasted URL (fetched server-side and reduced to JSON-LD Recipe data or readable text — no model involved in the fetch), a photo/PDF upload (`POST /api/imports/upload`, up to 15 MB), or an Android share to the installed app (manifest `share_target` → `POST /share`). The run writes `recipes/<slug>.md` in house format and a dated "user-supplied recipe" note in Learned preferences; the result card offers Open recipe and **Queue for next week**.

### Next (the planning cockpit)
- Shows next week's plan file state:
  - **No file yet** → "Propose" button (passcode) + a free-text box for constraints ("we're out Wed–Thu", "use the frozen shrimp") passed to the propose run. Refused with a plain message while the profile still has `_fill in_` placeholders.
  - **Status `planning`** → proposal review: each proposed meal as a card with the run's rationale (and the recipe's picture as a thumb when it has one), a **servings stepper** (4 by default, with a live preview of the headline ingredient at that scale), and three controls — **✓ approve**, **✗ reject (reason required)**, **↻ swap request (note)** — plus a week-level free-text change box. All feedback is *captured* instantly (open endpoints). **Send changes** (passcode) fires a `revise` run with the whole feedback bundle; once every meal has a decision, **Send and lock** chains revise → lock, and **Approve all** fills the remaining decisions in one tap.
  - **All approved** → **Lock week + grocery list** button (passcode) fires `lock`.
  - **Status `locked`** → read-only summary + a free-text change box → small revise run; the servings stepper now fires a light `rescale` run that rewrites that meal's grocery lines.

### Shop
- The upcoming week's grocery list parsed from its plan file: one block per store, sections, quantities, the Pantry-check block, bulk notes, and a progress bar. **Checkboxes are shared live state.**
- **"Add item"** free text (open, capture-only): lands in an "Extras" section of the list state immediately — no tokens. Extras are folded into the plan file's list by the next run that touches the plan.
- **"Ask for changes"** box (passcode) → `shop-adjust` run on the light model.
- **Pantry** sheet (also from Settings): add an item to a section, mark it low, strike a freezer item as used, add a freezer item — deterministic edits to `profile/pantry.md` that the server commits itself (§5).

### Ask Claude (every tab)
A bottom sheet for the jobs that used to need a desktop session: substitutions, recipe modifications that should stick, pantry and preference changes, questions about past weeks, and the first-run profile interview. `POST /api/ask` (passcode, 10/min) streams from the plan model with the whole repo readable and the run tool gate (edits inside the repo, plain git), up to 30 turns; it may ask a clarifying question and the user can reply. It holds the run lock while answering (the strip shows "Asking Claude", Stop aborts it; 409 while a run is active). A turn that changed files ends with a `Changed:` line rendered as chips and a `[git]` outcome, followed by a state refresh. The transcript is client-side; `GET /api/ask/last?turn=` refills an answer after a screen-lock reload.

---

## 4. Run types — the Claude bridge

All runs: repo cwd, project settings, the tool gate above, one at a time, event stream to the UI, and "never ask the user questions — if blocked, explain in the final message" in the system append. The final message is a human-facing summary rendered in the UI; the *product* of every run is the repo file it wrote (the server re-parses plan files after each run and broadcasts fresh state).

| Run | Trigger | Model | What it does |
|---|---|---|---|
| `propose` | Next tab button | plan | `/plan-week` steps 1–3 in app mode: read prefs/pantry/history, create `plans/W.md` (status `planning`) with proposed meals, servings, and per-meal why; queued ideas come in as `{{QUEUED_IDEAS}}`. No lock. |
| `revise` | "Send changes" / step 1 of send-and-lock | plan | Reads the feedback bundle (approvals, rejections + reasons, swap notes, servings, free text). Replaces rejected/swapped meals, records rejection reasons; in send-and-lock the replacements come back approved. |
| `lock` | "Lock week + grocery list" / step 2 of send-and-lock | plan | Guard: every meal approved. Lock status, new recipe files, Prep timeline, full grocery list built from the ingredient lines pre-scaled to each meal's servings (`{{SCALED_INGREDIENTS}}`), bulk/pantry logic, fold any Shop extras. |
| `fold` | Auto-debounced after captures (§6) or "Sync now" | light | Writes pending captures into the plan file Log tables (multi-week aware, reconcile-don't-duplicate), appends recipe Notes when a note warrants it. |
| `shop-adjust` | Shop tab "Ask for changes" | light | Small edit to the locked plan's grocery section. |
| `rescale` | Servings stepper on a locked week | light | One meal to a new servings count: its Servings cell, its grocery lines, Bulk notes, Prep only if pack sizes change. Never touches the recipe file. |
| `move` | Move control on a Week-tab day card | light | One unlogged dinner of the locked cooking week to another day (plain move onto a flexible night, or a swap): Plan-table rows exchange everything but Day, planning bullets relabeled plus a `Moved` bullet, that dinner's prep re-dated (ticked tasks kept byte-identical via `{{DONE_PREP}}`), a freshness task when a fresh or thawing protein would outlast the move. Grocery list, Bulk notes and Log untouched. |
| `review` | "Close out the week" / step 1 of close-and-plan | plan | Folds any pending captures itself, then `/review-week`: recipe frontmatter stats (including "took about" time nudges), Week review section with the `{{TRENDS}}` numbers, learned-preference signals into `preferences.md`, pantry/freezer update, status `complete`. |
| `ideas` | Recipes tab "New ideas" | plan | A new dated batch of eight dishes at the top of `profile/ideas.md`, avoiding the library and everything queued, dismissed or already suggested (`{{IDEAS_STATE}}`). |
| `import` | Recipes tab "Add a recipe" / Android share | plan | One user-supplied recipe (`{{IMPORT_SOURCE}}`) → `recipes/<slug>.md` in house format, never overwriting, plus a dated Learned-preferences entry. |

**Chains.** Two flows run steps back to back under the one-run lock (`startChain` in `server/runs.ts`). **Close-and-plan** (`POST /api/runs/close-and-plan`, Week tab) is `review` of the cooking week, then `propose` of the ahead week, with cook-night chips and constraints collected before anything runs (chips reach the prompt as a structured first line of `{{NOTE}}`). **Send-and-lock** (`POST /api/runs/revise` with `lock: true`, Next tab) is `revise` with the prompt's `{{AUTO_APPROVE}}` block, then `lock` behind a file re-check; refused while any meal lacks a decision. The strip shows "step 1 of 2" with the summed typical time; Stop ends the whole chain; a failed step stops it and says which step did not run; success leaves one result card holding every step's summary.

Every run commits and pushes. Prompts live in `app/prompts/*.md` (server-loaded per run, with `{{WEEK}}`, `{{DATES}}`, `{{TODAY}}`, `{{NOTE}}`, `{{FEEDBACK}}`, `{{CAPTURES}}`, `{{EXTRAS}}`, `{{ROUTING}}`, `{{SCALED_INGREDIENTS}}`, `{{TRENDS}}`, `{{QUEUED_IDEAS}}`, `{{IDEAS_STATE}}`, `{{IMPORT_SOURCE}}` filled in). They are app-mode translations of the four slash commands — same rules by reference to CLAUDE.md, minus the interactive steps, plus strict file-format contracts so the server's parser always has clean input. `MEALAPP_MOCK_RUNS=1` (dev instances only) replaces every SDK call with canned activity and summaries so the UI can be exercised without Claude.

---

## 5. Data and state

**Repo (canonical, git-synced)**: `plans/YYYY-Wnn.md` (plan table, prep timeline, grocery list, log table, review), `recipes/*.md`, `profile/*.md`. The server parses; agent runs write.

**The server's two repo writers** go through `server/commit.ts`: a repo lock serializes them, each commits only its own paths with a `(via app, <who>)` message, pushes in the background with one `pull --rebase` retry, and is refused with 409 while a run, chain or Ask Claude holds the run lock. (1) **Pantry edits**: `GET /api/pantry` (open) returns the parsed sections; `POST /api/pantry/items`, `DELETE /api/pantry/items/:id`, `PUT /api/pantry/items/:id/low`, `POST /api/pantry/freezer`, `POST /api/pantry/freezer/:id/used` (passcode, rate-limited, attributed) each apply one pure `server/pantry.ts` edit, preserving every byte the edit doesn't own; item ids are content slugs, so an edit from a stale screen gets a 404. (2) **Starter import**: `POST /api/starter/import` copies chosen files from `starter-recipes/` into `recipes/`.

**Parser contract** (`parsePlan` / `parseRecipe` in `server/parse.ts`): plan-table rows read **by header text** (day / meal / recipe link / servings / time / cal / protein / status; files without a Servings column parse as 4), Prep timeline `- [ ] **day:** task` lines, grocery `- [ ] item` lines under `### Store` / `**Section**` headings, the `**Status:**` line, log-table rows, and recipe frontmatter (scalars, one nested `nutrition_per_serving` map, a `prep_ahead` list). `plans/TEMPLATE.md` has this structure and the run prompts pin it. `npm run selftest` checks the parsers, the scaler, the pantry editor, trends and notifications against the sample files in `app/scripts/fixtures/`.

**App state, `app/data/` (gitignored)**

| File | Contents |
|---|---|
| `captures.json` | Rating/note/dish entries keyed by ISO date — the capture log. Each: `{date, dish, rating, note, by, at, foldedAt?}`. |
| `checks.json` | Shared checkbox state, week-scoped keys (`YYYY-Wnn:shop:<item-key>`, `YYYY-Wnn:prep:<key>`) so stale state can't bleed across weeks. |
| `plan-feedback.json` | Per-meal approve/reject/swap + notes + servings + week-level free text for the week in `planning`, consumed by the next revise/lock run. |
| `extras.json` | Shop-tab add-items per week. |
| `ideas-state.json` | Queue / Not-for-me decisions on ideas and imported recipes. |
| `imports/`, `uploads/`, `shares.json` | Import records, uploaded photos/PDFs, Android shares. |
| `runstats.json` | Per-run-type duration history. |
| `passcode.txt` | Gate secret (rotate by editing; no restart). |
| `settings.json` | Gear-panel overrides (models, effort, auto-fold, push times); only changed keys. |
| `vapid.json`, `push.json` | Web Push key pair (generated once) and per-phone subscriptions with their toggles. |

**Device state (localStorage / sessionStorage)**: passcode, cosmetic prefs, view state, chat transcripts, the Get started card's dismissal. No meal data lives on a device.

---

## 6. Capture → fold

Markdown is the record and Claude maintains it — but capture must be instant.

1. Tap stars / type a note / mark "cooked as planned", "substituted: X" or "didn't cook" → POST → `captures.json` → WS broadcast. Done in under a second, works for anyone in the household, survives restarts.
2. A **fold timer** (default: 5 min after the last new capture, a Settings option) fires the `fold` run on the light model, which writes the Log tables, commits, pushes, and stamps `foldedAt`.
3. `review` folds whatever is pending itself, so "Close out the week" is always safe to press.

Auto-fold spends a small run unattended. Turn it off in the gear panel or with `MEALAPP_AUTOFOLD=off` to make folding manual-only.

---

## 7. Which week is which

- **Weeks run Saturday→Friday.** The id is the ISO week of the Monday the span contains: `weekIdForDate(date)` = ISO week of `date + 2 days`. The flip happens at the Fri→Sat midnight boundary.
- **Cooking week** (Week/Recipes): `curId = weekIdForDate(today)`, once its plan is locked. Days from the *previous* week that are planned-but-unlogged render as carry cards for 3 days.
- **Ahead week** (Next/Shop): `curId` while the current week is unplanned or still `planning` (there's nothing to be ahead of yet); otherwise `curId + 1`. This is what lands Friday's planning session and Saturday morning's shop on the right tab.
- **Shop-week rule**: the Shop tab shows the ahead week's grocery list if it has one; else the cooking week's list if it has one (on shopping morning the active list belongs to the week that just started); else the empty state pointing at Next.
- If today's week was never locked (a skipped week), Week falls back to the most recent locked plan with a banner.
- The scheme is implemented in one place, `server/weeks.ts`. It also carries legacy constants for an older Monday→Sunday scheme (week ids up to `2026-W32`); they are exercised only by the selftest.

---

## 8. API sketch

**Recipe images**: `recipes/images/<slug>.jpg` (slug = recipe file minus `.md`; jpg/jpeg/png/webp accepted), found by filename, never named in frontmatter (`repo.ts recipeImages`). Served statically at `/recipe-images/<file>` (image files only, 1 h cache) and surfaced as an `image` URL on `/api/recipes`, `/api/recipes/entry` meta and the `/api/state` meals; a recipe without one shows no image slot. Pictures are made outside the app by the desktop command `/recipe-images` (after the grocery list, or last after a recipe addition); the app only reminds (a **Pictures to make** card on the Recipes tab, a line on the lock and import result cards).

Open GETs: `/api/state` (everything the UI needs: weeks, parsed plan/prep/grocery/log, checks, captures, feedback, run status, setup; `imagesMissing` = `[{ file, name }]` of recipes with no picture yet, for the `/recipe-images` reminders), `/api/recipes`, `/api/recipes/entry?f=&servings=`, `/api/recipes/headline`, `/api/plans` + `/api/plans/entry?f=` (history), `/api/trends`, `/api/ideas`, `/api/imports`, `/api/shares`, `/api/starter`, `/api/pantry`, `/api/weather`, `/api/geocode?q=`, `/api/run`, `/api/settings`, `/api/push/key`, `/api/push`.

Open captures (rate-limited, whois-attributed when possible): `POST /api/log` (rating/note/dish), `POST /api/check` (prep/shop toggle), `POST /api/feedback` (per-meal approve/reject/swap/note/servings, week free-text), `POST /api/feedback/approve-all`, `POST /api/extras`, `POST /api/ideas/:id`, `POST /api/imports/upload`, `POST /share`, `POST /api/push/subscribe`, `PUT /api/push/:id/types`.

Passcode: `POST /api/runs/{propose|revise|lock|fold|shop-adjust|rescale|move|review|close-and-plan|ideas|import}`, `POST /api/stop`, `POST /api/cook/ask` and `POST /api/ask` (chats — spend tokens, stream `text/plain`), `PUT /api/settings`, the pantry edits, `POST /api/starter/import`, `GET /api/ask/last`, `DELETE` endpoints (a capture, an extra, a share, a push subscription).

WS (`/ws`): `run-state` / `event`, `state-updated` (post-run or post-edit reparse), `check`, `capture`, `feedback` deltas, `settings-updated`.

---

## 9. Out of scope (ideas, parked)

Multi-household support, configurable week start day, lunch and breakfast planning, nutrition tracking beyond dinners, native apps.
