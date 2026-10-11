---
description: Build the shopping list from the locked weekly plan
---

Generate the grocery list for the current locked plan in `plans/`.

> The app's **lock** run builds the list as part of locking (`app/prompts/lock.md`), and the Shop tab displays it. Use this command as the desktop fallback.

1. Read the locked plan, every linked recipe file, `profile/pantry.md`, and the Shopping section of `profile/preferences.md` (store names, household size, serving count).
2. Aggregate all ingredients across the week's recipes, scaled to the serving count set in preferences.
3. Subtract pantry staples. Separately list pantry items that recipes rely on heavily this week under "Pantry check" so the user can verify they're not low.
4. Split by store per CLAUDE.md rules: primary store first; secondary store only for what the primary doesn't carry or only sells in impractical bulk. For each secondary-store item, note why. Organize each store by section, with quantities. Keep the exact structure the app parses: `### {store name}` headings, `**Section**` bold lines, `- [ ]` items.
5. Apply bulk logic: if a pack size far exceeds the week's need, either note the freezer plan (and add the surplus to `profile/pantry.md` freezer inventory) or flag that a future week should reuse the item.
6. Write the list into the plan file's Grocery list section with checkboxes, and show it to the user.

Sync: `git pull` before starting; commit and push after the list is done (see CLAUDE.md sync rules).

Adjustments requested with the command: $ARGUMENTS
