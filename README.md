# Meal Planner

A weekly meal-planning system where Claude does the work: it proposes the week's dinners, builds the grocery list, and keeps every record (plans, recipes, ratings, pantry) as markdown in this repo. You approve or reject meals, tick off the shopping list, and rate what you cooked — from a small web app on your phone.

- **`app/`** — the web app: an Express server with the Claude Agent SDK inside it, running always-on on a Mac at home. Five tabs: **Week** (what's cooking, log + rate, move a dinner, trends, and a drawn kitchen window showing your weather), **Cook** (the recipe at the stove, scaled to tonight's servings, with a sous-chef chat), **Recipes** (your library, ideas, importing recipes from links or photos), **Next** (plan the coming week), **Shop** (live-shared grocery checklist, pantry editor). An **Ask Claude** chat on every tab handles the odd jobs: substitutions, recipe tweaks that stick, pantry and preference changes, questions about past weeks.
- **`profile/`, `plans/`, `recipes/`** — the system of record. Plain markdown, synced through git.
- **`starter-recipes/`** — thirty-odd tested recipes you can import on day one (optional; see First run).
- **`.claude/commands/`** — the same four workflows as Claude Code slash commands (`/plan-week`, `/grocery-list`, `/log-meal`, `/review-week`), for when you'd rather work in a Claude Code session.
- **`CLAUDE.md`** — the rules Claude follows (planning, shopping, tracking, sync). **`SPEC.md`** — how the app is put together.

The weekly rhythm is fixed: weeks run **Saturday → Friday**, you plan on **Friday** and shop on **Saturday morning**.

## Prerequisites

- **A Mac that stays on** (and awake) at home — it hosts the app. In System Settings, stop it sleeping when the display is off.
- **Node.js 22 or newer**, installed with [nvm](https://github.com/nvm-sh/nvm) (the LaunchAgent sources nvm; a Homebrew `node` also works).
- **Claude Code**, installed and logged in on that Mac. The app runs on your Claude Code login — there is no API key. Run `claude` in a terminal once and complete `/login`.
- **A private GitHub repo** for your copy, with `git push` working from Terminal without a password prompt (SSH key or `gh auth login`). Every run commits and pushes, and this is what keeps the Mac and any other Claude Code session (laptop, phone) in sync. Keep it private — it will hold your household's eating history.
- **Tailscale** (optional) — to reach the app away from home Wi-Fi, and for the https address that unlocks the installable app, push notifications, and sharing recipes to it from Android.

## Install

1. **Make it your repo.** Create an empty private repo on GitHub, then from this folder:

   ```bash
   git remote add origin git@github.com:YOUR-USER/meal-planner.git
   ```

   ```bash
   git push -u origin main
   ```

2. **Install dependencies and check the build:**

   ```bash
   cd app && npm ci && npm run typecheck && npm run selftest
   ```

3. **Set a passcode.** Anything that spends tokens (planning runs, the chats) or changes the repo from the app asks for it once per device. With no passcode the gate is *off* and anyone on your network can trigger runs, so set one before going further:

   ```bash
   mkdir -p app/data && printf '%s\n' 'pick-your-own-passcode' > app/data/passcode.txt
   ```

   `app/data/` is gitignored — the passcode and the app's local state never leave the Mac. Change the passcode any time by editing the file; no restart needed.

4. **Install the LaunchAgent** so the app starts at login and restarts if it crashes:

   ```bash
   app/launchd/install.sh
   ```

   The script fills in this checkout's path, writes `~/Library/LaunchAgents/com.mealplanner.app.plist`, and starts the server. Logs go to `~/Library/Logs/meal-planner.log`. Re-run it if you move the folder. Other subcommands: `restart`, `uninstall`, `--print`.

5. **Open the app:** <http://localhost:4316> on the Mac.

## First run

The Week tab opens with a **Get started** card that tracks these three steps and hides itself when they're done.

1. **Fill in your profile.** `profile/preferences.md` and `profile/pantry.md` are blank templates, and Claude won't plan until the `_fill in_` placeholders are gone. The card's **Ask Claude to interview me** button opens the Ask Claude chat with the request already typed: answer its questions a few at a time and it writes both files and commits them. You can also edit the files by hand, or do the interview in a Claude Code session in this folder.

   The Shopping section is where you name your stores (a primary one, and optionally a secondary one for small quantities). Those names become the headings on every grocery list; ingredient lines in recipes are tagged `[1]` primary store, `[2]` secondary store, `[P]` pantry.

2. **Add recipes (optional).** The Recipes tab shows a **Starter library** card while `starter-recipes/` holds recipes you haven't imported: pick the ones that suit your kitchen and tap Import. They arrive with no ratings or history and can be edited or deleted like any recipe. Skip this to start from an empty library — Claude writes a recipe file for every new dish it plans. When you are done with the folder, delete it from the repo and the card goes away. Each recipe can have a picture at `recipes/images/<slug>.jpg` (the recipe's file name without `.md`; `recipes/images/README.md` describes how the template author makes them), which the app shows on the day cards, the Cook tab and the Recipes list; starter recipes bring theirs along when imported.

3. **Propose your first week.** On the **Next** tab, add any constraints for the week ("out Wednesday", "use up the frozen chicken") and tap **Propose**. Enter the passcode when asked. A run takes a few minutes; the page updates itself when it finishes.

Then the loop: **approve, reject, or swap** each meal and tap **Send changes** (or **Send and lock** once everything is decided) — Claude writes the recipe files, the prep timeline, and the shopping list. **Shop** from the Shop tab (checkboxes sync live between phones), **rate** dinners on the Week tab as you cook them, and on Friday tap **Close out and plan next week**.

## URLs and ports

The server listens on port **4316** on all network interfaces.

| Where you are | URL |
|---|---|
| On the Mac itself | `http://localhost:4316` |
| Phone or laptop on the same Wi-Fi | `http://<mac-hostname>.local:4316` |
| Anywhere, with Tailscale on both devices | `http://<mac-hostname>.<tailnet-name>.ts.net:4316` |
| Installable app, push, Android share (Tailscale) | `https://<mac-hostname>.<tailnet-name>.ts.net` |

Find `<mac-hostname>` under System Settings → General → Sharing → Local hostname. The https address needs one command on the Mac, `tailscale serve --bg 4316`, which terminates TLS in Tailscale and proxies to the app. Open that address on your phone and use the browser's "Add to Home Screen" to install it; Settings → This phone then offers push notifications (run finished, prep due today, tonight's dinner). The http addresses keep working as the fallback, including the plain home-screen bookmark.

To use a different port, set `MEALAPP_PORT` in the LaunchAgent's environment (add an `EnvironmentVariables` dict to `app/launchd/com.mealplanner.app.plist`, then re-run `install.sh`).

## Day-to-day operations

- **Settings** (gear icon in the app): which Claude model each kind of run uses, reasoning effort, whether ratings are written into the record automatically (~5 minutes after you stop tapping) or only when you press "Sync now", the kitchen window's place and °F/°C (weather comes from Open-Meteo, fetched by the Mac, no account), push notifications for this phone, and a status block (git state, last pull, pending entries).
- **Restart after changing server code:** `app/launchd/install.sh restart`. It refuses while a run is in flight, because a restart would kill the run.
- **Don't run `npm start` yourself** while the LaunchAgent is installed — the two would fight over the port.
- **After pulling app changes:** `npm ci` in `app/`, then restart.
- **Working from another device:** any Claude Code session on a clone of your repo can use the slash commands. Always `git pull` first; the rules in `CLAUDE.md` have Claude commit and push after every change.
- **If a run fails with an authentication error:** run `claude` in a terminal on the Mac and complete `/login` again.

## Things worth knowing

- **Who can reach it.** There are no user accounts: anyone who can reach port 4316 on the Mac can view the plan, tick boxes, and rate meals. The passcode guards runs, the chats, settings, pantry edits, imports, and deletes. Don't expose the port to the public internet.
- **Token use.** Planning, locking, and reviewing each run Claude for a few minutes on your Claude subscription. The automatic "fold" of ratings into the record is a small run on a lighter model; turn it off in Settings if you'd rather trigger it by hand. The chats stream from Claude too.
- **Names on entries.** If Tailscale is installed at `/Applications/Tailscale.app`, ratings and checkmarks made over the tailnet are labeled with the Tailscale user's name. Without it, entries are simply unlabeled; nothing else changes.
- **Push contact.** Web Push requires a contact address in each notification's signature. The app uses `MEALAPP_PUSH_CONTACT` if set, otherwise your git `user.email`; it is only ever seen by the browser vendors' push services.
- **The week is Saturday → Friday** in the server code, not just in the preferences file. Changing the planning or shopping day means changing code (see the Dates note in `CLAUDE.md`).
- **`app/scripts/fixtures/`** holds made-up sample weeks for the selftest. They aren't history and Claude is told to ignore them. `starter-recipes/` is likewise never read when planning.
