#!/usr/bin/env python3
"""Stage 5G frame audit — record the tape transport and measure the reticle.

Records a phone-viewport session (playback, forward drag, rewind drag, 7-day widen +
mid-tape scrub) as video, samples the geometry ~10x/s while it runs, and prints a table so
"the pill never moves, the tape does" is a measurement, not an opinion.

Run:
  /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/tape_audit.py --url http://127.0.0.1:8000/
  ... --url https://xxbeansproutxx.github.io/big-pond-chop/ --out tmp/audit-5g

Outputs in --out: tape.webm (Playwright), tape.mp4 (ffmpeg, if available), frames/*.png,
and a printed SAMPLES table. Exit 0 always; read the PASS/FAIL lines.
"""
import argparse
import shutil
import subprocess
import sys
import time


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", required=True)
    ap.add_argument("--out", default="tmp/tape-audit")
    ap.add_argument("--frames-fps", type=float, default=2.0)
    args = ap.parse_args()

    from pathlib import Path
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    (out / "frames").mkdir(exist_ok=True)

    from playwright.sync_api import sync_playwright
    samples = []
    raw = []
    verdicts = []

    def rec(name, ok, detail):
        verdicts.append(ok)
        print("%-26s %s   %s" % (name, "ok  " if ok else "FAIL", detail))

    with sync_playwright() as pw:
        browser = pw.chromium.launch()
        ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                  record_video_dir=str(out), record_video_size={"width": 390, "height": 844})
        page = ctx.new_page()
        page.goto(args.url, wait_until="load", timeout=60000)
        page.wait_for_function(
            "() => { var p = document.getElementById('time-pill');"
            " return !!p && p.textContent.trim() !== '\u2014' &&"
            " document.getElementById('track-days').children.length >= 1; }",
            timeout=120000)

        def snap(label):
            v = page.evaluate("""() => {
                const pill = document.getElementById('time-pill').getBoundingClientRect();
                const tl = document.getElementById('timeline').getBoundingClientRect();
                const tape = document.getElementById('track-tape');
                const tr = tape.getBoundingClientRect();
                const n = parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10);
                return {pillX: pill.x + pill.width / 2, winX: tl.x + tl.width / 2,
                        tapeLeft: tr.left, tapeW: tr.width, idx: n,
                        text: document.getElementById('time-pill').textContent};
            }""")
            v["label"] = label
            v["t"] = round(time.time(), 2)
            samples.append(v)
            return v

        def hold(seconds, step=0.1, label=""):
            end = time.time() + seconds
            while time.time() < end:
                raw.append(snap(label))
                time.sleep(step)

        tl = page.evaluate("""() => { const r = document.getElementById('timeline').getBoundingClientRect();
            return {cx: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width}; }""")

        # --- 1. playback: the tape must move, the reticle must not
        page.click("#play")
        hold(3.0, label="play")
        page.click("#play")           # pause again
        page.wait_for_timeout(300)

        # --- 2. forward drag (left) then rewind drag (right)
        def drag(dx, label, steps=12):
            page.mouse.move(tl["cx"], tl["y"])
            page.mouse.down()
            for i in range(1, steps + 1):
                page.mouse.move(tl["cx"] + dx * i / steps, tl["y"])
                time.sleep(0.02)
            page.mouse.up()
            page.wait_for_timeout(250)
            return snap(label)

        # The 24 h tape ends at "now" (this audit runs late evening), so rewind first —
        # otherwise a forward drag is already clamped at the last frame.
        drag(250, "rewind-room", steps=18)
        before_fwd = snap("before-fwd")
        after_fwd = drag(-150, "after-fwd")
        before_back = snap("before-back")
        after_back = drag(100, "after-back")
        # --- 3. 7-day widen + mid-tape scrub
        page.click("#h-7d")
        page.wait_for_function(
            "() => document.getElementById('track').getAttribute('aria-valuemax') === '671'",
            timeout=90000)
        page.wait_for_timeout(800)
        w7 = snap("7d-start")
        drag(-420, "7d-mid", steps=20)
        hold(1.5, label="7d-hold")

        ctx.close()
        browser.close()

    # ---- video
    webms = sorted(out.glob("*.webm"))
    if webms:
        webm = webms[-1]
        target = out / "tape.webm"
        if webm != target:
            shutil.move(str(webm), str(target))
        print("video: %s (%.1f MB)" % (target, target.stat().st_size / 1e6))
        mp4 = out / "tape.mp4"
        if shutil.which("ffmpeg"):
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(target),
                            "-c:v", "libx264", "-preset", "veryfast", "-crf", "26",
                            "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(mp4)], check=False)
            if mp4.exists():
                print("mp4:   %s (%.1f MB)" % (mp4, mp4.stat().st_size / 1e6))
            subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", str(target),
                            "-vf", "fps=%g" % args.frames_fps, str(out / "frames" / "f_%03d.png")], check=False)
            n = len(list((out / "frames").glob("*.png")))
            print("frames: %d PNGs at %g fps" % (n, args.frames_fps))
    else:
        print("no video produced", file=sys.stderr)

    # ---- measurements
    print("\nSAMPLES (window centre vs pill centre vs tape left)")
    print("  %-12s %6s %8s %8s %9s %9s" % ("phase", "idx", "winCx", "pillCx", "dPill", "tapeLeft"))
    for s in samples:
        print("  %-12s %6d %8.1f %8.1f %9.2f %9.1f"
              % (s["label"], s["idx"], s["winX"], s["pillX"], s["pillX"] - s["winX"], s["tapeLeft"]))

    pills = [s["pillX"] - s["winX"] for s in samples]
    rec("reticle fixed", max(pills) - min(pills) <= 0.5,
        "pill minus window centre spread=%.2f px over %d samples" % (max(pills) - min(pills), len(samples)))
    play = [s for s in raw if s["label"] == "play"]
    rec("tape moves on play", (play[-1]["tapeLeft"] - play[0]["tapeLeft"]) < -5,
        "tape left moved %.1f px, idx %d -> %d during playback"
        % (play[-1]["tapeLeft"] - play[0]["tapeLeft"], play[0]["idx"], play[-1]["idx"]))
    rec("drag left advances", after_fwd["idx"] > before_fwd["idx"],
        "idx %d -> %d on -150 px drag" % (before_fwd["idx"], after_fwd["idx"]))
    rec("drag right rewinds", after_back["idx"] < before_back["idx"],
        "idx %d -> %d on +100 px drag" % (before_back["idx"], after_back["idx"]))
    rec("7d tape wide", w7["tapeW"] >= 1100, "tape width %.0f px at 7 day" % w7["tapeW"])

    print("\nSUMMARY: %d ok, %d FAIL" % (sum(verdicts), verdicts.count(False)))
    return 0


if __name__ == "__main__":
    sys.exit(main())
