// The kitchen window's weather (Week tab; public/js/05-window.js draws it).
// Open-Meteo, no key and no account: the forecast for the gear panel's saved
// location, and the place search that sets it. Every network call happens
// here, server-side, so the phone never talks to a third party and every
// device shares one fetch.
//
// getWeather() never throws: null when no location is set, else a snapshot
// (cached 10 minutes), the last good snapshot marked `stale` for up to 3 hours
// while Open-Meteo is failing, or `{ unavailable }` when there is nothing to
// fall back on. The cache is keyed by place + unit, so changing either in the
// gear panel misses it and fetches fresh. A failure is retried at most once a
// minute however often the window asks.
//
// Dev knob: MEALAPP_WEATHER_FAKE=<json> returns that object merged over a sane
// base (one level deep for location / current / daily) without calling
// Open-Meteo, for screenshots and QA. It works with or without a saved place.
import { effectiveSettings, type TempUnit, type WeatherLocation } from './store.ts';

export const WEATHER_TTL_MS = 10 * 60_000;
export const WEATHER_STALE_MAX_MS = 3 * 60 * 60_000;
export const WEATHER_RETRY_MS = 60_000;
const FETCH_TIMEOUT_MS = 6_000;
const FORECAST_URL = 'https://api.open-meteo.com/v1/forecast';
const GEOCODE_URL = 'https://geocoding-api.open-meteo.com/v1/search';
const HEADERS = { accept: 'application/json', 'user-agent': 'meal-planner kitchen window (self-hosted, one household)' };
const TEXT_MAX = 80; // store.ts validates saved places to this length

export interface WeatherSnapshot {
  configured: true;
  location: WeatherLocation;
  unit: TempUnit;
  fetchedAt: number;   // ms epoch of the Open-Meteo answer behind this snapshot
  stale: boolean;      // true = Open-Meteo is failing and this is the last good one (≤ 3 h old)
  fake?: true;         // MEALAPP_WEATHER_FAKE
  timezone: string;    // Open-Meteo's resolved zone for the place (sunrise/sunset are local to it)
  current: {
    temp: number;        // in `unit`
    feelsLike: number;
    code: number;        // WMO weather code
    isDay: boolean;
    cloudCover: number;  // %
    windMph: number;
    precipMm: number;
    rainMm: number;      // rain + showers
    snowCm: number;
  };
  daily: {
    sunrise: string;   // local ISO without offset, "2026-10-12T07:19"
    sunset: string;
    tmax: number;
    tmin: number;
    code: number;
  };
}
export interface WeatherUnavailable {
  configured: true;
  unavailable: true;
  location: WeatherLocation;
  unit: TempUnit;
  error: string;
}
export type WeatherResult = WeatherSnapshot | WeatherUnavailable;

export interface GeoResult { name: string; admin1?: string; country?: string; lat: number; lon: number; tz: string }

/** A user-facing place-search failure (the route answers it as a 4xx/502 with this message). */
export class GeoError extends Error {
  constructor(public status: number, message: string) { super(message); }
}

// ---------- pure: response → snapshot / results ----------

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const first = (v: unknown): unknown => (Array.isArray(v) ? v[0] : undefined);
const ISO_LOCAL = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;

/** An Open-Meteo forecast body → a snapshot. Throws on a malformed body (the caller treats it as a failed fetch). */
export function normalizeForecast(json: unknown, location: WeatherLocation, unit: TempUnit, fetchedAt: number): WeatherSnapshot {
  const j = (json ?? {}) as Record<string, unknown>;
  const c = (j.current ?? {}) as Record<string, unknown>;
  const d = (j.daily ?? {}) as Record<string, unknown>;
  const temp = num(c.temperature_2m);
  const code = num(c.weather_code);
  const sunrise = first(d.sunrise);
  const sunset = first(d.sunset);
  if (temp === null || code === null) throw new Error('forecast without current temperature / weather code');
  if (typeof sunrise !== 'string' || typeof sunset !== 'string' || !ISO_LOCAL.test(sunrise) || !ISO_LOCAL.test(sunset)) {
    throw new Error('forecast without daily sunrise / sunset');
  }
  return {
    configured: true,
    location,
    unit,
    fetchedAt,
    stale: false,
    timezone: typeof j.timezone === 'string' ? j.timezone : location.tz,
    current: {
      temp,
      feelsLike: num(c.apparent_temperature) ?? temp,
      code,
      isDay: num(c.is_day) === 1,
      cloudCover: Math.max(0, Math.min(100, num(c.cloud_cover) ?? 0)),
      windMph: Math.max(0, num(c.wind_speed_10m) ?? 0),
      precipMm: Math.max(0, num(c.precipitation) ?? 0),
      rainMm: Math.max(0, (num(c.rain) ?? 0) + (num(c.showers) ?? 0)),
      snowCm: Math.max(0, num(c.snowfall) ?? 0),
    },
    daily: {
      sunrise: sunrise.slice(0, 16),
      sunset: sunset.slice(0, 16),
      tmax: num(first(d.temperature_2m_max)) ?? temp,
      tmin: num(first(d.temperature_2m_min)) ?? temp,
      code: num(first(d.weather_code)) ?? code,
    },
  };
}

const clip = (s: unknown): string | undefined => {
  if (typeof s !== 'string') return undefined;
  const t = s.trim();
  return t ? t.slice(0, TEXT_MAX) : undefined;
};

/** An Open-Meteo geocoding body → places (populated places first, then the rest in the geocoder's order). */
export function normalizeGeocode(json: unknown): GeoResult[] {
  const rows = (json as { results?: unknown } | null)?.results;
  if (!Array.isArray(rows)) return [];
  const out: { r: GeoResult; town: boolean }[] = [];
  for (const raw of rows) {
    const o = (raw ?? {}) as Record<string, unknown>;
    const name = clip(o.name);
    const lat = num(o.latitude);
    const lon = num(o.longitude);
    if (!name || lat === null || lon === null || Math.abs(lat) > 90 || Math.abs(lon) > 180) continue;
    const r: GeoResult = { name, lat, lon, tz: clip(o.timezone) ?? '' };
    const admin1 = clip(o.admin1);
    const country = clip(o.country);
    if (admin1) r.admin1 = admin1;
    if (country) r.country = country;
    out.push({ r, town: typeof o.feature_code === 'string' && o.feature_code.startsWith('PPL') });
  }
  return [...out.filter((x) => x.town), ...out.filter((x) => !x.town)].map((x) => x.r);
}

const US_STATES: Record<string, string> = {
  al: 'alabama', ak: 'alaska', az: 'arizona', ar: 'arkansas', ca: 'california', co: 'colorado', ct: 'connecticut',
  de: 'delaware', dc: 'district of columbia', fl: 'florida', ga: 'georgia', hi: 'hawaii', id: 'idaho', il: 'illinois',
  in: 'indiana', ia: 'iowa', ks: 'kansas', ky: 'kentucky', la: 'louisiana', me: 'maine', md: 'maryland',
  ma: 'massachusetts', mi: 'michigan', mn: 'minnesota', ms: 'mississippi', mo: 'missouri', mt: 'montana',
  ne: 'nebraska', nv: 'nevada', nh: 'new hampshire', nj: 'new jersey', nm: 'new mexico', ny: 'new york',
  nc: 'north carolina', nd: 'north dakota', oh: 'ohio', ok: 'oklahoma', or: 'oregon', pa: 'pennsylvania',
  ri: 'rhode island', sc: 'south carolina', sd: 'south dakota', tn: 'tennessee', tx: 'texas', ut: 'utah',
  vt: 'vermont', va: 'virginia', wa: 'washington', wv: 'west virginia', wi: 'wisconsin', wy: 'wyoming',
};

/** "Portland, OR" → the Oregon Portland first: results whose state/country matches the text after the comma lead. */
export function rankByQualifier(results: GeoResult[], qualifier: string): GeoResult[] {
  const q = qualifier.trim().toLowerCase().replace(/\./g, '');
  if (!q) return results;
  const want = US_STATES[q] ?? q;
  const hit = (r: GeoResult) => [r.admin1, r.country].some((s) => !!s && s.toLowerCase().startsWith(want))
    || (q === 'usa' || q === 'us' ? r.country === 'United States' : false);
  return [...results.filter(hit), ...results.filter((r) => !hit(r))];
}

// ---------- the fake (MEALAPP_WEATHER_FAKE) ----------

let fakeRaw: string | undefined;
let fakeParsed: Record<string, unknown> | null = null;
/** The parsed dev knob, or null when unset / not a JSON object (logged once). */
export function fakeFromEnv(): Record<string, unknown> | null {
  const raw = process.env.MEALAPP_WEATHER_FAKE;
  if (raw === fakeRaw) return fakeParsed;
  fakeRaw = raw;
  fakeParsed = null;
  if (!raw || !raw.trim()) return null;
  try {
    const v = JSON.parse(raw) as unknown;
    if (v && typeof v === 'object' && !Array.isArray(v)) fakeParsed = v as Record<string, unknown>;
    else console.log('[weather] MEALAPP_WEATHER_FAKE is not a JSON object; ignoring it');
  } catch {
    console.log('[weather] MEALAPP_WEATHER_FAKE is not valid JSON; ignoring it');
  }
  if (fakeParsed) console.log(`[weather] MEALAPP_WEATHER_FAKE on: ${JSON.stringify(fakeParsed)} (no Open-Meteo calls)`);
  return fakeParsed;
}

const pad = (n: number) => String(n).padStart(2, '0');
/** `over` merged over a plausible base snapshot (the saved place if any; today at 07:15 / 18:35, server-local). */
export function fakeSnapshot(over: Record<string, unknown>, location: WeatherLocation | null, unit: TempUnit, now = Date.now()): WeatherSnapshot {
  const t = new Date(now);
  const ymd = `${t.getFullYear()}-${pad(t.getMonth() + 1)}-${pad(t.getDate())}`;
  const mins = t.getHours() * 60 + t.getMinutes();
  const temp = unit === 'C' ? 16 : 61;
  const obj = (v: unknown) => (v && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : {});
  const base: WeatherSnapshot = {
    configured: true,
    location: location ?? { name: 'Fake weather', lat: 0, lon: 0, tz: 'UTC' },
    unit,
    fetchedAt: now,
    stale: false,
    fake: true,
    timezone: location?.tz || 'UTC',
    current: { temp, feelsLike: temp, code: 0, isDay: mins >= 7 * 60 + 15 && mins < 18 * 60 + 35, cloudCover: 10, windMph: 5, precipMm: 0, rainMm: 0, snowCm: 0 },
    daily: { sunrise: `${ymd}T07:15`, sunset: `${ymd}T18:35`, tmax: temp + 8, tmin: temp - 9, code: 0 },
  };
  return {
    ...base,
    ...(over as Partial<WeatherSnapshot>),
    configured: true,
    fake: true,
    location: { ...base.location, ...obj(over.location) } as WeatherLocation,
    current: { ...base.current, ...obj(over.current) } as WeatherSnapshot['current'],
    daily: { ...base.daily, ...obj(over.daily) } as WeatherSnapshot['daily'],
  };
}

// ---------- I/O: forecast with cache, place search ----------

const describe = (e: unknown) => (e instanceof Error ? (e.name === 'TimeoutError' || e.name === 'AbortError' ? `no answer in ${FETCH_TIMEOUT_MS / 1000} s` : e.message) : String(e));

async function getJson(url: URL): Promise<unknown> {
  const res = await fetch(url, { headers: HEADERS, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }); // covers the body too
  if (!res.ok) throw new Error(`Open-Meteo answered ${res.status}`);
  return res.json();
}

/** One forecast fetch for a place + unit (throws; getWeather catches). */
export async function fetchForecast(location: WeatherLocation, unit: TempUnit): Promise<WeatherSnapshot> {
  const u = new URL(FORECAST_URL);
  u.search = new URLSearchParams({
    latitude: String(location.lat),
    longitude: String(location.lon),
    current: 'temperature_2m,apparent_temperature,is_day,precipitation,rain,showers,snowfall,weather_code,cloud_cover,wind_speed_10m',
    daily: 'sunrise,sunset,temperature_2m_max,temperature_2m_min,weather_code',
    temperature_unit: unit === 'C' ? 'celsius' : 'fahrenheit',
    wind_speed_unit: 'mph',
    timezone: 'auto',
    forecast_days: '1',
  }).toString();
  return normalizeForecast(await getJson(u), location, unit, Date.now());
}

const cacheKey = (l: WeatherLocation, unit: TempUnit) => `${l.lat.toFixed(4)},${l.lon.toFixed(4)},${unit}`;
let cache: { key: string; snap: WeatherSnapshot } | null = null;
let inflight: { key: string; p: Promise<WeatherSnapshot> } | null = null;
let lastFail: { key: string; at: number; error: string } | null = null;

function fallback(key: string, location: WeatherLocation, unit: TempUnit, error: string, now: number): WeatherResult {
  if (cache?.key === key && now - cache.snap.fetchedAt < WEATHER_STALE_MAX_MS) return { ...cache.snap, stale: true };
  return { configured: true, unavailable: true, location, unit, error };
}

/** The window's weather now: null (no place set), a snapshot (fresh or stale), or unavailable. Never throws. */
export async function getWeather(now = Date.now()): Promise<WeatherResult | null> {
  try {
    const { location, tempUnit } = effectiveSettings();
    const fake = fakeFromEnv();
    if (fake) return fakeSnapshot(fake, location, tempUnit, now);
    if (!location) return null;
    const key = cacheKey(location, tempUnit);
    if (cache?.key === key && now - cache.snap.fetchedAt < WEATHER_TTL_MS) return cache.snap;
    if (lastFail?.key === key && now - lastFail.at < WEATHER_RETRY_MS) return fallback(key, location, tempUnit, lastFail.error, now);
    // several devices asking at once share one fetch
    let shared = inflight?.key === key ? inflight.p : null;
    if (!shared) {
      const p = fetchForecast(location, tempUnit);
      inflight = { key, p };
      void p.then(() => {}, () => {}).finally(() => { if (inflight?.p === p) inflight = null; });
      shared = p;
    }
    try {
      const snap = await shared;
      if (cache?.key !== key || cache.snap.fetchedAt !== snap.fetchedAt) {
        console.log(`[weather] ${location.name}: ${Math.round(snap.current.temp)}°${tempUnit}, code ${snap.current.code}, cloud ${snap.current.cloudCover}%, wind ${Math.round(snap.current.windMph)} mph`);
      }
      cache = { key, snap };
      if (lastFail?.key === key) lastFail = null;
      return snap;
    } catch (e) {
      const error = describe(e);
      if (lastFail?.key !== key || lastFail.error !== error) console.log(`[weather] ${location.name}: forecast failed (${error})${cache?.key === key ? '; serving the last good one' : ''}`);
      lastFail = { key, at: now, error };
      return fallback(key, location, tempUnit, error, now);
    }
  } catch (e) {
    console.error('[weather] unexpected:', e);
    return null;
  }
}

/** Up to six places for a typed name ("Millbrook", "Portland, OR"). Throws GeoError with a user-facing message. */
export async function geocode(q: string): Promise<GeoResult[]> {
  const query = q.trim().replace(/\s+/g, ' ');
  if (query.length < 2) throw new GeoError(400, 'Type at least two letters of a town or city.');
  if (query.length > TEXT_MAX) throw new GeoError(400, `That’s longer than ${TEXT_MAX} characters.`);
  const search = async (name: string) => {
    const u = new URL(GEOCODE_URL);
    u.search = new URLSearchParams({ name, count: '10', language: 'en', format: 'json' }).toString();
    return normalizeGeocode(await getJson(u));
  };
  try {
    let results = await search(query);
    // "Town, ST" / "Town, Country": the geocoder matches names only, so when
    // the whole string finds nothing, search the town and rank by the rest
    const comma = query.indexOf(',');
    if (!results.length && comma > 0) {
      results = rankByQualifier(await search(query.slice(0, comma).trim()), query.slice(comma + 1));
    }
    return results.slice(0, 6);
  } catch (e) {
    console.log(`[weather] place search "${query}" failed: ${describe(e)}`);
    throw new GeoError(502, `Couldn’t reach the place search (${describe(e)}). Try again in a moment.`);
  }
}

/** Test seam: forget the cache and the failure memo. */
export function resetWeatherCache() {
  cache = null;
  inflight = null;
  lastFail = null;
}
