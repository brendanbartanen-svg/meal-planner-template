// Parser + week-math selftest against sample files in scripts/fixtures/ (three
// plan weeks and one recipe in the exact formats the run prompts pin — if
// those formats drift, this should fail loudly rather than the UI failing
// quietly). The fixtures are synthetic; see scripts/fixtures/README.md.
// Run: npm run selftest
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  addWeeks, endOfWeek, humanRange, isoWeekId, mondayOf, parsePlan, parseRecipe, prepDueDate,
  startOfWeek, todayUTC, weekDates, weekDays, weekIdForDate,
} from '../server/index.ts';

const fixturesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures');
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

// ---- W31 (locked, full grocery, empty log) ----
const w31 = parsePlan(await fs.readFile(path.join(fixturesDir, '2026-W31.md'), 'utf8'), '2026-W31.md');
console.log('\nfixtures/2026-W31.md:');
check('week id', w31.week === '2026-W31');
check('status locked', w31.status === 'locked', w31.status);
check('7 table rows', w31.meals.length === 7, w31.meals.length);
check('5 cook nights', w31.meals.filter((m) => !m.flexible).length === 5);
const mon = w31.meals.find((m) => m.day === 'Mon');
check('Mon dish', mon?.dish === 'Pork and green bean stir-fry + jasmine rice', mon?.dish);
check('Mon recipe link', mon?.recipeFile === 'pork-green-bean-stir-fry.md', mon?.recipeFile);
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
check('primary store first', primary?.name === 'Warehouse club', primary?.name);
check('primary store has 3 sections', primary?.sections.length === 3, primary?.sections.map((s) => s.name));
check('primary store Meat & fish has 3 items', primary?.sections[0]?.items.length === 3);
const secondary = w31.grocery.stores[1];
const secondaryItems = secondary?.sections.flatMap((s) => s.items) ?? [];
check('secondary store named', secondary?.name === 'Supermarket', secondary?.name);
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
const w30 = parsePlan(await fs.readFile(path.join(fixturesDir, '2026-W30.md'), 'utf8'), '2026-W30.md');
console.log('\nfixtures/2026-W30.md:');
check('status complete', w30.status === 'complete', w30.status);
check('log rows', w30.log.length === 6, w30.log.length);
check('Tue rated 4', w30.log.find((l) => l.day === 'Tue')?.rating === 4);
check('Sun rated 5', w30.log.find((l) => l.day === 'Sun')?.rating === 5);
check('Mon “—” rating is undefined', w30.log.find((l) => l.day === 'Mon')?.rating === undefined);
check('review body present', w30.reviewMd.length > 100, w30.reviewMd.length);
check('prep tasks parsed', w30.prep.length > 0, w30.prep.length);

// ---- W29 (earliest format: no prep, no planning notes) ----
const w29 = parsePlan(await fs.readFile(path.join(fixturesDir, '2026-W29.md'), 'utf8'), '2026-W29.md');
console.log('\nfixtures/2026-W29.md:');
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
const carnitas = parseRecipe(await fs.readFile(path.join(fixturesDir, 'carnitas.md'), 'utf8'), 'carnitas.md');
console.log('\nfixtures/carnitas.md:');
check('name', carnitas.meta.name === 'Carnitas (Slow-Braised Pork Shoulder, Dutch Oven)', carnitas.meta.name);
// running stats change every time it's cooked — check shape, not values
check('rating 1–5 number', typeof carnitas.meta.rating === 'number' && carnitas.meta.rating >= 1 && carnitas.meta.rating <= 5, carnitas.meta.rating);
check('times_cooked ≥ 1', (carnitas.meta.times_cooked ?? 0) >= 1 && Number.isInteger(carnitas.meta.times_cooked), carnitas.meta.times_cooked);
check('last_cooked ISO date', /^\d{4}-\d{2}-\d{2}$/.test(String(carnitas.meta.last_cooked)), carnitas.meta.last_cooked);
check('active_time_min 35', carnitas.meta.active_time_min === 35);
check('nutrition calories 540', carnitas.meta.nutrition?.calories === 540, carnitas.meta.nutrition);
check('nutrition fiber 7', carnitas.meta.nutrition?.fiber_g === 7);
check('prep_ahead 2 items', carnitas.meta.prep_ahead.length === 2, carnitas.meta.prep_ahead);
check('prep_ahead unquoted', carnitas.meta.prep_ahead[0]?.startsWith('thaw') === true, carnitas.meta.prep_ahead[0]);
check('body has Ingredients', carnitas.body.includes('## Ingredients'));

if (failures) {
  console.error(`\n${failures} check(s) FAILED`);
  process.exit(1);
}
console.log('\nAll selftest checks passed.');
