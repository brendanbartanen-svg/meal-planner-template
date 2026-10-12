Lock the meal plan for {{WEEK}} ({{DATES}}) and build its grocery list. Today is {{TODAY}}.

Last-mile feedback state from the app (any `approve` decisions here cover meals whose table Status still says `proposed`):

{{FEEDBACK}}

First verify every non-flexible meal is approved (table Status `approved` or an `approve` decision above). If any meal is neither, DO NOT lock — change nothing, and make your final message a one-line explanation of which days still need a decision.

Otherwise, in `plans/{{WEEK}}.md` and per `.claude/commands/plan-week.md` step 5 + `.claude/commands/grocery-list.md`:

1. Set every approved meal's Status to `approved` and the plan to `**Status:** locked (locked {{TODAY}} via app)`. Write each cook night's **Servings** cell: the `servings` number from the feedback above where there is one, otherwise keep the cell (`4` if it is empty). If the file predates the Servings column, add it right after Recipe (header, separator and every row; empty for flexible nights). Servings live only in the column, never in a prose line. When a meal's Servings is not 4, update that day's `- **Day:**` bullet under `### Planning notes` so any quantities it mentions are at the new scale; never leave base-scale figures next to scaled ones.
2. Create `recipes/` files for any 🆕 recipes, matching the existing files' format exactly: full frontmatter (name, cuisine, protein, method, times, servings, nutrition_per_serving, `prep_ahead` when the recipe needs thawing/marinating/an early start, rating omitted until first cook, times_cooked 0), ingredients with source tags per the legend in `recipes/README.md`, a `## Prep` section between Ingredients and Steps (the whole mise en place as `- ` bullets with `**Component:**` labels, ingredient names not amounts), `prep_min` right after `total_time_min`, steps at the user's skill level that assume the prep is done, and honest times per `recipes/README.md` (`active_time_min` = prep + hands-on cooking for one cook, rounded up to 5), empty Notes section. Write the recipe at `servings: 4` even when this week's Servings cell says more (the app scales it), and write every ingredient line in the scalable format in `recipes/README.md`: the main ingredient on the first line (the protein or the dish's defining component, never oil or aromatics), quantity and unit first, digits not words, equivalents and pack counts inside the source tag (never in parentheses), and steps that name ingredients rather than repeat amounts. Then convert their Plan-table cells to `[Name](../recipes/file.md) 🆕` links.
3. Generate the **Prep timeline** from every recipe's `prep_ahead`: each task a `- [ ]` line dated to the day it is DUE, not the day it pays off — a 48 h thaw for Monday's dinner lands on Saturday; prep may be due before the week starts (the Friday before shop day), and such pre-week tasks are fine (freezer items need thaw time too). Use the `**Ddd D, time:** task` label format from recent weeks.
4. Build the **Grocery list** exactly per CLAUDE.md shopping rules: aggregate across the week from the pre-scaled ingredient lines below, subtract pantry staples, one `### {store name}` heading per store using the names in `profile/preferences.md` → Shopping — primary store first, secondary store only for what the primary doesn't carry sensibly (note why), `**Section**` bold headings, `- [ ]` items with quantities and which nights use them, `### Pantry check` for heavy pantry draws to verify, `### Bulk notes` for pack-size math and the freezer plan (update `profile/pantry.md` freezer inventory for planned freezes). Items in `profile/pantry.md` marked ` ⚠️ low (date)` go into the `### Pantry check` section, or onto a store list if this week's meals need them.

   **Pre-scaled ingredient lines**, one block per cook night at that night's servings. The app computed them from each recipe file; a 🆕 meal with no file yet states the factor to apply to the recipe you write in step 2.

{{SCALED_INGREDIENTS}}

   Build the grocery list from these scaled lines; do not re-derive quantities. Source tags still state pack sizes at base scale, so compute pack counts (cans, bags) from the scaled amount.
5. **Extra items the household added in the app** — fold these into the right store sections (they may be non-meal household items; a plain "Extras" section at the end of a store is fine for those):
{{EXTRAS}}

Commit and push. Final message: 3–5 sentences — the locked week's shape, the headline shopping numbers (items per store), and the first prep deadline coming up.
