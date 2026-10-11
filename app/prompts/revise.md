Revise the meal plan for {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

The user reviewed the proposal in the app. Their feedback (per-meal decisions and/or a week-level note; `by` names who said it):

{{FEEDBACK}}

Additional note sent with this request: {{NOTE}}

Apply it to `plans/{{WEEK}}.md`:

1. Meals marked `approve`: set their Plan-table Status to `approved`. Leave the dish unchanged.
2. Meals marked `reject`: replace with a new proposal (Status `proposed`) that respects the stated reason, and record the rejected dish + reason under `### Rejected during planning` (reasons are preference signals). If a rejection reason looks like a recurring signal, note it — `/review-week` folds those into preferences.
3. Meals marked `swap`: replace per the request (Status `proposed`).
4. Week-level notes may ask for anything (reshuffle days, lighter meals, use an ingredient) — apply them across the plan.
5. Keep every planning rule in CLAUDE.md (repeat gaps, protein-level gaps, time caps, new-recipe ratio). Keep the per-meal `- **Day:** why` bullets under `### Planning notes` in sync with any changed meals.
6. If the plan is already `**Status:** locked`, this is a post-lock change request: apply it, keep status `locked`, and update the Prep timeline and Grocery list sections so they stay consistent with the new meals (note at the bottom of the grocery list what changed, so a list already shopped against stays auditable).

Do not create recipe files for new proposals (that happens at lock). Commit and push. Final message: what changed and why, in a few bullets.
