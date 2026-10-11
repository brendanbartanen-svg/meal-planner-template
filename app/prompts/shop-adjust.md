Adjust the grocery list for {{WEEK}} ({{DATES}}). Today is {{TODAY}}.

The user asked, from the Shop tab: {{NOTE}}

Apply the request to the Grocery list section of `plans/{{WEEK}}.md`:

- Keep the exact structure (`### Store` headings, `**Section**` bold lines, `- [ ]` items) — the app parses it.
- Adding items: put them in the right store per CLAUDE.md rules (primary store first; secondary store for small quantities or what the primary lacks) with sensible quantities for the household size and serving count in preferences.
- Removing ("we already have X"): delete the line; if it's a pantry item worth tracking, reflect it in `profile/pantry.md` instead of silently dropping.
- If the request implies a meal change rather than a list tweak, make the minimal consistent edit (meal row, prep timeline, list) and say so in the final message.

Commit and push. Final message: one or two lines — what was added/removed and where.
