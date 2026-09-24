// src/delay-math.mjs — delay-aware wind ("lake memory"). The ONE new algorithm.
//
// v1 reacted to wind shifts instantly: F_used = min(F_eff, U_A·t_eff). Physically the
// waves arriving at a cell now were generated further up-wind at an earlier time.
// v2 offsets the merged hourly wind series by the travel time of the arriving energy:
//
//     τ_cell = F_cell / cg,   cg = CG_MPH   (cgs ≈ 11 mph, the calibration knob)
//
// Per cell per frame the series is sampled with a zero-order hold at t − τ_cell, then
// cells are bucketed by sampled series index and each bucket runs the UNCHANGED v1
// computeField (src/wave-math.js). All reef physics — SPM growth, Ks, breaking — stays
// in v1; this module only decides WHICH wind state each cell reads.
//
// τ choice: F_cell is the blended-bearing effective fetch in metres for the frame's
// wind direction, via the same v1 waveMath.blendFetch the field pass uses, so delay and
// field share one fetch definition. Direction drift over τ ≤ 1.3 h is small; the frame
// direction is the arriving-direction proxy (single pass, no fixed-point solve).
//
// ponytail: zero-order-hold bucketing assumes τ ≲ a few hours, so one frame collapses
// to ≤ ~3 distinct sampled wind states (τ_max ≈ 1.3 h here). If τ ever grows or the
// series drops to 15-min steps, switch the hold to an interpolated sample (linear in
// speed/t_eff, shortest-arc in direction) instead of duplicating computeField per index.

import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const waveMath = require('./wave-math.js');
const {
  BATHY_ROWS, BATHY_COLS, BATHY_CELLS, FETCH_ROWS, FETCH_COLS,
} = require('./tables.js');

export const CG_MPH = 11;        // calibration knob: cgs ≈ 11 mph group speed
export const M_PER_MI = 1609.344;

// Travel time for an arriving wave over fetch F (metres), in hours.
export function tauHours(F_m, cgMph = CG_MPH) {
  return (F_m / M_PER_MI) / cgMph;
}

// Zero-order hold: index of the last series entry with time ≤ queryMs (0 if before start).
export function sampleIndex(timesMs, queryMs) {
  if (!timesMs.length) return -1;
  if (queryMs < timesMs[0]) return 0;
  let lo = 0, hi = timesMs.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (timesMs[mid] <= queryMs) lo = mid; else hi = mid - 1;
  }
  return lo;
}

let CELL_COARSE = null;

// Bathy (285×292) cell -> coarse (95×98) fetch cell, the exact mapping computeField uses.
function cellCoarse() {
  if (CELL_COARSE) return CELL_COARSE;
  const m = new Int32Array(BATHY_CELLS);
  let i = 0;
  for (let row = 0; row < BATHY_ROWS; row++) {
    let rc = Math.trunc((row - 1) / 3);
    rc = rc < 0 ? 0 : rc > FETCH_ROWS - 1 ? FETCH_ROWS - 1 : rc;
    const base = rc * FETCH_COLS;
    for (let col = 0; col < BATHY_COLS; col++, i++) {
      let cc = Math.trunc((col - 1) / 3);
      cc = cc < 0 ? 0 : cc > FETCH_COLS - 1 ? FETCH_COLS - 1 : cc;
      m[i] = base + cc;
    }
  }
  CELL_COARSE = m;
  return m;
}

// Blended effective fetch (metres) for every coarse fetch cell at one grid bearing.
export function coarseFetchM(tables, bearingGridDeg) {
  const nc = FETCH_ROWS * FETCH_COLS;
  const out = new Float64Array(nc);
  for (let c = 0; c < nc; c++) out[c] = waveMath.blendFetch(tables, c, bearingGridDeg).F_m;
  return out;
}

// One frame's delay-aware field.
//   series: [{ tMs, speedMph, dirTrueDeg, tEffH }, ...] ascending
//   tMs:    frame valid time (ms)
//   opts:   { gamma, out, outAfterKs, outTs, frameIndex, frameDirDeg, timesMs, delay, cgMph }
// delay:false pins every cell to the frame's own series entry — the v1 path.
export function computeDelayedField(tables, series, tMs, opts = {}) {
  const delay = opts.delay !== false;
  const gamma = opts.gamma || 0;
  const cgMph = opts.cgMph != null ? opts.cgMph : CG_MPH;
  const capped = opts.out || new Float64Array(BATHY_CELLS);
  const afterKs = opts.outAfterKs || new Float64Array(BATHY_CELLS);
  const ts = opts.outTs || new Float64Array(BATHY_CELLS);
  const timesMs = opts.timesMs || series.map((e) => e.tMs);

  const picked = new Int32Array(BATHY_CELLS);
  if (delay) {
    const bg = (((opts.frameDirDeg - gamma) % 360) + 360) % 360;
    const cf = coarseFetchM(tables, bg);
    const map = cellCoarse();
    for (let i = 0; i < BATHY_CELLS; i++) {
      const q = tMs - tauHours(cf[map[i]], cgMph) * 3600000;
      picked[i] = sampleIndex(timesMs, q);
    }
  } else {
    picked.fill(opts.frameIndex | 0);
  }

  // Bucket cells by sampled series index; each bucket = one UNCHANGED v1 computeField.
  const buckets = new Map();
  for (let i = 0; i < BATHY_CELLS; i++) {
    const si = picked[i];
    if (buckets.has(si)) continue;
    const e = series[si];
    const b = {
      capped: new Float64Array(BATHY_CELLS),
      afterKs: new Float64Array(BATHY_CELLS),
      ts: new Float64Array(BATHY_CELLS),
    };
    waveMath.computeField(tables, e.speedMph, e.dirTrueDeg, b.capped, {
      blend: true, t_eff_s: e.tEffH * 3600, gamma, outAfterKs: b.afterKs, outTs: b.ts,
    });
    buckets.set(si, b);
  }
  for (let i = 0; i < BATHY_CELLS; i++) {
    const b = buckets.get(picked[i]);
    capped[i] = b.capped[i];
    afterKs[i] = b.afterKs[i];
    ts[i] = b.ts[i];
  }
  return { capped, afterKs, ts, buckets: buckets.size };
}
