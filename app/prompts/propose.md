Propose the meal plan for {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

Follow `.claude/commands/plan-week.md` steps 1–3 and every planning rule in CLAUDE.md (hard-nos, nutrition direction, recipe- and protein-level repeat gaps, new-vs-favorite ratio, weeknight time caps), with these app-mode adjustments:

1. Read `profile/preferences.md`, `profile/pantry.md` (use up the freezer), and the last 2–3 weekly files in `plans/`.
2. **Pending log captures from the app** — ratings/notes the user has tapped that are not yet folded into plan files. Treat these as authoritative recent signal for planning (do NOT write them into log tables in this run; a separate fold run owns that):
{{CAPTURES}}
3. Create `plans/{{WEEK}}.md` from `plans/TEMPLATE.md` with `**Status:** planning`.
4. The Plan table must keep the exact template columns. Per-meal Status is `proposed` (flexible nights use `—`). In the Recipe column:
   - proven recipes: `[Name](../recipes/file.md)` plus `⭐N` (current rating);
   - new recipes: plain name plus `🆕` — do **not** create recipe files yet (that happens at lock).
5. Under `### Planning notes`, write **one bullet per cook night, starting with the bolded day** — `- **Sat:** why this pick, in one or two sentences` — the app renders these as per-meal rationale. Add any further non-day bullets after them.
6. Leave the Prep timeline section as its placeholder and do not write a grocery list — both are generated at lock.
7. User constraints for this week: {{NOTE}}

Commit and push when done. Your final message: a 3–5 sentence summary of the proposed week (shape, what's new, what carried over) — the user approves or rejects individual meals in the app afterward.
