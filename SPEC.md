# Meal Planner App — Architecture overview

A local, always-on web app with the Claude Agent SDK inside it, so the whole weekly loop — propose, approve, lock, shop, log, review — happens from any device's browser. The repo's markdown stays the system of record; the app is a *view + capture layer + run trigger*, and only Claude agent runs write repo files.

Operational rules (restart discipline, sync, file formats) live in `CLAUDE.md`. Install steps live in `README.md`. This file explains how the pieces fit.

---

## 1. Goals and non-goals

**Goals**

1. Claude lives *in* the app. Every workflow that would otherwise need a Claude Code session is a button: propose the week, revise it, lock it + build the grocery list, fold logs into the record, close out the week.
2. Capture is instant and needs no hand-off: ratings and notes post to the server the moment they're tapped; per-meal approve/reject/swap feedback triggers a revise run and the page re-renders itself when the run finishes.
3. Shared live state where it matters: grocery and prep checkboxes sync over WebSocket, so two people can split up in a store and watch each other's checks land.
4. The repo stays the system of record: `plans/`, `recipes/`, `profile/` markdown, git-synced.

**Non-goals**

- No public hosting, no accounts. Reachability on the home network (or a private tailnet) is the identity; one shared passcode guards anything that spends tokens or destroys state.
- No recipe import from URLs, no push notifications, no nutrition dashboard, no general chat box, no pantry editor UI (pantry stays markdown, maintained by runs).
- Desktop Claude Code sessions keep working via the slash commands — the app is the primary interface, not the only one.

---

## 2. Architecture

- **`app/` directory in the repo.** Express + `@anthropic-ai/claude-agent-sdk` (runs on the machine's Claude Code login — no API key) + `ws` + `marked`, TypeScript via `tsx`, no build step. Vanilla JS frontend (`public/index.html`, `app.js`, `style.css`). The whole server is one file, `app/server/index.ts`.
- **Agent runs execute with `cwd` = repo root**, `settingSources: ['project']`, and the `claude_code` system-prompt preset with an app-mode append — so CLAUDE.md's planning/sync rules bind automatically.
- **Tool gate**: allow Read/Grep/Glob/WebSearch/WebFetch/Skill/TodoWrite/Task; Edit/Write only inside the repo; Bash only for plain git commands (no shell metacharacters); deny everything else. Granted twice over — as `allowedTools` rules enforced by the CLI, and as a `canUseTool` callback that denies by default.
- **One run at a time** (409 otherwise), in-memory run state + event log, AbortController stop, WS broadcast of run events. The UI shows a pulse + elapsed + "usually ~N min" (median of recent successful runs of *that run type*).
- **Persistent app state** in `app/data/*.json` (gitignored, lives only on the host Mac). Survives restarts; run state does not — check `GET /api/run` for `active: false` before restarting.
- **Passcode gate**: every GET is open; mutations split into *capture* (open, rate-limited, attributed via `tailscale whois` when available) and *spend/destroy* (passcode header, prompted once per device, kept in localStorage). Passcode in `app/data/passcode.txt` or env, read per-request. With no passcode configured the gate is off.
- **Reachability**: the server binds all interfaces on port **4316** (`MEALAPP_PORT`). `http://localhost:4316` on the host; `http://<mac-hostname>.local:4316` on the home network; `http://<mac-hostname>.<tailnet-name>.ts.net:4316` over Tailscale.
- **Always-on**: LaunchAgent `com.mealplanner.app` (template + `install.sh` in `app/launchd/`), sources nvm, logs to `~/Library/Logs/meal-planner.log`, auto-restarts on crash. Never `npm start` alongside the agent.
- **Git**: the server does `git pull --ff-only` at boot and throttled before reads, never during a run (the agent owns git then). Agent runs commit + push per CLAUDE.md sync rules, so other Claude Code sessions and the app never diverge.
- **Env**: `MEALAPP_PORT` (4316), `MEALAPP_MODEL` (plan/review runs), `MEALAPP_LIGHT_MODEL` (fold/adjust runs), `MEALAPP_COOK_MODEL` (default = light model; the Cook tab's sous-chef chat), `MEALAPP_PASSCODE`, `MEALAPP_AUTOFOLD` (`off` to disable the fold debounce). Built-in model defaults and the selectable list are at the top of `app/server/index.ts` (`MODEL_OPTIONS`, `settingDefaults`).
- **Settings panel** (gear in the header): `app/data/settings.json` overrides the env for `planModel`/`lightModel`/`cookModel`, `planEffort`/`lightEffort`/`cookEffort` (absent = model default), `autoFold`, `foldQuietMin` (5/15/30/60). Effective value = settings.json > env > built-in; read at use time, so changes hit the next run/chat (never an in-flight one) with no restart. `GET /api/settings` (open) returns values/stored/defaults/options plus read-only status; `PUT` (passcode, rate-limited) validates strictly, `null` resets a key.

---

## 3. Surfaces — five tabs

**Week · Cook · Recipes · Next · Shop.** Week/Recipes show the week being *cooked*, Next/Shop show the *week ahead*, and Cook is the at-the-stove view. Header retitles per tab. A thin **status strip** under the header on every tab says where the week stands and the one next action.

**View-state persistence:** phones discard backgrounded tabs, so everything needed to rebuild the exact view — active tab, expanded recipe cards, per-tab scroll position, the cook tab's dish and chat transcripts — lives in sessionStorage and is restored on boot. A `?tab=` URL param is honored once, then stripped.

### Week (default tab)
- Day cards for the cooking week, parsed from its plan file: dish, active time, cal/protein, NEW/⭐ badge, per-meal rationale, TONIGHT highlight on today's card.
- **Prep checkboxes** on the day they're due (parsed from the Prep timeline) — shared state, WS-live.
- **Rating (1–5 stars) + note + "what actually got cooked"** control per day — POSTs immediately (open endpoint). Shows a small "recorded ✓ / folded ✓" state so it's visible when an entry has made it into the markdown record (§6).
- **Carry cards**: unlogged days from the previous week render as dashed cards above the week's first day so a stranded final day can still be rated after the flip.
- **Close out week** button (passcode) → runs the `review` run.
- "‹ past weeks" link → read-only rendered view of any historical plan file.

### Cook
- A dish picker (defaults to tonight's dinner, else the next one coming up this week; explicit picks persist), the full rendered recipe, and a **sous-chef chat** under it.
- The chat is `POST /api/cook/ask` (passcode, rate-limited 10/min): streams plain text from the cook model with the recipe, `profile/preferences.md`, and `profile/pantry.md` embedded in the prompt. Read-only tool gate (Read/Grep/Glob inside the repo only), custom system prompt, max 2 concurrent. **Deliberately not a run**: it doesn't touch the run lock, so it works while a fold or lock is in flight.
- Transcripts are per-recipe, client-side (sessionStorage, capped at 40 messages) — the server keeps no chat state; the client sends the whole conversation each turn.

### Recipes
- The full library from `recipes/`: list with rating, times cooked, last cooked; sortable (rating / recency / name); tap → rendered recipe. This week's dishes pinned on top.

### Next (the planning cockpit)
- Shows next week's plan file state:
  - **No file yet** → "Propose" button (passcode) + a free-text box for constraints ("we're out Wed–Thu", "use the frozen shrimp") passed to the propose run.
  - **Status `planning`** → proposal review: each proposed meal as a card with the run's rationale and three controls — **✓ approve**, **✗ reject (reason required)**, **↻ swap request (note)** — plus a week-level free-text change box. All feedback is *captured* instantly (open endpoints). **Send changes** (passcode) fires a `revise` run with the whole feedback bundle. Iterate until every meal is approved.
  - **All approved** → **Lock week + grocery list** button (passcode) fires `lock`.
  - **Status `locked`** → read-only summary + a free-text change box → small revise run.

### Shop
- The upcoming week's grocery list parsed from its plan file: one block per store, sections, quantities, the Pantry-check block, bulk notes. **Checkboxes are shared live state.**
- **"Add item"** free text (open, capture-only): lands in an "Extras" section of the list state immediately — no tokens. Extras are folded into the plan file's list by the next run that touches the plan.
- **"Ask for changes"** box (passcode) → `shop-adjust` run on the light model.

---

## 4. Run types — the Claude bridge

All runs: repo cwd, project settings, the tool gate above, one at a time, event stream to the UI, and "never ask the user questions — if blocked, explain in the final message" in the system append. The final message is a human-facing summary rendered in the UI; the *product* of every run is the repo file it wrote (the server re-parses plan files after each run and broadcasts fresh state).

| Run | Trigger | Model | What it does |
|---|---|---|---|
| `propose` | Next tab button | plan | `/plan-week` steps 1–3 in app mode: read prefs/pantry/history, create `plans/W.md` (status `planning`) with proposed meals + per-meal why. No lock. |
| `revise` | "Send changes" | plan | Reads the feedback bundle (approvals, rejections + reasons, swap notes, free text). Replaces rejected/swapped meals, records rejection reasons. |
| `lock` | "Lock week + grocery list" | plan | Guard: every meal approved. Lock status, new recipe files, Prep timeline, full grocery list with bulk/pantry logic, fold any Shop extras. |
| `fold` | Auto-debounced after captures (§6) or "Sync now" | light | Writes pending captures into the plan file Log tables (multi-week aware, reconcile-don't-duplicate), appends recipe Notes when a note warrants it. |
| `shop-adjust` | Shop tab "Ask for changes" | light | Small edit to the locked plan's grocery section. |
| `review` | "Close out week" | plan | Folds any pending captures itself, then `/review-week`: recipe frontmatter stats, Week review section, learned-preference signals into `preferences.md`, pantry/freezer update, status `complete`. |

Every run commits and pushes. Prompts live in `app/prompts/*.md` (server-loaded per run, with `{{WEEK}}`, `{{DATES}}`, `{{TODAY}}`, `{{NOTE}}`, `{{FEEDBACK}}`, `{{CAPTURES}}`, `{{EXTRAS}}`, `{{ROUTING}}` filled in). They are app-mode translations of the four slash commands — same rules by reference to CLAUDE.md, minus the interactive steps, plus strict file-format contracts so the server's parser always has clean input.

---

## 5. Data and state

**Repo (canonical, git-synced)**: `plans/YYYY-Wnn.md` (plan table, prep timeline, grocery list, log table, review), `recipes/*.md`, `profile/*.md`. The server parses, never writes.

**Parser contract** (`parsePlan` / `parseRecipe` in `app/server/index.ts`): plan-table rows (day / meal / recipe link / time / cal / protein / status), Prep timeline `- [ ] **day:** task` lines, grocery `- [ ] item` lines under `### Store` / `**Section**` headings, the `**Status:**` line, log-table rows, and recipe frontmatter (scalars, one nested `nutrition_per_serving` map, a `prep_ahead` list). `plans/TEMPLATE.md` has this structure and the run prompts pin it. `npm run selftest` checks the parser against the sample files in `app/scripts/fixtures/`.

**App state, `app/data/` (gitignored)**

| File | Contents |
|---|---|
| `captures.json` | Rating/note/dish entries keyed by ISO date — the capture log. Each: `{date, dish, rating, note, by, at, foldedAt?}`. |
| `checks.json` | Shared checkbox state, week-scoped keys (`YYYY-Wnn:shop:<item-key>`, `YYYY-Wnn:prep:<key>`) so stale state can't bleed across weeks. |
| `plan-feedback.json` | Per-meal approve/reject/swap + notes + week-level free text for the week in `planning`, consumed by the next revise/lock run. |
| `extras.json` | Shop-tab add-items per week. |
| `runstats.json` | Per-run-type duration history. |
| `passcode.txt` | Gate secret (rotate by editing; no restart). |
| `settings.json` | Gear-panel overrides (models, effort, auto-fold); only changed keys. |

**Device state (localStorage / sessionStorage)**: passcode, cosmetic prefs, view state, and sous-chef transcripts only. No meal data lives on a device.

---

## 6. Capture → fold

Markdown is the record and Claude maintains it — but capture must be instant.

1. Tap stars / type a note / mark "cooked as planned" or "substituted: X" → POST → `captures.json` → WS broadcast. Done in under a second, works for anyone in the household, survives restarts.
2. A **fold timer** (default: 15 min after the last new capture) fires the `fold` run on the light model, which writes the Log tables, commits, pushes, and stamps `foldedAt`.
3. `review` folds whatever is pending itself, so "Close out week" is always safe to press.

Auto-fold spends a small run unattended. Turn it off in the gear panel or with `MEALAPP_AUTOFOLD=off` to make folding manual-only.

---

## 7. Which week is which

- **Weeks run Saturday→Friday.** The id is the ISO week of the Monday the span contains: `weekIdForDate(date)` = ISO week of `date + 2 days`. The flip happens at the Fri→Sat midnight boundary.
- **Cooking week** (Week/Recipes): `curId = weekIdForDate(today)`, once its plan is locked. Days from the *previous* week that are planned-but-unlogged render as carry cards for 3 days.
- **Ahead week** (Next/Shop): `curId` while the current week is unplanned or still `planning` (there's nothing to be ahead of yet); otherwise `curId + 1`. This is what lands Friday's planning session and Saturday morning's shop on the right tab.
- **Shop-week rule**: the Shop tab shows the ahead week's grocery list if it has one; else the cooking week's list if it has one (on shopping morning the active list belongs to the week that just started); else the empty state pointing at Next.
- If today's week was never locked (a skipped week), Week falls back to the most recent locked plan with a banner.
- The scheme is implemented in one place — the "week scheme" block in `app/server/index.ts`. That block also carries legacy constants for an older Monday→Sunday scheme (week ids up to `2026-W32`); it is exercised only by the selftest.

---

## 8. API sketch

Open GETs: `/api/state` (everything the UI needs: weeks, parsed plan/prep/grocery/log, checks, captures, feedback, run status), `/api/recipes`, `/api/recipes/entry?f=`, `/api/plans` + `/api/plans/entry?f=` (history), `/api/run`, `/api/settings`.

Open captures (rate-limited, whois-attributed when possible): `POST /api/log` (rating/note/dish), `POST /api/check` (prep/shop toggle), `POST /api/feedback` (per-meal approve/reject/swap/note, week free-text), `POST /api/extras`.

Passcode: `POST /api/runs/{propose|revise|lock|fold|shop-adjust|review}`, `POST /api/stop`, `POST /api/cook/ask` (sous-chef chat — spends tokens, streams `text/plain`, not a run), `PUT /api/settings`, `DELETE` endpoints (clear a capture, clear an extra).

WS (`/ws`): `run-state` / `event`, `state-updated` (post-run reparse), `check`, `capture`, `feedback` deltas, `settings-updated`.

---

## 9. Out of scope (ideas, parked)

Recipe recommendations tab, URL/recipe import, push notifications for prep tasks, nutrition trend charts, pantry editor UI, multi-household support, configurable week start day, general-purpose chat pane.
