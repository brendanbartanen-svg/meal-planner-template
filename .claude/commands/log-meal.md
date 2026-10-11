---
description: Log what actually got cooked and rate it (1–5)
---

Log cooked meals for the current week's plan.

> Logging normally happens on the app's day cards (instant capture, then a background fold run — `app/prompts/fold.md` — writes the Log tables). Use this command for conversational logging or when the app is down; reconcile against what is already in the Log tables the same way the fold run does (don't double-count).

1. Parse what the user reported: $ARGUMENTS
   (If empty or ambiguous, show the current week's plan table and ask which days they're logging.)
   Match each reported meal to its plan file by date — entries can span multiple weeks. Route by week id: weeks run Saturday→Friday and the id is the ISO week of date+2 days (a Sat/Sun both roll forward into the Monday their Sat–Fri span contains). Reconcile against what's already logged rather than double-counting; only fill gaps or correct differences, and say which entries were already recorded.
2. For each logged meal, fill the plan file's Log table: what was actually cooked (planned dish, substitution, takeout, or skipped), the 1–5 rating, and any notes (portion size, tweaks, complaints).
3. If they made a modification worth keeping ("added more lime, better"), append it to the recipe file's Notes section immediately.
4. If a planned meal was skipped and its ingredients are unused, note them as available — suggest carrying the meal into next week's plan.
5. Don't update recipe frontmatter stats yet — that happens in `/review-week`.

Multiple days can be logged at once ("Mon and Tue as planned, both 4s; Wed we ordered pizza").

Sync: `git pull` before touching files; commit and push after logging (see CLAUDE.md sync rules).
