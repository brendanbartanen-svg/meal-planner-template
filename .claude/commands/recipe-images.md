---
description: Make a picture for every recipe that has none (ChatGPT via Chrome, one chat per image)
---

Make `recipes/images/<slug>.jpg` for every recipe in `recipes/` that has no picture yet.

> **When this runs.** Step 2b of the weekly cadence: after the plan is locked and the grocery
> list is final, never before or during (the picture is not needed for shopping and the lock run
> must not wait on it). After a one-off recipe addition (an import, Ask Claude, a hand-written
> file) it is the last step. It is a manual loop driven from this Mac: it needs Chrome with the
> Claude in Chrome extension and the user's ChatGPT login; no API key is involved. It never runs
> inside an app run.

The conventions (filename, size, the house look, the setting palette, the prompts already used)
are in `recipes/images/README.md`. Read it first; it is the source of truth, this command is the
procedure.

## 1. Find the work

`git pull` first. List the recipes without a picture:

```bash
for f in recipes/*.md; do s=$(basename "$f" .md); [ "$s" = README ] && continue; ls recipes/images/"$s".* >/dev/null 2>&1 || echo "$s"; done
```

Nothing listed → say so and stop. Otherwise show the list and proceed without asking (the user
invoked the command). If `$ARGUMENTS` names slugs, do only those (regenerating an existing picture
is allowed when a slug is named explicitly: move the old file aside first).

## 2. Write each prompt

One prompt per recipe, from the recipe file's `description`, Ingredients and Steps. It says:

- what is in the bowl and how it was cooked, in the words the recipe uses (charred edges, glossy
  glaze, craggy crust, sauce pooling into the rice), the garnish, and the serving vessel;
- the setting, one pick from each palette line in the README (angle · surface · light · vessel ·
  props). Read the last three entries under "Prompts used" and share at most one palette element
  with each of them, so consecutive pictures never look like the same shoot;
- the fixed tail: realistic editorial food photograph, not an illustration; no text, labels, people
  or hands; square 1:1.

Keep every prompt under ~900 characters (ChatGPT's composer takes it in one go).

## 3. Generate, one ChatGPT chat per image

Use Claude in Chrome (load its tools in one ToolSearch call: `tabs_context_mcp, navigate,
computer, find, tabs_create_mcp, tabs_close_mcp`). For each recipe:

1. New tab → `https://chatgpt.com/` → wait ~3 s → screenshot. A fresh chat drops text typed within
   ~2 s of load, so: click the composer, then in a second call type `Generate an image. ` + the
   prompt, screenshot to confirm the text is in the box, then press Return.
2. Wait 60–90 s (several `wait` actions). `find` the "Generated image 1" button, click it to open
   the viewer, `find` its **Download** button, click it, wait 4 s, press Escape, close the tab.
   The download is the only way out: the image's signed URL cannot be passed back through the
   Chrome tools. Chrome saves a ~1250 px PNG to `~/Downloads` under ChatGPT's own title.
3. Immediately move the newest `~/Downloads/*.png` to a scratch folder as `<slug>.png`, so two
   downloads can never be confused.
4. Look at the PNG. The dish must match the recipe: right protein, right vessel, no ingredient the
   recipe does not have, no text anywhere. If it is off, regenerate once in a **new** chat with the
   prompt tightened on what went wrong. If the second try is still off, keep the better one and
   list it as questionable in the report.
5. Resize and file: `sips -s format jpeg -s formatOptions 85 -Z 1024 <scratch>/<slug>.png --out
   recipes/images/<slug>.jpg`. The PNG is not kept.

Never reuse a chat for a second image (the user's rule: every picture starts clean). A ChatGPT
usage limit or sign-in prompt means stop and report; do not retry in a loop.

## 4. Record and sync

Append each prompt under "Prompts used" in `recipes/images/README.md` as `### <slug>` + the prompt
text. Commit the JPEGs and the README together — `Recipes: images for <slug>, <slug>` — and push
(CLAUDE.md sync rules). Batch of more than ~8: commit every 6–8 so a dropped session loses little.
The app discovers the files by name; nothing needs a restart.

Report: each slug with its palette picks, any regenerated or questionable picture, and anything not
done.

Slugs requested with the command (optional): $ARGUMENTS
