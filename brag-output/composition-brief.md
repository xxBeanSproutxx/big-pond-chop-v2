# Hyperframes Composition Brief: Big Pond Chop

## Objective
Create a 15-second launch-style brag video for Big Pond Chop, a precomputed 15-day wind-wave
forecast viewer for Mille Lacs Lake, Minnesota.

## Output
- Composition directory: `brag-output/composition/`
- Rendered video: `brag-output/brag.mp4`
- Format: landscape — 1920x1080
- Duration: 15.0s

## Source Material
- Project root: `/home/reid/projects/big-pond-chop-v2`
- Primary files read: `index.html`, `src/ui.js` (Hs palette, tier enum, headline format),
  `src/render.js` (Hmax = `min(1.67·Hs, 0.78·depth)`), `README.md`, `docs/shots/*`, `data/frames.json`,
  `data/wind.json`, `data/f0xx.bin`
- Product name: Big Pond Chop
- Tagline / strongest claim: "Precomputed 15-day wind-wave forecast for Mille Lacs Lake"
- Key UI or visual moment to recreate: the phone viewer — Hs heat field over a muted map, the
  two-line verdict header with the condition chip, the wind pills, the 15-day tape with the amber
  time pill.
- Copy that must appear verbatim (from the real UI):
  - `Fishable · Light Chop`
  - `Walleye Chop`
  - `Heavy Rollers`
  - `Dangerous · Stay Home`
  - `Waves: 1.0 - 2.6 ft` and `Peak: 4.4 ft` (frame f042)
- Real data baked in (`brag-output/tools/stats.json`, all from `data/`):
  - f042: Waves 1.0-2.6 ft · Peak 4.4 ft · 22 mph / 31 Gust · From SE 151° · Dangerous · Stay Home
  - f060: flat calm (`Calm · Flat`), f036: Heavy Rollers, f024: Walleye Chop
  - Heat overlays: `assets/heat/heat-*.png`, generated with the app's exact `HS_STOPS` palette.

## Creative Direction
- Tone preset: `default`
- Creative direction: deadpan Minnesota marine forecast — a public information film that takes
  one lake very seriously.
- Interpretation: short, confident declaratives delivered straight; the joke is the seriousness
  applied to a single lake. Comfortable pacing, clean cuts, no winking.
- Angle: a broadcast forecast for a pond, backed by real computed data and a verdict that will
  tell you to stay home.
- Hook: "Minnesota has 11,842 lakes." → "This one has a wave forecast."
- Outro / punchline: `BIG POND CHOP` + "15-day wind waves for Mille Lacs Lake." + the four-verdict
  ladder as a footer.
- Avoid:
  - Generic SaaS language
  - Abstract filler visuals
  - Unrelated visual redesign (keep the app's palette, fonts' register, and vocabulary)

## Visual Identity
- Background: `#0d1b2a`
- Text: `#e8f0f7`; header text `#f8fafc`; muted metadata `#9fc3dd`
- Accent: `#ffd166`
- Chip colours: green `#15803d`, yellow `#facc15`, amber `#ea580c`, red `#dc2626`
- Display font: `Oswald`; data font: `JetBrains Mono`; supporting: `Montserrat` (all
  pre-bundled HyperFrames families — no @font-face needed)
- Visual references from the project: the Hs heat field, the amber time pill and wind arrow,
  the frosted header band, the 15-day day-cell strip, the tier chips.

## Storyboard
Use `brag-output/brag-plan.md` as the creative contract.

Scene summary:
1. Hook — 3.4s — "Minnesota has 11,842 lakes." / "This one has a wave forecast."; phone card slides
   up from lower-right, real lake heat field fades up.
2. The read — 2.8s — push to the phone header; `Waves: 1.0 - 2.6 ft`, `Peak: 4.4 ft`, wind pills,
   `Dangerous · Stay Home` chip pop in; left copy "Never one number. / A range, a peak, and a verdict."
3. Scrub the lake — 4.8s — simulated cursor drag on the tape; day blocks slide; the heat field
   cross-fades f060 → f042 → f036 → f024; header numbers + chip flip Calm·Flat → Dangerous·Stay Home
   → Heavy Rollers → Walleye Chop; left copy "Scrub 15 days. / Watch the lake change its mind."
4. Outro — 4.0s — `BIG POND CHOP` wordmark over the frame; four-verdict ladder footer; tagline.
- The phone card is persistent across all four scenes (one device, not four mockups).

## Audio
- Audio role: warm corporate bed with sparse UI accents; forecast-bulletin energy.
- Audio arc: bed throughout → UI hits on phone/verdict/scrub → bell alone over a 1.2s fade.
- Music: `assets/music/happy-beats-business-moves-vol-10-by-ende-dot-app.mp3`, volume 0.32, run 0→15s, fade out last 1.2s.
- Music treatment: start at 0, `0.32` bed, fade to silence under the final wordmark.
- Music cue guidance: bundled preset `.opencode/skills/brag/assets/music/cues/happy-beats-business-moves-vol-10-by-ende-dot-app.music-cues.json`
  (~109.96 BPM; beat grid from 0.27s, ~0.545s spacing). Lock 2 major landings (phone reveal, wordmark)
  to the nearest highest-`strength` beats within ±0.15s; snap small entrances within ±0.10s. Skip cues
  that hurt reading time.
- Audio-reactive treatment: subtle — a per-frame audio band drives the heat-field glow opacity and the
  phone card's bass presence. No waveform/equalizer visuals. If extraction is unavailable, use a light
  deterministic pulse instead and note it.
- Audio-coupled moments:
  - Scene 1 — phone card landing (`impact/impactSoft_medium_001`), map reveal (`interface/drop_001`)
  - Scene 2 — verdict range (`impact/impactSoft_medium_001`), chip pop (`interface/click_003`)
  - Scene 3 — drag start (`interface/click_003`), hour ticks (`keyboard/keypress-*`, randomized), chip flips (`interface/drop_002`)
  - Scene 4 — wordmark (`impact/impactBell_heavy_000`)
- SFX selection guidance: match motion and interaction; each SFX fires at the animation's start. Keep it
  sparse (5-6 cues). Prefer low-HF-risk picks.
- SFX analysis guidance: `.opencode/skills/brag/assets/sfx/sfx-analysis.md` — prefer low-HF-risk files.
- Exact SFX choice: Hyperframes chooses filenames, timestamps, density, and volume from the implemented animation.
- Audio files already copied to `brag-output/composition/assets/{music,sfx}/`.

## Hyperframes Instructions
Load the composition-building Hyperframes domain skills — `hyperframes-core` (composition contract +
`data-*` timing), `hyperframes-animation` (motion), `hyperframes-creative` (design spec, beats,
audio-reactive), `hyperframes-keyframes` (seek-safe keyframes), and `hyperframes-cli` (lint/check/render).
/brag is its own workflow: do not enter the `hyperframes` entry-point intent interview and do not route
into its generic promo / launch-video workflow. Prefer native Hyperframes conventions.

Requirements:
- Show at least one real UI, copy, or visual element from the source project (the recreated viewer + real copy).
- Keep all text readable in the final render.
- Keep the video at 15.0s.
- Include music + SFX.
- Treat /brag audio notes as guidance, not a fixed cue sheet. Choose SFX after the visual animation exists.
- Treat music cue metadata as optional timing hints.
- Use local assets for audio and media.
- Run `npx hyperframes check` before render — brag's single gate.
