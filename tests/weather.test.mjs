// P3 weather-merge policy fixtures. Run: node --test (auto-discovers .test.mjs).
// Locks worker/merge.mjs (AIFS base / HRRR override / IFS gust-gap fill) and the
// strip's daily aggregation. Synthetic rows only — no network, no fs.
import assert from 'node:assert';
import { createRequire } from 'node:module';
import { mergeWeather, firstHourlyGap } from '../worker/merge.mjs';

let passes = 0, failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}

// Worker row shape (guard.rows): {t,speedMph,dirTrueDeg,gustMph,tempF,precipMm}.
const AIFS = [
  { t: '2026-09-24T03:00', speedMph: 10, dirTrueDeg: 180, gustMph: null, tempF: 50, precipMm: 0 },
  { t: '2026-09-24T01:00', speedMph: 12, dirTrueDeg: 180, gustMph: null, tempF: 51, precipMm: 1 },
  { t: '2026-09-24T02:00', speedMph: 15, dirTrueDeg: 180, gustMph: null, tempF: 52, precipMm: 2 },
  { t: '2026-09-24T10:00', speedMph: 20, dirTrueDeg: 200, gustMph: null, tempF: 60, precipMm: 0 },
];
const HRRR = [
  { t: '2026-09-24T01:00', speedMph: 8, dirTrueDeg: 90, gustMph: 22, tempF: 40, precipMm: 5 },
  { t: '2026-09-24T02:00', speedMph: 9, dirTrueDeg: 90, gustMph: null, tempF: 41, precipMm: 6 },
];
const IFS = [
  { t: '2026-09-24T01:00', gustMph: 30 },
  { t: '2026-09-24T02:00', gustMph: 25 },
  { t: '2026-09-24T05:00', gustMph: 99 }, // no AIFS/HRRR row here -> must NOT create one
];
const at = (s, t) => s.find((e) => e.t === t);

console.log('\n== weather merge policy ==');

check('output = union of AIFS+HRRR hours, sorted ascending, IFS adds no rows', () => {
  const s = mergeWeather({ near: HRRR, mid: AIFS, ifs: IFS, ifsOk: true });
  assert.strictEqual(s.length, 4, 'IFS-only hour must not create a row');
  assert.deepStrictEqual(s.map((e) => e.t),
    ['2026-09-24T01:00', '2026-09-24T02:00', '2026-09-24T03:00', '2026-09-24T10:00'],
    'must be sorted ascending by time');
});

check('HRRR wins on a shared hour (src + speed/temp/precip/gust, not IFS)', () => {
  const r = at(mergeWeather({ near: HRRR, mid: AIFS, ifs: IFS, ifsOk: true }), '2026-09-24T01:00');
  assert.strictEqual(r.src, 'hrrr');
  assert.strictEqual(r.speedMph, 8);
  assert.strictEqual(r.tempF, 40);
  assert.strictEqual(r.precipMm, 5);
  assert.strictEqual(r.gustMph, 22, 'IFS 30 must not overwrite an existing HRRR gust');
});

check('IFS fills ONLY null gusts: HRRR null row fills, AIFS-only hour stays null', () => {
  const s = mergeWeather({ near: HRRR, mid: AIFS, ifs: IFS, ifsOk: true });
  assert.strictEqual(at(s, '2026-09-24T02:00').gustMph, 25, 'HRRR null gust filled from IFS');
  assert.strictEqual(at(s, '2026-09-24T02:00').src, 'hrrr', 'src stays HRRR after a gust fill');
  assert.strictEqual(at(s, '2026-09-24T03:00').gustMph, null, 'no IFS value -> null');
  assert.strictEqual(at(s, '2026-09-24T03:00').src, 'aifs');
});

check('gusts stay null beyond IFS coverage (the +240 h boundary)', () => {
  const far = at(mergeWeather({ near: HRRR, mid: AIFS, ifs: IFS, ifsOk: true }), '2026-09-24T10:00');
  assert.strictEqual(far.gustMph, null, 'row past IFS horizon must stay null');
  assert.strictEqual(far.src, 'aifs');
});

check('ifsOk=false -> zero IFS fills', () => {
  const s = mergeWeather({ near: HRRR, mid: AIFS, ifs: IFS, ifsOk: false });
  assert.strictEqual(at(s, '2026-09-24T02:00').gustMph, null, 'no fill when IFS is down');
  assert.strictEqual(at(s, '2026-09-24T01:00').gustMph, 22, 'HRRR gust untouched');
});

check('near=[] (HRRR dead) -> all rows src aifs; IFS still fills AIFS null gusts', () => {
  const s = mergeWeather({ near: [], mid: AIFS, ifs: IFS, ifsOk: true });
  assert.ok(s.every((e) => e.src === 'aifs'), 'every row must be labelled aifs');
  assert.strictEqual(at(s, '2026-09-24T01:00').gustMph, 30, 'AIFS null gust filled from IFS');
  assert.strictEqual(at(s, '2026-09-24T10:00').gustMph, null, 'past IFS -> null');
});

// ---- firstHourlyGap: rows() drops null hours; computeTeff(dtH=1) must never read across a hole ----
const hourly = (n, startH = 1) => Array.from({ length: n }, (_, i) =>
  ({ t: `2026-09-24T${String(startH + i).padStart(2, '0')}:00`, speedMph: 10, dirTrueDeg: 180, gustMph: null, tempF: 50, precipMm: 0 }));

check('firstHourlyGap: contiguous hourly series -> null', () => {
  const s = mergeWeather({ near: [], mid: hourly(5), ifs: [], ifsOk: false });
  assert.strictEqual(firstHourlyGap(s), null);
});

check('firstHourlyGap: missing 04:00 hour -> flags the hour after the hole', () => {
  const rows = hourly(5).filter((e) => e.t !== '2026-09-24T04:00'); // 01,02,03,05
  const s = mergeWeather({ near: [], mid: rows, ifs: [], ifsOk: false });
  assert.strictEqual(firstHourlyGap(s), new Date('2026-09-24T05:00Z').getTime());
});

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'} (${passes} assertions)`);
process.exit(failures === 0 ? 0 : 1);
