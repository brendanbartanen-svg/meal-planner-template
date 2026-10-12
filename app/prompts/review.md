Close out week {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

**First**, fold any pending app captures into log tables (same rules as the fold run — reconcile-don't-duplicate, notes worth keeping go to recipe Notes, a capture's `minutes` becomes a `(took ~N min)` prefix on its Log-table note, a `skipped — <reason>` dish goes in Actually cooked as written):

{{CAPTURES}}

Route each capture to its plan file by this table, never by computing the ISO week of the date (weeks run Saturday→Friday from `2026-W33`); a file marked `(missing …)` means leave that capture pending:

{{ROUTING}}

Then run the full close-out per `.claude/commands/review-week.md`:

1. Update each cooked recipe's frontmatter in `recipes/`: recompute `rating` (running average), increment `times_cooked`, set `last_cooked`. A night logged `skipped — …` was not cooked: no stats change for it. If the week's log notes carry `(took ~N min)` for a recipe, nudge its `active_time_min` toward the observed value (average it with the current estimate, round to 5) and mention it in the review.
2. Write the **Week review** section of `plans/{{WEEK}}.md`: adherence (planned vs cooked, why deviations happened), nutrition (use the computed numbers below) vs the directional targets in preferences, standouts (4–5s → rotation candidates) and misses (≤2 → retire), carryover ingredients/freezer items for next week.
   Computed numbers for this and prior weeks (use them, don't estimate): {{TRENDS}}
3. Look for preference signals across recent weeks (recurring rejection reasons, rating patterns, time-budget friction) and append dated entries to `profile/preferences.md` → Learned preferences.
4. Set the plan to `**Status:** complete · closed {{TODAY}} (via app)` and update `profile/pantry.md` freezer inventory for anything used or added.
5. If some planned night is genuinely unlogged even after folding the captures above, log it as `skipped — unrecorded` rather than blocking, and flag it in your final message.

Commit and push. Final message: the week in 4–6 sentences — adherence, the standout and the miss, what carries into next week's plan.
