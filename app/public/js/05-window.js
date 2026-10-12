/* 05-window.js — the kitchen window. You're at the sink; the window over it
   looks out on the back woods, showing the real sky, weather, time of day and
   season for the household's place (Settings → Kitchen window). Week tab only,
   above the page header. Drawn, not photographed: one inline SVG (viewBox
   390 × 176, ≤ ~120 nodes) + CSS animations on transform/opacity, no images,
   no libraries, no canvas, no rAF loop. Weather comes from GET /api/weather
   (server/weather.ts; Open-Meteo is called server-side only).

   The first half of this file is pure (no DOM): scenePhase, skyStops,
   conditions, season, moonPhase, windowScene, windowSvg, windowCaption,
   parseScene. scripts/selftest.ts loads this file in a node vm and checks
   them, so DOM work stays inside functions or the guarded block at the end.

   Animation phases come from the wall clock (negative animation-delay =
   seconds since the epoch modulo the period), so re-drawing the scene once
   a minute never makes a cloud jump back to its start.

   Classic script (not an ES module): index.html loads public/js/*.js in
   filename order and every top-level function/let/const is shared global
   scope across the files. Top-level code here may only use bindings from
   this file or earlier ones; cross-file calls inside functions are fine.
   Everything here is prefixed wx/WX (or named for the window) to keep that
   shared scope collision-free.
*/
'use strict';

/* ---------- pure: constants ---------- */
const WX_PHASES = ['night', 'dawn', 'sunrise', 'morning', 'day', 'golden', 'sunset', 'dusk'];
const WX_CONDS = ['clear', 'partly', 'overcast', 'fog', 'drizzle', 'rain', 'snow', 'storm'];
const WX_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const WX_INK = '#0C112C';                 // what the woods darken toward at night
const WX_PAPER = '#F4EDE1';               // daylight colours lean a touch toward the page: an illustration, not a photo
const WX_DEFAULT_SUN = ['07:00', '18:30']; // no place set: the device clock with these
// glass (inside the frame), panes split by a mullion at x 192.5–197.5 and a meeting rail at y 73.5–80.5
const WX_G = { x0: 18, y0: 12, x1: 372, y1: 142, w: 354, h: 130 };

// Sky keyframes. `sky` = four gradient stops, top → horizon (glass top y 12 → the ridge, y 94).
// light = how lit the woods are (0 night … 1 noon); tint/tintAmt = the
// warm or rosy cast on the trees; cloud = cloud body colour; stars = alpha;
// sun = [disc, glow].
const WX_SKY = {
  night:   { sky: ['#0E1437', '#18204D', '#252D5E', '#343A69'], light: .13, tint: '#1A2250', tintAmt: 0,   cloud: '#323863', stars: 1,   sun: ['#FFB46B', '#FF9F5E'] },
  dawn:    { sky: ['#283063', '#665F94', '#CF8E9F', '#F3B98A'], light: .38, tint: '#D88E9E', tintAmt: .12, cloud: '#E3AEBC', stars: .35, sun: ['#FFB46B', '#FFA56B'] },
  sunrise: { sky: ['#4C6EAB', '#9A9BC4', '#EFB8A4', '#FDD399'], light: .64, tint: '#FFB98A', tintAmt: .13, cloud: '#FFD9C4', stars: 0,   sun: ['#FFC57E', '#FFB06A'] },
  morning: { sky: ['#5C93CE', '#84B1DD', '#B7D5EC', '#E2EEEB'], light: .92, tint: '#FFF1D8', tintAmt: .04, cloud: '#FFFFFF', stars: 0,   sun: ['#FFF3D4', '#FFEEC2'] },
  day:     { sky: ['#4D8BCA', '#71A8DA', '#A4C9E7', '#D3E5EF'], light: 1,   tint: '#FFFFFF', tintAmt: 0,   cloud: '#FFFFFF', stars: 0,   sun: ['#FFF9E8', '#FFF4D2'] },
  golden:  { sky: ['#5B84BB', '#94ACCB', '#E5C59C', '#F6BA6F'], light: .86, tint: '#FFAE48', tintAmt: .15, cloud: '#FFE7CB', stars: 0,   sun: ['#FFDC92', '#FFC46A'] },
  sunset:  { sky: ['#3B4380', '#866895', '#DE846A', '#F5A85F'], light: .56, tint: '#EC7C55', tintAmt: .18, cloud: '#F1AA94', stars: .06, sun: ['#FFA562', '#FF8A55'] },
  dusk:    { sky: ['#171D4A', '#3D3977', '#92638A', '#DA987B'], light: .3,  tint: '#8A6294', tintAmt: .13, cloud: '#8C6E91', stars: .55, sun: ['#FF9F5E', '#FF8A55'] },
};

// Foliage per season (daylight colours; the scene darkens and tints them).
// leaf: 1 = full canopy, .55 = November thinning (branches show), 0 = bare.
const WX_SEASONS = {
  winter:         { far: '#7E7B87', canopy: [], conifer: '#2D4A3B', near: ['#33473A', '#2B3D33'], trunk: '#4A3E37', ground: '#7B7563', branch: '#5A4F49', haze: '#8C837E', leaf: 0 },
  spring:         { far: '#8CA48C', canopy: ['#9CBF73', '#B4CE89', '#86AD63'], conifer: '#3C6246', near: ['#5C8446', '#4B723B'], trunk: '#4A3B30', ground: '#7B9E56', blossom: '#F8E1EA', leaf: 1 },
  summer:         { far: '#6C8B73', canopy: ['#4E7B3D', '#5F8C48', '#41693A'], conifer: '#2E5540', near: ['#2F4E2C', '#3A5D34'], trunk: '#3B2F27', ground: '#5B7B42', leaf: 1 },
  'early-autumn': { far: '#86906F', canopy: ['#7E9442', '#C9A13D', '#66833C', '#B9692F'], conifer: '#2F533F', near: ['#4D6233', '#6A5A2C'], trunk: '#3E3128', ground: '#76743F', leaf: 1 },
  autumn:         { far: '#9E8A74', canopy: ['#E2A93C', '#D4762F', '#B7472C', '#9C9642'], conifer: '#2E4F3E', near: ['#8A4426', '#6A5A2A'], trunk: '#3E3027', ground: '#957140', leaf: 1 },
  'late-autumn':  { far: '#8A7F76', canopy: ['#8E6C45', '#7A5938', '#A27C4C'], conifer: '#2D4B3C', near: ['#5A4532', '#493A2C'], trunk: '#43362D', ground: '#6F5D45', branch: '#5A4C42', haze: '#8A7C70', leaf: .55 },
};

// ?scene= previews: a representative WMO code, cloud cover and wind per condition
const WX_FORCE = {
  clear: { code: 0, cc: 4, wind: 4 }, partly: { code: 2, cc: 45, wind: 7 }, overcast: { code: 3, cc: 100, wind: 8 },
  fog: { code: 45, cc: 92, wind: 2 }, drizzle: { code: 53, cc: 88, wind: 6 }, rain: { code: 63, cc: 96, wind: 9 },
  snow: { code: 73, cc: 94, wind: 5 }, storm: { code: 95, cc: 100, wind: 18 },
};

/* ---------- pure: small helpers ---------- */
const wxClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const wxF = (v) => Math.round(v * 10) / 10; // one decimal keeps the markup short
function wxRgb(hex) { const n = parseInt(String(hex).slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; }
function wxHex(rgb) { return `#${rgb.map((v) => wxClamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('')}`; }
function wxMix(a, b, t) {
  if (t <= 0) return a;
  if (t >= 1) return b;
  const A = wxRgb(a), B = wxRgb(b);
  return wxHex(A.map((v, i) => v + (B[i] - v) * t));
}
const wxLum = (hex) => { const [r, g, b] = wxRgb(hex); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
/** A grey at the colour's own brightness (× k): a hair cool, bluer the darker it is (night cloud). */
const wxGrey = (hex, k = 1) => {
  const l = wxLum(hex) * k;
  const blue = wxClamp((120 - l) / 120, 0, 1);
  return wxHex([l * (.98 - .1 * blue), l * (1 - .03 * blue), l * (1.04 + .3 * blue)]);
};
const wxSmooth = (t) => t * t * (3 - 2 * t);
/** Seeded PRNG (mulberry32): the woods, stars and clouds land in the same places on every render. */
function wxRand(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** Minutes after local midnight from a Date, "2026-10-12T07:19", "07:19", or a number of minutes. */
function wxMinutes(t) {
  if (typeof t === 'number') return Number.isFinite(t) ? t : null;
  if (t && typeof t.getHours === 'function') return t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60;
  const m = /(?:^|T)(\d{1,2}):(\d{2})/.exec(String(t ?? ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}
/** "6:40 pm" from minutes after midnight. */
function wxClock(min) {
  const t = ((Math.round(min) % 1440) + 1440) % 1440;
  const h = Math.floor(t / 60), m = t % 60;
  return `${h % 12 || 12}:${String(m).padStart(2, '0')} ${h < 12 ? 'am' : 'pm'}`;
}

/* ---------- pure: the five scene functions ---------- */

/** Phase of the day: night | dawn | sunrise | morning | day | golden | sunset | dusk, plus the
   sun's position on its arc (sunP: 0 at sunrise, 1 at sunset) and the clock in minutes.
   Sunrise/sunset arrive from Open-Meteo as the place's local times without an offset and are
   compared as wall-clock times on this device: in practice the phone is in the place's time
   zone (a phone travelling elsewhere would see home's sunrise at its own local hour). Only the
   time of day is used, so a snapshot fetched before midnight still works after it. */
function scenePhase(now, sunrise, sunset) {
  let sr = wxMinutes(sunrise), ss = wxMinutes(sunset);
  // missing or polar-extreme days fall back to the no-location defaults
  if (sr === null || ss === null || ss - sr < 240 || ss - sr > 1200) { sr = wxMinutes(WX_DEFAULT_SUN[0]); ss = wxMinutes(WX_DEFAULT_SUN[1]); }
  const m = wxMinutes(now) ?? 720;
  const edges = [[sr - 45, 'dawn'], [sr - 8, 'sunrise'], [sr + 30, 'morning'], [sr + 120, 'day'],
    [ss - 80, 'golden'], [ss - 12, 'sunset'], [ss + 15, 'dusk'], [ss + 50, 'night']];
  let phase = 'night';
  for (const [t, ph] of edges) if (m >= t) phase = ph;
  return { phase, minute: m, sr, ss, sunP: (m - sr) / (ss - sr) };
}

/** Sky keyframes in time; the sky between two is a smooth blend, so it never jumps at a phase edge. */
function wxSkyKeys(sr, ss) {
  const day = ss - 130 > sr + 150 ? [[sr + 150, 'day'], [ss - 130, 'day']] : [[(sr + ss) / 2, 'day']];
  return [[sr - 75, 'night'], [sr - 30, 'dawn'], [sr + 6, 'sunrise'], [sr + 75, 'morning'], ...day,
    [ss - 55, 'golden'], [ss - 4, 'sunset'], [ss + 28, 'dusk'], [ss + 75, 'night']];
}
function wxSkyAt(m, sr, ss) {
  const K = wxSkyKeys(sr, ss);
  if (m <= K[0][0] || m >= K[K.length - 1][0]) return { a: 'night', b: 'night', f: 0 };
  for (let i = 0; i < K.length - 1; i++) {
    const [t0, a] = K[i], [t1, b] = K[i + 1];
    if (m >= t0 && m < t1) return { a, b, f: wxSmooth((m - t0) / (t1 - t0)) };
  }
  return { a: 'night', b: 'night', f: 0 };
}
/** 0 (clean sky) … .92 (storm grey): cloud cover plus a bump for wet or murky weather. */
function wxCloudiness(cloudCover, kind) {
  const wet = { drizzle: .14, rain: .2, snow: .12, storm: .32, fog: .22, overcast: .06 }[kind] || 0;
  return wxClamp(wxClamp((cloudCover - 25) / 75, 0, 1) * .6 + wet, 0, .92);
}
function wxGreySky(stops, k, kind) {
  if (k <= 0) return stops.slice();
  const avg = wxHex([0, 1, 2].map((i) => stops.reduce((a, s) => a + wxRgb(s)[i], 0) / stops.length));
  const bright = kind === 'storm' ? .6 : kind === 'rain' ? .86 : kind === 'snow' || kind === 'fog' ? 1.08 : .95;
  return stops.map((s) => wxMix(wxMix(s, avg, k * .55), wxGrey(s, bright), k));
}
/** Four sky gradient stops (top → horizon) for a phase, flattened and greyed by cloud cover. */
function skyStops(phase, cloudCover = 0, kind = 'clear') {
  return wxGreySky((WX_SKY[phase] || WX_SKY.day).sky, wxCloudiness(cloudCover, kind), kind);
}

/** WMO weather code → { kind: clear|partly|overcast|fog|drizzle|rain|snow|storm, intensity 0–1, label }. */
function conditions(code, isDay = true) {
  const c = Number(code);
  const C = (kind, intensity, label) => ({ kind, intensity, label });
  switch (c) {
    case 0: return C('clear', 0, isDay ? 'sunny' : 'clear');
    case 1: return C('partly', .3, isDay ? 'mostly sunny' : 'mostly clear');
    case 2: return C('partly', .6, 'partly cloudy');
    case 3: return C('overcast', 1, 'overcast');
    case 45: return C('fog', .8, 'fog');
    case 48: return C('fog', 1, 'freezing fog');
    case 51: return C('drizzle', .3, 'light drizzle');
    case 53: return C('drizzle', .55, 'drizzle');
    case 55: return C('drizzle', .85, 'heavy drizzle');
    case 56: case 57: return C('drizzle', c === 56 ? .45 : .8, 'freezing drizzle');
    case 61: return C('rain', .35, 'light rain');
    case 63: return C('rain', .6, 'rain');
    case 65: return C('rain', 1, 'heavy rain');
    case 66: case 67: return C('rain', c === 66 ? .45 : .9, 'freezing rain');
    case 71: return C('snow', .35, 'light snow');
    case 73: return C('snow', .6, 'snow');
    case 75: return C('snow', 1, 'heavy snow');
    case 77: return C('snow', .3, 'snow grains');
    case 80: return C('rain', .4, 'light showers');
    case 81: return C('rain', .7, 'showers');
    case 82: return C('rain', 1, 'heavy showers');
    case 85: return C('snow', .55, 'snow showers');
    case 86: return C('snow', 1, 'heavy snow showers');
    case 95: return C('storm', .75, 'thunderstorm');
    case 96: case 99: return C('storm', 1, 'thunderstorm with hail');
    default: return C('partly', .4, 'cloudy');
  }
}

/** Month (1–12) + latitude → the foliage palette. The southern hemisphere runs six months on. */
function season(month, lat = 1) {
  let m = ((Math.round(month) - 1) % 12 + 12) % 12 + 1;
  if (lat < 0) m = (m + 5) % 12 + 1;
  const key = m === 12 || m <= 2 ? 'winter' : m <= 4 ? 'spring' : m <= 8 ? 'summer'
    : m === 9 ? 'early-autumn' : m === 10 ? 'autumn' : 'late-autumn';
  return { key, month: m, ...WX_SEASONS[key] };
}

/** The moon's age as a fraction of the synodic month (0 new, .5 full), its lit fraction, and a name. */
function moonPhase(date) {
  const SYNODIC = 29.530588853, NEW_MOON = Date.UTC(2000, 0, 6, 18, 14); // a known new moon
  return wxMoonAt(((((Number(date) - NEW_MOON) / 864e5 / SYNODIC) % 1) + 1) % 1);
}
function wxMoonAt(phase) {
  const illum = (1 - Math.cos(2 * Math.PI * phase)) / 2;
  const name = phase < .03 || phase > .97 ? 'new moon' : phase < .22 ? 'waxing crescent' : phase < .28 ? 'first quarter'
    : phase < .47 ? 'waxing gibbous' : phase < .53 ? 'full moon' : phase < .72 ? 'waning gibbous' : phase < .78 ? 'last quarter' : 'waning crescent';
  return { phase, illum, name };
}

const WX_MOON_WORDS = { crescent: .14, quarter: .25, gibbous: .37, full: .5, waning: .66, old: .86 };
/** "rain-night" / "snow-day-jan" / "partly-dusk-4" / "clear-night-full" → { cond, phase, month|null, moon|null }, else null.
   After the condition and phase: an optional month (1–12 or jan…dec) and an optional moon
   (crescent, quarter, gibbous, full, waning, old), in either order. */
function parseScene(raw) {
  if (!raw) return null;
  const [c, p, ...rest] = String(raw).toLowerCase().trim().split(/[-_\s]+/);
  if (!WX_CONDS.includes(c) || !WX_PHASES.includes(p)) return null;
  let month = null, moon = null;
  for (const t of rest) {
    const n = Number(t);
    const i = WX_MONTHS.indexOf(t.slice(0, 3));
    if (Number.isInteger(n) && n >= 1 && n <= 12) month = n;
    else if (t in WX_MOON_WORDS) moon = WX_MOON_WORDS[t];
    else if (i >= 0) month = i + 1;
  }
  return { cond: c, phase: p, month, moon };
}
/** A clock time that shows a phase at its most typical (a keyframe, or a flattering spot for sun/moon). */
function wxPhaseMinute(phase, sr, ss) {
  const night = 1440 - (ss - sr);
  return ({ night: (ss + night * .36) % 1440, dawn: sr - 30, sunrise: sr + 6, morning: sr + 75,
    day: sr + (ss - sr) * .38, golden: ss - 55, sunset: ss - 4, dusk: ss + 28 })[phase];
}
/** Sun and moon share one arc across the glass: 0 = rising at the left, 1 = setting at the right. */
const wxArc = (p) => ({ x: 62 + 266 * p, y: 102 - Math.sin(Math.PI * p) * 74 });

/** Everything the drawing needs, from the clock and a /api/weather payload (or null). Pure.
   wx: the payload; forced: parseScene() result for ?scene= previews. */
function windowScene({ now, wx = null, forced = null }) {
  const real = wx && wx.configured && !wx.unavailable && wx.current && wx.daily ? wx : null;
  const sunrise = real ? real.daily.sunrise : WX_DEFAULT_SUN[0];
  const sunset = real ? real.daily.sunset : WX_DEFAULT_SUN[1];
  const clock = scenePhase(now, sunrise, sunset);
  const { sr, ss } = clock;
  let minute = clock.minute;
  let code = real ? real.current.code : 0;
  let cc = real ? real.current.cloudCover : 0;
  let wind = real ? real.current.windMph : 5;
  let isDay = real ? !!real.current.isDay : minute >= sr && minute < ss;
  if (forced) {
    minute = wxPhaseMinute(forced.phase, sr, ss);
    ({ code, cc, wind } = WX_FORCE[forced.cond]);
    isDay = !['night', 'dusk', 'dawn'].includes(forced.phase);
  }
  const ph = scenePhase(minute, sunrise, sunset);
  const cond = conditions(code, isDay);
  const k = wxCloudiness(cc, cond.kind);
  const { a, b, f } = wxSkyAt(minute, sr, ss);
  const A = WX_SKY[a], B = WX_SKY[b];
  const lerp = (x, y) => x + (y - x) * f;
  // at night an overcast sky keeps some of its indigo: grey it less
  const sky = wxGreySky(A.sky.map((c, i) => wxMix(c, B.sky[i], f)), k * (.62 + .38 * lerp(A.light, B.light)), cond.kind)
    .map((c) => wxMix(c, WX_PAPER, .08 * lerp(A.light, B.light)));
  const wet = ['drizzle', 'rain', 'storm', 'snow'].includes(cond.kind);
  let cloud = wxMix(A.cloud, B.cloud, f);
  if (wet || cond.kind === 'overcast' || cond.kind === 'fog') cloud = wxMix(cloud, wxGrey(cloud, cond.kind === 'storm' ? .62 : .84), cond.kind === 'storm' ? .8 : .5);
  const lat = wx && wx.location && Number.isFinite(wx.location.lat) ? wx.location.lat : 1;
  const month = forced && forced.month ? forced.month : now.getMonth() + 1;

  // sun: on the arc from sunrise to sunset; dimmed and spread by cloud
  const sunVis = wxClamp(1 - wxClamp((cc - 35) / 55, 0, 1) * .92, 0, 1) * (wet ? .55 : 1);
  const sun = ph.sunP > -0.06 && ph.sunP < 1.06
    ? { ...wxArc(ph.sunP), alpha: sunVis, disc: wxMix(A.sun[0], B.sun[0], f), glow: wxMix(A.sun[1], B.sun[1], f) }
    : null;
  // moon: rises about phase × 24 h after the sun and stays up about as long
  // as the day is long — a young crescent sets soon after the sun, a full
  // moon is up all night. A ?scene= night/dusk preview always shows it.
  const mo = forced && forced.moon != null ? wxMoonAt(forced.moon) : moonPhase(now);
  let mp = ((((minute - (sr + mo.phase * 1440)) % 1440) + 1440) % 1440) / (ss - sr);
  const dark = ['night', 'dusk', 'dawn'].includes(ph.phase);
  if (forced && dark && mp > 1) mp = .3;
  const moonA = (dark ? 1 : ph.phase === 'sunset' ? .7 : .38) * wxClamp(1 - wxClamp((cc - 40) / 50, 0, 1) * .85, 0, 1);
  const moon = mp <= 1 && mo.illum >= .01 && (dark || mo.illum > .3) && !(sun && !dark && Math.abs(wxArc(mp).x - sun.x) < 40)
    ? { ...wxArc(mp), alpha: moonA, phase: mo.phase, illum: mo.illum, name: mo.name, dark }
    : null;

  return {
    phase: ph.phase, minute, sr, ss, sunP: ph.sunP, forced: !!forced,
    cond, cloudCover: cc, windMph: wind, k,
    sky, light: lerp(A.light, B.light) * (1 - .3 * k - (cond.kind === 'storm' ? .12 : 0)), mute: k * .5,
    tint: wxMix(A.tint, B.tint, f), tintAmt: lerp(A.tintAmt, B.tintAmt) * (1 - k * .6),
    cloud, stars: lerp(A.stars, B.stars) * Math.pow(1 - cc / 100, 1.6),
    sun, moon, southern: lat < 0, season: season(month, lat),
  };
}

/* ---------- pure: geometry (built once from fixed seeds) ---------- */
const WX_STARS = (() => {
  const r = wxRand(7);
  return [14, 14, 12].map((n) => Array.from({ length: n }, () => [wxF(WX_G.x0 + 4 + r() * (WX_G.w - 8)), wxF(15 + Math.pow(r(), 1.5) * 70)]));
})();
/** A crown as a lumpy cluster: one body and three lobes on its shoulders and crown. */
function wxCrownLobes(x, y, R, r) {
  return [[x, y, R], [x - R * .62, y + R * .28, R * (.56 + r() * .14)], [x + R * .6, y + R * .24, R * (.58 + r() * .14)],
    [x + (r() - .5) * R * .6, y - R * .48, R * (.5 + r() * .16)]].map((l) => l.map(wxF));
}
// mid canopy: two rows of crowns; k picks the colour, rank decides who stays in a thin year
const WX_MID = (() => {
  const r = wxRand(42);
  const out = [];
  for (const [y0, rmin, rspan, step] of [[101, 10, 6, 1.3], [112, 8, 5, 1.45]]) {
    let x = 4 + r() * 8;
    while (x < 394) {
      const R = rmin + r() * rspan;
      out.push({ lobes: wxCrownLobes(x, y0 + r() * 6 - R * .3, R, r), k: r(), rank: r() });
      x += R * (step + r() * .35);
    }
  }
  return out;
})();
const WX_CONIFERS = [[104, 118, 52, 21], [121, 119, 40, 17], [262, 118, 47, 20], [279, 120, 33, 15]];
// the near trees at the edges of the view (crown: cx, cy, r, tone) and low shrubs between them
const WX_NEAR = [
  { x: 34, top: 70, w: 7, lean: -3, seed: 11, crowns: [[16, 86, 18, 0], [38, 97, 15, 1], [10, 106, 16, 1], [50, 110, 11, 0]] },
  { x: 360, top: 76, w: 6, lean: 4, seed: 23, crowns: [[372, 90, 17, 0], [352, 101, 13, 1], [380, 108, 15, 1]] },
];
// near crowns as lumpy clusters (built once)
const WX_NEAR_LOBES = (() => {
  const r = wxRand(77);
  return WX_NEAR.map((t) => t.crowns.map(([x, y, R, tone], i) => ({ tone, i, lobes: wxCrownLobes(x, y, R, r) })));
})();

const WX_DROPS = (() => {
  const r = wxRand(99);
  const out = [];
  while (out.length < 16) {
    const x = WX_G.x0 + 6 + r() * (WX_G.w - 12), y = WX_G.y0 + 6 + r() * (WX_G.h - 12);
    if (Math.abs(x - 195) < 7 || Math.abs(y - 77) < 7) continue; // not on the mullion or the rail
    out.push([wxF(x), wxF(y), wxF(.9 + r() * 1.4)]);
  }
  return out;
})();
const wxCircle = (x, y, r) => `M${wxF(x - r)} ${wxF(y)}a${wxF(r)} ${wxF(r)} 0 1 0 ${wxF(2 * r)} 0a${wxF(r)} ${wxF(r)} 0 1 0 ${wxF(-2 * r)} 0`;
/** A bare tree as strokes: { thick: trunk + limbs, thin: twigs, ends: limb tips (for the winter twig haze) }. */
function wxTree(x, base, h, lean, seed) {
  const r = wxRand(seed);
  const tx = x + lean, ty = base - h;
  let thick = `M${wxF(x)} ${base}Q${wxF(x + lean * .2)} ${wxF(base - h * .55)} ${wxF(tx)} ${wxF(ty)}`;
  let thin = '';
  const ends = [];
  for (let i = 0; i < 5; i++) {
    const t = .36 + i * .13 + r() * .05;
    const side = (i + seed) % 2 ? 1 : -1;
    const bx = x + lean * t, by = base - h * t;
    const ang = (30 + r() * 24) * Math.PI / 180;
    const len = h * (.46 - i * .06) * (.85 + r() * .3);
    const ex = bx + side * Math.sin(ang) * len, ey = by - Math.cos(ang) * len;
    thick += `M${wxF(bx)} ${wxF(by)}L${wxF(ex)} ${wxF(ey)}`;
    for (const s of [.5, .8, 1]) {
      const px = bx + (ex - bx) * s, py = by + (ey - by) * s;
      for (const d of [-1, 1]) {
        const a2 = ang * side + d * (.35 + r() * .3);
        const l2 = len * (.22 + r() * .14);
        thin += `M${wxF(px)} ${wxF(py)}l${wxF(Math.sin(a2) * l2)} ${wxF(-Math.cos(a2) * l2)}`;
      }
    }
    ends.push([ex, ey, len * .45]);
  }
  return { thick, thin, ends };
}
const WX_BARE_MID = [[34, 30, -2], [70, 38, 3], [150, 34, -3], [176, 40, 2], [214, 36, 4], [240, 29, -2], [300, 39, 3], [318, 31, -4], [372, 35, 2]]
  .map(([x, h, lean], i) => wxTree(x, 124, h, lean, 300 + i));
const WX_BARE_NEAR = WX_NEAR.map((t) => wxTree(t.x, 142, 142 - t.top + 4, t.lean * 2, t.seed));
const WX_FRAME = 'M11 2H379A3 3 0 0 1 382 5V150H8V5A3 3 0 0 1 11 2Z'
  + 'M18 12H192.5V73.5H18ZM197.5 12H372V73.5H197.5ZM18 80.5H192.5V142H18ZM197.5 80.5H372V142H197.5Z';
const WX_PANES = 'M18 12H192.5V73.5H18ZM197.5 12H372V73.5H197.5ZM18 80.5H192.5V142H18ZM197.5 80.5H372V142H197.5Z';

/** One lens-shaped basil leaf from its base, pointing at `deg` (0 = up), `len` long. */
function wxLeaf(x, y, deg, len, wid) {
  const a = deg * Math.PI / 180, ux = Math.sin(a), uy = -Math.cos(a), nx = -uy, ny = ux;
  const tx = x + ux * len, ty = y + uy * len;
  const mx = x + ux * len * .45, my = y + uy * len * .45;
  return `M${wxF(x)} ${wxF(y)}Q${wxF(mx + nx * wid)} ${wxF(my + ny * wid)} ${wxF(tx)} ${wxF(ty)}Q${wxF(mx - nx * wid)} ${wxF(my - ny * wid)} ${wxF(x)} ${wxF(y)}Z`;
}
// the basil on the sill: back leaves (darker), front leaves (lighter), stems
const WX_BASIL = (() => {
  const back = [[343, 133, -38, 13, 5.2], [356, 132, 40, 13, 5.2], [349, 124, -12, 12, 5], [341, 121, -55, 11, 4.6]];
  const front = [[351, 134, -6, 11, 4.8], [347, 128, 22, 10, 4.4], [354, 122, 30, 11, 4.6], [345, 116, -20, 9, 4]];
  const stems = 'M350 136Q349 126 347 117M350 136Q352 128 355 121M349 128Q345 124 341 121';
  return { back: back.map((l) => wxLeaf(...l)).join(''), front: front.map((l) => wxLeaf(...l)).join(''), stems };
})();

/** The lit part of the moon: the limb on the lit side plus an elliptical terminator. */
function wxMoonPath(cx, cy, r, phase, southern) {
  const f = Math.cos(2 * Math.PI * phase); // 1 new … −1 full
  let rx = r * Math.abs(f);
  if (f > 0) rx = Math.min(rx, r - 1.3); // a young or old crescent stays a visible sliver
  const right = (phase < .5) !== !!southern; // waxing is lit on the right in the north
  const top = `${wxF(cx)} ${wxF(cy - r)}`, bot = `${wxF(cx)} ${wxF(cy + r)}`;
  const limb = right ? 1 : 0;
  const term = right ? (f > 0 ? 0 : 1) : (f > 0 ? 1 : 0);
  return `M${top}A${r} ${r} 0 0 ${limb} ${bot}A${wxF(rx)} ${r} 0 0 ${term} ${top}Z`;
}

/* ---------- pure: the drawing ---------- */
/** animation-duration + a negative delay from the wall clock (nowSec) so a redraw lands mid-loop.
   period = the visible loop (2 × duration for alternate animations); seed staggers siblings. */
function wxAnim(dur, nowSec, seed = 0, alternate = false) {
  const period = alternate ? dur * 2 : dur;
  const at = (((nowSec / period) + seed) % 1 + 1) % 1;
  return `animation-duration:${wxF(dur)}s;animation-delay:-${wxF(at * period)}s`;
}

/** The scene's cloud shapes: count from cover and condition, drift speed from wind. */
function wxClouds(sc) {
  const kind = sc.cond.kind, cc = sc.cloudCover;
  let n = Math.round(cc / 100 * 7);
  if (kind === 'clear') n = Math.min(n, cc > 15 ? 1 : 0);
  else if (kind === 'partly') n = wxClamp(n, 2, 5);
  else n = wxClamp(n, 5, 7);
  const heavy = kind !== 'clear' && kind !== 'partly';
  const windDur = wxClamp(90 - (sc.windMph - 4) * 3.6, 30, 90); // calm ≈ 90 s across the glass, windy ≈ 30 s
  const out = [];
  for (let i = 0; i < n; i++) {
    const r = wxRand(1000 + i * 7919);
    const w = heavy ? 96 + r() * 70 : 44 + r() * 46;
    const cx = WX_G.x0 + ((i * .618 + .13) % 1) * WX_G.w;
    const cy = heavy ? 18 + ((i * .382 + .21) % 1) * 58 : 22 + ((i * .382 + .21) % 1) * 44;
    const h = heavy ? 9 + r() * 6 : 8 + r() * 4;
    const x0 = cx - w / 2, x1 = cx + w / 2;
    let d = `M${wxF(x0 + h / 2)} ${wxF(cy - h / 2)}H${wxF(x1 - h / 2)}A${wxF(h / 2)} ${wxF(h / 2)} 0 0 1 ${wxF(x1 - h / 2)} ${wxF(cy + h / 2)}H${wxF(x0 + h / 2)}A${wxF(h / 2)} ${wxF(h / 2)} 0 0 1 ${wxF(x0 + h / 2)} ${wxF(cy - h / 2)}Z`;
    const lobes = heavy ? 6 + Math.floor(r() * 3) : 3 + Math.floor(r() * 3);
    for (let j = 0; j < lobes; j++) {
      const lx = x0 + (j + .5) * (w / lobes) + (r() - .5) * 4;
      const lr = (w / lobes) * (heavy ? .42 + r() * .32 : .55 + r() * .35) * (j === 0 || j === lobes - 1 ? .8 : 1.05);
      const ly = cy - lr * .35;
      d += `M${wxF(lx - lr)} ${wxF(ly)}a${wxF(lr)} ${wxF(lr)} 0 1 1 ${wxF(2 * lr)} 0a${wxF(lr)} ${wxF(lr)} 0 1 1 ${wxF(-2 * lr)} 0`;
    }
    const pad = w * .2 + 4;
    out.push({
      d,
      fill: heavy ? wxMix(sc.cloud, wxGrey(sc.cloud, .74), r() * .8) : sc.cloud,
      o: wxF(heavy ? .5 + r() * .32 : .62 + r() * .3),
      from: wxF(WX_G.x0 - (x1 + pad)), // off the left edge …
      to: wxF(WX_G.x1 - (x0 - pad)),   // … to off the right edge
      dur: windDur * (.8 + r() * .45),
      seed: r(),
    });
  }
  return out;
}

/** The whole window as SVG markup (390 × 176). nowSec = wall-clock seconds for the animation phases. */
function windowSvg(sc, nowSec = 0) {
  const S = sc.season, L = sc.light;
  const lit = (c, l = L) => {
    const d = 1 - wxClamp(l, 0, 1);
    return wxMix(wxMix(wxMix(wxMix(c, wxGrey(c), d * .45 + sc.mute), WX_INK, d * .84), sc.tint, sc.tintAmt), WX_PAPER, .07 * (1 - d));
  };
  const kind = sc.cond.kind, I = sc.cond.intensity;
  const o = [];
  const fogC = wxMix(sc.sky[3], '#DADDDC', .5 * L + .1);

  // defs: sky gradient, one soft glow (the sun's, else a dark-sky moon's), the glass clip, fog band
  const moonGlow = !sc.sun && sc.moon && sc.moon.dark && sc.moon.alpha > .05;
  o.push('<defs>',
    `<linearGradient id="wx-sky" x1="0" y1="12" x2="0" y2="94" gradientUnits="userSpaceOnUse">${sc.sky.map((c, i) => `<stop offset="${[0, .4, .74, 1][i]}" stop-color="${c}"/>`).join('')}</linearGradient>`,
    sc.sun ? `<radialGradient id="wx-glow"><stop offset="0" stop-color="${sc.sun.glow}" stop-opacity="${wxF((sc.sunP < .12 || sc.sunP > .88 ? .75 : .55) * sc.sun.alpha + .12)}"/><stop offset="1" stop-color="${sc.sun.glow}" stop-opacity="0"/></radialGradient>`
      : moonGlow ? `<radialGradient id="wx-glow"><stop offset="0" stop-color="#E4E8FF" stop-opacity="${wxF(.1 + .3 * sc.moon.illum * sc.moon.alpha)}"/><stop offset="1" stop-color="#E4E8FF" stop-opacity="0"/></radialGradient>` : '',
    '<clipPath id="wx-glass"><rect x="18" y="12" width="354" height="130"/></clipPath>',
    kind === 'fog' ? `<linearGradient id="wx-fog" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${fogC}" stop-opacity="0"/><stop offset=".5" stop-color="${fogC}" stop-opacity=".88"/><stop offset="1" stop-color="${fogC}" stop-opacity="0"/></linearGradient>` : '',
    '</defs>');

  o.push('<g clip-path="url(#wx-glass)">');
  // 1 · sky
  o.push('<rect x="18" y="12" width="354" height="130" fill="url(#wx-sky)"/>');
  // 2 · stars, sun, moon
  if (sc.stars > .03) {
    WX_STARS.forEach((grp, gi) => {
      const a = wxF(sc.stars * [.95, .78, .62][gi]);
      o.push(`<path class="wx-tw" d="${grp.map(([x, y]) => `M${x} ${y}h0`).join('')}" stroke="#FFF7E2" stroke-width="${[1, 1.4, 1.9][gi]}" stroke-linecap="round" opacity="${a}" style="--o1:${a};--o2:${wxF(a * .3)};${wxAnim([5.5, 7.5, 4.3][gi], nowSec, gi * .37, true)}"/>`);
    });
  }
  if (sc.sun) {
    const { x, y } = sc.sun;
    const low = sc.sunP < .12 || sc.sunP > .88;
    o.push(`<circle cx="${wxF(x)}" cy="${wxF(y)}" r="${low ? 54 : 32}" fill="url(#wx-glow)"/>`);
    if (sc.sun.alpha > .05) o.push(`<circle cx="${wxF(x)}" cy="${wxF(y)}" r="8.5" fill="${sc.sun.disc}" opacity="${wxF(sc.sun.alpha)}"/>`);
  }
  if (sc.moon && sc.moon.alpha > .05) {
    const { x, y, alpha, phase, dark } = sc.moon;
    if (dark) {
      if (moonGlow) o.push(`<circle cx="${wxF(x)}" cy="${wxF(y)}" r="${wxF(18 + 10 * sc.moon.illum)}" fill="url(#wx-glow)"/>`);
      o.push(`<circle cx="${wxF(x)}" cy="${wxF(y)}" r="8" fill="${wxMix(sc.sky[1], '#FFFFFF', .1)}" opacity="${wxF(alpha * .9)}"/>`);
    }
    o.push(`<path d="${wxMoonPath(x, y, 8, phase, sc.southern)}" fill="#F4EFDD" opacity="${wxF(alpha)}"/>`);
  }
  // 3 · clouds, drifting left to right
  for (const c of wxClouds(sc)) {
    o.push(`<path class="wx-drift" d="${c.d}" fill="${c.fill}" opacity="${c.o}" style="--a:${c.from}px;--b:${c.to}px;${wxAnim(c.dur, nowSec, c.seed)}"/>`);
  }
  if (kind === 'storm') {
    o.push(`<path class="wx-bolt" d="M252 40l-6 17h6l-9 19 4 1-6 17" fill="none" stroke="#FFF6D6" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round" opacity="0"/>`);
  }
  // 4 · the back woods, far → near
  const haze = L < .5 ? .32 : .48; // far ridge melts into the horizon colour; less so in the dark
  o.push(`<path d="M10 142V97C50 90 80 93 118 91C160 89 185 84 222 90C262 96 300 87 336 90C356 92 370 95 380 94V142Z" fill="${lit(wxMix(S.far, sc.sky[3], haze), L + .1)}"/>`);
  const leafy = S.leaf > 0;
  o.push(`<path d="M10 ${leafy ? 110 : 118}Q60 104 110 110T210 109T310 110T390 108V142H10Z" fill="${lit(wxMix(leafy ? S.canopy[0] : S.haze, '#000000', .28))}"/>`);
  if (!leafy || S.leaf < 1) {
    // bare (winter) or thinning (November): twig haze, then trunks + limbs, then twigs
    const branch = lit(S.branch);
    if (!leafy) o.push(`<path d="${WX_BARE_MID.map((t) => t.ends.map(([x, y, r]) => wxCircle(x, y, r)).join('')).join('')}" fill="${lit(S.haze)}" opacity=".42"/>`);
    o.push(`<path d="${WX_BARE_MID.map((t) => t.thick).join('')}" fill="none" stroke="${branch}" stroke-width="1.5" stroke-linecap="round"/>`);
    o.push(`<path d="${WX_BARE_MID.map((t) => t.thin).join('')}" fill="none" stroke="${branch}" stroke-width=".7" stroke-linecap="round" opacity=".85"/>`);
  }
  if (leafy) {
    const keep = WX_MID.filter((b) => b.rank < S.leaf);
    S.canopy.forEach((col, ci) => {
      const d = keep.filter((b) => Math.floor(b.k * S.canopy.length) === ci)
        .map((b) => b.lobes.map(([x, y, rr]) => wxCircle(x, y, rr * (S.leaf < 1 ? .85 : 1))).join('')).join('');
      if (d) o.push(`<path d="${d}" fill="${lit(col)}"/>`);
    });
    if (S.blossom) {
      o.push(`<path d="${keep.filter((b, i) => i % 3 === 0).map(({ lobes: [[x, y, R]] }) => `M${wxF(x - R * .3)} ${wxF(y - R * .45)}h0M${wxF(x + R * .35)} ${wxF(y - R * .1)}h0M${wxF(x - R * .7)} ${wxF(y + R * .2)}h0`).join('')}" stroke="${lit(S.blossom)}" stroke-width="2.4" stroke-linecap="round"/>`);
    }
  }
  const conifers = WX_CONIFERS.map(([cx, base, h, w]) => {
    const t = base - h;
    return `M${cx} ${t}L${wxF(cx + w * .28)} ${wxF(t + h * .3)}L${wxF(cx + w * .16)} ${wxF(t + h * .3)}L${wxF(cx + w * .42)} ${wxF(t + h * .62)}L${wxF(cx + w * .24)} ${wxF(t + h * .62)}L${wxF(cx + w * .5)} ${base}L${wxF(cx - w * .5)} ${base}L${wxF(cx - w * .24)} ${wxF(t + h * .62)}L${wxF(cx - w * .42)} ${wxF(t + h * .62)}L${wxF(cx - w * .16)} ${wxF(t + h * .3)}L${wxF(cx - w * .28)} ${wxF(t + h * .3)}Z`;
  }).join('');
  const conC = lit(S.conifer);
  o.push(`<path d="${conifers}" fill="${conC}" stroke="${conC}" stroke-width="1.4" stroke-linejoin="round"/>`);
  // fog: a translucent band over the mid layer, in front of it and behind the near trees
  if (kind === 'fog') {
    o.push(`<rect class="wx-mist" x="-6" y="80" width="402" height="46" fill="url(#wx-fog)" style="${wxAnim(38, nowSec, .2, true)}"/>`);
    o.push(`<rect class="wx-mist" x="-6" y="98" width="402" height="36" fill="url(#wx-fog)" opacity=".7" style="${wxAnim(53, nowSec, .65, true)}"/>`);
  }
  // near trees at the edges: trunks, then crowns (or bare limbs)
  const nearL = L * .88;
  o.push(`<path d="${WX_NEAR.map((t) => `M${t.x - t.w / 2} 142L${t.x - t.w * .3 + t.lean} ${t.top + 30}H${t.x + t.w * .3 + t.lean}L${t.x + t.w / 2} 142Z`).join('')}" fill="${lit(S.trunk, nearL)}"/>`);
  if (!leafy || S.leaf < 1) {
    const branch = lit(S.branch, nearL);
    o.push(`<path d="${WX_BARE_NEAR.map((t) => t.thick).join('')}" fill="none" stroke="${branch}" stroke-width="${leafy ? 2 : 2.6}" stroke-linecap="round"/>`);
    o.push(`<path d="${WX_BARE_NEAR.map((t) => t.thin).join('')}" fill="none" stroke="${branch}" stroke-width="1" stroke-linecap="round"/>`);
  }
  [0, 1].forEach((tone) => {
    const crowns = leafy ? WX_NEAR_LOBES.flatMap((t) => t.filter((c) => c.tone === tone && (S.leaf >= 1 || c.i % 2 === 0))) : [];
    const d = crowns.map((c) => c.lobes.map(([x, y, r]) => wxCircle(x, y, r * (S.leaf < 1 ? .8 : 1))).join('')).join('');
    if (d) o.push(`<path d="${d}" fill="${lit(S.near[tone], nearL * (tone ? 1.06 : 1))}"/>`);
  });
  // ground strip; snow-covered under snow
  const ground = kind === 'snow' ? lit('#EEF2F6', Math.max(L, .3)) : lit(S.ground, nearL);
  o.push(`<path d="M10 138C80 134 150 139 220 136S330 138 380 135V142H10Z" fill="${ground}"/>`);

  // 5 · weather
  if (kind === 'rain' || kind === 'drizzle' || kind === 'storm') {
    const drizzle = kind === 'drizzle';
    const layers = drizzle ? 2 : 3;
    const total = drizzle ? 12 : Math.round(16 + I * 14);
    const slant = .14 + wxClamp(sc.windMph, 0, 25) * .007;
    const dx = WX_G.h * slant;
    const col = wxMix(sc.sky[2], '#FFFFFF', .5);
    for (let li = 0; li < layers; li++) {
      const r = wxRand(500 + li);
      const len = drizzle ? 4 + li * 1.5 : 8 + li * 2.5;
      let d = '';
      for (let i = 0; i < Math.round(total / layers); i++) {
        const x = WX_G.x0 - dx + r() * (WX_G.w + dx), y = WX_G.y0 + r() * WX_G.h;
        for (const c of [0, 1]) d += `M${wxF(x - c * dx)} ${wxF(y - c * WX_G.h)}l${wxF(len * slant)} ${len}`;
      }
      o.push(`<path class="wx-fall" d="${d}" stroke="${col}" stroke-width="${wxF(.7 + li * .25)}" stroke-linecap="round" opacity="${wxF((drizzle ? .3 : .4) + li * .08)}" style="--dx:${wxF(dx)}px;--dy:${WX_G.h}px;${wxAnim((drizzle ? 2.3 : 1.35) - li * .22, nowSec, li * .31)}"/>`);
    }
  }
  if (kind === 'snow') {
    const col = lit('#FFFFFF', Math.max(L, .45));
    for (let li = 0; li < 3; li++) {
      const r = wxRand(700 + li);
      let d = '';
      for (let i = 0; i < Math.round((20 + I * 16) / 3); i++) {
        const x = WX_G.x0 + r() * WX_G.w, y = WX_G.y0 + r() * WX_G.h;
        d += `M${wxF(x)} ${wxF(y)}h0M${wxF(x)} ${wxF(y - WX_G.h)}h0`;
      }
      o.push(`<g class="wx-fall" style="--dx:0px;--dy:${WX_G.h}px;${wxAnim([16, 12, 9][li], nowSec, li * .29)}"><path class="wx-sway" d="${d}" stroke="${col}" stroke-width="${[2.2, 2.9, 3.7][li]}" stroke-linecap="round" opacity="${[.7, .82, .92][li]}" style="${wxAnim([3.8, 3.1, 2.6][li], nowSec, li * .41, true)}"/></g>`);
    }
  }
  if (kind === 'storm') o.push('<rect class="wx-flash" x="18" y="12" width="354" height="130" fill="#F2F0FF" opacity="0"/>');
  // 6 · the glass: a diagonal highlight, and droplets clinging while it rains
  const night = sc.phase === 'night' || sc.phase === 'dusk';
  o.push(`<path d="M62 12H92L63 73.5H33ZM104 12H112L83 73.5H75Z" fill="#FFFFFF" opacity="${night ? .07 : .09}"/>`);
  if (kind === 'rain' || kind === 'drizzle' || kind === 'storm') {
    const n = kind === 'drizzle' ? 8 : Math.round(10 + I * 6);
    o.push(`<path d="${WX_DROPS.slice(0, n).map(([x, y, r]) => wxCircle(x, y, r)).join('')}" fill="#FFFFFF" fill-opacity=".2" stroke="#FFFFFF" stroke-opacity=".38" stroke-width=".5"/>`);
  }
  o.push('</g>');

  // 7 · the frame (theme tokens via CSS classes), two-over-two panes, the sill, the basil
  o.push(`<path class="wf-inset" d="${WX_PANES}"/>`);
  o.push(`<path class="wf-frame" d="${WX_FRAME}" fill-rule="evenodd"/>`);
  o.push('<path class="wf-sill" d="M6 150H384L390 157H0Z"/>');
  o.push('<path class="wf-sill-front" d="M0 157H390V163A2 2 0 0 1 388 165H2A2 2 0 0 1 0 163Z"/>');
  o.push('<path class="wf-sill-shadow" d="M3 165H387L383 169H7Z"/>');
  o.push(`<path class="wf-stem" d="${WX_BASIL.stems}"/>`);
  o.push(`<path class="wf-basil" d="${WX_BASIL.back}"/>`);
  o.push(`<path class="wf-basil-2" d="${WX_BASIL.front}"/>`);
  o.push('<path class="wf-pot" d="M339 139H361L358.5 155H341.5Z"/>');
  o.push('<path class="wf-pot-shade" d="M339.4 139H360.6L360.2 142H339.8Z"/>');
  o.push('<rect class="wf-pot-rim" x="336.5" y="134" width="27" height="5.5" rx="1.6"/>');
  return `<svg viewBox="0 0 390 176" xmlns="http://www.w3.org/2000/svg" aria-hidden="true" focusable="false">${o.join('')}</svg>`;
}

/** Words for the caption and the aria-label. wx = /api/weather payload; sc = windowScene(). */
function windowCaption(wx, sc, nowMs) {
  const phaseWord = sc.phase === 'day' ? (sc.minute < 720 ? 'late morning' : sc.minute < 840 ? 'midday' : 'afternoon')
    : { night: 'night', dawn: 'dawn', sunrise: 'sunrise', morning: 'morning', golden: 'late afternoon', sunset: 'sunset', dusk: 'evening' }[sc.phase];
  const place = wx && wx.location ? wx.location.name : '';
  if (sc.forced) {
    return { unset: false, left: `Scene preview · ${sc.cond.label}`, right: phaseWord,
      aria: `Kitchen window (preview): ${sc.cond.label}, ${phaseWord}` };
  }
  if (!wx || !wx.configured) {
    return { unset: true, left: 'Set your location to see the weather →', right: '',
      aria: `Kitchen window: ${phaseWord}. Set a location in Settings to see the weather.` };
  }
  if (wx.unavailable || !wx.current) {
    return { unset: false, left: `Weather unavailable${place ? ` · ${place}` : ''}`, right: '',
      aria: `Kitchen window: ${phaseWord}; the weather is unavailable right now` };
  }
  const t = Math.round(wx.current.temp);
  const sunIsUp = sc.minute >= sc.sr && sc.minute < sc.ss; // sunrise before dawn and after sunset
  const right = sunIsUp ? `sunset ${wxClock(sc.ss)}` : `sunrise ${wxClock(sc.sr)}`;
  const ageMs = nowMs - Number(wx.fetchedAt || nowMs);
  // over an hour old (Open-Meteo failing, or this phone offline): the time it's from replaces the place
  const tail = ageMs > 3600e3 ? `as of ${wxClock(wxMinutes(new Date(wx.fetchedAt)))}` : place;
  return {
    unset: false,
    left: [`${t}°`, sc.cond.label, tail].filter(Boolean).join(' · '),
    right,
    aria: `Kitchen window: ${sc.cond.label}, ${t} degrees, ${phaseWord}${place ? `, ${place}` : ''}`,
  };
}

/* ---------- DOM: render, refresh, timers ---------- */
const WX_SHOW_KEY = 'mealapp-window'; // per-device "Show the window" ('0' = off; default on)
let wxData = null;        // last /api/weather payload
let wxFetchedAt = 0;      // when this device last got one
let wxFailed = false;     // the last fetch failed and there is nothing to show
let wxInflight = null;
let wxTick = null;        // minute: recompute the phase
let wxPoll = null;        // 15 min: refetch the weather
let wxLastSig = '';
let wxHookedWs = null;
let wxForced = null;      // ?scene= preview (parseScene)

function windowEnabled() { try { return localStorage.getItem(WX_SHOW_KEY) !== '0'; } catch { return true; } }
function setWindowEnabled(on) {
  try { if (on) localStorage.removeItem(WX_SHOW_KEY); else localStorage.setItem(WX_SHOW_KEY, '0'); } catch { /* storage blocked */ }
  renderWindow();
}
const windowShown = () => typeof tab !== 'undefined' && tab === 'week' && windowEnabled();

/** Show/hide with the tab (called from showTab) and draw. The timers run only while the window
   shows on a visible page; a page booted in the background still draws (and fetches) once. */
function renderWindow() {
  const el = document.getElementById('window');
  if (!el) return;
  const show = windowShown();
  el.hidden = !show;
  if (!show) { wxStop(); return; }
  wxPaint();
  if (document.visibilityState !== 'hidden') wxStart();
  setTimeout(wxHookWs, 0); // boot calls showTab before connectWS
  if (Date.now() - wxFetchedAt > 60_000) void refreshWeather();
}

function wxPaint() {
  const el = document.getElementById('window');
  if (!el || el.hidden) return;
  if (!el.querySelector('.window-scene')) {
    el.innerHTML = '<div class="window-scene" role="img"></div>'
      + '<button class="window-cap" type="button"><span class="wc-l"></span><span class="wc-r"></span></button>';
    el.querySelector('.window-cap').onclick = () => { if (typeof openSettingsAt === 'function') openSettingsAt('set-window'); };
  }
  const now = new Date();
  const wx = wxData && wxData.configured ? wxData : null;
  const sc = windowScene({ now, wx, forced: wxForced });
  const sig = windowSvg(sc, 0);
  if (sig !== wxLastSig) {
    el.querySelector('.window-scene').innerHTML = windowSvg(sc, now.getTime() / 1000);
    wxLastSig = sig;
  }
  const cap = wxData === null && !wxForced
    ? { unset: false, left: wxFailed ? 'Weather unavailable right now' : '', right: '', aria: 'Kitchen window' }
    : windowCaption(wxData, sc, now.getTime());
  el.querySelector('.window-scene').setAttribute('aria-label', cap.aria);
  const btn = el.querySelector('.window-cap');
  btn.classList.toggle('unset', cap.unset);
  btn.setAttribute('aria-label', `${cap.left.replace(/\s*→$/, '')}${cap.right ? `, ${cap.right}` : ''} (Kitchen window settings)`);
  const l = btn.querySelector('.wc-l'), r = btn.querySelector('.wc-r');
  // the temperature leads in bold: "61° · light rain · Millbrook"
  const m = /^(-?\d+°)( · .*)$/.exec(cap.left);
  l.innerHTML = m ? `<b>${esc(m[1])}</b>${esc(m[2])}` : esc(cap.left);
  r.textContent = cap.right;
}

/** GET /api/weather (served from the server's 10-minute cache). force skips the one-a-minute throttle. */
function refreshWeather(force) {
  if (wxInflight) return wxInflight;
  if (!force && Date.now() - wxFetchedAt < 60_000) return Promise.resolve();
  wxInflight = (async () => {
    try {
      const r = await fetch('/api/weather');
      if (!r.ok) throw new Error(String(r.status));
      wxData = await r.json();
      wxFetchedAt = Date.now();
      wxFailed = false;
    } catch {
      wxFailed = true; // keep the last good payload, if any
    } finally {
      wxInflight = null;
    }
    wxPaint();
  })();
  return wxInflight;
}

function wxStart() {
  if (!wxTick) wxTick = setInterval(() => { wxHookWs(); wxPaint(); }, 60_000);
  if (!wxPoll) wxPoll = setInterval(() => { void refreshWeather(true); }, 15 * 60_000);
}
function wxStop() {
  clearInterval(wxTick);
  clearInterval(wxPoll);
  wxTick = wxPoll = null;
}

// settings-updated (a place or unit changed on any device) → refetch. 00-core.js
// owns the socket and may replace it on reconnect, so listen on whichever is current.
function wxHookWs() {
  if (typeof ws === 'undefined' || !ws || ws === wxHookedWs) return;
  const sock = ws;
  wxHookedWs = sock;
  sock.addEventListener('message', (e) => {
    let m = null;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m && m.type === 'settings-updated' && windowShown()) void refreshWeather(true);
  });
  sock.addEventListener('close', () => {
    // follow the replacement socket within a minute (00-core.js reconnects with backoff)
    let tries = 0;
    const t = setInterval(() => { tries++; wxHookWs(); if (wxHookedWs !== sock || tries > 30) clearInterval(t); }, 2000);
  });
}

if (typeof document !== 'undefined') {
  // ?scene=rain-night (any condition-phase, optional month: snow-day-jan) previews a scene;
  // honoured once and stripped like ?tab=. 00-core.js already strips the whole query when
  // ?tab= rides along, so fall back to the URL this page was loaded with.
  try {
    const qs = new URLSearchParams(location.search);
    let raw = qs.get('scene');
    if (raw === null) {
      const nav = performance.getEntriesByType && performance.getEntriesByType('navigation')[0];
      if (nav && nav.name) raw = new URL(nav.name).searchParams.get('scene');
    }
    wxForced = parseScene(raw);
    if (qs.has('scene')) {
      qs.delete('scene');
      const rest = qs.toString();
      history.replaceState(null, '', location.pathname + (rest ? `?${rest}` : '') + location.hash);
    }
  } catch { /* no preview */ }

  // Hidden page: pause the animations (html.wx-paused) and the timers; back: redraw + refetch.
  document.documentElement.classList.toggle('wx-paused', document.visibilityState === 'hidden');
  document.addEventListener('visibilitychange', () => {
    const hidden = document.visibilityState === 'hidden';
    document.documentElement.classList.toggle('wx-paused', hidden);
    if (hidden) { wxStop(); return; }
    wxHookWs();
    if (windowShown()) { wxPaint(); wxStart(); void refreshWeather(); }
  });
}
