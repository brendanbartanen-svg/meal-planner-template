Rescale one meal of the locked plan for {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

The user moved **{{RESCALE_DAY}}** ({{RESCALE_DISH}}) from {{OLD_SERVINGS}} to **{{NEW_SERVINGS}} servings** with the servings control in the app. The week is locked and its list may already be partly shopped, so make the smallest consistent edit to `plans/{{WEEK}}.md`:

1. **Plan table:** set {{RESCALE_DAY}}'s Servings cell to `{{NEW_SERVINGS}}`. If the table has no Servings column yet, add it right after Recipe (header, separator and every row: `4` for the other cook nights, empty for flexible nights). Change nothing else in the table.
2. **Grocery list:** update only the lines this meal uses: quantities, pack counts (cans, bags, packs), and the store when the new quantity now fits a bulk pack size at the primary store (or no longer needs one). A line shared with other nights (lemons, onions, oil) changes by this meal's difference only. Keep the exact structure (`### Store` headings, `**Section**` bold lines, `- [ ]` items) and each line's note of which nights use it. Leave other meals' lines alone.
3. **Bulk notes:** update any note about this meal's items (pack math, leftovers, the freezer plan; reflect a planned freeze in `profile/pantry.md`).
4. **Prep timeline:** change it only if a pack size or count changes a task (thaw two bags instead of one, say). Otherwise leave it.
5. **Never touch the recipe file.** The Cook tab scales it from the Servings cell. Do not write scaled quantities into the recipe's Notes or into the planning notes.

This meal's ingredient lines, computed by the app from the recipe file. At the old {{OLD_SERVINGS}} servings (what the current list was built from):

{{OLD_SCALED_INGREDIENTS}}

At the new {{NEW_SERVINGS}} servings:

{{SCALED_INGREDIENTS}}

Take the new quantities from these scaled lines; do not re-derive them. Source tags still state pack sizes at base scale, so compute pack counts from the scaled amount.

Commit and push. Final message: one or two lines naming the meal, its new servings, and what changed on the list (e.g. "Saturday's salmon is now 8 servings: salmon 3 lb, coconut cream 2 cans, green beans moved to the primary store's 2-lb bag.").
In your final message, name weeks the way a person does: by their dates ("Oct 17–23", "the week of Oct 17") or as "this week" / "next week", never by the week id (`2026-W43`, `W43`). Ids stay exactly as they are in the files, headings and tables you write.
