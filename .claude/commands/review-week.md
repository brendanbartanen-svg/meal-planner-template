---
description: Close out the week — update stats, surface insights, prep for next plan
---

Close out the current week.

> The app's Week tab has a "Close out the week" button running `app/prompts/review.md` (it folds pending app captures itself). Use this command as the desktop fallback.

1. Read the week's plan file. If the Log table has gaps, ask the user to fill them before closing — conversational reporting or `/log-meal` both work.
2. Update each cooked recipe's frontmatter in `recipes/`: recompute `rating` (running average), increment `times_cooked`, set `last_cooked`.
3. Write the Week review section of the plan file:
   - Adherence: planned vs. cooked, and why deviations happened
   - Nutrition: rough week average vs. targets in preferences (at the tracking depth the user chose)
   - Ratings: standouts (4–5s → rotation candidates) and misses (≤2 → retired)
   - Carryover: unused ingredients and freezer items for next week's plan to use
4. Look for preference signals across recent weeks (repeated rejection reasons, consistently low ratings for a cuisine/method, "too much time on weeknights" patterns) and append dated entries to the Learned preferences section of `profile/preferences.md`.
5. Set the plan status to `complete` and update `profile/pantry.md` freezer inventory for anything used or added.
6. Offer to run `/plan-week` for the coming week, listing the carryover items it should build around.
7. Sync: `git pull` happened at start; commit and push the closed-out week (see CLAUDE.md sync rules).

$ARGUMENTS
