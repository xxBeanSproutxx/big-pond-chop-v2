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
- Dispatch run URL: https://github.com/xxBeanSproutxx/big-pond-chop-v2/actions/runs/36037293434 — **conclusion=success** (9 s), commit `257dc18` (data) on base `ce0ea6b`.
- CI artifacts (pulled): frames=**147**, bin files=**147** (matches frames.json, 0 missing), total=**12,233,340 B**, max file=**83,220 B**, wind hours=**360**.
- Pages: branch main/root, `html_url=https://xxbeansproutxx.github.io/big-pond-chop-v2/`, build id 1237056089 → **status=built**.
- Live curl (2026-09-24T~17:55Z):
  - `HEAD /data/frames.json` → **200**, content-type `application/json; charset=utf-8`, content-length **8700**.
  - `HEAD /data/f000.bin` → **200**, content-type `application/octet-stream`, content-length **83220**.
  - `GET /data/wind.json` → parsed, hours=**360**, `models={"wind_near":"hrrr","wind_mid":"aifs","gusts":"hrrr+ifs"}`.

### Deviations
1. `node --test tests/` (directory positional) is not supported by Node 22.23.1 — the runner tries to load `tests` as a module (`MODULE_NOT_FOUND`). Suite is green via the equivalent `node --test` (auto-discovery) and `node --test tests/*.test.js`: **4/4 pass, exit 0**.
2. Merged series starts at the AIFS 00Z (00:00Z) rather than HRRR's +12 h-past window (~05Z on an afternoon run), because AIFS begins earlier — union covers both. `wind.json` hours=**360** (≥343 gate satisfied), not the ~357 a pure HRRR-start union would give.

