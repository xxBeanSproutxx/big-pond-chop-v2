#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Re-runnable 96-frame sweep of the #wind-badge flow-vector arrow (Stage 5I).

Per frame it asserts:
  (a) text == "From <SECTOR> <round(dirTrue)>°", dirTrue = (grid + gamma) % 360
  (b) arrow angle == (dirTrue + 180) % 360 within 1.5°
  (c) aria == "Wind from <SECTOR> at <n> degrees, blowing toward <m> degrees"
  (d) calm frames (speed < 3 mph) instead show text "Calm" and a hidden arrow

Run:
    /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/wind_arrow_sweep.py
    /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/wind_arrow_sweep.py \\
        --url http://127.0.0.1:8000/index.html --viewport 390x844

Writes tmp/wind-arrow-sweep.json. Exit code 0 always.
"""

import argparse
import json
import math
import re
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
    from playwright.sync_api import TimeoutError as PWTimeout
except ImportError:  # pragma: no cover
    print("playwright is required: run with /home/reid/.hermes/hermes-agent/venv/bin/python")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
OUT = ROOT / "tmp" / "wind-arrow-sweep.json"

SECTORS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"]
BOOT_OK = "() => document.getElementById('boot').classList.contains('hidden')"
OVERLAY_OK = ("() => { var i = document.querySelector('.leaflet-image-layer'); "
              "return !!i && i.naturalWidth > 0; }")

READ_FRAME = """() => {
  var a = document.getElementById('wind-badge-arrow');
  return {
    idx: parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10),
    text: document.getElementById('wind-badge-text').textContent,
    matrix: getComputedStyle(a).transform,
    display: getComputedStyle(a).display,
    aria: document.getElementById('wind-badge').getAttribute('aria-label'),
    windMph: parseFloat(document.body.dataset.windMph),
    grid: parseFloat(document.body.dataset.bearingGrid),
  };
}"""

_MATRIX = re.compile(r"matrix\(\s*([-0-9.eE]+)\s*,\s*([-0-9.eE]+)")


def js_round(x):
    """JS Math.round semantics (half up, toward +inf)."""
    return math.floor(x + 0.5)


def angle_from_matrix(matrix):
    if not matrix or matrix == "none":
        return None
    m = _MATRIX.search(matrix)
    if not m:
        return None
    try:
        a, b = float(m.group(1)), float(m.group(2))
    except ValueError:
        return None
    return math.degrees(math.atan2(b, a)) % 360.0


def wrap_delta(a, b):
    return min(abs(a - b), 360.0 - abs(a - b))


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def serve(port):
    return subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=str(ROOT), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def wait_http(url, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as resp:
                if resp.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    return False


def read_frame(page):
    rec = page.evaluate(READ_FRAME)
    rec["angle"] = None if rec["display"] == "none" else angle_from_matrix(rec["matrix"])
    return rec


def sweep(page):
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuenow') === '0'",
        timeout=5000)
    page.wait_for_timeout(400)
    frames = [read_frame(page)]
    presses = 0
    while frames[-1]["idx"] < 95 and presses < 400:
        prev = frames[-1]["idx"]
        advanced = False
        for _ in range(3):  # initial press + up to 2 retries
            page.keyboard.press("ArrowRight")
            presses += 1
            try:
                page.wait_for_function(
                    "(p) => parseInt(document.getElementById('track')"
                    ".getAttribute('aria-valuenow'), 10) > p",
                    arg=prev, timeout=2000)
                advanced = True
                break
            except PWTimeout:
                continue
        if not advanced:
            break
        frames.append(read_frame(page))
    return frames


def assess(rec, gamma):
    speed = rec["windMph"]
    grid = rec["grid"]
    calm = speed is not None and speed < 3
    rec["calm"] = calm
    if calm:
        ok = rec["text"] == "Calm" and rec["angle"] is None
        rec["expected"] = None
        return ok
    if grid is None or not math.isfinite(grid):
        rec["expected"] = None
        return False
    dir_true = (grid + gamma) % 360.0
    sector = SECTORS[js_round(dir_true / 45) % 8]
    n = js_round(dir_true)
    m = js_round((dir_true + 180.0) % 360.0)
    rec["dirTrue"] = dir_true
    rec["expected"] = (dir_true + 180.0) % 360.0
    text_ok = rec["text"] == "From %s %d°" % (sector, n)
    arrow_ok = rec["angle"] is not None and \
        wrap_delta(rec["angle"], rec["expected"]) <= 1.5
    aria = rec["aria"] or ""
    am = re.match(r"^Wind from [NSEW]{1,2} at (\d+) degrees, "
                  r"blowing toward (\d+) degrees$", aria)
    aria_ok = bool(am) and abs(int(am.group(1)) - n) <= 0.5 and \
        abs(int(am.group(2)) - m) <= 0.5
    return text_ok and arrow_ok and aria_ok


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--url", default=None,
                    help="app URL (default: serve the repo root on a free port)")
    ap.add_argument("--viewport", default="390x844", help="WxH, default 390x844")
    args = ap.parse_args()
    try:
        width, height = (int(x) for x in args.viewport.lower().split("x"))
    except ValueError:
        print("bad --viewport %r (expect WxH)" % args.viewport)
        return 0

    gamma = json.load(open(ROOT / "public" / "meta.v1.json"))["gamma_deg"]
    srv = None
    url = args.url
    if url is None:
        port = free_port()
        srv = serve(port)
        url = "http://127.0.0.1:%d/index.html" % port
        if not wait_http(url):
            print("server did not start")
            if srv:
                srv.terminate()
            return 0

    started = datetime.now(timezone.utc)
    records = []
    browser = None
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            ctx = browser.new_context(viewport={"width": width, "height": height},
                                      device_scale_factor=2)
            page = ctx.new_page()
            page.goto(url, wait_until="domcontentloaded")
            page.wait_for_function(BOOT_OK, timeout=60000)
            page.wait_for_function(OVERLAY_OK, timeout=30000)
            records = sweep(page)
            ctx.close()
    except Exception as exc:  # noqa: BLE001
        print("sweep error: %s: %s" % (type(exc).__name__, exc))
    finally:
        try:
            if browser:
                browser.close()
        except Exception:  # noqa: BLE001
            pass
        if srv:
            srv.terminate()

    ok_count = 0
    for rec in records:
        try:
            ok = assess(rec, gamma)
        except Exception:  # noqa: BLE001
            ok = False
        rec["ok"] = ok
        ok_count += int(ok)
        exp = rec.get("expected")
        print("idx %s %s text=%r arrow=%s expected=%s" % (
            rec.get("idx"), "ok" if ok else "FAIL", rec.get("text"),
            "None" if rec.get("angle") is None else "%.2f" % rec["angle"],
            "None" if exp is None else "%.2f" % exp))

    total = 96
    fails = total - ok_count
    print("wind-arrow sweep: %d/%d ok, %d FAIL" % (ok_count, total, fails))

    ts = started.strftime("%Y-%m-%dT%H:%M:%SZ")
    OUT.parent.mkdir(parents=True, exist_ok=True)
    OUT.write_text(json.dumps({
        "run": {"utc": ts, "url": url, "viewport": args.viewport,
                "gamma_deg": gamma, "n_frames": len(records),
                "ok": ok_count, "fail": fails},
        "frames": records,
    }, indent=2))
    return 0


if __name__ == "__main__":
    sys.exit(main())
