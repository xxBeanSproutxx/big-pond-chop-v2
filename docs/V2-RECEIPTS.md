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

### Orchestrator gate — PASS (2026-09-24T18:00Z, independently re-run)

- Scope: `ce0ea6b` = worker/compute.mjs + worker.yml + docs + PROGRESS only; working tree clean; origin/main synced.
- Unit suites re-run BY THE ORCHESTRATOR: parity/render/ui/wind all `ALL TESTS PASSED`, exit 0 ×4.
- Local `data/`: 147 files present, every file = 83,220 B, total 12,233,340 B; `f000.bin` decodes to a real field (30,482 land=255; 1,898 calm=0; 84 distinct values).
- CI provenance: data commit `257dc18` authored `bpc-worker <bpc-worker@users.noreply.github.com>` (artifacts came from the Actions run, not a local run).
- Live curls re-run by orchestrator: frames.json 200/8,700 B · f000.bin 200/83,220 B (octet-stream) · wind.json 200/360 h · index.html 200.
- Gate note for P2 client spec: `frames.json.frame[].file` = bare basename (`f000.bin`) → fetch as `data/<file>`.

## P1 — delay math + fixtures

- **Algorithm**: `src/delay-math.mjs` (ESM, zero deps). τ_cell = F_eff / cg with `CG_MPH = 11` at top (calibration knob). Per cell per frame the merged hourly series is sampled **zero-order hold** at `t − τ_cell` (last entry with time ≤ query, carrying {speed, dir, tEffH} together); cells are bucketed by sampled-series index and each bucket runs the **unchanged** v1 `waveMath.computeField` (SPM/Ks/breaking untouched); per cell the value is selected from its bucket. τ uses the **blended-bearing effective fetch in metres** along the frame's wind direction via the same v1 `waveMath.blendFetch` the field pass uses (documented single-pass arriving-direction proxy).
- **Fixtures** (`tests/delay.test.js`, `node --test` style):
  1. **PARITY** — delay OFF `computeDelayedField({delay:false})` bit-identical to `render.computeFrame` for the 3 synthetic entries (12 mph/315°/4 h; 25/90/1; 7/200/6): `.capped`, `.afterKs`, `.ts` bytes equal + quantized `.bin` bytes equal.
  2. **DELAY** — synthetic 48 h hourly series, step at t0=+24 h, both decay (25→5) and ramp-up (5→25), tEff via `computeTeff`. **τ_14mi = 1.272727 h** (F = 22,530.816 m); frames t0−1/t0/t0+1 h sample EXACTLY the old equilibrium; first moved = **t0+2 h**; holds new equilibrium through t0+8 h. **5.5 mi cell (τ = 0.5 h)** first moved = **t0+1 h** while the 14 mi cell is still old — spatial delay, not a global time-shift. Equilibria via `waveCore` (strict-equal: same speed/tEff).
  3. **REEF** — steady 25 mph/315°/tEff 8 h series, full grid at frames 0/6/12/24/36/47: delay ON vs OFF `.capped`/`.afterKs` bit-identical, `.bin` byte-identical, and OFF == `computeFrame`; buckets per frame 1–3.
  4. **NULL-GRID** — all-null AIFS payload → `guard.rows` gives 0 rows → `decideModels` returns `{write:false, reason:'aifs-all-null'}` → `writeArtifacts` writes nothing (temp dir empty). Positive control proves the gate is load-bearing (a live decision writes `frames.json`).
- **Mutation proof (test is not vacuous)**: with `CG_MPH` temporarily set to `1e12` (delay effectively off), fixture 2 fails on the first sampled frame:
  `FAIL decay: 14 mi holds old through t0+1 h, new equilibrium from t0+2 h: k=0 sampled speed`
  (plus all 5 delay-fixture checks fail). Restored to 11; suite green again.
- **Perf** (local, run hour 18:00Z): compute step **146 frames in 1.03 s = 7.0 ms/frame (delay ON)**; delay OFF 0.40 s = 2.8 ms/frame. Full run wall **2.22 s**. Budgets: soft ≤60 s, hard ≤300 s — PASS.
- **Dry run**: `node worker/compute.mjs` → 146 frames, 12,150,120 B (plan derived: hourly +0..+48 h then 3-hourly to +341 h; f0=2026-09-24T18:00Z), same artifact shapes (A3/A5/A6), 360 wind hours. `BPC_DELAY=0` path runs and is P0-equivalent. `data/` removed and restored after local runs (CI owns artifacts).
- **Unit suite**: `node --test` → **5/5 pass, exit 0** (parity, render, ui, wind, delay).

### Deviations

1. **Golden Ks range**: the P1 spec says "assert `golden.json` Ks values all in [0.93, 0.98]". Reality: `deep_mud_basin` Ks = **1.0012** (a deep basin where local cg ≥ path cg, no shoaling reduction), outside that band. Fixture 3 asserts the two shoaling cells (`garrison_reef` 0.9586, `cove_bay_se_reach` 0.9694) in [0.93, 0.98] and *all* golden Ks within the v1 clamp [0.7, 1.6]. The "all in [0.93,0.98]" wording is unattainable with the frozen golden fixture.
2. **Frame count 146 vs 147** (A1 says derive, never hardcode): 146 at run hour 18:00Z vs P0's 147 at 17:00Z — the 3-hourly tail ends on the last AIFS hour, which shifts with the run hour. Same plan rule; shape identical.
3. **`node --test tests/`** directory positional still rejected by Node 22.23.1 (P0 deviation carries) — green via `node --test`.

### Dispatch — BLOCKED (pre-existing P0 workflow bug)

- Code pushed: `2d6c7cc` (`P1: delay-aware wind math + 4 fixtures`), `origin/main` up to date.
- Dispatch: `gh workflow run worker.yml --ref main` → run **36038396851** https://github.com/xxBeanSproutxx/big-pond-chop-v2/actions/runs/36038396851 — **conclusion=failure** (exit 128).
- The **Compute step succeeded**: `[plan] ... frames=146 delay=on cg=11 mph`, `[compute] 146 frames in 1.22s (8.3 ms/frame)`, `[write] frames=146 ... -> data/`. So delay-ON worker execution is proven on CI.
- The **Commit data step failed**:
  `error: cannot pull with rebase: You have unstaged changes.` / `error: Please commit or stash them.`
- **Root cause**: `worker.yml` runs `git pull --rebase origin main` BEFORE `git add data/`. Since data/ became a *tracked* tree after P0's first data commit, the freshly computed files are unstaged modifications and Git refuses the rebase. P0's first dispatch (`36037293434`) only succeeded because data/ was not yet tracked at base `ce0ea6b`. Every run since (and every hourly cron) will fail identically. Not caused by the delay code.
- **Live refresh NOT performed**; `data/frames.json generated_at` unchanged (still P0's `257dc18`).
- **Proposed minimal fix (needs approval — `worker.yml` is outside the P1 allowed-file list)**:
  ```sh
  git config user.name "bpc-worker" && git config user.email "bpc-worker@users.noreply.github.com"
  git add data/
  if ! git diff --cached --quiet; then
    git commit -m "data: refresh $(date -u +%Y-%m-%dT%H:%MZ)"
    git pull --rebase origin main
    git push
  fi
  ```
  (commit first, then rebase/push; commit-skip preserved). Alternative: `git stash`/`git stash pop` around the existing order.
- Per the P1 contract ("Only stop-and-report for ... an impossible requirement, or a decision the spec doesn't cover") and repo AGENTS.md ("If the spec and the code disagree, STOP and report"), the run is stopped here rather than editing the frozen workflow.

