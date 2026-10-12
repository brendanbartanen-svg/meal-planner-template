# Selftest fixtures

Files read by `app/scripts/selftest.ts` (`npm run selftest`). They are **test data, not anyone's live record** — never treat them as past weeks when planning, and never copy them into `plans/` or `recipes/`.

## Synthetic plan weeks + recipe (the parser suite)

The parser suite is source-aware. In a repo with real history (`plans/2026-W31.md` exists) it reads the real `plans/2026-W29…W31.md` and `recipes/goulash.md`; everywhere else (the shareable template, a fresh install) it reads these synthetic samples instead. The selftest prints which source ran.

- `2026-W29.md` — the minimal shape: no Prep timeline, no Planning notes.
- `2026-W30.md` — a `complete` week: filled Log table (including `—` ratings) and a written Week review.
- `2026-W31.md` — a `locked` week: ⭐/🆕 markers, Planning notes, Flexibility note, Prep timeline with dated labels, a two-store grocery list (`Warehouse club`, `Supermarket`), Pantry check, Bulk notes.
- `carnitas.md` — recipe frontmatter: nested `nutrition_per_serving`, quoted `prep_ahead` items, running stats.

The week ids are deliberately from before 2026-08-08: the server's week scheme (`app/server/weeks.ts`) treats weeks up to 2026-W31 as Monday→Sunday and everything from 2026-W33 on as Saturday→Friday, and the selftest covers both sides of that boundary. Every week a fresh install creates is Saturday→Friday.

## Byte-for-byte snapshots (exact-value suites)

Taken 2026-10-11 from the original household's repo, so later edits to the live library or pantry can't break exact-value checks (the suites that sweep the live `recipes/`, `plans/` and `profile/pantry.md` are shape-only and skip what isn't there):

- `pantry-2026-10-11.md` — `profile/pantry.md` for the pantry editor suite (`server/pantry.ts`).
- `recipe-*-2026-10-11.md` — recipes for the scaler, headline and Cook-tab section suites (`server/scale.ts`, `server/recipe-sections.ts`) and the lock/rescale prompt builder.
- `import-jsonld-page.html` — a recipe web page with JSON-LD for the import reducer (`server/import.ts`).

If you change a format in `plans/TEMPLATE.md`, `recipes/README.md` or the run prompts, update these files and the selftest together.
