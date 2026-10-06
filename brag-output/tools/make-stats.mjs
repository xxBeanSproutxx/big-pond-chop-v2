// One-off: precompute the readouts baked into the brag composition (deterministic, real data).
import { readFileSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const frames = JSON.parse(readFileSync(join(repo, "data", "frames.json")));
const wind = JSON.parse(readFileSync(join(repo, "data", "wind.json")));
const SECT = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
const TZ = "America/Chicago";

function percentile(a, p) {
  const s = [...a].sort((x, y) => x - y);
  if (!s.length) return 0;
  const i = (s.length - 1) * p, lo = Math.floor(i), hi = Math.ceil(i);
  return s[lo] + (s[hi] - s[lo]) * (i - lo);
}
function tier(maxHs, roller) {
  if (maxHs >= 5.0 || roller >= 4.0) return ["red", "Dangerous · Stay Home"];
  if (maxHs >= 3.5 || roller >= 2.5) return ["amber", "Heavy Rollers"];
  if (maxHs >= 2.0 || roller >= 1.5) return ["yellow", "Walleye Chop"];
  return ["green", "Fishable · Light Chop"];
}
function nearestWind(t) {
  let best = wind.hours[0], bd = Infinity;
  for (const h of wind.hours) { const d = Math.abs(Date.parse(h.t) - Date.parse(t)); if (d < bd) { bd = d; best = h; } }
  return best;
}
function fmt(t) {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric", hour: "numeric" }).format(new Date(t));
}

const KEYS = [0, 12, 24, 36, 42, 43, 48, 60, 72, 84];
const out = { keyframes: {}, days: [] };
for (const i of KEYS) {
  const f = frames.frames[i];
  const bin = readFileSync(join(repo, "data", f.file));
  const water = [];
  let max = 0;
  for (const v of bin) { if (v !== 255) { const ft = v / 32; water.push(ft); if (ft > max) max = ft; } }
  const roller = 1.67 * max;
  const e = nearestWind(f.t);
  const dir = ((Number(e.dir) % 360) + 360) % 360;
  out.keyframes[i] = {
    p10: +percentile(water, 0.1).toFixed(1),
    max: +max.toFixed(1),
    roller: +roller.toFixed(1),
    wind: Math.round(e.speed), gust: Math.round(e.gust),
    sector: SECT[Math.round(dir / 45) % 8], dir: Math.round(dir),
    label: fmt(f.t), tierKey: tier(max, roller)[0], tierLabel: tier(max, roller)[1],
  };
}

// 15 day cells from the frame index: day head, date, and that day's peak wind.
const dayNames = ["SUN", "MON", "TUE", "WED", "THU", "FRI", "SAT"];
const seen = new Set();
for (const f of frames.frames) {
  const d = new Date(f.t);
  const key = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(d);
  if (seen.has(key)) continue;
  seen.add(key);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "short", month: "short", day: "numeric" }).formatToParts(d);
  const weekday = parts.find((p) => p.type === "weekday").value.toUpperCase().slice(0, 3);
  const day = parts.find((p) => p.type === "day").value;
  const dayWind = wind.hours.filter((h) => new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(h.t)) === key);
  const peak = dayWind.length ? Math.max(...dayWind.map((h) => Number(h.speed))) : 0;
  out.days.push({ head: weekday, date: day, wind: Math.round(peak) });
  if (out.days.length >= 15) break;
}

writeFileSync(join(here, "stats.json"), JSON.stringify(out, null, 2));
console.log(JSON.stringify(out, null, 1));
void dayNames;
