'use strict';
// Stage 3: pure UI helpers — headline formatting, Hs palette, spot naming.
// No DOM, no tables: node-testable and browser-loadable via the tiny loader.

// ---- Hs palette (ft): cyan -> cyan -> amber -> orange-red -> crimson -> magenta ----
// The 0 ft stop is the calm-lake colour: flat water is painted opaque at this value (see
// render.paintRaster), so calm water reads as one continuous saturated cyan sheet. The
// ramp above 0 ft is opaque too; only land stays transparent.
// Stage 5O: the floor is #0891b2, a deeper turquoise. The 1.0 ft stop stays #06b6d4, so
// the 0-1 ft band is a real gradient again (5N had both stops at #06b6d4, a flat band).
const HS_STOPS = [
  [0.0, 0x08, 0x91, 0xb2], // saturated cyan calm floor (opaque)
  [1.0, 0x06, 0xb6, 0xd4], // vibrant cyan
  [2.0, 0xf5, 0x9e, 0x0b], // amber
  [3.5, 0xea, 0x58, 0x0c], // orange-red
  [4.5, 0xdc, 0x26, 0x26], // crimson
  [5.5, 0xbe, 0x18, 0x5d], // magenta
];
// Calm-water RGBA. Must equal HS_STOPS[0]'s rgb (single source of truth): the legend's
// 0 ft colour and the map's calm colour are the same colour. Alpha 255 = fully opaque in
// the PNG; the Leaflet overlay multiplies it by OVERLAY_OPACITY 0.68, so calm water lands
// at 0.68 effective. Composite 0.68 x rgb(8, 145, 178) + 0.32 x rgb(205, 207, 207) is
// ~rgb(71, 165, 187): bright turquoise/teal, with bay/lake labels legible through it.
// Land stays exactly transparent.
const CALM_RGBA = [0x08, 0x91, 0xb2, 255];
const HS_BREAKS = [0, 1, 2, 3.5, 4.5, 6];
const OVERLAY_OPACITY = 0.68;

// RGBA for an Hs value in ft. Non-positive / non-finite -> fully transparent (the caller
// decides land vs calm water); water -> opaque. Opacity is applied once by the Leaflet overlay.
function colorForHs(hsFt) {
  if (!(hsFt > 0) || !Number.isFinite(hsFt)) return [0, 0, 0, 0];
  const t = Math.min(hsFt, HS_STOPS[HS_STOPS.length - 1][0]);
  let i = 0;
  while (i < HS_STOPS.length - 2 && t > HS_STOPS[i + 1][0]) i++;
  const a = HS_STOPS[i], b = HS_STOPS[i + 1];
  const f = (t - a[0]) / (b[0] - a[0]);
  return [
    Math.round(a[1] + f * (b[1] - a[1])),
    Math.round(a[2] + f * (b[2] - a[2])),
    Math.round(a[3] + f * (b[3] - a[3])),
    255,
  ];
}

// CSS rgb() for a stop value, used by the legend strip.
function rgbForHs(hsFt) {
  const c = colorForHs(hsFt);
  return `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
}

// Single source of truth for the legend ramp gradient: the six Hs stop colours, evenly
// spaced. src/render.js applies it to #legend-card-bar at mount.
const RAMP_PCT = ['0%', '16.7%', '33.3%', '50%', '66.7%', '100%'];
function rampGradient() {
  const stops = HS_STOPS.map(([, r, g, b], i) => `rgb(${r}, ${g}, ${b}) ${RAMP_PCT[i]}`);
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

// ---- stats ----
function percentile(values, p) {
  const v = [];
  for (let i = 0; i < values.length; i++) {
    if (values[i] > 0 && Number.isFinite(values[i])) v.push(values[i]);
  }
  if (!v.length) return 0;
  v.sort((x, y) => x - y);
  const idx = (v.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return v[lo] + (v[hi] - v[lo]) * (idx - lo);
}
function p10(values) { return percentile(values, 0.1); }

// ---- geography ----
const SECTORS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
const MI_M = 1609.344;
const FEATURE_RADIUS_M = 4000;
const SHORE_RADIUS_M = 400;

function haversineM(lat1, lon1, lat2, lon2) {
  const R = 6371008.8;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(a)));
}

// 8-way compass bearing from point 1 to point 2, degrees clockwise from north.
function bearing8(lat1, lon1, lat2, lon2) {
  const midLat = (lat1 + lat2) / 2 * Math.PI / 180;
  const dx = (lon2 - lon1) * Math.cos(midLat);
  const dy = lat2 - lat1;
  let deg = Math.atan2(dx, dy) * 180 / Math.PI;
  deg = ((deg % 360) + 360) % 360;
  return SECTORS[Math.round(deg / 45) % 8];
}

function centroidOfCorners(corners) {
  let lat = 0, lon = 0, n = 0;
  for (const k of Object.keys(corners || {})) { lat += corners[k][1]; lon += corners[k][0]; n++; }
  return n ? { lat: lat / n, lon: lon / n } : { lat: 0, lon: 0 };
}

// 8-way sector of a point relative to the lake centroid.
function sectorFor(lat, lon, centroid) {
  return bearing8(centroid.lat, centroid.lon, lat, lon);
}

// Nearest named feature within 4 km, else open water with its sector descriptor.
// sector = { name, shore }.
function nameSpot(lat, lon, features, sector) {
  let best = null, bestM = Infinity;
  for (const f of features || []) {
    const m = haversineM(lat, lon, f.lat, f.lon);
    if (m < bestM) { bestM = m; best = f; }
  }
  if (best && bestM <= FEATURE_RADIUS_M) {
    return {
      kind: 'feature', name: best.name, distanceMi: bestM / MI_M,
      bearing: bearing8(lat, lon, best.lat, best.lon), sector,
    };
  }
  return { kind: 'open', sector };
}

function describePin(spot) {
  if (spot.kind === 'feature') {
    return `${spot.distanceMi.toFixed(1)} mi ${spot.bearing} of ${spot.name}`;
  }
  return `Open water - ${sectorName(spot.sector)}`;
}

function sectorPhrase(sector) {
  const s = sector || {};
  return `${s.name} ${s.shore ? 'shore' : 'basin'}`;
}

// Capitalised sector label for headers and cards: "N Basin" / "SW Shore".
function sectorName(sector) {
  const s = sector || {};
  return `${s.name} ${s.shore ? 'Shore' : 'Basin'}`;
}

// Short place label for the header: the named feature if the peak is close to one,
// else the sector. "Peak: 4.0 ft · N Basin" / "Peak: 4.0 ft · Cove Bay".
function shortPlace(spot, sector) {
  return spot && spot.kind === 'feature' ? spot.name : sectorName(sector);
}

// Two-line honest verdict. Never a bare single Hs number.
function formatHeadline(frame) {
  const spot = nameSpot(frame.peakLat, frame.peakLon, frame.features, frame.sector);
  return {
    range: `Waves: ${frame.p10Ft.toFixed(1)} - ${frame.maxHsFt.toFixed(1)} ft`,
    peak: `Peak: ${frame.rollerFt.toFixed(1)} ft · ${shortPlace(spot, frame.sector)}`,
  };
}

// ---- Stage 4B: wind split, compass, condition tier, local clock ----
const CALM_MPH = 3;
const CALM_TIER_MPH = 4; // Stage 5J: "Calm · Flat" badge below this wind (green only)
const CALM_HS_FT = 0.5;  // Stage 5J: ...or below this lake-max Hs (green only)
const CHICAGO_TZ = 'America/Chicago';
const TIERS = {
  red: 'Dangerous · Stay Home',
  amber: 'Heavy Rollers',
  yellow: 'Walleye Chop',
  green: 'Fishable · Light Chop',
};

// Bearing in [0, 360).
function normalizeDeg(deg) {
  const d = Number(deg) % 360;
  return d < 0 ? d + 360 : d;
}

// Stage 6B: three-pill marine wind row. Integer display model for the header:
// lake/shore/gust speeds plus the lake pill's WIND_HEAT tier as a .55-alpha fill
// over the frosted glass (white ink on every tier, by measurement). A missing or
// malformed value (e.g. no shore series) renders an em dash.
function windPills(lakeMph, shoreMph, gustMph) {
  const int = (v) => {
    if (v == null || v === '') return '—';
    const n = Number(v);
    return Number.isFinite(n) ? String(Math.round(n)) : '—';
  };
  const c = windHeatColor(lakeMph);
  return {
    lake: int(lakeMph), shore: int(shoreMph), gust: int(gustMph),
    lakeTint: `rgba(${c[0]}, ${c[1]}, ${c[2]}, 0.55)`,
    lakeBorder: `rgb(${c[0]}, ${c[1]}, ${c[2]})`,
  };
}

// Compass metadata. Text fields describe the SOURCE (fromDeg); arrowDeg points
// DOWNWIND (flow vector = from + 180) so the arrow reads as "where the air is
// going". Calm (< 3 mph) or a non-finite bearing -> all-null fields.
function compass(bearingDeg, speedMph) {
  if (speedMph != null) {
    const s = Number(speedMph);
    if (!Number.isFinite(s) || s < CALM_MPH)
      return { sector: 'Calm', degText: '', fromDeg: null, arrowDeg: null };
  }
  const b = Number(bearingDeg);
  if (!Number.isFinite(b)) return { sector: 'Calm', degText: '', fromDeg: null, arrowDeg: null };
  const deg = normalizeDeg(b);
  return {
    sector: SECTORS[Math.round(deg / 45) % 8],
    degText: `${Math.round(deg)}°`,
    fromDeg: deg,
    arrowDeg: (deg + 180) % 360,
  };
}

// Condition tier, strict red -> amber -> yellow -> green (first match wins).
// Missing/NaN inputs never trigger a condition. A green sea is relabelled "Calm · Flat"
// when the wind is under 4 mph or the lake max is under 0.5 ft — never for rougher keys.
function comfortTier(stats) {
  const s = stats || {};
  const maxHs = Number(s.maxHsFt), roller = Number(s.rollerFt), hl = Number(s.hlMax);
  const at = (v, t) => Number.isFinite(v) && v >= t;
  let key = 'green';
  if (at(maxHs, 5.0) || at(roller, 4.0) || at(hl, 0.055)) key = 'red';
  else if (at(maxHs, 3.5) || at(roller, 2.5)) key = 'amber';
  else if (at(maxHs, 2.0) || at(roller, 1.5)) key = 'yellow';
  if (key === 'green') {
    const windMph = Number(s.windMph);
    if ((Number.isFinite(maxHs) && maxHs < CALM_HS_FT) ||
        (Number.isFinite(windMph) && windMph < CALM_TIER_MPH)) {
      return { key: 'green', label: 'Calm · Flat' };
    }
  }
  return { key, label: TIERS[key] };
}

// Offset (local wall-clock as UTC minus the true instant) at an instant, ms.
function tzOffsetMs(utcMs) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(utcMs));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  const asUTC = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute, +p.second);
  return asUTC - utcMs;
}

// "2026-09-11T17:15" -> "5:15 PM CDT". Input is America/Chicago wall-clock; the
// local instant is resolved with a two-pass offset (DST-safe), never by slicing.
function formatClockLocal(isoLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(isoLocal == null ? '' : isoLocal));
  if (!m) return '';
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let epoch = naive - tzOffsetMs(naive);
  epoch = naive - tzOffsetMs(epoch);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ, hour: 'numeric', minute: '2-digit', hour12: true, timeZoneName: 'short',
  }).format(new Date(epoch));
}

// Compact pill clock: 12-hour, no leading zero, minutes only when non-zero,
// no timezone suffix. '2026-09-11T10:00' -> '10 AM', '2026-09-11T13:15' -> '1:15 PM'.
function formatPillTime(isoLocal) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(isoLocal == null ? '' : isoLocal));
  if (!m) return '';
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let epoch = naive - tzOffsetMs(naive);
  epoch = naive - tzOffsetMs(epoch);
  return new Intl.DateTimeFormat('en-US', {
    timeZone: CHICAGO_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
  }).format(new Date(epoch)).replace(':00 ', ' ');
}

// 6.2: minute-level pill clock for continuous (sub-frame) scrubbing. The offset is applied
// to the resolved INSTANT — never to the wall-clock string — so a scrub that crosses a DST
// change still reads the true local time. Minutes are always shown ('7:04 AM', '7:00 AM'):
// the drag path can land anywhere inside a 15-minute frame, which the compact form above
// cannot express. Bad input -> ''; a non-finite offset -> the base frame's own clock.
let _pillMinuteFmt = null;
function formatPillTimeAt(isoLocal, addMinutes) {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(isoLocal == null ? '' : isoLocal));
  if (!m) return '';
  const naive = Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  let epoch = naive - tzOffsetMs(naive);
  epoch = naive - tzOffsetMs(epoch);
  const add = Number(addMinutes);
  const at = epoch + (Number.isFinite(add) ? Math.round(add) * 60000 : 0);
  if (!_pillMinuteFmt) {
    _pillMinuteFmt = new Intl.DateTimeFormat('en-US', {
      timeZone: CHICAGO_TZ, hour: 'numeric', minute: '2-digit', hour12: true,
    });
  }
  return _pillMinuteFmt.format(new Date(at));
}

// ---- Stage 5D: day label from a local ISO string ----
// Weekday comes from calendar math alone (Date.UTC noon + getUTCDay); never a
// TZ-parse of the full string, which would shift the date near midnight.
const DOW_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const DOW_LONG = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// '2026-09-11T00:00' -> 'Fri 11' (long = false) / 'Friday 11' (long = true). '' on bad input.
function dayLabel(isoLocal, long) {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(isoLocal == null ? '' : isoLocal));
  if (!m) return '';
  const y = +m[1], mo = +m[2], d = +m[3];
  const dt = new Date(Date.UTC(y, mo - 1, d, 12));
  if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== d) return '';
  return `${(long ? DOW_LONG : DOW_SHORT)[dt.getUTCDay()]} ${d}`;
}

// ---- Stage 5O: wind heat ribbon ----
// Ascending tier scale: [maxMph (exclusive), r, g, b]. 10 -> <10 cyan, 15 -> 10-14 green,
// 20 -> 15-19 amber, 25 -> 20-24 orange, Infinity -> 25+ crimson.
const WIND_HEAT = [
  [10, 0x08, 0x91, 0xb2], // < 10 mph  saturated cyan  (#0891b2)
  [15, 0x10, 0xb9, 0x81], // 10-14     bright green    (#10b981)
  [20, 0xf5, 0x9e, 0x0b], // 15-19     amber           (#f59e0b)
  [25, 0xf9, 0x73, 0x16], // 20-24     orange          (#f97316)
  [Infinity, 0xef, 0x44, 0x44], // 25+   crimson         (#ef4444)
];

// Tier colour [r,g,b] for a wind speed. Non-finite or negative -> the <10 mph colour.
function windHeatColor(mph) {
  const s = Number(mph);
  const v = Number.isFinite(s) && s >= 0 ? s : 0;
  for (let i = 0; i < WIND_HEAT.length; i++) {
    if (v < WIND_HEAT[i][0]) return [WIND_HEAT[i][1], WIND_HEAT[i][2], WIND_HEAT[i][3]];
  }
  const last = WIND_HEAT[WIND_HEAT.length - 1];
  return [last[1], last[2], last[3]];
}

// Continuous CSS gradient, one stop per sample at i/(n-1). n < 2 -> a flat two-stop
// gradient of that sample's colour; empty -> the <10 colour (never throws, never NaN).
function windHeatGradient(speeds) {
  const list = speeds || [];
  if (list.length < 2) {
    const c = windHeatColor(list.length ? list[0] : NaN);
    const rgb = `rgb(${c[0]}, ${c[1]}, ${c[2]})`;
    return `linear-gradient(90deg, ${rgb} 0%, ${rgb} 100%)`;
  }
  const n = list.length;
  const stops = list.map((s, i) => {
    const c = windHeatColor(s);
    return `rgb(${c[0]}, ${c[1]}, ${c[2]}) ${(i / (n - 1)) * 100}%`;
  });
  return `linear-gradient(90deg, ${stops.join(', ')})`;
}

module.exports = {
  HS_STOPS, HS_BREAKS, OVERLAY_OPACITY, CALM_RGBA,
  colorForHs, rgbForHs, rampGradient, percentile, p10,
  SECTORS, haversineM, bearing8, centroidOfCorners, sectorFor,
  nameSpot, describePin, sectorPhrase, sectorName, shortPlace, formatHeadline,
  FEATURE_RADIUS_M, SHORE_RADIUS_M,
  CALM_MPH, CALM_TIER_MPH, CALM_HS_FT, normalizeDeg, windPills, compass,
  comfortTier, formatClockLocal, formatPillTime, formatPillTimeAt, dayLabel,
  WIND_HEAT, windHeatColor, windHeatGradient,
};
