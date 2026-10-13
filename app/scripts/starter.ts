// CLI fallback for the Recipes tab's Starter library card: copy recipes from
// starter-recipes/ into recipes/ and commit them (same module as the app,
// server/starter.ts, so each recipe's picture in starter-recipes/images/ comes
// along to recipes/images/; MEALAPP_NO_GIT=1 leaves them uncommitted).
//   npm run starter                 list what's there
//   npm run starter -- --all        import everything not yet in recipes/
//   npm run starter -- a.md b       import these (".md" optional)
// Don't run it while the app is mid-run: the app's run lock lives in the
// server process, so this script can't see it.
import { importStarter, listStarter, StarterError } from '../server/starter.ts';

const args = process.argv.slice(2);
const { available, recipes } = await listStarter();
if (!available) {
  console.log('No starter-recipes/ folder in this repo: nothing to import.');
  process.exit(0);
}
const remaining = recipes.filter((r) => !r.inLibrary);
if (!args.length) {
  console.log(`${recipes.length} starter recipes, ${remaining.length} not yet in recipes/:`);
  for (const r of recipes) {
    const bits = [r.protein, r.cuisine, r.active_time_min !== undefined ? `~${r.active_time_min} min active` : ''].filter(Boolean).join(' · ');
    console.log(`  ${r.inLibrary ? '✓' : ' '} ${r.file.padEnd(48)} ${r.name}${bits ? ` (${bits})` : ''}`);
  }
  console.log('\nImport: npm run starter -- --all   or   npm run starter -- <file> [<file> …]');
  process.exit(0);
}
const files = args.includes('--all')
  ? remaining.map((r) => r.file)
  : args.filter((a) => !a.startsWith('--')).map((a) => (a.endsWith('.md') ? a : `${a}.md`));
if (!files.length) {
  console.log('Nothing to import: every starter recipe is already in recipes/.');
  process.exit(0);
}
try {
  const r = await importStarter(files, undefined, { background: false });
  console.log(`Imported ${r.imported.length}: ${r.imported.join(', ') || '(none)'}`);
  if (r.images.length) console.log(`Pictures copied to recipes/images/: ${r.images.join(', ')}`);
  if (r.skipped.length) console.log(`Skipped (already in recipes/): ${r.skipped.join(', ')}`);
  const g = r.git;
  if (g) {
    if (g.committed) console.log(`git: committed ${g.sha ?? ''}${g.pushed === true ? ', pushed' : `, not pushed${g.error ? ` (${g.error})` : ''}`}`);
    else console.log(`git: ${g.reason ?? 'not committed'} — the files are saved but uncommitted`);
  }
} catch (err) {
  console.error(err instanceof StarterError ? err.message : `Import failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
}
