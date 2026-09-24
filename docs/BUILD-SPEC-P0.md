# BUILD-SPEC P0 — scaffold + worker spike (big-pond-chop-v2)

You are the P0 worker for big-pond-chop v2. Read `docs/BUILD-SPEC-V2.md` (project reference; its
ORCHESTRATOR AMENDMENTS section wins over the body). Work ONLY inside this repo. Do not attempt to
read anything outside this repository (permission wall auto-rejects and wastes budget) — everything
you need is here or on the public internet. You MUST edit/create the files listed below; a run that
only reads files and exits is a failure, not a deliverable — the orchestrator checks for real diffs.

## GOAL
Ship the working hourly precompute worker: `worker/compute.mjs` + `.github/workflows/worker.yml`.
Prove it with a local dry run, push, dispatch it on GitHub, and get real artifacts + GitHub Pages live
at https://xxbeansproutxx.github.io/big-pond-chop-v2/.

## FILES ALLOWED TO TOUCH (nothing else)
- `worker/compute.mjs` (new)
- `.github/workflows/worker.yml` (new)
- `data/**` (generated — do NOT commit from local; CI commits it; rm -rf locally after dry run)
- `docs/V2-RECEIPTS.md` (new/append — P0 section)
- `PROGRESS.md` (append)
- Scratch: `tmp/` only (gitignored).

No new dependencies. No package.json (none exists — bare Node 22; new worker code = ESM .mjs; v1 `src/`
is CJS, load via `createRequire`). Do NOT modify `src/**`, `tests/**`, `public/**`, `index.html`, or any
other copied v1 file.

## CONTEXT (verified 2026-09-24 by the orchestrator)
- Canonical Node call pattern lives in `tests/parity.test.js` and `tools/bench_frames.js`:
  `decodeTables(fs.readFileSync('public/tables.v1.bin'))` once, then
  `render.computeFrame(tables, {speedMph, dirTrueDeg, tEffH}, {gamma})` → `.capped` = Float64Array(83220)
  of capped Hs in FEET. Land cells: `tables.depth[i] === 65535`.
- `gamma` = `public/meta.v1.json` → `gamma_deg` (-0.474). Read it; don't hardcode.
- Grid: 285 cols × 292 rows = 83,220 cells.
- Open-Meteo fetches (ALL keyless; set a User-Agent; retry ×3 with 30 s backoff; `timezone=UTC`):
  1. HRRR — `https://api.open-meteo.com/v1/gfs?latitude=46.22&longitude=-93.657&hourly=wind_speed_10m,wind_direction_10m,wind_gusts_10m,temperature_2m,precipitation&models=gfs_hrrr&past_hours=12&forecast_days=2&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC`
     Probed today: 396 timestamps returned, ONLY indices 0..55 non-null (12 past + 44 ahead). FILTER TO
     THE NON-NULL WINDOW — never assume a fixed count.
  2. AIFS — `https://api.open-meteo.com/v1/forecast?latitude=46.22&longitude=-93.657&hourly=wind_speed_10m,wind_direction_10m,temperature_2m,precipitation&models=ecmwf_aifs025_single&forecast_days=15&wind_speed_unit=mph&temperature_unit=fahrenheit&timezone=UTC`
     360 hourly timestamps, all non-null. NO gusts in this model.
  3. IFS — `https://api.open-meteo.com/v1/forecast?latitude=46.22&longitude=-93.657&hourly=wind_gusts_10m&models=ecmwf_ifs025&forecast_days=10&wind_speed_unit=mph&timezone=UTC`
     240 hourly timestamps, all non-null. Gusts only.

## REQUIREMENTS
1. **compute.mjs** (ESM): fetch ×3 → null-grid guard → merge → frame plan → compute → write artifacts.
   - Merge: one hourly series from HRRR start through AIFS end. HRRR value wins where non-null
     (≈ first 44–56 h), AIFS fills after. Per-hour `src`: "hrrr" | "aifs". Gusts: HRRR where present,
     else IFS (≤ +240 h from 00Z), else `null`. Temp/precip: HRRR near, AIFS beyond.
   - `t_eff`: reuse `src/wind.js` `computeTeff` semantics on the full merged hourly series (dtH=1),
     then sample at frame times. (`computeTeff` is exported; file is CJS.)
   - Frame plan (amendment A1): hourly frames hourly +0..+48 h from the run hour, then 3-hourly through
     the last AIFS hour (hard cap +360 h from f0). ~145–152 frames — derive, never hardcode.
   - `.bin`: Uint8, cols=285, rows=292, row-major (col fastest), `min(254, round(Hs_ft × 32))`;
     land/nodata = 255 (amendment A3).
   - `data/wind.json` schema — amendment A5.
   - `data/frames.json` schema — amendment A6.
   - Guard (amendment A4): AIFS all-null/failed → NO artifact writes, log, exit 0 (last-good stays).
     HRRR dead → proceed AIFS-only, labels flip honestly. IFS dead → gusts null beyond HRRR window.
   - Write all artifacts only after a fully successful run (no partial writes).
2. **worker.yml**: `on: schedule: cron '15 * * * *'` + `workflow_dispatch`; `concurrency: {group: bpc-worker, cancel-in-progress: true}`; `permissions: {contents: write}`; `timeout-minutes: 15`;
   ubuntu-latest; `actions/checkout@v4`; `actions/setup-node@v4` (node 22); `node worker/compute.mjs`;
   then commit data only if changed:
   ```
   git config user.name "bpc-worker" && git config user.email "bpc-worker@users.noreply.github.com"
   git pull --rebase origin main
   git add data/
   if ! git diff --cached --quiet; then git commit -m "data: refresh $(date -u +%Y-%m-%dT%H:%MZ)"; git push; fi
   ```
3. **Local dry run**: `node worker/compute.mjs` from repo root; verify outputs + sizes (≈83 KB/frame).
   Then `rm -rf data/` — artifacts must come from the CI run, not your local run.
4. **Commit + push code**: `git add worker/ .github/ docs/BUILD-SPEC-P0.md docs/V2-RECEIPTS.md PROGRESS.md`
   → commit "P0: precompute worker + workflow" → `git push -u origin main` (if upstream not yet set) /
   `git push`. Push directly to main; no branches, no PRs.
5. **Dispatch**: `gh workflow run worker.yml --ref main`; find the run id (`gh run list --workflow=worker.yml --limit 1`),
   watch to completion (`gh run watch <id> --exit-status` or poll `gh run view <id>`), require conclusion=success.
6. **Verify run products**: `git pull` → `data/` present; frame-file count matches `frames.json` frames array;
   per-file size ≤ 100 KB; `wind.json` hours count ≈ 343+.
7. **Pages**: orchestrator may have already enabled it — check
   `gh api repos/xxBeanSproutxx/big-pond-chop-v2/pages` (html_url + status). If NOT enabled, enable with
   `gh api -X POST repos/xxBeanSproutxx/big-pond-chop-v2/pages -f 'source[branch]=main' -f 'source[path]=/'`
   then wait for a build. Do not fight the API beyond one retry — report instead.
8. **Live check** (may need ~1–2 min after the data commit for Pages to republish):
   `curl -sI https://xxbeansproutxx.github.io/big-pond-chop-v2/data/frames.json` → 200
   `curl -sI .../data/f000.bin` → 200; `curl -s .../data/wind.json` → parse + count hours.

## PROGRESS.md + RECEIPTS
- PROGRESS.md: append `- <ISO-Z> [P0] ...` lines for: worker implemented, dry-run ok (N frames),
  pushed <sha>, workflow run <id> <conclusion>, Pages <status>, live check ok.
- docs/V2-RECEIPTS.md: append `## P0 — scaffold + worker spike` with: dispatch run URL, frame count +
  total bytes, **one Open-Meteo pull pinned with URL + row counts** (e.g. AIFS 360/360 non-null),
  Pages URL + curl evidence, deviations from spec (or "none").

## DONE-WHEN — print these EXACT evidence lines at the end
```
WORKFLOW: <run url> conclusion=<success|failure>
ARTIFACTS: frames=<N> bytes=<total> first=<ISO> last=<ISO>
LIVE: frames.json=<http status,bytes> f000.bin=<http status,bytes>
UNIT: node --test tests/ exit=<0|nonzero>
DEVIATIONS: <none|list>
```
Also run `node --test tests/` (copied v1 suites must stay green) and report the exit code.

## OUT OF SCOPE
- Delay math, client rewrite, weather strip UI, README/AGENTS rewrites = later phases (P1–P4).
- No package.json, no npm installs, no CRG, no tags, no v1-repo edits (at /home/reid/projects/big-pond-chop).
- If a spec number conflicts with observed reality, trust reality and note it in the receipts.
  Only stop-and-report for: gh auth failure, Pages impossible, or a decision the spec doesn't cover.
