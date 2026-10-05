# SPEC — Phase 4 "Weather drawer + horizon simplification" (big-pond-chop v2)

## Goal
Restore weather data (a core v2 feature) as a collapsible deck drawer, and simplify the horizon toggle to 24 h | 15 d.

## Files allowed to touch
- `src/render.js`
- `index.html` (markup + CSS)
- `sw.js` (cache bump v3 → v4)
- `tests/**` (update/fix)

## Context you need
- The worker still ships all weather data (hourly wind/temp/precip per model merge); only the CLIENT rendering was deleted in the previous commit. The deleted implementation lives in git history: `git show 2dd0a6e~1:src/render.js` (see `dailySummaries`, `updateWeatherDetail`, weather cell builders) and `git show 2dd0a6e~1:index.html` (see `#weather-strip` markup/CSS). CRIB the aggregation/conversion logic from there — do not reinvent it. Keep the Phase 1 bans: NO model names (hrrr/aifs/ifs/src labels) anywhere in the UI, NO precip-free-without-data nonsense — show honest zeros/dashes when data is missing.

## Changes (do exactly these, nothing else)
1. Horizon toggle = exactly two buttons: `24 h` and `15 d`, each ≥44px, default 24h. Delete the 48h button and its frame-slicing path (dead code). `?horizon=15d` keeps working; a legacy stored/URL value of 48h may simply fall back to 24h (no special handling needed).
2. Weather drawer, collapsed by default, inside the time deck area (NOT an overlay floating on the map):
   - Collapsed: ONE compact row showing today: day name · wind (arrow + `S 12–22 mph` style) · precip in · high/low temp °F. Wind first — this is a wind app. Slim (≈28px visual, ≥44px touch hit), deck-styled (dark, matches the tape).
   - Tap toggles expand/collapse. Expanded: 15 rows, one per day (same fields), vertically scrollable with a max-height so it never covers more than ~40% of the map; chevron/aria-expanded on the header row.
   - Drawer data comes from the worker payload the old strip consumed (find the exact field in `data/frames.json` / git history).
3. Keep everything from the previous pass intact: data-age in header, dark spot card, G-unit gust pill, 1-frame play step, no eased tape snap, boot progress.
4. `sw.js`: bump `bpc-cache-v3` → `bpc-cache-v4`.

## Done-when
- Fresh load: two-button toggle (24 h active), drawer row shows today's real weather from the served data, zero model-name strings.
- Tap expands to 15 day-rows; tap again collapses; no layout overflow at 390px width; console clean.
- All suites pass (`node --test tests/*.test.js tests/*.mjs`).
- `git diff --stat` touches ONLY the allowed files.

## Out of scope
- worker/, data/ generation, delay math, map/verdict rendering, 48h UI of any kind.
- Do NOT touch `opencode.jsonc`, `.opencode/`, `brag-output/`, `SPEC-PHASE1.md`, `SPEC-PHASE3.md`.
- Do NOT commit — leave changes in the working tree.

Follow the ponytail ruleset: laziest correct implementation; crib from git history before writing anything new.
