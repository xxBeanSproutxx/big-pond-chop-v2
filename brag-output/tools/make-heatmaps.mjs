// One-off: turn Mille Lacs Hs frames into transparent PNG heat overlays.
// Uses the project's exact Hs palette (src/ui.js HS_STOPS) so the video matches the app.
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const cols = 285, rows = 292;

const STOPS = [
  [0.0, 0x08, 0x91, 0xb2],
  [1.0, 0x06, 0xb6, 0xd4],
  [2.0, 0xf5, 0x9e, 0x0b],
  [3.5, 0xea, 0x58, 0x0c],
  [4.5, 0xdc, 0x26, 0x26],
  [5.5, 0xbe, 0x18, 0x5d],
];
function colorForHs(hs) {
  if (!(hs > 0)) return [0, 0, 0, 0];
  const t = Math.min(hs, STOPS[STOPS.length - 1][0]);
  let i = 0;
  while (i < STOPS.length - 2 && t > STOPS[i + 1][0]) i++;
  const a = STOPS[i], b = STOPS[i + 1];
  const f = (t - a[0]) / (b[0] - a[0]);
  return [
    Math.round(a[1] + f * (b[1] - a[1])),
    Math.round(a[2] + f * (b[2] - a[2])),
    Math.round(a[3] + f * (b[3] - a[3])),
    255,
  ];
}

const frames = [0, 12, 24, 36, 42, 43, 48, 60, 72, 84];
const outDir = join(repo, "brag-output", "composition", "assets", "heat");
mkdirSync(outDir, { recursive: true });

const ffmpeg = process.env.FFMPEG || "ffmpeg";
for (const i of frames) {
  const file = `f${String(i).padStart(3, "0")}.bin`;
  const bin = readFileSync(join(repo, "data", file));
  const rgba = Buffer.alloc(cols * rows * 4);
  for (let k = 0; k < cols * rows; k++) {
    const v = bin[k];
    if (v === 255) continue; // land / nodata -> transparent
    // Calm water (Hs 0) is painted opaque cyan, exactly like the app's CALM_RGBA.
    const c = v === 0 ? [0x08, 0x91, 0xb2, 255] : colorForHs(v / 32);
    rgba[k * 4] = c[0]; rgba[k * 4 + 1] = c[1]; rgba[k * 4 + 2] = c[2]; rgba[k * 4 + 3] = c[3];
  }
  const raw = join(outDir, `_${i}.raw`);
  writeFileSync(raw, rgba);
  const png = join(outDir, `heat-${String(i).padStart(3, "0")}.png`);
  execFileSync(ffmpeg, ["-y", "-v", "error", "-f", "rawvideo", "-pix_fmt", "rgba",
    "-s", `${cols}x${rows}`, "-i", raw, "-pix_fmt", "rgba", png]);
  console.log("wrote", png);
}
