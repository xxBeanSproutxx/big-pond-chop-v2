// src/sun-times.mjs — NOAA solar calculation for sunrise/sunset.
// Pure ESM util mirroring the delay-math.mjs pattern.
// Returns UTC epoch ms; null for polar day/night.

const PI = Math.PI, DEG = PI / 180;

function julianDay(y, mo, d) {
  const a = Math.floor((14 - mo) / 12);
  const yy = y + 4800 - a, mm = mo + 12 * a - 3;
  return d + Math.floor((153 * mm + 2) / 5) + 365 * yy + Math.floor(yy / 4) -
    Math.floor(yy / 100) + Math.floor(yy / 400) - 32045;
}

export function sunTimesUtc(dateUtcMs, latDeg, lonDeg) {
  const date = new Date(dateUtcMs);
  const y = date.getUTCFullYear(), mo = date.getUTCMonth() + 1, day = date.getUTCDate();

  const jd = julianDay(y, mo, day);
  const t = (jd - 2451545 + 0.5) / 36525;

  const L0 = ((280.46646 + 36000.76983 * t + 0.0003032 * t * t) % 360) * DEG;
  const M = ((357.52911 + 35999.05029 * t - 0.0001537 * t * t) % 360) * DEG;
  const e = 0.016708634 - 0.000042037 * t - 0.0000001267 * t * t;
  const C = (1.914602 - 0.004817 * t - 0.000014 * t * t) * Math.sin(M) +
            (0.01993 - 0.000101 * t) * Math.sin(2 * M) + 0.000289 * Math.sin(3 * M);
  const sunLonDeg = ((L0 / DEG) + C) % 360;
  const sunLon = sunLonDeg * DEG;
  const obliq = (23.439291 - 0.013004 * t) * DEG;
  const dec = Math.asin(Math.sin(obliq) * Math.sin(sunLon));

  const yTan = Math.pow(Math.tan(obliq / 2), 2);
  const eotRad = yTan * Math.sin(2 * L0) - 2 * e * Math.sin(M) +
    0.5 * yTan * yTan * Math.sin(4 * L0) - 1.25 * e * e * Math.sin(2 * M);
  const eotMin = eotRad * 180 / PI * 4;

  const latRad = latDeg * DEG;
  // Solar altitude at sunrise: 0.833° below horizon (refraction + semi-diameter)
  const cosHa = (Math.sin(-0.833 * DEG) - Math.sin(latRad) * Math.sin(dec)) /
    (Math.cos(latRad) * Math.cos(dec));

  if (cosHa > 1 || cosHa < -1) return { sunriseMs: null, sunsetMs: null };

  const haDeg = Math.acos(cosHa) / DEG;
  const riseMin = 720 - 4 * (lonDeg + haDeg) - eotMin;
  const setMin = 720 - 4 * (lonDeg - haDeg) - eotMin;
  const noonUtc = Date.UTC(y, mo - 1, day, 12, 0, 0, 0);

  return {
    sunriseMs: noonUtc + (riseMin - 720) * 60000,
    sunsetMs: noonUtc + (setMin - 720) * 60000,
  };
}