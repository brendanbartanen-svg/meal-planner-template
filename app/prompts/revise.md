Revise the meal plan for {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

The user reviewed the proposal in the app. Their feedback (per-meal decisions and/or a week-level note; `by` names who said it):

{{FEEDBACK}}
{{AUTO_APPROVE}}
Additional note sent with this request: {{NOTE}}

Apply it to `plans/{{WEEK}}.md`:

1. Meals marked `approve`: set their Plan-table Status to `approved`. Leave the dish unchanged.
2. Meals marked `reject`: replace with a new proposal (Status `proposed`) that respects the stated reason, and record the rejected dish + reason under `### Rejected during planning` (reasons are preference signals). If a rejection reason looks like a recurring signal, note it — `/review-week` folds those into preferences.
3. Meals marked `swap`: replace per the request (Status `proposed`).
4. Meals with a `servings` number (set on the Next tab, independent of the decision): write it into that day's Plan-table **Servings** cell. A replacement meal on that day keeps it unless the user's note says otherwise; meals without one keep their cell (`4` if empty). If the file predates the Servings column, add it right after Recipe (header, separator and every row: `4` for cook nights unless set here, empty for flexible nights). Servings live only in the column, never in a prose line.
5. Week-level notes may ask for anything (reshuffle days, lighter meals, use an ingredient, more servings of a meal) — apply them across the plan.
6. Keep every planning rule in CLAUDE.md (repeat gaps, protein-level gaps, time caps, new-recipe ratio). Keep the per-meal `- **Day:** why` bullets under `### Planning notes` in sync with any changed meals.
7. If the plan is already `**Status:** locked`, this is a post-lock change request: apply it, keep status `locked`, and update the Prep timeline and Grocery list sections so they stay consistent with the new meals (note at the bottom of the grocery list what changed, so a list already shopped against stays auditable).

Do not create recipe files for new proposals (that happens at lock). Commit and push. Final message: what changed and why, in a few bullets.
In your final message, name weeks the way a person does: by their dates ("Oct 17–23", "the week of Oct 17") or as "this week" / "next week", never by the week id (`2026-W43`, `W43`). Ids stay exactly as they are in the files, headings and tables you write.
