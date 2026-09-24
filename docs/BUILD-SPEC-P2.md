# BUILD-SPEC P2 — full horizon + thin viewer (big-pond-chop-v2)

You are the P2 worker for big-pond-chop v2. Read `docs/BUILD-SPEC-V2.md` (amendments A1–A8 win) and
`docs/V2-RECEIPTS.md` (P0/P1 done + orchestrator-gated). Work ONLY inside this repo; reading outside it
is auto-rejected and wastes budget. You MUST edit/create the files below — a run that only reads files
and exits is a failure. Trust reality over any stale number in this spec; note conflicts in the receipts.

## GOAL
Replace the client compute path with a thin viewer over the precomputed frames: fetch `data/frames.json`
+ `data/wind.json` + on-demand `data/<file>.bin`, render via the existing v1 raster/colormap pipeline,
ship the 15-day tape, and adapt + run the two local QA harnesses. The worker is NOT modified (146-frame
artifacts are already live).

## WHAT'S LIVE NOW (verified)
- `data/frames.json` = `{generated_at, dims{cols:285,rows:292}, scale{min_ft:0, step_ft:0.03125, nodata:255}, frames:[{i,t,file}]}` — **`file` is a BARE basename** (`f000.bin`) → fetch as `data/<file>`; `t` is ISO-UTC.
- `data/f000.bin…` Uint8 285×292 (row-major, col fastest): value = min(254, round(Hs_ft×32)); **255 = land/nodata**. Current run: 146 frames (hourly +0..+48 h, then 3-hourly).
- `data/wind.json` = `{fetched_at, point, models{wind_near,wind_mid,gusts}, hours:[{t,speed,dir,gust,temp,precip,src}]}` — 360 h; `gust` is null beyond ~+240 h.
- v1 client: `index.html` boots a mini-CJS shim (`load('src/x.js')`) into `render.mount({tables,wave,wind,ui,render})`; `render.js` owns fetch→compute→LRU→canvas→tape→verdict; `wind.js` fetches Open-Meteo. `render.js` already exports the whole raster pipeline (`gatherRaster`, `landMaskRaster`, `smoothRaster`, `paintRaster`, `createFrameCache`, `cacheKey`, `pxPerDay`, `tapeTranslate`, `idxFromDrag`, `dayPartitions`, `tickWinds`, `mount`, …).
- QA: `/home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/pwa_check.py` and `…/scrub_bench.py` (playwright). scrub_bench drives `#timeline`, `#track`, `#track-tape`, `#time-pill`, `#h-7d`, `#h-24h`, `.leaflet-image-layer`; pwa_check drives `#map`, `#note`, `#note-msg`, `#track-days`. v1's shipped scrub bar: frame-paint **median 16.7 ms**.

## REQUIREMENTS
1. **Data layer (replaces compute):** on load, fetch `data/frames.json` + `data/wind.json` (cache-bust both, e.g. `?cb=<Date.now()>`); frames on demand via `data/<file>` (plain fetch; LRU like v1's `createFrameCache`, keyed per v1's `cacheKey` pattern per (frame, W, H)). Dequantize: `255` → land/0 (land comes from the existing `landMaskRaster` path); else `v/32` ft. Keep the rest of the render pipeline (gather → smooth → colorize → paint) so visuals match v1.
2. **Delete the client compute path:** strip wind.js's Open-Meteo fetchers (keep `computeTeff`/`gammaToGrid`/series builders and everything `tests/wind.test.js` imports); render.js's lazy compute-per-index source is replaced by the loader above. Keep all `node --test` suites green (5/5).
3. **Tape + horizon:** toggle becomes **`48 h | 15 day`** — same two-button + `aria-pressed` pattern, NEW ids `h-48h` / `h-15d`, `data-horizon="48h"|"15d"`, persistence + `?h=` URL param kept (v1 `HORIZON_KEY` pattern). 48h view = the 49 hourly frames; 15d = the full set. Density per v1 tape patterns (~330 px/day class, tiers by range); ticks at frame times; scrub maps continuously to frame index (no sub-frame snapping); `#play` steps frames at a sane interval.
4. **Verdict header + spot card:** derive client-side via v1 math (no new math). Recommended: peak cell = argmax of the loaded grid → Hs = val/32; roller = min(1.67·Hs, 0.78·d), d = depth from tables (×0.25 ft, skip LAND_U16); steepness H/L via a one-cell recompute at the frame's wind sampled at `frame_time − τ_cell` with `τ = F_cell/cg`, `cg = 11 mph` (same constant as `src/delay-math.mjs`; the browser can't import that .mjs — a tiny local helper with a comment pointing at it is fine). Frozen ids kept: `#verdict #verdict-peak #verdict-range #comfort-chip #readout #card #card-close`. Wind badges `#pill-lake #mph #pill-gust #gust` fed from wind.json hours, existing tint tiers.
5. **Data age display:** from `fetched_at` + `models.wind_near` → e.g. `updated 2h ago (HRRR)`, visible on load, fits at 360 px width; place within existing chrome (your call).
6. **Self-host Leaflet 1.9.4:** vendor `leaflet.js` + `leaflet.css` (+ its `images/`) into `public/vendor/leaflet/`; index.html references local paths; no `unpkg` left anywhere in the client.
7. **PWA:** `manifest.webmanifest` name/short_name = `Big Pond Chop v2` (distinct install identity); `sw.js` bump `CACHE_NAME` (v2), precache shell incl. vendored Leaflet; add a `data/*` strategy: **network-first, cache fallback for offline**, cache key WITHOUT query string ("live data on open, no stale cache" when online).
8. **Adapt + run QA locally:** `tools/qa/scrub_bench.py` + `tools/qa/pwa_check.py` → serve under `/big-pond-chop-v2` subpath, update the toggle ids they drive, keep their check semantics. Run BOTH against the v2 client with the hermes venv python; paste real outputs.
9. **Record budgets** (fresh-context Playwright network bytes under `data/`): full payload ≤ **13 MB** (current 12.15), single frame ≤ **100 KB** (83.2 ✓), typical session (load + 15d toggle + one scrub pass + one spot tap) ≤ **2 MB** — record actuals.

## FILES ALLOWED TO TOUCH (nothing else)
`index.html` · `src/render.js` · `src/wind.js` · `src/ui.js` (only if unavoidable — say why) · `sw.js` ·
`manifest.webmanifest` · `public/vendor/**` (new) · `tools/qa/scrub_bench.py` · `tools/qa/pwa_check.py` ·
`docs/V2-RECEIPTS.md` · `PROGRESS.md` · `tmp/`.
FORBIDDEN: `worker/**`, `data/**`, `src/wave-math.js`, `src/tables.js`, `tests/**`. If a suite breaks for
a legitimate client change, make the minimal fix ONLY for genuinely dead behavior and quote it in the
receipts. If a driven id must change (beyond the toggle rename), update the QA file in the same commit
and say so.

## DONE-WHEN — print these EXACT evidence lines at the end
```
VIEWER: frames=<n> scrub48_p50=<ms> scrub48_p90=<ms> scrub15d_p50=<ms> scrub15d_p90=<ms> (v1 bar 16.7 median)
BUDGETS: full=<MB> frame=<KB> session=<KB>
QA: scrub_bench=<PASS n/n|failures> pwa_check_local=<N ok / M FAIL>
UNITS: node --test: tests=<n> pass=<n> fail=<n>
NOPKG: unpkg refs in client = <0|list>
COMMIT: <sha> pushed
DEVIATIONS: <none|list>
```
Target: scrub_bench median ≤ 16.7 ms on BOTH horizons (record actuals either way); 0 FAIL where v1 checks
still apply. Commit + push with `git pull --rebase` first (the hourly worker commits data — that's fine).

## OUT OF SCOPE
Worker changes (P3 builds on it for the weather strip), weather strip UI (P3), README/AGENTS/screenshots/
tags/live pwa_check (P4), v1 repo, CRG.
