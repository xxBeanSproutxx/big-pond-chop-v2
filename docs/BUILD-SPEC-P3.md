# BUILD-SPEC P3 — weather strip + merge-policy test (big-pond-chop-v2)

You are the P3 worker for big-pond-chop v2. Read `docs/BUILD-SPEC-V2.md` (amendments A1–A8 win) and
`docs/V2-RECEIPTS.md` (P0–P2 done + orchestrator-gated; the viewer is LIVE). Work ONLY inside this
repo; reading outside it is auto-rejected. You MUST edit/create files — a read-only run is a failure.

## GOAL
Ship the 15-day weather strip (client) and lock the weather merge policy in a unit test (worker seam).

## WHAT'S ALREADY TRUE (verified)
- `data/wind.json.hours[]` = `{t (ISO-UTC), speed (mph), dir (deg), gust (mph|null), temp (°F), precip (mm), src ("hrrr"|"aifs"|"null past +240h")}`.
- Merge policy lives inline in `worker/compute.mjs` (~lines 82–90): AIFS base → HRRR overrides where
  `t` matches → IFS fills gust gaps where `gustMph == null`. `models` = `{wind_near, wind_mid, gusts}`
  with honest flips when a source dies. Gusts are `null` beyond ~+240 h (IFS horizon).
- Units on the wire: mph / °F / **mm**. The app is US-facing: **display precip in inches** (×1/25.4,
  2 dp; convert in the client, keep the wire format unchanged — note it in receipts).

## REQUIREMENTS
1. **Worker seam (behavior-preserving):** extract the merge block into `worker/merge.mjs` as a pure
   function (no network, no fs): `mergeWeather({ near, mid, ifs, ifsOk })` → array sorted ascending by
   time, same row shape/field names as today (`{t, speedMph, dirTrueDeg, gustMph, tempF, precipMm,
   src}` or whatever the current block produces — byte-identical semantics). `worker/compute.mjs`
   imports it; delete the inline copy. No other worker behavior changes.
   - **A/B proof (required):** run `node worker/compute.mjs` locally BEFORE the edit and AFTER, ~2 min
     apart, with the delay math ON (default), and diff the two `data/wind.json` files (ignore
     `fetched_at`): must be identical. Also confirm `[guard]` passes, frame count = 146, and restore
     the tracked data afterwards (`git checkout -- data/`).
2. **`tests/weather.test.mjs`** (new; existing tests must not be edited — `node --test` discovers
   `.test.mjs`): lock the merge policy with synthetic fixtures (no network):
   - HRRR row + AIFS row on same `t` → HRRR wins (src `hrrr`, its temp/precip/gust).
   - AIFS-only hour → src `aifs`, gust null (no IFS) / filled from IFS when `ifsOk`.
   - IFS fills ONLY `gustMph == null` rows and ONLY where IFS has a value; rows beyond IFS coverage
     stay `null` (the `+240 h` boundary).
   - `ifsOk=false` → zero IFS fills; `near=[]` (HRRR dead) → all rows src `aifs`.
   - Output sorted ascending.
   Keep it one small file, assert-based, no frameworks.
3. **Strip UI (client):** a floating weather band, horizontally scrollable if needed, that shows:
   - **15 day-cells**: abbreviated day + date (e.g. `THU 24`), hi/lo °F, precip inches, max wind mph
     (computed from that day's hours).
   - **Selected-hour detail**: temp / precip / gust for the currently scrubbed hour, updating as the
     tape moves and on horizon toggle.
   - **Honest source labels**: the hour's `src` (hrrr/aifs) and the gust provenance from
     `models.gusts` when `gust != null` (e.g. `gusts hrrr+ifs`); `—` when null. Do not claim a source
     the data doesn't have.
   - Constraints: fits 390 px width (mobile-first, no horizontal page scroll); must NOT overlap or
     push the frozen elements the QA harnesses drive (`#map #note #note-msg #track-days #timeline
     #track #track-tape #time-pill`); `#data-age` may be repositioned if needed. Verify at 360 px.
4. **Re-run the P2 gates you could have broken** (index.html / render.js change): all `node --test`
   suites (now 6 with the new one), `tools/qa/scrub_bench.py` and `tools/qa/pwa_check.py` (local,
   hermes venv python, same subpath adaptations) — both stay green.
5. Save a 390×844 screenshot of the strip to `/tmp/p3_strip.png`.

## FILES ALLOWED TO TOUCH
`worker/merge.mjs` (new) · `worker/compute.mjs` (import swap only) · `tests/weather.test.mjs` (new) ·
`index.html` · `src/render.js` · `src/ui.js` (only if unavoidable — say why) · `docs/V2-RECEIPTS.md` ·
`PROGRESS.md` · `tmp/`.
FORBIDDEN: `data/**` (except the A/B smoke — restore it), `src/wave-math.js`, `src/tables.js`,
`worker/guard.mjs`, existing test files, `sw.js`/manifest (no new files to precache), v1 repo.

## DONE-WHEN — print these EXACT evidence lines at the end
```
WEATHER: merge extracted=yes test=<N asserts pass> gust-null-beyond-ifs=locked
AB: wind.json pre/post diff=<identical|DIFF n lines> guard=<ok>
STRIP: cells=15 detail-sample="<text>" labels="<text>"
UNITS: wire=mph/°F/mm display=mph/°F/in (converted client-side)
UNITS-TESTS: node --test: tests=6 pass=6 fail=0
QA: scrub_bench=<result> pwa_check_local=<result>
SCREENSHOT: /tmp/p3_strip.png
COMMIT: <sha> pushed
DEVIATIONS: <none|list>
```
Commit + push (`git pull --rebase` first; the hourly worker commits data — fine).

## OUT OF SCOPE
Any other UI, sw/manifest changes, README (P4), live-site checks (P4), delay math, frame plan.
