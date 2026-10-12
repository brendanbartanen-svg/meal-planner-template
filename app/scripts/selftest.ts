// Parser + week-math selftest. The plan/recipe parser suite is source-aware:
// when this repo has its real history (plans/2026-W31.md exists) it reads the
// REAL files (W29–W31 and the goulash recipe — if their formats drift, this
// should fail loudly rather than the UI failing quietly); otherwise (the
// shareable template, a fresh install) it reads the synthetic samples in
// scripts/fixtures/ (2026-W29/30/31.md + carnitas.md; see fixtures/README.md).
// Suites that sweep the live library/plans/pantry skip what isn't there.
// Run: npm run selftest
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addWeeks, endOfWeek, humanRange, isoWeekId, mondayOf, parsePlan, parseRecipe, prepDueDate,
  startOfWeek, todayUTC, weekDates, weekDays, weekIdForDate,
} from '../server/index.ts';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
const pathExists = (p: string) => fs.access(p).then(() => true, () => false);
// REAL = this household's repo with its history; otherwise the synthetic fixtures.
const REAL = await pathExists(path.join(repoRoot, 'plans/2026-W31.md'));
const planSrc = (wk: string) => (REAL ? path.join(repoRoot, 'plans', `${wk}.md`) : path.join(fixturesDir, `${wk}.md`));
const srcLabel = (wk: string) => (REAL ? `plans/${wk}.md` : `fixtures/${wk}.md`);
console.log(`selftest source: ${REAL ? 'REAL repo files (plans/2026-W29…W31, recipes/goulash.md)' : 'synthetic fixtures (app/scripts/fixtures/2026-W29…W31, carnitas.md)'}`);
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) { console.log(`  ok  ${label}`); return; }
  failures++;
  console.error(`FAIL  ${label}${detail !== undefined ? ` — got ${JSON.stringify(detail)}` : ''}`);
}
const utc = (y: number, m: number, d: number) => new Date(Date.UTC(y, m - 1, d));

// ---- ISO week primitives (scheme-independent) ----
console.log('ISO week math:');
check('2026-08-01 is in 2026-W31', isoWeekId(utc(2026, 8, 1)) === '2026-W31', isoWeekId(utc(2026, 8, 1)));
check('monday of 2026-W31 is Jul 27', mondayOf('2026-W31').toISOString().slice(0, 10) === '2026-07-27');
check('sunday of 2026-W31 is Aug 2', weekDates('2026-W31').Sun === '2026-08-02');
check('W31 + 1 = W32', addWeeks('2026-W31', 1) === '2026-W32');
check('2026-01-01 (Thu) is 2026-W01', isoWeekId(utc(2026, 1, 1)) === '2026-W01', isoWeekId(utc(2026, 1, 1)));
check('2025-12-28 (Sun) is 2025-W52', isoWeekId(utc(2025, 12, 28)) === '2025-W52', isoWeekId(utc(2025, 12, 28)));
check('2026-12-31 (Thu) is 2026-W53', isoWeekId(utc(2026, 12, 31)) === '2026-W53', isoWeekId(utc(2026, 12, 31)));
check('2027-01-01 (Fri) is 2026-W53', isoWeekId(utc(2027, 1, 1)) === '2026-W53', isoWeekId(utc(2027, 1, 1)));
check('todayUTC carries a calendar date', /^\d{4}-\d{2}-\d{2}$/.test(todayUTC().toISOString().slice(0, 10)));

// ---- the Saturday cutover (2026-08-08: weeks run Sat→Fri from 2026-W33) ----
console.log('\nweek scheme (Mon→Sat cutover):');
const wid = (y: number, m: number, d: number) => weekIdForDate(utc(y, m, d));
check('Fri 2026-08-07 → W32 (last Mon-week day)', wid(2026, 8, 7) === '2026-W32', wid(2026, 8, 7));
check('Sat 2026-08-08 → W33 (cutover, day 1)', wid(2026, 8, 8) === '2026-W33', wid(2026, 8, 8));
check('Sun 2026-08-09 → W33', wid(2026, 8, 9) === '2026-W33', wid(2026, 8, 9));
check('Fri 2026-08-14 → W33 (last day)', wid(2026, 8, 14) === '2026-W33', wid(2026, 8, 14));
check('Sat 2026-08-15 → W34', wid(2026, 8, 15) === '2026-W34', wid(2026, 8, 15));
check('Fri 2026-08-21 → W34', wid(2026, 8, 21) === '2026-W34', wid(2026, 8, 21));
check('Sat 2026-08-22 → W35', wid(2026, 8, 22) === '2026-W35', wid(2026, 8, 22));
check('2026-07-31 (pre-cutover) → W31', wid(2026, 7, 31) === '2026-W31', wid(2026, 7, 31));
check('Sat 2026-12-26 → 2026-W53', wid(2026, 12, 26) === '2026-W53', wid(2026, 12, 26));
check('Fri 2027-01-01 → 2026-W53 (last day)', wid(2027, 1, 1) === '2026-W53', wid(2027, 1, 1));
check('Sat 2027-01-02 → 2027-W01', wid(2027, 1, 2) === '2027-W01', wid(2027, 1, 2));

const days = (w: string) => weekDays(w).join(',');
check('W31 days Mon…Sun', days('2026-W31') === 'Mon,Tue,Wed,Thu,Fri,Sat,Sun', days('2026-W31'));
check('W32 days Mon…Fri (truncated)', days('2026-W32') === 'Mon,Tue,Wed,Thu,Fri', days('2026-W32'));
check('W33 days Sat…Fri', days('2026-W33') === 'Sat,Sun,Mon,Tue,Wed,Thu,Fri', days('2026-W33'));

const span = (w: string) => `${startOfWeek(w).toISOString().slice(0, 10)}…${endOfWeek(w).toISOString().slice(0, 10)}`;
check('W31 spans Jul 27…Aug 2', span('2026-W31') === '2026-07-27…2026-08-02', span('2026-W31'));
check('W32 spans Aug 3…Aug 7', span('2026-W32') === '2026-08-03…2026-08-07', span('2026-W32'));
check('W33 spans Aug 8…Aug 14', span('2026-W33') === '2026-08-08…2026-08-14', span('2026-W33'));
check('W34 spans Aug 15…Aug 21', span('2026-W34') === '2026-08-15…2026-08-21', span('2026-W34'));

check('weekDates W33 Sat = Aug 8', weekDates('2026-W33').Sat === '2026-08-08', weekDates('2026-W33').Sat);
check('weekDates W33 Fri = Aug 14', weekDates('2026-W33').Fri === '2026-08-14', weekDates('2026-W33').Fri);
check('weekDates W32 has no Sat/Sun', weekDates('2026-W32').Sat === undefined && weekDates('2026-W32').Sun === undefined);
check('ids stay consecutive: W34 − 1 = W33', addWeeks('2026-W34', -1) === '2026-W33', addWeeks('2026-W34', -1));
check('ids stay consecutive: W32 + 1 = W33', addWeeks('2026-W32', 1) === '2026-W33', addWeeks('2026-W32', 1));

check('humanRange W33 is Sat→Fri', humanRange('2026-W33') === 'Sat Aug 8 – Fri Aug 14, 2026', humanRange('2026-W33'));
check('humanRange W32 is Mon→Fri', humanRange('2026-W32') === 'Mon Aug 3 – Fri Aug 7, 2026', humanRange('2026-W32'));
check('humanRange W31 still Mon→Sun', humanRange('2026-W31') === 'Mon Jul 27 – Sun Aug 2, 2026', humanRange('2026-W31'));

check('prep "Fri 14, night" in W33 → Aug 14', prepDueDate('Fri 14, night', '2026-W33') === '2026-08-14', prepDueDate('Fri 14, night', '2026-W33'));
check('prep "Fri 7" in W33 → Aug 7 (before the week)', prepDueDate('Fri 7', '2026-W33') === '2026-08-07', prepDueDate('Fri 7', '2026-W33'));
check('prep bare "Sat, night" in W33 → Aug 8', prepDueDate('Sat, night', '2026-W33') === '2026-08-08', prepDueDate('Sat, night', '2026-W33'));

// ---- human week names (ids stay identifiers; people read relative words or dates) ----
console.log('\nhuman week names:');
{
  const { weekInfo, weekPhrase, humanizeWeekIds } = await import('../server/weeks.ts');
  const j = (x: unknown) => JSON.stringify(x);
  const w43 = weekInfo('2026-W43', '2026-W42');
  check('weekInfo W43 from W42 = Oct 17–23, next', j(w43) === j({ start: '2026-10-17', end: '2026-10-23', range: 'Oct 17–23', rel: 'next' }), w43);
  check('weekInfo W42 from W42 is this week', weekInfo('2026-W42', '2026-W42').rel === 'this');
  check('weekInfo W41 from W42 is last week', weekInfo('2026-W41', '2026-W42').rel === 'last');
  check('weekInfo W44 from W42 has no relative name', weekInfo('2026-W44', '2026-W42').rel === null);
  check('range across a month: W40 = "Sep 26–Oct 2"', weekInfo('2026-W40', '2026-W42').range === 'Sep 26–Oct 2', weekInfo('2026-W40', '2026-W42').range);
  check('range of truncated W32 = "Aug 3–7"', weekInfo('2026-W32', '2026-W42').range === 'Aug 3–7', weekInfo('2026-W32', '2026-W42').range);
  check('range of Mon-start W31 = "Jul 27–Aug 2"', weekInfo('2026-W31', '2026-W42').range === 'Jul 27–Aug 2', weekInfo('2026-W31', '2026-W42').range);
  check('rel across the year: 2026-W53 → 2027-W01 is next', weekInfo('2027-W01', '2026-W53').rel === 'next');
  check('weekPhrase: "next week" / "Next week"', weekPhrase(w43) === 'next week' && weekPhrase(w43, { cap: true }) === 'Next week');
  const w44 = weekInfo('2026-W44', '2026-W42');
  check('weekPhrase with no relative name: "the week of Oct 24" / "The week of Oct 24"',
    weekPhrase(w44) === 'the week of Oct 24' && weekPhrase(w44, { cap: true }) === 'The week of Oct 24', [weekPhrase(w44), weekPhrase(w44, { cap: true })]);
  const h = humanizeWeekIds('Not started: 2026-W43 got a plan file while 2026-W42 was closing.');
  check('humanizeWeekIds: ids in prose become dates', h === 'Not started: Oct 17–23 got a plan file while Oct 10–16 was closing.', h);
  const h2 = humanizeWeekIds('Revised 2026-W43: see plans/2026-W43.md, key 2026-W43:shop:x, file 2026-W43.md');
  check('humanizeWeekIds: paths, keys and file names keep their ids',
    h2 === 'Revised Oct 17–23: see plans/2026-W43.md, key 2026-W43:shop:x, file 2026-W43.md', h2);
}

// ---- W31 (locked, full grocery, empty log) ----
const w31 = parsePlan(await fs.readFile(planSrc('2026-W31'), 'utf8'), '2026-W31.md');
console.log(`\n${srcLabel('2026-W31')}:`);
check('week id', w31.week === '2026-W31');
check('status locked', w31.status === 'locked', w31.status);
check('7 table rows', w31.meals.length === 7, w31.meals.length);
check('5 cook nights', w31.meals.filter((m) => !m.flexible).length === 5);
const mon = w31.meals.find((m) => m.day === 'Mon');
const MON_DISH = REAL ? 'Chicken rice bowl' : 'Pork and green bean stir-fry + jasmine rice';
const MON_FILE = REAL ? 'chicken-rice-bowl.md' : 'pork-green-bean-stir-fry.md';
check('Mon dish', mon?.dish === MON_DISH, mon?.dish);
check('Mon recipe link', mon?.recipeFile === MON_FILE, mon?.recipeFile);
check('Mon fav ⭐5', mon?.favRating === 5, mon?.favRating);
check('Mon time 30', mon?.timeMin === 30, mon?.timeMin);
check('Mon cal ~550', mon?.cal === 550, mon?.cal);
check('Mon approved', mon?.status === 'approved', mon?.status);
check('Tue is new', w31.meals.find((m) => m.day === 'Tue')?.isNew === true);
check('Fri flexible', w31.meals.find((m) => m.day === 'Fri')?.flexible === true);
check('4 prep tasks', w31.prep.length === 4, w31.prep.length);
check('prep keys week-scoped', w31.prep.every((p) => p.key.startsWith('2026-W31:prep:')));
check('first prep due Jul 26 (Sun before the week)', w31.prep[0]?.dueDate === '2026-07-26', w31.prep[0]);
check('last prep due Aug 1 (Sat 1)', w31.prep[3]?.dueDate === '2026-08-01', w31.prep[3]);
check('2 stores', w31.grocery.stores.length === 2, w31.grocery.stores.map((s) => s.name));
const primary = w31.grocery.stores[0];
const PRIMARY_OK = REAL ? (primary?.name ?? '').startsWith('Costco') : primary?.name === 'Warehouse club';
check('primary store first', PRIMARY_OK, primary?.name);
check('primary store has 3 sections', primary?.sections.length === 3, primary?.sections.map((s) => s.name));
check('primary store Meat & fish has 3 items', primary?.sections[0]?.items.length === 3);
const secondary = w31.grocery.stores[1];
const secondaryItems = secondary?.sections.flatMap((s) => s.items) ?? [];
if (!REAL) check('secondary store named', secondary?.name === 'Supermarket', secondary?.name);
check('secondary store has 11 items', secondaryItems.length === 11, secondaryItems.length);
check('pantry check has 9 items', w31.grocery.pantryCheck.length === 9, w31.grocery.pantryCheck.length);
check('2 bulk notes', w31.grocery.bulkNotes.length === 2, w31.grocery.bulkNotes.length);
check('shop keys week-scoped', secondaryItems.every((i) => i.key.startsWith('2026-W31:shop:')));
check('hasGrocery', w31.hasGrocery === true);
check('log has 5 rows, Wed rated 5', w31.log.length === 5 && w31.log.find((l) => l.day === 'Wed')?.rating === 5, w31.log.length);
check('Tue skipped note parsed, unrated', (w31.log.find((l) => l.day === 'Tue')?.cooked ?? '').includes('skipped') && w31.log.find((l) => l.day === 'Tue')?.rating === undefined);
check('planning notes parsed', w31.notes.length >= 5, w31.notes.length);
check('flex note parsed', (w31.flexNote ?? '').includes('re-shuffle'));

// ---- W30 (complete, filled log, review) ----
const w30 = parsePlan(await fs.readFile(planSrc('2026-W30'), 'utf8'), '2026-W30.md');
console.log(`\n${srcLabel('2026-W30')}:`);
check('status complete', w30.status === 'complete', w30.status);
check('log rows', w30.log.length === 6, w30.log.length);
check('Tue rated 4', w30.log.find((l) => l.day === 'Tue')?.rating === 4);
check('Sun rated 5', w30.log.find((l) => l.day === 'Sun')?.rating === 5);
check('Mon “—” rating is undefined', w30.log.find((l) => l.day === 'Mon')?.rating === undefined);
check('review body present', w30.reviewMd.length > 100, w30.reviewMd.length);
check('prep tasks parsed', w30.prep.length > 0, w30.prep.length);

// ---- W29 (earliest format: no prep, no planning notes) ----
const w29 = parsePlan(await fs.readFile(planSrc('2026-W29'), 'utf8'), '2026-W29.md');
console.log(`\n${srcLabel('2026-W29')}:`);
check('status locked', w29.status === 'locked', w29.status);
check('meals parsed', w29.meals.length >= 6, w29.meals.length);
check('no prep section tolerated', w29.prep.length === 0, w29.prep.length);
check('2 stores', w29.grocery.stores.length === 2);
check('log parsed', w29.log.length >= 5, w29.log.length);

// ---- template grocery skeleton (a freshly proposed week copies it) ----
const skeleton = parsePlan(
  [
    '# Week of August 8–14, 2026 (2026-W33)', '', '**Status:** planning', '',
    '## Grocery list', '', '### {Primary store}', '**Produce**', '- [ ] ...', '',
    '### {Secondary store}', '- [ ] ... (why not the primary store: ...)', '',
    '### Pantry check (likely low — verify)', '- [ ] ...', '',
  ].join('\n'),
  '2026-W33.md',
);
console.log('\nsynthetic: template grocery skeleton:');
check('placeholder items skipped', skeleton.grocery.stores.every((s) => s.sections.every((x) => x.items.length === 0)));
check('placeholder pantry skipped', skeleton.grocery.pantryCheck.length === 0, skeleton.grocery.pantryCheck.length);
check('skeleton hasGrocery false', skeleton.hasGrocery === false);

// ---- recipe frontmatter ----
// REAL: recipes/goulash.md (running stats + times change: shape, not values).
// Fixtures: fixtures/carnitas.md (synthetic, pre-prep-first format: exact values).
{
  const file = REAL ? 'goulash.md' : 'carnitas.md';
  const raw = await fs.readFile(REAL ? path.join(repoRoot, 'recipes', file) : path.join(fixturesDir, file), 'utf8');
  const r = parseRecipe(raw, file);
  console.log(`\n${REAL ? 'recipes' : 'fixtures'}/${file}:`);
  const NAME = REAL ? 'Goulash (Hungarian-Style, Dutch Oven)' : 'Carnitas (Slow-Braised Pork Shoulder, Dutch Oven)';
  check('name', r.meta.name === NAME, r.meta.name);
  // running stats change every time it's cooked — check shape, not values
  check('rating 1–5 number', typeof r.meta.rating === 'number' && r.meta.rating >= 1 && r.meta.rating <= 5, r.meta.rating);
  check('times_cooked ≥ 1', (r.meta.times_cooked ?? 0) >= 1 && Number.isInteger(r.meta.times_cooked), r.meta.times_cooked);
  check('last_cooked ISO date', /^\d{4}-\d{2}-\d{2}$/.test(String(r.meta.last_cooked)), r.meta.last_cooked);
  if (REAL) {
    // times are re-estimated (the 2026-10-11 prep-first migration: 40 → 70): shape, not values.
    // prep_min isn't in RecipeMeta, so it is read from the raw frontmatter.
    const act = r.meta.active_time_min, tot = r.meta.total_time_min;
    const prepRaw = raw.slice(0, raw.indexOf('\n---', 3)).match(/^prep_min:\s*(\S+)\s*$/m)?.[1];
    const prepMin = Number(prepRaw);
    const pos = (n: unknown) => typeof n === 'number' && Number.isFinite(n) && n > 0;
    check('active_time_min + total_time_min positive numbers', pos(act) && pos(tot), [act, tot]);
    check('prep_min present, positive, and ≤ active_time_min', prepRaw !== undefined && pos(prepMin) && prepMin <= act!, [prepRaw, act]);
    check('total_time_min ≥ active_time_min', pos(tot) && tot! >= act!, [act, tot]);
  } else {
    check('active_time_min 35', r.meta.active_time_min === 35, r.meta.active_time_min);
  }
  const CAL = REAL ? 560 : 540, FIBER = REAL ? 6 : 7;
  check(`nutrition calories ${CAL}`, r.meta.nutrition?.calories === CAL, r.meta.nutrition);
  check(`nutrition fiber ${FIBER}`, r.meta.nutrition?.fiber_g === FIBER);
  check('prep_ahead 2 items', r.meta.prep_ahead.length === 2, r.meta.prep_ahead);
  check('prep_ahead unquoted', r.meta.prep_ahead[0]?.startsWith('thaw') === true, r.meta.prep_ahead[0]);
  check('body has Ingredients', r.body.includes('## Ingredients'));
  if (REAL) check('body has Prep (prep-first format)', /^## Prep\s*$/m.test(r.body));
}

// ---- recipe `description` (frontmatter, right after name:) ----
// What the Week tab's day cards show. Parser cases are synthetic; the library
// sweep reads the live recipes/ (every file must carry one in this household's
// repo; elsewhere only the ones present are held to the format).
console.log('\nrecipe description:');
{
  const fm = (line: string) => parseRecipe(`---\nname: Test Dish\n${line}\ncuisine: test\nservings: 4\n---\n\n## Ingredients\n- 1 lb x [P]\n`, 'test-dish.md').meta;
  const plain = fm('description: "Seared chicken thighs in a sweet-hot glaze, with smashed cucumbers and rice."');
  check('double-quoted: quotes stripped, commas kept', plain.description === 'Seared chicken thighs in a sweet-hot glaze, with smashed cucumbers and rice.', plain.description);
  check('the keys after it still parse', plain.name === 'Test Dish' && plain.cuisine === 'test' && plain.servings === 4, plain);
  const colon = fm('description: "Two ways to eat it: over rice, or stuffed into warm pita."');
  check('colon inside the quotes is text', colon.description === 'Two ways to eat it: over rice, or stuffed into warm pita.', colon.description);
  const esc = fm('description: "A \\"dry\\" curry: no gravy, all crust."');
  check('escaped quotes unescaped', esc.description === 'A "dry" curry: no gravy, all crust.', esc.description);
  const single = fm("description: 'The cook''s braise: beef, paprika, potatoes.'");
  check("single-quoted: '' unescaped, colon kept", single.description === "The cook's braise: beef, paprika, potatoes.", single.description);
  check('unquoted value passes through', fm('description: Beans in tomato sauce with feta.').description === 'Beans in tomato sauce with feta.');
  check('empty / null / absent → no description',
    fm('description: ""').description === undefined && fm('description: null').description === undefined
      && fm('description:').description === undefined && fm('protein: beef').description === undefined);

  const dir = path.join(repoRoot, 'recipes');
  const files = (await fs.readdir(dir).catch(() => [] as string[])).filter((f) => f.endsWith('.md') && f !== 'README.md').sort();
  const missing: string[] = [], bad: Array<[string, string]> = [];
  for (const f of files) {
    const raw = await fs.readFile(path.join(dir, f), 'utf8');
    const d = parseRecipe(raw, f).meta.description;
    if (!d) { missing.push(f); continue; }
    const line = raw.split('\n').findIndex((l) => l.startsWith('description:'));
    if (d.length > 160) bad.push([f, `${d.length} chars`]);
    else if (/[—"]/.test(d)) bad.push([f, 'em dash or double quote inside']);
    else if (!/^description: ".*"$/.test(raw.split('\n')[line] ?? '')) bad.push([f, 'not double-quoted']);
    else if (!(raw.split('\n')[line - 1] ?? '').startsWith('name:')) bad.push([f, 'not right after name:']);
  }
  check(`live recipes/ (${files.length}): descriptions ≤ 160 chars, double-quoted, right after name:`, bad.length === 0, bad);
  if (REAL) check(`live recipes/ (${files.length}): every recipe has a description`, files.length > 0 && missing.length === 0, missing);
  else if (missing.length) console.log(`  (${missing.length} recipe(s) without a description: the Week tab shows none for them)`);

  // the /api/state join: meals get their recipe's description by recipeFile
  const { addRecipeMeta } = await import('../server/repo.ts');
  const withDesc = files.find((f) => !missing.includes(f));
  const meal = (recipeFile?: string) => ({ day: 'Sat', mealType: 'Dinner', dish: 'x', recipeFile, isNew: false, status: 'approved', flexible: false });
  const planLike = { meals: [meal(withDesc), meal('not-written-yet.md'), meal('../CLAUDE.md'), meal(undefined)] } as unknown as import('../server/parse.ts').ParsedPlan;
  await addRecipeMeta(planLike, null, undefined);
  const got = planLike.meals.map((m) => m.description);
  if (withDesc) {
    const want = parseRecipe(await fs.readFile(path.join(dir, withDesc), 'utf8'), withDesc).meta.description;
    check(`join: a meal linked to ${withDesc} carries its description`, !!want && got[0] === want, got[0]);
  }
  check('join: missing file, unsafe path and no link → no description', got[1] === undefined && got[2] === undefined && got[3] === undefined, got);
  // …and the recipe's active time over the plan row's lock-day snapshot (one number per recipe, app-wide)
  const activeOf = async (f: string) => parseRecipe(await fs.readFile(path.join(dir, f), 'utf8'), f).meta.active_time_min ?? 0;
  const timed = (await Promise.all(files.map(async (f) => ((await activeOf(f)) > 0 ? f : null)))).find(Boolean);
  if (timed) {
    const stale = { meals: [{ ...meal(timed), timeMin: 1 }, { ...meal('not-written-yet.md'), timeMin: 25 }] } as unknown as import('../server/parse.ts').ParsedPlan;
    await addRecipeMeta(stale);
    check(`join: ${timed} shows the recipe's active time, a 🆕 without a file keeps the plan row's`,
      stale.meals[0]!.timeMin === (await activeOf(timed)) && stale.meals[1]!.timeMin === 25, stale.meals.map((m) => m.timeMin));
  }

  // the Week tab renders the description, never the planner's rationale
  const weekJs = await fs.readFile(path.join(repoRoot, 'app/public/js/10-week.js'), 'utf8');
  check('Week tab: day cards read m.description, not plan.whys', weekJs.includes('m.description') && !/\bwhys\[/.test(weekJs));
}

// ---- pantry editor core (server/pantry.ts) ----
// Exact values are pinned to a byte-for-byte snapshot of profile/pantry.md
// taken 2026-10-11 (app/scripts/fixtures/): the live file changes at every
// lock and review, so exact counts against it would fail weekly. The
// round-trip suite is content-independent and runs on BOTH the snapshot and
// the live file, so whatever a run writes into the pantry later still gets
// exercised. Block-scoped + dynamic import so this section stays self-contained.
{
  const { parsePantry, addItem, removeItem, setLow, freezerUse, freezerAdd } = await import('../server/pantry.ts');
  type Pantry = import('../server/pantry.ts').Pantry;
  const D = '2026-10-11';
  const LOW = ` ⚠️ low (${D})`; // the documented marker, spelled out literally
  const ADDED = (t: string) => `${t} (added ${D} via app)`;
  const snap = await fs.readFile(path.join(repoRoot, 'app/scripts/fixtures/pantry-2026-10-11.md'), 'utf8');
  const live = await fs.readFile(path.join(repoRoot, 'profile/pantry.md'), 'utf8');
  const same = (a: string[], b: string[]) => a.length === b.length && a.every((x, i) => x === b[i]);
  const diffAt = (a: string[], b: string[]) => a.map((x, i) => (x === b[i] ? -1 : i)).filter((i) => i >= 0);
  const firstDiff = (a: string[], b: string[]) => { let i = 0; while (i < a.length && a[i] === b[i]) i++; return i; };
  const noCR = (s: string | undefined) => (s ?? '').replace(/\r$/, '');
  const allItems = (p: Pantry) => p.sections.flatMap((s, si) => s.items.map((it) => ({ si, it })));
  const findId = (p: Pantry, id: string) => p.sections.flatMap((s) => s.items).find((i) => i.id === id);
  const throws = (fn: () => unknown) => { try { fn(); return false; } catch (e) { return e instanceof Error; } };
  // Run fn over a list; one check per named property, failures reported by tag.
  function sweep<T>(label: string, list: T[], fn: (x: T) => Record<string, boolean>, tag: (x: T) => unknown) {
    const bad = new Map<string, unknown[]>();
    const keys: string[] = [];
    for (const x of list) {
      let r: Record<string, boolean>;
      try { r = fn(x); } catch (e) { (bad.get('threw') ?? bad.set('threw', []).get('threw')!).push([tag(x), String(e)]); continue; }
      for (const [k, ok] of Object.entries(r)) {
        if (!keys.includes(k)) keys.push(k);
        if (!ok) (bad.get(k) ?? bad.set(k, []).get(k)!).push(tag(x));
      }
    }
    if (bad.has('threw')) keys.push('threw');
    for (const k of keys) {
      const b = bad.get(k) ?? [];
      check(`${label} ×${list.length}: ${k === 'threw' ? 'no edit threw' : k}`, b.length === 0, b.slice(0, 3));
    }
  }

  console.log('\npantry: snapshot app/scripts/fixtures/pantry-2026-10-11.md (exact values):');
  const ps = parsePantry(snap);
  const SL = snap.split('\n');
  const names = ps.sections.map((s) => s.name);
  check('section names in order', same(names, ['Oils, vinegars, condiments', 'Spices & dried herbs', 'Dry goods', 'Fridge staples', 'Freezer inventory']), names);
  const counts = ps.sections.map((s) => s.items.length).join('/');
  check('items per section 17/18/12/8/19', counts === '17/18/12/8/19', counts);
  check('only Freezer inventory isFreezer', ps.sections.map((s) => s.isFreezer).join() === 'false,false,false,false,true');
  const sItems = ps.sections.flatMap((s) => s.items);
  check('item.line is the 1-based bullet line (preamble, blockquote, HTML comment skipped)',
    sItems.every((i) => SL[i.line - 1]?.startsWith('- ')) && sItems[0]?.line === 8 && sItems.at(-1)?.line === 90);
  const fz = ps.sections[4]!.items;
  const usedExpected: Array<[number, string, string]> = [
    [72, '~2 lb boneless skinless chicken thighs', 'cooked 2026-07-27 (W31 Mon rice bowl)'],
    [73, '~2 lb boneless skinless chicken thighs (remainder of the 6 lb pack, 2026-W31 shop)', 'cooked 2026-08-06 (W32 Thu Greek chicken)'],
    [74, '2 lb boneless skinless chicken thighs (remainder of the 6 lb pack, 2026-W33 shop)', 'cooked 2026-08-16 (W34 Sun tandoori)'],
    [75, '2 lb boneless skinless chicken thighs (last bag of the 6 lb pack, 2026-W33 shop)', 'cooked 2026-08-23 (W35 Sun shawarma); **freezer thigh drawdown complete**'],
    [77, '2 NY strip steaks, ~12 oz each (the 2026-W33 Thu fridge pair, refrozen when that night slipped)', "cooked 2026-08-20 (W34 Thu strip, per the W35 planning record; W34's own log is still unclosed)"],
    [78, '~1 lb salmon (remainder of the ~2.5 lb tray, 2026-W31 shop)', 'cooked 2026-08-15 (W34 Sat puttanesca)'],
    [79, '~1 lb salmon (refrozen surplus of the 2026-W34 top-up tray, conditional)', 'retired at the W40 lock: drawn for the 2026-09-27 miso salmon if it existed, confirmed absent otherwise'],
    [80, '2 lb raw shrimp (added 2026-W31 shop)', `used W33 (shrimp v2 retest, per the W35 planning record's "last shrimp W33"; W33's own log is still unclosed)`],
    [83, '2 lb boneless skinless chicken thighs (remainder of the 6-lb pack, 2026-W37 shop)', 'cooked 2026-09-18 (W38 Fri shawarma, per the W39 planning record)'],
    [89, '1 chuck roast, ~2.5–3 lb', 'cooked 2026-07-26 (W30 goulash)'],
    [90, '2 salmon portions', 'eaten 2026-07-20'],
  ];
  const usedGot = fz.filter((i) => i.used).map((i) => [i.line, i.text, i.usedNote]);
  check('11 used freezer entries: line, text (strike stripped, "~2 lb" kept) and usedNote', JSON.stringify(usedGot) === JSON.stringify(usedExpected), usedGot);
  const activeExpected: Array<[number, string]> = [
    [76, '2 NY strip steaks, ~12 oz each (remainder of the 4-pack, 2026-W33 shop) — **⚠️ may have been cooked 2026-09-26**'],
    [81, '~0.5 lb raw shrimp (added 2026-W30 shop, remainder of 2 lb bag) — earmarked: harissa shrimp drawdown'],
    [82, '2 lb boneless skinless chicken thighs (existing stock) — **⚠️ status unknown as of 2026-09-05:**'],
    [84, '2 lb boneless skinless chicken thighs (from the 6-lb pack, 2026-W38 shop) — **⚠️ status unknown as of 2026-10-03:**'],
    [85, '2 lb boneless skinless chicken thighs (from the 6-lb pack, 2026-W38 shop) — **⚠️ status unknown as of 2026-10-10:**'],
    [86, '2 × ~1 lb lean ground beef (remainder of the 2026-W39 ~3-lb pack) — unearmarked'],
    [87, 'Frozen chopped spinach, bulk bag (2026-W36 shop) — freezer staple'],
    [88, '1 chuck roast, ~2.5–3 lb (second roast of the Costco 2-pack, 2026-W36 shop) — earmarked: pot roast'],
  ];
  const activeGot = fz.filter((i) => !i.used);
  check('8 active freezer entries, in file order', activeGot.length === 8 && activeExpected.every(([ln, pre], k) => activeGot[k]?.line === ln && activeGot[k]!.text.startsWith(pre)),
    activeGot.map((i) => [i.line, i.text.slice(0, 60)]));
  check('active text = whole raw content (warnings, provenance, bold kept), no usedNote',
    activeGot.every((i) => SL[i.line - 1] === `- ${i.text}` && i.usedNote === undefined));
  check('staples: none used, text = raw line minus "- " (provenance parens kept)',
    ps.sections.slice(0, 4).every((s) => s.items.every((i) => !i.used && SL[i.line - 1] === `- ${i.text}`)));
  check('nothing low; "**⚠️ …**" warning prose is not a low marker', sItems.every((i) => !i.low && i.lowSince === undefined));
  check('ids unique and slug-shaped', new Set(sItems.map((i) => i.id)).size === sItems.length && sItems.every((i) => /^[a-z0-9][a-z0-9-]*-[a-z0-9]+$/.test(i.id)));
  check('Gochujang id = slug(text) scheme', sItems.find((i) => i.line === 22)?.id === 'gochujang-added-2026-w36-shop-keeps-fore-oovrty', sItems.find((i) => i.line === 22)?.id);
  check('parse is deterministic', JSON.stringify(parsePantry(snap)) === JSON.stringify(ps));

  function roundTrips(label: string, raw: string, exact: boolean) {
    console.log(`\npantry round-trips: ${label}:`);
    const L = raw.split('\n');
    const P = parsePantry(raw);
    const items = allItems(P);
    const total = items.length;
    const dupText = (t: string) => items.filter((x) => x.it.text === t).length > 1;
    const tag = (x: { it: { line: number } }) => x.it.line;

    sweep('removeItem', items, ({ si, it }) => {
      const N = removeItem(raw, it.id).split('\n');
      const a = it.line - 1;
      const k = L.length - N.length;
      const q = parsePantry(N.join('\n'));
      return {
        '(a) the removed block starts at the bullet line': k >= 1 && (!exact || k === 1) && /^[-*+][ \t]/.test(L[a]!),
        '(b) every other line byte-identical': same(N.slice(0, a), L.slice(0, a)) && same(N.slice(a), L.slice(a + k)),
        '(c) parse shows one fewer item in that section, id gone': q.sections[si]!.items.length === P.sections[si]!.items.length - 1
          && allItems(q).length === total - 1 && (dupText(it.text) || !findId(q, it.id)),
      };
    }, tag);

    const lowable = items.filter((x) => !x.it.used && !x.it.low);
    sweep('setLow(true)', lowable, ({ it }) => {
      const out = setLow(raw, it.id, true, D);
      const N = out.split('\n');
      const d = diffAt(L, N);
      const q = findId(parsePantry(out), it.id);
      return {
        '(a) marker appended to the item\'s last line': d.length === 1 && d[0]! >= it.line - 1 && (!exact || d[0] === it.line - 1)
          && N[d[0]!] === L[d[0]!]!.replace(/(\r?)$/, `${LOW}$1`),
        '(b) every other line byte-identical': N.length === L.length && d.length === 1,
        '(c) parse: same id, low, lowSince, text unchanged': q?.low === true && q.lowSince === D && q.text === it.text && !q.used,
        '(d) idempotent: marking twice = once (first date kept)': setLow(out, it.id, true, '2026-12-31') === out,
        '(e) clearing restores the original bytes': setLow(out, it.id, false, D) === raw,
        '(f) clearing an unmarked item is a no-op': setLow(raw, it.id, false, D) === raw,
      };
    }, tag);

    const lowNow = items.filter((x) => x.it.low);
    if (lowNow.length) {
      sweep('setLow(false) on already-low items', lowNow, ({ it }) => {
        const out = setLow(raw, it.id, false, D);
        const q = findId(parsePantry(out), it.id);
        return { 'cleared, same id and text, one line changed': q?.low === false && q.text === it.text && diffAt(L, out.split('\n')).length === 1 };
      }, tag);
    }

    const usedNow = items.filter((x) => x.it.used);
    check(`setLow(true) on each of ${usedNow.length} used items throws`, usedNow.every(({ it }) => throws(() => setLow(raw, it.id, true, D))));

    const fzActive = items.filter((x) => P.sections[x.si]!.isFreezer && !x.it.used);
    sweep('freezerUse', fzActive, ({ it }) => {
      const note = it.line % 2 ? 'thawed for selftest' : undefined;
      const tail = ` — used ${D}${note ? ` (${note})` : ''}`;
      const out = freezerUse(raw, it.id, D, note);
      const N = out.split('\n');
      const d = diffAt(L, N);
      const a = it.line - 1;
      const prefix = /^[-*+][ \t]+/.exec(L[a]!)![0];
      const q = findId(parsePantry(out), it.id);
      return {
        '(a) "~~" opens the bullet, "~~ — used DATE[ (note)]" closes the item': d[0] === a && noCR(N[d.at(-1)!]).endsWith(`~~${tail}`)
          && (it.low || N[a]!.startsWith(`${prefix}~~${L[a]!.slice(prefix.length, prefix.length + 8)}`))
          && (!exact || N[a] === `- ~~${L[a]!.slice(2)}~~${tail}`),
        '(b) every other line byte-identical': N.length === L.length && d.length >= 1 && d.length <= 2 && (!exact || d.length === 1),
        '(c) parse: same id, used, usedNote, text unchanged, not low': q?.used === true && q.usedNote === tail.slice(3) && q.text === it.text && !q.low,
        '(d) idempotent: using twice = once': freezerUse(out, it.id, D) === out,
      };
    }, tag);

    const staples = items.filter((x) => !P.sections[x.si]!.isFreezer);
    check(`freezerUse on each of ${staples.length} non-freezer items throws`, staples.every(({ it }) => throws(() => freezerUse(raw, it.id, D))));

    const secs = P.sections.map((s, si) => ({ s, si }));
    sweep('addItem', secs, ({ s, si }) => {
      const out = addItem(raw, s.name, 'Selftest item', D);
      const N = out.split('\n');
      const k = firstDiff(L, N);
      const last = s.items.at(-1);
      const q = parsePantry(out);
      const added = q.sections[si]!.items.at(-1);
      return {
        '(a) "- Selftest item (added DATE via app)" lands right after the section\'s last item': noCR(N[k]) === `- ${ADDED('Selftest item')}`
          && (!last || (k >= last.line && L.slice(last.line, k).every((x) => noCR(x).trim() !== '') && (!exact || k === last.line))),
        '(b) every other line byte-identical': N.length === L.length + 1 && same(N.slice(0, k), L.slice(0, k)) && same(N.slice(k + 1), L.slice(k)),
        '(c) parse: section +1, new item last': q.sections[si]!.items.length === s.items.length + 1 && added?.text === ADDED('Selftest item')
          && allItems(q).length === total + 1,
        '(d) idempotent retry, and remove(add(raw)) === raw': addItem(out, s.name, 'Selftest item', D) === out && removeItem(out, added!.id) === raw,
      };
    }, ({ s }) => s.name);

    sweep('remove then re-add', secs.filter(({ s }) => s.items.length > 0), ({ s, si }) => {
      const first = s.items[0]!;
      const out = addItem(removeItem(raw, first.id), s.name, first.text, D);
      const q = parsePantry(out);
      return {
        'item count restored (section and file)': q.sections[si]!.items.length === s.items.length && allItems(q).length === total,
        're-added item is last with the added suffix': q.sections[si]!.items.at(-1)?.text === ADDED(first.text),
      };
    }, ({ s }) => s.name);

    const fzSec = P.sections.find((s) => s.isFreezer);
    if (fzSec) {
      const out = freezerAdd(raw, 'Selftest bag', D);
      check('freezerAdd === addItem(freezer section)', out === addItem(raw, fzSec.name, 'Selftest bag', D));
      check('freezerAdd: new last freezer item', parsePantry(out).sections.find((s) => s.isFreezer)?.items.at(-1)?.text === ADDED('Selftest bag'));
      const first = fzActive[0];
      if (first) {
        check('freezerUse on a low item drops the marker (same bytes as never-low)',
          freezerUse(setLow(raw, first.it.id, true, D), first.it.id, D) === freezerUse(raw, first.it.id, D));
      }
    }

    const outNew = addItem(raw, 'Selftest section', 'Yeast', D);
    const qn = parsePantry(outNew);
    check('addItem to a missing section appends "## name" at EOF with one item',
      qn.sections.at(-1)?.name === 'Selftest section' && qn.sections.at(-1)?.items.length === 1
      && qn.sections.at(-1)?.items[0]?.text === ADDED('Yeast') && outNew.startsWith(raw.replace(/\s+$/, '')));
    if (exact) check('  … exactly: raw + "\\n## Selftest section\\n- Yeast (added …)\\n"', outNew === `${raw}\n## Selftest section\n- ${ADDED('Yeast')}\n`);
    check('unchanged sections still parse identically after every add', JSON.stringify(qn.sections.slice(0, -1)) === JSON.stringify(P.sections));
  }

  roundTrips('snapshot (exact positions)', snap, true);
  roundTrips('live profile/pantry.md', live, false);

  console.log('\npantry: errors:');
  const anyId = sItems[0]!.id;
  check('unknown id throws (remove / setLow / freezerUse)', throws(() => removeItem(snap, 'nope-1')) && throws(() => setLow(snap, 'nope-1', true, D)) && throws(() => freezerUse(snap, 'nope-1', D)));
  check('bad date throws (addItem / setLow(true) / freezerUse / freezerAdd)', throws(() => addItem(snap, 'Dry goods', 'x', '10/11/2026'))
    && throws(() => setLow(snap, anyId, true, '2026-10')) && throws(() => freezerUse(snap, fz[4]!.id, 'today')) && throws(() => freezerAdd(snap, 'x', '')));
  check('empty / multi-line text, section or note throws', throws(() => addItem(snap, 'Dry goods', '  ', D)) && throws(() => addItem(snap, 'Dry goods', 'a\nb', D))
    && throws(() => addItem(snap, '', 'x', D)) && throws(() => freezerUse(snap, fz[4]!.id, D, 'a\nb')));
  check('section match is case/space-insensitive', addItem(snap, '  dry   GOODS ', 'Selftest', D) === addItem(snap, 'Dry goods', 'Selftest', D));

  console.log('\npantry: synthetic constructs:');
  const syn = [
    '# Pantry', '', '- preamble bullet (not an item)', '',
    '## Alpha',
    '- one',
    '- two spans',
    '  two lines',
    '- three',
    'lazy continuation',
    '<!-- a comment',
    '- inside the comment (not an item)',
    '-->',
    '- four',
    '',
    '  loose paragraph of four',
    '* star bullet',
    '- dup',
    '- dup',
    '- salt ⚠ low (2026-10-01)',
    '',
    '```',
    '## not a heading',
    '- not an item',
    '```',
    '',
    '## Beta',
    '### Sub (not a section)',
    '- under sub',
    '',
    '- - -',
    '',
    '## Empty',
    '<!-- only a comment -->',
    '',
    '## Prose only',
    'Some words.',
    '',
    '## Freezer',
    '- 1 lb beef',
    '  (bottom drawer)',
    '',
    '# Level one ends sections',
    '- after level one (not an item)',
    '',
  ].join('\n');
  const sp = parsePantry(syn);
  const sn = sp.sections.map((s) => `${s.name}:${s.items.length}`).join('|');
  check('sections: fenced "##" and "###" are not sections; "#" ends them', sn === 'Alpha:8|Beta:1|Empty:0|Prose only:0|Freezer:1', sn);
  const alpha = sp.sections[0]!.items;
  check('multi-line items join (indented, lazy, loose paragraph); "* " bullets count',
    same(alpha.map((i) => i.text), ['one', 'two spans two lines', 'three lazy continuation', 'four loose paragraph of four', 'star bullet', 'dup', 'dup', 'salt']), alpha.map((i) => i.text));
  check('duplicate texts get distinct ids (…-2)', alpha[6]!.id === `${alpha[5]!.id}-2`, [alpha[5]!.id, alpha[6]!.id]);
  check('low marker without U+FE0F recognized', alpha[7]!.low && alpha[7]!.lowSince === '2026-10-01');
  const sl = syn.split('\n');
  const idOf = (t: string) => sp.sections.flatMap((s) => s.items).find((i) => i.text === t)!.id;
  check('removeItem on a 2-line item drops both lines', removeItem(syn, idOf('two spans two lines')) === [...sl.slice(0, 6), ...sl.slice(8)].join('\n'));
  check('removeItem on a loose item drops bullet, blank and paragraph', removeItem(syn, idOf('four loose paragraph of four')) === [...sl.slice(0, 13), ...sl.slice(16)].join('\n'));
  const lowTwo = setLow(syn, idOf('two spans two lines'), true, D);
  check('setLow on a multi-line item marks its last line; id/text stable',
    lowTwo.split('\n')[7] === `  two lines${LOW}` && findId(parsePantry(lowTwo), idOf('two spans two lines'))?.low === true);
  check('clearing a no-FE0F marker removes exactly it', setLow(syn, idOf('salt'), false, D).split('\n')[19] === '- salt');
  check('setLow(true) on an already-low item is a no-op', setLow(syn, idOf('salt'), true, D) === syn);
  const beef = idOf('1 lb beef (bottom drawer)');
  const usedBeef = freezerUse(syn, beef, D);
  const ub = usedBeef.split('\n');
  check('freezerUse on a multi-line item: opener on bullet, closer on last line',
    ub[39] === '- ~~1 lb beef' && ub[40] === `  (bottom drawer)~~ — used ${D}` && diffAt(sl, ub).length === 2);
  const qb = findId(parsePantry(usedBeef), beef);
  check('  … parses back used, same id and text', qb?.used === true && qb.text === '1 lb beef (bottom drawer)' && qb.usedNote === `used ${D}`);
  const bAdd = addItem(syn, 'Beta', 'x', D).split('\n');
  check('addItem goes right after the last item (before blank + thematic break)', bAdd[29] === `- ${ADDED('x')}` && same([...bAdd.slice(0, 29), ...bAdd.slice(30)], sl));
  const eAdd = addItem(syn, 'Empty', 'x', D).split('\n');
  check('addItem to an item-less section: right after its comment', eAdd[34] === `- ${ADDED('x')}` && same([...eAdd.slice(0, 34), ...eAdd.slice(35)], sl));
  const pAdd = addItem(syn, 'Prose only', 'x', D).split('\n');
  check('addItem after prose: blank line first so it starts a list', pAdd[37] === '' && pAdd[38] === `- ${ADDED('x')}` && same([...pAdd.slice(0, 37), ...pAdd.slice(39)], sl)
    && parsePantry(pAdd.join('\n')).sections[3]!.items.length === 1);
  const crlf = syn.replace(/\n/g, '\r\n');
  check('CRLF parses identically', JSON.stringify(parsePantry(crlf)) === JSON.stringify(sp));
  const toCR = (s: string) => s.replace(/\n/g, '\r\n');
  check('CRLF edits = LF edits with CRLF endings (add, remove, low, clear, use, new section)',
    addItem(crlf, 'Beta', 'x', D) === toCR(addItem(syn, 'Beta', 'x', D))
    && removeItem(crlf, idOf('two spans two lines')) === toCR(removeItem(syn, idOf('two spans two lines')))
    && setLow(crlf, idOf('one'), true, D) === toCR(setLow(syn, idOf('one'), true, D))
    && setLow(crlf, idOf('salt'), false, D) === toCR(setLow(syn, idOf('salt'), false, D))
    && freezerUse(crlf, beef, D, 'n') === toCR(freezerUse(syn, beef, D, 'n'))
    && addItem(crlf, 'New', 'x', D) === toCR(addItem(syn, 'New', 'x', D)));
  check('no trailing newline kept: add after an unterminated last line',
    addItem('## A\n- x', 'A', 'y', D) === `## A\n- x\n- ${ADDED('y')}` && addItem('## A\r\n- x', 'A', 'y', D) === `## A\r\n- x\r\n- ${ADDED('y')}`);
  check('removing an unterminated last item leaves no dangling CR', removeItem('## A\r\n- x', parsePantry('## A\r\n- x').sections[0]!.items[0]!.id) === '## A');
  check('empty file: addItem creates the section', addItem('', 'Staples', 'Salt', D) === `## Staples\n- ${ADDED('Salt')}\n`);
  check('appending a section into an unclosed fence throws', throws(() => addItem('## A\n- x\n```\nunclosed', 'B', 'y', D)));
}


// ---- ingredient scaling (server/scale.ts) ----
// Inputs are REAL lines copied from recipes/*.md (frozen here so recipe edits
// don't break them); every expectation is hand-derived. Whole-recipe checks
// read snapshots in app/scripts/fixtures/; only the library sweep reads
// recipes/ live (shape-only). Dynamic import keeps this section independent of
// the import block above.
{
  const { parseQty, formatQty, scaleIngredientLine, scaleIngredients, headline, factorFor } = await import('../server/scale.ts');
  console.log('\nscale:');
  const near = (a: number | undefined, b: number) => a !== undefined && Math.abs(a - b) < 1e-9;
  const line = (label: string, input: string, factor: number, expected: string) => {
    const got = scaleIngredientLine(input, factor);
    check(`${label} ×${factor}`, got.text === expected && got.scaled, got.text);
  };
  const same = (label: string, input: string) => {
    const got = scaleIngredientLine(input, 2);
    check(`${label} unscaled`, got.text === input && got.scaled === false, got);
  };

  // parseQty / formatQty / factorFor
  const pq = (s: string) => parseQty(s);
  check('parseQty 1½', near(pq('1½')?.value, 1.5), pq('1½'));
  check('parseQty 1 1/2', near(pq('1 1/2')?.value, 1.5), pq('1 1/2'));
  check('parseQty 1/2', near(pq('1/2')?.value, 0.5), pq('1/2'));
  check('parseQty 2.5', near(pq('2.5')?.value, 2.5), pq('2.5'));
  check('parseQty ⅔', near(pq('⅔')?.value, 2 / 3), pq('⅔'));
  check('parseQty 1⅓', near(pq('1⅓')?.value, 4 / 3), pq('1⅓'));
  check('parseQty 2–3 range', near(pq('2–3')?.value, 2) && near(pq('2–3')?.hi, 3), pq('2–3'));
  check('parseQty 2-3 range', near(pq('2-3')?.value, 2) && near(pq('2-3')?.hi, 3), pq('2-3'));
  check('parseQty 2 to 3 range', near(pq('2 to 3')?.value, 2) && near(pq('2 to 3')?.hi, 3), pq('2 to 3'));
  check('parseQty 13–15 range', near(pq('13–15')?.value, 13) && near(pq('13–15')?.hi, 15), pq('13–15'));
  check('parseQty ½–1 range', near(pq('½–1')?.value, 0.5) && near(pq('½–1')?.hi, 1), pq('½–1'));
  check('parseQty ~2 approx', near(pq('~2')?.value, 2) && pq('~2')?.approx === true, pq('~2'));
  check('parseQty about 2 approx', near(pq('about 2')?.value, 2) && pq('about 2')?.approx === true, pq('about 2'));
  check('parseQty rejects words', pq('salt') === null, pq('salt'));
  check('parseQty rejects sizes (2-lb)', pq('2-lb') === null, pq('2-lb'));
  check('formatQty 1.5 → 1½', formatQty(1.5) === '1½', formatQty(1.5));
  check('formatQty 7/3 → 2⅓', formatQty(7 / 3) === '2⅓', formatQty(7 / 3));
  check('formatQty .375 → ⅜', formatQty(0.375) === '⅜', formatQty(0.375));
  check('formatQty .75 → ¾', formatQty(0.75) === '¾', formatQty(0.75));
  check('formatQty 2/3 → ⅔', formatQty(2 / 3) === '⅔', formatQty(2 / 3));
  check('formatQty 3 → 3', formatQty(3) === '3', formatQty(3));
  check('formatQty 2.98 → 3', formatQty(2.98) === '3', formatQty(2.98));
  check('formatQty 2.4 → 2.4 (no false snap)', formatQty(2.4) === '2.4', formatQty(2.4));
  check('formatQty range 4–6', formatQty(4, 6) === '4–6', formatQty(4, 6));
  check('factorFor 4 → 8 = 2', factorFor(4, 8) === 2, factorFor(4, 8));
  check('factorFor default 4 → 2 = ½', factorFor(undefined, 2) === 0.5, factorFor(undefined, 2));
  check('factorFor 6 → 9 = 1.5', factorFor(6, 9) === 1.5, factorFor(6, 9));

  // coconut-dill-salmon-green-beans-corn.md
  const SALMON = '- 1½ lb salmon fillet in one piece, skin on or off, **fresh** [C — Costco fresh Atlantic side; Kroger seafood counter is the fallback; never frozen]';
  line('salmon lead', SALMON, 2, '- 3 lb salmon fillet in one piece, skin on or off, **fresh** [C — Costco fresh Atlantic side; Kroger seafood counter is the fallback; never frozen]');
  line('salmon lead', SALMON, 0.5, '- ¾ lb salmon fillet in one piece, skin on or off, **fresh** [C — Costco fresh Atlantic side; Kroger seafood counter is the fallback; never frozen]');
  const OIL = '- 2 tbsp + 1 tsp olive oil [P]';
  line('sum a + b', OIL, 2, '- ¼ cup + 2 tsp olive oil [P]');
  line('sum a + b', OIL, 0.5, '- 1 tbsp + ½ tsp olive oil [P]');
  same('salt & pepper', '- Kosher salt and black pepper [P]');
  const DRESSING = '- **Coconut-dill dressing:** 1 cup unsweetened coconut cream [K — one 13.5-oz can; *not* sweetened "cream of coconut"] or full-fat coconut milk [P] · 2 tbsp dark brown sugar [K — not a pantry staple yet; honey [P] works at 1½ tbsp] · 1 tbsp sherry vinegar [K — or red wine vinegar [P]] · 1 tsp Dijon mustard [P] · zest of 1 lemon + 2 tbsp juice [P] · 1 serrano, finely minced [K] · ½ cup chopped fresh dill [K] · 1 tsp kosher salt · ½ tsp black pepper';
  line('dressing (label, · segments, nested tags)', DRESSING, 2, '- **Coconut-dill dressing:** 2 cups unsweetened coconut cream [K — one 13.5-oz can; *not* sweetened "cream of coconut"] or full-fat coconut milk [P] · ¼ cup dark brown sugar [K — not a pantry staple yet; honey [P] works at 1½ tbsp] · 2 tbsp sherry vinegar [K — or red wine vinegar [P]] · 2 tsp Dijon mustard [P] · zest of 2 lemons + ¼ cup juice [P] · 2 serranos, finely minced [K] · 1 cup chopped fresh dill [K] · 2 tsp kosher salt · 1 tsp black pepper');
  line('dressing (label, · segments, nested tags)', DRESSING, 0.5, '- **Coconut-dill dressing:** ½ cup unsweetened coconut cream [K — one 13.5-oz can; *not* sweetened "cream of coconut"] or full-fat coconut milk [P] · 1 tbsp dark brown sugar [K — not a pantry staple yet; honey [P] works at 1½ tbsp] · 1½ tsp sherry vinegar [K — or red wine vinegar [P]] · ½ tsp Dijon mustard [P] · zest of ½ lemon + 1 tbsp juice [P] · ½ serrano, finely minced [K] · ¼ cup chopped fresh dill [K] · ½ tsp kosher salt · ¼ tsp black pepper');
  const BEANS = '- 12 oz green beans, trimmed and halved crosswise [C — 2-lb bag of French beans; the rest roasts as a side later in the week]';
  line('green beans (oz → lb tidy)', BEANS, 2, '- 1½ lb green beans, trimmed and halved crosswise [C — 2-lb bag of French beans; the rest roasts as a side later in the week]');
  line('green beans', BEANS, 0.5, '- 6 oz green beans, trimmed and halved crosswise [C — 2-lb bag of French beans; the rest roasts as a side later in the week]');
  const CORN = '- 1½ cups fresh corn kernels, from 2 ears [K — in season; out of season use thawed frozen kernels]';
  line('corn (from N ears)', CORN, 2, '- 3 cups fresh corn kernels, from 4 ears [K — in season; out of season use thawed frozen kernels]');
  line('corn (from N ears)', CORN, 0.5, '- ¾ cup fresh corn kernels, from 1 ear [K — in season; out of season use thawed frozen kernels]');
  const TOMS = '- 1 pint cherry or grape tomatoes, halved or lightly crushed [C — 2-lb clamshell; the remainder is lunch fodder]';
  line('pint tomatoes', TOMS, 2, '- 2 pints cherry or grape tomatoes, halved or lightly crushed [C — 2-lb clamshell; the remainder is lunch fodder]');
  line('pint tomatoes', TOMS, 0.5, '- ½ pint cherry or grape tomatoes, halved or lightly crushed [C — 2-lb clamshell; the remainder is lunch fodder]');
  const DILL = '- ½ cup more chopped fresh dill to finish [K — 1 cup chopped total is 2 big bunches or 3 clamshells]';
  line('dill (tag numbers untouched)', DILL, 2, '- 1 cup more chopped fresh dill to finish [K — 1 cup chopped total is 2 big bunches or 3 clamshells]');
  line('dill (tag numbers untouched)', DILL, 0.5, '- ¼ cup more chopped fresh dill to finish [K — 1 cup chopped total is 2 big bunches or 3 clamshells]');
  same('lemon wedges', '- Lemon wedges, from the zested lemon plus one more [P]');

  // red-lentil-soup.md
  const CUMIN = '- 1½ tsp ground cumin [P] · ½ tsp chili powder [P] · ¼ tsp cayenne [P]';
  line('spice segments (3 tsp → 1 tbsp)', CUMIN, 2, '- 1 tbsp ground cumin [P] · 1 tsp chili powder [P] · ½ tsp cayenne [P]');
  line('spice segments', CUMIN, 0.5, '- ¾ tsp ground cumin [P] · ¼ tsp chili powder [P] · ⅛ tsp cayenne [P]');
  const STOCK = '- 1 quart chicken stock or better-than-bouillon equivalent [P] + 3 cups water';
  line('sum after a tag', STOCK, 2, '- 2 quarts chicken stock or better-than-bouillon equivalent [P] + 6 cups water');
  line('sum after a tag', STOCK, 0.5, '- ½ quart chicken stock or better-than-bouillon equivalent [P] + 1½ cups water');
  const JUICE = '- Juice of 1 lemon, plus wedges from a second [P]';
  line('juice of N lemon', JUICE, 2, '- Juice of 2 lemons, plus wedges from a second [P]');
  line('juice of N lemon', JUICE, 0.5, '- Juice of ½ lemon, plus wedges from a second [P]');
  const PITAS = '- 4 pitas, warmed [K — bakery; freeze on shop day, see prep_ahead]';
  line('pitas', PITAS, 2, '- 8 pitas, warmed [K — bakery; freeze on shop day, see prep_ahead]');
  line('pitas', PITAS, 0.5, '- 2 pitas, warmed [K — bakery; freeze on shop day, see prep_ahead]');
  line('pitas (singularize)', PITAS, 0.25, '- 1 pita, warmed [K — bakery; freeze on shop day, see prep_ahead]');
  const ONION = '- 1 large yellow onion, chopped [P]';
  line('onion (pluralize past adjectives)', ONION, 2, '- 2 large yellow onions, chopped [P]');
  line('onion', ONION, 0.5, '- ½ large yellow onion, chopped [P]');
  const GARLIC = '- 4 cloves garlic, minced [P]';
  line('cloves', GARLIC, 0.5, '- 2 cloves garlic, minced [P]');
  line('cloves (singularize)', GARLIC, 0.25, '- 1 clove garlic, minced [P]');
  const CARROTS = '- 2 carrots, peeled and diced [K — small bag]';
  line('carrots', CARROTS, 2, '- 4 carrots, peeled and diced [K — small bag]');
  line('carrots (singularize)', CARROTS, 0.5, '- 1 carrot, peeled and diced [K — small bag]');
  const CHILE_OIL = '- **Chile oil (the finish):** 2 tbsp olive oil [P] · 1 tsp red pepper flakes (Aleppo or Urfa if there is any) [P] · ½ tsp smoked paprika [P] · pinch of ground cumin [P]';
  line('chile oil (label with parens)', CHILE_OIL, 2, '- **Chile oil (the finish):** ¼ cup olive oil [P] · 2 tsp red pepper flakes (Aleppo or Urfa if there is any) [P] · 1 tsp smoked paprika [P] · pinch of ground cumin [P]');
  line('chile oil (label with parens)', CHILE_OIL, 0.5, '- **Chile oil (the finish):** 1 tbsp olive oil [P] · ½ tsp red pepper flakes (Aleppo or Urfa if there is any) [P] · ¼ tsp smoked paprika [P] · pinch of ground cumin [P]');
  const LENTIL_SALT = "- Kosher salt and black pepper [P] — plan on ~2 tsp salt total; the soup reads flat until it's there";
  const ls = scaleIngredientLine(LENTIL_SALT, 2);
  check('salt aside unscaled but noted', ls.text === LENTIL_SALT && !ls.scaled && ls.notes?.[0] === 'left as written: ~2 tsp salt total', ls);

  // other recipes
  line('shawarma marinade (range ½–1)', '- **Marinade:** ¾ cup Greek yogurt [P] · 3 tbsp lemon juice [P] · 6 cloves garlic, minced [P] · 2 tbsp olive oil [P] · 1 tbsp smoked paprika [P] · 2 tsp cumin [P] · 2 tsp ground coriander [P] · 1 tsp turmeric [P] · ½ tsp cinnamon [P] · ½–1 tsp cayenne [P] · 2 tsp salt · plenty of black pepper', 2,
    '- **Marinade:** 1½ cups Greek yogurt [P] · 6 tbsp lemon juice [P] · 12 cloves garlic, minced [P] · ¼ cup olive oil [P] · 2 tbsp smoked paprika [P] · 4 tsp cumin [P] · 4 tsp ground coriander [P] · 2 tsp turmeric [P] · 1 tsp cinnamon [P] · 1–2 tsp cayenne [P] · 4 tsp salt · plenty of black pepper');
  line('serrano or jalapeño', '- 1 serrano or jalapeño, minced (seeds out = medium) [K]', 2, '- 2 serranos or jalapeños, minced (seeds out = medium) [K]');
  const SHALLOT = '- 1 shallot or ½ yellow onion, thinly sliced [P]';
  line('or-alternative with its own amount', SHALLOT, 2, '- 2 shallots or 1 yellow onion, thinly sliced [P]');
  line('or-alternative with its own amount', SHALLOT, 0.5, '- ½ shallot or ¼ yellow onion, thinly sliced [P]');
  line('bold-wrapped amount', '- **Rub:** 5 cloves garlic, minced [P] · 2 tsp smoked paprika [P] · 1 tsp cumin [P] · **1 tsp red pepper flakes** [P] · ¼ tsp cayenne [P] · 2 tbsp olive oil [P] · salt', 2,
    '- **Rub:** 10 cloves garlic, minced [P] · 4 tsp smoked paprika [P] · 2 tsp cumin [P] · **2 tsp red pepper flakes** [P] · ½ tsp cayenne [P] · ¼ cup olive oil [P] · salt');
  const GARAM = '- 2 tsp garam masala, 1 tsp paprika, ½ tsp cayenne (medium) [P]';
  line('comma list', GARAM, 2, '- 4 tsp garam masala, 2 tsp paprika, 1 tsp cayenne (medium) [P]');
  line('comma list', GARAM, 0.5, '- 1 tsp garam masala, ½ tsp paprika, ¼ tsp cayenne (medium) [P]');
  const BC_MAR = '- Marinade: ¾ cup Greek yogurt [P], 1 tbsp garam masala [P], 1 tsp turmeric [P], 1 tsp cumin [P], 4 cloves garlic [P], 1 tbsp ginger [P], salt';
  line('plain label + comma list', BC_MAR, 2, '- Marinade: 1½ cups Greek yogurt [P], 2 tbsp garam masala [P], 2 tsp turmeric [P], 2 tsp cumin [P], 8 cloves garlic [P], 2 tbsp ginger [P], salt');
  line('plain label + comma list (⅜ cup → 6 tbsp, ½ tbsp → 1½ tsp)', BC_MAR, 0.5, '- Marinade: 6 tbsp Greek yogurt [P], 1½ tsp garam masala [P], ½ tsp turmeric [P], ½ tsp cumin [P], 2 cloves garlic [P], 1½ tsp ginger [P], salt');
  const CANS = '- 2 cans (15 oz) chickpeas, drained, liquid reserved [P]';
  line('cans (paren size untouched)', CANS, 2, '- 4 cans (15 oz) chickpeas, drained, liquid reserved [P]');
  line('cans (paren size untouched)', CANS, 0.5, '- 1 can (15 oz) chickpeas, drained, liquid reserved [P]');
  const GARLIC_SPLIT = '- 6 cloves garlic — 4 minced (gravy), 2 thinly sliced (tadka) [P]';
  line('breakdown aside', GARLIC_SPLIT, 2, '- 12 cloves garlic — 8 minced (gravy), 4 thinly sliced (tadka) [P]');
  line('breakdown aside', GARLIC_SPLIT, 0.5, '- 3 cloves garlic — 2 minced (gravy), 1 thinly sliced (tadka) [P]');
  const GHEE = '- 4 tbsp ghee — 2 for the gravy, 2 for the tadka [P]';
  line('breakdown keeps lead unit', GHEE, 2, '- 8 tbsp ghee — 4 for the gravy, 4 for the tadka [P]');
  line('breakdown keeps lead unit', GHEE, 0.5, '- 2 tbsp ghee — 1 for the gravy, 1 for the tadka [P]');
  const CAN_HALF = '- 1 can (28 oz) crushed tomatoes — use half, ~1¾ cups [P]';
  line('aside with unit amount', CAN_HALF, 2, '- 2 cans (28 oz) crushed tomatoes — use half, ~3½ cups [P]');
  line('aside with unit amount', CAN_HALF, 0.5, '- ½ can (28 oz) crushed tomatoes — use half, ~⅞ cup [P]');
  const CHUCK = '- ~2.5–3 lb chuck roast, 1.5-inch cubes (frozen from W29 — thaw in fridge from Friday) [C]';
  line('approx decimal range', CHUCK, 2, '- ~5–6 lb chuck roast, 1.5-inch cubes (frozen from W29 — thaw in fridge from Friday) [C]');
  line('approx decimal range', CHUCK, 0.5, '- ~1¼–1½ lb chuck roast, 1.5-inch cubes (frozen from W29 — thaw in fridge from Friday) [C]');
  const BROC = '- 1.5–2 lb broccoli crowns, cut into florets [C]';
  line('decimal range', BROC, 2, '- 3–4 lb broccoli crowns, cut into florets [C]');
  line('decimal range', BROC, 0.5, '- ¾–1 lb broccoli crowns, cut into florets [C]');
  const FILLETS = '- 4 salmon fillets, ~6 oz each (Costco fresh Atlantic side, portioned) [C]';
  line('per-each size untouched', FILLETS, 2, '- 8 salmon fillets, ~6 oz each (Costco fresh Atlantic side, portioned) [C]');
  line('per-each size untouched (singularize)', FILLETS, 0.25, '- 1 salmon fillet, ~6 oz each (Costco fresh Atlantic side, portioned) [C]');
  check('per-each line has no notes', scaleIngredientLine(FILLETS, 2).notes === undefined, scaleIngredientLine(FILLETS, 2).notes);
  line('steaks', '- 2 NY strip steaks, ~12 oz each [C]', 0.5, '- 1 NY strip steak, ~12 oz each [C]');
  const BAY = '- 1 tsp dried thyme, 2 bay leaves [P]';
  line('comma count', BAY, 2, '- 2 tsp dried thyme, 4 bay leaves [P]');
  line('comma count (leaves → leaf)', BAY, 0.5, '- ½ tsp dried thyme, 1 bay leaf [P]');
  line('plus N more', '- 4 scallions, chopped, plus 1 more sliced to finish [K]', 2, '- 8 scallions, chopped, plus 2 more sliced to finish [K]');
  const PANEER = '- 14 oz paneer, in 1" cubes [C — 2-pack; the second block keeps for weeks]';
  line('paneer (inch mark untouched; 28 oz → 1¾ lb)', PANEER, 2, '- 1¾ lb paneer, in 1" cubes [C — 2-pack; the second block keeps for weeks]');
  line('paneer', PANEER, 0.5, '- 7 oz paneer, in 1" cubes [C — 2-pack; the second block keeps for weeks]');
  line('16 oz → 1 lb', '- 8 oz feta [C]', 2, '- 1 lb feta [C]');
  const MILK = '- ⅓ cup whole milk, warmed [K]';
  line('thirds', MILK, 2, '- ⅔ cup whole milk, warmed [K]');
  line('⅙ cup → 2⅔ tbsp', MILK, 0.5, '- 2⅔ tbsp whole milk, warmed [K]');
  line('8 tbsp → ½ cup', '- 4 tbsp butter [P]', 2, '- ½ cup butter [P]');
  line('head (unit after adjective)', '- 1 large head broccoli, florets [C]', 2, '- 2 large heads broccoli, florets [C]');
  line('sweet potatoes (irregular; ¾-inch untouched)', '- 2 medium sweet potatoes, ¾-inch cubes [C]', 0.5, '- 1 medium sweet potato, ¾-inch cubes [C]');
  line('zucchini (invariant)', '- 2 zucchini, half-moons [K]', 0.5, '- 1 zucchini, half-moons [K]');
  line('optional label', '- Optional: 2 anchovy fillets, minced into the tomato toss [K]', 0.5, '- Optional: 1 anchovy fillet, minced into the tomato toss [K]');
  const TOFU = "- 2 blocks (14–16 oz each) extra-firm tofu [K — Costco doesn't sell single blocks sensibly; keeps for weeks, this is the at-risk night]";
  line('blocks', TOFU, 0.5, "- 1 block (14–16 oz each) extra-firm tofu [K — Costco doesn't sell single blocks sensibly; keeps for weeks, this is the at-risk night]");
  check('blocks paren not noted', scaleIngredientLine(TOFU, 0.5).notes === undefined, scaleIngredientLine(TOFU, 0.5).notes);
  const LIME = '- Juice of ½ lime (or 2 tsp red wine vinegar) to finish [P]';
  const lime2 = scaleIngredientLine(LIME, 2);
  check('juice of ½ lime ×2 (paren noted, untouched)', lime2.text === '- Juice of 1 lime (or 2 tsp red wine vinegar) to finish [P]' && lime2.notes?.[0] === 'left as written: (or 2 tsp red wine vinegar)', lime2);
  const CREMA = '- **Chipotle-lime crema:** ¾ cup Greek yogurt [P] · ¼ cup mayonnaise [P] · 2 chipotles in adobo, minced, + 1 tbsp of the adobo sauce [K] · zest + juice of 1 lime [P] · ½ tsp salt';
  line('crema', CREMA, 2, '- **Chipotle-lime crema:** 1½ cups Greek yogurt [P] · ½ cup mayonnaise [P] · 4 chipotles in adobo, minced, + 2 tbsp of the adobo sauce [K] · zest + juice of 2 limes [P] · 1 tsp salt');
  line('crema (⅜ cup, ⅛ cup, ½ tbsp)', CREMA, 0.5, '- **Chipotle-lime crema:** 6 tbsp Greek yogurt [P] · 2 tbsp mayonnaise [P] · 1 chipotle in adobo, minced, + 1½ tsp of the adobo sauce [K] · zest + juice of ½ lime [P] · ¼ tsp salt');
  line('scotch bonnet', '- 1 whole scotch bonnet (or habanero) [K]', 2, '- 2 whole scotch bonnets (or habanero) [K]');
  const TORT = "- 12 corn tortillas (3 per serving) [K — Costco's count is restaurant-sized]";
  line('per-serving paren untouched', TORT, 0.5, "- 6 corn tortillas (3 per serving) [K — Costco's count is restaurant-sized]");
  check('per-serving paren not noted', scaleIngredientLine(TORT, 0.5).notes === undefined, scaleIngredientLine(TORT, 0.5).notes);
  const GINGER = '- 1 tbsp ginger + 3 cloves garlic, minced [P]';
  line('sum with count unit', GINGER, 2, '- 2 tbsp ginger + 6 cloves garlic, minced [P]');
  line('sum with count unit', GINGER, 0.5, '- 1½ tsp ginger + 1½ cloves garlic, minced [P]');
  const PAN = '- **Pan sauce:** 3 cloves garlic, minced [P] · ½ cup dry white wine [K] · 1 cup chicken stock [P] · juice + zest of 1½ lemons [P] · 3–4 tbsp capers, drained [P] · 2 tbsp cold butter, to mount [P]';
  line('pan sauce', PAN, 2, '- **Pan sauce:** 6 cloves garlic, minced [P] · 1 cup dry white wine [K] · 2 cups chicken stock [P] · juice + zest of 3 lemons [P] · 6–8 tbsp capers, drained [P] · ¼ cup cold butter, to mount [P]');
  line('pan sauce', PAN, 0.5, '- **Pan sauce:** 1½ cloves garlic, minced [P] · ¼ cup dry white wine [K] · ½ cup chicken stock [P] · juice + zest of ¾ lemon [P] · 1½–2 tbsp capers, drained [P] · 1 tbsp cold butter, to mount [P]');
  line('bunch', '- **Ginger-scallion sauce:** 1 bunch scallions, minced [K] · 2 tbsp grated ginger [P] · ⅓ cup neutral oil, heated smoking-hot [P] · 1 tbsp soy sauce [P] · ½ tsp salt', 2,
    '- **Ginger-scallion sauce:** 2 bunches scallions, minced [K] · ¼ cup grated ginger [P] · ⅔ cup neutral oil, heated smoking-hot [P] · 2 tbsp soy sauce [P] · 1 tsp salt');
  line('quick pickle', '- **Quick-pickled cucumber:** 2 cucumbers, thinly sliced [K] · ⅓ cup rice vinegar [P] · 1 tsp sugar or honey [P] · 1 tsp salt', 0.5,
    '- **Quick-pickled cucumber:** 1 cucumber, thinly sliced [K] · 2⅔ tbsp rice vinegar [P] · ½ tsp sugar or honey [P] · ½ tsp salt');
  const RAITA = '- Raita: 1 cup Greek yogurt [P], ½ cucumber grated & squeezed [K], pinch ground cumin + salt [P]';
  line('raita comma count', RAITA, 2, '- Raita: 2 cups Greek yogurt [P], 1 cucumber grated & squeezed [K], pinch ground cumin + salt [P]');
  line('raita comma count (pluralize)', RAITA, 4, '- Raita: 4 cups Greek yogurt [P], 2 cucumbers grated & squeezed [K], pinch ground cumin + salt [P]');
  const CHARD = '- 1 lb chard or kale (2 bunches), leaves and stems chopped into 1-inch pieces [K — chard is the better choice here for the stems; the Costco kale bag works if the remainder has a lunch plan]';
  const chard2 = scaleIngredientLine(CHARD, 2);
  check('chard ×2 (paren noted, untouched)', chard2.text === '- 2 lb chard or kale (2 bunches), leaves and stems chopped into 1-inch pieces [K — chard is the better choice here for the stems; the Costco kale bag works if the remainder has a lunch plan]'
    && JSON.stringify(chard2.notes) === JSON.stringify(['left as written: (2 bunches)']), chard2);
  const PUTT = '- 1½ lb salmon fillets, 4 × 6 oz (or the thawed ~1 lb freezer remainder at 3 portions) [C]';
  const putt2 = scaleIngredientLine(PUTT, 2);
  check('puttanesca ×2 (multiplier + paren noted)', putt2.text === '- 3 lb salmon fillets, 4 × 6 oz (or the thawed ~1 lb freezer remainder at 3 portions) [C]'
    && JSON.stringify(putt2.notes) === JSON.stringify(['left as written: 4 × 6 oz', 'left as written: (or the thawed ~1 lb freezer remainder at 3 portions)']), putt2);
  check('factor 1 is byte-identical', scaleIngredientLine('- 1.5 lb large shrimp, peeled/deveined [C]', 1).text === '- 1.5 lb large shrimp, peeled/deveined [C]');
  let threw = false;
  try { scaleIngredientLine(SALMON, 0); } catch { threw = true; }
  check('factor 0 rejected', threw);

  // headline — exact-value checks read byte-for-byte snapshots of the recipes
  // taken 2026-10-11 (app/scripts/fixtures/recipe-<slug>-2026-10-11.md), so a
  // library rewrite can't break them; only the shape-only sweep reads live files.
  const readRecipe = (f: string) => fs.readFile(path.join(repoRoot, 'recipes', f), 'utf8');
  const readFixture = (slug: string) => fs.readFile(path.join(repoRoot, `app/scripts/fixtures/recipe-${slug}-2026-10-11.md`), 'utf8');
  const servingsOf = (t: string) => { const m = /^servings:\s*(\d+(?:\.\d+)?)\s*$/m.exec(t); return m ? Number(m[1]) : undefined; };
  const dalSrc = await readFixture('red-lentil-dal');
  const harissaSrc = await readFixture('harissa-salmon-sheet-pan');
  check('headline red-lentil-dal ×2', headline(dalSrc, 2) === '3 cups red lentils', headline(dalSrc, 2));
  check('headline harissa-salmon ×2', headline(harissaSrc, 2) === '8 salmon fillets', headline(harissaSrc, 2));
  check('headline count noun', headline('## Ingredients\n- 4 pitas, warmed [K]\n', 1) === '4 pitas', headline('## Ingredients\n- 4 pitas, warmed [K]\n', 1));
  check('headline null without a quantity', headline('## Ingredients\n- Kosher salt [P]\n', 2) === null);

  // the salmon example end to end: recipe serves 4 → 8 servings (fixture snapshot)
  const salmonSrc = await readFixture('coconut-dill-salmon-green-beans-corn');
  const f8 = factorFor(servingsOf(salmonSrc), 8);
  const salmon8 = scaleIngredients(salmonSrc, f8);
  console.log('\nscale: coconut-dill salmon → 8 servings (fixture recipe-coconut-dill-salmon-green-beans-corn-2026-10-11.md):');
  check('factor is 2', f8 === 2, f8);
  check('headline 3 lb salmon fillet', headline(salmonSrc, f8) === '3 lb salmon fillet', headline(salmonSrc, f8));
  for (const want of [
    '- 3 lb salmon fillet in one piece',
    ' 2 cups unsweetened coconut cream [K — one 13.5-oz can; *not* sweetened "cream of coconut"]',
    '- 1½ lb green beans, trimmed and halved crosswise [C — 2-lb bag of French beans;',
    '- 3 cups fresh corn kernels, from 4 ears [',
    '- 2 pints cherry or grape tomatoes,',
    ' · 1 cup chopped fresh dill [K]',
    ' · zest of 2 lemons + ¼ cup juice [P]',
  ]) check(`has "${want.trim()}"`, salmon8.body.includes(want));
  check('3 unscaled (salt, wedges, foil)', salmon8.unscaled.length === 3 && salmon8.unscaled[0] === '- Kosher salt and black pepper [P]', salmon8.unscaled);
  check('servings frontmatter untouched', salmon8.body.includes('\nservings: 4\n'));
  const lentil2 = scaleIngredients(await readFixture('red-lentil-soup'), 2);
  check('red-lentil-soup ×2: Juice of 2 lemons', lentil2.body.includes('\n- Juice of 2 lemons, plus wedges from a second [P]\n'));
  check('red-lentil-soup ×2: salt aside is unscaled AND flagged', lentil2.unscaled.includes(LENTIL_SALT)
    && lentil2.flagged.some((x) => x.line === LENTIL_SALT && x.notes[0] === 'left as written: ~2 tsp salt total'), lentil2.flagged);

  // synthetic edge cases (not in the library yet)
  line('word unit singularizes', '- 2 teaspoons salt', 0.5, '- 1 teaspoon salt');
  line('lbs → lb at 1', '- 2 lbs ground beef', 0.5, '- 1 lb ground beef');
  line('"to" range keeps its shape', '- 2 to 3 tbsp oil', 2, '- 4 to 6 tbsp oil');
  line('mixed 1 1/2', '- 1 1/2 cups rice', 2, '- 3 cups rice');
  line('size-adjective count untouched (4 6-oz)', '- 4 6-oz salmon fillets [C]', 2, '- 8 6-oz salmon fillets [C]');
  same('temperature only', '- Oven at 450°F');
  const crlfBody = '## Ingredients\r\n- 1 lemon [P]\r\n\r\n## Steps\r\n1. Zest 1 lemon, 15 min.\r\n';
  check('CRLF kept; Steps untouched', scaleIngredients(crlfBody, 2).body === '## Ingredients\r\n- 2 lemons [P]\r\n\r\n## Steps\r\n1. Zest 1 lemon, 15 min.\r\n', scaleIngredients(crlfBody, 2).body);

  // the whole library at ×2 and ×½: never throws; only Ingredients list lines change
  console.log('\nscale: library sweep (×2; unscaled = no scalable amount, flagged = numbers left as written):');
  const isItem = (l: string, inSec: boolean) => inSec && /^\s*[-*]\s+\S/.test(l);
  const recipeFiles = (await fs.readdir(path.join(repoRoot, 'recipes'))).filter((f) => f.endsWith('.md')).sort();
  for (const f of recipeFiles) {
    const src = await readRecipe(f);
    let ok = true;
    let detail = '';
    let counts = '';
    for (const factor of [2, 0.5]) {
      try {
        const r = scaleIngredients(src, factor);
        const a = src.split('\n');
        const b = r.body.split('\n');
        if (a.length !== b.length) { ok = false; detail = `line count ${a.length} → ${b.length}`; continue; }
        let inSec = false;
        for (let i = 0; i < a.length; i++) {
          if (/^#{1,2}\s/.test(a[i]!)) inSec = /^##\s+Ingredients\b/.test(a[i]!);
          if (!isItem(a[i]!, inSec) && a[i] !== b[i]) { ok = false; detail = `non-ingredient line ${i + 1} changed`; }
        }
        if (factor === 2) counts = `${r.unscaled.length} unscaled, ${r.flagged.length} flagged`;
      } catch (e) { ok = false; detail = String(e); }
    }
    check(`${f}: ${counts}`, ok, detail || undefined);
  }
}

// ---- Cook tab recipe sections (server/recipe-sections.ts) ----
// Exact values pin the 2026-10-11 snapshot of recipes/red-lentil-soup.md
// (byte-identical to the live file today; the prep-first migration will
// rewrite the live one), plus a synthetic body in the post-migration shape
// (## Prep with **Component:** prefixes). The live sweep is shape-only.
{
  const { recipeSections, scaledSections, frontmatterNumber } = await import('../server/recipe-sections.ts');
  console.log('\nrecipe sections (Cook tab):');
  const lentilSrc = await fs.readFile(path.join(repoRoot, 'app/scripts/fixtures/recipe-red-lentil-soup-2026-10-11.md'), 'utf8');
  const lentil = recipeSections(lentilSrc);
  check('red-lentil-soup: 14 ingredients, markers stripped, source comment dropped, bold label kept',
    lentil.ingredients.length === 14 && lentil.ingredients[0] === '3 tbsp olive oil [P]' && lentil.inserts.ingredients.length === 0
      && lentil.ingredients[11] === '**Chile oil (the finish):** 2 tbsp olive oil [P] · 1 tsp red pepper flakes (Aleppo or Urfa if there is any) [P] · ½ tsp smoked paprika [P] · pinch of ground cumin [P]',
    { n: lentil.ingredients.length, first: lentil.ingredients[0], label: lentil.ingredients[11], ins: lentil.inserts.ingredients });
  check('red-lentil-soup: 6 steps (numbers stripped), no Prep → [], comment-only Notes → ""',
    lentil.steps.length === 6 && lentil.steps[0]!.startsWith('Heat the 3 tbsp oil in the Dutch oven') && lentil.steps[5]!.endsWith('a lemon wedge and a pita each.')
      && lentil.prep.length === 0 && lentil.notesMd === '',
    { steps: lentil.steps.map((s) => s.slice(0, 24)), prep: lentil.prep, notes: lentil.notesMd });
  const lentil2 = scaledSections(lentilSrc, 4, 8);
  const same = scaledSections(lentilSrc, 4, 4).scale;
  check('scaledSections: at 8 factor 2 + scaled texts + marker-stripped unscaled; at 4 factor 1, no unscaled/flagged',
    lentil2.scale.factor === 2 && lentil2.scale.factorText === '2' && lentil2.sections.ingredients[0] === '6 tbsp olive oil [P]'
      && lentil2.sections.ingredients[9] === 'Juice of 2 lemons, plus wedges from a second [P]'
      && (lentil2.scale.unscaled ?? []).some((u) => u.startsWith('Kosher salt and black pepper [P]'))
      && same.factor === 1 && !('unscaled' in same) && !('flagged' in same),
    { at8: lentil2.scale, at4: same });

  const synth = [
    '---', 'name: Synthetic', 'servings: 4', 'prep_min: 15', '---', '',
    '## Ingredients', '<!-- [C] Costco -->', '**Chicken**', '- 2 lb chicken thighs [C]', '- 1 tbsp oil [P]', '',
    '**Glaze:**', '- 3 tbsp gochujang [K]', '',
    '## Prep', '- **Chicken:** pat the thighs dry, salt both sides', '- **Glaze:** grate the garlic and ginger,',
    '  whisk everything together', '- slice the scallions', '',
    '## Steps', '1. Sear the thighs, 5–6 min a side.', '2. Glaze in; toss 2–3 min', 'until sticky.', '',
    '**Grill instead:** same timing over direct heat.', '',
    '## Notes', '<!-- learnings -->', '- Double the glaze next time.', '',
    '## Wine', 'Off-dry riesling.',
  ].join('\n');
  const sy = recipeSections(synth);
  check('synthetic: ## Prep items keep **Component:** prefixes; indented line joins with \\n',
    sy.prep.length === 3 && sy.prep[0] === '**Chicken:** pat the thighs dry, salt both sides'
      && sy.prep[1] === '**Glaze:** grate the garlic and ginger,\nwhisk everything together' && sy.prep[2] === 'slice the scallions',
    sy.prep);
  check('synthetic: bold-only lines become ingredient group heads at the right index',
    JSON.stringify(sy.inserts.ingredients) === JSON.stringify([{ before: 0, text: 'Chicken', head: true }, { before: 2, text: 'Glaze', head: true }])
      && sy.ingredients.length === 3,
    sy.inserts.ingredients);
  check('synthetic: lazy continuation joins the step; trailing paragraph is a steps aside',
    sy.steps.length === 2 && sy.steps[1] === 'Glaze in; toss 2–3 min until sticky.'
      && sy.inserts.steps.length === 1 && sy.inserts.steps[0]!.before === 2 && sy.inserts.steps[0]!.head === false
      && sy.inserts.steps[0]!.text.startsWith('**Grill instead:**'),
    { steps: sy.steps, ins: sy.inserts.steps });
  check('synthetic: notes keep markdown, drop comments, fold "## Wine" under its heading; prep_min read from frontmatter',
    sy.notesMd === '- Double the glaze next time.\n\n### Wine\n\nOff-dry riesling.'
      && frontmatterNumber(synth, 'prep_min') === 15 && frontmatterNumber(lentilSrc, 'prep_min') === undefined,
    sy.notesMd);

  // live library, shape only (survives the prep-first migration): every recipe
  // has ingredients and steps, and no item text still carries its list marker
  const files = (await fs.readdir(path.join(repoRoot, 'recipes'))).filter((f) => f.endsWith('.md') && f !== 'README.md');
  const bad: string[] = [];
  for (const f of files) {
    const s = recipeSections(await fs.readFile(path.join(repoRoot, 'recipes', f), 'utf8'));
    const items = [...s.ingredients, ...s.prep, ...s.steps];
    if (!s.ingredients.length || !s.steps.length || items.some((t) => /^(?:[-*+]|\d+[.)])\s/.test(t) || t.includes('<!--'))) bad.push(f);
  }
  check(`live recipes/ (${files.length}): ingredients + steps found, markers stripped`, bad.length === 0, bad);
}

// ---- trends (server/trends.ts): real plans + recipes, then a synthetic week ----
console.log('\ntrends:');
{
  const { computeTrends, trendsPromptBlock, laneOf } = await import('../server/trends.ts');
  const { readAllPlans, readRecipes } = await import('../server/repo.ts');
  // real: needs this household's history (W33…W42); the synthetic week below always runs
  if (!REAL) console.log('  (real-history trends checks skipped: no real plans in this repo)');
  else {
    const plans = [...(await readAllPlans()).values()];
    const recipes = await readRecipes();
    const t = computeTrends(plans, recipes, { weeks: 12 });
    const wk = (id: string) => t.weeks.find((w) => w.week === id);
    check(`real: ${t.weeks.length} weeks returned (≥ 8), oldest first`,
      t.weeks.length >= 8 && t.weeks.every((w, i) => i === 0 || t.weeks[i - 1]!.week < w.week), t.weeks.map((w) => w.week));
    check('real: W42 has 3 planned nights', wk('2026-W42')?.planned === 3, wk('2026-W42'));
    check('real: every week cooked ≤ planned', t.weeks.every((w) => w.cooked <= w.planned),
      t.weeks.filter((w) => w.cooked > w.planned).map((w) => w.week));
    check('real: averages sane (300–1200 cal, 10–80 g protein)',
      t.weeks.every((w) => !w.avg || ((w.avg.calories ?? 600) >= 300 && (w.avg.calories ?? 600) <= 1200
        && (w.avg.protein_g ?? 30) >= 10 && (w.avg.protein_g ?? 30) <= 80)),
      t.weeks.map((w) => [w.week, w.avg?.calories, w.avg?.protein_g]));
    check('real: lanes sum to cooked', t.weeks.every((w) => Object.values(w.lanes).reduce((a, b) => a + b, 0) === w.cooked),
      t.weeks.map((w) => [w.week, w.cooked, w.lanes]));
    check('real: W33 (locked, empty log) is all unlogged, no averages',
      wk('2026-W33')?.unlogged === 4 && wk('2026-W33')?.cooked === 0 && wk('2026-W33')?.avg === null, wk('2026-W33'));
    check('real: W39 free-text "Red lentil soup (NYT recipe)" resolves to recipes/red-lentil-soup.md (plant lane)',
      (wk('2026-W39')?.lanes.plant ?? 0) >= 1 && wk('2026-W39')?.nutritionN === 3, wk('2026-W39'));
    const ip = computeTrends(plans, recipes, { weeks: 12, through: '2026-W42', inProgress: '2026-W42' });
    check('real: through + inProgress — W42 last, flagged, kept out of the summary',
      ip.weeks.at(-1)?.week === '2026-W42' && ip.weeks.at(-1)?.inProgress === true && !ip.summaryWeeks.includes('2026-W42')
        && /^Last \d weeks \([A-Z][a-z]{2} \d{1,2}–(?:[A-Z][a-z]{2} )?\d{1,2}\): \d\.\d of [\d.]+ nights cooked, ~\d+ cal \/ \d+ g protein per serving, red meat \d+ nights?, plant protein \d+ nights?, avg rating \d\.\d/.test(ip.summary),
      ip.summary);
    const early = computeTrends(plans, recipes, { weeks: 12, through: '2026-W40' });
    check('real: through drops later weeks', early.weeks.at(-1)?.week === '2026-W40', early.weeks.at(-1)?.week);
    const block = trendsPromptBlock(computeTrends(plans, recipes, { weeks: 6, through: '2026-W42' }), '2026-W42');
    check('real: {{TRENDS}} block = summary + header + 6 week rows',
      block.includes('Last ') && (block.match(/^\| 2026-W\d\d \|/gm) ?? []).length === 6 && block.includes('| Week | Cooked/planned |'),
      block);
  }
  check('laneOf: live protein values map to lanes',
    laneOf('chicken-thighs') === 'chicken' && laneOf('white-fish') === 'fish' && laneOf('beef-strip-steak') === 'red'
      && laneOf('white-beans') === 'plant' && laneOf('paneer') === 'plant' && laneOf('beef-oxtail') === 'red' && laneOf('eggs') === 'other',
    ['chicken-thighs', 'white-fish', 'beef-strip-steak', 'white-beans', 'paneer', 'beef-oxtail', 'eggs'].map(laneOf));

  // synthetic: as planned, a flexible-night skip (ignored), `skipped — …`, a
  // linked substitution, a missing recipe (plan-row fallback), a night with no log row
  const synth = parsePlan([
    '# Week of test (2026-W50)', '', '**Status:** locked (test)', '', '## Plan', '',
    '| Day | Meal | Recipe | Active time | Cal/serving | Protein | Status |',
    '|-----|------|--------|-------------|-------------|---------|--------|',
    '| Sat | dinner | [Test chicken](../recipes/t-chicken.md) 🆕 | 30 min | ~500 | ~40 g | approved |',
    '| Sun | — | flexible (leftovers / out) | | | | — |',
    '| Mon | dinner | [Test lentils](../recipes/t-lentils.md) | 30 min | ~450 | ~20 g | approved |',
    '| Tue | dinner | [Test steak](../recipes/t-steak.md) | 30 min | ~700 | ~50 g | approved |',
    '| Wed | dinner | [Mystery stew](../recipes/t-missing.md) | 30 min | ~610 | ~33 g | approved |',
    '| Thu | dinner | [Test salmon](../recipes/t-salmon.md) | 20 min | ~600 | ~38 g | approved |',
    '', '## Log', '',
    '| Day | Planned | Actually cooked | Rating (1–5) | Notes |',
    '|-----|---------|-----------------|--------------|-------|',
    '| Sat | Test chicken | as planned | 4 | |',
    '| Sun | flexible | skipped | | |',
    '| Mon | Test lentils | skipped — didn\'t cook | | |',
    '| Tue | Test steak | [Test salmon](../recipes/t-salmon.md) | 5 | swapped |',
    '| Wed | Mystery stew | as planned | 3 | |',
  ].join('\n'), '2026-W50.md');
  const nut = (calories: number, protein_g: number, carbs_g: number) => ({ calories, protein_g, carbs_g, fat_g: 20, fiber_g: 5 });
  const synthRecipes = [
    { file: 't-chicken.md', name: 'Test chicken', protein: 'chicken-thigh', nutrition: nut(520, 42, 40), prep_ahead: [] },
    { file: 't-lentils.md', name: 'Test lentils', protein: 'lentils', nutrition: nut(450, 20, 60), prep_ahead: [] },
    { file: 't-steak.md', name: 'Test steak', protein: 'beef-strip-steak', nutrition: nut(700, 50, 10), prep_ahead: [] },
    { file: 't-salmon.md', name: 'Test salmon', protein: 'salmon', nutrition: nut(600, 38, 30), prep_ahead: [] },
  ];
  const s = computeTrends([synth], synthRecipes).weeks[0];
  check('synthetic: `skipped — …` counts as skipped; a flexible-night "skipped" does not',
    s?.skipped === 1 && s?.planned === 5 && s?.cooked === 3 && s?.unlogged === 1, s);
  check('synthetic: substitution link uses the linked recipe; missing recipe falls back to the plan row',
    s?.avg?.calories === 577 && s?.avg?.protein_g === 37.7 && s?.avg?.carbs_g === 35 && s?.nutritionN === 3, s?.avg);
  check('synthetic: lanes (chicken, fish via the swap, other for the unknown stew), rating, 🆕 count',
    s?.lanes.chicken === 1 && s?.lanes.fish === 1 && s?.lanes.other === 1 && s?.lanes.red === 0 && s?.lanes.plant === 0
      && s?.avgRating === 4 && s?.newCount === 1, s);
  check('synthetic: one logged week is not enough for a two-week card, but the summary still reads',
    computeTrends([synth], synthRecipes).summary.startsWith('Last week (Dec 5–11): 3.0 of 5 nights cooked'),
    computeTrends([synth], synthRecipes).summary);
}

// ---- servings: Plan-table column + pre-scaled lock/rescale prompts ----
// The Plan table is read by header, so files without a Servings column (every
// real file before 2026-10) parse exactly as they did, at 4 servings. The
// prompt check writes a throwaway planning file for a far-future week
// (2099-W10, so no dev server's Next tab picks it up) plus a recipes/ copy of
// the salmon fixture snapshot, and always deletes both.
{
  const { buildPrompt } = await import('../server/runs.ts');
  const store = await import('../server/store.ts');
  const { ingredientListLines } = await import('../server/parse.ts');
  console.log('\nservings column + scaled prompts:');

  // every real plan file: non-flexible meals at 4, flexible rows without servings,
  // and adding a Servings column of 4s changes nothing else in the parse
  const planFiles = (await fs.readdir(path.join(repoRoot, 'plans'))).filter((f) => /^\d{4}-W\d{2}\.md$/.test(f)).sort();
  const off: string[] = [];
  const drift: string[] = [];
  const withServings = (raw: string) => {
    let inPlan = false;
    return raw.split('\n').map((l) => {
      if (l.startsWith('## ')) inPlan = /^## Plan\b/.test(l);
      if (!inPlan || !l.trim().startsWith('|')) return l;
      const c = l.split('|');
      const isHead = /^\s*day\s*$/i.test(c[1] ?? '');
      const isSep = /^\s*:?-{3,}/.test(c[1] ?? '');
      c.splice(4, 0, isHead ? ' Servings ' : isSep ? '----------' : ' 4 ');
      return c.join('|');
    }).join('\n');
  };
  for (const f of planFiles) {
    const raw = await fs.readFile(path.join(repoRoot, 'plans', f), 'utf8');
    const p = parsePlan(raw, f);
    if (p.meals.some((m) => (m.flexible ? m.servings !== undefined : m.servings !== 4))) off.push(f);
    if (JSON.stringify(parsePlan(withServings(raw), f).meals) !== JSON.stringify(p.meals)) drift.push(f);
  }
  if (REAL) {
    check(`real plans (${planFiles.length}): every non-flexible meal at servings 4, flexible rows without`, planFiles.length >= 14 && off.length === 0, off);
    check('real plans: inserting a Servings column of 4s leaves every parsed meal identical', drift.length === 0, drift);
  } else console.log(`  (real-plans servings sweep skipped: ${planFiles.length} plan files, no real history)`);

  const table = (header: string, rows: string[]) => parsePlan(
    ['# Week of March 3–9, 2099 (2099-W10)', '', '**Status:** planning', '', '## Plan', '', header,
      header.replace(/[^|]+/g, '---'), ...rows, '', '## Log', ''].join('\n'), '2099-W10.md').meals;
  const NEW = '| Day | Meal | Recipe | Servings | Active time | Cal/serving | Protein | Status |';
  const OLD = '| Day | Meal | Recipe | Active time | Cal/serving | Protein | Status |';
  const neu = table(NEW, [
    '| Sat | dinner | [Salmon](../recipes/x.md) ⭐5 | 6 | 20 min | ~740 | ~40 g | approved |',
    '| Sun | dinner | Harissa Stew 🆕 | ~9 | 35 min | 520 | 22 g | proposed |',
    '| Mon | — | flexible (leftovers / out) | | | | | — |',
    '| Tue | dinner | [Thighs](../recipes/y.md) | 9 (3½ lb) | 30 min | 570 | 40 g | approved |',
    '| Wed | dinner | Soup | | 30 min | 600 | 25 g | approved |',
    '| Thu | dinner | Tacos | **8** | 25 min | 610 | 35 g | approved |',
  ]);
  const by = (ms: typeof neu, d: string) => ms.find((m) => m.day === d);
  check('new layout: Servings 6 / ~9 / 9 (3½ lb) / empty / **8** → 6, 9, 9, 4, 8; flexible has none',
    by(neu, 'Sat')?.servings === 6 && by(neu, 'Sun')?.servings === 9 && by(neu, 'Tue')?.servings === 9
      && by(neu, 'Wed')?.servings === 4 && by(neu, 'Thu')?.servings === 8 && by(neu, 'Mon')?.flexible === true
      && by(neu, 'Mon')?.servings === undefined,
    neu.map((m) => [m.day, m.servings]));
  check('new layout: the columns after Servings still land (time 20, cal 740, protein 40, status, link, 🆕)',
    by(neu, 'Sat')?.timeMin === 20 && by(neu, 'Sat')?.cal === 740 && by(neu, 'Sat')?.protein === 40
      && by(neu, 'Sat')?.status === 'approved' && by(neu, 'Sat')?.recipeFile === 'x.md' && by(neu, 'Sat')?.favRating === 5
      && by(neu, 'Sun')?.status === 'proposed' && by(neu, 'Sun')?.isNew === true && by(neu, 'Tue')?.recipeFile === 'y.md',
    by(neu, 'Sat'));
  const old = table(OLD, [
    '| Sat | dinner | [Salmon](../recipes/x.md) ⭐5 | 20 min | ~740 | ~40 g | approved |',
    '| Sun | dinner | Harissa Stew 🆕 | 35 min | 520 | 22 g | proposed |',
    '| Mon | — | flexible (leftovers / out) | | | | — |',
    '| Tue | dinner | [Thighs](../recipes/y.md) | 30 min | 570 | 40 g | approved |',
    '| Wed | dinner | Soup | 30 min | 600 | 25 g | approved |',
    '| Thu | dinner | Tacos | 25 min | 610 | 35 g | approved |',
  ]);
  const sansServings = (ms: typeof neu) => JSON.stringify(ms.map(({ servings: _s, ...rest }) => rest));
  check('old layout (no Servings column): same meals as the new layout, every cook night at 4',
    sansServings(old) === sansServings(neu) && old.filter((m) => !m.flexible).every((m) => m.servings === 4),
    old.map((m) => [m.day, m.servings, m.timeMin, m.status]));
  const shuffled = table('| day | meal | recipe | status | SERVINGS | active time | cal/serving | protein |', [
    '| Sat | dinner | [Salmon](../recipes/x.md) ⭐5 | approved | 6 | 20 min | ~740 | ~40 g |',
  ]);
  check('header-aware: lowercase + reordered columns map by name',
    shuffled[0]?.servings === 6 && shuffled[0]?.status === 'approved' && shuffled[0]?.timeMin === 20 && shuffled[0]?.protein === 40,
    shuffled[0]);

  // The salmon checks read the 2026-10-11 snapshot (app/scripts/fixtures/), not
  // the live recipe the prep-first migration rewrites. The prompt builder only
  // reads recipes/, so the prompt checks below link a throwaway copy of the
  // snapshot there, deleted in the finally like the plan file.
  const salmonRaw = await fs.readFile(path.join(repoRoot, 'app/scripts/fixtures/recipe-coconut-dill-salmon-green-beans-corn-2026-10-11.md'), 'utf8');
  const salmonLines = ingredientListLines(parseRecipe(salmonRaw, 'coconut-dill-salmon-green-beans-corn.md').body);
  check('ingredientListLines: the salmon recipe\'s `- ` items, comment dropped (fixture snapshot)',
    salmonLines.length >= 8 && salmonLines.every((l) => l.startsWith('- ')) && salmonLines[0]!.startsWith('- 1½ lb salmon fillet'),
    salmonLines.slice(0, 2));

  // lock + rescale prompts from a throwaway planning file (+ the salmon snapshot copied into recipes/)
  const wk = '2099-W10';
  const fixture = path.join(repoRoot, 'plans', `${wk}.md`);
  const salmonCopy = `selftest-${wk}-coconut-dill-salmon.md`;
  const salmonCopyPath = path.join(repoRoot, 'recipes', salmonCopy);
  try {
    await fs.writeFile(salmonCopyPath, salmonRaw);
    await fs.writeFile(fixture, [
      '# Week of March 7–13, 2099 (2099-W10)', '', '**Status:** planning', '', '## Plan', '', NEW,
      '|-----|------|--------|----------|-------------|-------------|---------|--------|',
      `| Sat | dinner | [Coconut-Dill Salmon with Green Beans, Corn & Tomatoes](../recipes/${salmonCopy}) | 4 | 20 min | ~740 | ~40 g | approved |`,
      '| Sun | — | flexible (leftovers / out) | | | | | — |',
      '| Tue | dinner | [Sticky Gochujang-Glazed Chicken Thighs](../recipes/gochujang-glazed-chicken-thighs.md) ⭐5 | 4 | 30 min | ~570 | ~40 g | approved |',
      '| Thu | dinner | Harissa Chickpea Stew 🆕 | 6 | 35 min | ~520 | ~22 g | approved |',
      '', '## Grocery list', '',
    ].join('\n'));
    store.feedback[wk] = { meals: { Sat: { servings: 8, at: 0 } } };
    const lock = await buildPrompt('lock', wk, '');
    const blockOf = (s: string, day: string) => {
      const i = s.indexOf(`### ${day} — `);
      if (i < 0) return '';
      const j = s.indexOf('\n### ', i + 1);
      const k = s.indexOf('\n\n   Build the grocery list', i);
      const ends = [j, k].filter((x) => x > i);
      return s.slice(i, ends.length ? Math.min(...ends) : undefined);
    };
    const sat = blockOf(lock, 'Sat');
    check('lock prompt: Sat block at the stepper\'s 8 servings, ×2, with 3 lb salmon fillet + 2 cups coconut cream',
      sat.startsWith('### Sat — Coconut-Dill Salmon with Green Beans, Corn & Tomatoes — 8 servings (×2)')
        && sat.includes('- 3 lb salmon fillet') && sat.includes('2 cups unsweetened coconut cream'),
      sat.slice(0, 260));
    // Tue links a library recipe; without it (template / fresh install) the prompt says "of the recipe you write"
    const tueFile = await pathExists(path.join(repoRoot, 'recipes', 'gochujang-glazed-chicken-thighs.md'));
    check(`lock prompt: Tue ${tueFile ? 'from the file' : '(no recipe file)'} at 4 (×1); 🆕 Thu at 6 says ×1½ of the recipe written at 4`,
      blockOf(lock, 'Tue').startsWith(`### Tue — Sticky Gochujang-Glazed Chicken Thighs — 4 servings (×1${tueFile ? ')' : ' of the recipe you write at 4)'}`)
        && blockOf(lock, 'Thu').startsWith('### Thu — Harissa Chickpea Stew — 6 servings (×1½ of the recipe you write at 4)')
        && !lock.includes('### Sun'),
      [blockOf(lock, 'Tue').split('\n')[0], blockOf(lock, 'Thu').split('\n')[0]]);
    check('lock prompt: feedback JSON carries servings; no placeholder left unfilled',
      /"servings": 8/.test(lock) && !/\{\{[A-Z_]+\}\}/.test(lock), lock.match(/\{\{[A-Z_]+\}\}/g));

    const rescale = await buildPrompt('rescale', wk, '', { rescale: { day: 'Sat', servings: 8 } });
    const oldAt = rescale.indexOf('### Sat — Coconut-Dill Salmon with Green Beans, Corn & Tomatoes — 4 servings (×1)');
    const newAt = rescale.indexOf('### Sat — Coconut-Dill Salmon with Green Beans, Corn & Tomatoes — 8 servings (×2)');
    check('rescale prompt: Sat 4 → 8, old block (1½ lb) then new block (3 lb), only that meal, no placeholder left',
      rescale.includes('from 4 to **8 servings**') && oldAt > 0 && newAt > oldAt
        && rescale.slice(oldAt, newAt).includes('- 1½ lb salmon fillet') && rescale.slice(newAt).includes('- 3 lb salmon fillet')
        && !rescale.includes('### Tue') && !/\{\{[A-Z_]+\}\}/.test(rescale),
      { oldAt, newAt, left: rescale.match(/\{\{[A-Z_]+\}\}/g) });
  } finally {
    delete store.feedback[wk];
    await fs.rm(fixture, { force: true });
    await fs.rm(salmonCopyPath, { force: true });
  }
  const exists = (p: string) => fs.stat(p).then(() => true, () => false);
  check('fixture plan file + recipe copy removed', !(await exists(fixture)) && !(await exists(salmonCopyPath)));

  // Cook-night chips → the propose note's first line (runs.ts withCookNights), in the week's own order
  const { withCookNights } = await import('../server/runs.ts');
  const cn = withCookNights('2026-W43', ['Thu', 'Sat', 'Tue'], '  use the frozen shrimp  ');
  check('withCookNights: Sat-start week order, both lists spelled out, note kept on the next line',
    cn === 'Cook nights: Sat, Tue, Thu (3 nights). No cooking: Sun, Mon, Wed, Fri.\nuse the frozen shrimp', cn);
  const cn1 = withCookNights('2026-W43', ['Wed'], '');
  const cnAll = withCookNights('2026-W43', ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'], '');
  const cnNone = withCookNights('2026-W43', [], ' lighter week ');
  check('withCookNights: one night (singular), every night ("none"), no nights = the trimmed note alone',
    cn1 === 'Cook nights: Wed (1 night). No cooking: Sat, Sun, Mon, Tue, Thu, Fri.'
      && cnAll === 'Cook nights: Sat, Sun, Mon, Tue, Wed, Thu, Fri (7 nights). No cooking: none.'
      && cnNone === 'lighter week',
    [cn1, cnAll, cnNone]);
  const cnOld = withCookNights('2026-W30', ['Sun', 'Mon'], '');
  check('withCookNights: an old Mon–Sun week keeps Mon-first order',
    cnOld === 'Cook nights: Mon, Sun (2 nights). No cooking: Tue, Wed, Thu, Fri, Sat.', cnOld);
}

// ---- move a dinner (server/move.ts): eligibility, ticked prep lines, the move prompt ----
// The rules are pure, so they run on a synthetic locked week shaped like the
// real 2026-W42 (Sat cooked and logged, Tue + Thu still to cook, the rest
// flexible) with `today` and captures chosen per case. The prompt check writes
// a throwaway locked file for 2099-W11 and always deletes it.
{
  const { checkMove, moveTargets, nightLogged, donePrepLines, moveFills, MOVE_PLACEHOLDERS } = await import('../server/move.ts');
  const { buildPrompt } = await import('../server/runs.ts');
  const { prepKey } = await import('../server/parse.ts');
  const store = await import('../server/store.ts');
  type Cap = import('../server/move.ts').CaptureLike;
  console.log('\nmove a dinner:');

  const THAW = '- [ ] **Mon 12, morning:** move the thigh bag from the freezer to the fridge for Tuesday\'s gochujang chicken (24 h+ thaw).';
  const CUKES = '- [ ] **Tue 13, afternoon (optional):** smash + salt the cucumbers a few hours ahead.';
  const weekMd = (o: { week?: string; status?: string; tue?: string; thu?: string; log?: string[] } = {}) => {
    const week = o.week ?? '2026-W42';
    return [
      `# Week of October 10–16, 2026 (${week})`, '', `**Status:** ${o.status ?? 'locked (locked 2026-10-10 via app)'}`, '', '## Plan', '',
      '| Day | Meal | Recipe | Servings | Active time | Cal/serving | Protein | Status |',
      '|-----|------|--------|----------|-------------|-------------|---------|--------|',
      '| Sat | dinner | [Coconut-Dill Salmon with Green Beans](../recipes/coconut-dill-salmon-green-beans-corn.md) | 8 | 20 min | ~740 | ~40 g | approved |',
      '| Sun | — | flexible (leftovers / out) | | | | | — |',
      '| Mon | — | flexible (leftovers / out) | | | | | — |',
      `| Tue | dinner | [Sticky Gochujang-Glazed Chicken Thighs with Sesame Smashed Cucumbers](../recipes/gochujang-glazed-chicken-thighs.md) ⭐5 | 4 | 30 min | ~570 | ~40 g | ${o.tue ?? 'approved'} |`,
      '| Wed | — | flexible (leftovers / out) | | | | | — |',
      `| Thu | dinner | [Red Lentil Soup (Mercimek Çorbası) with Lemon](../recipes/red-lentil-soup.md) 🆕 | 4 | 30 min | ~600 | ~25 g | ${o.thu ?? 'approved'} |`,
      '| Fri | — | flexible (leftovers / out) | | | | | — |',
      '', '### Planning notes', '- **Tue:** Gochujang chicken, the free re-slot.', '- **Thu:** The red lentil soup.', '',
      '## Prep timeline', '- [ ] **Sat 10, at the shop:** buy the salmon from the fresh case.', THAW, CUKES,
      '- [ ] **Thu 15, morning:** pull the pitas from the freezer.', '',
      '## Grocery list', '', '### Costco', '**Meat**', '- [ ] Fresh salmon, 3 lb', '',
      '## Log', '', '| Day | Planned | Actually cooked | Rating (1–5) | Notes |', '|-----|---------|-----------------|--------------|-------|',
      ...(o.log ?? ['| Sat | Coconut-dill salmon | as planned | 5 | |']), '',
    ].join('\n');
  };
  const planOf = (o: Parameters<typeof weekMd>[0] = {}) => parsePlan(weekMd(o), `${o?.week ?? '2026-W42'}.md`);
  const base = planOf();
  // "Tue→Mon,Wed,Thu*,Fri | Thu→…": every allowed move, a swap starred
  const show = (plan: ReturnType<typeof planOf>, today: string, captures: Record<string, Cap> = {}) =>
    Object.entries(moveTargets({ plan, today, captures }))
      .map(([from, list]) => `${from}→${list!.map((t) => `${t.day}${t.swapsWith ? '*' : ''}`).join(',')}`).join(' | ');

  const mon = show(base, '2026-10-12');
  check('Mon, nothing logged but Sat: Tue → Mon/Wed/Fri (plain) + Thu (swap); Thu → Mon/Wed/Fri + Tue (swap); Sat and flexible nights not movable',
    mon === 'Tue→Mon,Wed,Thu*,Fri | Thu→Mon,Tue*,Wed,Fri', mon);
  const tMon = moveTargets({ plan: base, today: '2026-10-12', captures: {} });
  check('targets carry the date, and a swap carries the other dinner\'s dish',
    JSON.stringify(tMon.Tue?.[1]) === '{"day":"Wed","date":"2026-10-14"}'
      && tMon.Tue?.[2]?.swapsWith === 'Red Lentil Soup (Mercimek Çorbası) with Lemon' && tMon.Tue?.[2]?.date === '2026-10-15'
      && tMon.Thu?.[1]?.swapsWith === 'Sticky Gochujang-Glazed Chicken Thighs with Sesame Smashed Cucumbers', tMon);
  const tue = show(base, '2026-10-13');
  check('Tue itself (tonight): still movable and swappable; Mon is past, so no longer a target', tue === 'Tue→Wed,Thu*,Fri | Thu→Tue*,Wed,Fri', tue);
  const wed = show(base, '2026-10-14');
  check('Wed, Tue an unlogged straggler: Tue → flexible nights only (no swap with Thu); Thu cannot move back onto Tue',
    wed === 'Tue→Wed,Fri | Thu→Wed,Fri', wed);
  const why = checkMove({ plan: base, today: '2026-10-14', captures: {} }, 'Tue', 'Thu');
  check('…and the refusal says why (the endpoint\'s 409 text)',
    !why.ok && why.why === 'Tuesday has passed, so its dinner can only move to a flexible night, and Thursday has a dinner planned.', why);
  const fri = show(base, '2026-10-16');
  check('Fri: both stragglers may still move onto tonight\'s flexible night', fri === 'Tue→Fri | Thu→Fri', fri);

  const rated = show(base, '2026-10-13', { '2026-10-13': { rating: 4 } });
  const skipped = show(base, '2026-10-13', { '2026-10-13': { dish: 'skipped — ate out' } });
  const swapped = show(base, '2026-10-13', { '2026-10-13': { dish: 'takeout pizza' } });
  check('captured but not folded (rating, skip, dish correction): that night is neither a source nor a swap target',
    rated === 'Thu→Wed,Fri' && skipped === rated && swapped === rated, { rated, skipped, swapped });
  const noteOnly = show(base, '2026-10-13', { '2026-10-13': { note: 'thighs still frozen' } as Cap });
  check('a note-only capture does not log the night', noteOnly === tue, noteOnly);
  const flexCap = show(base, '2026-10-12', { '2026-10-14': { dish: 'takeout' } });
  check('a flexible night with a capture is not a target', flexCap === 'Tue→Mon,Thu*,Fri | Thu→Mon,Tue*,Fri', flexCap);
  const fileLogged = show(planOf({ log: ['| Sat | Salmon | as planned | 5 | |', '| Tue | Gochujang chicken | as planned | | |', '| Wed | — | takeout | | |'] }), '2026-10-12');
  check('Log-table rows count the same way (Tue cooked "as planned" unrated; Wed "takeout")', fileLogged === 'Thu→Mon,Fri', fileLogged);
  check('nightLogged: an empty Log row is not logged; a rating, a cooked text, or a capture is',
    !nightLogged([{ day: 'Tue', planned: 'x', cooked: '', notes: '' }], 'Tue', undefined)
      && nightLogged([{ day: 'Tue', planned: 'x', cooked: '', rating: 3, notes: '' }], 'Tue', undefined)
      && nightLogged([{ day: 'Tue', planned: 'x', cooked: 'skipped — no time', notes: '' }], 'Tue', undefined)
      && nightLogged([], 'Tue', { dish: 'skipped — leftovers' }) && !nightLogged([], 'Tue', {}));

  check('a week that is not locked → nothing (planning, complete)',
    show(planOf({ status: 'planning' }), '2026-10-12') === '' && show(planOf({ status: 'complete (reviewed 2026-10-17)' }), '2026-10-12') === '');
  check('only the week that contains today: the day before it starts and the day after it ends → nothing',
    show(base, '2026-10-09') === '' && show(base, '2026-10-17') === '');
  const notWeek = checkMove({ plan: base, today: '2026-10-09', captures: {} }, 'Tue', 'Wed');
  check('…with a reason naming the week', !notWeek.ok && notWeek.why.startsWith('2026-W42 is not the week being cooked'), notWeek);
  const rej = show(planOf({ thu: 'skipped' }), '2026-10-12');
  check('a row whose Status is skipped/rejected is neither moved nor swapped with', rej === 'Tue→Mon,Wed,Fri', rej);
  const bad = [checkMove({ plan: base, today: '2026-10-12', captures: {} }, 'Wed', 'Fri'), checkMove({ plan: base, today: '2026-10-12', captures: {} }, 'Tue', 'Tue'),
    checkMove({ plan: base, today: '2026-10-12', captures: {} }, 'Tue', 'Sun'), checkMove({ plan: base, today: '2026-10-12', captures: {} }, 'Sat', 'Wed')];
  check('refused: a flexible source, the same day, a day already past, a logged dinner',
    bad.every((b) => !b.ok) && bad.map((b) => (b.ok ? '' : b.why)).join(' / ')
      === '2026-W42 has no cook night on Wed. / That dinner is already on Tuesday. / Sunday has already passed. / Saturday\'s dinner is already logged.',
    bad);

  // ticked prep lines come back exactly as written; fills name a plain move vs a swap
  const raw = weekMd();
  const thawKey = prepKey('2026-W42', THAW.replace(/^- \[ \] /, ''));
  check('prepKey is the parser\'s own key for the task', base.prep.some((p) => p.key === thawKey), base.prep.map((p) => p.key));
  const doneLines = donePrepLines(raw, base, { [thawKey]: { at: 1 }, '2026-W42:shop:not-a-prep-task-1': { at: 1 } });
  check('donePrepLines: only the ticked Prep-timeline line, byte-identical', doneLines.length === 1 && doneLines[0] === THAW, doneLines);
  check('donePrepLines: nothing ticked → no lines', donePrepLines(raw, base, {}).length === 0);
  const plain = moveFills(base, { day: 'Tue', to: 'Wed' }, []);
  const swap = moveFills(base, { day: 'Tue', to: 'Thu' }, doneLines);
  check('moveFills: a plain move onto a flexible night; dates and dish filled; "(none…)" when nothing is ticked',
    plain.MOVE_FROM === 'Tue' && plain.MOVE_FROM_DATE === '2026-10-13' && plain.MOVE_TO === 'Wed' && plain.MOVE_TO_DATE === '2026-10-14'
      && plain.MOVE_DISH.startsWith('Sticky Gochujang-Glazed Chicken Thighs') && plain.MOVE_KIND.includes('**plain move**: Tuesday becomes the flexible night')
      && plain.DONE_PREP.startsWith('(none'), plain);
  check('moveFills: a swap names the other dinner and where it goes; ticked lines listed',
    swap.MOVE_KIND.includes('**swap**') && swap.MOVE_KIND.includes('Red Lentil Soup') && swap.MOVE_KIND.includes('moves to Tuesday (Tue 2026-10-13)')
      && swap.DONE_PREP === THAW, swap);

  // prompts/move.md ↔ buildPrompt: the template uses exactly the placeholders a move fills
  const tpl = await fs.readFile(path.join(repoRoot, 'app/prompts/move.md'), 'utf8');
  const used = [...new Set([...tpl.matchAll(/\{\{([A-Z_]+)\}\}/g)].map((m) => m[1]!))].sort();
  check('move.md uses every placeholder a move fills, and no other', used.join(',') === [...MOVE_PLACEHOLDERS].sort().join(','),
    { used, expected: [...MOVE_PLACEHOLDERS].sort() });
  check('moveFills\' keys + WEEK/DATES/TODAY are that same list',
    [...Object.keys(plain), 'WEEK', 'DATES', 'TODAY'].sort().join(',') === [...MOVE_PLACEHOLDERS].sort().join(','), Object.keys(plain));
  const wk = '2099-W11';
  const fixture = path.join(repoRoot, 'plans', `${wk}.md`);
  const fxKey = prepKey(wk, THAW.replace(/^- \[ \] /, ''));
  const fxDates = weekDates(wk);
  try {
    await fs.writeFile(fixture, weekMd({ week: wk }));
    store.checks[fxKey] = { at: 0 };
    const mv = await buildPrompt('move', wk, '', { move: { day: 'Tue', to: 'Wed' } });
    check('move prompt (Tue → Wed): days, dates, dish, plain move, the ticked thaw line verbatim, no placeholder left',
      mv.includes(`from Tue ${fxDates.Tue} to **Wed ${fxDates.Wed}**`) && mv.includes('(Sticky Gochujang-Glazed Chicken Thighs with Sesame Smashed Cucumbers)')
        && mv.includes('**plain move**') && mv.includes(`\n${THAW}\n`) && mv.includes('`plans/2099-W11.md`')
        && !/\{\{[A-Z_]+\}\}/.test(mv),
      { left: mv.match(/\{\{[A-Z_]+\}\}/g), head: mv.slice(0, 420) });
    const sw = await buildPrompt('move', wk, '', { move: { day: 'Thu', to: 'Tue' } });
    check('move prompt (Thu → Tue): a swap that sends the chicken to Thursday',
      sw.includes(`**swap**: that dinner moves to Thursday (Thu ${fxDates.Thu})`) && !/\{\{[A-Z_]+\}\}/.test(sw), sw.slice(0, 520));
  } finally {
    delete store.checks[fxKey];
    await fs.rm(fixture, { force: true });
  }
  check('move fixture plan file removed', !(await pathExists(fixture)));
  const noteLabel = parsePlan(['# W (2026-W42)', '', '## Plan', '', '### Planning notes', '- **Wed:** Gochujang chicken.',
    '- **Moved (2026-10-12, via app):** Tuesday\'s gochujang chicken to Wednesday.', ''].join('\n'), '2026-W42.md');
  check('a "Moved (…)" notes bullet is a note, not Monday\'s rationale', noteLabel.whys.Mon === undefined && noteLabel.whys.Wed === 'Gochujang chicken.'
    && noteLabel.notes.length === 1, { whys: noteLabel.whys, notes: noteLabel.notes });
}

// ---- Recipes tab (UI round H): profile/ideas.md parser + import's JSON-LD /
// readable-text extraction (app/scripts/fixtures/import-jsonld-page.html is a
// synthetic WordPress-shaped page, not a real one). Pure functions only.
console.log('\nideas + import (Recipes tab):');
{
  const { parseIdeas, slugify } = await import('../server/ideas.ts');
  const synthIdeas = [
    '# Ideas', '',
    'Suggestions from the app\'s ideas run, newest batch first.', '',
    '## Batch 2026-09-27',
    '- **Kerala Fish Curry** · white fish · Indian · ~35 min active — older copy. Why you: x',
    '- **Shakshuka with Feta** · eggs · Tunisian · ~25 min active — Eggs poached in a cumin-spiked tomato sauce. Why you: the puttanesca ⭐5.',
    '',
    '## Batch 2026-10-11',
    '- **Kerala Fish Curry** · white fish · Indian · ~35 min active — Coconut-tamarind curry with curry leaves and a chile kick. Why you: the coconut fish bake rated 5 and the fish lane needs non-tomato preparations.',
    '- **Chicken Shawarma Bowls** · chicken thighs · Middle Eastern · ~40 min active — Griddled spiced thighs over herby rice. Why you: Blackstone shawarma night was a 5.',
    '- **Malformed line without the bold close',
    'loose prose inside a batch is ignored',
    '- **Gochujang Tofu** · tofu · Korean · ~30 min — Crisp tofu in a sticky glaze.',
  ].join('\n');
  const b = parseIdeas(synthIdeas);
  check('ideas: two batches, newest first', b.length === 2 && b[0]!.date === '2026-10-11' && b[1]!.date === '2026-09-27', b.map((x) => x.date));
  check('ideas: malformed and loose lines skipped (3 items in the new batch, 2 in the old)', b[0]!.items.length === 3 && b[1]!.items.length === 2, b.map((x) => x.items.length));
  const k = b[0]!.items[0]!;
  check('ideas: item fields parsed', k.id === 'kerala-fish-curry' && k.name === 'Kerala Fish Curry' && k.protein === 'white fish'
    && k.cuisine === 'Indian' && k.activeMin === 35 && k.pitch === 'Coconut-tamarind curry with curry leaves and a chile kick.'
    && k.why.startsWith('the coconut fish bake rated 5'), k);
  const t = b[0]!.items[2]!;
  check('ideas: "~30 min" without "active", and no "Why you:" → why ""', t.id === 'gochujang-tofu' && t.activeMin === 30 && t.why === '' && t.pitch === 'Crisp tofu in a sticky glaze.', t);
  check('ideas: slugify folds accents and &', slugify('Crème Brûlée & Co.') === 'creme-brulee-and-co', slugify('Crème Brûlée & Co.'));

  const { extractJsonLdRecipe, readableText, durationMin, decodeEntities, sourceBlock } = await import('../server/import.ts');
  const html = await fs.readFile(path.join(repoRoot, 'app/scripts/fixtures/import-jsonld-page.html'), 'utf8');
  const r = extractJsonLdRecipe(html);
  check('import: Recipe node found inside a Yoast @graph, entities decoded', r?.name === 'Lemony Chickpea Stew with Harissa & Greens' && r?.description === 'A brothy, bright stew—fast enough for a weeknight.', r?.name);
  check('import: ingredients kept in order', r?.ingredients.length === 7 && r.ingredients[2] === '2 (15-ounce) cans chickpeas, drained', r?.ingredients);
  check('import: HowToSections flatten to bold heads + step text (text preferred over name; &nbsp; collapsed)',
    JSON.stringify(r?.instructions) === JSON.stringify([
      '**Stew**',
      'Heat the oil in a Dutch oven over medium-high. Add the onion and cook until golden at the edges, about 8 minutes.',
      'Stir in the harissa and chickpeas, add 3 cups water, and simmer until the broth tastes rich, about 20 minutes.',
      '**Finish**',
      'Stir in the spinach, lemon zest and juice. Season with salt and pepper. Serve.',
    ]), r?.instructions);
  check('import: yield, times, author, cuisine, nutrition; image ignored',
    r?.yield === '4 / 4 servings' && r.prepTimeMin === 15 && r.cookTimeMin === 30 && r.totalTimeMin === 45
      && r.author === 'Test Cook' && r.cuisine === 'North African' && r.category === 'Main Course'
      && r.nutrition?.calories === '410 kcal' && !JSON.stringify(r).includes('.jpg'), r);
  check('import: ISO durations', durationMin('PT1H5M') === 65 && durationMin('P0DT2H') === 120 && durationMin('PT0M') === undefined && durationMin('soon') === undefined);
  check('import: double-encoded entities decode', decodeEntities('Mom&amp;#8217;s &amp; more') === 'Mom’s & more', decodeEntities('Mom&amp;#8217;s &amp; more'));
  const loose = '<html><head><script type=application/ld+json>{"@type":["Recipe"],"name":"Quick Dal","recipeIngredient":["1 cup lentils","2 cups water"],\n"recipeInstructions":"Rinse the lentils.\nSimmer 20 minutes."}</script></head><body></body></html>';
  const lr = extractJsonLdRecipe(loose);
  check('import: unquoted type attr, @type array, raw newline inside a JSON string, string instructions split by line',
    lr?.name === 'Quick Dal' && JSON.stringify(lr.instructions) === JSON.stringify(['Rinse the lentils.', 'Simmer 20 minutes.']), lr);
  check('import: no Recipe node → null', extractJsonLdRecipe('<script type="application/ld+json">{"@type":"Organization","name":"x"}</script>') === null);
  const rt = readableText(html);
  check('import: readable text keeps the article, drops scripts/styles/nav/header/footer/aside',
    rt.title === 'Lemony Chickpea Stew with Harissa & Greens | Test Kitchen' && rt.text.includes('deeply browned onion')
      && rt.text.includes('2 (15-ounce) cans chickpeas, drained') && !/adSlots|dataLayer|recipe-card\{|All recipes|All rights reserved|Ten more stews/.test(rt.text),
    rt.text.slice(0, 400));
  check('import: readable text is capped', readableText(`<body><p>${'word '.repeat(9000)}</p></body>`, 1000).text.length < 1100);
  const block = await sourceBlock({ id: 'selftest1', at: Date.UTC(2026, 9, 11, 15), kind: 'url', url: 'https://example.test/lemony-chickpea-stew/', title: r!.name, extraction: 'json-ld', recipe: r!, status: 'saved' });
  check('import: {{IMPORT_SOURCE}} for a JSON-LD page leads with Title:, carries the URL and the JSON',
    block.startsWith('Title: Lemony Chickpea Stew with Harissa & Greens\n') && block.includes('URL: https://example.test/lemony-chickpea-stew/')
      && block.includes('```json') && block.includes('"recipeIngredient"') === false && block.includes('"ingredients"'), block.slice(0, 300));
  const fileBlock = await sourceBlock({ id: 'selftest2', at: Date.UTC(2026, 9, 11, 15), kind: 'upload', title: 'p1.jpg', status: 'saved',
    files: [{ abs: '/tmp/x/p1.jpg', name: 'p1.jpg', type: 'image/jpeg', size: 300_000 }, { abs: '/tmp/x/p2.jpg', name: 'p2.jpg', type: 'image/jpeg', size: 310_000 }] });
  check('import: {{IMPORT_SOURCE}} for photos names each absolute path for the Read tool',
    fileBlock.includes('Read these files, in order, as one recipe') && fileBlock.includes('- /tmp/x/p1.jpg (image/jpeg') && fileBlock.includes('- /tmp/x/p2.jpg'), fileBlock);
}

// ---- the kitchen window: settings, Open-Meteo normalizers, cache, the fake (server/weather.ts)
// ---- and the pure scene functions of public/js/05-window.js, loaded in a vm ----
console.log('\nkitchen window (weather.ts + public/js/05-window.js):');
{
  const { settingError, setSettings } = await import('../server/store.ts');
  const W = await import('../server/weather.ts');
  const loc = { name: 'Testville', admin1: 'Ohio', country: 'United States', lat: 40.1, lon: -82.9, tz: 'America/New_York' };
  check('settings: a geocoder place is a valid location', settingError('location', loc) === null, settingError('location', loc));
  check('settings: admin1/country optional, tz may be empty', settingError('location', { name: 'X', lat: 0, lon: 0, tz: '' }) === null);
  check('settings: lat 91 / lon -181 / string lat refused', settingError('location', { ...loc, lat: 91 }) !== null
    && settingError('location', { ...loc, lon: -181 }) !== null && settingError('location', { ...loc, lat: '38' }) !== null);
  check('settings: unknown field, empty or 81-char name, array refused', settingError('location', { ...loc, population: 5 }) !== null
    && settingError('location', { ...loc, name: '  ' }) !== null && settingError('location', { ...loc, name: 'x'.repeat(81) }) !== null
    && settingError('location', [loc]) !== null);
  check('settings: tempUnit F / C ok, K refused', settingError('tempUnit', 'F') === null && settingError('tempUnit', 'C') === null && settingError('tempUnit', 'K') !== null);

  const body = {
    timezone: 'America/New_York',
    current: { time: '2026-10-12T15:00', temperature_2m: 58.8, apparent_temperature: 54.4, is_day: 1, precipitation: 0.4, rain: 0.3, showers: 0.1, snowfall: 0, weather_code: 61, cloud_cover: 93, wind_speed_10m: 14.7 },
    daily: { sunrise: ['2026-10-12T07:34'], sunset: ['2026-10-12T18:58'], temperature_2m_max: [74.9], temperature_2m_min: [58.4], weather_code: [3] },
  };
  const snap = W.normalizeForecast(body, loc, 'F', 1000);
  check('forecast → snapshot (current, daily, flags)', snap.current.temp === 58.8 && snap.current.feelsLike === 54.4 && snap.current.isDay
    && snap.current.code === 61 && snap.current.cloudCover === 93 && snap.current.windMph === 14.7 && snap.current.rainMm === 0.4
    && snap.daily.sunrise === '2026-10-12T07:34' && snap.daily.sunset === '2026-10-12T18:58' && snap.daily.tmax === 74.9 && snap.daily.code === 3
    && snap.stale === false && snap.unit === 'F' && snap.configured === true && snap.fetchedAt === 1000, snap);
  let threw = false;
  try { W.normalizeForecast({ current: { temperature_2m: 50 } }, loc, 'F', 0); } catch { threw = true; }
  check('forecast without a weather code or sunrise throws (a failed fetch, never a half snapshot)', threw);
  const geo = W.normalizeGeocode({ results: [
    { name: 'Testville Dam', latitude: 40.2, longitude: -83, feature_code: 'DAM', admin1: 'Ohio', country: 'United States', timezone: 'America/New_York' },
    { name: 'Testville', latitude: 40.1, longitude: -82.9, feature_code: 'PPLA2', admin1: 'Ohio', country: 'United States', timezone: 'America/New_York' },
    { name: 'Nowhere', latitude: null, longitude: 3 },
  ] });
  check('geocode: towns first, rows without coordinates dropped, fields mapped', geo.length === 2 && geo[0]!.name === 'Testville'
    && geo[0]!.lat === 40.1 && geo[0]!.tz === 'America/New_York' && geo[0]!.admin1 === 'Ohio' && geo[1]!.name === 'Testville Dam', geo);
  const portlands = [{ name: 'Portland', admin1: 'Maine', lat: 43.7, lon: -70.3, tz: '' }, { name: 'Portland', admin1: 'Oregon', lat: 45.5, lon: -122.7, tz: '' }];
  check('geocode: "Portland, OR" ranks Oregon first', W.rankByQualifier(portlands, ' OR')[0]!.admin1 === 'Oregon');

  const fake = W.fakeSnapshot({ current: { code: 95, temp: 70 }, location: { name: 'Elsewhere' } }, null, 'F', new Date(2026, 9, 12, 15, 0).getTime());
  check('fake: merged over the base, one level deep', fake.current.code === 95 && fake.current.temp === 70 && fake.current.cloudCover === 10
    && fake.location.name === 'Elsewhere' && fake.location.lat === 0 && fake.fake === true && fake.daily.sunrise === '2026-10-12T07:15' && fake.current.isDay, fake);

  // getWeather: no place → null; the fake; then the cache, stale-while-error and unavailable with a stubbed fetch
  const realFetch = globalThis.fetch;
  const prevFake = process.env.MEALAPP_WEATHER_FAKE;
  try {
    delete process.env.MEALAPP_WEATHER_FAKE;
    setSettings({});
    W.resetWeatherCache();
    check('getWeather: no place set → null', (await W.getWeather()) === null);
    process.env.MEALAPP_WEATHER_FAKE = '{"current":{"code":71}}';
    const gf = await W.getWeather();
    check('getWeather: MEALAPP_WEATHER_FAKE → the fake, with no place set', !!gf && 'current' in gf && gf.current.code === 71 && gf.fake === true);
    process.env.MEALAPP_WEATHER_FAKE = 'not json';
    check('getWeather: a malformed fake is ignored', (await W.getWeather()) === null);
    delete process.env.MEALAPP_WEATHER_FAKE;

    let calls = 0;
    let fail = false;
    globalThis.fetch = (async () => {
      calls++;
      if (fail) throw new Error('network down');
      return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    setSettings({ location: loc });
    const t0 = Date.now();
    const a = await W.getWeather(t0);
    const b = await W.getWeather(t0 + 5 * 60_000);
    check('getWeather: fetched once, then served from the 10-minute cache', calls === 1 && !!a && 'current' in a && !a.stale && b === a, { calls });
    fail = true;
    const c = await W.getWeather(t0 + 11 * 60_000);
    const c2 = await W.getWeather(t0 + 11.5 * 60_000);
    check('getWeather: a failed refresh serves the last good one, stale, and waits a minute to retry',
      calls === 2 && !!c && 'current' in c && c.stale === true && !!c2 && 'current' in c2 && c2.stale === true, { calls, c: c && 'stale' in c ? c.stale : c });
    const d = await W.getWeather(t0 + 4 * 3600_000);
    check('getWeather: past 3 hours with no good fetch → unavailable (no throw)', calls === 3 && !!d && 'unavailable' in d && d.error === 'network down', d);
    fail = false;
    setSettings({ location: loc, tempUnit: 'C' });
    const e = await W.getWeather(t0 + 4 * 3600_000 + 1);
    check('getWeather: changing the unit misses the cache and refetches', calls === 4 && !!e && 'current' in e && e.unit === 'C', { calls });
  } finally {
    globalThis.fetch = realFetch;
    if (prevFake === undefined) delete process.env.MEALAPP_WEATHER_FAKE; else process.env.MEALAPP_WEATHER_FAKE = prevFake;
    setSettings({});
    W.resetWeatherCache();
  }

  // the client's pure half, from the real file
  const vm = await import('node:vm');
  const ctx = vm.createContext({});
  vm.runInContext(await fs.readFile(path.join(repoRoot, 'app/public/js/05-window.js'), 'utf8'), ctx, { filename: '05-window.js' });
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const C = ctx as Record<string, any>;
  const at = (h: number, m = 0) => new Date(2026, 9, 12, h, m); // local wall clock, any TZ
  const ph = (h: number, m: number) => C.scenePhase(at(h, m), '2026-10-12T07:19', '2026-10-12T18:40').phase;
  const seq = [[3, 0], [6, 45], [7, 15], [8, 30], [12, 0], [17, 45], [18, 40], [19, 10], [20, 0]].map(([h, m]) => ph(h!, m!)).join(',');
  check('scenePhase: night,dawn,sunrise,morning,day,golden,sunset,dusk,night across Oct 12', seq === 'night,dawn,sunrise,morning,day,golden,sunset,dusk,night', seq);
  const sp = C.scenePhase(at(12, 59), '07:19', '18:40');
  check('scenePhase: sunP 0 at sunrise, 1 at sunset, ~.5 at solar noon', C.scenePhase(at(7, 19), '07:19', '18:40').sunP === 0
    && C.scenePhase(at(18, 40), '07:19', '18:40').sunP === 1 && Math.abs(sp.sunP - .5) < .01, sp.sunP);
  check('scenePhase: bad sunrise/sunset → the 07:00 / 18:30 defaults', C.scenePhase(at(12), 'nope', '').sr === 420 && C.scenePhase(at(12), 'nope', '').ss === 1110);
  let maxJump = 0;
  let prev: string | null = null;
  for (let m = 0; m < 1440; m++) {
    const top = C.windowScene({ now: at(Math.floor(m / 60), m % 60), wx: null }).sky[0] as string;
    if (prev) for (let i = 1; i < 7; i += 2) maxJump = Math.max(maxJump, Math.abs(parseInt(top.slice(i, i + 2), 16) - parseInt(prev.slice(i, i + 2), 16)));
    prev = top;
  }
  check('sky: no jump at phase edges (max channel change per minute ≤ 10 across the day)', maxJump <= 10, maxJump);
  const clearDay = C.skyStops('day', 0), greyDay = C.skyStops('day', 100, 'rain');
  const sat = (hex: string) => { const v = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)); return Math.max(...v) - Math.min(...v); };
  check('skyStops: 4 stops; full cloud + rain greys the sky', clearDay.length === 4 && sat(greyDay[0]) < sat(clearDay[0]) / 2, { clearDay, greyDay });

  const kinds = [[0, 'clear'], [1, 'partly'], [2, 'partly'], [3, 'overcast'], [45, 'fog'], [48, 'fog'], [51, 'drizzle'], [57, 'drizzle'], [61, 'rain'],
    [67, 'rain'], [71, 'snow'], [77, 'snow'], [80, 'rain'], [82, 'rain'], [85, 'snow'], [86, 'snow'], [95, 'storm'], [99, 'storm']];
  const badKinds = kinds.filter(([code, kind]) => C.conditions(code, true).kind !== kind);
  check('conditions: every WMO group maps to its kind', !badKinds.length, badKinds);
  check('conditions: labels (61 light rain, 0 sunny by day / clear at night)', C.conditions(61, true).label === 'light rain'
    && C.conditions(0, true).label === 'sunny' && C.conditions(0, false).label === 'clear' && C.conditions(65).intensity === 1);
  const sk = (mo: number, lat: number) => C.season(mo, lat).key;
  check('season: Oct north autumn, Oct south spring, Jan winter, Jul south winter, Sep early, Nov thinning, Apr blossom',
    sk(10, 38) === 'autumn' && sk(10, -34) === 'spring' && sk(1, 38) === 'winter' && sk(7, -34) === 'winter' && sk(9, 38) === 'early-autumn'
    && C.season(11, 38).leaf === .55 && C.season(12, 38).leaf === 0 && !!C.season(4, 38).blossom,
    [10, 1, 4, 7, 9, 11, 12].map((m) => sk(m, 38)));
  const newMoon = C.moonPhase(new Date(Date.UTC(2024, 3, 8, 18, 21))); // the April 2024 eclipse
  const fullMoon = C.moonPhase(new Date(Date.UTC(2024, 3, 23, 23, 49)));
  check('moonPhase: 2024-04-08 new, 2024-04-23 full', (newMoon.phase < .02 || newMoon.phase > .98) && Math.abs(fullMoon.phase - .5) < .02
    && fullMoon.illum > .99 && fullMoon.name === 'full moon', { newMoon, fullMoon });
  check('moon drawing: first quarter lit on the right (north), left (south); full = two half-discs',
    C.wxMoonPath(100, 50, 8, .25, false).includes('A8 8 0 0 1') && C.wxMoonPath(100, 50, 8, .25, true).includes('A8 8 0 0 0')
    && /A8 8 0 0 (\d) 100 58A8 8 0 0 \1 100 42Z$/.test(C.wxMoonPath(100, 50, 8, .5, false)), C.wxMoonPath(100, 50, 8, .5, false));
  check('parseScene: rain-night, snow-day-jan, partly-dusk-4, a moon word; junk → null', C.parseScene('rain-night').cond === 'rain'
    && C.parseScene('rain-night').phase === 'night' && C.parseScene('snow-day-jan').month === 1 && C.parseScene('partly-dusk-4').month === 4
    && C.parseScene('bogus-day') === null && C.parseScene('rain-noon') === null && C.parseScene('') === null
    && C.parseScene('clear-night-full').moon === .5 && C.parseScene('clear-night-gibbous-jan').month === 1);

  // every condition × phase × season: the forced phase lands, no NaN/undefined, ≤ 120 SVG nodes
  let maxNodes = 0, worst = '';
  const broken: string[] = [];
  for (const cond of C.WX_CONDS ?? vm.runInContext('WX_CONDS', ctx)) {
    for (const phase of vm.runInContext('WX_PHASES', ctx) as string[]) {
      for (const month of [1, 4, 7, 10, 11]) {
        const sc = C.windowScene({ now: at(15), wx: null, forced: { cond, phase, month } });
        const svg: string = C.windowSvg(sc, 1_760_000_000);
        const nodes = (svg.match(/<(?!\/)[a-zA-Z]/g) ?? []).length;
        if (nodes > maxNodes) { maxNodes = nodes; worst = `${cond}-${phase}-${month}`; }
        if (sc.phase !== phase || /NaN|undefined|Infinity/.test(svg)) broken.push(`${cond}-${phase}-${month}`);
      }
    }
  }
  console.log(`  ..  largest scene: ${maxNodes} SVG nodes (${worst})`);
  check('windowSvg: every condition × phase × season draws, lands on its phase, ≤ 120 nodes', !broken.length && maxNodes <= 120, { broken, maxNodes, worst });
  const live = { configured: true, location: loc, unit: 'F', fetchedAt: at(15).getTime(), stale: false,
    current: { temp: 58.8, feelsLike: 54, code: 61, isDay: true, cloudCover: 93, windMph: 9, precipMm: .4, rainMm: .4, snowCm: 0 },
    daily: { sunrise: '2026-10-12T07:34', sunset: '2026-10-12T18:58', tmax: 75, tmin: 58, code: 61 } };
  const cap = (h: number, wx: unknown, nowH = h) => C.windowCaption(wx, C.windowScene({ now: at(h), wx }), at(nowH).getTime());
  const c15 = cap(15, live);
  check('caption: "59° · light rain · Testville" / "sunset 6:58 pm"; aria in words', c15.left === '59° · light rain · Testville'
    && c15.right === 'sunset 6:58 pm' && c15.aria === 'Kitchen window: light rain, 59 degrees, afternoon, Testville', c15);
  check('caption: sunrise after sunset and before dawn', cap(21, live).right === 'sunrise 7:34 am' && cap(5, live).right === 'sunrise 7:34 am');
  const old = { ...live, fetchedAt: at(13, 10).getTime() };
  check('caption: over an hour old → "as of 1:10 pm" in place of the town', cap(15, old).left === '59° · light rain · as of 1:10 pm', cap(15, old).left);
  check('caption: no place → the set-your-location prompt', cap(15, { configured: false }).unset === true
    && cap(15, { configured: false }).left === 'Set your location to see the weather →');
}

// ---------- commit.ts + pantry commit subjects (workstream I) ----------
// Message formatting, the NO_GIT path, the path guard, the run-lock refusal
// and the repo lock's ordering. Every commitRepoFiles call passes noGit (or
// is refused before git), so no real git runs here.
{
  const { commitMessage, commitRepoFiles, withRepoLock } = await import('../server/commit.ts');
  const { pantrySubject } = await import('../server/pantry-routes.ts');
  const { withRunLock, RunBusyError } = await import('../server/runs.ts');

  check('commit: message = subject + " (via app, <by>)"',
    commitMessage('Pantry: add Za’atar to Spices & dried herbs', 'brendan') === 'Pantry: add Za’atar to Spices & dried herbs (via app, brendan)');
  check('commit: no by → " (via app)"', commitMessage('Pantry: remove Soy sauce') === 'Pantry: remove Soy sauce (via app)');
  check('commit: newlines and control chars collapse to one line',
    commitMessage('Pantry:\n add\t x\r\n', 'Bren\ndan') === 'Pantry: add x (via app, Bren dan)', commitMessage('Pantry:\n add\t x\r\n', 'Bren\ndan'));
  const longMsg = commitMessage(`Pantry: add ${'very long item '.repeat(20)}`, 'brendan');
  check('commit: long subjects clip with … and keep the (via app, by) tail, ≤ 120 chars',
    longMsg.length <= 120 && longMsg.endsWith('… (via app, brendan)'), longMsg);
  check('commit: empty subject falls back', commitMessage('  ') === 'App edit (via app)');

  check('pantry subject: add names the section, ** stripped',
    pantrySubject('add', '**Za’atar** (Costco jar)', 'Spices & dried herbs') === 'Pantry: add Za’atar (Costco jar) to Spices & dried herbs');
  check('pantry subject: remove / mark low / clear low / freezer add',
    pantrySubject('remove', 'Soy sauce') === 'Pantry: remove Soy sauce'
      && pantrySubject('low', 'Soy sauce') === 'Pantry: mark low Soy sauce'
      && pantrySubject('unlow', 'Soy sauce') === 'Pantry: clear low Soy sauce'
      && pantrySubject('freezer-add', '2 lb raw shrimp') === 'Pantry: freezer add 2 lb raw shrimp');
  check('pantry subject: freezer used carries the note; no note, no parens',
    pantrySubject('freezer-used', '2 lb chicken thighs', 'Tue gochujang') === 'Pantry: freezer used 2 lb chicken thighs (Tue gochujang)'
      && pantrySubject('freezer-used', '2 lb chicken thighs') === 'Pantry: freezer used 2 lb chicken thighs');
  const longSubj = pantrySubject('remove', `2 lb boneless skinless chicken thighs — **⚠️ status unknown as of 2026-09-05:** ${'x '.repeat(80)}`);
  check('pantry subject: long item text clipped to 60 chars with …', /^Pantry: remove .{59}…$/u.test(longSubj) && !longSubj.includes('**'), longSubj);

  const off = await commitRepoFiles(['profile/pantry.md'], 'Pantry: add zz', { by: 'selftest', noGit: true });
  check('commit: NO_GIT → no git; committed false, pushed false, reason "git disabled", message formatted',
    off.committed === false && off.pushed === false && off.reason === 'git disabled' && off.message === 'Pantry: add zz (via app, selftest)' && !off.sha, off);
  const rejects = async (paths: string[]) => { try { await commitRepoFiles(paths, 'x', { noGit: true }); return false; } catch { return true; } };
  check('commit: path guard refuses outside-repo, .git and empty path lists (even with git disabled)',
    await rejects(['../outside.md']) && await rejects(['/etc/passwd']) && await rejects(['.git/config']) && await rejects([]) && await rejects(['.']));

  let busyErr: unknown = null;
  await withRunLock('ask', '', async () => {
    try { await commitRepoFiles(['profile/pantry.md'], 'x', { noGit: true }); } catch (e) { busyErr = e; }
  });
  check('commit: refused with RunBusyError while a run/Ask holds the run lock (checked before NO_GIT)', busyErr instanceof RunBusyError, busyErr);

  const order: string[] = [];
  const pause = (ms: number) => new Promise((res) => setTimeout(res, ms));
  await Promise.all([
    withRepoLock(async () => { order.push('a1'); await pause(30); order.push('a2'); }),
    withRepoLock(async () => { order.push('b1'); await pause(5); order.push('b2'); }),
    withRepoLock(async () => { order.push('c'); throw new Error('boom'); }).catch(() => order.push('c-caught')),
    withRepoLock(async () => { order.push('d'); }),
  ]);
  check('commit: withRepoLock runs holders one at a time, in order; a throwing holder doesn’t wedge it',
    order.filter((x) => x !== 'c-caught').join(',') === 'a1,a2,b1,b2,c,d' && order.includes('c-caught'), order.join(','));
}

// ---- notify.ts: push copy from synthetic state + delivery guards (workstream G) ----
console.log('\nnotify (push copy + delivery guards):');
{
  const N = await import('../server/notify.ts');
  const push = await import('../server/push.ts');
  const os = await import('node:os');
  type Meal = import('../server/parse.ts').PlanMeal;
  type Prep = import('../server/parse.ts').PrepTask;
  type Info = import('../server/runs.ts').RunDoneInfo;
  type St = import('../server/notify.ts').NotifyState;
  const meal = (day: Meal['day'], dish: string, o: Partial<Meal> = {}): Meal =>
    ({ day, mealType: 'Dinner', dish, isNew: false, status: 'approved', flexible: false, servings: 4, timeMin: 30, ...o });
  const flex = (day: Meal['day']): Meal => meal(day, 'flexible (leftovers / out)', { flexible: true, status: '—', servings: undefined, timeMin: undefined });
  const task = (week: string, dueDate: string, text: string): Prep => ({ key: `${week}:prep:${text.slice(0, 20).toLowerCase().replace(/[^a-z0-9]+/g, '-')}`, label: '', text, dueDate });
  const items = (n: number, p: string) => Array.from({ length: n }, (_, i) => ({ key: `${p}-${i}`, text: `${p} ${i}` }));
  const plan = (week: string, o: Partial<NonNullable<St['cooking']>['plan']> = {}): NonNullable<St['cooking']>['plan'] =>
    ({ week, status: 'locked', meals: [], prep: [], grocery: { stores: [], pantryCheck: [], bulkNotes: [] }, log: [], ...o });
  const st = (o: Partial<St> = {}): St => ({ today: '2026-10-13', cooking: null, ahead: null, checks: {}, captures: {}, feedback: null, ...o });
  const info = (type: Info['type'], week: string, summaryMd = '', ok = true, chain?: Info['chain']): Info => ({ type, week, ok, summaryMd, ...(chain ? { chain } : {}) });

  // the week ahead in planning: 4 proposed cook nights + flexible days
  const proposal = plan('2026-W43', {
    status: 'planning',
    meals: [meal('Sat', 'Miso cod', { status: 'proposed' }), flex('Sun'), meal('Mon', 'Chicken shawarma bowls', { status: 'proposed' }),
      meal('Tue', 'Red lentil soup', { status: 'proposed' }), flex('Wed'), meal('Thu', 'Pork carnitas', { status: 'proposed' }), flex('Fri')],
  });
  const sProp = st({ ahead: { week: '2026-W43', plan: proposal } });
  const pr = N.runDonePayload([info('propose', '2026-W43', '- Proposed 2026-W43')], sProp);
  check('notify: propose → "Proposal ready for next week" · "4 meals to decide" · /?tab=next · tag run-propose-2026-W43',
    pr?.title === 'Proposal ready for next week' && pr.body === '4 meals to decide' && pr.url === '/?tab=next' && pr.tag === 'run-propose-2026-W43', pr);
  const sPropFb = st({ ahead: { week: '2026-W43', plan: proposal }, feedback: { meals: { Sat: { decision: 'approve', at: 1 } } } });
  check('notify: a Next-tab decision counts as decided ("3 meals to decide")', N.proposeBody(sPropFb, '2026-W43') === '3 meals to decide', N.proposeBody(sPropFb, '2026-W43'));
  check('notify: propose with no plan file found → a generic body, still a notice',
    N.runDonePayload([info('propose', '2026-W44')], sProp)?.body === 'Ready to review on the Next tab');

  // the same week locked, with a grocery list
  const locked = plan('2026-W43', {
    meals: proposal.meals.map((m) => (m.flexible ? m : { ...m, status: 'approved' })),
    grocery: {
      stores: [
        { name: 'Costco', sections: [{ name: 'Meat & seafood', items: items(1, 'cod') }, { name: 'Produce', items: items(1, 'dill') }] },
        { name: 'Kroger', sections: [{ name: '', items: items(4, 'k') }, { name: 'Meat', items: items(5, 'm') }, { name: 'Bakery', items: items(2, 'b') }] },
      ],
      pantryCheck: [], bulkNotes: [],
    },
  });
  const sLock = st({ ahead: { week: '2026-W43', plan: locked } });
  const lk = N.runDonePayload([info('lock', '2026-W43', '- Locked')], sLock);
  check('notify: lock → "Next week locked" · "Costco 2 items · Kroger 11" · /?tab=shop',
    lk?.title === 'Next week locked' && lk.body === 'Costco 2 items · Kroger 11' && lk.url === '/?tab=shop' && lk.tag === 'run-lock-2026-W43', lk);
  check('notify: lock with no grocery list → generic body', N.lockBody(st(), '2026-W43') === 'The grocery list is on the Shop tab');

  // chains: one notice for the whole chain
  const cp = N.runDonePayload([
    info('review', '2026-W42', '- Closed out 2026-W42.', true, { step: 1, of: 2, types: ['review', 'propose'] }),
    info('propose', '2026-W43', '- Proposed', true, { step: 2, of: 2, types: ['review', 'propose'] }),
  ], sProp);
  check('notify: close-and-plan chain → "Closed out this week · proposed next week" · "4 meals to decide" · /?tab=next',
    cp?.title === 'Closed out this week · proposed next week' && cp.body === '4 meals to decide' && cp.url === '/?tab=next' && cp.tag === 'run-propose-2026-W43', cp);
  const sl = N.runDonePayload([
    info('revise', '2026-W43', '- Swapped Tue.', true, { step: 1, of: 2, types: ['revise', 'lock'] }),
    info('lock', '2026-W43', '- Locked', true, { step: 2, of: 2, types: ['revise', 'lock'] }),
  ], sLock);
  check('notify: send-and-lock chain → "Next week revised and locked" · the lock body · /?tab=shop',
    sl?.title === 'Next week revised and locked' && sl.body === 'Costco 2 items · Kroger 11' && sl.url === '/?tab=shop', sl);

  // failures
  const f1 = N.runDonePayload([info('propose', '2026-W43', 'Claude error: overloaded (529)\nstack…', false)], sProp);
  check('notify: failed run → "Run failed: propose, next week" · error first line · the relevant tab',
    f1?.title === 'Run failed: propose, next week' && f1.body === 'Claude error: overloaded (529)' && f1.url === '/?tab=next' && f1.tag === 'run-propose-2026-W43', f1);
  const f2 = N.runDonePayload([
    info('review', '2026-W42', '- Closed out', true, { step: 1, of: 2, types: ['review', 'propose'] }),
    info('propose', '2026-W43', 'Not started: 2026-W43 got a plan file while 2026-W42 was closing.', false, { step: 2, of: 2, types: ['review', 'propose'] }),
  ], sProp);
  check('notify: a chain failing at step 2 says the finished step went through',
    f2?.title === 'Run failed: propose, next week'
      && f2.body === 'This week closed out ✓. Not started: Oct 17–23 got a plan file while Oct 10–16 was closing.', f2);
  const f3 = N.runDonePayload([info('review', '2026-W42', 'Mock review failure (MEALAPP_MOCK_FAIL).', false)], sProp);
  check('notify: failed close-out points at the Week tab', f3?.title === 'Run failed: review, this week' && f3.url === '/?tab=week', f3);
  const f4 = N.runDonePayload([info('lock', '2026-W43', 'Stopped by user.', false)], sProp);
  check('notify: a Stop reads "Run stopped: lock, next week"', f4?.title === 'Run stopped: lock, next week', f4);
  check('notify: fold and ask never send run-done',
    N.runDonePayload([info('fold', '', '- Folded')], sProp) === null && N.runDonePayload([info('ask', '', 'answer')], sProp) === null);

  // summary-derived bodies
  const rv = N.runDonePayload([info('revise', '2026-W43',
    '_Mock run (MEALAPP_MOCK_RUNS): nothing was written or committed._\n\n- **Revised** 2026-W43: Tue swapped for `miso cod`; see [the plan](plans/2026-W43.md).')], sProp);
  check('notify: revise body = first summary line, markdown stripped, mock header skipped, ids as dates',
    rv?.title === 'Next week revised' && rv.body === 'Revised Oct 17–23: Tue swapped for miso cod; see the plan.' && rv.url === '/?tab=next', rv);
  const longLine = N.firstLine(`- ${'word '.repeat(60)}`);
  check('notify: summary first line is capped at 120 chars with an ellipsis', longLine.length <= 120 && longLine.endsWith('…'), longLine);
  const rs = N.runDonePayload([info('rescale', '2026-W42', 'Rescaled Sat salmon to 9 servings: list and bulk notes updated.')], sProp);
  check('notify: rescale → "List updated for this week" · summary line · /?tab=shop',
    rs?.title === 'List updated for this week' && rs.body === 'Rescaled Sat salmon to 9 servings: list and bulk notes updated.' && rs.url === '/?tab=shop', rs);
  const mvd = N.runDonePayload([info('move', '2026-W42', 'Tuesday\'s gochujang chicken is now Wednesday. The thigh thaw moved to Tue morning.')], sProp);
  check('notify: move → "Dinner moved" · summary line · /?tab=week',
    mvd?.title === 'Dinner moved' && mvd.body === 'Tuesday\'s gochujang chicken is now Wednesday. The thigh thaw moved to Tue morning.'
      && mvd.url === '/?tab=week' && mvd.tag === 'run-move-2026-W42', mvd);
  const rw = N.runDonePayload([info('review', '2026-W42', '## Week review\nClosed out 2026-W42: three nights, avg 4.7.')], sProp);
  check('notify: review → "This week closed out" · first line · /?tab=week', rw?.title === 'This week closed out' && rw.body === 'Week review' && rw.url === '/?tab=week', rw);
  const id8 = N.runDonePayload([info('ideas', '', '- Added 8 dishes')], sProp, { ideasCount: 8 });
  check('notify: ideas → "New ideas ready" · "8 dishes to browse" · /?tab=recipes',
    id8?.title === 'New ideas ready' && id8.body === '8 dishes to browse' && id8.url === '/?tab=recipes' && id8.tag === 'run-ideas', id8);
  const im = N.runDonePayload([info('import', '', '- Wrote recipes/lemony-chickpea-stew.md')], sProp, { importName: 'Lemony Chickpea Stew' });
  check('notify: import → "Recipe imported" · the recipe name', im?.title === 'Recipe imported' && im.body === 'Lemony Chickpea Stew' && im.url === '/?tab=recipes', im);

  // week names are relative to the day the notice goes out
  const sSat = st({ today: '2026-10-17', ahead: { week: '2026-W43', plan: proposal } }); // Saturday: W43 is this week
  const satRw = N.runDonePayload([info('review', '2026-W42', '- Closed out')], sSat);
  check('notify: Saturday morning, closing W42 reads "Last week closed out"', satRw?.title === 'Last week closed out', satRw);
  const satCp = N.runDonePayload([
    info('review', '2026-W42', '- Closed out', true, { step: 1, of: 2, types: ['review', 'propose'] }),
    info('propose', '2026-W43', '- Proposed', true, { step: 2, of: 2, types: ['review', 'propose'] }),
  ], sSat);
  check('notify: Saturday close-and-plan → "Closed out last week · proposed this week"', satCp?.title === 'Closed out last week · proposed this week', satCp);
  const far = N.runDonePayload([info('lock', '2026-W45', '- Locked')], sProp);
  check('notify: a week with no relative name uses its dates ("Oct 31–Nov 6 locked")', far?.title === 'Oct 31–Nov 6 locked', far);
  const all = [pr, lk, cp, sl, f1, f2, f3, f4, rv, rs, rw, id8, im, satRw, satCp, far];
  check('notify: no run-done title or body carries a week id',
    all.every((p) => p && !/\bW\d\d\b|\d{4}-W\d{2}/.test(`${p.title} ${p.body}`)), all.map((p) => p && `${p.title} | ${p.body}`));
  check('notify: run-done titles stay within ~40 chars', all.every((p) => p && p.title.length <= 41), all.map((p) => p && [p.title, p.title.length]));

  // record-updated: the client toast's wording (00-core.js noteFoldState / foldedLabel)
  const rec = N.recordPayload([
    { date: '2026-10-10', dish: 'Coconut-Dill Salmon with Green Beans, Corn & Tomatoes', rating: 5, noted: true },
    { date: '2026-10-13', dish: 'skipped — ate out' },
    { date: '2026-10-15', rating: 4, minutes: 35 },
  ]);
  check('notify: record → "In the record ✓✓" · "Sat Coconut-Dill Salmon — 5, noted and 2 more" · /?tab=week · tag record',
    rec?.title === 'In the record ✓✓' && rec.body === 'Sat Coconut-Dill Salmon — 5, noted and 2 more' && rec.url === '/?tab=week' && rec.tag === 'record', rec);
  check('notify: folded labels match the client (skip reason, minutes)',
    N.foldedLabel({ date: '2026-10-13', dish: 'skipped — ate out' }) === 'Tue skipped (ate out)'
      && N.foldedLabel({ date: '2026-10-15', rating: 4, minutes: 35 }) === 'Thu — 4, took ~35 min', [N.foldedLabel({ date: '2026-10-13', dish: 'skipped — ate out' }), N.foldedLabel({ date: '2026-10-15', rating: 4, minutes: 35 })]);
  check('notify: nothing folded → no record notice', N.recordPayload([]) === null);

  // prep-today: 0, 1, 3 tasks; checked tasks drop out; "before the week" tasks of the week ahead count
  const W = '2026-W42';
  const cookMeals = [meal('Sat', 'Coconut-Dill Salmon with Green Beans, Corn & Tomatoes', { timeMin: 20 }), flex('Sun'), flex('Mon'),
    meal('Tue', 'Sticky Gochujang-Glazed Chicken Thighs with Sesame Smashed Cucumbers'), flex('Wed'),
    meal('Thu', 'Red Lentil Soup (Mercimek Çorbası) with Lemon, Chile Oil & Warm Pita'), flex('Fri')];
  const thaw = task(W, '2026-10-12', "move the confirmed 2-lb thigh bag from the freezer to the fridge for Tuesday's gochujang chicken (24 h+ thaw). Skip this if the fresh Kroger pack was bought instead.");
  const cukes = task(W, '2026-10-13', 'smash + salt the cucumbers a few hours ahead. They improve as they sit.');
  const cook = (prep: Prep[], checks: Record<string, unknown> = {}, o: Partial<St> = {}) =>
    st({ cooking: { week: W, plan: plan(W, { meals: cookMeals, prep }) }, checks, ...o });
  check('notify: prep-today with nothing due → null', N.prepTodayPayload(cook([thaw, cukes]), '2026-10-11') === null);
  const p1 = N.prepTodayPayload(cook([thaw, cukes]), '2026-10-12');
  check('notify: prep-today with 1 task → "Prep today" · its first sentence, parenthetical dropped · /?tab=week · tag prep-<date>',
    p1?.title === 'Prep today' && p1.body === "Move the confirmed 2-lb thigh bag from the freezer to the fridge for Tuesday's gochujang chicken"
      && p1.url === '/?tab=week' && p1.tag === 'prep-2026-10-12', p1);
  const three = [task(W, '2026-10-15', 'pull the pitas from the freezer. Optional: make the soup in the morning.'),
    task(W, '2026-10-15', 'start the chile oil'), task(W, '2026-10-15', 'rinse the lentils.')];
  const p3 = N.prepTodayPayload(cook(three), '2026-10-15');
  check('notify: prep-today with 3 tasks → joined with " · "',
    p3?.body === 'Pull the pitas from the freezer · Start the chile oil · Rinse the lentils', p3);
  check('notify: a checked prep task drops out', N.prepTodayPayload(cook(three, { [three[1]!.key]: { at: 1 } }), '2026-10-15')?.body === 'Pull the pitas from the freezer · Rinse the lentils');
  check('notify: everything checked → null', N.prepTodayPayload(cook([thaw], { [thaw.key]: { at: 1 } }), '2026-10-12') === null);
  const sat = [
    task(W, '2026-10-10', 'freezer check, three calls in one pass. (a) The three thigh bags: any bag that went to the fridge is past safe.'),
    task(W, '2026-10-10', 'buy ~3½ lb salmon from the fresh case (Costco fresh counter first, Kroger seafood counter fallback; never frozen) — one large side or two pieces. It cooks tonight.'),
    task(W, '2026-10-10', 'salmon to the coldest fridge shelf; pitas into the freezer in their bag (out again Thu morning); check the cucumbers.'),
    task(W, '2026-10-10', 'make the coconut-dill dressing ahead (double batch for the 3½-lb fillet) and refrigerate it.'),
  ];
  const p4 = N.prepTodayPayload(cook(sat), '2026-10-10');
  check('notify: a long prep day fits in 180 chars with "+N more"',
    !!p4 && p4.body.length <= 180 && p4.body === 'Freezer check, three calls in one pass · Buy ~3½ lb salmon from the fresh case · Salmon to the coldest fridge shelf; pitas into the freezer in their bag · +1 more', p4?.body);
  const pre = task('2026-W43', '2026-10-16', 'move the pork shoulder to the fridge for Saturday.');
  const p5 = N.prepTodayPayload(cook([], {}, { ahead: { week: '2026-W43', plan: plan('2026-W43', { prep: [pre] }) } }), '2026-10-16');
  check('notify: a "before the week" task of the week ahead counts', p5?.body === 'Move the pork shoulder to the fridge for Saturday', p5);

  // tonight
  const tn = N.tonightPayload(cook([thaw, cukes]), '2026-10-13');
  check('notify: tonight → "Tonight: <dish head>" · "30 min · 4 servings · prep: …" · /?tab=cook · tag tonight-<date>',
    tn?.title === 'Tonight: Sticky Gochujang-Glazed Chicken Thighs' && tn.body === '30 min · 4 servings · prep: smash + salt the cucumbers a few hours ahead'
      && tn.url === '/?tab=cook' && tn.tag === 'tonight-2026-10-13', tn);
  const tsat = N.tonightPayload(cook([thaw]), '2026-10-10');
  check('notify: tonight with no prep due → "prep: none"', tsat?.body === '20 min · 4 servings · prep: none', tsat);
  check('notify: tonight on a flexible night → null', N.tonightPayload(cook([thaw, cukes]), '2026-10-12') === null);
  check('notify: tonight already logged (rated or "Didn\'t cook") → null',
    N.tonightPayload(cook([cukes], {}, { captures: { '2026-10-13': { rating: 5 } } }), '2026-10-13') === null
      && N.tonightPayload(cook([cukes], {}, { captures: { '2026-10-13': { dish: 'skipped — ate out' } } }), '2026-10-13') === null);
  check('notify: tonight with no cooking week → null', N.tonightPayload(st(), '2026-10-13') === null);

  // delivery guards, dry-run (never calls sendPush): not ready → no devices → sent → deduped
  const dryWas = process.env.MEALAPP_PUSH_DRYRUN;
  process.env.MEALAPP_PUSH_DRYRUN = '1';
  const pay = { title: 'T', body: 'B', url: '/', tag: 'selftest' };
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'mealapp-notify-'));
  try {
    const before = push.pushReady() ? null : await N.deliver('run-done', pay);
    check('notify: push not initialised → skipped', before === null || before === 'not-ready', before);
    await push.initPush(tmp);
    check('notify: no subscriptions → skipped', (await N.deliver('run-done', pay)) === 'no-devices');
    const sub = await push.addSubscription({ endpoint: 'https://push.example.invalid/selftest', keys: { p256dh: 'B'.repeat(87), auth: 'A'.repeat(22) } });
    N.resetNotifyDedupe();
    check('notify: a subscribed device → dry-run send', (await N.deliver('run-done', pay)) === 'dry-run');
    check('notify: same tag again within 10 min → deduped', (await N.deliver('run-done', pay)) === 'duplicate');
    check('notify: another event with the same tag (its own key) still goes', (await N.deliver('run-done', pay, 'selftest#2')) === 'dry-run');
    await push.setTypes(sub.id, { tonight: false });
    check('notify: a type the device switched off → skipped', (await N.deliver('tonight', { ...pay, tag: 'selftest-t' })) === 'no-devices');
  } finally {
    if (dryWas === undefined) delete process.env.MEALAPP_PUSH_DRYRUN; else process.env.MEALAPP_PUSH_DRYRUN = dryWas;
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

// ---- QA fixes: headline main-ingredient pick, template placeholders, NO_GIT denials ----
{
  const { headline } = await import('../server/scale.ts');
  const { parseRecipe: parseR } = await import('../server/parse.ts');
  const { canUseTool } = await import('../server/runs.ts');
  console.log('\nheadline picks the main ingredient (frontmatter protein):');
  const fx = async (slug: string) => parseR(await fs.readFile(path.join(repoRoot, `app/scripts/fixtures/recipe-${slug}-2026-10-11.md`), 'utf8'), `${slug}.md`);
  const soup = await fx('red-lentil-soup');
  check('headline red-lentil-soup ×2 (protein lentils) → lentils, not the oil',
    soup.meta.protein === 'lentils' && headline(soup.body, 2, soup.meta.protein) === '3 cups red lentils', headline(soup.body, 2, soup.meta.protein));
  check('headline red-lentil-soup ×2 without protein → first line, as before', headline(soup.body, 2) === '6 tbsp olive oil', headline(soup.body, 2));
  const cds = await fx('coconut-dill-salmon-green-beans-corn');
  check('headline coconut-dill salmon ×2 (protein salmon) unchanged', headline(cds.body, 2, cds.meta.protein) === '3 lb salmon fillet', headline(cds.body, 2, cds.meta.protein));
  const dal = await fx('red-lentil-dal');
  check('headline red-lentil-dal ×2 (protein lentils) unchanged', headline(dal.body, 2, dal.meta.protein) === '3 cups red lentils', headline(dal.body, 2, dal.meta.protein));
  const thighs = '## Ingredients\n- 2 tbsp olive oil [P]\n- 1 cup chicken stock [P]\n- 2 lb boneless skinless chicken thighs [C — 6-lb pack]\n- 1 large onion, sliced [P]\n';
  check('headline oil first + protein chicken-thigh → the thighs line (every word beats the earlier "chicken stock")',
    headline(thighs, 1.5, 'chicken-thigh') === '3 lb boneless skinless chicken thighs', headline(thighs, 1.5, 'chicken-thigh'));
  check('headline protein plural-tolerant (chicken-thighs ↔ thighs, lentil ↔ lentils)',
    headline(thighs, 1, 'chicken-thighs') === '2 lb boneless skinless chicken thighs'
      && headline('## Ingredients\n- 3 tbsp olive oil [P]\n- 1½ cups red lentils [P]\n', 1, 'lentil') === '1½ cups red lentils');
  check('headline protein named only in a tag does not count',
    headline('## Ingredients\n- 2 tbsp olive oil [P — for the salmon]\n- 1½ lb salmon fillet [C]\n', 1, 'salmon') === '1½ lb salmon fillet');
  const fish = '## Ingredients\n- 2 tbsp olive oil [P]\n- **Smashed potatoes:** 1½ lb baby potatoes [K]\n- 4 cod fillets, ~6 oz each [C]\n';
  check('headline no protein match → first unlabeled lb/oz or cut line (labeled side skipped)', headline(fish, 1, 'white-fish') === '4 cod fillets', headline(fish, 1, 'white-fish'));
  const halibut = '## Ingredients\n- 3 tbsp olive oil [P]\n- 1 large onion [P]\n- 1½ lb halibut [C]\n';
  check('headline no protein match → first weighed line', headline(halibut, 2, 'white-fish') === '3 lb halibut', headline(halibut, 2, 'white-fish'));
  check('headline no protein value → first line, as before (no weight fallback)', headline(halibut, 2) === '6 tbsp olive oil', headline(halibut, 2));
  check('headline no protein match, nothing weighed → first line',
    headline('## Ingredients\n- 3 tbsp olive oil [P]\n- 2 cans chickpeas [P]\n', 1, 'tofu') === '3 tbsp olive oil');

  console.log('\ntemplate placeholders are not tasks or items:');
  const ph = parsePlan([
    '# Week of October 17–23, 2026 (2026-W43)', '', '**Status:** planning', '',
    '## Prep timeline', '<!-- Generated at lock … -->', '- [ ] **Sat, night:** ...', '- [ ] **Sun, morning:** …', '- [ ] **Mon, night:**', '',
    '## Grocery list', '', '<!-- One `### ` heading per store, named exactly as in profile/preferences.md → Shopping; primary store first. -->', '### {Primary store}', '**Produce**', '- [ ] ...', '- [ ] …', '', '**Meat**', '- [ ] **Salmon:** ...', '',
    '### {Secondary store}', '- [ ] ... (why not the primary store: ...)', '', '### Pantry check (likely low — verify)', '- [ ] ...', '',
  ].join('\n'), '2026-W43.md');
  check('placeholder prep lines → 0 tasks', ph.prep.length === 0, ph.prep);
  check('placeholder grocery lines → 0 items', ph.grocery.stores.every((s) => s.sections.every((x) => x.items.length === 0))
    && ph.grocery.pantryCheck.length === 0 && ph.hasGrocery === false, ph.grocery);
  const real = parsePlan([
    '# Week of October 17–23, 2026 (2026-W43)', '', '**Status:** locked', '',
    '## Prep timeline', '- [ ] **Sat, night:** ...', '- [ ] **Sun 18, morning:** thaw the salmon in the fridge', '',
    '## Grocery list', '', '### Costco', '**Pantry**', '- [ ] ...', '- [ ] **Rice: jasmine 1 cup (Sun) + basmati 1½ cups (Tue)**', '- [ ] Salmon, 3 lb (Sun)', '',
  ].join('\n'), '2026-W43.md');
  check('real tasks beside a placeholder survive', real.prep.length === 1 && real.prep[0]!.label === 'Sun 18, morning'
    && real.prep[0]!.text === 'thaw the salmon in the fridge', real.prep);
  check('a fully bold item with a colon inside is still an item', real.grocery.stores[0]?.sections[0]?.items.map((i) => i.text).join(' | ')
    === 'Rice: jasmine 1 cup (Sun) + basmati 1½ cups (Tue) | Salmon, 3 lb (Sun)', real.grocery.stores[0]?.sections[0]?.items);
  const tpl = parsePlan(await fs.readFile(path.join(repoRoot, 'plans/TEMPLATE.md'), 'utf8'), '2026-W43.md');
  check('plans/TEMPLATE.md copied verbatim → 0 prep tasks, 0 grocery items', tpl.prep.length === 0 && !tpl.hasGrocery && tpl.grocery.pantryCheck.length === 0,
    { prep: tpl.prep.length, pantry: tpl.grocery.pantryCheck.length });

  console.log('\nBash denials (canUseTool):');
  const bash = async (noGit: boolean, command: string) => {
    const r = await canUseTool(noGit)('Bash', { command });
    return r.behavior === 'allow' ? 'allow' : r.message;
  };
  const PLAIN = 'This app only permits plain git commands (status/diff/log/add/commit/push/pull), no shell operators.';
  check('git on: plain git allowed', (await bash(false, 'git status')) === 'allow');
  check('git on: non-git command → plain-git denial', (await bash(false, 'ls -la')) === PLAIN);
  check('NO_GIT: git command → "git is disabled on this dev instance"', (await bash(true, 'git status')) === 'git is disabled on this dev instance'
    && (await bash(true, 'cd plans && git push')) === 'git is disabled on this dev instance');
  check('NO_GIT: non-git command → the normal plain-git denial', (await bash(true, 'ls -la')) === PLAIN && (await bash(true, 'cat .gitignore')) === PLAIN);
}

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll selftest checks passed.');
