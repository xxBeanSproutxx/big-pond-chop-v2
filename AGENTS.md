# big-pond-chop-v2

Precomputed wave forecasts for Mille Lacs (Princeton MN). v1 (github.com/xxBeanSproutxx/big-pond-chop)
is FROZEN — this repo is the v2 fork: a GitHub Actions worker computes the 15-day wave field hourly;
the client is a thin viewer of precomputed frames.

## Commands
- Worker dry run: `node worker/compute.mjs`
- Unit suites: `node --test tests/`
- QA (Playwright, v2-adapted): `python3 tools/qa/pwa_check.py`, `python3 tools/qa/scrub_bench.py`
- No package.json — bare Node 22. New code = ESM `.mjs`; v1 `src/` is CJS (load via `createRequire`).

## Rules
- `src/wave-math.js` + `src/tables.js` + `public/tables.v1.bin` = VERIFIED engine + data. Reuse, never
  rewrite. Delay math (`src/delay-math.mjs`) is the ONE new algorithm; fixture-gated.
- Worker writes ONLY into `data/`; CI commits it hourly. Never hand-edit generated artifacts.
- Docs of record: `docs/BUILD-SPEC-V2.md` (full plan + orchestrator amendments), `docs/V2-RECEIPTS.md`
  (phase receipts), `PROGRESS.md` (phase log).
- CRG is NOT wired for this repo (no code-review-graph MCP config here).
