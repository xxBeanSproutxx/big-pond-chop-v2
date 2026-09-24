'use strict';
// Stage 4A wind ingest: 15-minute time base + t_eff persistence + grid-bearing mapping.
// Open-Meteo hourly (fallback) + minutely_15 (native), one lake-wide point, mph,
// America/Chicago, past_days=1, forecast_days=2.

const DEFAULT_POINT = { lat: 46.22, lon: -93.657 };
// Stage 6A: fixed shore sample (South Harbor Township / Isle MN, on land).
const SHORE_POINT = { lat: 46.13, lon: -93.57 };

const API = 'https://api.open-meteo.com/v1/forecast';
const HOURLY = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const MINUTELY = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m';
const STEP_H = 0.25;
const D2R = Math.PI / 180;

// bearing_grid = ((dir_true - gamma) % 360 + 360) % 360, gamma from meta.v1.json.
function gammaToGrid(dirTrueDeg, gammaDeg) {
  return ((dirTrueDeg - gammaDeg) % 360 + 360) % 360;
}

// Smallest absolute angular difference in degrees, wrap-aware.
function bearingDelta(a, b) {
  const d = Math.abs(a - b) % 360;
  return d > 180 ? 360 - d : d;
}

// Shortest-arc linear interpolation in true bearing space (350 -> 10 passes 0).
function lerpAngle(a, b, f) {
  const d = ((b - a + 540) % 360) - 180;
  return ((a + f * d) % 360 + 360) % 360;
}

// t_eff persistence pass, hours. dtH is the step in hours (1 = hourly, 0.25 = 15 min).
// The +1.0 accumulation is per step; the 0.5 reset and 4 mph floor are NOT scaled.
function computeTeff(series, dtH = 1) {
  const out = new Array(series.length);
  for (let i = 0; i < series.length; i++) {
    const s = series[i];
    if (s.speedMph < 4) { out[i] = 0; continue; }        // case 3 (speed wins)
    if (i === 0) { out[i] = 0.5; continue; }              // no predecessor
    const d = bearingDelta(s.bearingGrid, series[i - 1].bearingGrid);
    out[i] = d > 30 ? 0.5 : Math.min(6.0, out[i - 1] + dtH); // case 2 / case 1
  }
  return out;
}

// End-of-yesterday state, from the last up-to-6 hourly entries, so today's first
// frame can inherit persistence across midnight. Pure; the shipped ingest path
// computes t_eff over the whole multi-day series, so it does not need this seed.
function seedTeff(hourlyTail, opts = {}) {
  const dtH = opts.dtH != null ? opts.dtH : 1;
  const tail = (hourlyTail || []).slice(-6);
  if (!tail.length) return { tEffH: 0, bearingGrid: 0 };
  const teff = computeTeff(tail, dtH);
  const last = tail[tail.length - 1];
  return { tEffH: teff[teff.length - 1], bearingGrid: last.bearingGrid };
}

// Single construction path for a series: raw arrays -> tagged entries with t_eff.
function buildSeriesFrom(times, speeds, dirs, gusts, gammaDeg, dtH = 1) {
  const raw = [];
  for (let i = 0; i < times.length; i++) {
    const dirTrue = Number(dirs[i]);
    raw.push({
      time: times[i],
      speedMph: Number(speeds[i]),
      gustMph: Number(gusts[i]),
      dirTrueDeg: dirTrue,
      bearingGrid: gammaToGrid(dirTrue, gammaDeg),
    });
  }
  const teff = computeTeff(raw, dtH);
  for (let i = 0; i < raw.length; i++) raw[i].tEffH = teff[i];
  return raw;
}

function buildSeries(hourly, gammaDeg) {
  return buildSeriesFrom(
    hourly.time || [], hourly.wind_speed_10m || [],
    hourly.wind_direction_10m || [], hourly.wind_gusts_10m || [], gammaDeg, 1,
  );
}

// Expand a source series 4x to 15-min resolution. Linear for speed/gust,
// shortest-arc for direction (true bearing space). gammaDeg is applied by the
// caller (buildSeriesFrom); it is accepted here to keep the spec signature.
function addMin(iso, min) {
  const ms = Date.parse(iso.length <= 16 ? `${iso}:00Z` : `${iso}Z`);
  return new Date(ms + min * 60000).toISOString().slice(0, 16);
}

function interpolate15(fields, gammaDeg) {
  const times = (fields && fields.time) || [];
  const sp = (fields && fields.wind_speed_10m) || [];
  const dr = (fields && fields.wind_direction_10m) || [];
  const gu = (fields && fields.wind_gusts_10m) || [];
  const out = { times: [], speeds: [], dirs: [], gusts: [] };
  for (let i = 0; i < times.length - 1; i++) {
    const sa = Number(sp[i]), sb = Number(sp[i + 1]);
    const ga = Number(gu[i]), gb = Number(gu[i + 1]);
    const da = Number(dr[i]), db = Number(dr[i + 1]);
    for (let k = 0; k < 4; k++) {
      const f = k / 4;
      out.times.push(addMin(times[i], k * 15));
      out.speeds.push(sa + f * (sb - sa));
      out.gusts.push(ga + f * (gb - ga));
      out.dirs.push(lerpAngle(da, db, f));
    }
  }
  if (times.length) {
    const n = times.length - 1;
    out.times.push(times[n]);
    out.speeds.push(Number(sp[n]));
    out.gusts.push(Number(gu[n]));
    out.dirs.push(Number(dr[n]));
  }
  return out;
}

// Hourly model samples -> 15-min frames for days 3-7 via Cartesian vector
// interpolation. theta = dirTrueDeg is the direction the wind comes FROM, so the
// "toward" unit vector is (-sin, -cos): decompose, lerp the u/v components, then
// rebuild speed/direction. This is what makes 350 -> 10 pass through 0 (a 20 mph
// wind stays ~19.7 mph) instead of sweeping the long way through South.
// Gust speed carries no direction from the API, so it is blended linearly exactly
// like interpolate15. The final hourly sample has no successor; its trailing
// 15-min slots hold the sample, matching the API's own minutely_15 tail and
// keeping every local day exactly 96 frames. f = 0 is the source sample bit-for-bit.
function expandHourlyVector(hourlyEntries, gammaDeg) {
  const list = hourlyEntries || [];
  const times = [], speeds = [], dirs = [], gusts = [];
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    const b = i + 1 < list.length ? list[i + 1] : a; // last sample holds
    const sa = Number(a.speedMph), da = Number(a.dirTrueDeg), ga = Number(a.gustMph);
    const sb = Number(b.speedMph), db = Number(b.dirTrueDeg), gb = Number(b.gustMph);
    const ua = -sa * Math.sin(da * D2R), va = -sa * Math.cos(da * D2R);
    const ub = -sb * Math.sin(db * D2R), vb = -sb * Math.cos(db * D2R);
    for (let k = 0; k < 4; k++) {
      const f = k / 4;
      times.push(addMin(a.time, k * 15));
      if (k === 0) { // exact hour anchor
        speeds.push(sa); dirs.push(da); gusts.push(ga);
        continue;
      }
      const uf = (1 - f) * ua + f * ub;
      const vf = (1 - f) * va + f * vb;
      speeds.push(Math.hypot(uf, vf));
      dirs.push((Math.atan2(-uf, -vf) * 180 / Math.PI + 360) % 360);
      gusts.push(ga + f * (gb - ga));
    }
  }
  return buildSeriesFrom(times, speeds, dirs, gusts, gammaDeg, STEP_H);
}

// Raw Open-Meteo hourly arrays -> entry-shaped samples for expandHourlyVector.
function hourlySamples(hourly) {
  const t = (hourly && hourly.time) || [];
  const sp = (hourly && hourly.wind_speed_10m) || [];
  const dr = (hourly && hourly.wind_direction_10m) || [];
  const gu = (hourly && hourly.wind_gusts_10m) || [];
  const out = [];
  for (let i = 0; i < t.length; i++) {
    out.push({ time: t[i], speedMph: Number(sp[i]), gustMph: Number(gu[i]), dirTrueDeg: Number(dr[i]) });
  }
  return out;
}

function chicagoNow(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', year: 'numeric', month: '2-digit',
    day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const p = {};
  for (const part of fmt.formatToParts(now || new Date())) p[part.type] = part.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    hour: parseInt(p.hour, 10) % 24,
    minute: parseInt(p.minute, 10),
  };
}

// The entries of a local date, each tagged with its absolute series index.
function selectDay(series, dateStr) {
  const day = [];
  for (let i = 0; i < series.length; i++) {
    if (series[i].time.slice(0, 10) === dateStr) day.push({ ...series[i], seriesIndex: i });
  }
  return day;
}

// Stage 5D: the head run of entries sharing the first entry's local date. Lets the
// 7d->24h narrow slice the in-memory series with zero refetch. Empty in -> empty out.
function firstDaySlice(entries) {
  const list = entries || [];
  if (!list.length) return [];
  const date = list[0].time.slice(0, 10);
  let k = 1;
  while (k < list.length && list[k].time.slice(0, 10) === date) k++;
  return list.slice(0, k);
}

// Calendar-day arithmetic on a 'YYYY-MM-DD' (America/Chicago local) date string.
function addDays(dateStr, n) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

// Entries whose local date lies in [startDateStr, startDateStr + days).
function selectRange(series, startDateStr, days) {
  const end = addDays(startDateStr, days);
  return series.filter((e) => e.time.slice(0, 10) >= startDateStr && e.time.slice(0, 10) < end);
}

// Index (within `day`) of the current 15-min bucket (17:12 -> 17:00, 17:52 -> 17:45).
function currentIndex(day, now) {
  const { hour, minute } = chicagoNow(now);
  const target = `${String(hour).padStart(2, '0')}:${String(Math.floor(minute / 15) * 15).padStart(2, '0')}`;
  for (let i = 0; i < day.length; i++) {
    if (day[i].time.slice(11, 16) === target) return i;
  }
  return 0;
}

// horizon '24h' (default) requests the current 2-day window; '7d' extends it.
function buildUrl(lat, lon, horizon) {
  const days = horizon === '7d' ? 7 : 2;
  return `${API}?latitude=${lat}&longitude=${lon}&hourly=${HOURLY}` +
    `&minutely_15=${MINUTELY}` +
    `&wind_speed_unit=mph&timezone=America%2FChicago&past_days=1&forecast_days=${days}`;
}

// Stage 6A dual-location variant: comma-joined coords, one request, forecast_days last.
function buildDualUrl(lake, shore, horizon) {
  const days = horizon === '7d' ? 7 : 2;
  return `${API}?latitude=${lake.lat},${shore.lat}&longitude=${lake.lon},${shore.lon}` +
    `&hourly=${HOURLY}` +
    `&minutely_15=${MINUTELY}` +
    `&wind_speed_unit=mph&timezone=America%2FChicago&past_days=1&forecast_days=${days}`;
}

async function fetchWind(lat, lon, horizon) {
  const res = await fetch(buildUrl(lat, lon, horizon), { cache: 'no-store' });
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  return res.json();
}

async function fetchWindTwo(lake, shore, horizon) {
  const res = await fetch(buildDualUrl(lake, shore, horizon), { cache: 'no-store' });
  if (!res.ok) throw new Error(`open-meteo HTTP ${res.status}`);
  return res.json();
}

// Stage 6A: the live dual response is an ARRAY of 2 location objects. Index 0 has
// no location_id and index 1 does, so key by position, never by location_id.
function parseTwoLocations(json) {
  if (!Array.isArray(json) || json.length < 2) return { lake: null, shore: null };
  return { lake: json[0], shore: json[1] };
}

// A location object is usable only if its active source carries real wind speeds.
function hasWindSpeed(json) {
  const m = json && json.minutely_15;
  const h = json && json.hourly;
  const src = m && m.time && m.time.length > 1 ? m : h;
  const sp = src && src.wind_speed_10m;
  return Array.isArray(sp) && sp.some((v) => v != null && Number.isFinite(Number(v)));
}

// ?lat=&lon= override, else the lake-wide default point.
function pointFromQuery(search) {
  const q = new URLSearchParams(search || '');
  const lat = parseFloat(q.get('lat'));
  const lon = parseFloat(q.get('lon'));
  return {
    lat: Number.isFinite(lat) ? lat : DEFAULT_POINT.lat,
    lon: Number.isFinite(lon) ? lon : DEFAULT_POINT.lon,
  };
}

// One raw location object -> 15-min series for the 24h window (native minutely_15
// when present, else hourly expanded 4x). Single path shared by lake and shore.
function seriesFor24(json, gamma) {
  const m = json && json.minutely_15;
  const hourly = (json && json.hourly) || {};
  if (m && m.time && m.time.length > 1) {
    return buildSeriesFrom(m.time, m.wind_speed_10m || [], m.wind_direction_10m || [],
      m.wind_gusts_10m || [], gamma, STEP_H);
  }
  const f = interpolate15(hourly, gamma);
  return buildSeriesFrom(f.times, f.speeds, f.dirs, f.gusts, gamma, STEP_H);
}

// One raw location object -> 7-day assembled series. Trust native minutely_15
// through tomorrow (the past_days=1 seed is kept so t_eff crosses midnight);
// beyond 48 h we own the interpolation. Single path shared by lake and shore.
function seriesFor7d(json, gamma, today) {
  const m = json && json.minutely_15;
  const hourly = (json && json.hourly) || {};
  const native = m && m.time && m.time.length > 1
    ? buildSeriesFrom(m.time, m.wind_speed_10m || [], m.wind_direction_10m || [],
        m.wind_gusts_10m || [], gamma, STEP_H)
    : (() => {
        const f = interpolate15(hourly, gamma);
        return buildSeriesFrom(f.times, f.speeds, f.dirs, f.gusts, gamma, STEP_H);
      })();
  const through = addDays(today, 1);
  const from = addDays(today, 2);
  const kept = native.filter((e) => e.time.slice(0, 10) <= through);
  const expanded = expandHourlyVector(
    hourlySamples(hourly).filter((e) => e.time.slice(0, 10) >= from), gamma);
  const series = kept.concat(expanded);
  const teff = computeTeff(series, STEP_H); // one pass over the whole series
  for (let i = 0; i < series.length; i++) series[i].tEffH = teff[i];
  return series;
}

// Full ingest: fetch + parse + gamma + t_eff. Prefers native minutely_15; falls
// back to hourly expanded 4x. horizon '24h' (default) is the single-day window;
// '7d' assembles native minutely_15 through tomorrow (plus the past_days=1 seed)
// with vector-blended hourly frames for days 3-7, then slices 7 local days.
// Stage 6A: one batched request returns [lake, shore]; shoreDay is built through
// the same series path and is null whenever the shore payload is unusable.
async function ingest(opts = {}) {
  const point = opts.point || DEFAULT_POINT;
  const gamma = opts.gamma != null ? opts.gamma : 0;
  const horizon = opts.horizon === '7d' ? '7d' : '24h';
  const now = opts.now || new Date();
  const today = chicagoNow(now).date;

  let payload;
  if (opts.json != null) {
    payload = opts.json;
  } else {
    try {
      payload = await fetchWindTwo(point, SHORE_POINT, horizon);
    } catch (e) {
      console.warn(`wind fetch failed: ${e.message}`);
      throw e;
    }
  }
  const { lake, shore } = parseTwoLocations(payload);
  const json = lake || payload; // legacy/single object stays the lake, as before
  const shoreOk = shore && hasWindSpeed(shore);

  if (horizon === '7d') {
    const series = seriesFor7d(json, gamma, today);
    const day = selectRange(series, today, 7);
    const shoreDay = shoreOk ? selectRange(seriesFor7d(shore, gamma, today), today, 7) : null;
    return {
      point, gamma, series, day, currentIndex: currentIndex(day, now),
      raw: json, stepMin: 15, horizon, shoreDay,
    };
  }

  const series = seriesFor24(json, gamma);
  const day = selectDay(series, today);
  const shoreDay = shoreOk ? selectDay(seriesFor24(shore, gamma), today) : null;
  return {
    point, gamma, series, day, currentIndex: currentIndex(day, now),
    raw: json, stepMin: 15, horizon, shoreDay,
  };
}

module.exports = {
  DEFAULT_POINT, SHORE_POINT, API, gammaToGrid, bearingDelta, lerpAngle, computeTeff, seedTeff,
  buildSeries, buildSeriesFrom, interpolate15, expandHourlyVector,
  chicagoNow, selectDay, selectRange, currentIndex, buildUrl, buildDualUrl, fetchWind, fetchWindTwo,
  parseTwoLocations, pointFromQuery, ingest, firstDaySlice,
};
