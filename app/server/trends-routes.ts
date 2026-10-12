// The I/O half of trends.ts (which is pure): GET /api/trends for the Week
// tab's Trends card, and the close-out prompt's {{TRENDS}} block (runs.ts).
// Computed fresh on every call — 14-odd plan files and ~30 recipes parse in a
// few milliseconds, so there is no cache to go stale after a run or a pull.
import type express from 'express';
import { readAllPlans, readRecipes } from './repo.ts';
import { computeTrends, trendsPromptBlock } from './trends.ts';
import { todayUTC, weekIdForDate } from './weeks.ts';

export function registerTrendsRoutes(app: express.Express) {
  // Open GET (trust model: every read is open). ?weeks=2..52, default 12.
  // The current week is flagged inProgress; locked weeks after it are left out.
  app.get('/api/trends', async (req, res) => {
    try {
      const n = Math.min(52, Math.max(2, Math.floor(Number(req.query.weeks)) || 12));
      const current = weekIdForDate(todayUTC());
      const [plans, recipes] = await Promise.all([readAllPlans(), readRecipes()]);
      const t = computeTrends([...plans.values()], recipes, { weeks: n, through: current, inProgress: current });
      res.json({ currentWeek: current, ...t });
    } catch (err) { res.status(500).json({ error: String(err) }); }
  });
}

/** {{TRENDS}} for a review run: the closing week and the five before it, none flagged in progress. */
export async function trendsForPrompt(week: string): Promise<string> {
  const [plans, recipes] = await Promise.all([readAllPlans(), readRecipes()]);
  return trendsPromptBlock(computeTrends([...plans.values()], recipes, { weeks: 6, through: week }), week);
}
