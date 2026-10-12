Propose the meal plan for {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

Follow `.claude/commands/plan-week.md` steps 1–3 and every planning rule in CLAUDE.md (hard-nos, nutrition direction, recipe- and protein-level repeat gaps, new-vs-favorite ratio, weeknight time caps), with these app-mode adjustments:

1. Read `profile/preferences.md`, `profile/pantry.md` (use up the freezer), and the last 2–3 weekly files in `plans/`.
2. **Pending log captures from the app** — ratings/notes the user has tapped that are not yet folded into plan files. Treat these as authoritative recent signal for planning (do NOT write them into log tables in this run; a separate fold run owns that):
{{CAPTURES}}
3. Create `plans/{{WEEK}}.md` from `plans/TEMPLATE.md` with `**Status:** planning`.
4. The Plan table must keep the exact template columns, including **Servings** (right after Recipe). Per-meal Status is `proposed` (flexible nights use `—`). Servings is `4` for every cook night (the house default) unless the user's constraints below ask for more or fewer on a meal ("make extra salmon for lunches", "feed 6 on Saturday" → `6`, `8`, …); flexible nights leave it empty. The column is the record of servings: do not write a prose line about servings under the table ("All recipes at 4 servings …"). In the Recipe column:
   - proven recipes: `[Name](../recipes/file.md)` plus `⭐N` (current rating);
   - new recipes: plain name plus `🆕` — do **not** create recipe files yet (that happens at lock).
5. Under `### Planning notes`, write **one bullet per cook night, starting with the bolded day** — `- **Sat:** why this pick, in one or two sentences` — the app renders these as per-meal rationale. Add any further non-day bullets after them.
6. Do not write a prep timeline or a grocery list — both are generated at lock — and do not copy the template's placeholder lines into either section: under `## Prep timeline` keep only the HTML comment, with NO task lines (no `- [ ] **Sat, night:** ...`), and under `## Grocery list` keep only the headings and comments, with no `- [ ] ...` placeholder items. The app reads every `- [ ]` line in those sections as a real prep task or grocery item.
7. User constraints for this week: {{NOTE}}
8. Queued from the Recipes tab (Ideas / imported recipes): {{QUEUED_IDEAS}}

Commit and push when done. Your final message: a 3–5 sentence summary of the proposed week (shape, what's new, what carried over) — the user approves or rejects individual meals in the app afterward.
