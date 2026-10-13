# Starter recipes

A starter library for a fresh install: tested dinners from the template author's kitchen, written in the
house format (`recipes/README.md`). Ratings, cook counts and cook-by-cook history were stripped; Notes keep
only technique. Source tags use the template's codes: `[1]` primary store, `[2]` secondary store,
`[P]` pantry.

**Importing.** While any of these is not yet in `recipes/`, the app's Recipes tab shows a **Starter
library** card: tick what suits you and import. Importing copies the files into `recipes/` unchanged and
commits them; anything already in `recipes/` is skipped, never overwritten. Without the app, from `app/`:

    npm run starter              # list them
    npm run starter -- --all     # import everything not yet in recipes/
    npm run starter -- goulash red-lentil-dal

**Pictures.** `images/` holds each recipe's picture (`images/<slug>.jpg`, the recipe's file name without
`.md`). Importing a recipe also copies its picture to `recipes/images/`, where the app shows it; an
existing picture there is left alone.

Imported recipes are yours: edit or delete them like any other recipe.

**Delete this folder when you are done with it.** The app never reads it for planning (only `recipes/`
is the library), and once it is gone the Starter library card goes away.
