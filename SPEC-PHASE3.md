# SPEC — Phase 3 "Feel" (big-pond-chop v2)

## Goal
Restore v1's scrub feel and add boot progress. No new features, no data changes.

## Files allowed to touch
- `src/render.js`
- `index.html` (only if a hook/element for boot progress is missing)
- `tests/**` (only to fix tests broken by these changes)
- `sw.js` (cache bump ONLY if needed: bpc-cache-v3 → v4)

## Changes (do exactly these, nothing else)
1. Continuous tape scrub (v1 behavior): during drag, the time tape follows raw pointer pixels every rAF (transform translate, no transition); the canvas/frame still quantizes to the nearest frame. On release, tape stays where the pointer left it (no eased snap-back). The current `.32s eased transform` on drag must go. Keep the existing drag/scroll boundary handling and any scrub-suspension logic intact.
2. Boot progress: during initial frame prefetch, show real progress in the existing boot overlay (reuse the existing `fetchProgress` helper already used for `tables.v1.bin`) — e.g. "Loading forecast… 12/49". No new UI components.
3. Nothing else: no weather anything (deleted in Phase 1, keep it deleted), no horizon changes, no worker changes, no frame bundling.

## Done-when
- Dragging the tape moves it 1:1 with the pointer with no transition lag; frame updates still quantize; play still works (1 frame/tick).
- Boot overlay shows incremental count during prefetch (verify by throttling or reading the code path; a code-path check + existing tests passing is acceptable evidence).
- All test suites pass (`node --test tests/*.test.js tests/*.mjs`).
- `git diff --stat` touches ONLY the allowed files.

## Out of scope
- worker/, data/, delay math, frame request bundling, any visual redesign.
- Do NOT touch `opencode.jsonc`, `.opencode/`, `brag-output/`, `SPEC-PHASE1.md`.
- Do NOT commit — leave all changes in the working tree.

Follow the ponytail ruleset: laziest correct implementation.
