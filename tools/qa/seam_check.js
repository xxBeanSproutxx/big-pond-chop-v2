'use strict';
// Stage 5E live seam check: verify the +48 h handoff from native minutely_15 to
// vector-blended hourly frames is continuous. Run: node tools/qa/seam_check.js
// Exits non-zero when either delta breaches its gate. Live network required.

const wind = require('../../src/wind');

const SPEED_GATE = 2.0; // mph
const BEARING_GATE = 6.0; // degrees

function addDays(dateStr, n) {
  const ms = Date.parse(`${dateStr}T00:00:00Z`) + n * 86400000;
  return new Date(ms).toISOString().slice(0, 10);
}

function shortestArc(a, b) {
  const d = Math.abs(Number(a) - Number(b)) % 360;
  return d > 180 ? 360 - d : d;
}

function rawHourlyAt(hourly, hourKey) {
  const t = (hourly && hourly.time) || [];
  for (let i = 0; i < t.length; i++) {
    if (t[i].slice(0, 13) === hourKey) {
      return { speed: Number(hourly.wind_speed_10m[i]), dir: Number(hourly.wind_direction_10m[i]) };
    }
  }
  return null;
}

(async () => {
  const now = new Date();
  const data = await wind.ingest({ horizon: '7d', now });
  const today = wind.chicagoNow(now).date;
  const seamDate = addDays(today, 2); // first frame of local day 3 = +48 h
  const series = data.series;

  let seam = -1;
  for (let i = 0; i < series.length; i++) {
    if (series[i].time.slice(0, 10) === seamDate) { seam = i; break; }
  }
  if (seam <= 0) {
    console.log(`SEAM FAIL no seam frame for date ${seamDate} (series ${series.length}, today ${today})`);
    process.exit(1);
  }

  const prev = series[seam - 1];
  const cur = series[seam];
  const dSpeed = Math.abs(cur.speedMph - prev.speedMph);
  const dBearing = shortestArc(cur.dirTrueDeg, prev.dirTrueDeg);
  const pass = dSpeed <= SPEED_GATE && dBearing <= BEARING_GATE;

  const raw = rawHourlyAt(data.raw && data.raw.hourly, cur.time.slice(0, 13));
  const rawStr = raw ? `speed=${raw.speed} dir=${raw.dir}` : '(raw hour not found)';

  console.log(`  prev ${prev.time}  speed=${prev.speedMph}  dir=${prev.dirTrueDeg}`);
  console.log(`  seam ${cur.time}  speed=${cur.speedMph}  dir=${cur.dirTrueDeg}`);
  console.log(`  dSpeed=${dSpeed.toFixed(2)} mph (gate <= ${SPEED_GATE})  ` +
    `dDir=${dBearing.toFixed(2)} deg (gate <= ${BEARING_GATE})`);
  console.log(`  seam anchor blended speed=${cur.speedMph} dir=${cur.dirTrueDeg} | ` +
    `raw hourly ${rawStr}`);
  console.log(`SEAM ${seamDate} frame=${seam} dSpeed=${dSpeed.toFixed(2)} ` +
    `dDir=${dBearing.toFixed(2)} ${pass ? 'PASS' : 'FAIL'}`);
  process.exit(pass ? 0 : 1);
})().catch((err) => {
  console.log(`SEAM FAIL ${err && err.message ? err.message : err}`);
  process.exit(1);
});
