'use strict';
// P1 delay-math fixtures. Run: node --test (auto-discovers tests/; Node 22.23.1
// rejects a directory positional — same quirk P0 recorded).
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { decodeTables } = require('../src/tables');
const waveMath = require('../src/wave-math');
const { computeTeff } = require('../src/wind');
const render = require('../src/render');

const ROOT = path.join(__dirname, '..');
const GOLDEN = path.join(ROOT, 'tests', 'fixtures', 'golden.json');
const MPS_PER_MPH = 0.44704;
const HOUR = 3600000;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}
const eq = (a, b) => Buffer.from(a.buffer, a.byteOffset, a.byteLength)
  .equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

async function main() {
  const delay = await import('../src/delay-math.mjs');
  const guard = await import('../worker/guard.mjs');
  const gamma = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'meta.v1.json'), 'utf8')).gamma_deg;
  const tables = decodeTables(fs.readFileSync(path.join(ROOT, 'public', 'tables.v1.bin')));

  // =====================================================================
  console.log('\n== [1] PARITY: delay OFF === render.computeFrame ==');
  const entries3 = [
    { speedMph: 12, dirTrueDeg: 315, tEffH: 4 },
    { speedMph: 25, dirTrueDeg: 90, tEffH: 1 },
    { speedMph: 7, dirTrueDeg: 200, tEffH: 6 },
  ];
  check('delay-off is bit-identical to v1 computeFrame (.capped/.afterKs/.ts + .bin)', () => {
    entries3.forEach((entry, i) => {
      const e = { ...entry, tMs: Date.UTC(2026, 0, 1) + i * HOUR };
      const ref = render.computeFrame(tables, entry, { gamma });
      const got = delay.computeDelayedField(tables, [e], e.tMs, { gamma, delay: false, frameIndex: 0 });
      assert.ok(eq(ref.capped, got.capped), `entry ${i} capped differs`);
      assert.ok(eq(ref.afterKs, got.afterKs), `entry ${i} afterKs differs`);
      assert.ok(eq(ref.ts, got.ts), `entry ${i} ts differs`);
      const rb = guard.quantize(ref.capped, tables.depth);
      const gb = guard.quantize(got.capped, tables.depth);
      assert.ok(Buffer.from(rb).equals(Buffer.from(gb)), `entry ${i} .bin differs`);
      console.log(`       entry ${i} (${entry.speedMph} mph, ${entry.dirTrueDeg}°, ${entry.tEffH} h) bit-identical`);
    });
  });

  // =====================================================================
  console.log('\n== [2] DELAY: step shift, spatial travel time ==');
  const F14 = 14 * delay.M_PER_MI;   // 22,530.816 m
  const F55 = 5.5 * delay.M_PER_MI;  // 8,851.392 m
  const DP = 30, DL = 40;
  const hsOf = (F, e) => waveMath.waveCore(F, DP, DL, e.speedMph * MPS_PER_MPH, e.tEffH * 3600).capped_ft;

  function seriesStep(stepAt, oldSpd, newSpd) {
    const entries = [];
    for (let i = 0; i < 48; i++) {
      entries.push({
        tMs: Date.UTC(2026, 0, 1) + i * HOUR,
        speedMph: i < stepAt ? oldSpd : newSpd,
        dirTrueDeg: 315, bearingGrid: 315,
      });
    }
    const teff = computeTeff(entries, 1);
    entries.forEach((e, i) => { e.tEffH = teff[i]; });
    return entries;
  }
  function firstMoved(series, F, cg) {
    const times = series.map((e) => e.tMs);
    const t0 = series[24].tMs;
    for (let k = 0; k <= 8; k++) {
      const si = delay.sampleIndex(times, t0 + k * HOUR - delay.tauHours(F, cg) * HOUR);
      if (series[si].speedMph !== series[23].speedMph) return k;
    }
    return null;
  }

  check('tau: 14 mi -> 1.272727 h, 5.5 mi -> 0.5 h', () => {
    assert.ok(Math.abs(delay.tauHours(F14) - 1.2727272727272727) < 1e-12, `tau14 ${delay.tauHours(F14)}`);
    assert.ok(Math.abs(delay.tauHours(F55) - 0.5) < 1e-12, `tau55 ${delay.tauHours(F55)}`);
    console.log(`       tau_14mi=${delay.tauHours(F14).toFixed(6)} h  tau_5.5mi=${delay.tauHours(F55).toFixed(6)} h`);
  });

  for (const [label, oldSpd, newSpd] of [['decay', 25, 5], ['ramp-up', 5, 25]]) {
    const series = seriesStep(24, oldSpd, newSpd);
    const times = series.map((e) => e.tMs);
    const t0 = series[24].tMs;
    check(`${label}: 14 mi holds old through t0+1 h, new equilibrium from t0+2 h`, () => {
      const eqOld = hsOf(F14, series[23]);
      const eqNew = hsOf(F14, series[24]);
      for (const k of [-1, 0, 1]) {
        const si = delay.sampleIndex(times, t0 + k * HOUR - delay.tauHours(F14) * HOUR);
        assert.strictEqual(series[si].speedMph, oldSpd, `k=${k} sampled speed`);
        assert.strictEqual(hsOf(F14, series[si]), eqOld, `k=${k} not old equilibrium`);
      }
      for (let k = 2; k <= 8; k++) {
        const si = delay.sampleIndex(times, t0 + k * HOUR - delay.tauHours(F14) * HOUR);
        assert.strictEqual(series[si].speedMph, newSpd, `k=${k} sampled speed`);
        assert.strictEqual(hsOf(F14, series[si]), eqNew, `k=${k} not new equilibrium`);
      }
      assert.strictEqual(firstMoved(series, F14), 2, '14 mi first moved');
    });
    check(`${label}: 5.5 mi moves at t0+1 h while the 14 mi cell does not`, () => {
      assert.strictEqual(firstMoved(series, F55), 1, '5.5 mi first moved');
      const T = t0 + HOUR;
      const sl = delay.sampleIndex(times, T - delay.tauHours(F14) * HOUR);
      const ss = delay.sampleIndex(times, T - delay.tauHours(F55) * HOUR);
      assert.strictEqual(series[sl].speedMph, oldSpd, 'long cell old at t0+1 h');
      assert.strictEqual(series[ss].speedMph, newSpd, 'short cell new at t0+1 h');
      console.log(`       first_moved_14mi=${firstMoved(series, F14)}h first_moved_5.5mi=${firstMoved(series, F55)}h`);
    });
  }

  check('mutation proof: cg=1e12 (delay off) moves the 14 mi cell at t0+1 h', () => {
    const series = seriesStep(24, 25, 5);
    const times = series.map((e) => e.tMs);
    const si = delay.sampleIndex(times, series[24].tMs + HOUR - delay.tauHours(F14, 1e12) * HOUR);
    assert.strictEqual(series[si].speedMph, 5, 'with no delay the cell must already see the new wind at t0+1 h');
  });

  // =====================================================================
  console.log('\n== [3] REEF: steady wind, delay ON === OFF === v1 (full grid) ==');
  check('steady wind: ON/OFF bit-identical, .bin byte-identical, == computeFrame', () => {
    const series = [];
    for (let i = 0; i < 48; i++) {
      series.push({ tMs: Date.UTC(2026, 0, 1) + i * HOUR, speedMph: 25, dirTrueDeg: 315, tEffH: 8 });
    }
    const times = series.map((e) => e.tMs);
    for (const f of [0, 6, 12, 24, 36, 47]) {
      const on = delay.computeDelayedField(tables, series, series[f].tMs,
        { gamma, delay: true, frameIndex: f, frameDirDeg: 315, timesMs: times });
      const off = delay.computeDelayedField(tables, series, series[f].tMs, { gamma, delay: false, frameIndex: f });
      const ref = render.computeFrame(tables, series[f], { gamma });
      assert.ok(eq(on.capped, off.capped), `f${f} capped ON vs OFF`);
      assert.ok(eq(on.afterKs, off.afterKs), `f${f} afterKs ON vs OFF`);
      assert.ok(eq(off.capped, ref.capped), `f${f} capped OFF vs v1`);
      const ob = Buffer.from(guard.quantize(on.capped, tables.depth));
      const fb = Buffer.from(guard.quantize(off.capped, tables.depth));
      assert.ok(ob.equals(fb), `f${f} .bin ON vs OFF`);
      console.log(`       f${f}: buckets=${on.buckets} capped/afterKs/.bin identical`);
    }
  });
  check('golden Ks: shoaling cells in [0.93,0.98], all within v1 clamp [0.7,1.6]', () => {
    const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
    for (const [name, fx] of Object.entries(golden)) {
      assert.ok(fx.Ks >= 0.7 && fx.Ks <= 1.6, `${name} Ks ${fx.Ks} outside v1 clamp`);
      if (fx.Ks < 1) assert.ok(fx.Ks >= 0.93 && fx.Ks <= 0.98, `${name} shoaling Ks ${fx.Ks} outside [0.93,0.98]`);
      console.log(`       ${name}: Ks=${fx.Ks}`);
    }
  });

  // =====================================================================
  console.log('\n== [4] NULL-GRID: all-null AIFS rejected, write path gated ==');
  check('all-null AIFS -> no writes, last-good preserved, clean exit', () => {
    const allNull = {
      hourly: {
        time: ['2026-01-01T00:00', '2026-01-01T01:00'],
        wind_speed_10m: [null, null],
        wind_direction_10m: [null, null],
        wind_gusts_10m: [null, null],
        temperature_2m: [null, null],
        precipitation: [null, null],
      },
    };
    const near = guard.rows(allNull, { gust: true });
    const mid = guard.rows(allNull);
    const ifs = guard.gustRows(allNull);
    assert.strictEqual(mid.length, 0, 'all-null AIFS must parse to zero rows');
    const decision = guard.decideModels({ near, mid, ifs });
    assert.strictEqual(decision.write, false, 'guard must reject');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bpc-guard-'));
    try {
      const res = guard.writeArtifacts(dir,
        { framesJson: { frames: [] }, windJson: { hours: [] }, bins: [] }, decision);
      assert.strictEqual(res.wrote, false);
      assert.deepStrictEqual(fs.readdirSync(dir), [], 'no artifact writes on rejection');
      // positive control: a live decision DOES write, so the gate is load-bearing.
      const ok = guard.decideModels({ near: [], mid: [{ t: 'x' }], ifs: [] });
      assert.strictEqual(ok.write, true);
      const res2 = guard.writeArtifacts(dir,
        { framesJson: { frames: [] }, windJson: { hours: [] }, bins: [] }, ok);
      assert.strictEqual(res2.wrote, true);
      assert.ok(fs.readdirSync(dir).includes('frames.json'), 'control must write');
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    console.log(`       decision=${decision.reason} write=${decision.write}; control write=${true}`);
  });

  console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
