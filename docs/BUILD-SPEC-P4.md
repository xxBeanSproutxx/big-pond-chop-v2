# BUILD-SPEC P4 — docs + close-out (big-pond-chop-v2)

You are the P4 worker for big-pond-chop v2. Read `docs/BUILD-SPEC-V2.md` + `docs/V2-RECEIPTS.md`
(P0–P3 done + orchestrator-gated). Work ONLY inside this repo; reading outside it is auto-rejected.
You MUST edit/create files — a read-only run is a failure.

## GOAL
Finalize for hand-off: README quickstart, docs screenshots from the LIVE site, a fresh-clone smoke, a
LIVE pwa_check against GitHub Pages, and tag + release v2.0.0.

## WHAT'S TRUE NOW (verified)
- Live: `https://xxbeansproutxx.github.io/big-pond-chop-v2/` — 146-frame precomputed viewer, 48h|15d
  tape, weather strip, vendored Leaflet, sw `bpc-cache-v2`, manifest `Big Pond Chop v2`.
- Hourly worker (GitHub Actions cron) refreshes `data/`; QA harnesses at `tools/qa/*.py` run with
  `/home/reid/.hermes/hermes-agent/venv/bin/python` (playwright).

## REQUIREMENTS
1. **Fresh-clone smoke:** `git clone` the repo to `/tmp/bpc2-clone`, serve it (`python3 -m http.server`),
   load with playwright at 390×844: map + `#weather-strip` present, one frame fetched, no console
   errors, tap → spot card. Record result. (`data/` comes with the clone — it's committed.)
2. **LIVE pwa_check:** point `tools/qa/pwa_check.py` at the live URL (add a `--live`/base-url flag only
   if it doesn't have one — minimal edit, say why; keep the local default). Run against
   `https://xxbeansproutxx.github.io/big-pond-chop-v2/`: manifest served + parsed, SW registered +
   controlling, CDP installability clean, precache complete, offline shell renders, live data fetch
   (frames.json + wind.json 200, fresh `generated_at`), frozen-element checks. Skip inherently
   local-only checks with a note (`src-clean` etc.). Aim 0 FAIL.
3. **README.md rewrite (tight, scannable):** first screen = title + one-line description + LIVE LINK +
   a screenshot; then: how it works (worker → `data/` → Pages; delay-aware math in one line), local
   dev quickstart (serve, `node --test`, QA scripts + venv python path), data artifact shapes
   (frames.json / `fNNN.bin` / wind.json — 4–6 lines), pointer to `docs/V2-RECEIPTS.md` + `PROGRESS.md`.
   No walls of text; bullets.
4. **Screenshots → `docs/shots/`** (playwright against the LIVE site, mobile 390×844):
   `live-default.png`, `live-15day.png`, `live-strip.png` (or similar). Embed in README with relative
   paths. Keep total sane (< ~600 KB).
5. **Tag + release:** commit docs first, then annotated tag `v2.0.0` on the final commit, push it, and
   `gh release create v2.0.0 --title "Big Pond Chop v2.0.0" --notes "..."` — notes: live link, one
   paragraph on what's new vs v1 (15-day precomputed forecast via hourly GitHub Actions worker;
   HRRR+AIFS+IFS weather merge; lake-memory delay math; thin viewer + 15-day tape; weather strip).
6. **Cron check (report only, no debug):** `gh run list --workflow worker.yml` — is there a run with
   event `schedule` yet? Report `seen: success <id>` or `not-yet`. Do not chase GitHub scheduling.
7. Append a `### P4 — docs + close-out` section to `docs/V2-RECEIPTS.md` (what you did + the evidence
   lines below) and a line to `PROGRESS.md`.

## FILES ALLOWED TO TOUCH
`README.md` · `docs/shots/**` (new) · `docs/V2-RECEIPTS.md` · `PROGRESS.md` · `tools/qa/pwa_check.py`
(only for a live-mode flag — say why) · `tmp/`.
FORBIDDEN: everything else, incl. `src/`, `worker/`, `tests/`, `index.html`, `sw.js`, manifest,
`data/**`, `AGENTS.md` (unless a one-line quickstart pointer is genuinely needed — then say so).

## DONE-WHEN — print these EXACT evidence lines at the end
```
CLONE: fresh-clone smoke=<ok|fail> strip=<yes|no> errors=<n>
LIVE: pwa_check live=<N ok / M FAIL> installability=<clean|issues> sw=<ok|fail> offline=<ok|fail> data-fetch=<ok|fail>
README: rewritten=yes quickstart-verified=<yes|no>
SHOTS: docs/shots=<n files, total KB>
RELEASE: tag=v2.0.0 url=<release url>
CRON: scheduled-run=<seen: success <id>|not-yet>
COMMIT: <sha> pushed
DEVIATIONS: <none|list>
```
Push everything (tag included). Do NOT touch the live site's code; do NOT re-run the worker.

## OUT OF SCOPE
Code changes of any kind (stop-and-report if the live smoke finds a defect), worker debugging, brain
pages, v1 repo.
