// Phase 6: sunrise/sunset calculator fixtures.
// (a) equinox at (0,0): sunrise ≈ 06:00 UTC, sunset ≈ 18:00 UTC (±15 min)
// (b) polar day/night does not crash (returns nulls)
// (c) round-trip monotonicity across 15 consecutive days for Mille Lacs
import assert from 'node:assert';
import { sunTimesUtc } from '../src/sun-times.mjs';

const HOUR = 3600000;
const MIN = 60000;

let passes = 0, failures = 0;
function check(name, fn) {
  try { fn(); passes++; console.log(`  ok   ${name}`); }
  catch (e) { failures++; console.log(`  FAIL ${name}: ${e.message}`); }
}

const LAKE_LAT = 46.238, LAKE_LON = -93.642;

console.log('\n== Phase 6: sun-times ==');

check('(a) equinox at (0,0): sunrise ≈ 06:00 UTC, sunset ≈ 18:00 UTC (±15 min)', () => {
  // March equinox 2026: March 20, 12:00 UTC
  const equinox = Date.UTC(2026, 2, 20, 12, 0, 0, 0);
  const sun = sunTimesUtc(equinox, 0, 0);
  assert.ok(sun.sunriseMs != null, 'should have sunrise');
  assert.ok(sun.sunsetMs != null, 'should have sunset');
  const riseH = (sun.sunriseMs - Date.UTC(2026, 2, 20, 0, 0, 0, 0)) / HOUR;
  const setH = (sun.sunsetMs - Date.UTC(2026, 2, 20, 0, 0, 0, 0)) / HOUR;
  console.log(`       equator equinox: rise ${riseH.toFixed(2)}h UTC, set ${setH.toFixed(2)}h UTC`);
  assert.ok(Math.abs(riseH - 6) <= 0.25, `sunrise ${riseH}h UTC (expected ~6h)`);
  assert.ok(Math.abs(setH - 18) <= 0.25, `sunset ${setH}h UTC (expected ~18h)`);
});

check('(b) polar day/night returns nulls without crashing', () => {
  // North Pole on summer solstice (polar day — no sunset)
  const summer = Date.UTC(2026, 5, 21, 12, 0, 0, 0);
  const north = sunTimesUtc(summer, 80, 0);
  // The sun never sets at 80°N in June
  console.log(`       polar day (80°N June): sunrise ${north.sunriseMs != null}, sunset ${north.sunsetMs != null}`);
  // At least one should be null during polar day
  assert.ok(north.sunriseMs == null || north.sunsetMs == null,
    `polar day should have at least one null, got rise=${north.sunriseMs} set=${north.sunsetMs}`);

  // South Pole on winter solstice (also polar day for south — no sunset for north)
  // 80°S in December is polar day (sun never sets)
  const winter = Date.UTC(2026, 11, 21, 12, 0, 0, 0);
  const south = sunTimesUtc(winter, -80, 0);
  console.log(`       polar day (80°S Dec): sunrise ${south.sunriseMs != null}, sunset ${south.sunsetMs != null}`);
  assert.ok(south.sunriseMs == null || south.sunsetMs == null,
    `polar day should have at least one null, got rise=${south.sunriseMs} set=${south.sunsetMs}`);
});

check('(c) 15 consecutive days at Mille Lacs: sunrise < sunset, both strictly increasing', () => {
  let prevRise = null, prevSet = null;
  for (let d = 0; d < 15; d++) {
    const noon = Date.UTC(2026, 8, 11 + d, 12, 0, 0, 0);
    const sun = sunTimesUtc(noon, LAKE_LAT, LAKE_LON);
    assert.ok(sun.sunriseMs != null && sun.sunsetMs != null,
      `day ${d} should have both times at Mille Lacs (46.2°N)`);
    assert.ok(sun.sunriseMs < sun.sunsetMs, `day ${d}: sunrise < sunset`);
    if (prevRise != null) {
      assert.ok(sun.sunriseMs > prevRise, `day ${d}: sunrise strictly increasing`);
      assert.ok(sun.sunsetMs > prevSet, `day ${d}: sunset strictly increasing`);
    }
    prevRise = sun.sunriseMs;
    prevSet = sun.sunsetMs;
  }
  const first = new Date(prevRise), last = new Date(prevSet);
  console.log(`       Sep 11 sunrise ${first.getUTCHours()}:${String(first.getUTCMinutes()).padStart(2, '0')} UTC, ` +
    `Sep 25 sunset ${last.getUTCHours()}:${String(last.getUTCMinutes()).padStart(2, '0')} UTC, increasing ✓`);
});

console.log(`\n${failures === 0 ? 'ALL TESTS PASSED' : failures + ' TEST(S) FAILED'}`);
process.exit(failures === 0 ? 0 : 1);