# Recipes

One file per recipe, kebab-case filename (`sheet-pan-chicken-fajitas.md`). A recipe gets a file when it's first approved into a weekly plan. Frontmatter is the machine-readable record; Claude updates `rating`, `times_cooked`, and `last_cooked` during `/review-week`.

## Format

```markdown
---
name: Sheet-Pan Chicken Fajitas
description: "Chili-rubbed chicken thighs roasted with sweet peppers and onion on one pan, tucked into warm flour tortillas with a squeeze of lime."
cuisine: mexican
protein: chicken-thigh
method: [sheet-pan, oven]
active_time_min: 25   # prep + hands-on cooking, one cook, rounded up to 5 (see "Times are honest")
total_time_min: 45    # start to plate, passive time included
prep_min: 15          # the ## Prep section alone, one confident cook, rounded up to 5
servings: 4           # house default; the app scales from here
nutrition_per_serving:
  calories: 520
  protein_g: 42
  carbs_g: 38
  fat_g: 22
  fiber_g: 7
prep_ahead:           # omit if none — tasks that must happen BEFORE cook day/time
  - "thaw (if frozen): fridge, 24 h"
  - "marinate: morning-of"
  - "start_by: ~3 pm for a 6:30 dinner"
rating: null          # running average of 1–5 ratings
times_cooked: 0
last_cooked: null
source: original      # or URL
---

## Ingredients
<!-- Mark sourcing: [1] primary store, [2] secondary store, [P] pantry — store letters are declared in profile/preferences.md → Shopping -->
- 2 lb boneless skinless chicken thighs [1 — 6-lb pack; the other 4 lb freeze in 2-lb bags]
- 3 bell peppers, sliced [1 — 6-pack]
- 1 large yellow onion, sliced [P]
- 2 tbsp olive oil [P]
- **Spice rub:** 2 tsp chili powder [P] · 1 tsp ground cumin [P] · 1 tsp kosher salt [P]
- 8 flour tortillas [2]
- Juice of 1 lime, plus wedges from a second [2]
- Kosher salt and black pepper [P]

## Prep
- Oven to 425°F.
- **Chicken:** slice the thighs into strips.
- **Veg:** slice the peppers and onion; toss them and the chicken with the oil and the spice rub.
- Juice the lime, cut the wedges; tortillas wrapped in foil.

## Steps
1. Spread everything on a sheet pan in one layer and roast ...

## Notes
<!-- Cook-to-cook learnings: "double the lime", "less onion next time", timing corrections -->
```

## The description says what the dish is

`description:` sits on the line right after `name:` and is what the Week tab shows on each day card,
so it reads at a glance:

- **One sentence, at most 160 characters**, saying what the dish *is* and how it eats: the main
  component, the key flavors, the side.
- **Always double-quoted** (`description: "…"`), since it usually contains commas and may contain a
  colon. No double quotes inside it.
- **The dish only**: no ratings, no planning, shopping or freezer logistics, no people or store
  names, no times or nutrition, no em dashes. Why a dish was picked for a week belongs in that
  plan's Planning notes, not here.
- Every recipe has one (`npm run selftest` checks the library). Rewrite it when a recipe changes
  enough that it no longer describes the plate.

## Prep comes first

Every recipe has a `## Prep` section between Ingredients and Steps: the whole mise en place, so every
knife, measure and mix job is done before any heat goes on. The Cook tab shows it as a checklist above
the numbered Steps.

- **One `- ` bullet per task, in the order one cook would do them**: long leads first (a same-day
  marinade, rice on, oven or griddle on), then knife work, then measuring and mixing. Typically 4–10.
- **Components get a leading label**: `- **Glaze:** grate the garlic and ginger, whisk everything
  together`. A bold-only line or a `### ` line also works as a group head.
- **Name ingredients, never amounts** ("mince the garlic", "whisk the dressing"): Prep is never scaled.
- **Work goes in Prep, waits go in `prep_ahead`.** Making a marinade is a Prep bullet even when it
  happens the night before (`**Chicken (the night before):** …`); the overnight wait, thawing and
  start-by times stay in frontmatter `prep_ahead`.
- **Steps assume Prep is done**: no "chop the onion" or "meanwhile, mince the garlic" mid-cook. A
  step keeps its technique, timings and doneness cues. A job that naturally fills unattended cooking
  time (toasting bread during a poach) can stay in its step, and a Prep bullet can say "(now, or
  during the braise)".

## Times are honest

The planner holds `active_time_min` against the weeknight cap (≤45 min active, `profile/preferences.md`),
so every time describes one cook doing everything, with no helper:

- **`prep_min`** (right after `total_time_min`): minutes the `## Prep` section takes one confident
  cook, including getting everything out and any marinade made earlier in the day or the night
  before. Rounded up to 5.
- **`active_time_min`**: `prep_min` plus hands-on cooking (searing in batches, stirring, tending the
  griddle, blending, building plates). Rounded up to 5. Unattended roasting, simmering, braising,
  resting and marinade waits don't count.
- **`total_time_min`**: honest start to plate, never less than active: active plus the passive time
  the cook waits through (the braise, the roast, a same-day marinade's 30 min). Waits declared in
  `prep_ahead` (thawing, an overnight or morning-of marinade) are not counted.
- Calibrated 2026-10-11, when the library got its Prep sections: the earlier estimates ran 1.5–2×
  short. Sheet-pan dishes with a long unattended roast rose least; batch-seared and stir-heavy ones
  rose most. Logged "took about N min" times keep nudging `active_time_min` from here.

## Ingredient lines must scale

The app scales every recipe deterministically (`app/server/scale.ts`): the plan's Servings column
sets the factor, the Cook tab shows the scaled list, and the lock and rescale runs build the grocery
list from the scaled lines. The scaler only moves amounts it can read, so new and edited recipes
follow these rules:

- **The first Ingredients line is the main ingredient**: the protein or the dish's defining component
  (`1½ lb salmon fillet`, `1½ cups red lentils`), never oil or aromatics. The Next tab's servings
  preview shows the line naming the frontmatter `protein`, else the first line, so keep them agreeing.
- **Every ingredient line starts with its quantity and unit**: `2 tbsp olive oil`, `1 large yellow
  onion`, `Juice of 1 lime`. To-taste lines (`Kosher salt and black pepper`) are the only exception.
- **Equivalents and pack counts live in the `[store …]` source tag, never in parentheses**:
  `1 cup coconut cream [2 — one 13.5-oz can]`, not `1 cup (one 13.5-oz can) coconut cream`. Tags
  state pack sizes at base scale; whoever shops a scaled meal computes the pack count.
- **If a total matters, make it the lead amount.** Write `4 salmon fillets, ~6 oz each` or
  `1½ lb salmon`, never `1½ lb salmon, 4 × 6 oz`: per-unit sizes and `×` multipliers never scale.
- **Digits, not words**: `2 lemons`, not `two lemons`.
- **An ` — ` breakdown must sum to the lead**: `6 cloves garlic — 4 minced, 2 sliced` scales; a
  breakdown that doesn't add up is left as written.
- **Steps refer to ingredients by name, not amount**, wherever possible ("add the oil", "stir in the
  dill"), because step text is never scaled.
- **Scaled variants never go in Notes.** A bigger or smaller batch is a Servings number on the plan,
  not a second set of quantities in the recipe.
