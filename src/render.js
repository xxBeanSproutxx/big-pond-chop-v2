'use strict';
// Stage 4A display: affine warp, canvas paint, lazy frame cache + LRU,
// water-masked smoothing, zoom-aware gather, Leaflet overlay, map readout.
// Pure geometry/gather/cache helpers are node-testable; mount() drives the DOM.

const { BATHY_ROWS, BATHY_COLS, BATHY_CELLS, FETCH_ROWS, FETCH_COLS, LAND_U16 } = require('./tables');
const waveMath = require('./wave-math');
const ui = require('./ui');

const SCALE_FT = 6.0;
// Precomputed-frame layer (v2). Frames are Uint8 285x292: min(254, round(Hs_ft x 32)),
// 255 = land/nodata. Delay math constant mirrored from src/delay-math.mjs (CG_MPH);
// the browser cannot import that .mjs, so the one-cell steepness recompute below keeps
// this in sync by hand.
const FRAME_NODATA = 255;
const FRAME_STEP_FT = 1 / 32;
const CG_MPH = 11;            // == src/delay-math.mjs CG_MPH
const M_PER_MI = 1609.344;
const RAW_FRAME_CACHE_MAX = 8;
const TILE_URL = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
// CARTO's keyless basemaps now stamp "API KEY REQUIRED" on the tiles, so the muted
// look is achieved by desaturating standard OSM tiles (see .leaflet-tile-pane in index.html).
/* 6B.4: compact docked attribution — our own markup (no Leaflet prefix, see
   setPrefix(false) below), so the string is short enough to share the deck line
   with the legend: ~110 px on the right vs the legend on the left. */
const TILE_ATTRIBUTION = '<a href="https://openstreetmap.org" target="_blank">© OpenStreetMap</a> · <a href="https://leafletjs.com" target="_blank">Leaflet</a>';
const TILE_MAX_ZOOM = 19;
const OVERLAY_OPACITY = ui.OVERLAY_OPACITY;
const PLAY_INTERVAL_MS = 333;
const FRAME_MINUTES = 15;
const FRAME_CACHE_MAX = 8;
const MAP_PAINT_MIN_MS = 72; // ~13.9 fps: drag-time overlay repaint throttle (12-15 fps band)
const STICKY_INSET = 56;    // 5L: sticky day header clears the 48 px #play button at the window edge
// 6.4 D2.1/D2.2: suspend map encodes while a scrub gesture is live; the valve below caps it.
const SUSPEND_MAX_MS = 1200; // anti-freeze: one paint per 1.2 s of continuous suspension
const DRAG_RASTER_W = 512;   // 6.3 D3.5: drag-time raster width in device px (rest width 780)

// ---- affine warp ----
function gridToLonlat(warp, col, row) {
  const a = warp.grid_to_lonlat, b = warp.grid_to_lonlat_row;
  return { lon: a[0] * col + a[1] * row + a[2], lat: b[0] * col + b[1] * row + b[2] };
}

function lonlatToGrid(warp, lon, lat) {
  const a = warp.lonlat_to_grid, b = warp.lonlat_to_grid_row;
  return { col: a[0] * lon + a[1] * lat + a[2], row: b[0] * lon + b[1] * lat + b[2] };
}

function displayBounds(warp) {
  return {
    west: warp.corners.nw[0], north: warp.corners.nw[1],
    east: warp.corners.se[0], south: warp.corners.se[1],
  };
}

function pickDisplayDims(bounds, targetW) {
  const W = targetW || 384;
  const midLat = ((bounds.north + bounds.south) / 2) * Math.PI / 180;
  const wM = (bounds.east - bounds.west) * Math.cos(midLat) * 111320;
  const hM = (bounds.north - bounds.south) * 110574;
  return { W, H: Math.max(2, Math.round(W * hM / wM)) };
}

// Raster width for a container: client px * dpr, clamped to [lo, hi].
function targetWidth(clientWidth, dpr, lo = 512, hi = 1536) {
  const px = Math.round((Number(clientWidth) || 0) * (Number(dpr) || 1));
  return Math.max(lo, Math.min(hi, px));
}

// Playback raster width: 1x display (CSS) px, capped so the 3 fps loop stays cheap.
const PLAY_MAX_WIDTH = 780;
function playWidth(clientWidth, cap = PLAY_MAX_WIDTH) {
  const px = Math.round(Number(clientWidth) || 0);
  return Math.min(cap, Math.max(2, px));
}

// Async blob encode exists only where OffscreenCanvas + convertToBlob are present.
function offscreenSupported() {
  return typeof OffscreenCanvas === 'function' &&
    typeof OffscreenCanvas.prototype.convertToBlob === 'function' &&
    typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function';
}

// Revoke only blob: object URLs; the data-URL fallback has no handle and must not be revoked.
function revokeUrl(url) {
  if (typeof url === 'string' && url.slice(0, 5) === 'blob:' &&
      typeof URL !== 'undefined' && typeof URL.revokeObjectURL === 'function') {
    URL.revokeObjectURL(url);
  }
}

// Stale-result guard: an async encode may paint the overlay only if it still describes the
// frame currently shown (same index, pin and raster dims). Pure so it is node-testable.
function shouldPaintResult(result, current) {
  return !!result && !!current &&
    result.idx === current.idx && result.pinIdx === current.pinIdx &&
    result.W === current.W && result.H === current.H;
}

// Drag-time paint gate: open once the interval elapsed and no encode is in flight.
// Pure so the throttle decision is node-testable (stage 5H).
function shouldPaintMap(nowMs, lastPaintMs, busy, minIntervalMs) {
  return !busy && (Number(nowMs) - Number(lastPaintMs)) >= Number(minIntervalMs);
}

// ---- stage 5G: scrolling tape geometry (pure helpers) ----
// Tape density: 7 d is a fixed 330 px/day (672 frames -> 2,310 px; 41.25 px per 3 h
// interval, wide enough that the tick and wind rows never collide); a single 24 h day is
// a 550 px/day tape so it has ~176 px of runway at a phone viewport, and still fills at
// least the viewing window on desktop/tablet (window-fill, as in 5G).
function pxPerDay(horizon, windowW) {
  return (horizon === '7d' || horizon === '15d')
    ? 330 : Math.max(550, Math.round(Number(windowW) || 0));
}

function pxPerFrame(horizon, windowW) {
  return pxPerDay(horizon, windowW) / 96;
}

// v2 precomputed tapes: 15d is 3-hourly (8 frames/day), 48h is hourly (24/day).
// pxPerDay keeps the v1 density class; this gives one uniform px step per FRAME.
function framesPerDay(horizon) {
  return (horizon === '7d' || horizon === '15d') ? 8 : 24;
}

function framePx(horizon, windowW) {
  return pxPerDay(horizon, windowW) / framesPerDay(horizon);
}

// Reticle identity: the active frame's centre lands exactly on the window centre.
function tapeTranslate(idx, pxf, viewportCenterPx) {
  return viewportCenterPx - idx * pxf;
}

// Drag dx -> frame index. Dragging LEFT (dx < 0) advances into the future.
function idxFromDrag(dxPx, startIdx, pxf, n) {
  const raw = Math.round(startIdx - dxPx / pxf);
  return Math.max(0, Math.min(n - 1, raw));
}

// ---- 6.2: continuous (minute-level) scrub geometry (pure helpers) ----
// One minute of tape. The density is quoted in px per DAY, so a single 15-min frame is
// pxPerDay/96 px and a minute is a 15th of that (24 h @360 px: 0.382 px/min; 7 d: 0.229).
function pxPerMinute(horizon, windowW, stepMin) {
  const step = Number(stepMin) > 0 ? Number(stepMin) : FRAME_MINUTES;
  return pxPerFrame(horizon, windowW) / step;
}

// Raw pixel drag -> CONTINUOUS minutes (never snapped): dragging LEFT (dx < 0) advances
// into the future. Clamped to the series so a fling can neither run off the tape nor
// wrap. A non-positive px/min (a zero-width window during boot) returns the start.
function minutesFromDrag(dxPx, startMinutes, pxPerMin, maxMinutes) {
  const ppm = Number(pxPerMin);
  const lo = 0, hi = Math.max(0, Number(maxMinutes) || 0);
  const start = Math.max(lo, Math.min(hi, Number(startMinutes) || 0));
  if (!Number.isFinite(ppm) || ppm <= 0) return start;
  return Math.max(lo, Math.min(hi, start - Number(dxPx) / ppm));
}

// Continuous tape translate: the same reticle identity as tapeTranslate(), on the minute
// grid, so a half-frame drag moves the tape by exactly the finger delta.
function tapeTranslateMinutes(minutes, pxPerMin, viewportCenterPx) {
  return Number(viewportCenterPx) - Number(minutes) * Number(pxPerMin);
}

// The raster engine still works on the 15-min frame array: quantise the continuous minute
// position to the nearest frame (spec: round(minutes / step)) — never a dummy frame.
function idxFromMinutes(minutes, stepMin, n) {
  const step = Number(stepMin) > 0 ? Number(stepMin) : FRAME_MINUTES;
  const count = Math.max(1, Number(n) || 1);
  const raw = Math.round((Number(minutes) || 0) / step);
  return Math.max(0, Math.min(count - 1, raw));
}

// ---- stage 5D: timeline partitions + 7-day playback cadence (pure helpers) ----
// One entry per maximal run of equal local date, index = first frame of the run.
// Derived from the date strings only — never floor(i / framesPerDay).
function dayPartitions(entries) {
  const list = entries || [];
  const parts = [];
  let prev = null;
  for (let i = 0; i < list.length; i++) {
    const date = String(list[i].time).slice(0, 10);
    if (date !== prev) { parts.push({ date, index: i }); prev = date; }
  }
  return parts;
}

// 7-day/15-day horizon steps 4 frames per play tick; the 24h/48h horizon steps 1.
function playStep(horizon) {
  return (horizon === '7d' || horizon === '15d') ? 4 : 1;
}

function nextPlayIdx(cur, step, n) {
  return n > 0 ? (cur + step) % n : 0;
}

// ---- stage 5M: three-hourly wind row (pure helper) ----
// h = 0,3,…,21 -> Math.round(speedMph) of the frame in [start, end) whose local time is hh:00.
// Missing frame or non-finite speed is skipped (no label). Returns [{ h, mph }] ordered by hour.
function tickWinds(entries, start, end) {
  const list = entries || [];
  const lo = Math.max(0, start | 0);
  const hi = Math.min(list.length, end == null ? list.length : end | 0);
  const out = [];
  for (let h = 0; h <= 21; h += 3) {
    const hh = String(h).padStart(2, '0') + ':00';
    for (let i = lo; i < hi; i++) {
      const e = list[i];
      if (!e || String(e.time).slice(11, 16) !== hh) continue;
      if (Number.isFinite(e.speedMph)) out.push({ h, mph: Math.round(e.speedMph) });
      break;
    }
  }
  return out;
}

// ---- v2 precomputed-frame helpers (pure) ----
// Zero-order hold: index of the last wind series entry with tMs <= queryMs (0 if before
// the start). Mirrors src/delay-math.mjs sampleIndex (the browser cannot import the .mjs).
function sampleWindIndex(timesMs, queryMs) {
  if (!timesMs.length) return -1;
  if (queryMs < timesMs[0]) return 0;
  let lo = 0, hi = timesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timesMs[mid] <= queryMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

// Bathy (285x292) cell -> coarse (95x98) fetch cell, the exact mapping computeField uses.
function coarseIndexFor(cell) {
  const row = Math.floor(cell / BATHY_COLS);
  const col = cell % BATHY_COLS;
  let rc = Math.trunc((row - 1) / 3);
  rc = rc < 0 ? 0 : rc > FETCH_ROWS - 1 ? FETCH_ROWS - 1 : rc;
  let cc = Math.trunc((col - 1) / 3);
  cc = cc < 0 ? 0 : cc > FETCH_COLS - 1 ? FETCH_COLS - 1 : cc;
  return rc * FETCH_COLS + cc;
}

// UTC ISO -> America/Chicago wall-clock 'YYYY-MM-DDTHH:MM' (the shape ui.* parses as local).
function chicagoLocalIso(utcIso) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'America/Chicago', hourCycle: 'h23',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  }).formatToParts(new Date(utcIso));
  const p = {};
  for (const x of parts) p[x.type] = x.value;
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}`;
}

// P3 weather strip: one summary per America/Chicago calendar day from the merged hourly
// series. hi/lo °F, daily precip total in INCHES (wire is mm), and max wind mph.
function dailySummaries(entries) {
  const map = new Map();
  for (const e of (entries || [])) {
    const date = chicagoLocalIso(e.time).slice(0, 10);
    let d = map.get(date);
    if (!d) { d = { date, hiF: -Infinity, loF: Infinity, precipMm: 0, maxWindMph: -Infinity }; map.set(date, d); }
    const t = Number(e.tempF); if (Number.isFinite(t)) { if (t > d.hiF) d.hiF = t; if (t < d.loF) d.loF = t; }
    const p = Number(e.precipMm); if (Number.isFinite(p)) d.precipMm += p;
    const w = Number(e.speedMph); if (Number.isFinite(w) && w > d.maxWindMph) d.maxWindMph = w;
  }
  return [...map.values()].map((d) => ({
    date: d.date,
    hiF: Number.isFinite(d.hiF) ? d.hiF : null,
    loF: Number.isFinite(d.loF) ? d.loF : null,
    precipIn: d.precipMm / 25.4,
    maxWindMph: Number.isFinite(d.maxWindMph) ? d.maxWindMph : null,
  }));
}

function bilinearSample(field, cols, rows, colF, rowF) {
  const cx = colF < 0 ? 0 : colF > cols - 1 ? cols - 1 : colF;
  const ry = rowF < 0 ? 0 : rowF > rows - 1 ? rows - 1 : rowF;
  const c0 = Math.floor(cx), r0 = Math.floor(ry);
  const c1 = Math.min(cols - 1, c0 + 1), r1 = Math.min(rows - 1, r0 + 1);
  const fc = cx - c0, fr = ry - r0;
  const v00 = field[r0 * cols + c0], v01 = field[r0 * cols + c1];
  const v10 = field[r1 * cols + c0], v11 = field[r1 * cols + c1];
  return (v00 * (1 - fc) + v01 * fc) * (1 - fr) + (v10 * (1 - fc) + v11 * fc) * fr;
}

// Gather the UTM field into a lat/lng-uniform display raster (row 0 = north).
function gatherRaster(field, warp, W, H) {
  const [cols, rows] = warp.dims;
  const A = warp.lonlat_to_grid, Ar = warp.lonlat_to_grid_row;
  const b = displayBounds(warp);
  const out = new Float32Array(W * H);
  for (let i = 0; i < H; i++) {
    const lat = b.north + (b.south - b.north) * ((i + 0.5) / H);
    for (let j = 0; j < W; j++) {
      const lon = b.west + (b.east - b.west) * ((j + 0.5) / W);
      const colF = A[0] * lon + A[1] * lat + A[2];
      const rowF = Ar[0] * lon + Ar[1] * lat + Ar[2];
      out[i * W + j] = bilinearSample(field, cols, rows, colF, rowF);
    }
  }
  return out;
}

// roller / Hmax definition (post-Ks, pre-0.6d), pinned in golden.json.
function hmaxFt(hsAfterKsFt, dLocalFt) {
  return Math.min(1.67 * hsAfterKsFt, 0.78 * dLocalFt);
}

// One hour/step frame: capped Hs field + post-Ks/depth/period for readout + lake-max stats.
function computeFrame(tables, entry, opts = {}) {
  const gamma = opts.gamma || 0;
  const capped = opts.out || new Float64Array(BATHY_CELLS);
  const afterKs = opts.outAfterKs || new Float64Array(BATHY_CELLS);
  const ts = opts.outTs || new Float64Array(BATHY_CELLS);
  waveMath.computeField(tables, entry.speedMph, entry.dirTrueDeg, capped, {
    blend: true, t_eff_s: entry.tEffH * 3600, gamma, outAfterKs: afterKs, outTs: ts,
  });
  let maxIdx = 0, maxHs = 0;
  for (let i = 0; i < capped.length; i++) {
    if (capped[i] > maxHs) { maxHs = capped[i]; maxIdx = i; }
  }
  const depthMax = tables.depth[maxIdx] * 0.25;
  const rollerFt = hmaxFt(afterKs[maxIdx], depthMax);
  const L_m = (waveMath.dispersionFast(ts[maxIdx], depthMax * waveMath.FT)).L_m;
  return { capped, afterKs, ts, maxHs, maxIdx, rollerFt, hlMax: (afterKs[maxIdx] * waveMath.FT) / L_m };
}

// ---- colour scale (land transparent, calm water opaque navy) ----
// raster[k] > 0 is water with a height -> Hs ramp. Otherwise the pixel is either calm
// water (paint CALM_RGBA) or land (stay transparent); landFrac tells them apart. The
// land-fraction raster may be omitted (e.g. pure unit paint) -> non-positive is transparent.
function paintRaster(ctx, raster, W, H, landFrac) {
  const img = ctx.createImageData(W, H);
  const px = img.data;
  for (let k = 0, p = 0; k < raster.length; k++, p += 4) {
    const c = raster[k] > 0
      ? ui.colorForHs(raster[k])
      : (landFrac && landFrac[k] < 0.5 ? ui.CALM_RGBA : [0, 0, 0, 0]);
    px[p] = c[0]; px[p + 1] = c[1]; px[p + 2] = c[2]; px[p + 3] = c[3];
  }
  ctx.putImageData(img, 0, 0);
}

// Async PNG encode: paint the same raster into an OffscreenCanvas, then let the browser
// encode to a blob off the main thread. Resolves to an object URL.
function encodeOffscreen(raster, W, H, landFrac) {
  const off = new OffscreenCanvas(W, H);
  paintRaster(off.getContext('2d'), raster, W, H, landFrac);
  return off.convertToBlob({ type: 'image/png' }).then((blob) => URL.createObjectURL(blob));
}

// ---- display smoothing (display-only; stats stay on the raw field) ----
const landFields = new WeakMap();
const landFracCache = new Map();

// Land fraction per display pixel: bilinear gather of a binary land field.
function landMaskRaster(warp, tables, W, H) {
  let field = landFields.get(tables);
  if (!field) {
    field = new Float32Array(tables.depth.length);
    for (let i = 0; i < field.length; i++) field[i] = tables.depth[i] === LAND_U16 ? 1 : 0;
    landFields.set(tables, field);
  }
  const key = `${W}x${H}`;
  let frac = landFracCache.get(key);
  if (!frac) { frac = gatherRaster(field, warp, W, H); landFracCache.set(key, frac); }
  return frac;
}

// Separable masked blur. Land sources (landFrac = 1) get zero weight, so the
// shoreline fringe is removed; weights are normalized per pixel. Pure-land
// pixels are forced to exactly 0. Inputs are never mutated.
function smoothRaster(raster, landFrac, W, H, radius = 2) {
  const r = Math.max(1, radius | 0);
  const n = 2 * r;
  const kern = new Float64Array(n + 1);
  kern[0] = 1;
  for (let i = 1; i <= n; i++) kern[i] = (kern[i - 1] * (n - i + 1)) / i;
  const tmp = new Float32Array(W * H);
  const out = new Float32Array(W * H);
  for (let i = 0; i < H; i++) {
    const row = i * W;
    for (let j = 0; j < W; j++) {
      let sw = 0, sv = 0;
      if (j >= r && j < W - r) {
        const j0 = row + j - r;
        for (let k = 0; k <= n; k++) {
          const w = kern[k] * (1 - landFrac[j0 + k]);
          sw += w; sv += w * raster[j0 + k];
        }
      } else {
        for (let k = -r; k <= r; k++) {
          let jj = j + k;
          if (jj < 0) jj = 0; else if (jj >= W) jj = W - 1;
          const w = kern[k + r] * (1 - landFrac[row + jj]);
          sw += w; sv += w * raster[row + jj];
        }
      }
      tmp[row + j] = sw > 0 ? sv / sw : 0;
    }
  }
  for (let i = 0; i < H; i++) {
    const row = i * W;
    const inner = i >= r && i < H - r;
    for (let j = 0; j < W; j++) {
      let sw = 0, sv = 0;
      if (inner) {
        for (let k = -r; k <= r; k++) {
          const v = row + k * W + j;
          const w = kern[k + r] * (1 - landFrac[v]);
          sw += w; sv += w * tmp[v];
        }
      } else {
        for (let k = -r; k <= r; k++) {
          let ii = i + k;
          if (ii < 0) ii = 0; else if (ii >= H) ii = H - 1;
          const v = ii * W + j;
          const w = kern[k + r] * (1 - landFrac[v]);
          sw += w; sv += w * tmp[v];
        }
      }
      const v = row + j;
      out[v] = landFrac[v] >= 1 ? 0 : (sw > 0 ? sv / sw : 0);
    }
  }
  return out;
}

// ---- lazy frame cache (LRU) ----
function cacheKey(idx, pinIdx, W, H) {
  return `${idx}|${pinIdx}|${W}x${H}`;
}

// Rough memory of one cached frame: the encoded data URL is the payload.
function frameBytes(entry) {
  if (!entry) return 0;
  return (entry.url ? entry.url.length * 2 : 0) + 64;
}

function createFrameCache(opts = {}) {
  const max = opts.max || FRAME_CACHE_MAX;
  const sizeOf = opts.sizeOf || frameBytes;
  const onEvict = opts.onEvict;
  const map = new Map();
  let bytes = 0, peakBytes = 0;
  function drop(key) {
    const v = map.get(key);
    bytes -= sizeOf(v);
    map.delete(key);
    if (onEvict) onEvict(key, v); // lets the app revoke a blob: object URL
  }
  return {
    get(key) {
      if (!map.has(key)) return undefined;
      const v = map.get(key);
      map.delete(key); map.set(key, v); // touch -> most recently used
      return v;
    },
    has(key) { return map.has(key); },
    set(key, entry) {
      if (map.has(key)) drop(key);
      map.set(key, entry);
      bytes += sizeOf(entry);
      while (map.size > max) drop(map.keys().next().value);
      if (bytes > peakBytes) peakBytes = bytes;
      return entry;
    },
    clear() { for (const k of [...map.keys()]) drop(k); bytes = 0; },
    keys() { return [...map.keys()]; },
    get size() { return map.size; },
    get bytes() { return bytes; },
    get peakBytes() { return peakBytes; },
    get max() { return max; },
  };
}

// ---- browser app ----
async function mount(deps) {
  const { tables: T, wind } = deps;
  const note = document.getElementById('note');
  const noteMsg = document.getElementById('note-msg');
  const noteRetry = document.getElementById('note-retry');
  const bootEl = document.getElementById('boot');
  const bootText = document.getElementById('boot-text');
  const bootBar = document.getElementById('boot-bar');
  const body = document.body;
  const canvas = document.getElementById('field');
  const cctx = canvas.getContext('2d');
  const deck = document.getElementById('deck');
  const trackEl = document.getElementById('track');
  const timeline = document.getElementById('timeline');
  const trackTape = document.getElementById('track-tape');
  const trackDays = document.getElementById('track-days');
  const trackTicks = document.getElementById('track-ticks');
  const trackLabel = document.getElementById('track-label');
  const timePill = document.getElementById('time-pill');
  const nowTick = document.getElementById('now-tick');
  const horizonEl = document.getElementById('horizon');
  const h48Btn = document.getElementById('h-48h');
  const h15Btn = document.getElementById('h-15d');
  const dataAgeEl = document.getElementById('data-age');
  const weatherDays = document.getElementById('weather-days');
  const weatherDetail = document.getElementById('weather-detail');
  const weatherLabels = document.getElementById('weather-labels');
  const lakeEl = document.getElementById('lake');
  const gustEl = document.getElementById('gust');
  const pillLakeEl = document.getElementById('pill-lake');
  const pillGustEl = document.getElementById('pill-gust');
  const verdictRange = document.getElementById('verdict-range');
  const verdictPeak = document.getElementById('verdict-peak');
  const comfortChip = document.getElementById('comfort-chip');
  const windBadge = document.getElementById('wind-badge');
  const badgeText = document.getElementById('wind-badge-text');
  const badgeArrow = document.getElementById('wind-badge-arrow');
  const playBtn = document.getElementById('play');
  const card = document.getElementById('card');
  const mapEl = document.getElementById('map');
  const readout = document.getElementById('readout');
  // Panel chrome must not double as a map tap: without this, clicking the card's X (or the
  // wind badge) also fires Leaflet's map click, which re-drops the pin and reopens the card.
  ['click', 'mousedown', 'touchstart', 'dblclick'].forEach((t) => {
    card.addEventListener(t, (e) => e.stopPropagation());
    windBadge.addEventListener(t, (e) => e.stopPropagation());
    horizonEl.addEventListener(t, (e) => e.stopPropagation());
  });
  const q = new URLSearchParams(location.search);
  const DEFAULT_HINT = 'tap the lake for a local readout';

  // ---- horizon state (v2: 48h | 15d; never let storage throw-crash boot) ----
  // '7d'/'24h' remain accepted on read for bookmarks written by older builds.
  const HORIZON_KEY = 'bpc.horizon';
  const is15d = (v) => v === '15d' || v === '7d';
  const is48h = (v) => v === '48h' || v === '24h';
  function readStoredHorizon() {
    try {
      const v = localStorage.getItem(HORIZON_KEY);
      if (is15d(v)) return '15d';
      if (is48h(v)) return '48h';
      return null;
    } catch (err) { return null; }
  }
  function storeHorizon(h) {
    try { localStorage.setItem(HORIZON_KEY, h); } catch (err) { /* private mode */ }
  }
  function queryHorizon() {
    const v = q.get('h');
    if (is15d(v)) return '15d';
    if (is48h(v)) return '48h';
    return null;
  }
  let horizon = queryHorizon() || readStoredHorizon() || '48h';
  // Resolved horizon is written to both the store and the URL, ?h= merged over existing params.
  function persistHorizon(h) {
    horizon = h;
    storeHorizon(h);
    const params = new URLSearchParams(location.search);
    params.set('h', h);
    history.replaceState(null, '', `${location.pathname}?${params.toString()}${location.hash}`);
  }
  function setHorizonPressed(h) {
    h48Btn.setAttribute('aria-pressed', h === '48h' ? 'true' : 'false');
    h15Btn.setAttribute('aria-pressed', h === '15d' ? 'true' : 'false');
  }

  const reducedMotion = !!(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  if (reducedMotion) body.classList.add('reduced-motion');
  const dpr = () => window.devicePixelRatio || 1;

  let tables = null, warp = null, gamma = 0, features = [], centroid = null, bounds = null;

  // ---- loading skeleton + retry toast ----
  function boot(text, frac) {
    bootText.textContent = text;
    if (frac == null) bootEl.classList.add('indeterminate');
    else { bootEl.classList.remove('indeterminate'); bootBar.style.width = `${Math.round(frac * 100)}%`; }
    bootEl.classList.remove('hidden');
    bootHidden = false; // 5D.2: a freshly shown skeleton hides again on the next painted frame
  }
  function hideBoot() { bootEl.classList.add('hidden'); }
  function showNote(msg, retryFn) {
    noteMsg.textContent = msg;
    note.style.display = 'flex';
    noteRetry.hidden = !retryFn;
    noteRetry.onclick = retryFn || null;
  }
  function hideNote() { note.style.display = 'none'; noteRetry.onclick = null; }

  function fetchJson(url) {
    return fetch(url).then((r) => {
      if (!r.ok) throw new Error(`${url} HTTP ${r.status}`);
      return r.json();
    });
  }

  // Streaming fetch driven by Content-Length; null fraction = indeterminate.
  async function fetchProgress(url, onProgress) {
    const res = await fetch(url);
    if (!res.ok) throw new Error(`${url} HTTP ${res.status}`);
    const total = Number(res.headers.get('Content-Length'));
    if (!res.body || !Number.isFinite(total) || total <= 0) {
      const buf = await res.arrayBuffer();
      onProgress(null);
      return buf;
    }
    const reader = res.body.getReader();
    const chunks = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress(got / total);
    }
    const merged = new Uint8Array(got);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    return merged.buffer;
  }

  // Decoded map data is loaded once; a wind retry never refetches these.
  async function loadMapData() {
    if (tables) return;
    boot('Loading wave map…', null);
    const meta = await fetchJson('public/meta.v1.json');
    const bins = await fetchProgress('public/tables.v1.bin', (f) => boot('Loading wave map…', f));
    const w = await fetchJson('public/warp.v1.json');
    const spots = await fetchJson('public/spots.v1.json');
    tables = T.decodeTables(bins);
    warp = w;
    gamma = meta.gamma_deg;
    features = spots.features || [];
    centroid = ui.centroidOfCorners(meta.wgs84_corners || w.corners);
    bounds = displayBounds(warp);
  }

  const legendBar = document.getElementById('legend-card-bar');
  if (legendBar) legendBar.style.background = ui.rampGradient();

  function isShoreCell(lat, lon) {
    const g = lonlatToGrid(warp, lon, lat);
    const r0 = Math.round(g.row), c0 = Math.round(g.col);
    const d = Math.ceil(ui.SHORE_RADIUS_M / 100);
    for (let r = r0 - d; r <= r0 + d; r++) {
      if (r < 0 || r >= BATHY_ROWS) continue;
      for (let c = c0 - d; c <= c0 + d; c++) {
        if (c < 0 || c >= BATHY_COLS) continue;
        if (tables.depth[r * BATHY_COLS + c] !== LAND_U16) continue;
        const ll = gridToLonlat(warp, c, r);
        if (ui.haversineM(lat, lon, ll.lat, ll.lon) <= ui.SHORE_RADIUS_M) return true;
      }
    }
    return false;
  }

  function sectorInfo(lat, lon) {
    return { name: ui.sectorFor(lat, lon, centroid), shore: isShoreCell(lat, lon) };
  }

  let map = null, overlay = null;
  let allFrames = [];     // every precomputed frame (frames.json order)
  let frames = [];        // the active horizon slice (48h = first 49, 15d = all)
  let windSeries = [];    // [{ tMs, speedMph, dirTrueDeg, bearingGrid, tEffH, gustMph }]
  let windTimesMs = [];
  let windMeta = null;    // wind.json models/fetched_at
  let stepMin = 60;
  let cur = 0;
  let nowTickIdx = null;  // now-index the hairline shows (null = hidden)
  let pinned = null;
  let pin = null;
  let playing = false;
  let timer = null;
  let builtMs = 0;
  let bootHidden = false;
  let readoutTimer = null;
  let mapReady = false;
  let showSeq = 0;        // bumps per showFrame; a stale await must not overwrite the UI
  let scheduleRefit = () => {}; // 6.3 item 2: assigned once the map exists (debounced fitLake)

  // Decoded .bin grids (one Float64Array of capped Hs ft per frame), LRU by file name.
  // The render cache below then keys per (idx, pin, W, H) exactly like v1.
  const rawCache = createFrameCache({
    max: RAW_FRAME_CACHE_MAX,
    sizeOf: (b) => (b ? b.length * 8 + 64 : 0),
  });

  // Fetch + dequantize one precomputed frame: 255 -> land (0), else v/32 ft.
  async function loadCapped(file) {
    const hit = rawCache.get(file);
    if (hit) return hit;
    const res = await fetch('data/' + file);
    if (!res.ok) throw new Error(`frame ${file} HTTP ${res.status}`);
    const u8 = new Uint8Array(await res.arrayBuffer());
    const out = new Float64Array(BATHY_CELLS);
    for (let i = 0; i < out.length; i++) {
      const v = u8[i] === undefined ? FRAME_NODATA : u8[i];
      out[i] = v === FRAME_NODATA ? 0 : v * FRAME_STEP_FT;
    }
    rawCache.set(file, out);
    return out;
  }

  // One-cell v1 recompute for roller steepness H/L at a frame's delayed wind. τ_cell =
  // F_cell / cg with the same blended-bearing fetch and CG_MPH as src/delay-math.mjs.
  function cellSteepness(e, cell) {
    const depthU = tables.depth[cell];
    const dLocalFt = depthU === LAND_U16 ? 0 : depthU * 0.25;
    const ci = coarseIndexFor(cell);
    // τ picks the arriving wind entry from the FRAME direction (delay-math); the field
    // itself is then blended at the SAMPLED entry's own direction — exactly how
    // computeDelayedField buckets that cell into an unchanged v1 computeField call.
    const Ftau = waveMath.blendFetch(tables, ci, e.bearingGrid);
    const tauH = (Ftau.F_m / M_PER_MI) / CG_MPH;
    const si = sampleWindIndex(windTimesMs, e.utcMs - tauH * 3600000);
    const w = si >= 0 ? windSeries[si] : null;
    const speedMph = w ? w.speedMph : 0;
    const tEffH = w ? w.tEffH : 0;
    const F = w ? waveMath.blendFetch(tables, ci, w.bearingGrid) : Ftau;
    const core = waveMath.waveCore(F.F_m, F.d_path_ft, dLocalFt,
      speedMph * 0.44704, tEffH * 3600, { fastDispersion: true });
    return { hsKs: core.Hs_after_Ks_ft, ts: core.T_s, hl: core.HL };
  }

  function setupMap() {
    if (mapReady) return;
    mapReady = true;
  map = L.map('map', {
    zoomControl: true,
    zoomSnap: 0.1,      // fractional zoom levels
    zoomDelta: 0.5,     // half-step on the +/- buttons
    touchZoom: true,
    zoomAnimation: true,
    wheelPxPerZoomLevel: 90,
    inertia: false, // 6.4 D1.1: no momentum — the release tail collapses to one fixed-duration recoil (SPEC §1.4)
    maxBoundsViscosity: 0.75, // 6.3 D2.3: rubber-band feel at the pan box edges
  });
  // 6B.4: drop Leaflet's default "Leaflet |" prefix — TILE_ATTRIBUTION carries its own
  // (shorter) Leaflet link, and the doubled credit was what made the string too wide.
  if (map.attributionControl) map.attributionControl.setPrefix(false);
  L.tileLayer(TILE_URL, {
    maxZoom: TILE_MAX_ZOOM, attribution: TILE_ATTRIBUTION, detectRetina: true,
  }).addTo(map);
  const llBounds = [[bounds.south, bounds.west], [bounds.north, bounds.east]];
  overlay = L.imageOverlay('data:image/gif;base64,R0lGODlhAQABAAAAACw=',
    llBounds, { opacity: OVERLAY_OPACITY }).addTo(map);
  // Auto-fit the lake edge-to-edge: no static setView/zoom, padding keeps the
  // east/west shorelines off the viewport edges on portrait phones.
  // 6B.2: reserve the LIVE header band (72 px of content + any notch inset) plus a
  // 12 px clearance, so the lake edge stays visible under the floating band on any
  // device instead of a hard-coded 84 px.
  const headerBand = () => Math.round((document.querySelector('header') || {}).getBoundingClientRect
    ? document.querySelector('header').getBoundingClientRect().height : 72);
  const lakeBounds = L.latLngBounds(llBounds);
  // 6.3: animate:false — the fit must be READ back synchronously (getZoom/getCenter below);
  // with zoomAnimation a resize refit would measure the previous viewport's fit and install
  // a stale minZoom floor (Trap 2).
  const fitOpts = { paddingTopLeft: [12, headerBand() + 12], paddingBottomRight: [12, 12], maxZoom: 12, animate: false };
  // 6.3 trap: getBoundsZoom reads getMinZoom as its clamp, so a shrink (rotation, chrome
  // appearing) with a floor already installed returns a zoom that crops the lake.
  // The setMinZoom(0)-before-measure / setMinZoom(fitZoom)-after order is load-bearing.
  const fitLake = () => {
    map.setMinZoom(0);                        // measure the fit free of our own floor
    map.fitBounds(llBounds, fitOpts);
    const fitZoom = map.getZoom();            // snapped, post-maxZoom(12)
    const fitCenter = map.getCenter();        // carries the header offset
    const halfLat = (lakeBounds.getNorth() - lakeBounds.getSouth()) * (1 + 2 * 0.20) / 2;
    const halfLng = (lakeBounds.getEast() - lakeBounds.getWest()) * (1 + 2 * 0.20) / 2;
    map.setMaxBounds(L.latLngBounds(         // pan box re-centred on the FITTED centre
      [fitCenter.lat - halfLat, fitCenter.lng - halfLng],
      [fitCenter.lat + halfLat, fitCenter.lng + halfLng]));
    map.setMinZoom(fitZoom);                  // zoom floor = this viewport's fit
    if (map.getZoom() < fitZoom) map.setZoom(fitZoom);
  };
  // 6.3 Trap 2: a resize/rotation moves the fit and would leave the floor stale.
  // 6.4 D1.4: if the debounce lands mid-pan, re-arm (bounded) so the refit still lands
  // after the gesture instead of being silently dropped.
  let refitTimer = null;
  let refitRearms = 0;
  scheduleRefit = () => {
    if (refitTimer) clearTimeout(refitTimer);
    refitRearms = 0;
    const attempt = () => {
      if (map && map.dragging && map.dragging.moving() && refitRearms < 40) {
        refitRearms++;
        refitTimer = setTimeout(attempt, 175);
        return;
      }
      fitLake();
    };
    refitTimer = setTimeout(attempt, 175);
  };
  fitLake();
  // The flex layout can settle after the first paint; refit once the container is real.
  requestAnimationFrame(() => map.invalidateSize());
  window.addEventListener('load', () => { fitLake(); map.invalidateSize(); scheduleRegather(); }, { once: true });
  map.on('click', (ev) => {
    if (!placePin(ev.latlng)) {
      dismissPin();
      flashReadout('land — no wave data here');
    }
  });
  map.on('zoomend', scheduleRegather);
  const d0 = desiredDims();
  canvas.width = d0.W;
  canvas.height = d0.H;
  }

  // Zoom-aware raster width: the lake's projected on-screen width grows with zoom,
  // and the viewport can grow on resize. Clamp via targetWidth.
  function overlayScreenWidth() {
    const z = map.getZoom();
    const nw = map.project(L.latLng(bounds.north, bounds.west), z);
    const se = map.project(L.latLng(bounds.south, bounds.east), z);
    const w = Math.abs(se.x - nw.x);
    return Number.isFinite(w) && w > 0 ? w : (mapEl.clientWidth || 384);
  }
  function desiredDims() {
    const css = Math.max(mapEl.clientWidth || 384, overlayScreenWidth());
    let w = playing ? playWidth(css) : targetWidth(css, dpr());
    if (dragRaster) w = Math.min(w, DRAG_RASTER_W); // 6.3 D3.5: cheaper raster while the finger is down
    return pickDisplayDims(bounds, w);
  }
  const frameCache = createFrameCache({
    max: FRAME_CACHE_MAX,
    onEvict: (key, entry) => { if (entry) revokeUrl(entry.url); },
  });

  // ---- stage 5G: deck-wide scrub surface + scrolling tape ----
  let viewportW = 0;      // #timeline width = the viewing window
  let scrubbing = false;
  let scrubPointerId = null;
  let scrubRaf = 0;
  let scrubX = 0;
  let scrubStartX = 0;
  let scrubStartIdx = 0;
  // Stage 5H: decoupled drag. UI runs every frame; the map paint is throttled.
  let dragIdx = null;          // newest index the map owes a paint (UI already shows it)
  let pendingPaintIdx = null;  // newest target stashed while throttled/busy
  let paintArmed = false;
  let paintRaf = 0;
  let lastMapPaintMs = 0;
  let paintGen = 0;            // bumped per committed paint; stale encodes are dropped
  let inFlightEncode = 0;      // convertToBlob calls not yet settled
  let lastOverlayUrl = null;   // overlay URL dedupe (cache hits re-apply the same blob:)
  // 6.3 D3.5: drag-class raster. Set on the first drag-move that schedules a paint; a tap
  // never flips it, so the rest dims survive. Restored before the pointerup settle render.
  let dragRaster = false;
  let suspendStartMs = 0;     // 6.4 D2.2: start of the current suspension (valve clock)
  let stickyHead = null;       // 5L: wide (48h) day header, clamped in writeTape
  let scrubPos = null;         // v2: continuous frame position under the reticle mid-drag

  // Cached once per gesture / on layout change; never read in the move path.
  function refreshRailRect() {
    viewportW = timeline.getBoundingClientRect().width;
  }

  // Re-place the now hairline from the stored now-index (safe to call after width changes).
  // The hairline lives INSIDE the tape, so it scrolls in and out of view naturally.
  function placeNowTick() {
    if (nowTickIdx == null || !frames.length || !viewportW) return;
    nowTick.style.left = `${nowTickIdx * framePx(horizon, viewportW)}px`;
  }

  // Single writer for the tape transform: centre the active frame under the fixed reticle.
  // 5L: also clamps the wide day header to the window's left edge so it stays visible.
  function applyTapeTransform(tx) {
    trackTape.style.transform = 'translateX(' + tx + 'px)';
    if (stickyHead) {
      const want = Math.max(6, (-tx) + STICKY_INSET - stickyHead.blockLeft);
      if (stickyHead.el.style.left !== want + 'px') stickyHead.el.style.left = want + 'px';
    }
  }
  // idx may be fractional: the drag path feeds a continuous frame position so the tape
  // follows the finger 1:1, while the map still paints the nearest whole frame.
  function writeTape(idx) {
    if (!viewportW) return;
    applyTapeTransform(tapeTranslate(idx, framePx(horizon, viewportW), viewportW / 2));
  }

  // Stage 5H §C1: overlay URL dedupe — cache hits re-apply the same blob: URL today.
  function setOverlayUrl(url) {
    if (!url || url === lastOverlayUrl) return;
    lastOverlayUrl = url;
    overlay.setUrl(url);
  }
  // A different W×H is a different image even if the URL string repeats.
  function resetOverlayDedupe() { lastOverlayUrl = null; }

  // 6.3: move the canvas to the class desiredDims() now reports (drag vs rest raster).
  function applyDesiredDims() {
    const d = desiredDims();
    if (d.W === canvas.width && d.H === canvas.height) return;
    canvas.width = d.W;
    canvas.height = d.H;
    resetOverlayDedupe(); // same URL at a new W×H is a different image
  }

  // Stage 5H §B1: UI-only drag step. Cheap by construction — text + one transform.
  function scrubUiTo(idx) {
    dragIdx = idx;
    updateScrubUi(idx);
    scheduleMapPaint(idx);
  }

  // v2: continuous frame-position drag. The tape translate takes the fractional position
  // (no sub-frame snapping of the gesture) while the pill/map use the nearest frame.
  function scrubUiToPos(pos) {
    scrubPos = pos;
    const idx = Math.max(0, Math.min(frames.length - 1, Math.round(pos)));
    dragIdx = idx;
    updateScrubUi(idx, pos);
    scheduleMapPaint(idx);
  }

  // Stage 5H §B2: throttled map repaint. Newest index always wins; at most one build in
  // flight (busy skip). Re-arms via rAF until the gate opens or the encode settles.
  // 6.4 D2.1: a live scrub suspends encodes outright (D2.2's valve is the only exception).
  function scheduleMapPaint(idx) {
    pendingPaintIdx = idx;
    if (paintArmed) return;
    paintArmed = true;
    paintRaf = requestAnimationFrame(() => {
      paintRaf = 0;
      paintArmed = false;
      const target = pendingPaintIdx;
      pendingPaintIdx = null;
      if (target == null) return;
      // 6.3: the target may already be on screen (a clamped drag, or a drag that came back to
      // the start). 6.2's cache + overlay-dedupe made this a no-op; the drag raster class
      // changes the cache key, so skip explicitly instead of burning a redundant encode.
      if (target === cur) return;
      const now = performance.now();
      const busy = inFlightEncode > 0;
      if (scrubbing) {
        // 6.4 D2.1: no encodes while a scrub is live. The valve (D2.2) opens exactly one
        // anti-freeze paint per SUSPEND_MAX_MS of continuous suspension.
        if (!suspendStartMs) suspendStartMs = now;
        if (now - suspendStartMs < SUSPEND_MAX_MS) { scheduleMapPaint(target); return; }
        suspendStartMs = now; // valve fired: fall through to one paint
      } else if (busy || !shouldPaintMap(now, lastMapPaintMs, busy, MAP_PAINT_MIN_MS)) {
        scheduleMapPaint(target); // busy or gate closed: re-arm with the newest target
        return;
      }
      if (busy) { scheduleMapPaint(target); return; } // valve paint still waits out an in-flight encode
      lastMapPaintMs = now;
      paintGen++;
      showFrame(target, paintGen);
    });
  }

  function cancelMapPaint() {
    pendingPaintIdx = null;
    if (paintRaf) { cancelAnimationFrame(paintRaf); paintRaf = 0; }
    paintArmed = false;
  }

  // Solid segmented day blocks at real width: alternating shades, midnight divider, day
  // headers and the full 3 h sub-row. Blocks are date-string derived; each is sized from
  // its own frame run, so uneven days still tile exactly.
  // 5K: exactly one header per day block, pinned at the block's start on the wide 24 h
  // block (one "Saturday 12" on the tape) and centred on the narrow 7 d blocks.
  // 5L: the wide header is sticky — writeTape() clamps it to the window's left edge.
  function renderTimeline() {
    trackDays.textContent = '';
    trackTicks.textContent = '';
    stickyHead = null;
    trackLabel.textContent = horizon === '15d' ? '15 day' : '48 h';
    if (!frames.length || !viewportW) return;
    const n = frames.length;
    const pxf = framePx(horizon, viewportW);
    trackTape.style.width = `${n * pxf}px`;
    const parts = dayPartitions(frames);
    for (let k = 0; k < parts.length; k++) {
      const start = parts[k].index;
      const end = k + 1 < parts.length ? parts[k + 1].index : n;
      const left = start * pxf;
      const w = Math.max(1, (end - start) * pxf);
      const block = document.createElement('div');
      block.className = 'day-block' + (k % 2 ? ' alt' : '');
      block.style.left = `${left}px`;
      block.style.width = `${w}px`;
      const head = document.createElement('span');
      head.className = 'day-head';
      if (w > 275) {
        head.style.left = '6px';
        head.style.transform = 'none';
        stickyHead = { el: head, blockLeft: left }; // wide 48h block is sticky
      }
      head.textContent = ui.dayLabel(parts[k].date, true);
      block.appendChild(head);
      // v2: ticks live at real frame times. Frames are hourly (48h) or 3-hourly (15d),
      // so a 3h tick exists only where a frame's local minute is :00 and hour % 3 === 0.
      const hourly = [];
      for (let i = start; i < end; i++) {
        const e = frames[i];
        if (!e) continue;
        const hh = +e.time.slice(11, 13), mm = +e.time.slice(14, 16);
        const onTick = mm === 0 && hh % 3 === 0;
        if (onTick) {
          const sub = document.createElement('span');
          sub.className = 'day-sub' + (hh === 0 ? ' edge' : '');
          if (i === start) {
            sub.style.left = '3px';
            sub.style.transform = 'none';
          } else {
            sub.style.left = `${Math.max(6, Math.min(w - 6, (i - start) * pxf))}px`;
          }
          sub.textContent = String((hh % 12) || 12).padStart(2, '0');
          block.appendChild(sub);
        }
        if (mm === 0 && Number.isFinite(e.speedMph)) hourly.push(e.speedMph);
      }
      const heat = document.createElement('div');
      heat.className = 'day-heat';
      heat.setAttribute('aria-hidden', 'true');
      heat.style.backgroundImage = ui.windHeatGradient(hourly);
      block.appendChild(heat);
      // 5P: three-hourly wind labels embedded in the ribbon, at the same anchors as ticks.
      for (let i = start; i < end; i++) {
        const e = frames[i];
        if (!e) continue;
        const hh = +e.time.slice(11, 13), mm = +e.time.slice(14, 16);
        if (mm !== 0 || hh % 3 !== 0 || !Number.isFinite(e.speedMph)) continue;
        const wind = document.createElement('span');
        wind.className = 'day-wind';
        if (i === start) {
          wind.style.left = '3px';
          wind.style.transform = 'none';
        } else {
          wind.style.left = `${Math.max(6, Math.min(w - 6, (i - start) * pxf))}px`;
        }
        wind.textContent = String(Math.round(e.speedMph));
        block.appendChild(wind);
      }
      trackDays.appendChild(block);
    }
  }

  // Re-render on resize (debounced); the rail rect is refreshed by the caller first.
  let timelineTimer = null;
  function scheduleTimeline() {
    if (timelineTimer) clearTimeout(timelineTimer);
    timelineTimer = setTimeout(() => { timelineTimer = null; renderTimeline(); }, 100);
  }

  // Single feedback helper, called by showFrame (play + programmatic) and by scrub.
  // The pill is permanent and fixed: only its text changes; the tape moves underneath.
  function updateScrubUi(idx, pos) {
    if (!frames.length || !viewportW) return;
    const e = frames[idx];
    const text = ui.formatPillTime(e.time);
    if (timePill.textContent !== text) timePill.textContent = text;
    trackEl.setAttribute('aria-valuenow', String(idx));
    trackEl.setAttribute('aria-valuetext',
      `${ui.formatClockLocal(e.time)}, ${ui.dayLabel(e.time, true)}`);
    updateWeatherDetail(e);
    writeTape(pos == null ? idx : pos);
  }

  deck.addEventListener('pointerdown', (e) => {
    if (!frames.length) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    if (e.target.closest('button, [role=button], a, input')) return;
    e.preventDefault();
    refreshRailRect();
    scrubbing = true;
    scrubPointerId = e.pointerId;
    dragIdx = null;
    const wasPlaying = playing;
    if (wasPlaying) pause(); // capture only; never auto-resume
    deck.setPointerCapture(e.pointerId);
    scrubStartX = e.clientX;
    scrubStartIdx = cur;
    // v2: the drag baseline is the frame position, so the offset is continuous from the
    // first pointermove (the gesture never snaps; the map paints the nearest frame).
    scrubPos = cur;
    // 6.4 D3.2: the drag-start trigger queues a neighbour warm, which runs when idle
    // (prefetchNeighbours no-ops while the gesture is live).
    schedulePrefetchNeighbours();
    trackTape.style.transition = 'none'; // drag follows the finger 1:1
  });
  deck.addEventListener('pointermove', (e) => {
    if (!scrubbing || e.pointerId !== scrubPointerId) return;
    scrubX = e.clientX;
    if (scrubRaf) return;
    scrubRaf = requestAnimationFrame(() => {
      scrubRaf = 0;
      if (!scrubbing) return;
      // A real drag-move switches to the cheap drag raster; a tap never reaches here.
      if (!dragRaster) { dragRaster = true; applyDesiredDims(); }
      // v2: continuous frame-position drag. One pixel of tape is one frame step; the tape
      // translate takes the fractional position, the map the nearest whole frame.
      const pxf = framePx(horizon, viewportW);
      const maxPos = Math.max(0, frames.length - 1);
      const pos = Math.max(0, Math.min(maxPos, scrubStartIdx - (scrubX - scrubStartX) / pxf));
      // 5H: UI-only step (zero drag latency); the map catches up on its own throttle.
      scrubUiToPos(pos);
    });
  });
  function endScrub(e) {
    if (!scrubbing || (e && e.pointerId !== scrubPointerId)) return;
    scrubbing = false;
    scrubPointerId = null;
    trackTape.style.transition = ''; // restore the playback glide
    // 5H §B3: snap to the exact final frame, bypassing throttle + busy skip. v2: the
    // continuous frame position is dropped here, so the tape glides from where the finger
    // left it to the nearest frame (the .32 s CSS transition is already restored above).
    scrubPos = null;
    suspendStartMs = 0; // 6.4 D2.2: release the valve clock for the next gesture
    // 6.3 D3.5: restore the rest raster class before the full-width settle render.
    if (dragRaster) { dragRaster = false; applyDesiredDims(); }
    if (dragIdx != null && frames.length) {
      cancelMapPaint();
      paintGen++; // invalidate any drag encode still in flight
      lastMapPaintMs = performance.now();
      showFrame(dragIdx, paintGen);
      dragIdx = null;
      // 6.4 D3.2: settle paint done; warm the released index's neighbours while idle. Delayed by
      // 250 ms so the warm-up builds cannot compete with the settle's own cold build + encode/
      // decode window (measured 2026-09-14: 150.2 ms to the settle's visible paint with the
      // warm-up inside that window vs 12.4 ms without).
      setTimeout(schedulePrefetchNeighbours, 250);
    }
  }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    deck.addEventListener(type, endScrub);
  }

  trackEl.addEventListener('keydown', (e) => {
    if (!frames.length) return;
    let idx;
    switch (e.key) {
      case 'ArrowLeft': idx = cur - 1; break;
      case 'ArrowRight': idx = cur + 1; break;
      case 'PageUp': idx = cur + 4; break;
      case 'PageDown': idx = cur - 4; break;
      case 'Home': idx = 0; break;
      case 'End': idx = frames.length - 1; break;
      default: return;
    }
    e.preventDefault();
    pause();
    requestFrame(Math.max(0, Math.min(frames.length - 1, idx)));
  });

  // Snapshot of the frame the overlay is currently showing; the async encode compares against it.
  function currentMeta() {
    return { idx: cur, pinIdx: pinned ? pinned.i : -1, W: canvas.width, H: canvas.height };
  }

  async function frameFor(idx, gen) {
    if (!frames.length) return null;
    const frameEntry = frames[idx];
    if (!frameEntry) return null;
    const W = canvas.width, H = canvas.height;
    const pinIdx = pinned ? pinned.i : -1;
    const key = cacheKey(idx, pinIdx, W, H);
    const hit = frameCache.get(key);
    if (hit) return hit;
    const t0 = performance.now();
    let capped;
    try {
      capped = await loadCapped(frameEntry.file);
    } catch (err) {
      console.error(err);
      showNote('wind unavailable — retry', () => showFrame(cur));
      return null;
    }
    const raster = gatherRaster(capped, warp, W, H);
    const landFrac = landMaskRaster(warp, tables, W, H);
    const smooth = smoothRaster(raster, landFrac, W, H);
    const p10Ft = ui.p10(capped);
    let maxIdx = 0, maxHs = 0;
    for (let i = 0; i < capped.length; i++) {
      if (capped[i] > maxHs) { maxHs = capped[i]; maxIdx = i; }
    }
    const dPeak = tables.depth[maxIdx] === LAND_U16 ? 0 : tables.depth[maxIdx] * 0.25;
    const peak = gridToLonlat(warp, maxIdx % BATHY_COLS, Math.floor(maxIdx / BATHY_COLS));
    const steep = cellSteepness(frameEntry, maxIdx);
    const stats = {
      maxHs, maxIdx, rollerFt: hmaxFt(maxHs, dPeak), hlMax: steep.hl,
      p10Ft, peakLat: peak.lat, peakLon: peak.lon, entry: frameEntry,
    };
    const pinVals = pinned ? cellSteepness(frameEntry, pinned.i) : null;
    const entry = { url: null, stats, pinVals };
    frameCache.set(key, entry);
    const meta = { idx, pinIdx, W, H };
    let pending = null;
    if (offscreenSupported()) {
      pending = encodeOffscreen(smooth, W, H, landFrac); // raster paint is sync; PNG encode is not
    } else {
      paintRaster(cctx, smooth, W, H, landFrac); // fallback: old synchronous path
      entry.url = canvas.toDataURL();
    }
    const ms = performance.now() - t0;
    builtMs += ms;
    body.dataset.precomputeMs = builtMs.toFixed(1);
    body.dataset.frameMs = ms.toFixed(1);
    if (pending) {
      inFlightEncode++;
      const e0 = performance.now();
      pending.then((url) => {
        body.dataset.encodeMs = (performance.now() - e0).toFixed(1);
        if (!frameCache.has(key)) { revokeUrl(url); return; } // evicted while encoding
        entry.url = url;
        if (gen != null && gen !== paintGen) return; // 5H §C2: scrubbed past -> drop
        if (shouldPaintResult(meta, currentMeta())) setOverlayUrl(url); // skip a stale result
      }).catch((err) => { console.error(err); }).finally(() => {
        inFlightEncode--;
        // Busy settled: paint the newest stashed drag target now.
        if (pendingPaintIdx != null) scheduleMapPaint(pendingPaintIdx);
      });
    }
    return entry;
  }

  function setCardField(name, value) {
    const el = card.querySelector(`[data-field="${name}"] .v`);
    if (el) el.textContent = value;
  }

  async function updatePinned() {
    if (!pinned || !frames.length) return;
    const pinnedCell = pinned.i;
    const built = await frameFor(cur);
    if (!pinned || pinned.i !== pinnedCell || !built || !built.pinVals) return;
    const d = tables.depth[pinned.i] * 0.25;
    const hsKs = built.pinVals.hsKs, ts = built.pinVals.ts;
    const hs = Math.min(hsKs, 0.6 * d);
    const hm = hmaxFt(hsKs, d);
    const L_m = waveMath.dispersionFast(ts, d * waveMath.FT).L_m;
    const spot = ui.nameSpot(pinned.latlng.lat, pinned.latlng.lng, features,
      sectorInfo(pinned.latlng.lat, pinned.latlng.lng));
    setCardField('spot', ui.describePin(spot));
    setCardField('coords', `${pinned.latlng.lat.toFixed(4)}, ${pinned.latlng.lng.toFixed(4)}`);
    setCardField('depth', `${d.toFixed(1)} ft`);
    setCardField('hs', `${hs.toFixed(1)} ft`);
    setCardField('hmax', `${hm.toFixed(1)} ft`);
    setCardField('hl', (hsKs * waveMath.FT / L_m).toFixed(3));
    card.dataset.spot = spot.name || spot.kind;
  }

  function placePin(latlng) {
    pause();
    const g = lonlatToGrid(warp, latlng.lng, latlng.lat);
    const c = Math.round(g.col), r = Math.round(g.row);
    if (c < 0 || r < 0 || c >= BATHY_COLS || r >= BATHY_ROWS) return false;
    const i = r * BATHY_COLS + c;
    if (tables.depth[i] === LAND_U16) return false;
    pinned = { latlng, i };
    frameCache.clear(); // cache key includes pinIdx
    if (pin) pin.setLatLng(latlng);
    else pin = L.circleMarker(latlng, {
      radius: 6, color: '#ffffff', weight: 2, fillColor: '#FF00AA', fillOpacity: 1,
    }).addTo(map);
    card.hidden = false;
    updatePinned();
    return true;
  }

  function dismissPin() {
    if (pin) { map.removeLayer(pin); pin = null; }
    pinned = null;
    frameCache.clear();
    card.hidden = true;
  }

  async function showFrame(idx, gen) {
    if (!frames.length) return;
    const target = Math.max(0, Math.min(frames.length - 1, idx));
    const seq = ++showSeq;
    cur = target;
    const built = await frameFor(target, gen);
    if (seq !== showSeq) return; // a newer showFrame superseded this one
    if (!built) return;
    const s = built.stats, e = s.entry;
    if (built.url) setOverlayUrl(built.url); // null while the async encode is in flight
    if (!bootHidden) { bootHidden = true; hideBoot(); }
    body.dataset.hour = e.time;
    body.dataset.stepMin = String(stepMin);
    body.dataset.hsFt = s.maxHs.toFixed(3);
    body.dataset.hmaxFt = s.rollerFt.toFixed(3);
    body.dataset.p10Ft = s.p10Ft.toFixed(3);
    body.dataset.windMph = Number(e.speedMph).toFixed(1);
    body.dataset.bearingGrid = e.bearingGrid.toFixed(3);
    body.dataset.teffH = e.tEffH.toFixed(2);
    // During a drag the tape UI is owned by the continuous scrub path; only the map paints.
    if (!scrubbing) updateScrubUi(cur);
    else updateWeatherDetail(e);
    // 6.2: two-badge row — lake (tier-tinted) + gust, each carrying its own unit. The
    // shore series is still ingested and kept on hand, it is simply not displayed.
    const pills = ui.windPills(e.speedMph, null, e.gustMph);
    lakeEl.textContent = pills.lake;
    gustEl.textContent = pills.gust;
    pillGustEl.setAttribute('aria-label', 'Gust ' + pills.gust + ' mph');
    pillLakeEl.setAttribute('aria-label', `Lake wind ${pills.lake} mph`);
    pillLakeEl.style.setProperty('--tint', pills.lakeTint);
    pillLakeEl.style.setProperty('--tint-bd', pills.lakeBorder);
    const c = ui.compass(e.dirTrueDeg, e.speedMph);
    if (c.arrowDeg == null) {
      badgeArrow.style.display = 'none';
      badgeText.textContent = 'Calm';
      windBadge.setAttribute('aria-label', 'Wind calm');
    } else {
      badgeArrow.style.display = 'block';
      badgeArrow.style.transform = `rotate(${c.arrowDeg}deg)`; // downwind flow vector
      badgeText.textContent = `From ${c.sector} ${c.degText}`;
      windBadge.setAttribute('aria-label',
        `Wind from ${c.sector} at ${Math.round(c.fromDeg)} degrees, ` +
        `blowing toward ${Math.round(c.arrowDeg)} degrees`);
    }
    const tier = ui.comfortTier({ maxHsFt: s.maxHs, rollerFt: s.rollerFt, hlMax: s.hlMax,
      windMph: e.speedMph });
    comfortChip.className = `tier-${tier.key}`;
    comfortChip.textContent = tier.label;
    const headline = ui.formatHeadline({
      p10Ft: s.p10Ft, maxHsFt: s.maxHs, rollerFt: s.rollerFt,
      peakLat: s.peakLat, peakLon: s.peakLon,
      features, sector: sectorInfo(s.peakLat, s.peakLon),
    });
    verdictRange.textContent = headline.range;
    verdictPeak.textContent = headline.peak;
    if (pinned) updatePinned();
    if (playing && frames.length > 1) prefetch(nextPlayIdx(cur, playStep(horizon), frames.length));
  }

  // Warm the next play frame during idle time so the 3 fps loop never waits on a cold build.
  function prefetch(idx) {
    if (!playing || !frames.length) return;
    const run = () => { if (playing) frameFor(idx); };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 200 });
    else setTimeout(run, 0);
  }

  // 6.4 D3.2: warm the neighbours of the shown index so the next scrub/settle is not a cold build.
  // Never builds while a gesture is live — a 23-41 ms cold build would eat the frame budget the
  // suspension exists to protect; the drag-start trigger therefore queues and runs when idle.
  function prefetchNeighbours() {
    if (!frames.length || scrubbing || playing) return;
    for (let i = cur - 1; i <= cur + 1; i++) {
      if (i >= 0 && i < frames.length && i !== cur) frameFor(i);
    }
  }
  function schedulePrefetchNeighbours() {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(prefetchNeighbours, { timeout: 400 });
    else setTimeout(prefetchNeighbours, 0);
  }

  // rAF-coalesced: many input/tick events collapse into one render of the LATEST index.
  let pendingIdx = null;
  let rafId = 0;
  function requestFrame(idx) {
    pendingIdx = idx;
    if (rafId) return;
    rafId = requestAnimationFrame(() => {
      rafId = 0;
      const i = pendingIdx;
      pendingIdx = null;
      if (i != null) showFrame(i);
    });
  }

  function setPlaying(on) {
    const was = playing;
    playing = !!on;
    playBtn.setAttribute('aria-pressed', playing ? 'true' : 'false');
    playBtn.dataset.state = playing ? 'pause' : 'play';
    if (playing) {
      regather(); // switch to the play-width class before the first tick
      timer = setInterval(() => {
        if (!frames.length) return;
        requestFrame(nextPlayIdx(cur, playStep(horizon), frames.length));
      }, PLAY_INTERVAL_MS);
    } else if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // Back to the full zoom-aware width, debounced so a quick play/pause does not thrash.
    if (was && !playing) scheduleRegather();
  }
  function pause() { if (playing) setPlaying(false); }

  // Re-gather at the zoom-aware width, debounced; the old image stays visible until ready.
  // The cache key carries the dims, so full and play classes coexist without a clear.
  let regatherTimer = null;
  function regather() {
    const d = desiredDims();
    if (d.W === canvas.width && d.H === canvas.height) return;
    canvas.width = d.W;
    canvas.height = d.H;
    resetOverlayDedupe(); // same URL at a new W×H is a different image
    if (frames.length) showFrame(cur);
  }
  function scheduleRegather() {
    if (regatherTimer) clearTimeout(regatherTimer);
    regatherTimer = setTimeout(regather, 150);
  }

  function flashReadout(msg) {
    readout.textContent = msg;
    if (readoutTimer) clearTimeout(readoutTimer);
    readoutTimer = setTimeout(() => { readout.textContent = DEFAULT_HINT; }, 2000);
  }
  document.addEventListener('visibilitychange', () => { if (document.hidden) pause(); });
  playBtn.addEventListener('click', () => setPlaying(!playing));
  document.getElementById('card-close').addEventListener('click', dismissPin);
  // 6.2: the ? explainer and its popover were removed with the shore pill — the two
  // badges are self-labelling, so there is no popover to open, close, focus or trap.
  // A width change moves the rail mapping: re-place the hairline/playhead + day label.
  function resyncTrackUi() {
    updateScrubUi(cur);
    placeNowTick();
  }
  window.addEventListener('resize', () => { refreshRailRect(); scheduleRegather(); scheduleTimeline(); resyncTrackUi(); scheduleRefit(); });
  window.addEventListener('orientationchange', () => { refreshRailRect(); scheduleTimeline(); resyncTrackUi(); scheduleRefit(); });
  // test hook: same handler the map click uses
  window.__bpcTap = (lat, lon) => placePin(L.latLng(lat, lon));

  // ---- v2 forecast: precomputed frame index + merged wind series (no client compute) ----
  // Rebuild the worker's hourly series from wind.json so client-side verdict/steepness math
  // reads the SAME t_eff and grid bearing the worker used (wind.computeTeff, dtH = 1 h).
  function buildWindSeries(windJson) {
    const hours = (windJson && windJson.hours) || [];
    const raw = hours.map((h) => {
      const dir = Number(h.dir);
      return {
        time: h.t,
        tMs: Date.parse(h.t),
        speedMph: Number(h.speed),
        gustMph: h.gust == null ? null : Number(h.gust),
        dirTrueDeg: dir,
        tempF: h.temp, precipMm: h.precip, src: h.src,
        bearingGrid: wind.gammaToGrid(dir, gamma),
      };
    });
    const teff = wind.computeTeff(raw, 1);
    for (let i = 0; i < raw.length; i++) raw[i].tEffH = teff[i];
    return raw;
  }

  function updateDataAge() {
    if (!dataAgeEl || !windMeta) return;
    const src = { hrrr: 'HRRR', aifs: 'AIFS', ifs: 'IFS' };
    const near = src[windMeta.wind_near] || src[windMeta.wind_mid] || 'model';
    const fetched = Date.parse(windMeta.fetched_at);
    const ageH = Number.isFinite(fetched) ? (Date.now() - fetched) / 3600000 : NaN;
    let age = '—';
    if (Number.isFinite(ageH)) age = ageH < 1 ? 'just now' : `${Math.round(ageH)}h ago`;
    dataAgeEl.textContent = `updated ${age} (${near})`;
  }

  // ---- P3 weather strip ---------------------------------------------------------------
  // 15 day-cells from the merged hourly series (hi/lo °F, precip in, max wind mph).
  function renderWeatherCells() {
    if (!weatherDays || !windSeries.length) return;
    weatherDays.textContent = '';
    // 360 h opens at 00Z (the prior evening in Chicago), so local grouping yields one
    // leading partial bucket; the 15-day strip is the trailing 15 local days (run day on).
    const days = dailySummaries(windSeries).slice(-15);
    for (const d of days) {
      const cell = document.createElement('div');
      cell.className = 'wx-day';
      cell.dataset.date = d.date;
      const lines = [
        ['wx-day-h', ui.dayLabel(d.date).toUpperCase()],
        ['wx-day-t', `${d.hiF == null ? '—' : Math.round(d.hiF)}°/${d.loF == null ? '—' : Math.round(d.loF)}°`],
        ['wx-day-p', `${d.precipIn.toFixed(2)} in`],
        ['wx-day-w', d.maxWindMph == null ? '— mph' : `${Math.round(d.maxWindMph)} mph`],
      ];
      for (const [cls, text] of lines) {
        const span = document.createElement('span');
        span.className = cls;
        span.textContent = text;
        cell.appendChild(span);
      }
      weatherDays.appendChild(cell);
    }
  }

  // Honest provenance of the merged series (wind.json models), shown once.
  function updateWeatherLabels() {
    if (!weatherLabels || !windMeta) return;
    const near = windMeta.wind_near || '—';
    const mid = windMeta.wind_mid || '—';
    weatherLabels.textContent = `wind ${near}/${mid} · gusts ${windMeta.gusts || 'none'}`;
  }

  // Selected-hour detail for the scrubbed frame: temp / precip (in) / gust + sources.
  function updateWeatherDetail(e) {
    if (!weatherDetail) return;
    if (!e) { weatherDetail.textContent = '—'; return; }
    const temp = Number.isFinite(e.tempF) ? `${Math.round(e.tempF)}°F` : '—';
    const precip = Number.isFinite(e.precipMm) ? `${(e.precipMm / 25.4).toFixed(2)} in` : '—';
    const gust = e.gustMph == null
      ? 'gust —'
      : `gust ${Math.round(e.gustMph)} mph ${(windMeta && windMeta.gusts) || ''}`.trim();
    weatherDetail.textContent =
      `${ui.dayLabel(e.time, true)} ${ui.formatPillTime(e.time)} · ${temp} · ${precip} · ${gust} · src ${e.src || '—'}`;
    const sel = String(e.time || '').slice(0, 10);
    for (const c of (weatherDays ? weatherDays.children : [])) c.classList.toggle('sel', c.dataset.date === sel);
  }

  // Cache-bust the two index files so a fresh open never reads a stale manifest; the
  // per-frame .bin fetches stay plain (the SW caches them with a query-less key).
  async function loadForecast() {
    const cb = Date.now();
    const [fj, wj] = await Promise.all([
      fetchJson(`data/frames.json?cb=${cb}`),
      fetchJson(`data/wind.json?cb=${cb}`),
    ]);
    windSeries = buildWindSeries(wj);
    windTimesMs = windSeries.map((w) => w.tMs);
    windMeta = Object.assign({}, wj.models, { fetched_at: wj.fetched_at });
    allFrames = ((fj && fj.frames) || []).map((f) => {
      const utcMs = Date.parse(f.t);
      const si = sampleWindIndex(windTimesMs, utcMs);
      const w = si >= 0 ? windSeries[si] : null;
      return {
        file: f.file, utcMs,
        time: chicagoLocalIso(f.t),
        speedMph: w ? w.speedMph : 0,
        gustMph: w ? w.gustMph : null,
        dirTrueDeg: w ? w.dirTrueDeg : 0,
        bearingGrid: w ? w.bearingGrid : 0,
        tEffH: w ? w.tEffH : 0,
        tempF: w ? w.tempF : null,
        precipMm: w ? w.precipMm : null,
        src: w ? w.src : null,
      };
    });
    updateDataAge();
    renderWeatherCells();
    updateWeatherLabels();
  }

  // Re-slice the in-memory frame set for the active horizon (48h = first 49 hourly frames;
  // 15d = every frame). Zero network on the toggle path.
  function applyForecast() {
    frames = horizon === '15d' ? allFrames : allFrames.slice(0, 49);
    builtMs = 0;
    frameCache.clear();
    const d = desiredDims();
    if (d.W !== canvas.width || d.H !== canvas.height) {
      canvas.width = d.W; canvas.height = d.H; resetOverlayDedupe();
    }
    console.info(`precomputed frames: ${frames.length} of ${allFrames.length}`);
    trackEl.setAttribute('aria-valuemax', String(Math.max(0, frames.length - 1)));
    refreshRailRect();
    renderTimeline();
    nowTickIdx = null;
    nowTick.hidden = true;
    let start = 0;
    if (frames.length) {
      const now = Date.now();
      for (let i = 0; i < frames.length; i++) if (frames[i].utcMs <= now) start = i;
      if (q.has('hour')) {
        const hh = String(parseInt(q.get('hour'), 10)).padStart(2, '0');
        const k = frames.findIndex((e) => e.time.slice(11, 13) === hh);
        if (k >= 0) start = k;
      } else if (q.has('frame')) {
        const k = parseInt(q.get('frame'), 10);
        if (Number.isFinite(k)) start = Math.max(0, Math.min(frames.length - 1, k));
      } else {
        nowTickIdx = start;
        nowTick.hidden = false;
        placeNowTick();
      }
    }
    showFrame(start);
  }

  // Retry path: the map data stays decoded; only the forecast index is refetched.
  async function refreshData() {
    hideNote();
    boot('Loading forecast…', null);
    try {
      await loadForecast();
      applyForecast();
    } catch (err) {
      console.error(err);
      hideBoot();
      showNote('wind unavailable — retry', refreshData);
    }
  }

  function setHorizon(h) {
    if (horizon === h) return;
    pause();
    persistHorizon(h);
    setHorizonPressed(h);
    if (allFrames.length) applyForecast();
    else renderTimeline();
  }

  h48Btn.addEventListener('click', () => setHorizon('48h'));
  h15Btn.addEventListener('click', () => setHorizon('15d'));
  setHorizonPressed(horizon);
  persistHorizon(horizon); // resolved horizon -> storage + URL (replaceState)

  // Full boot: map data first (streamed), then the precomputed forecast. Each retries itself.
  async function bootMap() {
    hideNote();
    try {
      await loadMapData();
    } catch (err) {
      console.error(err);
      hideBoot();
      showNote('map data failed — retry', bootMap);
      return;
    }
    setupMap();
    await refreshData();
  }

  document.getElementById('refresh').addEventListener('click', refreshData);
  await bootMap();
}

module.exports = {
  SCALE_FT, TILE_URL, TILE_ATTRIBUTION, TILE_MAX_ZOOM, OVERLAY_OPACITY, PLAY_INTERVAL_MS,
  FRAME_MINUTES, FRAME_CACHE_MAX, PLAY_MAX_WIDTH,
  gridToLonlat, lonlatToGrid, displayBounds, pickDisplayDims, targetWidth, playWidth,
  bilinearSample, gatherRaster, hmaxFt, computeFrame, paintRaster,
  landMaskRaster, smoothRaster, cacheKey, frameBytes, createFrameCache, mount,
  offscreenSupported, revokeUrl, shouldPaintResult, shouldPaintMap, encodeOffscreen,
  pxPerDay, pxPerFrame, framesPerDay, framePx, tapeTranslate, idxFromDrag, dayPartitions,
  playStep, nextPlayIdx, pxPerMinute, minutesFromDrag, tapeTranslateMinutes, idxFromMinutes,
  tickWinds, sampleWindIndex, coarseIndexFor, chicagoLocalIso, dailySummaries,
};
