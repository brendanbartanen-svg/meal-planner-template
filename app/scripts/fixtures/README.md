# Selftest fixtures

Sample plan and recipe files read by `app/scripts/selftest.ts` (`npm run selftest`). They are **synthetic sample data, not anyone's history** — never treat them as past weeks when planning, and never copy them into `plans/` or `recipes/`.

They exist to pin the file formats the server's parser depends on:

- `2026-W29.md` — the minimal shape: no Prep timeline, no Planning notes.
- `2026-W30.md` — a `complete` week: filled Log table (including `—` ratings) and a written Week review.
- `2026-W31.md` — a `locked` week: ⭐/🆕 markers, Planning notes, Flexibility note, Prep timeline with dated labels, a two-store grocery list, Pantry check, Bulk notes.
- `carnitas.md` — recipe frontmatter: nested `nutrition_per_serving`, quoted `prep_ahead` items, running stats.

The week ids are deliberately from before 2026-08-08: the server's week scheme (`app/server/index.ts`, "week scheme" block) treats weeks up to 2026-W31 as Monday→Sunday and everything from 2026-W33 on as Saturday→Friday, and the selftest covers both sides of that boundary. Every week a fresh install creates is Saturday→Friday.

If you change a format in `plans/TEMPLATE.md` or the run prompts, update these files and the selftest together.
