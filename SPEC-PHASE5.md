# SPEC — Phase 5 "Windy-style weather tape" (big-pond-chop v2)

## Goal
Replace the Phase 4 text drawer with Windy.com-style weather drawn INTO the existing time deck: precip as a line graph, temp as heat-colored labels above the wind ribbon. No drawer, no collapse, no extra chrome — the deck stays the single bottom strip.

## Files allowed to touch
- `src/render.js`
- `index.html` (markup + CSS)
- `sw.js` (cache bump v4 → v5)
- `tests/**` (update/fix)

## Context you need
- Data source is ALREADY loaded: `windSeries` (built from `data/wind.json`), hourly entries `{t, tMs, speedMph, dirTrueDeg, gustMph, tempF, precipMm}` — 370 hours, covers the 15d horizon. NO new fetches.
- The deck is built per-day in render.js (~line 1000-1040): each day block is a positioned div containing a `.day-heat` wind-gradient background and 3-hourly wind labels embedded in the ribbon. Study `buildDeck`/that block and `ui.windHeatGradient` before writing.
- DELETE the Phase 4 drawer entirely: `#wx-drawer`, `#wx-rows`, `renderWeatherDrawer`, `formatWxDay`, `highlightWxDay` and their wiring/CSS/tests. The collapse bug dies with the drawer.

## Changes (do exactly these)
1. DELETE the drawer (above). Remove all its CSS, event wiring, test references.
2. **Precip line graph** (Windy-style): inside each day block of the tape, an SVG (or canvas) layer ~16px tall sitting just above the wind ribbon: a polyline where each hour's precip amount maps to line height (0 = flat baseline, more = higher). Scale: 0.5mm+ should be clearly visible; clamp the scale so a downpour doesn't dwarf the strip (cap at, say, 4mm). Same horizontal pixel mapping as the tape (pxPerFrame/pxPerDay already exist — reuse them). A hair of fill (semi-transparent) under the line like Windy does. Dry hours = flat line, unobtrusive.
3. **Temp labels** (Windy-style): a thin band ABOVE the precip layer (~14px), 3-hourly temp text at the same anchors as the wind labels, each label's color heat-mapped: ≤40°F icy blue → 60s neutral → ≥85°F warm amber/red. Match the wind-label font/size style so the two rows read as siblings: temp above, wind below.
4. Keep everything else: 24h|15d toggle, verdict band, data-age, dark card, scrub behavior (no eased snap), boot progress, no model names.
5. `sw.js`: bump to `bpc-cache-v5`.

## Done-when
- Fresh load at 390×844: drawer is GONE from DOM; tape shows per-day: temp labels (heat-colored) over a precip line over the existing wind ribbon+labels, all inside the same deck strip.
- On 15d horizon the same layers render (sparser labels are fine — reuse the existing label-density logic).
- Scrubbing still 1:1, play still 1 frame/tick, zero console errors, tests pass (`node --test tests/*.test.js tests/*.mjs`).
- `git diff --stat` touches ONLY allowed files.

## Out of scope
- worker/, data/, new fetches, horizon changes, map/verdict changes.
- Do NOT touch `opencode.jsonc`, `.opencode/`, `brag-output/`, SPEC-*.md files.
- Do NOT commit.

Follow the ponytail ruleset: reuse the existing day-block geometry and label machinery; this is one new drawing layer + one label band, not a rewrite.
