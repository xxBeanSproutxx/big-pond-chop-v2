'use strict';
// Wave math core — SPM 1984 (3-39)/(3-40) + shoaling. Units are in every symbol.

const G = 9.81;
const FT = 0.3048;
const LAND_U16 = 65535;
const FETCH_ROWS = 98;
const FETCH_COLS = 95;
const { fetchIndex, BATHY_ROWS, BATHY_COLS, BATHY_CELLS } = require('./tables');

// ---- tanh lookup table (linear interp, error < 1e-6) ----
const TANH_N = 20001;
const TANH_LO = -10;
const TANH_INV = (TANH_N - 1) / 20;
const TANH = new Float64Array(TANH_N);
for (let i = 0; i < TANH_N; i++) TANH[i] = Math.tanh(TANH_LO + i / TANH_INV);

function tanhLUT(x) {
  if (x <= TANH_LO) return -1;
  if (x >= -TANH_LO) return 1;
  const t = (x - TANH_LO) * TANH_INV;
  const i = Math.min(TANH_N - 2, Math.floor(t));
  const f = t - i;
  return TANH[i] + f * (TANH[i + 1] - TANH[i]);
}

function tanhExact(x) {
  return Math.tanh(x);
}

// ---- dispersion relation: omega^2 = g k tanh(k h), solve k by bisection ----
function dispersionExact(T_s, h_m, tanhf) {
  const w = 2 * Math.PI / T_s;
  let lo = 1e-5;
  let hi = 50;
  for (let i = 0; i < 120; i++) {
    const k = 0.5 * (lo + hi);
    if (G * k * tanhf(k * h_m) - w * w > 0) hi = k;
    else lo = k;
  }
  const k = 0.5 * (lo + hi);
  const kh = k * h_m;
  const n = 0.5 * (1 + 2 * kh / Math.sinh(2 * kh));
  return { cg_mps: n * (w / k), L_m: 2 * Math.PI / k };
}

// ---- dispersion LUT over (T, h) for the hot field loop ----
const T_LO = 0.2, T_HI = 12, T_N = 400;
const H_LO = 0.05, H_HI = 15, H_N = 200;
const T_INV = (T_N - 1) / (T_HI - T_LO);
const H_INV = (H_N - 1) / (H_HI - H_LO);
// ponytail: 50 bisection iterations in a 400x200 table; build is ~100 ms once,
// exact enough (k > 1e-12) for the 0.01 ft parity budget.
const CG_LUT = new Float64Array(T_N * H_N);
const L_LUT = new Float64Array(T_N * H_N);
(function buildDispersionLUT() {
  for (let ti = 0; ti < T_N; ti++) {
    const T_s = T_LO + (T_HI - T_LO) * ti / (T_N - 1);
    const w = 2 * Math.PI / T_s;
    for (let hi = 0; hi < H_N; hi++) {
      const h_m = H_LO + (H_HI - H_LO) * hi / (H_N - 1);
      let lo = 1e-5;
      let up = 50;
      for (let i = 0; i < 50; i++) {
        const k = 0.5 * (lo + up);
        if (G * k * Math.tanh(k * h_m) - w * w > 0) up = k;
        else lo = k;
      }
      const k = 0.5 * (lo + up);
      const kh = k * h_m;
      const n = 0.5 * (1 + 2 * kh / Math.sinh(2 * kh));
      CG_LUT[ti * H_N + hi] = n * (w / k);
      L_LUT[ti * H_N + hi] = 2 * Math.PI / k;
    }
  }
})();

function dispersionFast(T_s, h_m) {
  let t = (T_s - T_LO) * T_INV;
  t = t < 0 ? 0 : t > T_N - 1 ? T_N - 1 : t;
  const ti = Math.min(T_N - 2, Math.floor(t));
  const tf = t - ti;
  let hh = (h_m - H_LO) * H_INV;
  hh = hh < 0 ? 0 : hh > H_N - 1 ? H_N - 1 : hh;
  const hi = Math.min(H_N - 2, Math.floor(hh));
  const hf = hh - hi;
  const i00 = ti * H_N + hi;
  const i10 = i00 + H_N;
  const a = CG_LUT[i00] * (1 - hf) + CG_LUT[i00 + 1] * hf;
  const b = CG_LUT[i10] * (1 - hf) + CG_LUT[i10 + 1] * hf;
  const c = L_LUT[i00] * (1 - hf) + L_LUT[i00 + 1] * hf;
  const d = L_LUT[i10] * (1 - hf) + L_LUT[i10 + 1] * hf;
  return { cg_mps: a * (1 - tf) + b * tf, L_m: c * (1 - tf) + d * tf };
}

// ---- SPM fetch/duration-limited growth (evaluated once) ----
function spm(U_mps, F_m, d_path_ft, t_eff_s, tanhf) {
  const U_A = 0.71 * Math.pow(U_mps, 1.23);
  const F_used_m = Math.min(F_m, U_A * t_eff_s);
  const Fstar = G * F_used_m / (U_A * U_A);
  const hstar = G * (d_path_ft * FT) / (U_A * U_A);
  const P1 = tanhf(0.530 * Math.pow(hstar, 0.75));
  const P2 = tanhf(0.833 * Math.pow(hstar, 0.375));
  const Hs_m = 0.283 * (U_A * U_A / G) * P1 * tanhf(0.00565 * Math.sqrt(Fstar) / P1);
  const T_s = 7.54 * (U_A / G) * P2 * tanhf(0.0379 * Math.cbrt(Fstar) / P2);
  return { U_A, F_used_m, Hs_m, T_s };
}

// ---- full point model (used for parity / spot queries) ----
function waveCore(F_m, d_path_ft, d_local_ft, U_mps = 13.4112, t_eff_s = 28800, opts = {}) {
  const tanhf = opts.exactTanh ? tanhExact : tanhLUT;
  const s = spm(U_mps, F_m, d_path_ft, t_eff_s, tanhf);
  const dp = opts.fastDispersion
    ? dispersionFast(s.T_s, d_path_ft * FT)
    : dispersionExact(s.T_s, d_path_ft * FT, tanhf);
  const dl = opts.fastDispersion
    ? dispersionFast(s.T_s, d_local_ft * FT)
    : dispersionExact(s.T_s, d_local_ft * FT, tanhf);
  const Ks = Math.min(1.6, Math.max(0.7, Math.sqrt(dp.cg_mps / dl.cg_mps)));
  const Hs_ft = s.Hs_m / FT;
  const Hs_after_Ks_ft = Hs_ft * Ks;
  return {
    Hs_ft,
    T_s: s.T_s,
    Ks,
    Hs_after_Ks_ft,
    capped_ft: Math.min(Hs_after_Ks_ft, 0.6 * d_local_ft),
    roller_ft: Math.min(1.67 * Hs_after_Ks_ft, 0.78 * d_local_ft),
    HL: (Hs_after_Ks_ft * FT) / dl.L_m,
  };
}

// ---- stage 2: direction blending (no snapping) ----
// bearing_grid in [0,360) -> the two nearest of the 16 table bearings and the
// interpolation weight toward the upper one.
function blendDir(bearingGridDeg) {
  const b = bearingGridDeg / 22.5;
  const f = Math.floor(b);
  const i0 = ((f % 16) + 16) % 16;
  const i1 = (i0 + 1) % 16;
  return { i0, i1, w: b - f };
}

// Blend F_eff and path depth at one coarse (98x95) cell for a grid bearing.
function blendFetch(tables, coarseIndex, bearingGridDeg) {
  const { fetchEff, pathEff } = tables;
  const { i0, i1, w } = blendDir(bearingGridDeg);
  const nc = FETCH_ROWS * FETCH_COLS;
  const a = i0 * nc + coarseIndex;
  const b = i1 * nc + coarseIndex;
  const fa = fetchEff[a], fb = fetchEff[b];
  const Fa = fa === LAND_U16 ? 0 : fa * 10;
  const Fb = fb === LAND_U16 ? 0 : fb * 10;
  const Da = fa === LAND_U16 ? 0 : pathEff[a];
  const Db = fb === LAND_U16 ? 0 : pathEff[b];
  return { F_m: Fa + w * (Fb - Fa), d_path_ft: Da + w * (Db - Da) };
}

// ---- per-hour field over all 83,220 bathy cells ----
// memoized: wave params depend only on the 9,310 coarse fetch cells; depth (Ks)
// varies per bathy cell, so only the depth term is recomputed 83,220 times.
// opts.blend: blend the two nearest bearings (default false = stage-1 snap).
// opts.t_eff_s: duration input in seconds (default 28800 = 8 h).
// opts.gamma: grid convergence for blending, degrees (default 0).
// opts.outAfterKs / opts.outTs: optional per-bathy-cell outputs (post-Ks Hs ft,
// period s) used by the stage-2 display for Hmax and H/L.
function computeField(tables, windMph, windDirDeg, out, opts = {}) {
  const { depth, fetchEff, pathEff } = tables;
  const blend = !!opts.blend;
  const t_eff_s = opts.t_eff_s != null ? opts.t_eff_s : 28800;
  const gamma = opts.gamma || 0;
  const outAfterKs = opts.outAfterKs;
  const outTs = opts.outTs;
  const U_mps = windMph * 0.44704;
  const U_A = 0.71 * Math.pow(U_mps, 1.23);
  const dstar = G * FT / (U_A * U_A);
  const Fdurd = U_A * t_eff_s;

  let dirA, dirB, wB;
  if (blend) {
    const bg = ((windDirDeg - gamma) % 360 + 360) % 360;
    const d = blendDir(bg);
    dirA = d.i0;
    dirB = d.i1;
    wB = d.w;
  } else {
    dirA = ((Math.round(windDirDeg / 22.5) % 16) + 16) % 16;
    dirB = dirA;
    wB = 0;
  }
  const offA = dirA * FETCH_ROWS * FETCH_COLS;
  const offB = dirB * FETCH_ROWS * FETCH_COLS;

  const nc = FETCH_ROWS * FETCH_COLS;
  const cellHs_ft = new Float64Array(nc);
  const cellTi = new Int32Array(nc);
  const cellTf = new Float64Array(nc);
  const cellDpCg = new Float64Array(nc);
  const cellT_s = outTs ? new Float64Array(nc) : null;
  for (let c = 0; c < nc; c++) {
    let F_m, d_path_ft;
    if (blend) {
      const fa = fetchEff[offA + c], fb = fetchEff[offB + c];
      const Fa = fa === LAND_U16 ? 0 : fa * 10;
      const Fb = fb === LAND_U16 ? 0 : fb * 10;
      const Da = fa === LAND_U16 ? 0 : pathEff[offA + c];
      const Db = fb === LAND_U16 ? 0 : pathEff[offB + c];
      F_m = Fa + wB * (Fb - Fa);
      d_path_ft = Da + wB * (Db - Da);
    } else {
      const fu = fetchEff[offA + c];
      if (fu === LAND_U16) continue; // cellHs_ft stays 0
      F_m = fu * 10;
      d_path_ft = pathEff[offA + c];
    }
    if (F_m <= 0 || d_path_ft <= 0) continue;
    const F_used_m = F_m < Fdurd ? F_m : Fdurd;
    const Fstar = G * F_used_m / (U_A * U_A);
    const hstar = dstar * d_path_ft;
    const P1 = tanhLUT(0.530 * Math.pow(hstar, 0.75));
    const P2 = tanhLUT(0.833 * Math.pow(hstar, 0.375));
    cellHs_ft[c] = (0.283 * (U_A * U_A / G) * P1 * tanhLUT(0.00565 * Math.sqrt(Fstar) / P1)) / FT;
    const T_s = 7.54 * (U_A / G) * P2 * tanhLUT(0.0379 * Math.cbrt(Fstar) / P2);
    if (cellT_s) cellT_s[c] = T_s;
    let t = (T_s - T_LO) * T_INV;
    t = t < 0 ? 0 : t > T_N - 1 ? T_N - 1 : t;
    const ti = Math.min(T_N - 2, Math.floor(t));
    cellTi[c] = ti;
    cellTf[c] = t - ti;
    let hh = (d_path_ft * FT - H_LO) * H_INV;
    hh = hh < 0 ? 0 : hh > H_N - 1 ? H_N - 1 : hh;
    const hi = Math.min(H_N - 2, Math.floor(hh));
    const hf = hh - hi;
    const i00 = ti * H_N + hi;
    const i10 = i00 + H_N;
    const a = CG_LUT[i00] * (1 - hf) + CG_LUT[i00 + 1] * hf;
    const b = CG_LUT[i10] * (1 - hf) + CG_LUT[i10 + 1] * hf;
    cellDpCg[c] = a * (1 - cellTf[c]) + b * cellTf[c];
  }

  const rowRc = new Int32Array(BATHY_ROWS);
  for (let row = 0; row < BATHY_ROWS; row++) {
    let rc = Math.trunc((row - 1) / 3);
    rowRc[row] = rc < 0 ? 0 : rc > 97 ? 97 : rc;
  }
  const colCc = new Int32Array(BATHY_COLS);
  for (let col = 0; col < BATHY_COLS; col++) {
    let cc = Math.trunc((col - 1) / 3);
    colCc[col] = cc < 0 ? 0 : cc > 94 ? 94 : cc;
  }

  const target = out || new Float64Array(BATHY_CELLS);
  let i = 0;
  for (let row = 0; row < BATHY_ROWS; row++) {
    const base = rowRc[row] * FETCH_COLS;
    for (let col = 0; col < BATHY_COLS; col++, i++) {
      const du = depth[i];
      const d_local_ft = du * 0.25;
      if (du === LAND_U16) {
        target[i] = 0;
        if (outAfterKs) outAfterKs[i] = 0;
        if (outTs) outTs[i] = 0;
        continue;
      }
      const c = base + colCc[col];
      const Hs_ft = cellHs_ft[c];
      if (Hs_ft === 0) {
        target[i] = 0;
        if (outAfterKs) outAfterKs[i] = 0;
        if (outTs) outTs[i] = 0;
        continue;
      }
      let hh = (d_local_ft * FT - H_LO) * H_INV;
      hh = hh < 0 ? 0 : hh > H_N - 1 ? H_N - 1 : hh;
      const hi = Math.min(H_N - 2, Math.floor(hh));
      const hf = hh - hi;
      const ti = cellTi[c];
      const tf = cellTf[c];
      const i00 = ti * H_N + hi;
      const i10 = i00 + H_N;
      const a = CG_LUT[i00] * (1 - hf) + CG_LUT[i00 + 1] * hf;
      const b = CG_LUT[i10] * (1 - hf) + CG_LUT[i10 + 1] * hf;
      const cgl = a * (1 - tf) + b * tf;
      const Ks = Math.min(1.6, Math.max(0.7, Math.sqrt(cellDpCg[c] / cgl)));
      const hs_after_ks = Hs_ft * Ks;
      target[i] = Math.min(hs_after_ks, 0.6 * d_local_ft);
      if (outAfterKs) outAfterKs[i] = hs_after_ks;
      if (outTs) outTs[i] = cellT_s ? cellT_s[c] : 0;
    }
  }
  return target;
}

module.exports = {
  G, FT, tanhLUT, tanhExact, dispersionExact, dispersionFast, spm, waveCore,
  computeField, blendDir, blendFetch, fetchIndex,
};
