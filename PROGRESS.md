# PROGRESS — big-pond-chop-v2

One line per phase transition + blocker notes. Orchestrator polls `git log origin/main` + this file.

- 2026-09-24T17:50Z [P0] scaffold: v1 files copied (src/public/tests/tools + root files), docs/BUILD-SPEC-V2.md (with orchestrator amendments A1–A8) + docs/BUILD-SPEC-P0.md committed; worker leaf dispatching.
- 2026-09-24T17:52Z [P0] worker implemented: worker/compute.mjs (ESM, HRRR+AIFS+IFS merge, A1 frame plan, A4 guards) + .github/workflows/worker.yml (cron+dispatch).
- 2026-09-24T17:52Z [P0] dry-run ok: 147 frames, 12,233,340 bytes, wind.json 360 h (f0=2026-09-24T17:00Z, last=2026-10-08T23:00Z); data/ removed locally.
- 2026-09-24T17:53Z [P0] pushed ce0ea6b (worker + workflow) to origin/main.
- 2026-09-24T17:53Z [P0] workflow run 36037293434 conclusion=success (data commit 257dc18).
- 2026-09-24T17:55Z [P0] Pages status=built; live check ok: frames.json 200/8700B, f000.bin 200/83220B, wind.json 360 h.
- 2026-09-24T18:01Z [P1] delay-math implemented: src/delay-math.mjs (CG_MPH=11 knob, τ=F_eff/cg ZOH bucketing, reuses v1 computeField); worker integrated (delay ON default, BPC_DELAY=0 off-switch); worker/guard.mjs seam extracted (parsing + AIFS-null decision + gated artifact write + quantize).
- 2026-09-24T18:01Z [P1] fixtures 4/4 green + mutation proof; node --test 5/5 pass; dry-run 146 frames (run hour 18:00Z), 7.0 ms/frame ON (2.8 OFF), full run 2.22 s; data/ removed/restored.
