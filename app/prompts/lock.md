Lock the meal plan for {{WEEK}} ({{DATES}}) and build its grocery list. Today is {{TODAY}}.

Last-mile feedback state from the app (any `approve` decisions here cover meals whose table Status still says `proposed`):

{{FEEDBACK}}

First verify every non-flexible meal is approved (table Status `approved` or an `approve` decision above). If any meal is neither, DO NOT lock — change nothing, and make your final message a one-line explanation of which days still need a decision.

Otherwise, in `plans/{{WEEK}}.md` and per `.claude/commands/plan-week.md` step 5 + `.claude/commands/grocery-list.md`:

1. Set every approved meal's Status to `approved` and the plan to `**Status:** locked (locked {{TODAY}} via app)`.
2. Create `recipes/` files for any 🆕 recipes, matching the existing files' format exactly: full frontmatter (name, cuisine, protein, method, times, servings, nutrition_per_serving, `prep_ahead` when the recipe needs thawing/marinating/an early start, rating omitted until first cook, times_cooked 0), ingredients with [1]/[2]/[P] source tags (primary store / secondary store / pantry), steps at the user's skill level, empty Notes section. Then convert their Plan-table cells to `[Name](../recipes/file.md) 🆕` links.
3. Generate the **Prep timeline** from every recipe's `prep_ahead`: each task a `- [ ]` line dated to the day it is DUE, not the day it pays off — a 48 h thaw for Monday's dinner lands on Saturday; prep may be due before the week starts (the Friday before shop day), and such pre-week tasks are fine (freezer items need thaw time too). Use the `**Ddd D, time:** task` label format from recent weeks.
4. Build the **Grocery list** exactly per CLAUDE.md shopping rules: aggregate across the week at the serving count set in preferences, subtract pantry staples, one `### {store name}` heading per store using the names in `profile/preferences.md` → Shopping — primary store first, secondary store only for what the primary doesn't carry sensibly (note why), `**Section**` bold headings, `- [ ]` items with quantities and which nights use them, `### Pantry check` for heavy pantry draws to verify, `### Bulk notes` for pack-size math and the freezer plan (update `profile/pantry.md` freezer inventory for planned freezes).
5. **Extra items the household added in the app** — fold these into the right store sections (they may be non-meal household items; a plain "Extras" section at the end of a store is fine for those):
{{EXTRAS}}

Commit and push. Final message: 3–5 sentences — the locked week's shape, the headline shopping numbers (items per store), and the first prep deadline coming up.
