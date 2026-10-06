# Brag Plan: Big Pond Chop

## What is this app?
A precomputed 15-day wind-wave forecast viewer for one lake — Mille Lacs, Minnesota. A GitHub
Action runs hourly, merges HRRR + AIFS + IFS weather, computes ~152 wave frames, and commits
them; the client is a thin, scrubbable viewer. Wave height is depth- and delay-aware: a wind
shift doesn't move the water until energy can physically travel the fetch — "lake memory."

## The angle
A deadpan public-information film about a single lake that has been studied harder than most
oceans. The humor is not invented: the app literally grades your afternoon as
`Fishable · Light Chop` → `Walleye Chop` → `Heavy Rollers` → `Dangerous · Stay Home`. We play
it completely straight, like a broadcast forecast for a pond. Specific, not quirky.

## Hook (first 2-3 seconds)
"Minnesota has 11,842 lakes." Beat. "This one has a wave forecast." The real lake heat-map slides
in during the second line — the glowing silhouette is the payoff to the setup.

## Key moments (the middle)
- Sub-headline numbered line: "Never one number." — one line that explains the app's core honesty.
- The recap: "Scrub 15 days." — one line that explains the scrub is the product.
- The tier ladder as the final punch: `Fishable · Light Chop` / `Walleye Chop` / `Heavy Rollers` /
  `Dangerous · Stay Home` — the app's actual verdict enum, ending on the funniest one.
- The header verdict really flips while scrubbing: `Fishable · Light Chop` → `Walleye Chop` →
  `Heavy Rollers` → `Dangerous · Stay Home`, driven by the real frame data.

## Outro / punchline
`BIG POND CHOP` slams in. Tagline: "15-day wind waves for Mille Lacs Lake." Small footer:
"Computed hourly. 152 frames. One lake."

## User flow worth showing
entry → key action → result:
1. **Entry:** the viewer loads with the lake's wave field, current verdict, wind, and the 15-day tape.
2. **Key action:** scrub the timeline tape across the days; the wave heat morphs and every readout updates.
3. **Result:** the same lake flips from glass-flat (`Calm · Flat`) to 4.7 ft peak rollers
   (`Dangerous · Stay Home`), with the map recolouring cyan → amber → orange along the way.

The scrub is the centerpiece. The recreation is a faithful phone card, not a landing-page hero.

## Tone
- Preset: `default`
- Creative direction: "deadpan Minnesota marine forecast — a public information film that
  takes one lake very seriously."
- Interpretation: clean, confident, postable. Copy is short declaratives delivered straight;
  the joke is the seriousness applied to a single lake. Comfortable pacing, no chaotic cutting,
  no winking at the camera.

## Format: landscape — 1920x1080
## Duration: 15.0s

## Visual identity (from the project)
- Background: `#0d1b2a` (app body), header band `rgba(15,23,42,.85)`
- Text: `#e8f0f7` (body), `#f8fafc` (header), `#9fc3dd` (muted metadata)
- Accent: `#ffd166` (amber — time pill, wind arrow, wave ticks)
- Tier colours (verbatim from `src/ui.js`): green `#15803d`, yellow `#facc15`, amber `#ea580c`,
  red `#dc2626`
- Hs palette (verbatim from `src/ui.js` `HS_STOPS`): `#0891b2` → `#06b6d4` → `#f59e0b` →
  `#ea580c` → `#dc2626` → `#be185d`
- Display font: `Oswald` (condensed public-service sans)
- Data font: `JetBrains Mono` (mirrors the app's `tabular-nums` readouts)
- Secondary: `Montserrat` (400) for supporting copy
- Strongest visual element: the lake's Hs heat field over a muted map, with the amber time pill.

## Share copy (draft)
Minnesota has 11,842 lakes. This one has a 15-day wave forecast. Big Pond Chop computes ~152
frames of depth-aware wind-wave height for Mille Lacs every hour — and it will tell you, honestly,
when to just stay home.

## Audio direction
- Role: warm, clean corporate bed with restrained UI accents — the radar-loop energy of a forecast bulletin.
- Music: `happy-beats-business-moves-vol-10-by-ende-dot-app.mp3` (60s, punchy loop, ~110 BPM).
- Music treatment: start at 0 and run the full 15s at `0.32`; fade out over the last 1.2s under
  the wordmark so the final bell rings clear.
- Music cue guidance: bundled preset
  `.opencode/skills/brag/assets/music/cues/happy-beats-business-moves-vol-10-by-ende-dot-app.music-cues.json`
  (tempo ~109.96 BPM; beat grid from 0.27s, ~0.545s spacing). Strong cues inside the 15s window are
  sparse; use the highest-`strength` beats near the two major landings (see storyboard) within ±0.15s,
  and snap small entrances within ±0.10s. Ignore any cue that fights reading time.
- Audio-reactive treatment: subtle. A per-frame audio band drives the heat glow's opacity slightly and
  the phone card's shadow presence on bass. No waveform/equalizer visuals.
- SFX posture: sparse-to-moderate, motion-matched, restrained: 5-6 cues total.
- Audio-coupled moments: phone card slide-in; the verdict chip pop (and later chip flips); the tape
  scrub ticks; the wordmark bell.
- Restraint rule: no risers, no whooshes on every scene, nothing louder than the words on screen.

## Storyboard

### Scene 1 — Hook — 3.4s
Left copy, anchored left edge. Line 1 settles first, line 2 lands after a beat; the phone card
slides up from the lower right and the real lake heat-field fades up inside it.
- Line 1 (0.3s): `Minnesota has 11,842 lakes.`
- Line 2 (1.7s): `This one has a wave forecast.`
- Phone enters 0.5s; heat field fades in 1.6s; auto-scrubs between frame 000 and 012.
Sequential/interaction: yes — phone slides up, then the map overlay fades up.
Audio intent: confident, a little dry; the bed establishes the bulletin mood.
Audio-coupled idea: soft `impact/impactSoft_medium_001` as the phone lands; `interface/drop_001` on the map reveal.
Music: upbeat corporate bed.
Transition mood: clean → Scene 2

### Scene 2 — The read — 2.8s
Camera pushes toward the phone header. The real readout appears: `Waves: 0.9 - 2.8 ft`,
`Peak: 4.7 ft`, wind pill `2 mph`, gust pill `6 Gust`, and the `Dangerous · Stay Home` chip.
Left copy: `Never one number.` then `A range, a peak, and a verdict.`
Sequential/interaction: yes — range, peak, and chip pop in one after another inside the header.
Audio intent: the reveal lands with a small hit; confident, not loud.
Audio-coupled idea: `impact/impactSoft_medium_001` on the range; `interface/click_003` on the chip.
Music: continue.
Transition mood: hard cut → Scene 3

### Scene 3 — Scrub the lake — 4.8s
The centerpiece flow. A cursor catches the tape and drags it right: day blocks slide, the amber
`1 PM` pill rides the rail, the heat field cross-fades between real frames, and the header numbers
and chip flip live (`Fishable · Light Chop` → `Walleye Chop` → `Heavy Rollers` → `Dangerous · Stay Home`).
Left copy: `Scrub 15 days.` then `Watch the lake change its mind.`
Sequential/interaction: yes — simulated cursor drag; day labels pass one by one; the chip flips at
the 2.0 ft and 2.5 ft-roller thresholds. Each readout line holds ≥0.7s after a flip before the next.
Audio intent: momentum, a loop winding through the forecast; the scrub is the fun.
Audio-coupled idea: `interface/click_003` at drag start; sparse `keyboard/keypress-*` (randomized)
ticking as hours pass; `interface/drop_002` on each chip flip.
Music: continue, full energy.
Transition mood: clean crossfade → Scene 4

### Scene 4 — Outro — 4.0s
The phone settles on the calm frame; the wordmark `BIG POND CHOP` rises over the whole frame, with
the four-verdict ladder as a footer strip (`Fishable · Light Chop` · `Walleye Chop` · `Heavy Rollers` ·
`Dangerous · Stay Home`) and the tagline `15-day wind waves for Mille Lacs Lake.`
Sequential/interaction: yes — the four ladder chips arrive one by one, left to right.
Audio intent: clean landing; one resonant bell; music fades out.
Audio-coupled idea: `impact/impactBell_heavy_000` on the wordmark.
Music: fade out over the scene.
Transition mood: end.

**Music mood for this video:** upbeat / clean corporate, forecast-bulletin energy
**Audio summary:** a steady corporate bed anchors the film; sparse UI hits mark the phone, the
verdict, the scrub ticks, and the wordmark, then the bell rings alone over a 1.2s fade.
