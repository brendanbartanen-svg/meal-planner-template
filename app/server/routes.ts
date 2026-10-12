// Every HTTP route except the cook chat (cook.ts): reads, captures, run
// triggers, and settings. Registered on the app by index.ts.
import type express from 'express';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { marked } from 'marked';
import { allowHit, CAPTURES_PER_MIN, CHECKS_PER_MIN, clientIp, configuredPasscode, requirePasscode, whoFor } from './auth.ts';
import { broadcast } from './bus.ts';
import { gitHead, lastPullResult, pullIfStale, readSdkVersion } from './git.ts';
import { CHECK_KEY, parseRecipe, SAFE_FILE } from './parse.ts';
import { plansDir, recipesDir } from './paths.ts';
import { COOK_SERVINGS_MAX, COOK_SERVINGS_MIN, cookEntry, parseServings } from './cook.ts';
import { readAllPlans, readRecipes } from './repo.ts';
import { factorFor, formatQty, headline } from './scale.ts';
import type { MealDecision } from './store.ts';
import { busyLabel, foldPublic, lastCaptureAt, markCapture, NO_GIT, run, runPublic, startChain, startRun, withCookNights } from './runs.ts';
import { aheadWeekIdFor, buildState, mealApproved, profileReady, undecidedDays } from './state.ts';
import {
  captures, checks, EFFORT_OPTIONS, effectiveSettings, extras, feedback, FOLD_QUIET_OPTIONS,
  foldDebounceMs, MODEL_OPTIONS, pendingCaptures, saveCaptures, saveChecks, saveExtras,
  saveFeedback, saveSettings, SETTING_KEYS, setSettings, settingDefaults, settingError, settings,
  typicalMs, type Capture, type ExtraItem, type RunType, type SettingKey, type Settings,
  type WeekFeedback,
} from './store.ts';
import { DAYS, todayUTC, weekDays, weekIdForDate, type DayName } from './weeks.ts';

const SERVER_STARTED_AT = Date.now();

// ---------- route helpers ----------

// Same wording as ask.ts's 409: "Claude is busy: another Ask Claude answer" /
// "Claude is busy: the fold run" — a pseudo-run (ask) is not "a run".
function guardNoRun(res: express.Response): boolean {
  if (run) { const busy = busyLabel(run); res.status(409).json({ error: `Claude is busy: ${busy}`, busy }); return false; }
  return true;
}

// Cook-night chips (propose, close-and-plan): a list of day names, each one a
// day of that week; returned in the week's own order. Absent/empty = no constraint.
function parseCookNights(raw: unknown, week: string): { nights: DayName[] } | { error: string } {
  if (raw === undefined || raw === null) return { nights: [] };
  if (!Array.isArray(raw)) return { error: 'cookNights must be a list of day names.' };
  const order = weekDays(week);
  for (const d of raw) {
    if (!order.includes(d as DayName)) return { error: `${String(d)} isn't a day of ${week}.` };
  }
  return { nights: order.filter((d) => raw.includes(d)) };
}

// Send-and-lock's second step: re-check the file right before the lock spends
// anything. The revise step was told to come back with every meal approved;
// if it didn't, stop here with a clear message instead of a lock run that
// refuses in prose. (In mock mode runs.ts downgrades a failure to a note.)
const lockGuard = (week: string) => async (): Promise<string | null> => {
  const plan = (await readAllPlans()).get(week);
  if (!plan) return `plans/${week}.md is missing`;
  if (plan.status !== 'planning') return `${week} is ${plan.status}, not in planning`;
  const open = plan.meals.filter((m) => !mealApproved(plan, feedback[week], m)).map((m) => `${m.day} (${m.status})`);
  return open.length ? `still not approved after the revision: ${open.join(', ')}; review them on the Next tab, then lock` : null;
};

async function settingsPayload() {
  const pend = pendingCaptures();
  const eff = effectiveSettings();
  // The tick fires once a minute, so the fold lands within a minute after this.
  const nextFoldAt = eff.autoFold && pend.length && lastCaptureAt ? lastCaptureAt + foldDebounceMs() : null;
  return {
    values: eff,
    stored: settings,
    defaults: settingDefaults(),
    options: { models: MODEL_OPTIONS, efforts: EFFORT_OPTIONS, foldQuietMin: FOLD_QUIET_OPTIONS },
    status: {
      passcodeGate: !!(await configuredPasscode()),
      startedAt: SERVER_STARTED_AT,
      uptimeMs: Date.now() - SERVER_STARTED_AT,
      git: await gitHead(),
      sdkVersion: await readSdkVersion(),
      node: process.version,
      lastPull: lastPullResult,
      // The "Last git pull" text when there is no result: a MEALAPP_NO_GIT dev
      // instance never pulls, so "not yet" would read as a stuck pull.
      lastPullLabel: lastPullResult ? null : NO_GIT ? 'git disabled (dev)' : 'not yet',
      gitDisabled: NO_GIT,
      pendingCaptures: pend.length,
      autoFold: {
        on: eff.autoFold,
        nextEligibleAt: nextFoldAt,
        // pending entries but no capture since boot: the debounce has no anchor,
        // so auto-fold waits for the next capture (or a manual Sync now)
        waitingForCapture: eff.autoFold && pend.length > 0 && !lastCaptureAt,
      },
      run: { active: !!run, type: run?.type ?? null, startedAt: run?.startedAt ?? null },
      typicalMs: Object.fromEntries((['propose', 'revise', 'lock', 'fold', 'shop-adjust', 'review', 'rescale', 'ideas', 'import'] as RunType[])
        .map((k) => [k, typicalMs(k)])),
    },
  };
}

const SETTINGS_PER_MIN = 20;
function settingsRateLimit(req: express.Request, res: express.Response, next: express.NextFunction) {
  const ip = clientIp(req);
  if (!allowHit('settings', ip, SETTINGS_PER_MIN)) return res.status(429).json({ error: `Easy there — ${SETTINGS_PER_MIN} settings changes per minute, tops.` });
  next();
}

// ---------- http ----------

export function registerRoutes(app: express.Express) {
  app.get('/api/state', async (_req, res) => {
    try { res.json(await buildState()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/api/recipes', async (_req, res) => {
    try {
      await pullIfStale();
      res.json({ recipes: await readRecipes() });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  // { meta, html } for the Recipes tab, plus the Cook tab's `sections` and
  // `scale`; `?servings=N` (1–24) scales the Ingredients. See cook.ts cookEntry.
  app.get('/api/recipes/entry', async (req, res) => {
    const f = String(req.query.f ?? '');
    if (!SAFE_FILE.test(f)) return res.status(400).json({ error: 'bad filename' });
    const servings = parseServings(req.query.servings);
    if (Number.isNaN(servings)) return res.status(400).json({ error: `servings must be a whole number from ${COOK_SERVINGS_MIN} to ${COOK_SERVINGS_MAX}` });
    let raw: string;
    try { raw = await fs.readFile(path.join(recipesDir, f), 'utf8'); }
    catch { return res.status(404).json({ error: 'not found' }); }
    try { res.json(cookEntry(raw, f, servings)); }
    catch (err) { res.status(500).json({ error: `Could not render ${f}: ${err instanceof Error ? err.message : String(err)}` }); }
  });

  // The Next tab's servings preview: the main ingredient at that scale
  // ("3 lb salmon fillet", "3 cups red lentils"), picked by the frontmatter
  // `protein` (scale.ts mainLine). `headline` is null when that line has no
  // amount; absent `servings` = as written.
  app.get('/api/recipes/headline', async (req, res) => {
    const f = String(req.query.f ?? '');
    if (!SAFE_FILE.test(f)) return res.status(400).json({ error: 'bad filename' });
    const servings = parseServings(req.query.servings);
    if (Number.isNaN(servings)) return res.status(400).json({ error: `servings must be a whole number from ${COOK_SERVINGS_MIN} to ${COOK_SERVINGS_MAX}` });
    let raw: string;
    try { raw = await fs.readFile(path.join(recipesDir, f), 'utf8'); }
    catch { return res.status(404).json({ error: 'not found' }); }
    try {
      const { meta, body } = parseRecipe(raw, f);
      const base = meta.servings && meta.servings > 0 ? meta.servings : 4; // factorFor's base rule
      const factor = servings === null ? 1 : factorFor(meta.servings, servings);
      res.json({ file: f, servings: servings ?? base, baseServings: base, factor, factorText: formatQty(factor), headline: headline(body, factor, meta.protein) });
    } catch (err) { res.status(500).json({ error: `Could not scale ${f}: ${err instanceof Error ? err.message : String(err)}` }); }
  });

  app.get('/api/plans', async (_req, res) => {
    try {
      const plans = await readAllPlans();
      const list = [...plans.values()]
        .sort((a, b) => b.week.localeCompare(a.week))
        .map((p) => ({ file: p.file, week: p.week, title: p.title, status: p.status }));
      res.json({ plans: list });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.get('/api/plans/entry', async (req, res) => {
    const f = String(req.query.f ?? '');
    if (!SAFE_FILE.test(f)) return res.status(400).json({ error: 'bad filename' });
    try {
      const raw = await fs.readFile(path.join(plansDir, f), 'utf8');
      res.json({ html: String(marked.parse(raw)) });
    } catch { res.status(404).json({ error: 'not found' }); }
  });

  // --- captures (open, rate-limited, attributed) ---

  const SKIP_PREFIX = 'skipped — ';      // the fold prompt's existing `skipped — …` convention
  const SKIP_RE = /^skipped\b/i;

  app.post('/api/log', async (req, res) => {
    const date = String(req.body?.date ?? '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'bad date' });
    const ip = clientIp(req);
    if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} updates per minute, tops.` });

    const prev = captures[date];
    const entry: Capture = prev ? { ...prev } : { date, at: 0 };
    if ('rating' in (req.body ?? {})) {
      const r = req.body.rating;
      if (r === null) delete entry.rating;
      else if (Number.isInteger(r) && r >= 1 && r <= 5) entry.rating = r;
      else return res.status(400).json({ error: 'Rating must be a whole number from 1 to 5.' });
    }
    if ('note' in (req.body ?? {})) {
      const n = String(req.body.note ?? '').trim();
      if (n.length > 600) return res.status(400).json({ error: 'Keep notes under 600 characters.' });
      if (n) entry.note = n; else delete entry.note;
    }
    if ('dish' in (req.body ?? {})) {
      const d = String(req.body.dish ?? '').trim();
      if (d.length > 200) return res.status(400).json({ error: 'Keep that under 200 characters.' });
      if (d) entry.dish = d; else delete entry.dish;
    }
    // A rating means it got cooked after all: drop a "Didn't cook" skip.
    if (entry.rating !== undefined && entry.dish && SKIP_RE.test(entry.dish)) delete entry.dish;
    // "Didn't cook" → stored in the existing dish field as "skipped — <reason>",
    // so the fold/review prompts' `skipped — …` rule and close-out readiness
    // (a capture dish counts as logged) apply unchanged. null/'' = Undo, which
    // clears the dish only when it is a skip.
    if ('skipped' in (req.body ?? {})) {
      const raw = req.body.skipped;
      const reason = raw === null ? '' : String(raw).replace(/\s+/g, ' ').trim();
      if (reason.length > 60) return res.status(400).json({ error: 'Keep the reason under 60 characters.' });
      if (reason) {
        entry.dish = `${SKIP_PREFIX}${reason}`;
        delete entry.rating;   // nothing was cooked, so nothing to rate or time
        delete entry.minutes;
      } else if (entry.dish && SKIP_RE.test(entry.dish)) {
        delete entry.dish;
      }
    }
    // "Took about…" chip: whole minutes, 5–300; null clears.
    if ('minutes' in (req.body ?? {})) {
      const m = req.body.minutes;
      if (m === null) delete entry.minutes;
      else if (Number.isInteger(m) && m >= 5 && m <= 300) entry.minutes = m;
      else return res.status(400).json({ error: 'Minutes must be a whole number from 5 to 300.' });
    }
    if (entry.rating === undefined && !entry.note && !entry.dish && entry.minutes === undefined) {
      delete captures[date]; // everything cleared → drop the entry
    } else {
      entry.at = Date.now();
      delete entry.foldedAt; // edits re-open the entry for the next fold
      entry.by = (await whoFor(req)) ?? entry.by;
      captures[date] = entry;
    }
    markCapture();
    await saveCaptures();
    // fold state rides along: the pending count and the restarted countdown
    const fold = foldPublic();
    broadcast({ type: 'capture', date, entry: captures[date] ?? null, fold });
    res.json({ ok: true, entry: captures[date] ?? null, fold });
  });

  app.post('/api/check', async (req, res) => {
    const key = String(req.body?.key ?? '');
    const done = !!req.body?.done;
    if (!CHECK_KEY.test(key)) return res.status(400).json({ error: 'bad key' });
    const ip = clientIp(req);
    if (!allowHit('chk', ip, CHECKS_PER_MIN)) return res.status(429).json({ error: 'Too many taps — give it a minute.' });
    if (done) checks[key] = { by: await whoFor(req), at: Date.now() };
    else delete checks[key];
    await saveChecks();
    broadcast({ type: 'check', key, done, by: checks[key]?.by });
    res.json({ ok: true });
  });

  app.post('/api/feedback', async (req, res) => {
    const week = String(req.body?.week ?? '');
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    const ip = clientIp(req);
    if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} updates per minute, tops.` });
    const by = await whoFor(req);
    const fb: WeekFeedback = feedback[week] ?? { meals: {} };

    if ('weekNote' in (req.body ?? {})) {
      const text = String(req.body.weekNote ?? '').trim();
      if (text.length > 1000) return res.status(400).json({ error: 'Keep the note under 1000 characters.' });
      if (text) fb.weekNote = { text, by, at: Date.now() };
      else delete fb.weekNote;
    }
    const day = req.body?.day as DayName | undefined;
    if (day !== undefined) {
      if (!DAYS.includes(day)) return res.status(400).json({ error: 'bad day' });
      // `decision` and `servings` are independent: the servings stepper keeps the
      // decision, `clear` (undo) keeps the servings, and servings: null drops them.
      const body = req.body as Record<string, unknown>;
      const hasDecision = 'decision' in body;
      if (!hasDecision && !('servings' in body)) return res.status(400).json({ error: 'bad decision' });
      const entry: MealDecision = { ...(fb.meals[day] ?? { at: 0 }) };
      if ('servings' in body) {
        const s = body.servings;
        if (s === null) delete entry.servings;
        else if (Number.isInteger(s) && (s as number) >= COOK_SERVINGS_MIN && (s as number) <= COOK_SERVINGS_MAX) entry.servings = s as number;
        else return res.status(400).json({ error: `Servings must be a whole number from ${COOK_SERVINGS_MIN} to ${COOK_SERVINGS_MAX}.` });
      }
      if (hasDecision) {
        const decision = String(body.decision ?? '');
        const note = String(body.note ?? '').trim().slice(0, 500);
        if (decision === 'clear') { delete entry.decision; delete entry.note; }
        else if (decision === 'approve' || decision === 'reject' || decision === 'swap') {
          if (decision !== 'approve' && !note) {
            return res.status(400).json({ error: decision === 'reject' ? 'Give a reason — rejections teach the planner.' : 'Say what you want instead.' });
          }
          entry.decision = decision;
          if (note) entry.note = note; else delete entry.note;
        } else return res.status(400).json({ error: 'bad decision' });
      }
      if (!entry.decision && entry.servings === undefined) delete fb.meals[day];
      else fb.meals[day] = { ...entry, by: by ?? entry.by, at: Date.now() };
    }
    if (!fb.weekNote && !Object.keys(fb.meals).length) delete feedback[week];
    else feedback[week] = fb;
    await saveFeedback();
    broadcast({ type: 'feedback', week, feedback: feedback[week] ?? null });
    res.json({ ok: true, feedback: feedback[week] ?? null });
  });

  // One tap on the proposal: `approve` for every non-flexible meal that has no
  // decision yet and isn't already approved in the file. Rejections, swaps and
  // earlier approvals are left exactly as they are. Open + rate-limited like
  // /api/feedback (it's a capture, not a run).
  app.post('/api/feedback/approve-all', async (req, res) => {
    const week = String(req.body?.week ?? '');
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    const ip = clientIp(req);
    if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} updates per minute, tops.` });
    const plan = (await readAllPlans()).get(week);
    if (!plan) return res.status(404).json({ error: `No plan file for ${week} yet.` });
    if (plan.status !== 'planning') return res.status(409).json({ error: `${week} is ${plan.status}, not in planning.` });
    const fb: WeekFeedback = feedback[week] ?? { meals: {} };
    const days = undecidedDays(plan, fb);
    if (days.length) {
      const by = await whoFor(req);
      const at = Date.now();
      for (const day of days) fb.meals[day] = { ...fb.meals[day], decision: 'approve', by, at }; // keeps a stepper's servings
      feedback[week] = fb;
      await saveFeedback();
      broadcast({ type: 'feedback', week, feedback: fb });
    }
    res.json({ ok: true, approved: days, feedback: feedback[week] ?? null });
  });

  app.post('/api/extras', async (req, res) => {
    const week = String(req.body?.week ?? '');
    const text = String(req.body?.text ?? '').trim();
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    if (!text) return res.status(400).json({ error: 'Type an item first.' });
    if (text.length > 200) return res.status(400).json({ error: 'Keep items under 200 characters.' });
    const ip = clientIp(req);
    if (!allowHit('cap', ip, CAPTURES_PER_MIN)) return res.status(429).json({ error: `Easy there — ${CAPTURES_PER_MIN} adds per minute, tops.` });
    const list = extras[week] ?? [];
    if (list.length >= 30) return res.status(429).json({ error: 'That’s a lot of extras — fold some into the plan first.' });
    const item: ExtraItem = { id: Math.random().toString(36).slice(2, 10), text, by: await whoFor(req), at: Date.now() };
    extras[week] = [...list, item];
    await saveExtras();
    broadcast({ type: 'state-updated' });
    res.json({ ok: true, item });
  });

  app.delete('/api/extras/:week/:id', requirePasscode, async (req, res) => {
    const week = String(req.params.week);
    const before = extras[week]?.length ?? 0;
    extras[week] = (extras[week] ?? []).filter((e) => e.id !== req.params.id);
    if (extras[week]!.length === before) return res.status(404).json({ error: 'No such item.' });
    if (!extras[week]!.length) delete extras[week];
    await saveExtras();
    broadcast({ type: 'state-updated' });
    res.json({ ok: true });
  });

  app.delete('/api/log/:date', requirePasscode, async (req, res) => {
    const date = String(req.params.date);
    if (!captures[date]) return res.status(404).json({ error: 'No capture for that date.' });
    delete captures[date];
    await saveCaptures();
    // fold state rides along like POST /api/log: the pending count (and countdown) drop with the entry
    const fold = foldPublic();
    broadcast({ type: 'capture', date, entry: null, fold });
    res.json({ ok: true, fold });
  });

  // --- runs (passcode) ---

  // A fresh install (the template) ships profile/preferences.md with `_fill in_`
  // placeholders; proposing against it would plan for nobody. Only the propose
  // entry points check this (propose, and close-and-plan's propose step).
  const PROFILE_FIRST = 'Fill in profile/preferences.md first — the Get started card on the Week tab walks through it.';

  app.post('/api/runs/propose', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    if (!(await profileReady())) return res.status(409).json({ error: PROFILE_FIRST });
    const plans = await readAllPlans();
    // Same derivation buildState uses, so the default here can never disagree
    // with the week the Next tab is showing.
    const week = String(req.body?.week ?? aheadWeekIdFor(plans, weekIdForDate(todayUTC())));
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    if (plans.has(week)) return res.status(409).json({ error: `${week} already has a plan file — use revise.` });
    const cn = parseCookNights(req.body?.cookNights, week);
    if ('error' in cn) return res.status(400).json({ error: cn.error });
    void startRun('propose', week, withCookNights(week, cn.nights, String(req.body?.note ?? '')));
    res.json({ ok: true });
  });

  app.post('/api/runs/revise', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const week = String(req.body?.week ?? '');
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    const plans = await readAllPlans();
    const plan = plans.get(week);
    if (!plan) return res.status(404).json({ error: `No plan file for ${week} yet — propose first.` });
    const note = String(req.body?.note ?? '').trim();
    const fb = feedback[week];
    const hasFeedback = !!fb && (Object.keys(fb.meals).length > 0 || !!fb.weekNote);
    if (!hasFeedback && !note) return res.status(400).json({ error: 'Nothing to send — mark some meals or write a note first.' });
    if (req.body?.lock === true) {
      // "Send and lock": revise (replacements auto-approved) → lock, one chain.
      // Every meal needs a decision first, or the lock step would stop the chain.
      if (plan.status !== 'planning') return res.status(409).json({ error: `${week} is ${plan.status} — Send and lock is for a proposal still in planning.` });
      const open = undecidedDays(plan, fb);
      if (open.length) return res.status(400).json({ error: `Decide ${open.join(', ')} first — Send and lock needs a decision on every meal.` });
      if (!guardNoRun(res)) return; // re-check after the await above
      void startChain([
        { type: 'revise', week, note, autoApprove: true },
        { type: 'lock', week, guard: lockGuard(week) },
      ]);
      return res.json({ ok: true, chain: ['revise', 'lock'] });
    }
    void startRun('revise', week, note);
    res.json({ ok: true });
  });

  app.post('/api/runs/lock', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const week = String(req.body?.week ?? '');
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    const plans = await readAllPlans();
    const plan = plans.get(week);
    if (!plan) return res.status(404).json({ error: `No plan file for ${week}.` });
    if (plan.status !== 'planning') return res.status(409).json({ error: `${week} is ${plan.status}, not in planning.` });
    const fb = feedback[week];
    const unapproved = plan.meals.filter((m) => !mealApproved(plan, fb, m)).map((m) => m.day);
    if (unapproved.length) return res.status(400).json({ error: `Not everything is approved yet: ${unapproved.join(', ')}.` });
    void startRun('lock', week);
    res.json({ ok: true });
  });

  app.post('/api/runs/fold', requirePasscode, (_req, res) => {
    if (!guardNoRun(res)) return;
    if (!pendingCaptures().length) return res.status(400).json({ error: 'Nothing pending — every capture is already in the record.' });
    void startRun('fold', '');
    res.json({ ok: true });
  });

  app.post('/api/runs/shop-adjust', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const week = String(req.body?.week ?? '');
    const note = String(req.body?.note ?? '').trim();
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    if (!note) return res.status(400).json({ error: 'Say what to change.' });
    const plans = await readAllPlans();
    const plan = plans.get(week);
    if (!plan || plan.status === 'planning') return res.status(409).json({ error: `${week} isn’t locked yet.` });
    void startRun('shop-adjust', week, note);
    res.json({ ok: true });
  });

  // One meal of a LOCKED week to a new servings count: a light run rewrites
  // that row's Servings cell and its grocery lines from pre-scaled ingredient
  // lines (rescale.md). While planning, the stepper writes feedback instead.
  app.post('/api/runs/rescale', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const week = String(req.body?.week ?? '');
    const day = req.body?.day as DayName;
    const servings = req.body?.servings as number;
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    if (!DAYS.includes(day)) return res.status(400).json({ error: 'bad day' });
    if (!Number.isInteger(servings) || servings < COOK_SERVINGS_MIN || servings > COOK_SERVINGS_MAX) {
      return res.status(400).json({ error: `Servings must be a whole number from ${COOK_SERVINGS_MIN} to ${COOK_SERVINGS_MAX}.` });
    }
    const plan = (await readAllPlans()).get(week);
    if (!plan) return res.status(404).json({ error: `No plan file for ${week}.` });
    if (plan.status !== 'locked') return res.status(409).json({ error: `${week} is ${plan.status}: rescaling is for a locked week.` });
    const meal = plan.meals.find((m) => m.day === day && !m.flexible);
    if (!meal) return res.status(400).json({ error: `${week} has no cook night on ${day}.` });
    if ((meal.servings ?? 4) === servings) return res.status(400).json({ error: `${day} is already at ${servings} servings.` });
    if (!guardNoRun(res)) return; // re-check after the await
    void startChain([{ type: 'rescale', week, rescale: { day, servings } }]);
    res.json({ ok: true });
  });

  app.post('/api/runs/review', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const state = await buildState();
    const week = String(req.body?.week ?? state.cooking?.week ?? '');
    if (!/^\d{4}-W\d{2}$/.test(week)) return res.status(400).json({ error: 'bad week' });
    if (state.cooking?.week === week) {
      if (state.cooking.plan.status !== 'locked') return res.status(409).json({ error: `${week} is ${state.cooking.plan.status} — nothing to close.` });
      if (!state.cooking.closeReady) return res.status(400).json({ error: `Still unlogged: ${state.cooking.missing.join(', ')}. Rate those nights first.` });
    }
    void startRun('review', week);
    res.json({ ok: true });
  });

  // "Close out and plan next week": review(cooking week) → propose(ahead week),
  // one chain, with the planning inputs (cook nights + constraints) collected
  // before anything runs. Both weeks must match what buildState says, so a
  // stale tab can't close or plan the wrong week.
  app.post('/api/runs/close-and-plan', requirePasscode, async (req, res) => {
    if (!guardNoRun(res)) return;
    const week = String(req.body?.week ?? '');
    const nextWeek = String(req.body?.nextWeek ?? '');
    if (!/^\d{4}-W\d{2}$/.test(week) || !/^\d{4}-W\d{2}$/.test(nextWeek)) return res.status(400).json({ error: 'bad week' });
    const state = await buildState();
    if (!state.setup.profileReady) return res.status(409).json({ error: PROFILE_FIRST });
    const c = state.cooking;
    if (!c || c.week !== week) return res.status(409).json({ error: `${week} isn't the week being cooked${c ? ` (that's ${c.week})` : ''}.` });
    if (c.plan.status !== 'locked') return res.status(409).json({ error: `${week} is ${c.plan.status} — nothing to close.` });
    if (!c.closeReady) return res.status(400).json({ error: `Still unlogged: ${c.missing.join(', ')}. Rate those nights first.` });
    if (nextWeek !== state.aheadWeekId) return res.status(409).json({ error: `The week to plan is ${state.aheadWeekId}, not ${nextWeek}.` });
    if (state.ahead) return res.status(409).json({ error: `${nextWeek} already has a plan file — close out only, then revise it on the Next tab.` });
    const cn = parseCookNights(req.body?.cookNights, nextWeek);
    if ('error' in cn) return res.status(400).json({ error: cn.error });
    const note = withCookNights(nextWeek, cn.nights, String(req.body?.note ?? ''));
    if (!guardNoRun(res)) return; // re-check after the awaits; nothing async between here and the lock
    void startChain([
      { type: 'review', week },
      {
        type: 'propose', week: nextWeek, note,
        // a desktop session could push a plan for nextWeek while the close-out runs; never overwrite it
        guard: async () => ((await readAllPlans()).has(nextWeek) ? `${nextWeek} got a plan file while ${week} was closing` : null),
      },
    ]);
    res.json({ ok: true, chain: ['review', 'propose'] });
  });

  app.post('/api/stop', requirePasscode, (_req, res) => {
    if (!run) return res.status(409).json({ error: 'No active run.' });
    run.abort.abort();
    res.json({ ok: true });
  });

  app.get('/api/run', (_req, res) => {
    res.json({ ...runPublic(), events: run?.events ?? [] });
  });

  // --- settings (GET open; PUT passcode + rate limit) ---
  // app/data/settings.json holds only the keys someone changed; absent = env /
  // built-in fallback. `null` in a PUT deletes the key (reset to default).

  app.get('/api/settings', async (_req, res) => {
    try { res.json(await settingsPayload()); }
    catch (err) { res.status(500).json({ error: String(err) }); }
  });

  app.put('/api/settings', settingsRateLimit, requirePasscode, async (req, res) => {
    const body: unknown = req.body;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return res.status(400).json({ error: 'Send a JSON object of settings.' });
    const patch = body as Record<string, unknown>;
    for (const [k, v] of Object.entries(patch)) {
      if (!(SETTING_KEYS as readonly string[]).includes(k)) return res.status(400).json({ error: `Unknown setting: ${k}` });
      if (v === null) continue;
      const err = settingError(k as SettingKey, v);
      if (err) return res.status(400).json({ error: err });
    }
    // An empty PUT is a no-op that still proves the passcode — the panel uses
    // it to check a passcode before storing it on a device.
    if (!Object.keys(patch).length) return res.json(await settingsPayload());

    const next: Record<string, unknown> = { ...settings };
    for (const [k, v] of Object.entries(patch)) {
      if (v === null) delete next[k]; else next[k] = v;
    }
    setSettings(next as Settings);
    try { await saveSettings(); }
    catch (err) { return res.status(500).json({ error: `Could not save settings: ${String(err)}` }); }
    const ip = clientIp(req);
    const who = (await whoFor(req)) ?? ip.replace(/^::ffff:/, '');
    console.log(`[mealapp] settings changed by ${who}: ${JSON.stringify(patch)}`);
    broadcast({ type: 'settings-updated' });
    // /api/state carries autoFold, which may have just flipped
    if ('autoFold' in patch) broadcast({ type: 'state-updated' });
    res.json(await settingsPayload());
  });
}
