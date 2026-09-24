# BUILD-SPEC P1 — delay math + fixtures (big-pond-chop-v2)

You are the P1 worker for big-pond-chop v2 (repo = the v2 fork; v1 lives elsewhere and is FROZEN).
Read `docs/BUILD-SPEC-V2.md` (amendments A1–A8 win over its body) and `docs/V2-RECEIPTS.md` (P0 is
done, gated by the orchestrator). Work ONLY inside this repo — do not read outside it (permission wall
auto-rejects and wastes budget). You MUST edit/create the files below; a run that only reads files and
exits is a failure. If a spec number conflicts with observed reality, trust reality, note it in the
receipts. Only stop-and-report for: gh auth failure, an impossible requirement, or a decision the spec
doesn't cover.

## GOAL
Implement the ONE new algorithm — `src/delay-math.mjs` (delay-aware wind over the lake, "lake memory") —
with 4 fixture-gated tests, integrate it into `worker/compute.mjs` (ON by default, switch available),
and refresh the live artifacts via a dispatched worker run.

## FILES ALLOWED TO TOUCH (nothing else)
- `src/delay-math.mjs` (new — the ONLY new algorithm)
- `tests/delay.test.js` (new)
- `worker/compute.mjs` (edit — delay integration) and `worker/guard.mjs` (new, ONLY if you need a testable seam for fixture #4)
- `docs/V2-RECEIPTS.md` (append P1 section), `PROGRESS.md` (append)
- Scratch: `tmp/` only. Do NOT commit `data/` from local (CI owns it; rm -rf after dry runs).
Frozen: every other file — especially `src/wave-math.js`, `src/tables.js`, `src/render.js`, `src/wind.js`.
No package.json, no new deps. New code = ESM `.mjs`; v1 `src/` is CJS (load via `createRequire`).

## THE PHYSICS CONTRACT (fixture-gated; this is the review bar)
v1 (instant onset): `F_used = min(F_eff, U_A·t_eff)` — waves react instantly to wind shifts anywhere on
the fetch. v2: waves arriving at a cell reflect the wind from when the energy could physically travel
there: **τ_cell = fetch distance / cg**, `CG_MPH = 11` (cgs ≈ 11 mph group speed; TOP-OF-FILE constant,
the calibration knob).

**Pinned sampling semantics (do NOT deviate without reporting):** per cell per frame, sample the merged
wind series with ZERO-ORDER HOLD at `t − τ_cell`: use the last series entry with time ≤ (t − τ_cell),
carry its {speed, dir, tEffH} together. τ derives from the cell's effective fetch for the arriving
direction (from the baked tables — `tables.fetchEff`; document your exact choice, e.g. the blended-bearing
effective fetch in metres). τ max on this lake ≈ 1.3 h → per frame the whole grid collapses to at most
~2 distinct sampled wind states — bucket cells by sampled-series index and run the per-bucket field pass
(reuse v1 `computeField` semantics; select per cell from its bucket's result). Expect near-v1 per-frame
cost; report actual ms/frame.

**Behavior contract:**
- Steady wind ⇒ identical to fetch-limited equilibrium (SPM values, unchanged).
- Step shift at t0 on a 14 mi fetch (τ = 14/11 h = 1.2727 h ≈ 4581.9 s): **Hs must NOT move before
  t0 + 14/11 h**; the first hourly sample at/after arrival shows the change; both directions (ramp-up AND
  decay). Shorter fetches respond proportionally earlier — that spatial variation is the point.
- Reef physics UNCHANGED: reuse v1 functions (`waveCore`/SPM — never reimplement); Ks 0.93–0.98; with
  steady wind + delay ON, full-grid outputs must be identical to the delay-OFF/v1 path (bit-identical
  Float64 for `.capped`; byte-identical `.bin`). If you cannot achieve identity for a real numeric reason,
  STOP and report — do not silently loosen.
- `ponytail:` comment on the chosen integration scheme naming its ceiling + upgrade path.

## REQUIRED FIXTURES — `tests/delay.test.js` (node --test, no frameworks; use the repo's check() style)
Run `node --test` from repo root (auto-discovers `tests/`; NOTE Node 22.23.1 rejects a directory
positional — same quirk P0 recorded). Four fixtures, all REQUIRED green:

1. **PARITY** — delay OFF ⇒ bit-identical to `render.computeFrame` for identical wind (3 synthetic
   entries: (12 mph, 315°, 4 h), (25, 90°, 1 h), (7, 200°, 6 h)); compare `.capped` exactly and the
   quantized .bin bytes.
2. **DELAY** — synthetic 48 h hourly series, steady 25 mph / dir 315 (tEffH via the same computeTeff
   semantics) until t0 = +24 h, then a step to 5 mph (decay) — and a mirrored ramp-up (5 → 25). For a
   14 mi cell (F = 22,530.816 m; τ = 1.2727 h): samples at t0−1, t0, t0+1 h are EXACTLY the old
   equilibrium; the first sample ≥ t0+τ (t0+2 h) is the new equilibrium (≤1e-9 rel); stays there through
   t0+8 h. **Also a 5.5 mi short-fetch cell (τ = 0.5 h): it MOVES at t0+1 h while the 14 mi cell does
   not** (this proves spatial delay, not a global time-shift). Reuse `waveCore` for equilibria values.
3. **REEF** — steady wind, delay ON vs delay OFF on the FULL grid: `.capped`/`afterKs` bit-identical,
   `.bin` byte-identical; plus assert `tests/fixtures/golden.json` Ks values all in [0.93, 0.98].
4. **NULL-GRID** — all-null AIFS payload ⇒ guard rejects it; NO artifact writes happen (last-good
   preserved); no crash (clean exit 0 path). Design the smallest real seam (e.g. export the worker's
   decision logic in `worker/guard.mjs` and unit-test it, plus assert the write path is gated on that
   decision) — but the test must actually fail if the guard is removed. Say in the receipts HOW it fails
   when mutated.

**Mutation proof (required):** demonstrate fixture 2 actually fails when the delay is disabled (e.g.
temporarily set CG_MPH huge in a scratch copy or via the switch) — paste the failing assertion line into
the receipts as the "test is not vacuous" receipt.

## INTEGRATION
- `worker/compute.mjs` uses `src/delay-math.mjs` for frame generation, delay ON by default; keep a clean
  off-switch (constant or env, e.g. `BPC_DELAY=0`). Delay OFF must be equivalent to P0 behavior.
- Local dry run: `node worker/compute.mjs` → same 147-frame plan (f0=run hour, hourly +0..+48 h, 3-hourly
  to +342 h), same artifact shapes (A3/A5/A6). Then `rm -rf data/`.
- PERF: report local full-run seconds + ms/frame for the compute step. Soft ceiling: ≤ 60 s full run;
  hard: ≤ 300 s (Actions timeout budget). Optimize if above soft (bucketing as described).
- Run ALL suites: `node --test` → expect 5 files green (4 v1 + delay).
- Commit + push (pull --rebase first — the hourly worker may have committed data): 
  `git pull --rebase origin main && git add src/delay-math.mjs tests/delay.test.js worker/ docs/ PROGRESS.md && git commit -m "P1: delay-aware wind math + 4 fixtures" && git push`
- Then dispatch a manual worker run to regenerate live data with delay ON:
  `gh workflow run worker.yml --ref main`, watch to success, `git pull`, verify `data/frames.json`
  `generated_at` is fresh. (An hourly cron may also fire around this time — both are fine; verify the
  LATEST data commit's frames.json generated_at > your dispatch time.)

## PROGRESS.md + RECEIPTS
- PROGRESS.md: append `- <ISO-Z> [P1] ...` lines: delay-math implemented, fixtures green (4/4 + mutation
  proof), dry-run N frames + perf, pushed <sha>, worker run <id> <conclusion>, live refresh verified.
- docs/V2-RECEIPTS.md: append `## P1 — delay math + fixtures` with: the 4 fixture results, the NUMERIC
  delay values (τ_14mi = 1.2727 h; long-cell first-moved sample = t0+2 h; short-cell (5.5 mi, τ=0.5 h)
  first-moved = t0+1 h), parity/reef identity evidence, perf numbers (ms/frame + full run), the mutation
  proof line, dispatch run URL + conclusion, deviations.

## DONE-WHEN — print these EXACT evidence lines at the end
```
FIXTURES: parity=<pass|fail> delay=<pass|fail> reef=<pass|fail> null-grid=<pass|fail> | node --test: tests=<n> pass=<n> fail=<n>
DELAY_NUMBERS: tau_14mi_h=1.27273 first_moved_long=<T0+2h> first_moved_short=<T0+1h>
PERF: full_run_s=<N> ms_per_frame=<X>
DISPATCH: <run url> conclusion=<success|failure> frames_generated_at=<ISO>
MUTATION: delay-fixture fails with delay off: <yes + assertion line | no>
DEVIATIONS: <none|list>
```

## OUT OF SCOPE
- Client/viewer work (P2), weather strip (P3), ship polish (P4). No v1-repo edits, no tags, no PRs, no
  README/AGENTS rewrites, no CRG.
