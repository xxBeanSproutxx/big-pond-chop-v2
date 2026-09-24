'use strict';
// Stage 4A frame-pipeline benchmark (Node-only, no DOM).
// Run: node tools/bench_frames.js
// Gates: ms/frame @384 <= 15, ms/frame @780 <= 30, LRU peak bytes @780 <= 8 MB.
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { performance } = require('perf_hooks');
const { decodeTables, BATHY_CELLS } = require('../src/tables');
const render = require('../src/render');
const ui = require('../src/ui');

const ROOT = path.join(__dirname, '..');
const GAMMA = -0.474;
const N = 96;
const MB = 1024 * 1024;

const tables = decodeTables(fs.readFileSync(path.join(ROOT, 'public', 'tables.v1.bin')));
const warp = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'warp.v1.json'), 'utf8'));
const bounds = render.displayBounds(warp);

const pad = (n) => String(n).padStart(2, '0');
const day = [];
for (let i = 0; i < N; i++) {
  const a = (2 * Math.PI * i) / N;
  day.push({
    time: `2026-09-11T${pad(Math.floor(i / 4))}:${pad((i % 4) * 15)}`,
    speedMph: 12 + 10 * Math.sin(a),
    gustMph: 16 + 12 * Math.sin(a),
    dirTrueDeg: (315 + 60 * Math.sin(a) + 360) % 360,
    tEffH: 4 + 2 * Math.sin(a),
  });
}

function colorize(raster, buf) {
  for (let k = 0, p = 0; k < raster.length; k++, p += 4) {
    const c = ui.colorForHs(raster[k]);
    buf[p] = c[0]; buf[p + 1] = c[1]; buf[p + 2] = c[2]; buf[p + 3] = c[3];
  }
}

// stage: 0 math, 1 +gather, 2 +smooth, 3 +colorize
function oneLoop(d, stage, colorBuf) {
  const scratch = {
    out: new Float64Array(BATHY_CELLS),
    afterKs: new Float64Array(BATHY_CELLS),
    ts: new Float64Array(BATHY_CELLS),
  };
  for (let n = 0; n < day.length; n++) {
    const f = render.computeFrame(tables, day[n], { gamma: GAMMA, ...scratch });
    if (stage < 1) continue;
    const raster = render.gatherRaster(f.capped, warp, d.W, d.H);
    if (stage < 2) continue;
    const landFrac = render.landMaskRaster(warp, tables, d.W, d.H);
    const smooth = render.smoothRaster(raster, landFrac, d.W, d.H);
    if (stage < 3) continue;
    colorize(smooth, colorBuf);
  }
}

function bench(d, stage, colorBuf) {
  oneLoop(d, stage, colorBuf); // warm-up (fills land-mask cache)
  const t0 = performance.now();
  oneLoop(d, stage, colorBuf);
  return (performance.now() - t0) / day.length;
}

const d384 = render.pickDisplayDims(bounds, 384);
const d780 = render.pickDisplayDims(bounds, 780);
const buf780 = new Uint8ClampedArray(d780.W * d780.H * 4);

const rows = [
  ['(a) math only', '384', bench(d384, 0)],
  ['(b) + gather', '384', bench(d384, 1)],
  ['(c) + gather', '780', bench(d780, 1)],
  ['(d) + smooth', '780', bench(d780, 2)],
  ['(e) + colorize', '780', bench(d780, 3, buf780)],
];

console.log('\nStage 4A frame pipeline (96 frames, ms)');
console.log('  stage                       width   ms/frame   96-frame');
for (const [label, width, ms] of rows) {
  console.log(`  ${label.padEnd(27)} ${width.padStart(5)}   ${ms.toFixed(2).padStart(8)}   ${(ms * N).toFixed(1).padStart(8)}`);
}

// LRU peak bytes at 780: a realistic data-URL payload (deflate + base64 of the
// colorized RGBA frame) cached at max 8 entries.
const url = `data:image/png;base64,${zlib.deflateSync(Buffer.from(buf780)).toString('base64')}`;
const cache = render.createFrameCache({ max: 8 });
for (let i = 0; i < N; i++) {
  cache.set(render.cacheKey(i, -1, d780.W, d780.H), { url, stats: {}, pinVals: null });
}
const peak = cache.peakBytes;
console.log(`\n  LRU peak bytes @780        : ${peak} (${(peak / MB).toFixed(2)} MB, url ${url.length} chars, max 8)`);

const ms384 = rows[1][2];
const ms780 = rows[4][2];
const fails = [];
if (ms384 > 15) fails.push(`ms/frame @384 ${ms384.toFixed(2)} > 15`);
if (ms780 > 30) fails.push(`ms/frame @780 ${ms780.toFixed(2)} > 30`);
if (peak > 8 * MB) fails.push(`LRU peak ${(peak / MB).toFixed(2)} MB > 8 MB`);

if (fails.length) {
  console.log(`\nFAIL: ${fails.join('; ')}`);
  process.exit(1);
}
console.log('\nPASS');
