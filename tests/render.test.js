'use strict';
// Stage 2 display tests: affine round-trip, blend continuity, roller definition.
// Run: node tests/render.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { decodeTables, BATHY_ROWS, BATHY_COLS } = require('../src/tables');
const { waveCore, blendFetch, FT } = require('../src/wave-math');
const {
  gridToLonlat, lonlatToGrid, gatherRaster, hmaxFt, computeFrame, paintRaster,
  TILE_URL, TILE_ATTRIBUTION, TILE_MAX_ZOOM, OVERLAY_OPACITY, PLAY_INTERVAL_MS,
  FRAME_MINUTES, targetWidth, landMaskRaster, smoothRaster,
  cacheKey, frameBytes, createFrameCache,
  playWidth, PLAY_MAX_WIDTH, revokeUrl, shouldPaintResult, shouldPaintMap, offscreenSupported,
  pxPerDay, pxPerFrame, tapeTranslate, idxFromDrag, dayPartitions, playStep, nextPlayIdx,
  pxPerMinute, minutesFromDrag, tapeTranslateMinutes, idxFromMinutes,
  tickWinds,
} = require('../src/render');
const ui = require('../src/ui');

const ROOT = path.join(__dirname, '..');
const warp = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'warp.v1.json'), 'utf8'));
const tables = decodeTables(fs.readFileSync(path.join(ROOT, 'public', 'tables.v1.bin')));
const golden = JSON.parse(fs.readFileSync(path.join(ROOT, 'tests', 'fixtures', 'golden.json'), 'utf8'));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}
const U_MPS = 30 * 0.44704;
const T_EFF_S = 8 * 3600;

console.log('\n== [1] affine round-trip ==');
check('grid -> lonlat -> grid over the whole bathy grid', () => {
  let worst = 0;
  for (let r = 0; r < BATHY_ROWS; r += 17) {
    for (let c = 0; c < BATHY_COLS; c += 13) {
      const ll = gridToLonlat(warp, c, r);
      const g = lonlatToGrid(warp, ll.lon, ll.lat);
      worst = Math.max(worst, Math.hypot(g.col - c, g.row - r));
    }
  }
  const metres = worst * 100;
  console.log(`       worst round-trip error: ${worst.toFixed(4)} cells (${metres.toFixed(2)} m); ` +
    `affine residual ${warp.max_residual_m} m`);
  assert.ok(metres <= 2 * warp.max_residual_m + 5, `round-trip ${metres} m`);
});
check('lonlat -> grid -> lonlat on the fixture corners', () => {
  let worst = 0;
  for (const [lon, lat] of [warp.corners.nw, warp.corners.se, [warp.corners.nw[0], warp.corners.se[1]]]) {
    const g = lonlatToGrid(warp, lon, lat);
    const ll = gridToLonlat(warp, g.col, g.row);
    worst = Math.max(worst, Math.hypot((ll.lon - lon) * 76000, (ll.lat - lat) * 111000));
  }
  console.log(`       worst inverse round-trip error: ${worst.toFixed(2)} m`);
  assert.ok(worst <= 2 * warp.max_residual_m + 5, `inverse round-trip ${worst} m`);
});
check('gatherRaster fills the display raster with finite values', () => {
  const out = new Float64Array(BATHY_ROWS * BATHY_COLS);
  for (let i = 0; i < out.length; i++) out[i] = i % 7;
  const raster = gatherRaster(out, warp, 64, 66);
  assert.strictEqual(raster.length, 64 * 66);
  for (let i = 0; i < raster.length; i++) assert.ok(Number.isFinite(raster[i]), `raster[${i}]`);
  console.log(`       raster 64x66, min ${Math.min(...raster).toFixed(2)} max ${Math.max(...raster).toFixed(2)}`);
});

console.log('\n== [2] direction blending continuity (0 -> 360 in 0.5 deg steps) ==');
for (const [name, fx] of Object.entries(golden)) {
  check(`no Hs jump > 0.05 ft on ${name}`, () => {
    const col = Math.round((fx.utm_E - 436230) / 100);
    const row = Math.round((5135360 - fx.utm_N) / 100);
    const rc = Math.min(97, Math.max(0, Math.trunc((row - 1) / 3)));
    const cc = Math.min(94, Math.max(0, Math.trunc((col - 1) / 3)));
    const coarse = rc * 95 + cc;
    let prev = null, worst = 0;
    for (let b = 0; b <= 360; b += 0.5) {
      const { F_m, d_path_ft } = blendFetch(tables, coarse, b % 360);
      const r = waveCore(F_m, d_path_ft, fx.dlocal_ft, U_MPS, T_EFF_S, { fastDispersion: true });
      if (prev !== null) worst = Math.max(worst, Math.abs(r.Hs_ft - prev));
      prev = r.Hs_ft;
    }
    console.log(`       ${name.padEnd(18)} worst jump ${worst.toFixed(5)} ft`);
    assert.ok(worst <= 0.05, `${name} jump ${worst}`);
  });
}

console.log('\n== [3] roller / Hmax definition ==');
check('hmaxFt === min(1.67*(Ks*Hs), 0.78*d_local) and matches golden', () => {
  for (const [name, fx] of Object.entries(golden)) {
    const r = waveCore(fx.F_mi * 1609.34, fx.dpath_ft, fx.dlocal_ft, U_MPS, T_EFF_S);
    const expect = Math.min(1.67 * r.Ks * r.Hs_ft, 0.78 * fx.dlocal_ft);
    assert.ok(Math.abs(hmaxFt(r.Ks * r.Hs_ft, fx.dlocal_ft) - expect) < 1e-12, name);
    assert.ok(Math.abs(expect - fx.roller_ft) <= 0.01, `${name} golden roller`);
    console.log(`       ${name.padEnd(18)} Hmax ${expect.toFixed(4)} ft vs golden ${fx.roller_ft} ft`);
  }
});
check('computeFrame roller at lake-max uses the same definition', () => {
  const entry = { speedMph: 30, dirTrueDeg: 315, tEffH: 8 };
  const f = computeFrame(tables, entry, { gamma: -0.474 });
  const d = tables.depth[f.maxIdx] * 0.25;
  assert.ok(Math.abs(f.rollerFt - hmaxFt(f.afterKs[f.maxIdx], d)) < 1e-12);
  console.log(`       lake-max Hs ${f.maxHs.toFixed(3)} ft, Hmax ${f.rollerFt.toFixed(3)} ft, H/L ${f.hlMax.toFixed(4)}`);
});

console.log('\n== [4] stage-3 basemap + page stats ==');
check('basemap is muted + keyless (no watermarked provider)', () => {
  // CARTO's keyless tiles now stamp "API KEY REQUIRED", so the muted look comes from
  // desaturating standard OSM tiles instead. Pin the intent: keyless host + the CSS filter.
  assert.ok(TILE_URL.includes('tile.openstreetmap.org'), TILE_URL);
  assert.ok(!/cartocdn\.com/.test(TILE_URL), 'watermarked provider must not be used');
  const html = require('fs').readFileSync(require('path').join(__dirname, '..', 'index.html'), 'utf8');
  assert.ok(/\.leaflet-tile-pane\s*\{[^}]*filter:[^}]*grayscale/.test(html), 'tile pane must be desaturated');
  assert.strictEqual(TILE_MAX_ZOOM, 19);
  assert.strictEqual(OVERLAY_OPACITY, 0.68);
  assert.strictEqual(PLAY_INTERVAL_MS, 333);
  console.log(`       ${TILE_URL} @ opacity ${OVERLAY_OPACITY}`);
});
check('stage-5m deck markup: single full-height tape, no wind strip', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">/.test(html),
    'viewport meta must drop maximum-scale/user-scalable and add viewport-fit=cover');
  const footer = /<footer id="deck">([\s\S]*?)<\/footer>/.exec(html);
  assert.ok(footer, 'missing <footer id="deck">');
  const ids = ['play', 'track', 'timeline', 'track-tape', 'track-days', 'track-ticks',
    'track-label', 'now-tick', 'time-pill', 'h-24h', 'h-7d'];
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `page missing #${id}`);
  const removed = ['playhead', 'track-rail', 'track-progress', 'deck-day', 'hour-label',
    'play-label', 'deck-main'];
  for (const id of removed) assert.ok(!html.includes(id), `#${id} must be gone (5F)`);
  assert.ok(!footer[1].includes('id="scrub"'), '#scrub shim must be gone (5D)');
  assert.ok(!footer[1].includes('id="legend"'), '#legend must be gone from the deck');
  assert.ok(!footer[1].includes('id="readout"'), '#readout must be out of the deck');
  assert.ok(!footer[1].includes('id="wind-strip"'), 'the wind strip must be gone (5M)');
  assert.ok(!/\.deck-wind\b/.test(html), '.deck-wind CSS must be gone (5M)');
  assert.ok(!footer[1].includes('ramp-bar') && !footer[1].includes('ramp-ticks'),
    'the ramp row must be out of the deck (5L)');
  const map = /<div id="map">([\s\S]*?)<footer id="deck">/.exec(html);
  assert.ok(map, 'missing <div id="map">');
  for (const id of ['legend-card', 'legend-card-bar', 'legend-card-ticks']) {
    assert.ok(map[1].includes(`id="${id}"`), `#${id} must be inside #map (5L)`);
  }
  const ticks = html.match(/id="legend-card-ticks">([\s\S]*?)<\/div>/);
  assert.ok(ticks && ['0', '1', '2', '3.5', '4.5', '6+'].every((s) => ticks[1].includes(`<span>${s}</span>`)),
    'legend ticks must list the six Hs stops');
  console.log('       single-row tape, wind strip gone, ramp in the map legend card');
});
check('frame carries a water-only p10 at or below the lake max', () => {
  const entry = { speedMph: 30, dirTrueDeg: 315, tEffH: 8 };
  const f = computeFrame(tables, entry, { gamma: -0.474 });
  const p10 = ui.p10(f.capped);
  assert.ok(p10 >= 0 && p10 <= f.maxHs, `p10 ${p10} maxHs ${f.maxHs}`);
  const peak = gridToLonlat(warp, f.maxIdx % BATHY_COLS, Math.floor(f.maxIdx / BATHY_COLS));
  const g = lonlatToGrid(warp, peak.lon, peak.lat);
  assert.ok(Math.hypot(g.col - (f.maxIdx % BATHY_COLS), g.row - Math.floor(f.maxIdx / BATHY_COLS)) < 1);
  console.log(`       p10 ${p10.toFixed(3)} ft, max ${f.maxHs.toFixed(3)} ft, ` +
    `peak ${peak.lat.toFixed(4)}, ${peak.lon.toFixed(4)}`);
});

console.log('\n== [5] stage-4a: zoom-aware width ==');
check('targetWidth clamps to [lo, hi]', () => {
  assert.strictEqual(targetWidth(0, 1), 512);
  assert.strictEqual(targetWidth(300, 1), 512);
  assert.strictEqual(targetWidth(1000, 1), 1000);
  assert.strictEqual(targetWidth(800, 2), 1536);
  assert.strictEqual(targetWidth(2000, 1), 1536);
  assert.strictEqual(targetWidth(600, 1), 600);
  assert.strictEqual(FRAME_MINUTES, 15);
  console.log(`       300->${targetWidth(300, 1)} 1000->${targetWidth(1000, 1)} 1600->${targetWidth(800, 2)}`);
});

console.log('\n== [6] stage-4a: land mask + masked smoothing ==');
check('landMaskRaster returns a land fraction in [0,1]', () => {
  const lf = landMaskRaster(warp, tables, 64, 66);
  assert.strictEqual(lf.length, 64 * 66);
  let min = 1, max = 0;
  for (let i = 0; i < lf.length; i++) { min = Math.min(min, lf[i]); max = Math.max(max, lf[i]); }
  assert.ok(min >= 0 && max <= 1, `range ${min}..${max}`);
  console.log(`       64x66 land fraction min ${min.toFixed(3)} max ${max.toFixed(3)}`);
});
check('smoothRaster invariants: max not raised, pure land 0, inputs unmutated', () => {
  const W = 5, H = 5;
  const raster = new Float32Array(W * H);
  for (let i = 0; i < raster.length; i++) raster[i] = (i % 4) + 1; // 1..4
  const landFrac = new Float32Array(W * H);
  landFrac[12] = 1; // pure land at (row 2, col 2)
  landFrac[11] = 0.5; // partial shoreline
  const before = Float32Array.from(raster);
  const out = smoothRaster(raster, landFrac, W, H, 2);
  assert.notStrictEqual(out, raster, 'must be a new array');
  assert.deepStrictEqual(Array.from(raster), Array.from(before), 'input mutated');
  let maxIn = 0, maxOut = 0;
  for (let i = 0; i < raster.length; i++) maxIn = Math.max(maxIn, raster[i]);
  for (let i = 0; i < out.length; i++) maxOut = Math.max(maxOut, out[i]);
  assert.ok(maxOut <= maxIn + 1e-6, `max raised ${maxOut} > ${maxIn}`);
  assert.strictEqual(out[12], 0, 'pure land must be exactly 0');
  console.log(`       max ${maxIn} -> ${maxOut}, land pixel ${out[12]}`);
});
check('smoothRaster normalized: flat water stays flat', () => {
  const W = 4, H = 4;
  const raster = new Float32Array(W * H).fill(2.5);
  const landFrac = new Float32Array(W * H);
  const out = smoothRaster(raster, landFrac, W, H, 2);
  for (let i = 0; i < out.length; i++) assert.ok(Math.abs(out[i] - 2.5) < 1e-6, `out[${i}]=${out[i]}`);
});

console.log('\n== [7] stage-4a: LRU frame cache ==');
check('cache key includes idx, pinIdx and dims', () => {
  assert.strictEqual(cacheKey(3, -1, 780, 796), '3|-1|780x796');
  assert.notStrictEqual(cacheKey(3, -1, 780, 796), cacheKey(3, 7, 780, 796));
  assert.notStrictEqual(cacheKey(3, -1, 780, 796), cacheKey(3, -1, 384, 392));
});
check('LRU evicts least-recently-used and touches on get', () => {
  const cache = createFrameCache({ max: 3, sizeOf: (e) => e.size });
  cache.set('a', { size: 1 }); cache.set('b', { size: 1 }); cache.set('c', { size: 1 });
  cache.get('a');                       // a becomes most recent
  cache.set('d', { size: 1 });          // evicts b
  assert.deepStrictEqual(cache.keys(), ['c', 'a', 'd']);
  assert.strictEqual(cache.size, 3);
  assert.strictEqual(cache.has('b'), false);
  assert.strictEqual(cache.bytes, 3);
  console.log(`       keys ${cache.keys().join(', ')}, bytes ${cache.bytes}, peak ${cache.peakBytes}`);
});
check('clear resets size/bytes and frameBytes gauges url', () => {
  assert.strictEqual(frameBytes({ url: 'data:image/png;base64,AAAA' }), 26 * 2 + 64);
  const cache = createFrameCache({ max: 2 });
  cache.set('x', { url: '12345' });
  assert.strictEqual(cache.size, 1);
  cache.clear();
  assert.strictEqual(cache.size, 0);
  assert.strictEqual(cache.bytes, 0);
});

console.log('\n== [8] stage-4a2: playback width + async encode ==');
check('playWidth uses 1x display width, capped at 780', () => {
  assert.strictEqual(PLAY_MAX_WIDTH, 780);
  assert.strictEqual(playWidth(390), 390);
  assert.strictEqual(playWidth(779.6), 780);
  assert.strictEqual(playWidth(780), 780);
  assert.strictEqual(playWidth(1000), 780);
  assert.strictEqual(playWidth(0), 2);
  assert.ok(playWidth(390) < targetWidth(390, 2), 'play class must be cheaper than the full class');
  console.log(`       390->${playWidth(390)} 1000->${playWidth(1000)} ` +
    `(full @dpr2 390->${targetWidth(390, 2)})`);
});
check('cache eviction calls the hook once per entry; revokeUrl skips data URLs', () => {
  const evicted = [];
  const cache = createFrameCache({
    max: 2, sizeOf: () => 1, onEvict: (k, e) => evicted.push([k, e.url]),
  });
  cache.set('a', { url: 'blob:http://x/1' });
  cache.set('b', { url: 'data:image/png;base64,AA' });
  cache.set('c', { url: 'blob:http://x/2' }); // evicts a
  assert.deepStrictEqual(evicted, [['a', 'blob:http://x/1']]);
  cache.clear();                              // evicts b then c
  assert.deepStrictEqual(evicted.map((e) => e[0]), ['a', 'b', 'c']);

  const revoked = [];
  const orig = URL.revokeObjectURL;
  URL.revokeObjectURL = (u) => revoked.push(u);
  try {
    revokeUrl('blob:http://x/1');
    revokeUrl('data:image/png;base64,AA');
    revokeUrl(null);
    revokeUrl(undefined);
    assert.deepStrictEqual(revoked, ['blob:http://x/1']);
  } finally { URL.revokeObjectURL = orig; }
});
check('stale async result cached but not painted (decision helper)', () => {
  const shown = { idx: 5, pinIdx: -1, W: 780, H: 796 };
  assert.strictEqual(shouldPaintResult(shown, { idx: 5, pinIdx: -1, W: 780, H: 796 }), true);
  assert.strictEqual(shouldPaintResult(shown, { idx: 6, pinIdx: -1, W: 780, H: 796 }), false);
  assert.strictEqual(shouldPaintResult(shown, { idx: 5, pinIdx: 3, W: 780, H: 796 }), false);
  assert.strictEqual(shouldPaintResult(shown, { idx: 5, pinIdx: -1, W: 1536, H: 1568 }), false);
  assert.strictEqual(shouldPaintResult(shown, null), false);
  console.log('       idx/pin/dims mismatch all suppress the async paint');
});

console.log('\n== [9] stage-5g: tape geometry ==');
check('pxPerDay is 330 in 7d and max(550, window) in 24h', () => {
  assert.strictEqual(pxPerDay('7d', 374), 330);
  assert.strictEqual(pxPerDay('24h', 374), 550);
  assert.strictEqual(pxPerDay('24h', 120), 550, 'a single day keeps the 550 px/day phone floor');
  console.log(`       7d->${pxPerDay('7d', 374)} 24h(374)->${pxPerDay('24h', 374)} ` +
    `24h(120)->${pxPerDay('24h', 120)}`);
});
check('24h runway is >= 150 px at a 374 px window; 7d unchanged', () => {
  assert.ok(pxPerDay('24h', 374) - 374 >= 150,
    `24h runway ${pxPerDay('24h', 374) - 374} px`);
  assert.strictEqual(pxPerDay('7d', 374), 330);
  console.log(`       24h runway ${pxPerDay('24h', 374) - 374} px (tape ${pxPerDay('24h', 374)} - window 374)`);
});
check('pxPerFrame is pxPerDay / 96', () => {
  assert.strictEqual(pxPerFrame('7d', 374), 330 / 96);
  assert.strictEqual(pxPerFrame('24h', 374), 550 / 96);
  console.log(`       7d->${pxPerFrame('7d', 374).toFixed(4)} 24h->${pxPerFrame('24h', 374).toFixed(4)}`);
});
check('tapeTranslate keeps the active frame under the reticle centre', () => {
  const pxf = pxPerFrame('7d', 374), center = 187;
  for (const idx of [0, 1, 96, 335, 671]) {
    assert.ok(Math.abs(tapeTranslate(idx, pxf, center) + idx * pxf - center) < 1e-9,
      `idx ${idx} not under centre`);
  }
  console.log(`       center ${center}, idx 0 -> ${tapeTranslate(0, pxf, center)}, ` +
    `idx 671 -> ${tapeTranslate(671, pxf, center).toFixed(1)}`);
});
check('idxFromDrag: dragging left advances, right rewinds, clamped at both ends', () => {
  const pxf = 330 / 96, n = 672, start = 200;
  for (const k of [1, 5, 37, 120]) {
    assert.strictEqual(idxFromDrag(-pxf * k, start, pxf, n), start + k, `advance ${k}`);
  }
  assert.strictEqual(idxFromDrag(pxf * 40, start, pxf, n), start - 40, 'rewind 40');
  assert.strictEqual(idxFromDrag(-pxf * 10000, start, pxf, n), n - 1, 'clamp high');
  assert.strictEqual(idxFromDrag(pxf * 10000, start, pxf, n), 0, 'clamp low');
  let prev = Infinity;
  for (let dx = -400; dx <= 400; dx += 5) {
    const i = idxFromDrag(dx, start, pxf, n);
    assert.ok(i >= 0 && i <= n - 1, `bounds ${i}`);
    assert.ok(i <= prev, `monotone ${i} > ${prev} at dx ${dx}`);
    prev = i;
  }
  console.log(`       -pxf*37 -> +37; clamp [0,${n - 1}]; non-increasing in dx`);
});

console.log('\n== [10] stage-5d: day partitions + 7-day cadence ==');
function std7() {
  const out = [];
  for (let d = 0; d < 7; d++) {
    const date = new Date(Date.UTC(2026, 8, 11 + d)).toISOString().slice(0, 10);
    for (let i = 0; i < 96; i++) {
      const h = Math.floor(i / 4), m = (i % 4) * 15;
      out.push({ time: `${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}` });
    }
  }
  return out;
}
const std = std7();
check('standard 672-frame shape -> 7 partitions at 0..576', () => {
  const p = dayPartitions(std);
  assert.strictEqual(p.length, 7);
  assert.deepStrictEqual(p.map((x) => x.index), [0, 96, 192, 288, 384, 480, 576]);
  assert.deepStrictEqual(p.map((x) => x.date),
    ['2026-09-11', '2026-09-12', '2026-09-13', '2026-09-14', '2026-09-15', '2026-09-16', '2026-09-17']);
  console.log(`       ${p.map((x) => `${x.date}@${x.index}`).join(' ')}`);
});
check('uneven day lengths 5/4/6 -> indices [0,5,9] (string-derived, not /96)', () => {
  const mk = (date, k) => Array.from({ length: k }, (_, i) => ({
    time: `${date}T${String(i).padStart(2, '0')}:00`,
  }));
  const entries = [...mk('2026-09-11', 5), ...mk('2026-09-12', 4), ...mk('2026-09-13', 6)];
  assert.deepStrictEqual(dayPartitions(entries).map((x) => x.index), [0, 5, 9]);
});
check('single 96-frame day -> one partition', () => {
  const p = dayPartitions(std.slice(0, 96));
  assert.strictEqual(p.length, 1);
  assert.strictEqual(p[0].index, 0);
});
check('playStep + nextPlayIdx wrap cleanly at the 7-day boundary', () => {
  assert.strictEqual(playStep('7d'), 4);
  assert.strictEqual(playStep('24h'), 1);
  assert.strictEqual(nextPlayIdx(671, 4, 672), 3);
  assert.strictEqual(nextPlayIdx(668, 4, 672), 0);
  assert.strictEqual(nextPlayIdx(95, 1, 96), 0);
});
check('#scrub shim is gone; timeline containers present', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(!/\bid="scrub"/.test(html), '#scrub must be gone');
  for (const id of ['track-days', 'track-ticks', 'track-label', 'timeline', 'h-24h', 'h-7d']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
});

console.log('\n== [11] stage-5h: drag-time map paint throttle ==');
check('shouldPaintMap: gate closed -> false; open+idle -> true; open+busy -> false', () => {
  const MIN = 72;
  assert.strictEqual(shouldPaintMap(1000, 1000, false, MIN), false, 'gate closed');
  assert.strictEqual(shouldPaintMap(1000, 1000 - MIN + 1, false, MIN), false, 'just under the gate');
  assert.strictEqual(shouldPaintMap(1000, 1000 - MIN, false, MIN), true, 'gate open, not busy');
  assert.strictEqual(shouldPaintMap(1000, 0, false, MIN), true, 'opened long ago');
  assert.strictEqual(shouldPaintMap(1000, 0, true, MIN), false, 'busy wins even when open');
  assert.strictEqual(shouldPaintMap(1000, 1000 - MIN, true, MIN), false, 'busy at the boundary');
  console.log('       closed/busy suppress; open+idle paints');
});

console.log('\n== [12] stage-5l: calm-water paint ==');
check('paintRaster: calm water -> CALM_RGBA opaque (alpha 255), land -> transparent', () => {
  const W = 2, H = 1;
  const raster = new Float32Array([0, 0]);        // both non-positive
  const landFrac = new Float32Array([0, 1]);       // col 0 water (calm), col 1 land
  const img = { width: W, height: H, data: new Uint8ClampedArray(W * H * 4) };
  const ctx = { createImageData: () => img, putImageData: () => {} };
  paintRaster(ctx, raster, W, H, landFrac);
  assert.deepStrictEqual(Array.from(img.data.slice(0, 4)), [8, 145, 178, 255], 'calm water');
  assert.deepStrictEqual(Array.from(img.data.slice(4, 8)), [0, 0, 0, 0], 'land');
});
check('paintRaster: positive Hs still uses the colour ramp (opaque), no landFrac needed', () => {
  const img = { width: 1, height: 1, data: new Uint8ClampedArray(4) };
  const ctx = { createImageData: () => img, putImageData: () => {} };
  paintRaster(ctx, new Float32Array([1]), 1, 1, new Float32Array([0]));
  assert.strictEqual(img.data[3], 255);
  assert.deepStrictEqual(Array.from(img.data.slice(0, 3)), [6, 182, 212]);
});

console.log('\n== [13] stage-5m: tickWinds ==');
check('full day -> 8 entries, ordered by hour, integer mph', () => {
  const mk = (i) => ({
    time: `2026-09-11T${String(Math.floor(i / 4)).padStart(2, '0')}:${String((i % 4) * 15).padStart(2, '0')}`,
    speedMph: i,
  });
  const day = Array.from({ length: 96 }, (_, i) => mk(i));
  const w = tickWinds(day, 0, day.length);
  assert.deepStrictEqual(w.map((x) => x.h), [0, 3, 6, 9, 12, 15, 18, 21]);
  assert.deepStrictEqual(w.map((x) => x.mph), [0, 12, 24, 36, 48, 60, 72, 84]);
  assert.ok(w.every((x) => Number.isInteger(x.mph)), 'all mph are integers');
  console.log(`       ${w.map((x) => `${x.h}h=${x.mph}`).join(' ')}`);
});
check('rounds to the nearest mph', () => {
  const mk = (h, s) => ({ time: `2026-09-11T${String(h).padStart(2, '0')}:00`, speedMph: s });
  const day = [mk(0, 5.4), mk(1, 5.5), mk(3, 2.4), mk(6, 7.6)];
  assert.deepStrictEqual(tickWinds(day, 0, day.length),
    [{ h: 0, mph: 5 }, { h: 3, mph: 2 }, { h: 6, mph: 8 }]);
});
check('missing frame or non-finite speed is skipped (no label)', () => {
  const mk = (h, s) => ({ time: `2026-09-11T${String(h).padStart(2, '0')}:00`, speedMph: s });
  const day = [mk(0, 10), mk(3, NaN), mk(6, 20)]; // 09/12/... absent, 03 non-finite
  assert.deepStrictEqual(tickWinds(day, 0, day.length), [{ h: 0, mph: 10 }, { h: 6, mph: 20 }]);
});
check('respects [start, end) so a block never sees a neighbouring day', () => {
  const mk = (d, h, s) => ({ time: `2026-09-${d}T${String(h).padStart(2, '0')}:00`, speedMph: s });
  const entries = [mk('11', 0, 10), mk('11', 3, 11), mk('12', 0, 90)];
  assert.deepStrictEqual(tickWinds(entries, 0, 2).map((x) => [x.h, x.mph]), [[0, 10], [3, 11]]);
  assert.deepStrictEqual(tickWinds(entries, 2, 3).map((x) => [x.h, x.mph]), [[0, 90]]);
  assert.deepStrictEqual(tickWinds([], 0, 0), []);
});

console.log('\n== [14] 6.2: two-badge marine header markup ==');
check('two-badge row ids present; shore pill / arrow / help / popover deleted', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['secondary', 'three', 'pill-lake', 'lake', 'mph',
    'pill-gust', 'gust', 'gust-u', 'dot', 'refresh']) {
    assert.ok(html.includes(`id="${id}"`), `missing #${id}`);
  }
  for (const id of ['pill-shore', 'shore', 'shore-u', 'arrow', 'help', 'help-pop', 'lake-u']) {
    assert.ok(!html.includes(`id="${id}"`), `#${id} must be deleted by the 6.2 de-clutter`);
  }
  assert.ok(!html.includes('aria-controls="help-pop"'), 'no popover plumbing may remain');
  assert.ok(!html.includes('• Shore:') && !html.includes('• Lake:'),
    'the explainer copy must go with #help-pop');
  assert.ok(!html.includes('id="wind-info"'), '#wind-info must be deleted');
  assert.ok(!html.includes('id="frame-info"'), '#frame-info must be deleted');
  assert.ok(!/class="sep"/.test(html), 'the old #secondary .sep must be gone');
  assert.ok(!/>Wind:</.test(html), 'the row must not carry a "Wind:" prefix');
  const row = html.slice(html.indexOf('id="three"'), html.indexOf('</header>'));
  const order = ['pill-lake', 'mph', 'dot', 'pill-gust', 'gust', 'gust-u']
    .map((id) => row.indexOf(id));
  assert.ok(order.every((k) => k >= 0), 'every row id must be inside #three');
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order,
    'row order must be lake badge -> unit -> dot -> gust badge');
  assert.ok(row.indexOf('id="mph"') > row.indexOf('id="lake"'),
    '#mph must be the LAKE badge unit (it inherits the tier tint)');
  // 6.3 item 4: the gust badge drops its .unit span -> "24 Gust", not "24 mph Gust".
  const gustBadge = html.slice(html.indexOf('id="pill-gust"'), html.indexOf('id="refresh"'));
  assert.ok(!/class="unit"/.test(gustBadge),
    '#pill-gust must not contain a class="unit" child (gust renders [24 Gust])');
  assert.deepStrictEqual([...gustBadge.matchAll(/<span id="([^"]+)"/g)].map((m) => m[1]),
    ['gust', 'gust-u'], '#pill-gust inner spans must be exactly gust, gust-u');
  assert.ok(html.includes('id="gust-u"'), '#gust-u must still be present');
});
check('6.2 typography, badge fills and the minute pill are pinned', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/#lake, #gust \{ font-size: 13px; font-weight: 700; color: #f8fafc/.test(html),
    'numerals must be 13px/700/#f8fafc');
  assert.ok(/#gust-u \{ font-size: 10px; font-weight: 500; color: #cbd5e1/.test(html),
    'the Gust label must be 10px/500/#cbd5e1');
  assert.ok(/\.unit \{ font-size: 10px; font-weight: 500; color: #cbd5e1/.test(html),
    'units must be 10px/500/#cbd5e1');
  assert.ok(/#pill-lake \.unit \{ color: #f8fafc; \}/.test(html),
    'the lake unit must be white: #cbd5e1 over the tier tint measured 3.58:1 (amber), white >=5.08:1 on every tier');
  assert.ok(/#pill-gust \{ background: rgba\(148,163,184,\.18\)/.test(html),
    'the gust badge keeps the neutral fill');
  assert.ok(/#pill-lake \{ background: var\(--tint/.test(html),
    'the lake badge must inherit the WIND_HEAT tier tint');
  assert.ok(/#pill-lake, #pill-gust/.test(html) === false, 'the shore pill fill must be gone');
  assert.ok(/padding: 2px 6px/.test(html), 'badges must use the 2px 6px fit padding');
  const pill = html.slice(html.indexOf('#time-pill '), html.indexOf('#time-pill::after'));
  assert.ok(/tabular-nums/.test(pill), '#time-pill must pin font-variant-numeric: tabular-nums');
});
check('6.2 zoom stack docks bottom-right and the horizon owns the top-left corner', () => {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  assert.ok(/\.leaflet-top\.leaflet-left \{ top: auto; bottom: 20px; left: auto; right: 6px; \}/.test(html),
    'the zoom corner must be re-anchored bottom-right, map-relative (deck-h is a viewport offset)');
  assert.ok(/\.leaflet-top\.leaflet-left \.leaflet-control \{ margin: 0; \}/.test(html),
    'the inherited 10px Leaflet margins must be neutralised for the docked corner');
  assert.ok(/#horizon \{ position: absolute; top: calc\(var\(--header-h\) \+ 12px\); left: 12px;/.test(html),
    '#horizon must own the top-left corner at 12px (mirroring #wind-badge on the right)');
  assert.ok(!/left: 56px/.test(html), 'the old zoom-clearing 56px offset must be gone');
});

console.log('\n== [15] 6.2: continuous minute-level scrub geometry ==');
check('pxPerMinute is pxPerFrame / step', () => {
  assert.strictEqual(pxPerMinute('7d', 374, 15), (330 / 96) / 15);
  assert.strictEqual(pxPerMinute('24h', 374, 15), (550 / 96) / 15);
  // a zero/absent step falls back to the 15-minute frame base
  assert.strictEqual(pxPerMinute('24h', 374, 0), (550 / 96) / 15);
  console.log(`       24h -> ${pxPerMinute('24h', 360, 15).toFixed(4)} px/min, ` +
    `7d -> ${pxPerMinute('7d', 360, 15).toFixed(4)} px/min`);
});
check('minutesFromDrag is continuous, never snapped, and clamps at both ends', () => {
  const ppm = pxPerMinute('24h', 360, 15);
  const start = 10 * 15; // frame 10
  // dragging LEFT advances: one frame's worth of pixels == exactly 15 minutes
  assert.ok(Math.abs(minutesFromDrag(-ppm * 15, start, ppm, 1435) - (start + 15)) < 1e-9);
  // sub-frame: 3.5 minutes' worth of pixels lands on 3.5 minutes, NOT on a frame boundary
  const sub = minutesFromDrag(-ppm * 3.5, start, ppm, 1435);
  assert.ok(Math.abs(sub - (start + 3.5)) < 1e-9);
  assert.notStrictEqual(sub % 15, 0, 'a sub-frame drag must not snap to the 15-minute grid');
  assert.strictEqual(minutesFromDrag(ppm * 10000, start, ppm, 1435), 0, 'clamp low');
  assert.strictEqual(minutesFromDrag(-ppm * 10000, start, ppm, 1435), 1435, 'clamp high');
  assert.strictEqual(minutesFromDrag(-50, start, 0, 1435), start, 'a zero px/min returns the start');
});
check('tapeTranslateMinutes is the frame-multiple extension of tapeTranslate', () => {
  const ppm = pxPerMinute('7d', 374, 15), center = 187, pxf = pxPerFrame('7d', 374);
  for (const idx of [0, 1, 42, 671]) {
    assert.ok(Math.abs(tapeTranslateMinutes(idx * 15, ppm, center) -
      tapeTranslate(idx, pxf, center)) < 1e-9, `idx ${idx}`);
  }
  // a half-frame minute sits strictly between its two frames (continuous, not stepped)
  const mid = tapeTranslateMinutes(15 * 42 + 7.5, ppm, center);
  assert.ok(mid < tapeTranslate(42, pxf, center) && mid > tapeTranslate(43, pxf, center),
    'the half-frame translate must sit between the neighbouring frames');
  console.log(`       42 -> ${tapeTranslate(42, pxf, center).toFixed(2)}, ` +
    `42.5 -> ${mid.toFixed(2)}, 43 -> ${tapeTranslate(43, pxf, center).toFixed(2)}`);
});
check('idxFromMinutes quantises to the 96-frame array (round, clamped, never 96)', () => {
  const n = 96;
  assert.strictEqual(idxFromMinutes(0, 15, n), 0);
  assert.strictEqual(idxFromMinutes(7, 15, n), 0, 'round(0.47) -> 0');
  assert.strictEqual(idxFromMinutes(8, 15, n), 1, 'round(0.53) -> 1');
  assert.strictEqual(idxFromMinutes(15 * 95 + 20, 15, n), 95, 'never past the last frame');
  assert.strictEqual(idxFromMinutes(99999, 15, n), n - 1, 'clamp high');
  assert.strictEqual(idxFromMinutes(-99999, 15, n), 0, 'clamp low');
  assert.strictEqual(idxFromMinutes(NaN, 15, n), 0, 'NaN -> frame 0');
  for (const m of [0, 3, 7.4, 7.5, 22.5, 1400, 1425]) {
    const i = idxFromMinutes(m, 15, n);
    assert.ok(Number.isInteger(i) && i >= 0 && i <= n - 1, `minutes ${m} -> ${i}`);
  }
});

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
