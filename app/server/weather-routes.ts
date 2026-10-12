// The kitchen window's two open endpoints (weather.ts does the work):
//   GET /api/weather       → { configured: false } | the snapshot (fresh, or stale with `stale: true`)
//                            | { configured: true, unavailable: true, location, unit, error }
//   GET /api/geocode?q=…   → { results: [{ name, admin1?, country?, lat, lon, tz }] } (up to 6)
// Both are reads (open under the trust model) and rate-limited per device like
// the other open endpoints. Saving a place goes through PUT /api/settings
// { location } (passcode), which broadcasts settings-updated; the window
// refetches on that and the new place misses weather.ts's cache.
import type express from 'express';
import { allowHit, clientIp } from './auth.ts';
import { GeoError, geocode, getWeather } from './weather.ts';

export const WEATHER_PER_MIN = 30; // the window asks every 15 min, on tab show and on wake; served from cache
export const GEOCODE_PER_MIN = 20; // search-as-you-type in the gear panel, debounced

export function registerWeatherRoutes(app: express.Express) {
  app.get('/api/weather', async (req, res) => {
    if (!allowHit('weather', clientIp(req), WEATHER_PER_MIN)) return res.status(429).json({ error: `Easy there — ${WEATHER_PER_MIN} weather checks per minute, tops.` });
    const w = await getWeather(); // never throws
    res.set('Cache-Control', 'no-store');
    res.json(w ?? { configured: false });
  });

  app.get('/api/geocode', async (req, res) => {
    if (!allowHit('geocode', clientIp(req), GEOCODE_PER_MIN)) return res.status(429).json({ error: `Easy there — ${GEOCODE_PER_MIN} place searches per minute, tops.` });
    try {
      res.json({ results: await geocode(String(req.query.q ?? '')) });
    } catch (e) {
      if (e instanceof GeoError) return res.status(e.status).json({ error: e.message });
      console.error('[weather] place search:', e);
      res.status(500).json({ error: 'The place search broke — try again.' });
    }
  });
}
