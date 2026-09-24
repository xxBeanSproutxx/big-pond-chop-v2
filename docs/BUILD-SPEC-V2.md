# BIG-POND-CHOP v2 FORK — FULL BUILD SPEC (2026-09-24)

> **ORCHESTRATOR AMENDMENTS — 2026-09-24 (these override the body where they conflict)**
>
> A1. **Frame plan RESOLVED** (Reid, 2026-09-24: "use the full 15 days, highest detail we can get"): hourly frames +0..+48 h from the run hour, then 3-hourly through the last AIFS hour (hard cap +360 h) → ~145–152 frames (f000..f1xx). Derive the count; never hardcode 88. Restated budgets: full payload ≤ 13 MB; single frame ≤ 100 KB; typical LRU session ≤ 2 MB. (Raw-hourly to 360 h = ~30 MB — parked; 2-line change if ever wanted.)
> A2. **Commit policy**: `fetched_at` refreshes every successful run → artifacts change hourly → every run commits (≤24 builds/day; quota-safe). Diff-based commit-skip stays implemented; expect it to trigger rarely.
> A3. **.bin mapping**: value = min(254, round(Hs_ft × 32)); 254 = 7.9375 ft ceiling; 255 = land/nodata. (8 ft × 32 = 256 overflows uint8.)
> A4. **Guard policy**: AIFS dead → exit 0, NO writes (last-good artifacts stay live). HRRR dead → proceed AIFS-only, labels flip honestly. IFS dead → gusts null beyond HRRR's window.
> A5. **wind.json** = {"fetched_at", "point":{"lat","lon"}, "models":{"wind_near","wind_mid","gusts"}, "hours":[{"t","speed","dir","gust"|null,"temp","precip","src"}]} (ISO-UTC; mph/°F/mm).
> A6. **frames.json** = {"generated_at", "dims":{"cols":285,"rows":292}, "scale":{"min_ft":0,"step_ft":0.03125,"nodata":255}, "frames":[{"i","t","file"}]}.
> A7. HRRR responses return ~396 timestamps with only ~56 non-null (trailing null padding) — filter to the non-null window.
> A8. Receipts file of record: `docs/V2-RECEIPTS.md`.

Status: EXECUTING from 2026-09-24 (Reid's go given in session). Phase documents: docs/BUILD-SPEC-P0.md .. P4 (one per phase).
Execution mode: ONE long-running delegated build (OpenCode session pinned below).
Spec location note: `~/.hermes/plans/*` is rejected by opencode — the executing agent's
FIRST step is copying this file into the v2 repo as `docs/BUILD-SPEC-V2.md` and working from there.

---

## GOAL

Fork big-pond-chop into a separate v2 repo (`xxBeanSproutxx/big-pond-chop-v2`) that:
1. Serves **precomputed** wave fields from a GitHub Actions worker (hourly), instead of computing on the phone.
2. Adds **delay-aware wind math** (lake memory): waves respond to wind shifts only after energy can physically travel (cg ≈ 11 mph) — the logged v2 refinement, never implementable on-device.
3. Extends the horizon to **15 days** (AIFS 360h, verified live 2026-09-24: 360 non-null hours) with **HRRR freshness** for the near term (verified live: past_hours=12 + 48h ahead, gusts/temp/precip present).
4. Adds a **weather strip** (temp, precip, gusts) from pinned best-source models — AIFS/IFS/HRRR, no blend.
5. v1 stays FROZEN and live at https://xxbeansproutxx.github.io/big-pond-chop/ — untouched, no commits, no branch flips.

**Pinned engine:** OpenCode, one session in the v2 repo. Follow the ponytail ruleset (laziest correct
implementation). Spec format: Goal / Files allowed / Done-when / Out-of-scope. Use `opencode run` from
the v2 repo dir; fall back to direct shell only on a verifiable opencode error (report it verbatim).

## AGENT AUTH / PREFLIGHT (before anything)

- `gh auth status` → verified 2026-09-24: logged in as `xxBeanSproutxx`, scopes repo+workflow. OK.
- If any gh/network step fails with auth errors → STOP and report, do not improvise credentials.

## CONTEXT — v1 FACTS (verified 2026-09-24 from disk + gbrain)

- v1 repo: `/home/reid/projects/big-pond-chop` → github.com/xxBeanSproutxx/big-pond-chop,
  `origin/main` = `2c4516b` (`stage-7.0-shipped`), one dirty file (`docs/STAGE-7.0-RECEIPTS.md`) — DO NOT touch.
- Pages: **branch-based** (main/root), NO deploy workflow exists — v2 uses the same. Worker commits → Pages republishes.
- Reusable verified code (copy INTO v2, do not rewrite):
  - `src/wave-math.js` — SPM 1984 shallow-water engine (equations verified vs source, JS↔Python parity 6.9e-6 m).
    Formulas live in [[projects/big-pond-chop-design-2026-09-11]]; verification warnings in [[projects/big-pond-chop-wave-math]]
    (Y&V transcription retired — never implement it).
  - `src/tables.js`, `src/render.js`, `src/ui.js`, `src/wind.js` — tables/render/UI/tape machinery.
  - `public/tables.v1.bin` (600K baked 16-bearing fetch tables), `mask.v1.json`, `meta.v1.json`, `spots.v1.json`, `warp.v1.json`, icons.
  - `tests/` — parity.test.js, render.test.js, ui.test.js, wind.test.js + fixtures; `tools/` — export/golden-fixture scripts; `pwa_check.py`/`stage5_check.py`/`scrub_bench.py` QA scripts (adapt paths for v2).
  - `AGENTS.md`, `opencode.jsonc` — copy the pattern (drop the CRG section; CRG is NOT wired for v2).
  - NO package.json exists; bare Node (`node --test`) — keep it that way. No new npm deps.
- v1 grid: 285×292 @100 m; keyed verdict spots via `spots.v1.json`; verdict = Hs + roller (H1/100 = 1.67·Hs, capped by 0.78·d breaking) + steepness H/L.
- v1 pain this fork deletes: client-side compute treadmill (LRU/blob/OffscreenCanvas battles), instant-onset waves, blend wind, 7-day cap.

## ARCHITECTURE (v2)

**Worker** (`.github/workflows/worker.yml` + `worker/compute.mjs`, Node 22 on ubuntu-latest):
- Schedule: `cron: '15 * * * *'` (hourly, off-peak minute), `concurrency` group cancel-in-progress, timeout 15 min. Manual `workflow_dispatch` for testing.
- Fetch (ALL keyless, User-Agent set, retry ×3 with 30s backoff):
  - HRRR: `/v1/gfs?...&models=gfs_hrrr&past_hours=12&forecast_days=2` → wind speed/dir/gusts + temp + precip (mph/°F).
  - AIFS: `/v1/forecast?...&models=ecmwf_aifs025_single&forecast_days=15` → wind + temp + precip. (Gotchas verified in the Gemini transcript: model string MUST be `ecmwf_aifs025_single`; AIFS has NO gusts; horizon starts at 00Z of run day.)
  - IFS: `/v1/forecast?...&models=ecmwf_ifs025&forecast_days=10` → gusts cross-check only.
- **Null-grid guard**: if any model returns all-null (the transcript failure mode) → reject that model, use last-good artifacts, still exit 0 (data age shows in `wind.json`).
- Merge policy: **HRRR wins 0–48h; AIFS fills 48–360h; IFS gusts ≤240h (blank beyond — honest)**. Frames: hourly 0–48h (48 frames), 3-hourly 48–360h (40 frames) → **88 frames total**.
- Compute: port of `src/wave-math.js` per cell per frame + NEW `src/delay-math.mjs` (below).
- Artifacts written to `data/` (fixed file set, OVERWRITES in place — repo size stays flat):
  - `data/f000.bin` … `f087.bin` — Uint8 Hs grids, 285×292, scale 0–8 ft @ 1/32 ft, 255 = land/nodata.
  - `data/wind.json` — merged wind series (speed/dir/gusts, mph), temp, precip, `fetched_at` ISO timestamp (client derives data age from this — NO separate status.json), model pin labels.
  - `data/frames.json` — frame index: frame→valid-time mapping + grid dims + scale.
- **Commit-skip**: hash all artifacts; if unchanged → `git commit` NOT run (protects Pages build quota: 10 builds/hour free). Else commit + push to main (branch Pages republishes automatically).

**Delay math** (`src/delay-math.mjs` — the ONE new algorithm; `CG_MPH = 11` constant at top, calibration knob):
- v1 simplification (instant onset): F_used = min(F_eff, U_A·t_eff), one growth eval — waves react instantly to wind shifts anywhere on the fetch. Physically wrong around shifts.
- v2: per cell per frame, the arriving wave state integrates the wind HISTORY along its ray with arrival delay = ray distance / cg. Single wind time series per run (lake-center point — multi-point sampling is YAGNI for a 15 km lake; revisit only if HRRR cross-lake deltas ever prove material).
- Behavior contract (fixture-gated, internals = agent's choice within it):
  - Steady wind → identical to fetch-limited equilibrium (SPM values, unchanged).
  - Step shift at t0 on a 14 mi fetch → the cell's Hs must NOT move before t0 + 14/11 h (≈ 1.3 h), then transitions to the new equilibrium. Both directions (ramp-up AND decay).
  - Reef physics UNCHANGED: Ks 0.93–0.98 (no shoaling amplification), steepness/clip/breaking outputs byte-identical to v1 golden fixtures.
- `ponytail:` marker on the chosen integration scheme naming its ceiling + upgrade path.

**Client** (fork of v1 `index.html` + `src/`, thin viewer):
- DELETE the client compute path (wind.js Open-Meteo fetch → compute → frame cache); REPLACE with: fetch `data/frames.json` + `data/wind.json` + on-demand `data/fNNN.bin` (Uint8 → canvas via existing render.js colormap; LRU cache, v1 pattern).
- Verdict header / roller / steepness: derived CLIENT-side from loaded frame + wind.json via v1 math (reuse — no new math).
- Tape: 88 ticks (hourly 0–48h, 3-hourly beyond; density per v1's tape CSS patterns). Horizon toggle becomes `48 h | 15 day`.
- NEW weather strip: 15-day row (day, hi/lo temp, precip mm, max wind) + selected-hour detail (temp, precip, gust) in the floating band. Source labels shown honestly (HRRR / AIFS / IFS).
- Self-host Leaflet next to `src/` (kills the unpkg single point of failure — carried-over v1 open item, zero cost here).
- PWA: manifest.webmanifest + sw.js at repo root (v1 pattern), **bump SW cache version on release**, name it distinctly (`Big Pond Chop v2`) to avoid home-screen collision.
- Data age display: "updated Xh ago (HRRR)" from wind.json `fetched_at`.

## PHASES — each ends with a receipt in `docs/V2-RECEIPTS.md` (append per phase)

- **P0 Scaffold + spike**: create repo via `gh repo create xxBeanSproutxx/big-pond-chop-v2 --public`; copy v1 files; worker.yml + compute.mjs run ONCE via workflow_dispatch; artifacts committed; Pages enabled (branch main/root) via gh api; **DONE-WHEN**: `https://xxbeansproutxx.github.io/big-pond-chop-v2/` serves one real frame + wind.json, and one Open-Meteo pull is pinned in receipts (URL + row counts).
- **P1 Delay math + fixtures**: `src/delay-math.mjs` + `tests/delay.test.js`. REQUIRED fixtures (node --test, no frameworks):
  1. PARITY: delay-off output == v1 wave-math output for identical wind (exact or < 1e-9 relative — same formulas).
  2. DELAY: step-shift fixture → no response before t0 + travel time, correct new equilibrium after (both ramp-up and decay).
  3. REEF: steepness/clip/breaking identical to v1 golden fixtures.
  4. NULL-GRID: all-null AIFS payload → rejected, last-good preserved, no crash.
  **DONE-WHEN**: all 4 green + receipts include the numeric delay values.
- **P2 Full horizon + viewer**: 88-frame generation, frames.json, client scrub over precomputed frames; tape 15-day; adapt `scrub_bench.py` (frame-paint bench, target: no regression vs v1's 16.7 ms median) and `pwa_check.py` → run against v2 local. **DONE-WHEN**: scrub 48h→15d smooth on desktop Chromium; data budgets met: full 88-frame payload ≤ 8 MB (raw .bin ≈ 7.3 MB worst case), single frame ≤ 100 KB; typical session (LRU) ≤ 2 MB — record actuals in receipts.
- **P3 Weather strip**: weather data in wind.json (AIFS temp/precip 15d, IFS gusts ≤240h, HRRR near-term), 15-day row + header detail; `tests/weather.test.js` (merge policy incl. gust-blank-beyond-240h). **DONE-WHEN**: strip renders with honest source labels; unit suite green.
- **P4 Ship**: live-verify Pages URL (curl artifacts, HTTP 200, correct content-type for .bin), `pwa_check.py` 11/0-adapted on v2 live, screenshots (desktop + mobile viewport) into docs/, tag `v2-stage-1-shipped`, AGENTS.md for v2, README quickstart. **DONE-WHEN**: live URL + tag + receipts; final report lists every gate with its real output.

## PROGRESS REPORTING (hard requirement)

- `PROGRESS.md` in repo root, one line per phase transition + blocker notes.
- The orchestrator polls `git log origin/main` + `PROGRESS.md` — silence > 45 min without a phase transition = flagged.
- On ANY big decision not already locked by this spec → STOP, write the question to PROGRESS.md, end the run. Do not guess.

## OUT OF SCOPE (ponytail vetting — each skipped deliberately)

- Python precompute engine (design-doc's "B" said Python): SKIPPED — v1's verified JS engine + parity fixtures already exist; a Python port = re-verification cost, zero accuracy gain. Node runs natively on Actions.
- 30-min worker cadence: SKIPPED — AIFS updates 4×/day, HRRR hourly; hourly cron + commit-skip is the free-tier sweet spot.
- Multi-point wind sampling across the lake: SKIPPED — 15 km lake vs 3 km HRRR grid; one point + delay integration captures the physics (calibration knob exists if field data ever says otherwise).
- EPS/ensemble spread UI: SKIPPED for v2.0 (AIFS+IFS cross-check covers the near-term need; ensemble plumes = later).
- Bias-correction forecast-vs-observed loop: LATER — needs accumulated on-water observations first (Phase 5 candidate).
- Custom domain, auth, accounts, notifications, v1 modifications, CRG graph for v2: all SKIPPED.
- Alternative rejected & documented: client-compute fork (just repoint v1's wind.js at HRRR/AIFS) — rejected because Reid explicitly wants the precompute architecture (documented upgrade-path triggers: reef fidelity + perf headroom) and because 15-day tape + delay integration would recompute every frame on every visit.

## RISKS + FALLBACKS

- GitHub cron runs late by minutes (documented behavior) → acceptable for weather; wind.json `fetched_at` makes age visible.
- Pages build quota (10/h free) → commit-skip on unchanged artifacts; hourly cadence ≈ ≤ 24 builds/day worst case, ~3–5 typical.
- AIFS outage/null grids → null-grid guard keeps last-good artifacts live; app shows data age.
- Repo growth → fixed artifact set, overwrite-in-place, commit-skip. Target < 15 MB tracked payload.
- Worker failure streak → client serves last-good forever (age display); recovery is automatic on next successful run.

## ROLLBACK

v2 is fully isolated: v1 URL/repo untouched; v2 rollback = `git revert` or re-point… nothing. Worst case delete the v2 repo. v1 remains the production app until Reid's wet test promotes v2.
