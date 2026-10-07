# SPEC — Phase 6 "Production polish" (big-pond-chop v2)

## Goal
Make scrubbing feel continuous (the wind-delay color wave reads as physics, not a glitch),
add sunrise/sunset to the timeline, and land the audit's deferred polish items. No new data,
no worker changes, no lane re-architecture.

## Files allowed to touch
- `src/render.js`
- `src/sun-times.mjs` (NEW — small pure ESM util, mirrors the `delay-math.mjs` pattern)
- `index.html` (markup + inline CSS, minimal)
- `sw.js` (cache version bump ONLY: bpc-cache-v10 → v11)
- `tests/**` (add/update only what these changes need)
- UI version marker string → `ui v2.10`

## Out of scope (do NOT touch)
- `worker/**`, `data/**`, `src/delay-math.mjs`, `src/wave-math.js`, `src/tables.js`, `src/wind.js`
- Frame plan, horizons, lane structure/order, fetch patterns
- Any redesign beyond the specific items below

## Changes (do exactly these, nothing else)

### 1. Temporal crossfade between adjacent frames during scrub
Scrubbing currently quantizes paint to whole frames; the wind-delay color wave therefore
pops frame-to-frame and reads as a glitch. Blend the two nearest frames by time fraction:
- Add a pure helper `blendRasters(a, b, t)` (Float64Array, same length): `out[i] = a[i] + (b[i]-a[i])*t`,
  EXCEPT where either value is the land/nodata sentinel (the decoded raster uses 0 for land —
  check how `frameFor` decodes: land cells decode to 0, so blending is safe as-is; if you find
  any sentinel that isn't 0, take the non-sentinel value).
- During scrub paint (the existing drag-path, still honoring the 72 ms `MAP_PAINT_MIN_MS`
  throttle), compute the minute fraction between the current frame and the next, and paint the
  blended raster when the next frame is already cached. If the neighbor isn't cached, paint the
  single frame as today (no new fetches, no await in the drag path).
- Play mode keeps painting exact frames (ticks land on frames; fraction is 0/1 there anyway).
- Keep the existing frame caches and `cacheKey` scheme; do not grow cache size.

### 2. Sunrise/sunset ticks in the time deck
- New `src/sun-times.mjs`: `sunTimesUtc(dateUtcMs, latDeg, lonDeg) -> {sunriseMs, sunsetMs}`
  using the standard NOAA solar calculation (~25 lines, no dependency). Lake coordinates come
  from the existing static data already loaded in render.js — reuse whatever bounds/center
  object the render module already has; do not hardcode new constants.
- In the deck's day blocks (both horizons), draw for each day one 1px vertical tick + tiny
  8px SVG sun glyph at the sunrise x-position and sunset x-position (same px mapping the
  tape already uses). Muted color that reads on the dark deck (aim ≥3:1 against the deck
  background). Each gets `title="Sunrise 7:17a"` / `title="Sunset 6:29p"` (local time,
  Chicago). Skip a tick if its minute falls outside that day block's span.
- Tests: `tests/sun-times.test.mjs` — (a) equinox at (0,0): sunrise ≈ 06:00 UTC, sunset ≈ 18:00
  UTC (±15 min); (b) polar day/night does not crash (return nulls or skip — pick one and
  document in one comment line); (c) round-trip monotonicity across 15 consecutive days for
  the lake latitude (sunrise < sunset, both strictly increasing day-over-day).

### 3. One-line delay hint in the existing legend card
Inside the existing wave-ramp legend card, append one muted ~11px line:
"waves build ~1 h behind the wind across open water" — explains the delay color wave with
zero new elements. No tooltips, no chips, no buttons.

### 4. Audit-deferred polish (from the 2026-10-05 Agent C list)
- Zoom controls and the spot-card close button: ≥44px touch targets.
- Verdict pill: raise text/background contrast to ≥4.5:1 (adjust pill colors only).
- One subtle 1px lane divider between the weather lane (temp/rain) and the wind ribbon so
  the lanes read as separate rows, not stacked text.

### 5. Version bumps
- `sw.js`: CACHE_NAME v10 → v11.
- The "· ui vX" build marker in the data-age line → `ui v2.10`.

## Done-when
- `node --test tests/` all green (existing + new sun-times tests).
- `python3 tools/qa/pwa_check.py` passes; `python3 tools/qa/scrub_bench.py` still PASS
  (median may rise vs v1's 16.7 ms bar but must stay under 2× the v2.9 median).
- `git diff --stat` touches ONLY the allowed files.
- Scrubbing across a wind shift paints smooth color evolution (code-path check acceptable:
  blended paint invoked with 0 < t < 1 when neighbor cached).
