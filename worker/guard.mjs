// worker/guard.mjs — pure, testable worker seams: payload parsing, the model decision,
// frame quantization, and the single artifact-write path (gated on that decision).
// No network, no globals: compute.mjs does the fetching, this does the deciding.

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { BATHY_CELLS, LAND_U16 } = require('../src/tables.js');

export const num = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));

// Open-Meteo hourly -> tagged rows, dropping the null window (A7: HRRR pads ~340 nulls).
export function rows(json, { gust = false } = {}) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    const speedMph = num(h.wind_speed_10m?.[i]);
    const dirTrueDeg = num(h.wind_direction_10m?.[i]);
    if (speedMph == null || dirTrueDeg == null) continue;
    out.push({
      t: h.time[i],
      speedMph,
      dirTrueDeg,
      gustMph: gust ? num(h.wind_gusts_10m?.[i]) : null,
      tempF: num(h.temperature_2m?.[i]),
      precipMm: num(h.precipitation?.[i]),
    });
  }
  return out;
}

// IFS returns gusts only (no speed/dir), so it gets its own extractor.
export function gustRows(json) {
  const h = json && json.hourly;
  if (!h || !Array.isArray(h.time)) return [];
  const out = [];
  for (let i = 0; i < h.time.length; i++) {
    const gustMph = num(h.wind_gusts_10m?.[i]);
    if (gustMph != null) out.push({ t: h.time[i], gustMph });
  }
  return out;
}

// A4: AIFS is the base model — all-null/failed means NO writes, last-good stays.
export function decideModels({ near = [], mid = [], ifs = [] } = {}) {
  if (!mid.length) return { write: false, hrrrOk: false, ifsOk: false, reason: 'aifs-all-null' };
  return { write: true, hrrrOk: near.length > 0, ifsOk: ifs.length > 0, reason: 'ok' };
}

// A3 .bin mapping: min(254, round(Hs_ft × 32)); 255 = land/nodata.
export function quantize(capped, depth) {
  const out = new Uint8Array(BATHY_CELLS);
  for (let i = 0; i < BATHY_CELLS; i++) {
    if (depth[i] === LAND_U16) { out[i] = 255; continue; }
    const v = Math.round(capped[i] * 32);
    out[i] = v < 0 ? 0 : v > 254 ? 254 : v;
  }
  return out;
}

// The ONLY artifact write path. A non-write decision is a hard no-op: the worker never
// touches data/ when the guard rejects the payload (last-good artifacts stay live).
export function writeArtifacts(dataDir, { framesJson, windJson, bins }, decision) {
  if (!decision || !decision.write) return { wrote: false };
  fs.mkdirSync(dataDir, { recursive: true });
  const wanted = new Set(framesJson.frames.map((f) => f.file));
  for (const f of fs.readdirSync(dataDir)) {
    if (/^f\d{3}\.bin$/.test(f) && !wanted.has(f)) fs.unlinkSync(path.join(dataDir, f));
  }
  for (let i = 0; i < bins.length; i++) fs.writeFileSync(path.join(dataDir, framesJson.frames[i].file), bins[i]);
  fs.writeFileSync(path.join(dataDir, 'frames.json'), JSON.stringify(framesJson));
  fs.writeFileSync(path.join(dataDir, 'wind.json'), JSON.stringify(windJson));
  return { wrote: true, frames: bins.length };
}
