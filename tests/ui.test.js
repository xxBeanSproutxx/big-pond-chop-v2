'use strict';
// Stage 3 UI helper tests: palette stops, headline formatting, spot naming, sectors.
// Run: node tests/ui.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const ui = require('../src/ui');

const ROOT = path.join(__dirname, '..');
const spots = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'spots.v1.json'), 'utf8'));
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'meta.v1.json'), 'utf8'));
const features = spots.features;
const centroid = ui.centroidOfCorners(meta.wgs84_corners);

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}
const eq = (a, b, m) => assert.deepStrictEqual(a, b, m);

console.log('\n== [1] palette stops (colorForHs) ==');
check('stop boundaries are exact, land/flat water transparent', () => {
  eq(ui.colorForHs(1), [6, 182, 212, 255], '1 ft cyan');
  eq(ui.colorForHs(2), [245, 158, 11, 255], '2 ft amber');
  eq(ui.colorForHs(3.5), [234, 88, 12, 255], '3.5 ft orange-red');
  eq(ui.colorForHs(4.5), [220, 38, 38, 255], '4.5 ft crimson');
  eq(ui.colorForHs(5.5), [190, 24, 93, 255], '5.5 ft magenta');
  eq(ui.colorForHs(6), [190, 24, 93, 255], '6+ clamps to magenta');
  eq(ui.colorForHs(0), [0, 0, 0, 0], 'flat water');
  eq(ui.colorForHs(-2), [0, 0, 0, 0], 'land/negative');
  eq(ui.colorForHs(NaN), [0, 0, 0, 0], 'NaN');
});
check('interpolates smoothly between stops and stays opaque on water', () => {
  const a = ui.colorForHs(1), b = ui.colorForHs(2), mid = ui.colorForHs(1.5);
  for (let k = 0; k < 3; k++) {
    assert.ok(mid[k] >= Math.min(a[k], b[k]) && mid[k] <= Math.max(a[k], b[k]),
      `channel ${k} outside segment bounds`);
  }
  assert.strictEqual(mid[3], 255, 'water alpha opaque');
  assert.notDeepStrictEqual(mid, a);
  assert.notDeepStrictEqual(mid, b);
  console.log(`       1.5 ft -> rgb(${mid.slice(0, 3).join(',')})`);
});
check('legend breakpoints and overlay opacity are pinned', () => {
  eq(ui.HS_BREAKS, [0, 1, 2, 3.5, 4.5, 6]);
  assert.strictEqual(ui.OVERLAY_OPACITY, 0.68);
});
check('stage-5o: HS_STOPS[0] is the calm floor #0891b2', () => {
  eq(ui.HS_STOPS[0], [0.0, 0x08, 0x91, 0xb2]);
});
check('stage-5o: CALM_RGBA agrees with the 0 ft stop (single source of truth)', () => {
  eq(ui.CALM_RGBA, [8, 145, 178, 255]);
  eq(ui.CALM_RGBA, [ui.HS_STOPS[0][1], ui.HS_STOPS[0][2], ui.HS_STOPS[0][3], 255]);
  assert.deepStrictEqual(ui.colorForHs(0), [0, 0, 0, 0], 'colorForHs still transparent at 0');
});

console.log('\n== [2] percentile (p10) ==');
check('percentile ignores land/zero cells and interpolates', () => {
  assert.strictEqual(ui.percentile([1, 2, 3, 4, 5], 0), 1);
  assert.strictEqual(ui.percentile([1, 2, 3, 4, 5], 1), 5);
  assert.strictEqual(ui.percentile([1, 2, 3, 4, 5], 0.5), 3);
  assert.strictEqual(ui.p10([0, 0, 0]), 0, 'all land -> 0');
  const v = [0, 0, ...Array.from({ length: 100 }, (_, i) => i + 1)];
  const p10 = ui.p10(v);
  assert.ok(Math.abs(p10 - 10.9) < 1e-9, `p10 ${p10}`);
  console.log(`       p10 of 1..100 = ${p10}`);
});

console.log('\n== [3] sectors ==');
check('8-way sector relative to the lake centroid', () => {
  assert.strictEqual(ui.sectorFor(centroid.lat + 0.1, centroid.lon, centroid), 'N');
  assert.strictEqual(ui.sectorFor(centroid.lat, centroid.lon + 0.1, centroid), 'E');
  assert.strictEqual(ui.sectorFor(centroid.lat - 0.1, centroid.lon, centroid), 'S');
  assert.strictEqual(ui.sectorFor(centroid.lat, centroid.lon - 0.1, centroid), 'W');
  console.log(`       centroid ${centroid.lat.toFixed(4)}, ${centroid.lon.toFixed(4)}`);
});

console.log('\n== [4] spot naming / describePin ==');
check('a point near Spirit Island names the feature', () => {
  const lat = 46.15173 + 0.01, lon = -93.64465;
  const spot = ui.nameSpot(lat, lon, features, { name: 'S', shore: false });
  assert.strictEqual(spot.kind, 'feature', 'expected a feature');
  assert.strictEqual(spot.name, 'Spirit Island');
  const line = ui.describePin(spot);
  assert.ok(/^\d+\.\d mi [NSEW]{1,2} of Spirit Island$/.test(line), `got "${line}"`);
  console.log(`       ${line}`);
});
check('a mid-basin point falls back to Open water - <sector> Basin', () => {
  const spot = ui.nameSpot(centroid.lat, centroid.lon, features, { name: 'SW', shore: false });
  assert.strictEqual(spot.kind, 'open');
  assert.strictEqual(ui.describePin(spot), 'Open water - SW Basin');
});
check('a near-shore open-water point says Shore', () => {
  const spot = ui.nameSpot(centroid.lat, centroid.lon, features, { name: 'NW', shore: true });
  assert.strictEqual(ui.describePin(spot), 'Open water - NW Shore');
});
check('beyond 4 km is open water even if a feature is nearest', () => {
  const spot = ui.nameSpot(centroid.lat, centroid.lon, features, { name: 'SW', shore: false });
  assert.ok(spot.kind === 'open');
});

console.log('\n== [5] headline (formatHeadline) ==');
const frame = {
  p10Ft: 0.8, maxHsFt: 3.4, rollerFt: 3.93,
  peakLat: 46.15173, peakLon: -93.64465,
  features, sector: { name: 'S', shore: false },
};
check('line 1 is a lake-wide range, one decimal', () => {
  const h = ui.formatHeadline(frame);
  assert.strictEqual(h.range, 'Waves: 0.8 - 3.4 ft');
  console.log(`       ${h.range}`);
});
check('line 2 pairs the peak roller with a short location label', () => {
  const h = ui.formatHeadline(frame);
  assert.ok(h.peak.startsWith('Peak: 3.9 ft · '), h.peak);
  assert.ok(h.peak.endsWith('Spirit Island'), h.peak);
  console.log(`       ${h.peak}`);
});
check('never a bare single number (range + peak words present)', () => {
  const h = ui.formatHeadline(frame);
  assert.ok(h.range.includes(' - '), 'range missing dash');
  assert.ok(/peak/i.test(h.peak), 'peak word missing');
  const open = ui.formatHeadline({
    ...frame, peakLat: centroid.lat, peakLon: centroid.lon, sector: { name: 'SW', shore: false },
  });
  assert.strictEqual(open.peak, 'Peak: 3.9 ft · SW Basin');
  const shore = ui.formatHeadline({
    ...frame, peakLat: centroid.lat, peakLon: centroid.lon, sector: { name: 'NE', shore: true },
  });
  assert.strictEqual(shore.peak, 'Peak: 3.9 ft · NE Shore');
  console.log(`       ${open.peak} / ${shore.peak}`);
});

console.log('\n== [6] stage-6b windPills (three-pill row model) ==');
check('rounds to integers and tints the lake pill from its WIND_HEAT tier', () => {
  const p = ui.windPills(17.4, 8.5, 24.6);
  assert.strictEqual(p.lake, '17');
  assert.strictEqual(p.shore, '9');
  assert.strictEqual(p.gust, '25');
  assert.strictEqual(p.lakeTint, 'rgba(245, 158, 11, 0.55)'); // 17 mph -> amber
  assert.strictEqual(p.lakeBorder, 'rgb(245, 158, 11)');
  console.log(`       17.4/8.5/24.6 -> ${p.shore} Shore ${p.lake} Lake ${p.gust} Gust ${p.lakeTint}`);
});
check('missing shore -> em dash; every WIND_HEAT boundary keeps the lake tint honest', () => {
  for (const bad of [null, undefined, NaN, Infinity, -Infinity, '']) {
    assert.strictEqual(ui.windPills(12, bad, 20).shore, '—', `shore ${bad}`);
  }
  assert.strictEqual(ui.windPills(9.9, 1, 1).lakeTint, 'rgba(8, 145, 178, 0.55)');
  assert.strictEqual(ui.windPills(15, 1, 1).lakeTint, 'rgba(245, 158, 11, 0.55)');
  assert.strictEqual(ui.windPills(25, 1, 1).lakeTint, 'rgba(239, 68, 68, 0.55)');
});
check('never emits NaN / undefined / Infinity', () => {
  for (const [l, s, g] of [[NaN, 10, 5], [Infinity, 10, 5], [10, NaN, Infinity],
    [undefined, null, undefined]]) {
    const p = ui.windPills(l, s, g);
    for (const v of [p.lake, p.shore, p.gust]) {
      assert.ok(!/NaN|undefined|Infinity/.test(v), `bad output "${v}"`);
    }
  }
});

console.log('\n== [7] stage-4b compass (from-text, downwind arrow) ==');
check('sector + degText are the SOURCE; arrowDeg is DOWNWIND (from + 180)', () => {
  assert.deepStrictEqual(ui.compass(0, 10),   { sector: 'N',  degText: '0°',   fromDeg: 0,   arrowDeg: 180 });
  assert.deepStrictEqual(ui.compass(45, 10),  { sector: 'NE', degText: '45°',  fromDeg: 45,  arrowDeg: 225 });
  assert.deepStrictEqual(ui.compass(90, 10),  { sector: 'E',  degText: '90°',  fromDeg: 90,  arrowDeg: 270 });
  assert.deepStrictEqual(ui.compass(180, 10), { sector: 'S',  degText: '180°', fromDeg: 180, arrowDeg: 0 });
  assert.deepStrictEqual(ui.compass(315, 10), { sector: 'NW', degText: '315°', fromDeg: 315, arrowDeg: 135 });
  assert.deepStrictEqual(ui.compass(359, 10), { sector: 'N',  degText: '359°', fromDeg: 359, arrowDeg: 179 });
});
check('wrap-around normalizes; arrowDeg === (normalizeDeg(b) + 180) % 360', () => {
  assert.deepStrictEqual(ui.compass(360, 10), { sector: 'N', degText: '0°', fromDeg: 0, arrowDeg: 180 });
  assert.deepStrictEqual(ui.compass(720, 10), { sector: 'N', degText: '0°', fromDeg: 0, arrowDeg: 180 });
  assert.deepStrictEqual(ui.compass(-45, 10), { sector: 'NW', degText: '315°', fromDeg: 315, arrowDeg: 135 });
  for (const b of [0, 45, 90, 180, 315, 359, 360, 722, -90]) {
    assert.strictEqual(ui.compass(b, 10).arrowDeg, (ui.normalizeDeg(b) + 180) % 360);
  }
});
check('calm (< 3 mph) -> Calm with null arrow', () => {
  eq(ui.compass(315, 2), { sector: 'Calm', degText: '', fromDeg: null, arrowDeg: null });
  eq(ui.compass(315, 0), { sector: 'Calm', degText: '', fromDeg: null, arrowDeg: null });
  eq(ui.compass(NaN, 10), { sector: 'Calm', degText: '', fromDeg: null, arrowDeg: null });
});

console.log('\n== [8] stage-4b comfortTier ==');
check('locked boundaries (first match wins)', () => {
  assert.strictEqual(ui.comfortTier({ maxHsFt: 1, rollerFt: 4.0, hlMax: 0.01 }).key, 'red');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 3.4, rollerFt: 3.9, hlMax: 0.01 }).key, 'amber');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 3.5, rollerFt: 1, hlMax: 0.01 }).key, 'amber');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 2.0, rollerFt: 0.5, hlMax: 0.01 }).key, 'yellow');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 0.5, rollerFt: 1.5, hlMax: 0.01 }).key, 'yellow');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 1.99, rollerFt: 1.49, hlMax: 0.01 }).key, 'green');
});
check('H/L 0.055 alone is red even with tiny waves', () => {
  const t = ui.comfortTier({ maxHsFt: 0.2, rollerFt: 0.2, hlMax: 0.055 });
  assert.strictEqual(t.key, 'red');
  assert.strictEqual(t.label, 'Dangerous · Stay Home');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 5.0, rollerFt: 0, hlMax: 0 }).key, 'red');
});
check('labels are exact', () => {
  assert.strictEqual(ui.comfortTier({ maxHsFt: 6, rollerFt: 6, hlMax: 0.1 }).label, 'Dangerous · Stay Home');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 4, rollerFt: 0, hlMax: 0 }).label, 'Heavy Rollers');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 2.5, rollerFt: 0, hlMax: 0 }).label, 'Walleye Chop');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 0.5, rollerFt: 0.5, hlMax: 0 }).label, 'Fishable · Light Chop');
});
check('missing / NaN inputs never throw or return undefined', () => {
  for (const s of [{}, null, undefined, { maxHsFt: NaN, rollerFt: NaN, hlMax: NaN }]) {
    const t = ui.comfortTier(s);
    assert.strictEqual(t.key, 'green');
    assert.strictEqual(t.label, 'Fishable · Light Chop');
  }
});
check('monotonic: raising max or roller never yields a less-severe tier', () => {
  const rank = { green: 0, yellow: 1, amber: 2, red: 3 };
  const tier = (m, r) => rank[ui.comfortTier({ maxHsFt: m, rollerFt: r, hlMax: 0 }).key];
  for (let m = 0; m <= 6.01; m += 0.1) {
    for (let r = 0; r < 5; r += 0.1) {
      assert.ok(tier(m + 0.1, r) >= tier(m, r), `max ${m}->${m + 0.1} @ roller ${r}`);
      assert.ok(tier(m, r + 0.1) >= tier(m, r), `roller ${r}->${r + 0.1} @ max ${m}`);
    }
  }
});

console.log('\n== [9] stage-4b formatClockLocal ==');
check('12-hour wall clock in America/Chicago', () => {
  assert.strictEqual(ui.formatClockLocal('2026-09-11T00:00'), '12:00 AM CDT');
  assert.strictEqual(ui.formatClockLocal('2026-09-11T12:00'), '12:00 PM CDT');
  assert.strictEqual(ui.formatClockLocal('2026-09-11T17:15'), '5:15 PM CDT');
  assert.strictEqual(ui.formatClockLocal('2026-09-11T05:00'), '5:00 AM CDT');
});
check('winter is CST; the fall-back DST day does not throw', () => {
  assert.strictEqual(ui.formatClockLocal('2026-01-15T17:15'), '5:15 PM CST');
  const before = ui.formatClockLocal('2026-11-01T00:30');
  const after = ui.formatClockLocal('2026-11-01T03:30');
  assert.ok(/^\d{1,2}:\d{2} (AM|PM) C[SD]T$/.test(before), before);
  assert.ok(/^\d{1,2}:\d{2} (AM|PM) C[SD]T$/.test(after), after);
  console.log(`       ${before} / ${after}`);
});

console.log('\n== [9b] 6.2 minute-level pill clock (formatPillTimeAt) ==');
check('minutes are always shown; the offset is exact minute arithmetic', () => {
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T07:00', 4), '7:04 AM', 'the spec example');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T07:00', 9), '7:09 AM');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T07:00', 14), '7:14 AM');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T19:00', 0), '7:00 PM',
    'the exact hour keeps its :00 (the compact form is for the snapped path only)');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T19:00', 5.4), '7:05 PM', 'offsets round to whole minutes');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T19:45', 20), '8:05 PM', 'minute overflow rolls the hour');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T23:55', 10), '12:05 AM', 'minute overflow rolls the day');
});
check('bad input -> empty; a non-finite offset falls back to the frame clock', () => {
  assert.strictEqual(ui.formatPillTimeAt('', 5), '');
  assert.strictEqual(ui.formatPillTimeAt(null, 5), '');
  assert.strictEqual(ui.formatPillTimeAt('not-a-time', 5), '');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T19:00', NaN), '7:00 PM');
  assert.strictEqual(ui.formatPillTimeAt('2026-09-11T19:00', undefined), '7:00 PM');
});
check('a scrub across the fall-back DST change reads the true local minute', () => {
  // 2026-11-01: 2:00 AM CDT falls back to 1:00 AM CST. 01:50 CDT + 20 min is 01:10 CST —
  // the clock goes BACKWARD because the instant did not; the offset is never applied to
  // the wall-clock string.
  assert.strictEqual(ui.formatPillTimeAt('2026-11-01T01:50', 20), '1:10 AM');
  assert.strictEqual(ui.formatPillTimeAt('2026-11-01T00:30', 15), '12:45 AM');
});

console.log('\n== [10] stage-5b rampGradient ==');
check('ramp gradient contains the six Hs stops in order', () => {
  const g = ui.rampGradient();
  const stops = [
    ['rgb(8, 145, 178)', '0%'],
    ['rgb(6, 182, 212)', '16.7%'],
    ['rgb(245, 158, 11)', '33.3%'],
    ['rgb(234, 88, 12)', '50%'],
    ['rgb(220, 38, 38)', '66.7%'],
    ['rgb(190, 24, 93)', '100%'],
  ];
  assert.ok(g.startsWith('linear-gradient(90deg, '), g);
  let at = -1;
  for (const [rgb, pct] of stops) {
    const idx = g.indexOf(`${rgb} ${pct}`);
    assert.ok(idx > at, `missing or out of order: ${rgb} ${pct} in ${g}`);
    at = idx;
  }
  // 5O: the 0 ft floor is #0891b2, distinct from the #06b6d4 1 ft stop, so the 0-1 ft
  // band is a real gradient again; all six stop colours are distinct.
  assert.ok(g.includes('rgb(8, 145, 178) 0%') && g.includes('rgb(6, 182, 212) 16.7%'),
    '0% must be #0891b2 and 16.7% #06b6d4');
  console.log(`       ${g}`);
});

console.log('\n== [11] stage-5d dayLabel ==');
check('short + long weekday from calendar math (no TZ-parse)', () => {
  assert.strictEqual(ui.dayLabel('2026-09-11T00:00'), 'Fri 11');
  assert.strictEqual(ui.dayLabel('2026-09-11T00:00', true), 'Friday 11');
  assert.strictEqual(ui.dayLabel('2026-09-17T00:00'), 'Thu 17');
  assert.strictEqual(ui.dayLabel('2026-09-17T00:00', true), 'Thursday 17');
  assert.strictEqual(ui.dayLabel('2026-09-04T12:00'), 'Fri 4');
  assert.strictEqual(ui.dayLabel('2026-09-04T12:00', true), 'Friday 4');
  console.log(`       ${ui.dayLabel('2026-09-11T00:00')} / ${ui.dayLabel('2026-09-11T00:00', true)}`);
});
check('bad input -> empty string', () => {
  for (const bad of ['', 'nonsense', null, undefined, '2026-13-45', '2026-02-30']) {
    assert.strictEqual(ui.dayLabel(bad), '', `bad ${bad}`);
    assert.strictEqual(ui.dayLabel(bad, true), '', `bad long ${bad}`);
  }
});

console.log('\n== [12] stage-5j/l: calm tier ==');
check('calm tier relabels only a green sea under 0.5 ft or under 4 mph', () => {
  assert.strictEqual(ui.comfortTier({ maxHsFt: 0.2, rollerFt: 0.2, hlMax: 0, windMph: 10 }).label,
    'Calm · Flat');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 1.0, rollerFt: 0.2, hlMax: 0, windMph: 2 }).label,
    'Calm · Flat');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 1.0, rollerFt: 1.0, hlMax: 0, windMph: 10 }).label,
    'Fishable · Light Chop');
  // precedence unchanged: rough keys never read "Calm · Flat", even in calm wind
  assert.strictEqual(ui.comfortTier({ maxHsFt: 5, rollerFt: 0, hlMax: 0, windMph: 2 }).label,
    'Dangerous · Stay Home');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 3.5, rollerFt: 0, hlMax: 0, windMph: 2 }).label,
    'Heavy Rollers');
  assert.strictEqual(ui.comfortTier({ maxHsFt: 2.0, rollerFt: 0, hlMax: 0, windMph: 2 }).label,
    'Walleye Chop');
});

console.log('\n== [13] stage-5o wind heat ==');
const CYAN = [8, 145, 178], GREEN = [16, 185, 129], AMBER = [245, 158, 11];
const ORANGE = [249, 115, 22], CRIMSON = [239, 68, 68];
check('windHeatColor tier boundaries', () => {
  eq(ui.windHeatColor(9.9), CYAN, '9.9 -> cyan');
  eq(ui.windHeatColor(10), GREEN, '10 -> green');
  eq(ui.windHeatColor(14.9), GREEN, '14.9 -> green');
  eq(ui.windHeatColor(15), AMBER, '15 -> amber');
  eq(ui.windHeatColor(19.9), AMBER, '19.9 -> amber');
  eq(ui.windHeatColor(20), ORANGE, '20 -> orange');
  eq(ui.windHeatColor(24.9), ORANGE, '24.9 -> orange');
  eq(ui.windHeatColor(25), CRIMSON, '25 -> crimson');
  eq(ui.windHeatColor(40), CRIMSON, '40 -> crimson');
  eq(ui.windHeatColor(NaN), CYAN, 'NaN -> cyan');
});
check('windHeatGradient: one stop per sample, endpoints at 0%/100%', () => {
  const g = ui.windHeatGradient([5, 12, 17, 22, 30]);
  assert.strictEqual((g.match(/rgb\(/g) || []).length, 5, 'one stop per sample');
  assert.ok(g.startsWith('linear-gradient(90deg, rgb(8, 145, 178) 0%'), g);
  assert.ok(g.endsWith('rgb(239, 68, 68) 100%)'), g);
  for (const rgb of ['rgb(8, 145, 178)', 'rgb(16, 185, 129)', 'rgb(245, 158, 11)',
    'rgb(249, 115, 22)', 'rgb(239, 68, 68)']) {
    assert.ok(g.includes(rgb), `missing ${rgb} in ${g}`);
  }
  console.log(`       ${g.slice(0, 96)}…`);
});
check('windHeatGradient: single sample is a flat gradient; empty never throws', () => {
  const one = ui.windHeatGradient([18]);
  assert.strictEqual(one, 'linear-gradient(90deg, rgb(245, 158, 11) 0%, rgb(245, 158, 11) 100%)');
  const none = ui.windHeatGradient([]);
  assert.strictEqual((none.match(/rgb\(/g) || []).length, 2, 'empty -> flat two stops');
  assert.ok(!/NaN/.test(none), none);
});

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
