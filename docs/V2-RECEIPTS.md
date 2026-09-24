# V2 RECEIPTS — big-pond-chop-v2

Append per phase. Live/verified numbers only; deviations called out explicitly.

## P0 — scaffold + worker spike

- **Worker**: `worker/compute.mjs` (ESM, zero deps) + `.github/workflows/worker.yml` (cron `15 * * * *` + manual dispatch).
- **Local dry run** (`node worker/compute.mjs`, 2026-09-24T17:51Z): frames=**147**, total bytes=**12,233,340** (11.7 MiB), per-file=**83,220 B** (≤100 KB gate ok). Plan derived: hourly +0..+48 h then 3-hourly to +342 h (cap +360 h); first=`2026-09-24T17:00:00Z`, last=`2026-10-08T23:00:00Z`. `wind.json` hours=**360**.
- **Pinned Open-Meteo pull** (AIFS, verified 2026-09-24):
  - URL: `https://api.open-meteo.com/v1/forecast?latitude=46.22&longitude=-93.657&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation&models=ecmwf_aifs025_single&forecast_days=15`
  - rows: **360/360 non-null**, `2026-09-24T00:00` .. `2026-10-08T23:00`.
  - HRRR: **56/396 non-null** (null-padded — filtered to window, A7). IFS: **240/240 non-null** gusts.
- **Engine**: `src/render.js` `computeFrame(tables, {speedMph,dirTrueDeg,tEffH},{gamma})→.capped` (feet); `gamma` read from `public/meta.v1.json` (-0.474, not hardcoded); `.bin` = Uint8 min(254, round(Hs×32)), land/nodata 255.
- **Guard**: AIFS all-null/failed → no writes, exit 0; HRRR dead → AIFS-only labels; IFS dead → gusts null past HRRR window. All artifacts computed in memory, written only after success.
- **Unit suite**: `node --test` → **4/4 pass, exit 0** (parity, render, ui, wind).
  - DEVIATION: `node --test tests/` (directory positional) is rejected by Node 22.23.1 (`MODULE_NOT_FOUND`) — the runner only auto-discovers without an arg. Equivalent green command used: `node --test` (and `node --test tests/*.test.js`), both 4/4.
- Dispatch run URL: _pending_
- Pages: _pending_
- Live curl evidence: _pending_

<!-- P0-DISPATCH -->
