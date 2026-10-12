---
description: Propose next week's meal plan for approval
---

Plan the upcoming week's meals.

> Since 2026-08-01 the app (`app/`, Next tab) is the primary way this happens — its `app/prompts/propose.md`/`revise.md`/`lock.md` are the app-mode translation of this command. Use this command as the desktop fallback; keep the two consistent if either changes.
> The app also chains steps: **close-and-plan** (Week tab: close out the cooking week, then propose this one, with cook nights + constraints given up front) and **send-and-lock** (Next tab: revise, then lock straight away, replacements auto-approved). Desktop does the same steps one at a time.

1. Read `profile/preferences.md`, `profile/pantry.md` (especially the freezer inventory — use up what's there), and the last 2–3 weekly files in `plans/` (ratings, rejections, repeat gaps, carryover bulk items).
2. Determine which week is being planned: weeks run Saturday→Friday, and the file id is the ISO week of the Monday the span contains — for any date on/after 2026-08-08 that's the ISO week of date+2 days; before that, the plain ISO week of the date. Through 2026-W31 weeks ran Mon–Sun; 2026-W32 was truncated to Mon–Fri at the cutover. Create `plans/YYYY-Wnn.md` from `plans/TEMPLATE.md` with status `planning`.
3. Propose the week's meals per the cadence in preferences. Follow all planning rules in CLAUDE.md (hard-nos, nutrition targets, repeat gaps, new-vs-favorite ratio, time budgets by day of week). For each proposal show: day, dish, one-line description, active time, calories + protein per serving, and whether it's a proven favorite (with rating) or new. Write each meal's servings in the Plan table's **Servings** column (`4` by default, or what the user asks for; empty for flexible nights) and nowhere else; files from before the column parse as 4.
4. Ask the user to approve/reject/swap each meal. Iterate — replace rejections (recording the reason in the plan file) until every slot is approved.
5. When the plan is locked: set status to `locked`, create `recipes/` files for any new recipes (full ingredients, steps, nutrition frontmatter, a one-sentence `description: "…"` right after `name:` per `recipes/README.md`, `prep_ahead` if the recipe needs thawing/marinating/an early start), and generate the plan's **Prep timeline** from every recipe's `prep_ahead`: each task dated to the day it's DUE, not the day the meal happens — a 24 h thaw for Sunday's dinner is a Saturday task; prep may be due before the week starts (the Friday before shop day), and such pre-week tasks are fine (also account for freezer items needing thaw). Then tell the user to run `/grocery-list`.

Sync: `git pull` before starting; commit and push when the plan is locked (see CLAUDE.md sync rules).

If the user gave input with the command (e.g., "plan around us being gone Wed–Thu", "use up the frozen salmon"): $ARGUMENTS
