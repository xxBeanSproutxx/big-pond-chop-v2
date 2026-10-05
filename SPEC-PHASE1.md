# SPEC — Phase 1 "Subtraction Pass" (big-pond-chop v2)

## Goal
Make v2's phone UI as clean as v1's by DELETING clutter. No new features.

## Files allowed to touch
- `index.html` (markup + inline CSS)
- `src/render.js` (and any `src/*.css` if styles live there)
- `sw.js` (cache version bump ONLY)
- `tests/**` (only to fix tests broken by the deletions below)

## Changes (do exactly these, nothing else)
1. DELETE the weather strip entirely: `#weather-strip` markup, its CSS, and all render.js wiring (`dailySummaries`, `.wx-day*` builders, precip conversion, weather day cells). It must not exist in the DOM at any horizon, including `?horizon=15d`.
2. DELETE model-source jargon from the UI: `updateWeatherLabels()` / `updateWeatherDetail()` provenance text ("hrrr/aifs", "src hrrr", gusts source strings). Users never see model names.
3. Data age: keep ONE small "updated Nh ago" line, moved INTO the header band (not floating mid-map). Warn-tint it when age > 3 h. Delete `#weather-labels` (duplicate metadata).
4. Horizon: default 24h, visible toggle = two buttons `24h | 48h`, labels consistent ("h" style both), minimum 44px tall touch targets. 15-day horizon stays reachable ONLY via `?horizon=15d` URL param (no button). If a legacy 15d button exists, remove it.
5. DELETE legacy inert `#h-24h` / `#h-7d` buttons; update any test that greps for them so the suite tests the REAL toggle instead.
6. `PLAY_STEP`: always advance 1 frame per tick (no multi-frame stepping at long horizons).
7. Spot card `#card`: dark-theme it to match the app; make its close button a visible ≥44px target that doesn't overlap text.
8. Gust pill: render as `G12 mph` (unit present).
9. Bottom-right stack: keep zoom + attribution; relocate the wave-ramp legend so it no longer crowds that corner (deck area is fine).
10. Bump `sw.js` cache name (`bpc-cache-v2` → `bpc-cache-v3`) so clients get the new shell.

## Done-when
- Fresh load, phone viewport 390×844: no weather strip in DOM, no model-name strings anywhere, header shows verdict + "updated Nh ago", horizon toggle is 24h|48h with 24h active, ≥44px buttons.
- `?horizon=15d` still loads and scrubs without console errors.
- All test suites pass (`node --test` / existing scripts).
- `git diff --stat` touches ONLY the allowed files.

## Out of scope
- `worker/`, `data/`, delay math, frame bundling, continuous-scrub feel, boot progress, any new feature.
- Do NOT touch `opencode.jsonc`, `.opencode/`, `brag-output/`.
- Do NOT commit — leave all changes in the working tree.

Follow the ponytail ruleset: laziest correct implementation; deletion over addition. If a change here conflicts with repo AGENTS.md routing, this spec wins for scope.
