'use strict';
// Stage 4A wind tests: t_eff vectors A-F, dtH scaling, shortest-arc interpolation,
// seed continuity, 96-frame day, 15-min currentIndex, live ingest + perf.
// Run: node tests/wind.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const { decodeTables, BATHY_CELLS } = require('../src/tables');
const {
  gammaToGrid, computeTeff, seedTeff, interpolate15, buildSeriesFrom,
  expandHourlyVector, selectRange, buildUrl, bearingDelta,
  ingest, chicagoNow, currentIndex, firstDaySlice, selectDay,
  DEFAULT_POINT, SHORE_POINT, buildDualUrl, parseTwoLocations,
} = require('../src/wind');
const { computeFrame } = require('../src/render');

const ROOT = path.join(__dirname, '..');
let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}

function series(bearings, speeds) {
  return bearings.map((b, i) => ({ bearingGrid: b, speedMph: speeds[i] }));
}
function eq(a, b, msg) {
  assert.strictEqual(a.length, b.length, `${msg} length`);
  for (let i = 0; i < a.length; i++) assert.strictEqual(a[i], b[i], `${msg}[${i}] got ${a[i]} want ${b[i]}`);
}

console.log('\n== [1] t_eff persistence vectors A-F (dtH = 1 unchanged) ==');
check('A: steady 12 mph from 315 for 8 h (+1.0/h)', () => {
  const out = computeTeff(series(Array(8).fill(315), Array(8).fill(12)));
  eq(out, [0.5, 1.5, 2.5, 3.5, 4.5, 5.5, 6.0, 6.0], 'A');
});
check('B: 5 h 20 mph 315 then +90 deg shift', () => {
  const out = computeTeff(series([315, 315, 315, 315, 315, 0], Array(6).fill(20)));
  eq(out, [0.5, 1.5, 2.5, 3.5, 4.5, 0.5], 'B');
});
check('C: lull (2 mph) resets, recovery climbs from 0', () => {
  const out = computeTeff(series([315, 315, 315, 315], [12, 12, 2, 10]));
  eq(out, [0.5, 1.5, 0, 1.0], 'C');
});
check('D: saturates at 6.0 and stays', () => {
  const out = computeTeff(series(Array(14).fill(315), Array(14).fill(12)));
  assert.strictEqual(out[11], 6.0, 'D hit cap');
  assert.strictEqual(out[13], 6.0, 'D stays capped');
});
check('E: exactly +30 deg counts as within tolerance', () => {
  const out = computeTeff(series([315, 345], [12, 12]));
  eq(out, [0.5, 1.5], 'E');
});
check('F: +31 deg resets to 0.5', () => {
  const out = computeTeff(series([315, 346], [12, 12]));
  eq(out, [0.5, 0.5], 'F');
});

console.log('\n== [1b] dtH t_eff: 15-min accumulation, reset + floor unchanged ==');
check('dtH=0.25 accumulates per step', () => {
  const out = computeTeff(series(Array(5).fill(315), Array(5).fill(12)), 0.25);
  eq(out, [0.5, 0.75, 1.0, 1.25, 1.5], 'dtH quarter');
  console.log(`       ${out.join(', ')}`);
});
check('dtH=0.25 reset is 0.5 (not scaled) and 4 mph floor still 0', () => {
  const out = computeTeff(series([315, 45, 45], [12, 12, 3]), 0.25);
  eq(out, [0.5, 0.5, 0], 'dtH reset/floor');
});
check('dtH=1 matches a plain +1.0 accumulator exactly', () => {
  const s = series([300, 301, 302, 303], [20, 20, 20, 20]);
  assert.deepStrictEqual(computeTeff(s, 1), computeTeff(s));
});

console.log('\n== [1c] seedTeff continuity across midnight ==');
check('six steady hourly steps seed 5.5 h and carry the bearing', () => {
  const tail = series(Array(6).fill(315), Array(6).fill(12));
  const seed = seedTeff(tail, { dtH: 1 });
  assert.strictEqual(seed.tEffH, 5.5);
  assert.strictEqual(seed.bearingGrid, 315);
  const firstStep = Math.min(6.0, seed.tEffH + 1.0);
  console.log(`       seed ${seed.tEffH} h -> first hour ${firstStep} h`);
  assert.strictEqual(firstStep, 6.0);
});
check('empty tail seeds a neutral state', () => {
  const seed = seedTeff([], { dtH: 1 });
  assert.strictEqual(seed.tEffH, 0);
  assert.strictEqual(seed.bearingGrid, 0);
});

console.log('\n== [1d] shortest-arc interpolation (350 -> 10) ==');
check('interpolate15 expands 4x and passes through 0', () => {
  const out = interpolate15({ time: ['2026-09-11T00:00', '2026-09-11T01:00'], wind_speed_10m: [10, 20], wind_direction_10m: [350, 10], wind_gusts_10m: [12, 24] });
  assert.strictEqual(out.times.length, 5, '1 gap -> 4 + final');
  assert.strictEqual(out.times[0], '2026-09-11T00:00');
  assert.strictEqual(out.times[1], '2026-09-11T00:15');
  assert.strictEqual(out.times[4], '2026-09-11T01:00');
  assert.deepStrictEqual(out.dirs.map((d) => Math.round(d)), [350, 355, 0, 5, 10]);
  assert.ok(Math.abs(out.speeds[1] - 12.5) < 1e-9, `speed ${out.speeds[1]}`);
  assert.notStrictEqual(Math.round(out.dirs[2]), 180);
  console.log(`       dirs ${out.dirs.join(', ')}`);
});

console.log('\n== [2] gamma -> bearing_grid ==');
const meta = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'meta.v1.json'), 'utf8'));
check('dir_true 0 -> bearing_grid 0.474 (gamma -0.474)', () => {
  const bg = gammaToGrid(0, meta.gamma_deg);
  assert.ok(Math.abs(bg - 0.474) < 1e-9, `got ${bg}`);
});

console.log('\n== [2b] buildSeriesFrom is the single 15-min construction path ==');
check('gamma applied and dtH honored', () => {
  const s = buildSeriesFrom(
    ['2026-09-11T00:00', '2026-09-11T00:15'],
    [12, 12], [0, 0], [16, 16], meta.gamma_deg, 0.25,
  );
  assert.strictEqual(s.length, 2);
  assert.ok(Math.abs(s[0].bearingGrid - 0.474) < 1e-9);
  assert.strictEqual(s[0].tEffH, 0.5);
  assert.strictEqual(s[1].tEffH, 0.75);
});

console.log('\n== [1e] expandHourlyVector: Cartesian vector interpolation ==');
function hourEntry(i, speedMph, dirTrueDeg) {
  return {
    time: new Date(Date.parse('2026-09-13T00:00:00Z') + i * 3600000).toISOString().slice(0, 16),
    speedMph, dirTrueDeg, gustMph: speedMph + 8,
  };
}
check('round-trips every hourly anchor bit-for-bit to <=1e-9', () => {
  const src = [[20, 350], [15, 10], [7.5, 180], [1, 0]].map(([s, d], i) => hourEntry(i, s, d));
  const out = expandHourlyVector(src, meta.gamma_deg);
  assert.strictEqual(out.length, src.length * 4);
  for (let i = 0; i < src.length; i++) {
    const a = out[i * 4];
    assert.ok(Math.abs(a.speedMph - src[i].speedMph) < 1e-9, `speed anchor ${i}: ${a.speedMph}`);
    assert.ok(Math.abs(a.dirTrueDeg - src[i].dirTrueDeg) < 1e-9, `dir anchor ${i}: ${a.dirTrueDeg}`);
    assert.ok(Math.abs(a.bearingGrid - gammaToGrid(src[i].dirTrueDeg, meta.gamma_deg)) < 1e-9, `grid anchor ${i}`);
  }
});
check('crossing 20@350 -> 20@10: midpoint 20*cos(10), bearing 0 not 180', () => {
  const out = expandHourlyVector([hourEntry(0, 20, 350), hourEntry(1, 20, 10)], 0);
  const mid = out[2];
  const expect = 20 * Math.cos(10 * Math.PI / 180);
  assert.ok(Math.abs(mid.speedMph - expect) < 1e-9, `mid speed ${mid.speedMph} want ${expect}`);
  const brg = Math.min(Math.abs(mid.dirTrueDeg), Math.abs(mid.dirTrueDeg - 360));
  assert.ok(brg < 1e-9, `mid bearing ${mid.dirTrueDeg}`);
  assert.ok(bearingDelta(mid.dirTrueDeg, 180) > 90,
    `naive angle-lerp South-sweep regression: midpoint ${mid.dirTrueDeg}`);
});
check('unequal speeds 10@350 -> 30@10: midpoint ~19.7726 @ ~5.038', () => {
  const out = expandHourlyVector([hourEntry(0, 10, 350), hourEntry(1, 30, 10)], 0);
  const mid = out[2];
  assert.ok(Math.abs(mid.speedMph - 19.7726) < 1e-3, `speed ${mid.speedMph}`);
  assert.ok(Math.abs(mid.dirTrueDeg - 5.038) < 1e-3, `dir ${mid.dirTrueDeg}`);
});
check('hour anchors bit-equal across a blended day', () => {
  const src = [];
  for (let i = 0; i < 25; i++) src.push(hourEntry(i, 12 + (i % 5), (315 + 3 * i) % 360));
  const out = expandHourlyVector(src, 1.5);
  for (let i = 0; i < src.length; i++) {
    assert.strictEqual(out[i * 4].speedMph, src[i].speedMph, `speed anchor ${i}`);
    assert.strictEqual(out[i * 4].dirTrueDeg, src[i].dirTrueDeg, `dir anchor ${i}`);
  }
});
check('buildUrl: default and 24h are 2 days, 7d is 7 days', () => {
  assert.ok(buildUrl(1, 2).endsWith('forecast_days=2'));
  assert.ok(buildUrl(1, 2, '24h').endsWith('forecast_days=2'));
  assert.ok(buildUrl(1, 2, '7d').endsWith('forecast_days=7'));
  assert.strictEqual(buildUrl(1, 2), buildUrl(1, 2, '24h'));
});

console.log('\n== [1e-2] Stage 6A dual-location URL + index-keyed parse ==');
check('buildDualUrl joins both coords, keeps forecast_days last', () => {
  const u = buildDualUrl(DEFAULT_POINT, SHORE_POINT);
  assert.ok(u.includes('latitude=46.22,46.13'), u);
  assert.ok(u.includes('longitude=-93.657,-93.57'), u);
  assert.ok(u.endsWith('forecast_days=2'), u);
  assert.ok(buildDualUrl(DEFAULT_POINT, SHORE_POINT, '7d').endsWith('forecast_days=7'));
  assert.strictEqual(buildUrl(1, 2), buildUrl(1, 2, '24h'), 'single-location URL unchanged');
});
check('parseTwoLocations keys lake=index 0, shore=index 1 (no location_id on 0)', () => {
  const live = [
    { latitude: 46.21358, longitude: -93.64418, minutely_15: { time: ['t'] } },
    { latitude: 46.104504, longitude: -93.57359, location_id: 1, minutely_15: { time: ['t'] } },
  ];
  const r = parseTwoLocations(live);
  assert.strictEqual(r.lake, live[0]);
  assert.strictEqual(r.shore, live[1]);
  assert.ok(!('location_id' in r.lake), 'index 0 has no location_id');
  assert.strictEqual(r.shore.location_id, 1);
});
check('parseTwoLocations rejects non-array and short arrays', () => {
  assert.deepStrictEqual(parseTwoLocations({ hourly: {} }), { lake: null, shore: null });
  assert.deepStrictEqual(parseTwoLocations([{ a: 1 }]), { lake: null, shore: null });
  assert.deepStrictEqual(parseTwoLocations(null), { lake: null, shore: null });
});

console.log('\n== [1f] selectRange window ==');
check('picks [start, start+days) with correct first/last', () => {
  const series = [];
  const t0 = Date.parse('2026-09-10T00:00:00Z');
  for (let i = 0; i < 5 * 96; i++) {
    series.push({
      time: new Date(t0 + i * 15 * 60000).toISOString().slice(0, 16),
      speedMph: 10, gustMph: 12, dirTrueDeg: 0, bearingGrid: 0, tEffH: 0.5,
    });
  }
  const win = selectRange(series, '2026-09-11', 2);
  assert.strictEqual(win.length, 192, 'two full local days');
  assert.strictEqual(win[0].time, '2026-09-11T00:00');
  assert.strictEqual(win[win.length - 1].time, '2026-09-12T23:45');
  assert.strictEqual(selectRange(series, '2026-09-13', 7).length, 192, 'clamps at series end');
});

console.log('\n== [1g] blended-series t_eff continuity (dtH 0.25, no +1.0 jumps) ==');
check('steady bearing accumulates +0.25 per 15-min frame', () => {
  const src = [];
  for (let i = 0; i < 40; i++) src.push(hourEntry(i, 12, 315));
  const out = expandHourlyVector(src, 0);
  for (let k = 0; k < out.length; k++) {
    const want = Math.min(6, 0.5 + 0.25 * k);
    assert.ok(Math.abs(out[k].tEffH - want) < 1e-9, `tEff[${k}] ${out[k].tEffH} want ${want}`);
    if (k > 0) {
      const jump = out[k].tEffH - out[k - 1].tEffH;
      assert.ok(jump <= 0.25 + 1e-9, `+1.0 jump at ${k}: ${jump}`);
    }
  }
});
check('>30 deg between consecutive blended frames resets t_eff to 0.5', () => {
  const out = expandHourlyVector([hourEntry(0, 20, 0), hourEntry(1, 20, 120)], 0);
  const deltas = [];
  for (let k = 1; k < out.length; k++) deltas.push(bearingDelta(out[k].bearingGrid, out[k - 1].bearingGrid));
  const reset = deltas.findIndex((d) => d > 30);
  assert.ok(reset >= 0, `expected a >30 deg blended turn, deltas ${deltas.join(', ')}`);
  assert.strictEqual(out[reset + 1].tEffH, 0.5, `reset at frame ${reset + 1}`);
  console.log(`       frame deltas ${deltas.map((d) => d.toFixed(1)).join(', ')}`);
});

function synthMinutely(date) {
  const time = [], sp = [], dr = [], gu = [];
  for (let i = 0; i < 96; i++) {
    const h = Math.floor(i / 4), m = (i % 4) * 15;
    time.push(`${date}T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    sp.push(12 + 4 * Math.sin(i / 6));
    dr.push((315 + 5 * Math.sin(i / 5) + 360) % 360);
    gu.push(18 + 4 * Math.sin(i / 6));
  }
  return { minutely_15: { time, wind_speed_10m: sp, wind_direction_10m: dr, wind_gusts_10m: gu } };
}
function synthHourly(date) {
  const time = [], sp = [], dr = [], gu = [];
  for (let d = -1; d <= 1; d++) {
    for (let h = 0; h < 24; h++) {
      const day = new Date(Date.parse(`${date}T00:00:00Z`) + d * 86400000).toISOString().slice(0, 10);
      time.push(`${day}T${String(h).padStart(2, '0')}:00`);
      sp.push(12 + 4 * Math.sin((d * 24 + h) / 6));
      dr.push((315 + 5 * Math.sin((d * 24 + h) / 5) + 360) % 360);
      gu.push(18);
    }
  }
  return { hourly: { time, wind_speed_10m: sp, wind_direction_10m: dr, wind_gusts_10m: gu } };
}

(async function main() {
  const DATE = '2026-09-11';
  const at1712 = new Date(Date.UTC(2026, 8, 11, 22, 12)); // 17:12 CDT
  const at1752 = new Date(Date.UTC(2026, 8, 11, 22, 52)); // 17:52 CDT

  console.log('\n== [3] 96-frame day from minutely_15 + currentIndex buckets ==');
  let data;
  try {
    data = await ingest({ json: synthMinutely(DATE), gamma: meta.gamma_deg, now: at1712 });
  } catch (e) {
    console.log(`  FAIL synthetic ingest: ${e.message}`);
    failures++;
    return finish();
  }
  console.log(`  synthetic minutely day: ${data.day.length} frames, stepMin ${data.stepMin}`);
  check('minutely path yields a 96-entry day, stepMin 15', () => {
    assert.strictEqual(data.day.length, 96);
    assert.strictEqual(data.stepMin, 15);
  });
  check('currentIndex 17:12 -> the 17:00 frame (index 68)', () => {
    assert.strictEqual(currentIndex(data.day, at1712), 68);
  });
  check('currentIndex 17:52 -> the 17:45 frame (index 71)', () => {
    assert.strictEqual(currentIndex(data.day, at1752), 71);
  });

  let fb;
  try {
    fb = await ingest({ json: synthHourly(DATE), gamma: meta.gamma_deg, now: at1712 });
  } catch (e) {
    console.log(`  FAIL fallback ingest: ${e.message}`);
    failures++;
    return finish();
  }
  console.log(`  fallback hourly->15min day: ${fb.day.length} frames, stepMin ${fb.stepMin}`);
  check('missing minutely_15 falls back to hourly 4x, still 96 frames', () => {
    assert.strictEqual(fb.day.length, 96);
    assert.strictEqual(fb.stepMin, 15);
    assert.strictEqual(currentIndex(fb.day, at1712), 68);
  });

  console.log('\n== [3b] horizon window lengths on an 8-day synthetic ==');
  function pad2(n) { return String(n).padStart(2, '0'); }
  function dayAdd(date, n) {
    return new Date(Date.parse(`${date}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
  }
  // Mirrors the real past_days=1 + forecast_days=7 response: 8 local days (D-1..D6).
  function synth8(date) {
    const mins = { time: [], wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [] };
    const hrs = { time: [], wind_speed_10m: [], wind_direction_10m: [], wind_gusts_10m: [] };
    for (let d = -1; d <= 6; d++) {
      const day = dayAdd(date, d);
      for (let h = 0; h < 24; h++) {
        const sp = 12 + 4 * Math.sin((d * 24 + h) / 6);
        const dr = (315 + 5 * Math.sin((d * 24 + h) / 5) + 360) % 360;
        hrs.time.push(`${day}T${pad2(h)}:00`);
        hrs.wind_speed_10m.push(sp); hrs.wind_direction_10m.push(dr); hrs.wind_gusts_10m.push(18);
        for (let k = 0; k < 4; k++) {
          mins.time.push(`${day}T${pad2(h)}:${pad2(k * 15)}`);
          mins.wind_speed_10m.push(sp); mins.wind_direction_10m.push(dr); mins.wind_gusts_10m.push(18);
        }
      }
    }
    return { hourly: hrs, minutely_15: mins };
  }
  const eight = synth8(DATE);
  const h24 = await ingest({ json: eight, gamma: meta.gamma_deg, now: at1712, horizon: '24h' });
  const h7 = await ingest({ json: eight, gamma: meta.gamma_deg, now: at1712, horizon: '7d' });
  console.log(`  '24h' day ${h24.day.length}, '7d' day ${h7.day.length}, ` +
    `assembled series ${h7.series.length}, horizon ${h7.horizon}`);
  check("'24h' window is 96 entries", () => assert.strictEqual(h24.day.length, 96));
  check("'7d' window is 672 entries", () => assert.strictEqual(h7.day.length, 672));
  check("'7d' spans today..day+6 at 15 min, no gaps", () => {
    assert.strictEqual(h7.day[0].time, `${DATE}T00:00`);
    assert.strictEqual(h7.day[671].time, `${dayAdd(DATE, 6)}T23:45`);
    assert.strictEqual(h7.day[672 - 1].time.slice(0, 10), dayAdd(DATE, 6));
  });
  check("'7d' keeps cross-midnight t_eff history (first frame not reset)", () => {
    assert.ok(h7.day[0].tEffH > 0.5, `first frame tEff ${h7.day[0].tEffH}`);
    assert.ok(Math.abs(h7.day[192].tEffH - h7.day[191].tEffH) <= 0.25 + 1e-9,
      `native->blended boundary reset: ${h7.day[191].tEffH} -> ${h7.day[192].tEffH}`);
    assert.strictEqual(h7.day[192].time.slice(0, 10), dayAdd(DATE, 2), 'blended starts day 3');
  });

  console.log('\n== [3c] firstDaySlice: 7d -> 24h narrow (zero refetch) ==');
  const firstDay = firstDaySlice(h7.day);
  console.log(`  firstDaySlice ${firstDay.length} entries, first date ${firstDay[0].time.slice(0, 10)}`);
  check('firstDaySlice of the 7-day day -> 96 entries, all first date', () => {
    assert.strictEqual(firstDay.length, 96);
    assert.ok(firstDay.every((e) => e.time.slice(0, 10) === firstDay[0].time.slice(0, 10)));
  });
  check('equivalent to selectDay on the same series (count + times)', () => {
    const ref = selectDay(h7.series, firstDay[0].time.slice(0, 10));
    assert.strictEqual(firstDay.length, ref.length);
    assert.deepStrictEqual(firstDay.map((e) => e.time), ref.map((e) => e.time));
  });

  console.log('\n== [3d] Stage 6A dual-location ingest: shoreDay, fail-open, one fetch ==');
  function synthTwo(date) {
    const lake = synthMinutely(date);
    const shore = synthMinutely(date);
    shore.location_id = 1;
    shore.minutely_15.wind_speed_10m = shore.minutely_15.wind_speed_10m.map((v) => v + 5);
    return [lake, shore];
  }

  const dual = await ingest({ json: synthTwo(DATE), gamma: meta.gamma_deg, now: at1712 });
  console.log(`  dual: day ${dual.day.length}, shoreDay ${dual.shoreDay.length}, ` +
    `lake cur ${dual.day[dual.currentIndex].speedMph.toFixed(2)} mph, ` +
    `shore cur ${dual.shoreDay[dual.currentIndex].speedMph.toFixed(2)} mph`);
  check('shoreDay matches day length and timestamps on a synthetic dual payload', () => {
    assert.strictEqual(dual.shoreDay.length, dual.day.length);
    for (let i = 0; i < dual.day.length; i++) {
      assert.strictEqual(dual.shoreDay[i].time, dual.day[i].time, `time[${i}]`);
    }
    assert.ok(dual.shoreDay[0].speedMph > dual.day[0].speedMph, 'shore fixture is distinct');
  });
  check('shoreDay shares the exact entry shape (buildSeriesFrom path)', () => {
    const keys = Object.keys(dual.day[0]).sort().join(',');
    assert.strictEqual(Object.keys(dual.shoreDay[0]).sort().join(','), keys);
  });

  const dual7 = await ingest({ json: [synth8(DATE), synth8(DATE)], gamma: meta.gamma_deg, now: at1712, horizon: '7d' });
  console.log(`  dual 7d: day ${dual7.day.length}, shoreDay ${dual7.shoreDay.length}`);
  check("'7d' shoreDay also matches the 672-frame window", () => {
    assert.strictEqual(dual7.shoreDay.length, dual7.day.length);
    assert.strictEqual(dual7.shoreDay[671].time, dual7.day[671].time);
  });

  const bad1 = await ingest({ json: synthMinutely(DATE), gamma: meta.gamma_deg, now: at1712 });
  const bad2 = await ingest({ json: [synthMinutely(DATE)], gamma: meta.gamma_deg, now: at1712 });
  const allNull = synthMinutely(DATE);
  allNull.minutely_15.wind_speed_10m = allNull.minutely_15.wind_speed_10m.map(() => null);
  const bad3 = await ingest({ json: [synthMinutely(DATE), allNull], gamma: meta.gamma_deg, now: at1712 });
  check('malformed/one-location/no-shore-speed payloads -> shoreDay null, no throw', () => {
    assert.strictEqual(bad1.shoreDay, null, 'object not array');
    assert.strictEqual(bad2.shoreDay, null, 'array of 1');
    assert.strictEqual(bad3.shoreDay, null, 'shore wind_speed_10m all null');
    assert.strictEqual(bad1.day.length, 96, 'lake path unaffected');
  });

  const realFetch = global.fetch;
  let calls = 0, seenUrl = null;
  global.fetch = async (url) => {
    calls++; seenUrl = url;
    return { ok: true, json: async () => synthTwo(DATE) };
  };
  try {
    const net = await ingest({ gamma: meta.gamma_deg, now: at1712 });
    check('ingest hits the network exactly once with both coordinates in the URL', () => {
      assert.strictEqual(calls, 1, `fetch calls ${calls}`);
      assert.ok(seenUrl.includes('latitude=46.22,46.13'), seenUrl);
      assert.ok(seenUrl.includes('longitude=-93.657,-93.57'), seenUrl);
      assert.ok(net.shoreDay && net.shoreDay.length === 96, 'shore parsed from the same response');
    });
  } finally {
    global.fetch = realFetch;
  }

  console.log('\n== [4] live Open-Meteo ingest + 96-frame field table ==');
  const tables = decodeTables(fs.readFileSync(path.join(ROOT, 'public', 'tables.v1.bin')));
  let live;
  try {
    live = await ingest({ gamma: meta.gamma_deg });
  } catch (e) {
    console.log(`  FAIL live ingest: ${e.message}`);
    failures++;
    return finish();
  }
  console.log(`  point ${live.point.lat},${live.point.lon} | local date ${chicagoNow().date} | ` +
    `series ${live.series.length} @ ${live.stepMin} min, today ${live.day.length}, current idx ${live.currentIndex}`);
  check('live day has 96 frames', () => assert.strictEqual(live.day.length, 96, `got ${live.day.length}`));

  const scratch = {
    out: new Float64Array(BATHY_CELLS),
    afterKs: new Float64Array(BATHY_CELLS),
    ts: new Float64Array(BATHY_CELLS),
  };
  console.log('  local time        mph  gust dir  bearing_grid  t_eff  Hs_max  roller');
  const frames = [];
  for (let i = 0; i < live.day.length; i++) {
    const e = live.day[i];
    const f = computeFrame(tables, e, { gamma: meta.gamma_deg, ...scratch });
    frames.push(f);
    if (i % 4 === 0) {
      console.log(`  ${e.time.replace('T', ' ')}  ${e.speedMph.toFixed(0).padStart(3)}  ` +
        `${e.gustMph.toFixed(0).padStart(3)}  ${e.dirTrueDeg.toFixed(0).padStart(3)}  ` +
        `${e.bearingGrid.toFixed(2).padStart(11)}  ${e.tEffH.toFixed(2).padStart(5)}  ` +
        `${f.maxHs.toFixed(2).padStart(6)}  ${f.rollerFt.toFixed(2).padStart(6)}`);
    }
  }
  check('all 96 frames produced a finite, non-negative lake-max Hs', () => {
    let calm = 0;
    for (const f of frames) {
      assert.ok(Number.isFinite(f.maxHs) && f.maxHs >= 0, `bad maxHs ${f.maxHs}`);
      if (f.maxHs === 0) calm++;
    }
    console.log(`       ${calm} calm frame(s) (<4 mph lull -> t_eff 0)`);
  });
  check('Hs_max cap: roller uses post-Ks pre-0.6d value', () => {
    for (const f of frames) {
      const d = tables.depth[f.maxIdx] * 0.25;
      const expect = Math.min(1.67 * f.afterKs[f.maxIdx], 0.78 * d);
      assert.ok(Math.abs(f.rollerFt - expect) < 1e-9, `roller ${f.rollerFt} vs ${expect}`);
    }
  });

  console.log('\n== [5] per-frame field benchmark (blending enabled) ==');
  const ITERS = 2;
  for (const e of live.day) computeFrame(tables, e, { gamma: meta.gamma_deg, ...scratch });
  const t0 = performance.now();
  for (let it = 0; it < ITERS; it++) for (const e of live.day) computeFrame(tables, e, { gamma: meta.gamma_deg, ...scratch });
  const msPerFrame = (performance.now() - t0) / (ITERS * live.day.length);
  console.log(`  ms/frame (blended, incl. lake-max scan): ${msPerFrame.toFixed(3)} (budget <= 6)`);
  check('budget <= 6 ms/frame', () => assert.ok(msPerFrame <= 6, `${msPerFrame} ms`));

  finish();
})().catch((e) => { console.error(e); failures++; finish(); });

function finish() {
  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}
