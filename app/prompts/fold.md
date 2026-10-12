Fold the app's pending meal-log captures into the plan files. Today is {{TODAY}}.

Pending captures (each is one date's dinner: optional `dish` = what actually got cooked when it differs from the plan or is free text like "ordered pizza", or `skipped — <reason>` from the app's "Didn't cook" button; optional 1–5 `rating`; optional `note`; optional `minutes` = about how long it took to cook, from the app's "took about…" chips; `by` = who logged it):

{{CAPTURES}}

Routing table — the plan file each capture date belongs to, computed by the app:

{{ROUTING}}

Per `.claude/commands/log-meal.md` rules, app-mode:

1. Place each capture using the routing table **verbatim**. Never work out the week yourself: weeks are no longer ISO Monday–Sunday (from `2026-W33` they run Saturday→Friday), so deriving a file from the date puts Saturday and Sunday rows in the wrong week. A date routed to a file marked `(missing …)` gets no edit at all — leave that capture pending and say so at the end.
2. Fill that date's row in the file's **Log table**: Actually cooked (`as planned` when the planned dish was cooked and no dish override was given; otherwise the override — substitutions, takeout, `skipped — …`), the rating, and the note. When a capture has `minutes`, prepend `(took ~N min)` to the Log-table note — `(took ~60 min) more lime next time`, or just `(took ~60 min)` when there is no note — and append nothing else for it.
3. **Reconcile, don't duplicate**: if a row already has content, only fill gaps or correct genuine differences — an identical re-send is expected and is a no-op.
4. If a note records a modification worth keeping ("added more lime, better"), append it to that recipe file's Notes section with the date.
5. Do NOT update recipe frontmatter stats (rating/times_cooked/last_cooked) — `/review-week` owns that.
6. If a capture's date has no planned meal in its file (a flexible night, say), add a row for it in that file's Log table rather than dropping it.

Commit and push. Final message: one line per capture folded ("Wed Jul 30 · Harissa salmon — 5, noted"), "already recorded" where reconcile found nothing new, or "left pending — no plan file yet" for anything the routing table marked missing.
In your final message, name weeks the way a person does: by their dates ("Oct 17–23", "the week of Oct 17") or as "this week" / "next week", never by the week id (`2026-W43`, `W43`). Ids stay exactly as they are in the files, headings and tables you write.
