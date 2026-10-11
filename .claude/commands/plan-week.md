---
description: Propose next week's meal plan for approval
---

Plan the upcoming week's meals.

> The app (`app/`, Next tab) is the primary way this happens — its `app/prompts/propose.md`/`revise.md`/`lock.md` are the app-mode translation of this command. Use this command as the desktop fallback; keep the two consistent if either changes.

1. Read `profile/preferences.md`, `profile/pantry.md` (especially the freezer inventory — use up what's there), and the last 2–3 weekly files in `plans/` (ratings, rejections, repeat gaps, carryover bulk items).
2. Determine which week is being planned: weeks run Saturday→Friday, and the file id is the ISO week of the Monday the span contains — i.e. the ISO week of date+2 days for any date in the span. Create `plans/YYYY-Wnn.md` from `plans/TEMPLATE.md` with status `planning`.
3. Propose the week's meals per the cadence in preferences. Follow all planning rules in CLAUDE.md (hard-nos, nutrition targets, repeat gaps, new-vs-favorite ratio, time budgets by day of week). For each proposal show: day, dish, one-line description, active time, calories + protein per serving, and whether it's a proven favorite (with rating) or new.
4. Ask the user to approve/reject/swap each meal. Iterate — replace rejections (recording the reason in the plan file) until every slot is approved.
5. When the plan is locked: set status to `locked`, create `recipes/` files for any new recipes (full ingredients, steps, nutrition frontmatter, `prep_ahead` if the recipe needs thawing/marinating/an early start), and generate the plan's **Prep timeline** from every recipe's `prep_ahead`: each task dated to the day it's DUE, not the day the meal happens — a 24 h thaw for Sunday's dinner is a Saturday task; prep may be due before the week starts (the Friday before shop day), and such pre-week tasks are fine (also account for freezer items needing thaw). Then tell the user to run `/grocery-list`.

Sync: `git pull` before starting; commit and push when the plan is locked (see CLAUDE.md sync rules).

If the user gave input with the command (e.g., "plan around us being gone Wed–Thu", "use up the frozen salmon"): $ARGUMENTS
