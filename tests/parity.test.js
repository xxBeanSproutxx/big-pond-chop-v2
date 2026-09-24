'use strict';
// Stage 1 parity + invariants + bundle layout + perf. Run: node tests/parity.test.js
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const {
  decodeTables, fetchIndex, TOTAL_BYTES, OFF_FETCH, FETCH_ROWS, FETCH_COLS,
  LAND_U16, BATHY_CELLS,
} = require('../src/tables');
const {
  waveCore, spm, dispersionExact, dispersionFast, tanhLUT, tanhExact, G, FT,
} = require('../src/wave-math');

const ROOT = path.join(__dirname, '..');
const BIN = path.join(ROOT, 'public', 'tables.v1.bin');
const GOLDEN = path.join(ROOT, 'tests', 'fixtures', 'golden.json');
const U_MPH = 30;
const U_MPS = U_MPH * 0.44704;
const T_EFF_S = 8 * 3600;
const WIND_DIR = 315;

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}

// =====================================================================
console.log('\n== [1] golden parity ==');
const golden = JSON.parse(fs.readFileSync(GOLDEN, 'utf8'));
const pyByFixture = {};
for (const [name, fx] of Object.entries(golden)) {
  const r = waveCore(fx.F_mi * 1609.34, fx.dpath_ft, fx.dlocal_ft, U_MPS, T_EFF_S);
  pyByFixture[name] = r;
}
console.log('  fixture            field     python(golden)        JS        |delta|   limit');
for (const [name, fx] of Object.entries(golden)) {
  const js = pyByFixture[name];
  const rows = [
    ['Hs_ft', fx.Hs_ft, js.Hs_ft, 0.01],
    ['T_s', fx.T_s, js.T_s, 0.01],
    ['Ks', fx.Ks, js.Ks, 0.01],
    ['capped_ft', fx.capped_ft, js.capped_ft, 0.01],
  ];
  for (const [k, py, jsv, lim] of rows) {
    const d = Math.abs(py - jsv);
    const flag = d <= lim ? ' ' : '!';
    console.log(`  ${name.padEnd(18)} ${k.padEnd(9)} ${String(py).padEnd(18)} ${jsv.toFixed(6).padEnd(12)} ${d.toExponential(2).padEnd(10)} ${lim}${flag}`);
  }
}
check('Hs_ft/T_s/Ks/capped_ft within 0.01 (ft/s)', () => {
  for (const [name, fx] of Object.entries(golden)) {
    const js = pyByFixture[name];
    assert.ok(Math.abs(fx.Hs_ft - js.Hs_ft) <= 0.01, `${name} Hs`);
    assert.ok(Math.abs(fx.T_s - js.T_s) <= 0.01, `${name} T`);
    assert.ok(Math.abs(fx.Ks - js.Ks) <= 0.01, `${name} Ks`);
    assert.ok(Math.abs(fx.capped_ft - js.capped_ft) <= 0.01, `${name} capped`);
  }
});

// =====================================================================
console.log('\n== [2] dims / ordering ==');
const tables = decodeTables(fs.readFileSync(BIN));
check('bundle length is 16*98*95 fetch + 292*285 depth', () => {
  assert.strictEqual(fs.statSync(BIN).size, TOTAL_BYTES);
  assert.strictEqual(tables.fetchEff.length, 16 * 98 * 95);
  assert.strictEqual(tables.pathEff.length, 16 * 98 * 95);
  assert.strictEqual(tables.depth.length, 292 * 285);
});
check('(dir,row,col) marker round-trip, no transpose', () => {
  const dir = 3, row = 70, col = 12;
  const buf = Buffer.from(tables.bytes); // clone
  const marker = 0xbeef;
  const i = fetchIndex(dir, row, col);
  buf.writeUInt16LE(marker, OFF_FETCH + i * 2);
  const t2 = decodeTables(buf);
  assert.strictEqual(t2.fetchEff[i], marker, 'marker not at (dir,row,col)');
  const transposed = (dir * FETCH_COLS + col) * FETCH_ROWS + row; // [dir][col][row] layout
  assert.notStrictEqual(transposed, i, 'transposed index collided');
  assert.notStrictEqual(t2.fetchEff[transposed], marker, 'marker leaked to transposed index');
  const before = tables.fetchEff[transposed];
  assert.strictEqual(t2.fetchEff[transposed], before, 'transposed cell mutated');
  console.log(`       wrote 0x${marker.toString(16)} at fetch[dir=${dir},row=${row},col=${col}] (flat ${i}); ` +
              `read back ${t2.fetchEff[i]}; [dir=${dir},col=${col},row=${row}] (flat ${transposed}) = ${t2.fetchEff[transposed]}`);
});

// =====================================================================
console.log('\n== [3] endianness ==');
check('little-endian uint16 decode matches byte composition', () => {
  const raw = tables.bytes;
  const off = OFF_FETCH + fetchIndex(0, 0, 0) * 2;
  const manual = raw[off] | (raw[off + 1] << 8);
  const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  assert.strictEqual(dv.getUint16(off, true), manual);
  assert.strictEqual(dv.getUint16(off, true), tables.fetchEff[fetchIndex(0, 0, 0)]);
});

// =====================================================================
console.log('\n== [4] unit guards ==');
check('Hs_final_ft === min(Ks*Hs_ft, 0.6*d_local_ft), all ft', () => {
  for (const [name, fx] of Object.entries(golden)) {
    const r = pyByFixture[name];
    assert.strictEqual(r.capped_ft, Math.min(r.Ks * r.Hs_ft, 0.6 * fx.dlocal_ft), name);
  }
});
check('roller_ft uses ft operands', () => {
  for (const [name, fx] of Object.entries(golden)) {
    const r = pyByFixture[name];
    const expect = Math.min(1.67 * r.Ks * r.Hs_ft, 0.78 * fx.dlocal_ft);
    assert.ok(Math.abs(r.roller_ft - expect) <= 1e-12, `${name} ${r.roller_ft} vs ${expect}`);
  }
});

// =====================================================================
console.log('\n== [5] model invariants ==');
check('SPM shallow -> deep within 1.2% for F~ in [100,1000] at deep water', () => {
  const U_A = 0.71 * Math.pow(U_MPS, 1.23);
  const deep_ft = 1000; // h~ large => P1,P2 ~ 1
  let worst = 0;
  for (let Fstar = 100; Fstar <= 1000; Fstar += 50) {
    const F_m = Fstar * U_A * U_A / G;
    const s = spm(U_MPS, F_m, deep_ft, 1e9, tanhExact);
    const deep_m = 0.283 * (U_A * U_A / G) * Math.tanh(0.00565 * Math.sqrt(Fstar));
    worst = Math.max(worst, Math.abs(s.Hs_m - deep_m) / deep_m);
  }
  console.log(`       worst relative deviation over F~=[100,1000]: ${(worst * 100).toFixed(4)}%`);
  assert.ok(worst <= 0.012, `shallow/deep deviation ${worst}`);
});
check('duration identity Hs(F_dur=U_A*t) == Hs(t)', () => {
  const U_A = 0.71 * Math.pow(U_MPS, 1.23);
  const t_s = 3 * 3600;
  const a = spm(U_MPS, U_A * t_s, 100, t_s, tanhExact);
  const b = spm(U_MPS, U_A * t_s, 100, 100 * 3600, tanhExact);
  assert.ok(Math.abs(a.Hs_m - b.Hs_m) < 1e-12);
  assert.ok(Math.abs(a.T_s - b.T_s) < 1e-12);
});
check('LUT tanh wave result vs exact Math.tanh <= 1e-5 m', () => {
  let worst = 0;
  for (const [name, fx] of Object.entries(golden)) {
    const lut = waveCore(fx.F_mi * 1609.34, fx.dpath_ft, fx.dlocal_ft, U_MPS, T_EFF_S, { exactTanh: false });
    const ex = waveCore(fx.F_mi * 1609.34, fx.dpath_ft, fx.dlocal_ft, U_MPS, T_EFF_S, { exactTanh: true });
    worst = Math.max(worst, Math.abs(lut.Hs_ft - ex.Hs_ft) * FT);
  }
  console.log(`       worst LUT-vs-exact Hs delta: ${worst.toExponential(3)} m`);
  assert.ok(worst <= 1e-5, `LUT tanh delta ${worst} m`);
});
check('dispersionFast vs exact cg within 0.5% across field envelope', () => {
  let worst = 0;
  for (let T = 0.3; T <= 9; T += 0.37) {
    for (let h = 0.3; h <= 13; h += 0.53) {
      const f = dispersionFast(T, h);
      const e = dispersionExact(T, h, tanhExact);
      worst = Math.max(worst, Math.abs(f.cg_mps - e.cg_mps) / e.cg_mps);
    }
  }
  console.log(`       worst fast-vs-exact cg relative error: ${(worst * 100).toFixed(4)}%`);
  assert.ok(worst <= 0.005, `cg LUT error ${worst}`);
});

// =====================================================================
console.log('\n== [PERF] per-hour field over all 83,220 cells ==');
const { computeField } = require('../src/wave-math');
const out = new Float64Array(BATHY_CELLS);
for (let i = 0; i < 50; i++) computeField(tables, U_MPH, WIND_DIR, out);
const ITERS = 500;
const t0 = performance.now();
for (let i = 0; i < ITERS; i++) computeField(tables, U_MPH, WIND_DIR, out);
const msPerHour = (performance.now() - t0) / ITERS;
let wet = 0;
for (let i = 0; i < out.length; i++) if (out[i] > 0) wet++;
console.log(`  cells/hour        : ${BATHY_CELLS}`);
console.log(`  water cells w/ Hs : ${wet}`);
console.log(`  ms/hour           : ${msPerHour.toFixed(3)} (budget 2-6)`);

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);
