# Meal Planner

A weekly meal-planning system for one household (size, serving count, and tastes are in `profile/preferences.md` — plan one shared menu scaled to that household, never separate menus per person). Claude is the engine: it proposes meals, builds grocery lists, and maintains all records. The user's role is limited to approving/rejecting proposals, logging what got cooked, and rating meals.

**The primary interface is the app in `app/`** (Express + Claude Agent SDK on the Claude Code login, always-on via LaunchAgent) — see "The app" below. The slash commands remain the desktop fallback and the reference definition of each workflow. Setup steps for a new install are in `README.md`.

## User goals
1. Eat healthier
2. Eliminate the friction of recipe hunting and shopping-list creation
3. Keep track of everything (meals, ratings, nutrition, history)

## Weekly cadence

| Step | Command | What happens |
|------|---------|--------------|
| 1. Plan | `/plan-week` | Claude proposes the week's meals; user approves/rejects/swaps until the plan is locked |
| 2. Shop | `/grocery-list` | Claude generates the shopping list from the approved plan, split by store |
| 3. Log | `/log-meal` | User reports what actually got cooked + a 1–5 rating |
| 4. Review | `/review-week` | Claude closes out the week: updates recipe stats, notes patterns, feeds insights into next week's plan |

In the app, each step is a surface instead of a command: **Next tab** = plan (propose → per-meal approve/reject/swap → revise → lock, which also builds the grocery list), **Shop tab** = the list with live-shared checkboxes, **day cards** = log (stars/notes, folded to the record by a background run), **Week tab** = close out. Commands remain the desktop fallback for all four.

## Directory layout

- `profile/preferences.md` — household, tastes, restrictions, nutrition goals, logistics, stores (source of truth)
- `profile/pantry.md` — staples on hand; used to subtract items from grocery lists
- `recipes/` — one markdown file per recipe with frontmatter (nutrition, rating, times cooked)
- `plans/` — one file per week, named `YYYY-Wnn.md` (e.g. `2027-W03.md`); holds the plan, the grocery list, and the cooked log for that week
- `plans/TEMPLATE.md` — structure for weekly plan files
- `app/` — the app (server, UI, run prompts, selftest, LaunchAgent)
- `app/scripts/fixtures/` — synthetic sample files for the selftest. **Not history** — never read them as past weeks or as the recipe library.

## Rules for Claude

**Planning**
- Read `profile/preferences.md`, `profile/pantry.md`, and the last 2–3 weeks of `plans/` before proposing anything.
- Never propose anything on the hard-no / allergy list. Respect nutrition targets in preferences.
- Balance repeats and novelty: favor recipes rated 4–5, retire anything rated ≤2, and include new recipes at the rate set in preferences.
- Don't repeat a recipe within the minimum-gap window set in preferences. Check the **protein-level gaps** too — they bind across different recipes sharing a protein, so a new shrimp dish still violates a shrimp gap.
- Every proposed meal includes: active cooking time, and estimated nutrition per serving (calories, protein, carbs, fat, fiber).
- Prep is first-class: recipes declare `prep_ahead` (thaw/marinate/start-by) in frontmatter; locking a plan generates its Prep timeline with each task dated to the day it's **due**, not the day it pays off. The app surfaces prep as checkboxes on the day cards.
- Present proposals for approval one week at a time; iterate until the user locks the plan. Record rejections and why (rejection reasons are preference signals — fold recurring ones into preferences.md).

**Shopping**
- The stores are named in `profile/preferences.md` → Shopping. The **primary store** gets everything it sensibly carries; the **secondary store** is only for items the primary doesn't carry (or carries only in impractical bulk for the household). With no secondary store, everything goes on one list.
- Each store is a `### {store name}` heading in the plan file's Grocery list, primary first, using the names from preferences consistently week to week.
- Subtract pantry staples from the list. Flag pantry items that are likely running low.
- Account for bulk pack sizes: when a recipe needs an item sold only in bulk, plan additional meals that week (or the next) that reuse it, or note the freezer plan.
- Organize each store's list by section (produce, meat, dairy, frozen, pantry).
- Recipe ingredient lines carry a source tag: `[1]` primary store, `[2]` secondary store, `[P]` pantry.

**Tracking**
- Ratings are 1–5: 5 = make it weekly, 4 = regular rotation, 3 = fine, 2 = don't repeat soon, 1 = never again.
- After logging, update the recipe file's frontmatter: `rating` (running average), `times_cooked`, `last_cooked`.
- The weekly plan file is the historical record — never rewrite past weeks except to fill in logs.
- New recipes get a file in `recipes/` when they're first approved into a plan, not before.

**Sync (more than one device!)**
- This repo is used from more than one place: the always-on Mac that runs the app AND any other Claude Code session (another computer, or Claude Code web/mobile on a phone) working against the same private GitHub repo. Divergence is the failure mode.
- **Start of every session: `git pull` before reading or changing state.**
- After any state-changing step (plan locked, grocery list written, meals logged, week reviewed, preferences/pantry updated): commit with a descriptive message and push immediately. Don't batch several days of changes.
- If a push is rejected, pull --rebase and push again; conflicts in plan files resolve in favor of whichever side has the logged data.

**The app (`app/`)** — the primary interface (architecture overview: `SPEC.md`; install: `README.md`)
- Express + `@anthropic-ai/claude-agent-sdk` on the user's Claude Code login (no API key), WS live updates, vanilla JS frontend. **Always-on** via LaunchAgent `com.mealplanner.app` (template in `app/launchd/`; `app/launchd/install.sh` renders it with this checkout's path and installs it in `~/Library/LaunchAgents/`; it sources nvm because launchd has a bare environment). Logs: `~/Library/Logs/meal-planner.log`. Port 4316. On the Mac: `http://localhost:4316` · phone on home Wi-Fi: `http://<mac-hostname>.local:4316` · anywhere, if Tailscale is set up: `http://<mac-hostname>.<tailnet-name>.ts.net:4316`.
- **Restart after server changes** with `app/launchd/install.sh restart` (= `launchctl kickstart -k gui/$UID/com.mealplanner.app`) — but ALWAYS `GET /api/run` first and wait for `active: false`: run state is in-memory, a restart kills an in-flight run (the script refuses while a run is active). Captures/checks are persisted JSON and survive. Never `npm start` alongside the agent (port conflict); the repo's `.claude/launch.json` "meal-app" config only attaches a preview to the running server. Verify changes with `npm run typecheck` + `npm run selftest` (parsers checked against the sample files in `app/scripts/fixtures/`). The Agent SDK is **pinned** in `app/package.json` (never `"latest"` — a floated SDK version once broke git inside runs); after pulling app changes, `npm ci` in `app/` before restarting. Run git/read-tool permissions are granted via `allowedTools` rules (enforced CLI-side) with `canUseTool` as the deny-by-default backstop, so runs survive a broken SDK control channel.
- **Five tabs: Week · Cook · Recipes · Next · Shop** — Week/Recipes = the week being cooked, Next/Shop = the week ahead, Cook = at the stove. All computed live: the flip to a new week and the dashed carry cards for unlogged stragglers come from date + plan-status logic. Header retitles per tab. The UI persists view state (active tab, expanded recipes, per-tab scroll, cook dish + chat) in sessionStorage and restores it on boot, so a phone screen-lock reload lands back on the exact view.
- **Cook tab**: dish picker (defaults to tonight, explicit picks persist) + full recipe + **sous-chef chat**. Chat = `POST /api/cook/ask` (passcode, 10/min): streams from `MEALAPP_COOK_MODEL` (default = the light model) with the recipe + preferences + pantry embedded; read-only tools (Read/Grep/Glob in-repo), never git, **not a run** — usable while a run is active. Transcripts live client-side per recipe (sessionStorage, 40-msg cap); the server keeps no chat state.
- **The repo stays the only system of record.** The server *parses* `plans/` and `recipes/` (formats pinned by `plans/TEMPLATE.md` — don't drift them, the parser and `app/scripts/selftest.ts` bind them); it never writes repo files. Agent runs are the only writers. What the parser depends on: the Plan table's exact columns, the `**Status:**` line starting with `planning` / `locked` / `complete`, `- [ ] **Ddd D, time:** task` prep lines, `### Store` / `**Section**` / `- [ ] item` grocery structure, the `### Pantry check` and `### Bulk notes` headings, the Log table's columns, and recipe frontmatter keys.
- **Capture → fold:** stars/notes/dish-corrections POST instantly to `app/data/captures.json` (gitignored, lives only on the Mac) keyed by ISO date; shared checkboxes (prep + shop, week-scoped keys) live in `checks.json` and sync over WS between devices. A **fold run** (light model) writes pending captures into the plan files' Log tables after ~15 min of quiet (delay + on/off in the gear panel; `MEALAPP_AUTOFOLD=off` is the env fallback) or via "Sync now"; entries get `foldedAt` stamped. `week-review` folds whatever is still pending itself, so closing a week is always safe.
- **Runs** (one at a time, tool-gated to writes-inside-repo + plain git, `settingSources: ['project']` so this file's rules bind): `propose` → `revise` (consumes per-meal ✓/✗/↻ feedback + week notes from the Next tab) → `lock` (recipe files for 🆕, prep timeline, grocery list, folds Shop-tab extras) → `fold` → `shop-adjust` → `review`. Prompts in `app/prompts/*.md` — they are the app-mode translations of the four commands and pin the exact file formats. Feedback/extras are cleared after the run that consumes them. Runs commit+push per the sync rules; the server `git pull --ff-only`s throttled on reads and never during a run.
- **Trust model**: reachability is the identity — anyone who can reach the port (home network, or the tailnet if Tailscale is used) can use the app. GETs open; captures/checks/feedback/extras open but rate-limited, and attributed via `tailscale whois` when the request arrives over Tailscale (unattributed otherwise); run triggers, stop, and deletes need the shared passcode (`x-mealapp-passcode`, stored per device). Passcode file: `app/data/passcode.txt` (gitignored) or env `MEALAPP_PASSCODE` — **with neither set the gate is off**, so set one at install; rotating the file needs no restart. Env: `MEALAPP_PORT`, `MEALAPP_MODEL` (plan/review runs), `MEALAPP_LIGHT_MODEL` (fold/adjust), `MEALAPP_COOK_MODEL` (default = light — sous-chef chat), `MEALAPP_PASSCODE`, `MEALAPP_AUTOFOLD`.
- **Settings (gear icon, header):** models + effort per tier (plan / light / sous-chef), auto-fold on/off + quiet delay, per-device passcode/theme/chat-clearing, and a read-only Status block (gate, uptime, HEAD, SDK version, last git pull incl. errors, pending captures, typical run times). Server values persist in `app/data/settings.json` (gitignored; `GET` open, `PUT /api/settings` passcode) and **override env**: effective = settings.json > env > built-in. Changes apply to the next run/chat, no restart; `{}`/absent file = pure env behavior.

**General**
- **Onboarding:** `profile/preferences.md` and `profile/pantry.md` ship as blank templates. While either still contains `_fill in_` placeholders, onboarding is not complete — don't propose a plan. In an interactive session, interview the user and fill the files in (then commit and push). In an app run (no interaction possible), change nothing and say in the final message that the profile needs to be filled in first. Once filled in, `profile/preferences.md` is the live source of truth.
- **Dates:** weeks run Saturday–Friday, named `YYYY-Wnn` by the ISO week of the Monday they contain (= the ISO week of date + 2 days for any date in the week); planning happens Friday, shopping Saturday morning (day 1 of the week). This scheme is hard-coded in the server (`app/server/index.ts`, "week scheme" block) and assumed by the UI's nudges, so changing the planning/shopping days means changing code, not just preferences. The same block carries legacy handling for week ids up to `2026-W32` (Monday-start weeks); it only matters to the selftest fixtures.
