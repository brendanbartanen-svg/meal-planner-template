#!/usr/bin/env bash
# Refresh the shareable template from this repo (docs/2026-10-12-template-refresh.md, step 1).
#   app/scripts/sync-template.sh <template dir>      (or, from app/: npm run sync-template -- <template dir>)
# Copies the shared files verbatim (app/ minus node_modules, data, launchd; the
# desktop commands; launch.json; plans/TEMPLATE.md; .gitignore), copies
# recipes/README.md with the source-tag legend genericized, exports the
# starter library into <template>/starter-recipes/, then prints the manual
# checklist. It never commits anything in either repo.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
repo="$(cd "$here/../.." && pwd)"

if [[ $# -ne 1 ]]; then
  echo "usage: $0 <template dir>" >&2
  exit 2
fi
tpl="$(cd "$1" && pwd)"
if [[ "$tpl" == "$repo" ]]; then
  echo "refusing: the template dir is this repo" >&2
  exit 2
fi
if [[ ! -d "$tpl/app" || ! -f "$tpl/README.md" ]]; then
  echo "refusing: $tpl doesn't look like the template (no app/ or README.md)" >&2
  exit 2
fi
if [[ -n "$(git -C "$repo" status --porcelain)" ]]; then
  echo "refusing: $repo has uncommitted changes — commit or stash first, so the template is synced from a known HEAD" >&2
  git -C "$repo" status --short >&2
  exit 1
fi
head="$(git -C "$repo" rev-parse --short HEAD)"
echo "syncing $repo @ $head → $tpl"

# 1. app/ — verbatim, with deletions, minus local state and the household's LaunchAgent.
#    The template keeps its own app/launchd/ (excluded = neither copied nor deleted).
#    So do the four synthetic parser fixtures (this repo carries the same files; the template's win).
rsync -a --delete \
  --exclude 'node_modules/' --exclude 'data/' --exclude '/launchd/' --exclude '.DS_Store' \
  --exclude '/scripts/fixtures/2026-W29.md' --exclude '/scripts/fixtures/2026-W30.md' \
  --exclude '/scripts/fixtures/2026-W31.md' --exclude '/scripts/fixtures/carnitas.md' \
  "$repo/app/" "$tpl/app/"
echo "  app/ synced (node_modules, data, launchd and the synthetic fixtures untouched)"
# The selftest fixtures snapshotted from this household name its cook in prose; no
# assertion reads those words, so the template's copies get a neutral name.
sed -i '' -e "s/Brendan's/the cook's/g" -e 's/Brendan/the cook/g' "$tpl"/app/scripts/fixtures/*.md
echo "  fixtures: personal names neutralized"

# 2. desktop commands, the preview config, the plan template, .gitignore
mkdir -p "$tpl/.claude/commands" "$tpl/plans" "$tpl/recipes"
rsync -a --delete --exclude '.DS_Store' "$repo/.claude/commands/" "$tpl/.claude/commands/"
cp "$repo/.claude/launch.json" "$tpl/.claude/launch.json"
cp "$repo/plans/TEMPLATE.md" "$tpl/plans/TEMPLATE.md"
cp "$repo/.gitignore" "$tpl/.gitignore"
echo "  .claude/commands/, .claude/launch.json, plans/TEMPLATE.md, .gitignore copied"

# 3. recipes/README.md with the template's tag legend ([1]/[2]/[P]); same rules as the exporter
cd "$repo/app"
npx tsx scripts/starter-export.ts --genericize "$repo/recipes/README.md" "$tpl/recipes/README.md" | sed 's/^/  /'

# 4. the starter library, regenerated from scratch
rm -rf "$tpl/starter-recipes"
npx tsx scripts/starter-export.ts "$tpl/starter-recipes" | sed 's/^/  /'

cat <<EOF

Synced from $(basename "$repo") @ $head. Still to do by hand (docs/2026-10-12-template-refresh.md):
  2. Diff CLAUDE.md and SPEC.md against this repo's since the last refresh and port what applies
     (feature additions, rule changes), keeping the template's generic phrasing.
  3. Update README.md if install or first-run steps changed.
  4. In the template: cd app && npm ci && npm run typecheck && npm run selftest, then boot a dev
     instance with MEALAPP_MOCK_RUNS=1 MEALAPP_NO_GIT=1 MEALAPP_PORT=4317 MEALAPP_DATA_DIR=<scratch>
     from the template's app/ and check the Get started card, the Starter library card, and one
     mock propose.
  5. Commit in the template with a message naming this repo's HEAD ($head).
EOF
