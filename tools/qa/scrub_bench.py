#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 5H mobile scrub benchmark for big-pond-chop.

Measures one 30-step / 240 px LEFT drag (forward in time) across #timeline at two phone
viewports plus a CDP touch drag, on whatever tree --url points at. It never depends on
anything 5H adds, so the same command runs against the pre-stage5h tree and the merged tree
to produce a before/after pair.

Run:
    /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/scrub_bench.py \
        --url http://127.0.0.1:8000/index.html --label pre-stage5h
    /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/scrub_bench.py \
        --url http://127.0.0.1:8000/index.html --label stage5h

If --url is omitted it serves the repo root on a free port. Exit code is always 0; read the
PASS/FAIL lines for the verdict.
"""

import argparse
import json
import math
import socket
import statistics
import subprocess
import sys
import time
import urllib.request
from datetime import datetime
from pathlib import Path

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    print("playwright is required: run with /home/reid/.hermes/hermes-agent/venv/bin/python")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
OVERLAY_OK = ("() => { var i = document.querySelector('.leaflet-image-layer'); "
              "return !!i && i.naturalWidth > 0; }")

# add_init_script takes a *script body* string. Everything is installed before page scripts
# run; element lookups are deferred to the pointer/observer path.
INIT_SCRIPT = r"""
(function () {
  var B = window.__bench = {
    created: 0, revoked: 0, srcSwaps: 0, blobSrc: 0, imgSrc: 0, tapeTx: 0,
    moves: 0, downX: null, lastX: null, longtasks: [], paints: 0, touched: false,
    frameMs: [], txInst: false, srcInst: false, longInst: false, paintInst: false
  };
  window.__benchReset = function () {
    B.created = 0; B.revoked = 0; B.srcSwaps = 0; B.blobSrc = 0; B.imgSrc = 0;
    B.tapeTx = 0; B.moves = 0; B.downX = null; B.lastX = null;
    B.longtasks = []; B.paints = 0; B.frameMs = [];
  };
  try {
    var c = URL.createObjectURL.bind(URL), rv = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (b) { B.created++; return c(b); };
    URL.revokeObjectURL = function (u) { B.revoked++; return rv(u); };
  } catch (e) {}
  // blob-src writes on HTMLImageElement.prototype, split out for the overlay image.
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (d && d.set) {
      var set = d.set;
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          B.imgSrc++;
          var s = String(v);
          if (s.indexOf('blob:') === 0) {
            B.blobSrc++;
            if (this && this.classList &&
                this.classList.contains('leaflet-image-layer')) B.srcSwaps++;
          }
          set.call(this, v);
        }
      });
      B.srcInst = true;
    }
  } catch (e) { B.srcInst = false; }
  // #track-tape inline transform writes. Chromium does not expose a prototype accessor,
  // so shadow the property on that element's own CSSStyleDeclaration (translateX only).
  function installTapeTx() {
    var tape = document.getElementById('track-tape');
    if (!tape || !tape.style || tape.style.__benchTx) return;
    try {
      Object.defineProperty(tape.style, 'transform', {
        configurable: true,
        get: function () { return this.getPropertyValue('transform'); },
        set: function (v) {
          if (String(v).indexOf('translateX') === 0) B.tapeTx++;
          this.setProperty('transform', v);
        }
      });
      tape.style.__benchTx = true;
      B.txInst = true;
    } catch (e) { B.txInst = false; }
  }
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', installTapeTx);
  } else { installTapeTx(); }
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (en) { B.longtasks.push(Math.round(en.duration)); });
    }).observe({ entryTypes: ['longtask'] });
    B.longInst = true;
  } catch (e) { B.longInst = false; }
  // Map paints: wrap L.imageOverlay's setUrl (counts deduped and applied calls alike).
  try {
    var _L;
    Object.defineProperty(window, 'L', {
      configurable: true,
      get: function () { return _L; },
      set: function (v) {
        _L = v;
        if (v && v.imageOverlay && !v.__benchPatched) {
          v.__benchPatched = true;
          var orig = v.imageOverlay;
          v.imageOverlay = function () {
            var ov = orig.apply(this, arguments);
            var su = ov.setUrl;
            ov.setUrl = function (u) { B.paints++; return su.call(this, u); };
            return ov;
          };
        }
      }
    });
    B.paintInst = true;
  } catch (e) { B.paintInst = false; }
  window.addEventListener('pointerdown', function (e) { B.downX = e.clientX; }, true);
  window.addEventListener('pointermove', function (e) { B.moves++; B.lastX = e.clientX; }, true);
  window.addEventListener('touchstart', function () { B.touched = true; }, true);
  try {
    new MutationObserver(function () {
      var v = document.body && document.body.dataset ? document.body.dataset.frameMs : null;
      if (v) B.frameMs.push(parseFloat(v));
    }).observe(document,
      { subtree: true, attributes: true, attributeFilter: ['data-frame-ms'] });
  } catch (e) {}
})();
"""


def free_port():
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    port = s.getsockname()[1]
    s.close()
    return port


def serve(port, cwd):
    return subprocess.Popen(
        [sys.executable, "-m", "http.server", str(port), "--bind", "127.0.0.1"],
        cwd=str(cwd), stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


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


def js_round(x):
    """JS Math.round semantics for the dx -> index exactness check."""
    return math.floor(x + 0.5)


def pct(values, p):
    if not values:
        return 0.0
    ordered = sorted(values)
    k = min(len(ordered) - 1, int(round((p / 100.0) * (len(ordered) - 1))))
    return ordered[k]


def goto_horizon(page, horizon):
    # v2: 48h = first 49 hourly frames (max 48); 15d = the full precomputed set.
    sel = "#h-48h" if horizon == "48h" else "#h-15d"
    if page.get_attribute(sel, "aria-pressed") != "true":
        page.click(sel)
    n = page.evaluate(
        "() => parseInt(document.getElementById('track').getAttribute('aria-valuemax'), 10) + 1")
    page.wait_for_function(
        "() => parseInt(document.getElementById('track').getAttribute('aria-valuemax'), 10) >= 48",
        timeout=90000)
    page.wait_for_timeout(600)


def read_geometry(page):
    return page.evaluate(
        """() => {
             var tl = document.getElementById('timeline').getBoundingClientRect();
             var tape = document.getElementById('track-tape').getBoundingClientRect();
             var max = parseInt(document.getElementById('track').getAttribute('aria-valuemax'), 10);
             return { window: tl.width, tape: tape.width, n: max + 1,
                      cx: tl.x + tl.width / 2, y: tl.y + tl.height / 2 };
           }""")


def measure_horizon(page, horizon):
    goto_horizon(page, horizon)
    g = read_geometry(page)
    if not g["tape"]:
        return None
    px_day = g["tape"] / (2.0 if horizon == "48h" else 15.0)
    return {
        "window": round(g["window"], 1),
        "tape": round(g["tape"], 1),
        "runway": round(g["tape"] - g["window"], 1),
        "px_per_day": round(px_day, 2),
        "px_per_hour": round(px_day / 24.0, 2),
        "px_per_frame": round(g["tape"] / g["n"], 4),
    }


def drag_mouse(page, x0, y0, steps=30, dist=240, pace_ms=0):
    """Drag, snapshot the counters mid-drag, then release. Returns (latencies, stats, drag_ms)."""
    lat = []
    t_start = time.perf_counter()
    page.mouse.move(x0, y0)
    page.wait_for_timeout(30)
    page.mouse.down()
    for k in range(1, steps + 1):
        t0 = time.perf_counter()
        page.mouse.move(x0 - dist * k / steps, y0)
        lat.append((time.perf_counter() - t0) * 1000.0)
        if pace_ms:
            page.wait_for_timeout(pace_ms)
    page.wait_for_timeout(40)
    stats = page.evaluate("() => window.__bench")
    drag_ms = (time.perf_counter() - t_start) * 1000.0
    page.mouse.up()
    return lat, stats, drag_ms


def drag_touch(ctx, page, x0, y0, steps=30, dist=240, pace_ms=0):
    """CDP touch drag. Raises if Chromium cannot synthesise it here (caller marks unavailable)."""
    client = ctx.new_cdp_session(page)
    lat = []
    t_start = time.perf_counter()
    touch = [{"x": x0, "y": y0, "id": 1, "radiusX": 6, "radiusY": 6, "force": 1}]
    client.send("Input.dispatchTouchEvent", {"type": "touchStart", "touchPoints": touch})
    for k in range(1, steps + 1):
        pts = [{"x": x0 - dist * k / steps, "y": y0, "id": 1, "radiusX": 6, "radiusY": 6,
                "force": 1}]
        t0 = time.perf_counter()
        client.send("Input.dispatchTouchEvent", {"type": "touchMove", "touchPoints": pts})
        lat.append((time.perf_counter() - t0) * 1000.0)
        if pace_ms:
            page.wait_for_timeout(pace_ms)
    page.wait_for_timeout(40)
    stats = page.evaluate("() => window.__bench")
    drag_ms = (time.perf_counter() - t_start) * 1000.0
    client.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
    return lat, stats, drag_ms


def measured_drag(page, ctx, touch, horizon):
    """Reset to frame 0, run the fixed 30-step LEFT drag, return the measured record."""
    goto_horizon(page, horizon)
    # Known start: Home -> frame 0, then wait out the 320 ms tape glide.
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_timeout(500)
    g = read_geometry(page)
    # Warm-up (throwaway, not measured): JIT + a few cache entries so the measured drag
    # is not dominated by the first cold fetch/encode.
    if touch:
        drag_touch(ctx, page, g["cx"], g["y"])
    else:
        drag_mouse(page, g["cx"], g["y"])
    page.wait_for_timeout(300)
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_timeout(500)
    start_idx = int(page.get_attribute("#track", "aria-valuenow"))
    n, pxf = g["n"], g["tape"] / g["n"]

    page.evaluate("() => window.__benchReset()")
    if touch:
        lat, stats, drag_ms = drag_touch(ctx, page, g["cx"], g["y"])
        if not page.evaluate("() => window.__bench.touched"):
            raise RuntimeError("CDP touchStart did not reach the page (no touchstart)")
    else:
        lat, stats, drag_ms = drag_mouse(page, g["cx"], g["y"])
    page.wait_for_timeout(400)
    after = page.evaluate(
        "() => ({ idx: parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10),"
        " pill: document.getElementById('time-pill').textContent,"
        " hour: document.body.dataset.hour })")

    moves = stats["moves"]
    if moves <= 0:
        raise RuntimeError("drag delivered 0 pointermove events")
    dx = (stats["lastX"] - stats["downX"]) if stats["lastX"] is not None else 0.0
    expected = max(0, min(n - 1, js_round(start_idx - dx / pxf)))
    longtasks = stats["longtasks"]
    return {
        "horizon": horizon,
        "moves": moves, "downX": stats["downX"], "lastX": stats["lastX"],
        "dx": round(dx, 1), "dragMs": round(drag_ms, 1),
        "startIdx": start_idx, "expectedIdx": expected,
        "finalIdx": after["idx"], "finalPill": after["pill"],
        "finalHour": after["hour"],
        "swaps": stats["srcSwaps"], "blobCreated": stats["created"],
        "blobSrcWrites": stats["blobSrc"], "imgSrcWrites": stats["imgSrc"],
        "mapPaints": stats["paints"], "tapeTx": stats["tapeTx"],
        "frameMs": stats["frameMs"],
        "longtasks": longtasks, "longMax": max(longtasks) if longtasks else 0,
        "latencies": [round(x, 1) for x in lat],
        "latency": {
            "median": round(statistics.median(lat), 2) if lat else 0.0,
            "p90": round(pct(lat, 90), 2),
            "max": round(max(lat), 2) if lat else 0.0,
        },
    }


def run_case(pw, url, width, height, dsf, label, touch=False):
    case = {"label": label, "viewport": "%dx%d@%d" % (width, height, dsf),
            "mode": "cdp-touch" if touch else "mouse", "available": False, "error": None}
    browser = pw.chromium.launch()
    ctx = None
    try:
        ctx = browser.new_context(viewport={"width": width, "height": height},
                                  device_scale_factor=dsf, has_touch=touch)
        ctx.add_init_script(INIT_SCRIPT)
        page = ctx.new_page()
        page.goto(url, wait_until="domcontentloaded")
        page.wait_for_function(OVERLAY_OK, timeout=90000)

        case["horizons"] = {
            "48h": measure_horizon(page, "48h"),
            "15d": measure_horizon(page, "15d"),
        }

        inst = page.evaluate(
            "() => ({ tx: window.__bench.txInst, src: window.__bench.srcInst,"
            " long: window.__bench.longInst, paint: window.__bench.paintInst })")
        case["instruments"] = inst

        case["drags"] = {}
        for hz in ("48h", "15d"):
            case["drags"][hz] = measured_drag(page, ctx, touch, hz)
        case["drag"] = case["drags"]["48h"]
        case["drag15d"] = case["drags"]["15d"]
        case["available"] = True
    except Exception as exc:  # noqa: BLE001 - bench records, never aborts
        case["available"] = False
        case["error"] = "%s: %s" % (type(exc).__name__, exc)
    finally:
        if ctx:
            ctx.close()
        browser.close()
    return case


def _drag_checks(tag, d):
    lat = d["latency"]
    ratio = (lat["max"] / lat["median"]) if lat["median"] else 0.0
    return [
        ("%s_index_exact" % tag, d["finalIdx"] == d["expectedIdx"],
         "idx=%d expected=%d" % (d["finalIdx"], d["expectedIdx"])),
        # Absolute budgets: the modal step is ~one input frame. (max/median is reported,
        # but the ratio alone is pathological when the median drops to the input floor.)
        ("%s_median<=25ms" % tag, lat["median"] <= 25,
         "median=%.2f p90=%.2f max=%.2f max/median=%.2f"
         % (lat["median"], lat["p90"], lat["max"], ratio)),
        ("%s_max<=100ms" % tag, lat["max"] <= 100,
         "max=%.2f median=%.2f" % (lat["max"], lat["median"])),
    ]


def verdict(case):
    if not case.get("available"):
        return [("unavailable", False, case.get("error") or "not driven")]
    d = case["drag"]
    h48 = (case.get("horizons") or {}).get("48h") or {}
    ins = case.get("instruments") or {}
    checks = [
        ("instruments", all(ins.values()), "tx/src/long/paint=%s" % ins),
        ("runway_48h>=150", h48.get("runway", -1) >= 150, "runway=%s" % h48.get("runway")),
        ("swaps<=12", d["swaps"] <= 12, "swaps=%d" % d["swaps"]),
        # 6.3: bar is the drag-step count (moves - 1) — the mouse driver's pre-down
        # positioning move emits no transform write, and the suspension design keeps
        # fast drags at 0 mid-drag encodes. Real tape starvation still fails loudly.
        ("tapeTx>=moves-1", d["tapeTx"] >= d["moves"] - 1,
         "tx=%d moves=%d" % (d["tapeTx"], d["moves"])),
        ("long<=50", d["longMax"] <= 50, "longtasks=%s" % d["longtasks"]),
    ]
    checks += _drag_checks("48h", d)
    checks += _drag_checks("15d", case["drag15d"])
    return checks


def print_table(cases):
    print("")
    print("SCRUB BENCH")
    print("-" * 108)
    print("%-14s %-16s %-9s %8s %8s %8s %9s %8s %8s %10s"
          % ("label", "viewport", "mode", "px/day48", "p50_48h", "p90_48h",
             "p50_15d", "p90_15d", "swaps", "tx/moves"))
    for c in cases:
        h48 = (c.get("horizons") or {}).get("48h") or {}
        d = c.get("drag") or {}
        d15 = c.get("drag15d") or {}
        l48 = d.get("latency") or {}
        l15 = d15.get("latency") or {}
        print("%-14s %-16s %-9s %8s %8s %8s %9s %8s %8s %10s"
              % (c["label"], c["viewport"], c["mode"],
                 h48.get("px_per_day", "-"),
                 l48.get("median", "-"), l48.get("p90", "-"),
                 l15.get("median", "-"), l15.get("p90", "-"),
                 d.get("swaps", "-"),
                 ("%d/%d" % (d.get("tapeTx", 0), d.get("moves", 0))) if d else "-"))
    print("")
    n_pass = n_total = 0
    for c in cases:
        for name, ok, detail in verdict(c):
            n_total += 1
            n_pass += 1 if ok else 0
            print("%s %-18s %-16s %s"
                  % ("PASS" if ok else "FAIL", name, c["label"] + "/" + c["mode"], detail))
    print("-" * 108)
    print("VERDICT: %d/%d PASS" % (n_pass, n_total))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default=None,
                    help="page URL; if omitted the repo root is served locally")
    ap.add_argument("--label", default="bench")
    ap.add_argument("--out", default=str(ROOT / "tmp" / "scrub-bench"))
    args = ap.parse_args()

    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)

    srv = None
    url = args.url
    if not url:
        port = free_port()
        srv = serve(port, ROOT)
        url = "http://127.0.0.1:%d/index.html" % port
        if not wait_http(url):
            print("local server did not start")
            srv.terminate()
            return 0

    result = {"label": args.label, "url": url,
              "generated": datetime.now().astimezone().isoformat(), "cases": []}
    try:
        with sync_playwright() as pw:
            for width, height, dsf, touch in ((390, 844, 2, False),
                                              (360, 800, 2, False),
                                              (360, 800, 2, True)):
                try:
                    case = run_case(pw, url, width, height, dsf, args.label, touch)
                except Exception as exc:  # noqa: BLE001
                    case = {"label": args.label, "viewport": "%dx%d@%d" % (width, height, dsf),
                            "mode": "cdp-touch" if touch else "mouse",
                            "available": False, "error": "%s: %s" % (type(exc).__name__, exc)}
                if touch and not case.get("available"):
                    print("touch row unavailable: %s" % case.get("error"))
                result["cases"].append(case)
    finally:
        if srv:
            srv.terminate()

    print_table(result["cases"])

    # DONE-WHEN summary: p50/p90 of the pointermove latency, pooled per horizon.
    for hz in ("48h", "15d"):
        vals = [x for c in result["cases"] if c.get("available")
                for x in (c["drags"][hz]["latencies"] if c.get("drags") else [])]
        if vals:
            print("SCRUB %s: p50=%.2f p90=%.2f (n=%d)"
                  % (hz, statistics.median(vals), pct(vals, 90), len(vals)))

    (out / (args.label + ".json")).write_text(json.dumps(result, indent=2))
    print("=== JSON BEGIN ===")
    print(json.dumps(result, indent=2))
    print("=== JSON END ===")
    print("saved: %s" % (out / (args.label + ".json")))
    return 0


if __name__ == "__main__":
    sys.exit(main())
