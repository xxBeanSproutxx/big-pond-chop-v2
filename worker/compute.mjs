#!/usr/bin/env node
// big-pond-chop v2 precompute worker (P0/P1).
// Fetch HRRR + AIFS (+ IFS gusts) -> one hourly series -> delay-aware Hs frames -> data/.
// No deps; Node 22 ESM; v1 CJS engine loaded via createRequire.
//
//   node worker/compute.mjs
//   BPC_DELAY=0 node worker/compute.mjs   # v1 instant-onset path (P0 behaviour)
//
// Guard policy (A4): AIFS all-null/failed -> no writes, exit 0 (last-good stays).
// HRRR dead -> AIFS-only, labels flip honestly. IFS dead -> gusts null past HRRR.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { computeDelayedField, CG_MPH } from '../src/delay-math.mjs';
import { rows, gustRows, decideModels, quantize, writeArtifacts } from './guard.mjs';

const require = createRequire(import.meta.url);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DATA = path.join(ROOT, 'data');

const { decodeTables, BATHY_COLS, BATHY_ROWS } =
  require(path.join(ROOT, 'src', 'tables.js'));
const { computeTeff, gammaToGrid } = require(path.join(ROOT, 'src', 'wind.js'));

// Delay-aware wind ON by default; BPC_DELAY=0 restores the v1 instant-onset path.
const DELAY = process.env.BPC_DELAY !== '0';

const POINT = { lat: 46.22, lon: -93.657 };
const BASE = 'latitude=46.22&longitude=-93.657&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC';
const URLS = {
  hrrr: `https://api.open-meteo.com/v1/gfs?${BASE}&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation&models=gfs_hrrr&past_hours=12&forecast_days=2`,
  aifs: `https://api.open-meteo.com/v1/forecast?${BASE}&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation&models=ecmwf_aifs025_single&forecast_days=15`,
  ifs: `https://api.open-meteo.com/v1/forecast?${BASE}&hourly=wind_gusts_10m&models=ecmwf_ifs025&forecast_days=10`,
};
const UA = 'big-pond-chop-v2-worker/1.0 (+https://github.com/xxBeanSproutxx/big-pond-chop-v2)';
const HOUR_MS = 3600 * 1000;

const stamp = (v) => {
  const s = String(v);
  return new Date(/[Zz]$/.test(s) ? s : s + (s.length <= 16 ? ':00Z' : 'Z')).getTime();
};

// 3 tries, 30 s apart. A dead model is a null, never a crash.
async function fetchJson(url, label) {
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': UA } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } catch (e) {
      console.error(`[${label}] attempt ${attempt}/3 failed: ${e.message}`);
      if (attempt < 3) await new Promise((r) => setTimeout(r, 30000));
    }
  }
  return null;
}

async function main() {
  const ts = Date.now();
  const gamma = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'meta.v1.json'), 'utf8')).gamma_deg;
  const [hrrrRaw, aifsRaw, ifsRaw] = await Promise.all([
    fetchJson(URLS.hrrr, 'hrrr'),
    fetchJson(URLS.aifs, 'aifs'),
    fetchJson(URLS.ifs, 'ifs'),
  ]);

  const near = rows(hrrrRaw, { gust: true });    // winds + gusts + temp + precip
  const mid = rows(aifsRaw);                     // winds + temp + precip (no gusts)
  const ifs = gustRows(ifsRaw);                 // gusts only
  console.log(`[fetch] hrrr ${near.length} non-null, aifs ${mid.length} non-null, ifs ${ifs.length} non-null`);

  const decision = decideModels({ near, mid, ifs });
  if (!decision.write) {
    console.error(`[guard] ${decision.reason} -> no artifact writes, last-good stays, exit 0`);
    process.exit(0);
  }
  if (!decision.hrrrOk) console.error('[guard] HRRR all-null or failed -> AIFS-only, labels flip');
  if (!decision.ifsOk) console.error('[guard] IFS all-null or failed -> gusts null past HRRR window');

  // ---- merge: AIFS base, HRRR overrides where non-null; IFS fills gaps in gusts ----
  const byT = new Map();
  for (const e of mid) byT.set(e.t, { ...e, src: 'aifs' });
  for (const e of near) byT.set(e.t, { ...e, src: 'hrrr' });
  if (decision.ifsOk) {
    const gustAt = new Map(ifs.map((e) => [e.t, e.gustMph]));
    for (const e of byT.values()) if (e.gustMph == null && gustAt.get(e.t) != null) e.gustMph = gustAt.get(e.t);
  }
  const series = [...byT.values()].sort((a, b) => stamp(a.t) - stamp(b.t));

  // t_eff persistence over the whole merged hourly series (dtH = 1), then sampled per frame.
  const ordered = series.map((e) => ({ ...e, bearingGrid: gammaToGrid(e.dirTrueDeg, gamma) }));
  const teff = computeTeff(ordered, 1);
  series.forEach((e, i) => { e.tEffH = teff[i]; e.tMs = stamp(e.t); });
  const timesMs = series.map((e) => e.tMs);
  console.log(`[merge] ${series.length} hourly entries ${series[0].t} .. ${series[series.length - 1].t}`);

  // ---- frame plan (A1): hourly +0..+48 h, then 3-hourly to last AIFS hour (cap +360 h) ----
  const f0 = Math.floor(ts / HOUR_MS) * HOUR_MS;
  const firstIdx = series.findIndex((e) => stamp(e.t) >= f0);
  if (firstIdx < 0) { console.error('[guard] no series entry at/after run hour, exit 0'); process.exit(0); }
  const f0ms = stamp(series[firstIdx].t);
  const lastAifs = stamp(mid[mid.length - 1].t);
  const lastOffset = Math.min(Math.round((lastAifs - f0ms) / HOUR_MS), 360);
  const offsets = [];
  for (let k = 0; k <= 48; k++) offsets.push(k);
  for (let k = 51; k <= lastOffset; k += 3) offsets.push(k);
  const frameAt = new Map(series.map((e, i) => [stamp(e.t), { e, idx: i }]));
  const plan = [];
  for (const k of offsets) {
    const hit = frameAt.get(f0ms + k * HOUR_MS);
    if (hit) plan.push({ t: f0ms + k * HOUR_MS, e: hit.e, idx: hit.idx });
  }
  console.log(`[plan] f0=${new Date(f0ms).toISOString()} last=+${lastOffset}h frames=${plan.length} delay=${DELAY ? 'on' : 'off'} cg=${CG_MPH} mph`);

  // ---- compute ----
  const tables = decodeTables(fs.readFileSync(path.join(ROOT, 'public', 'tables.v1.bin')));
  const capped = new Float64Array(BATHY_ROWS * BATHY_COLS);
  const afterKs = new Float64Array(capped.length);
  const tsOut = new Float64Array(capped.length);
  const bins = [];
  let totalBytes = 0;
  const tCompute = performance.now();
  for (const p of plan) {
    computeDelayedField(tables, series, p.t, {
      gamma, out: capped, outAfterKs: afterKs, outTs: tsOut,
      frameIndex: p.idx, frameDirDeg: p.e.dirTrueDeg, timesMs, delay: DELAY,
    });
    const bytes = quantize(capped, tables.depth);
    bins.push(bytes);
    totalBytes += bytes.length;
  }
  const computeMs = performance.now() - tCompute;
  console.log(`[compute] ${plan.length} frames in ${(computeMs / 1000).toFixed(2)}s (${(computeMs / plan.length).toFixed(1)} ms/frame)`);

  const nowIso = new Date().toISOString();
  const framesJson = {
    generated_at: nowIso,
    dims: { cols: BATHY_COLS, rows: BATHY_ROWS },
    scale: { min_ft: 0, step_ft: 0.03125, nodata: 255 },
    frames: plan.map((p, i) => ({ i, t: new Date(p.t).toISOString(), file: `f${String(i).padStart(3, '0')}.bin` })),
  };
  const windJson = {
    fetched_at: nowIso,
    point: POINT,
    models: {
      wind_near: decision.hrrrOk ? 'hrrr' : 'aifs',
      wind_mid: 'aifs',
      gusts: decision.hrrrOk ? (decision.ifsOk ? 'hrrr+ifs' : 'hrrr') : (decision.ifsOk ? 'ifs' : null),
    },
    hours: series.map((e) => ({
      t: new Date(stamp(e.t)).toISOString(),
      speed: e.speedMph, dir: e.dirTrueDeg, gust: e.gustMph,
      temp: e.tempF, precip: e.precipMm, src: e.src,
    })),
  };

  const res = writeArtifacts(DATA, { framesJson, windJson, bins }, decision);
  console.log(`[write] frames=${res.frames} bytes=${totalBytes} wind_hours=${windJson.hours.length} -> data/`);
}

main().catch((e) => { console.error(`[fatal] ${e.stack || e}`); process.exit(1); });
