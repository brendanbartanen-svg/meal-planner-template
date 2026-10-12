Suggest new recipe ideas for the household. Today is {{TODAY}}.

This feeds the Recipes tab's optional **Ideas** section: a browsable shortlist where the user taps **Queue** (the next proposal schedules it when it fits) or **Not for me**. Nothing here is planned or filed: write no recipe files and do not touch `plans/`.

1. Read `profile/preferences.md` in full (tastes, spice setting, hard-nos, protein-level gaps, nutrition direction, logistics, equipment, and every Learned preferences entry, especially the flavor-lane rule and the notes on what lands), `profile/pantry.md`, the recipe library (`recipes/*.md` frontmatter: name, rating, times_cooked, last_cooked, cuisine, protein; skim Notes for what worked), and the last 4 weekly files in `plans/` (ratings, log notes, rejected-during-planning reasons).
2. What the app knows about earlier ideas:

{{IDEAS_STATE}}

3. Pick **8 dishes that are not in the library** and appear in none of the lists above (no near-duplicates either: a new salmon dish in the same flavor lane as a filed salmon recipe counts as a repeat). Rules:
   - Never anything on the hard-no list. Follow the nutrition direction (mostly-Mediterranean lean, vegetables forward, red meat occasional) and the spice setting (flavor-forward: built-in heat or a punchy finishing sauce, every component seasoned in its own right).
   - Protein lanes: at least 2 fish/seafood, at least 2 plant-protein (beans, lentils, chickpeas, tofu, paneer), at least 2 chicken, at most 1 red meat (a weekend braise or project only).
   - Flavor lanes (per Learned preferences: tomato-Mediterranean, Asian, citrus/herb, Indian, braise/comfort): no more than 2 dishes per lane, and at least 2 of the fish dishes outside the tomato-Mediterranean default (the fish lane is thin).
   - Effort: at least 4 weeknight dishes at ≤45 min active; the rest may be weekend projects that use the kamado, Blackstone, sous vide or Dutch oven.
   - Real, cookable dishes a confident home cook would recognize, cooked at 4 servings for the household in preferences, with ingredients from the household's stores (preferences → Shopping). Vary the sides too (not roasted broccoli and potatoes).
   - Make every "why you" specific: tie it to a named recipe's rating, a log note, or a Learned preferences entry ("the harissa salmon ⭐5 says…"), never generic praise.
4. Write `profile/ideas.md`. The app parses it line by line, so keep this shape exactly.
   - If the file does not exist, create it starting with:

     ```
     # Ideas

     Suggestions from the app's ideas run, newest batch first. Queue one on the Recipes tab and the next proposal schedules it.
     ```

   - Insert the new batch directly under that intro, above every older batch, and leave older batches unchanged:

     ```
     ## Batch {{TODAY}}
     - **Dish Name** · protein · cuisine · ~N min active — one-sentence pitch. Why you: one sentence tied to his ratings or notes.
     ```

     Exactly 8 item lines, one per line, no blank lines between them, no sub-bullets, no other text inside the batch. `protein` is a short lane (`salmon`, `white fish`, `shrimp`, `chicken thighs`, `chickpeas`, `tofu`); `cuisine` is a word or two (`Indian`, `Thai`, `Greek`); N is honest active minutes for one cook doing everything, rounded up to 5. The pitch says what the dish is and what makes it good. Keep the `·` (middle dot) separators, the em dash before the pitch, and the literal `Why you:` label. Dish names must be unique within the file.
   - If a batch dated {{TODAY}} already exists, add yours as another `## Batch {{TODAY}}` above it; do not merge them.
5. Commit `profile/ideas.md` and push.

Final message: one or two sentences on the batch's shape (protein and flavor lanes, weeknight vs weekend count), then the 8 dish names as a short bullet list.
