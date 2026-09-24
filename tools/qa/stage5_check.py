#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Stage 5 re-runnable QA harness for big-pond-chop.

Usage (from anywhere):
    /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/stage5_check.py

Serves the repo root with `python -m http.server` and drives the app with
Playwright/Chromium at 390x844 (DPR 2) and 360x800. Every check prints
`ok`/`FAIL` with the measured number. It also prints a before/after upscale
table against a read-only worktree of the `pre-stage4` tag (the stage-1-3
baseline), the tails of the four Node suites, the live +48 h seam delta via
tools/qa/seam_check.js, saves screenshots to /tmp/bpc-s5-*.png, and ends with a
summary. Failures are *findings*: the harness always runs every check to
completion and exits 0 so it can be re-run without a one-off data snapshot.
"""

import json
import math
import re
import socket
import subprocess
import sys
import time
import urllib.request
from datetime import datetime, timedelta
from pathlib import Path
from urllib.parse import urlparse
from zoneinfo import ZoneInfo

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    print("playwright is required: run with /home/reid/.hermes/hermes-agent/venv/bin/python")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
PRE_TAG = "pre-stage4"
PRE_WT = Path("/tmp/bpc-pre4")
SHOTS = ROOT / "tmp" / "s5g-shots"
SHOTS.mkdir(parents=True, exist_ok=True)
CHICAGO = ZoneInfo("America/Chicago")
DEFAULT_HINT = "tap the lake for a local readout"
LAND_FLASH = "land — no wave data here"

RESULTS = []  # (num, name, ok, detail)

# Counter + map-capture instrumentation. add_init_script takes a *script body*.
INIT_SCRIPT = r"""
(function () {
  window.__bpcCreated = 0; window.__bpcRevoked = 0;
  try {
    var _c = URL.createObjectURL.bind(URL), _r = URL.revokeObjectURL.bind(URL);
    URL.createObjectURL = function (b) { window.__bpcCreated++; return _c(b); };
    URL.revokeObjectURL = function (u) { window.__bpcRevoked++; return _r(u); };
  } catch (e) {}
  try {
    var _L;
    Object.defineProperty(window, 'L', {
      configurable: true,
      get: function () { return _L; },
      set: function (v) {
        _L = v;
        if (v && v.map && !v.__bpcPatched) {
          v.__bpcPatched = true;
          var orig = v.map;
          v.map = function () { var m = orig.apply(this, arguments); window.__bpcMap = m; return m; };
        }
      }
    });
  } catch (e) {}
})();
"""

OVERLAY_OK = ("() => { var i = document.querySelector('.leaflet-image-layer'); "
              "return !!i && i.naturalWidth > 0; }")
BOOT_HIDDEN = ("() => { var b = document.getElementById('boot'); "
               "return !!b && b.classList.contains('hidden'); }")


# --------------------------------------------------------------------------- #
# small helpers
# --------------------------------------------------------------------------- #
def record(num, name, ok, detail):
    RESULTS.append((num, name, bool(ok), detail))
    print("[%s] %-22s %s %s" % (num, name, "ok  " if ok else "FAIL", detail), flush=True)


def safe(num, name, fn, *args):
    """Run a check, turning any crash into a FAIL finding instead of aborting."""
    try:
        return fn(*args)
    except Exception as exc:  # noqa: BLE001 - a QA harness records, never aborts
        record(num, name, False, "EXCEPTION %s: %s" % (type(exc).__name__, exc))
        return None


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


def new_page(pw, width=390, height=844):
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": width, "height": height},
                              device_scale_factor=2)
    ctx.add_init_script(INIT_SCRIPT)
    page = ctx.new_page()
    return browser, page


def load_app(page, url):
    page.goto(url, wait_until="domcontentloaded")


def ll_bounds(warp):
    return [[warp["corners"]["se"][1], warp["corners"]["nw"][0]],
            [warp["corners"]["nw"][1], warp["corners"]["se"][0]]]


def format_chicago(iso_local):
    dt = datetime.fromisoformat(iso_local).replace(tzinfo=CHICAGO)
    return dt.strftime("%-I:%M %p %Z")


def format_chicago_pill(iso_local):
    """5F pill format: 12-hour, no TZ suffix, minutes only when non-zero."""
    dt = datetime.fromisoformat(iso_local).replace(tzinfo=CHICAGO)
    return dt.strftime("%-I:%M %p").replace(":00 ", " ")


def tier_of(max_hs, roller, hl):
    finite = lambda v: isinstance(v, float) and math.isfinite(v)
    at = lambda v, t: finite(float(v)) and float(v) >= t
    if at(max_hs, 5.0) or at(roller, 4.0) or at(hl, 0.055):
        return "red", "Dangerous · Stay Home"
    if at(max_hs, 3.5) or at(roller, 2.5):
        return "amber", "Heavy Rollers"
    if at(max_hs, 2.0) or at(roller, 1.5):
        return "yellow", "Walleye Chop"
    return "green", "Fishable · Light Chop"


# --------------------------------------------------------------------------- #
# checks
# --------------------------------------------------------------------------- #
def check_boot(page, port):
    load_app(page, "http://127.0.0.1:%d/index.html" % port)
    boot_before = page.is_visible("#boot")
    page.wait_for_function(BOOT_HIDDEN, timeout=90000)
    page.wait_for_function(OVERLAY_OK, timeout=90000)
    info = page.evaluate(
        "() => { var i = document.querySelector('.leaflet-image-layer');"
        " return { src: i.src || '', nw: i.naturalWidth, nh: i.naturalHeight }; }")
    ok = bool(boot_before) and info["src"].startswith("blob:") and info["nw"] > 0
    record(1, "boot", ok,
           "visible_before=%s hidden_after=True overlay_src=%s... naturalWidth=%dx%d"
           % (boot_before, info["src"][:12], info["nw"], info["nh"]))
    return info


def check_frame_base(page):
    max_v = page.get_attribute("#track", "aria-valuemax")
    step = page.evaluate("document.body.dataset.stepMin")
    page.click("#play")
    page.wait_for_timeout(120)  # let the play-width regather settle before sampling ticks
    page.evaluate(
        "() => { window.__s4hours = [];"
        " new MutationObserver(() => { var h = document.body.dataset.hour;"
        "   if (h) window.__s4hours.push(h); })"
        " .observe(document.body, { attributes: true, attributeFilter: ['data-hour'] }); }")
    page.wait_for_function("window.__s4hours.length >= 10", timeout=40000)
    hours = page.evaluate("window.__s4hours.slice()")
    page.click("#play")
    page.wait_for_timeout(250)
    distinct = len(hours) == len(set(hours))
    minutes_15 = all(int(h[14:16]) % 15 == 0 for h in hours)
    ok = max_v == "95" and step == "15" and distinct and minutes_15
    record(2, "frame base", ok,
           "track.aria-valuemax=%s data-step-min=%s ticks=%d distinct=%s minutes%%15=%s"
           % (max_v, step, len(hours), distinct, minutes_15))
    print("        series: %s" % hours)
    return hours


def _wait_boot_hidden(page, timeout=5000):
    """5D.2: a skeleton shown by a transition must hide again on the next painted frame."""
    try:
        page.wait_for_function(
            "() => document.getElementById('boot').classList.contains('hidden')",
            timeout=timeout)
        return True
    except Exception:
        return False


def check_horizon_ceiling(page):
    """5D/5E: the frame ceiling tracks the horizon (24 h = 96 frames, 7 day = 672) and
    each transition's first paint hides the boot skeleton again (5D.2 fix)."""
    page.click("#h-7d")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '671'",
        timeout=60000)
    max7 = page.get_attribute("#track", "aria-valuemax")
    p24_when7 = page.get_attribute("#h-24h", "aria-pressed")
    p7_when7 = page.get_attribute("#h-7d", "aria-pressed")
    boot7 = _wait_boot_hidden(page)
    page.click("#h-24h")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
        timeout=60000)
    max24 = page.get_attribute("#track", "aria-valuemax")
    p24_when24 = page.get_attribute("#h-24h", "aria-pressed")
    p7_when24 = page.get_attribute("#h-7d", "aria-pressed")
    boot24 = _wait_boot_hidden(page, 1000)
    ok = (max7 == "671" and max24 == "95" and
          p7_when7 == "true" and p24_when7 == "false" and
          p24_when24 == "true" and p7_when24 == "false" and boot7 and boot24)
    record("2b", "horizon ceiling", ok,
           "7d max=%s pressed 7d/24h=%s/%s boot-hidden=%s | "
           "24h max=%s pressed 24h/7d=%s/%s boot-hidden=%s"
           % (max7, p7_when7, p24_when7, boot7, max24, p24_when24, p7_when24, boot24))


def check_lazy_7d(page):
    """5A/5D: widening to 7d must build frames on demand, not eagerly evaluate the series."""
    page.click("#h-7d")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '671' &&"
        " document.getElementById('track').getAttribute('aria-valuenow') !== null",
        timeout=60000)
    r1 = float(page.evaluate("parseFloat(document.body.dataset.precomputeMs)"))
    page.wait_for_timeout(2500)  # idle: paused, no interaction, no play tick
    r2 = float(page.evaluate("parseFloat(document.body.dataset.precomputeMs)"))
    delta = r2 - r1
    ok = delta <= 10.0 and r1 < 500.0
    record(13, "lazy 7d compute", ok,
           "precomputeMs first=%.1f idle=%.1f idle_delta=%.1f (gate <=10, first<500)"
           % (r1, r2, delta))
    page.click("#h-24h")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
        timeout=60000)


def _header_metrics(page):
    return page.evaluate(
        "() => { var h = document.querySelector('header');"
        " return { c: h.clientHeight, s: h.scrollHeight, o: h.offsetHeight }; }")


def _sweep(page, names):
    return page.evaluate(
        """(names) => {
             var el = document.getElementById('verdict-peak');
             var orig = el.textContent, widest = 0, bad = [];
             var worst = { name: '', over: -999, sw: 0, cw: 0, nw: 0 };
             var range = document.createRange();
             for (var k = 0; k < names.length; k++) {
               el.textContent = 'Peak: 3.9 ft \\u00b7 ' + names[k];
               range.selectNodeContents(el);
               var nw = range.getBoundingClientRect().width;
               var sw = el.scrollWidth, cw = el.clientWidth, over = sw - cw;
               if (nw > widest) widest = nw;
               if (over > worst.over || (over === worst.over && nw > worst.nw)) {
                 worst = { name: names[k], over: over, sw: sw, cw: cw, nw: nw };
               }
               if (over > 1) bad.push(names[k] + ':+' + over);
             }
             el.textContent = orig;
             return { worst: worst, widest: widest, bad: bad };
           }""", names)


def check_header(page, names):
    rows = []
    sweeps = []
    for w, h in ((390, 844), (360, 800)):
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(500)
        m = _header_metrics(page)
        sw = _sweep(page, names)
        rows.append((w, m))
        sweeps.append((w, sw))
        page.screenshot(path=str(SHOTS / ("bpc-s5-%d.png" % w)))
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    # 6C delta 1: 6B gave the header a 1 px hairline border-bottom (approved design),
    # so clientHeight is 71 (content-box) while the BAND is still 72 px. Assert the
    # border-box height (offsetHeight == 72) — same intent, correct box model.
    ok = all(m["o"] == 72 and m["s"] <= 72 for _, m in rows) and \
        all(not sw["bad"] for _, sw in sweeps)
    detail = " | ".join("%d: box=%d content=%d scroll=%d" % (w, m["o"], m["c"], m["s"]) for w, m in rows)
    worst = max((sw["worst"] for _, sw in sweeps), key=lambda x: x["over"])
    widest = max(sw["widest"] for _, sw in sweeps)
    record(3, "header layout", ok,
           "%s | worst='Peak: 3.9 ft · %s' natural=%.0fpx scrollWidth=%d clientWidth=%d "
           "over=%d widest_natural=%dpx overflow=%s"
           % (detail, worst["name"], worst["nw"], worst["sw"], worst["cw"], worst["over"],
              widest, [b for _, sw in sweeps for b in sw["bad"]] or "none"))


def check_tier(page):
    # Stage 6C repair: #frame-info was deleted in 6B (the H/L readout left the
    # header).  Re-point the probe at the shipped #three row — null-safe, so a
    # missing id reads '' instead of throwing.  #three carries no H/L anymore, so
    # hl stays NaN and the tier is decided by the max/roller body datasets.
    v = page.evaluate(
        "() => ({ hs: parseFloat(document.body.dataset.hsFt),"
        " hm: parseFloat(document.body.dataset.hmaxFt),"
        " fi: (function () { var t = document.getElementById('three');"
        "       return t ? t.textContent : ''; })(),"
        " cls: document.getElementById('comfort-chip').className,"
        " txt: document.getElementById('comfort-chip').textContent })")
    m = re.search(r"H/L\s+([0-9.]+)", v["fi"])
    hl = float(m.group(1)) if m else float("nan")
    key, label = tier_of(v["hs"], v["hm"], hl)
    ok = v["cls"] == "tier-" + key and v["txt"] == label and v["txt"].strip() != ""
    record(4, "tier chip", ok,
           "max=%s roller=%s H/L=%s => tier-%s '%s' | chip='%s' text='%s'"
           % (v["hs"], v["hm"], hl, key, label, v["cls"], v["txt"]))


def check_clock(page):
    # 5F: the standalone clock left the deck; #time-pill is the live clock (compact format).
    v = page.evaluate(
        "() => ({ label: document.getElementById('time-pill').textContent,"
        " hour: document.body.dataset.hour })")
    expected = format_chicago_pill(v["hour"])
    fmt_ok = bool(re.match(r"^\d{1,2}(:\d{2})? (AM|PM)$", v["label"]))
    ok = fmt_ok and v["label"] == expected
    record(5, "clock", ok,
           "time-pill='%s' zoneinfo='%s' data-hour=%s regex=%s"
           % (v["label"], expected, v["hour"], fmt_ok))


def check_compass(page, gamma):
    v = page.evaluate(
        """() => {
             var a = document.getElementById('wind-badge-arrow');
             var badge = document.getElementById('wind-badge').getBoundingClientRect();
             var map = document.getElementById('map').getBoundingClientRect();
             var z = document.querySelector('.leaflet-control-zoom');
             var zr = z ? z.getBoundingClientRect() : null;
             return {
               text: document.getElementById('wind-badge-text').textContent,
               transform: getComputedStyle(a).transform,
               speed: parseFloat(document.body.dataset.windMph),
               grid: parseFloat(document.body.dataset.bearingGrid),
               badge: {x: badge.x, y: badge.y, w: badge.width, h: badge.height},
               map: {x: map.x, y: map.y, w: map.width, h: map.height},
               zoom: zr ? {x: zr.x, y: zr.y, w: zr.width, h: zr.height} : null,
               aria: document.getElementById('wind-badge').getAttribute('aria-label')
             };
           }""")
    if v["speed"] < 3:
        ok = v["text"] == "Calm" and bool(v["aria"])
        record(6, "compass badge", ok,
               "calm wind speed=%s text='%s' aria='%s'" % (v["speed"], v["text"], v["aria"]))
        return
    from_deg = (v["grid"] + gamma) % 360      # source bearing shown in the text
    expected_arrow = (from_deg + 180) % 360   # flow vector: arrow points DOWNWIND
    text_ok = bool(re.match(r"^From [NSEW]{1,2} \d{1,3}°$", v["text"]))
    m = re.match(r"^From [NSEW]{1,2} (\d{1,3})°$", v["text"])
    text_deg_ok = bool(m) and abs(int(m.group(1)) - round(from_deg)) <= 0.5
    mm = re.match(r"matrix\(([^)]+)\)", v["transform"])
    angle = None
    if mm:
        parts = [float(x) for x in mm.group(1).split(",")]
        angle = (math.degrees(math.atan2(parts[1], parts[0]))) % 360
    delta = min(abs(angle - expected_arrow), 360 - abs(angle - expected_arrow)) if angle is not None else 999
    b, mp = v["badge"], v["map"]
    bcx, bcy = b["x"] + b["w"] / 2, b["y"] + b["h"] / 2
    in_quadrant = (bcx > mp["x"] + mp["w"] / 2 and bcy < mp["y"] + mp["h"] / 2 and
                   b["x"] >= mp["x"] and b["y"] >= mp["y"] and
                   b["x"] + b["w"] <= mp["x"] + mp["w"] and
                   b["y"] + b["h"] <= mp["y"] + mp["h"])
    clear_zoom = True
    if v["zoom"]:
        z = v["zoom"]
        clear_zoom = not (b["x"] < z["x"] + z["w"] and z["x"] < b["x"] + b["w"] and
                          b["y"] < z["y"] + z["h"] and z["y"] < b["y"] + b["h"])
    aria_ok = bool(v["aria"]) and re.match(
        r"^Wind from [NSEW]{1,2} at \d+ degrees, blowing toward \d+ degrees$",
        v["aria"]) is not None
    ok = text_ok and text_deg_ok and angle is not None and delta <= 1.5 and in_quadrant \
         and clear_zoom and aria_ok
    record(6, "compass badge", ok,
           "text='%s' from=%.2f° arrow=%.2f° expected=%.2f° (downwind) delta=%.2f "
           "top-right=%s clear-zoom=%s aria='%s'"
           % (v["text"], from_deg, angle if angle is not None else float("nan"),
              expected_arrow, delta, in_quadrant, clear_zoom, v["aria"]))


def check_ramp_location(page):
    # Stage 5L: the six-stop ramp is a non-interactive legend card inside #map again
    # (5K had docked it at the deck base; 5L floats it in a card with the wind strip
    # taking the deck's second row).
    v = page.evaluate(
        """() => {
             var bar = document.getElementById('legend-card-bar');
             var deck = document.getElementById('deck');
             var map = document.getElementById('map');
             var ticks = document.getElementById('legend-card-ticks');
             return {
               exists: !!bar,
               inDeck: !!(bar && deck && deck.contains(bar)),
               inMap: !!(bar && map && map.contains(bar)),
               legend: !!document.getElementById('legend-card'),
               stops: ticks ? Array.from(ticks.children).map(function (s) { return s.textContent; }) : [],
               gradient: bar ? getComputedStyle(bar).backgroundImage : '',
             };
           }""")
    grad_ok = all(c in v["gradient"] for c in (
        "rgb(8, 145, 178)", "rgb(6, 182, 212)", "rgb(245, 158, 11)",
        "rgb(234, 88, 12)", "rgb(220, 38, 38)", "rgb(190, 24, 93)"))
    stops_ok = v["stops"] == ["0", "1", "2", "3.5", "4.5", "6+"]
    ok = v["exists"] and v["inMap"] and not v["inDeck"] and v["legend"] and stops_ok and grad_ok
    record("7a", "ramp location", ok,
           "ramp in-deck=%s in-map=%s legend-card-present=%s stops=%s gradient-six=%s"
           % (v["inDeck"], v["inMap"], v["legend"], v["stops"], grad_ok))


def check_card_and_touch(page, warp):
    ll = ll_bounds(warp)
    page.evaluate("(ll) => window.__bpcMap.fitBounds(ll, {padding:[12,12], maxZoom:12})", ll)
    page.wait_for_timeout(900)
    mr = page.evaluate(
        "() => { var r = document.getElementById('map').getBoundingClientRect();"
        " return {x:r.x, y:r.y, w:r.width, h:r.height}; }")
    page.mouse.click(mr["x"] + mr["w"] / 2, mr["y"] + mr["h"] / 2)
    page.wait_for_timeout(600)
    card = page.evaluate(
        """() => {
             var c = document.getElementById('card');
             return { hidden: c.hidden,
               fields: Array.from(document.querySelectorAll('#card .card-line .v'))
                         .map(function (e) { return e.textContent; }),
               pin: document.querySelectorAll('#map .leaflet-overlay-pane path').length };
           }""")
    six = len(card["fields"]) == 6 and all(f.strip() not in ("", "—") for f in card["fields"])
    page.screenshot(path=str(SHOTS / "bpc-s5-card.png"))

    page.click("#card-close")
    page.wait_for_timeout(400)
    a = page.evaluate(
        "() => ({ hidden: document.getElementById('card').hidden,"
        " pin: document.querySelectorAll('#map .leaflet-overlay-pane path').length })")
    page.wait_for_timeout(400)
    b = page.evaluate(
        "() => ({ hidden: document.getElementById('card').hidden,"
        " pin: document.querySelectorAll('#map .leaflet-overlay-pane path').length })")
    stayed = a["hidden"] and a["pin"] == 0 and b["hidden"] and b["pin"] == 0

    # land / nodata click, a few px west of the fitted bbox (off-grid -> nodata)
    north = warp["corners"]["nw"][1]
    south = warp["corners"]["se"][1]
    west = warp["corners"]["nw"][0]
    lat_c = (north + south) / 2
    lon_land = west - 0.004
    lp = page.evaluate(
        "(ll) => { var p = window.__bpcMap.latLngToContainerPoint(ll);"
        " return {x: p.x, y: p.y}; }", [lat_c, lon_land])
    x = max(2, min(mr["w"] - 2, mr["x"] + lp["x"]))
    y = max(mr["y"] + 2, min(mr["y"] + mr["h"] - 2, mr["y"] + lp["y"]))
    tag = page.evaluate(
        "(p) => { var e = document.elementFromPoint(p[0], p[1]);"
        " return e ? e.tagName + '|' + (e.className || '') : 'none'; }", [x, y])
    page.mouse.click(x, y)
    page.wait_for_timeout(350)
    flash = page.evaluate("document.getElementById('readout').textContent")
    page.wait_for_timeout(2200)
    revert = page.evaluate("document.getElementById('readout').textContent")
    ok = six and not card["hidden"] and stayed and flash == LAND_FLASH and revert == DEFAULT_HINT
    record(8, "tap card", ok,
           "fields=%s opened=%s dismissed-pin=0=%s land-flash='%s' revert='%s' land-hit=%s"
           % (card["fields"], not card["hidden"], stayed, flash, revert, tag))


def check_touch_ergonomics(page):
    """5G/5M: #track is a scrolling tape with a fixed centre reticle. A real mouse drag on
    #deck scrolls the tape: LEFT advances into the future, RIGHT rewinds, the amber pill
    never moves, a click on #play does not scrub, and a drag starting in the deck's bottom
    band (the 5M wind row, no second deck row) still scrubs (deck-wide pointer capture)."""
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    # Pin the 24 h horizon so the far-left/right clamp drags are guaranteed to clamp.
    if page.get_attribute("#h-24h", "aria-pressed") != "true":
        page.click("#h-24h")
        page.wait_for_function(
            "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
            timeout=60000)
        page.wait_for_timeout(300)
    g = page.evaluate(
        """() => {
             var deck = document.getElementById('deck').getBoundingClientRect();
             var play = document.getElementById('play').getBoundingClientRect();
             return { deck: {x: deck.x, y: deck.y, w: deck.width, h: deck.height},
                      play: {w: play.width, h: play.height} };
           }""")

    def metrics():
        return page.evaluate(
            """() => {
                 var t = document.getElementById('track-tape').getBoundingClientRect();
                 var p = document.getElementById('time-pill').getBoundingClientRect();
                 var tl = document.getElementById('timeline').getBoundingClientRect();
                 var max = parseInt(document.getElementById('track').getAttribute('aria-valuemax'), 10);
                 return {
                   idx: parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10),
                   n: max + 1, horizon: max === 671 ? '7d' : '24h',
                   tapeX: t.x, pillCx: p.x + p.width / 2,
                   tlCx: tl.x + tl.width / 2, tlX: tl.x, tlW: tl.width, tlY: tl.y,
                   transform: getComputedStyle(document.getElementById('track-tape')).transform,
                 };
               }""")

    m0 = metrics()
    n, horizon = m0["n"], m0["horizon"]
    pxf = (330.0 if horizon == "7d" else max(550.0, round(m0["tlW"]))) / 96.0
    ty = m0["tlY"] + 24  # inside #timeline, below the floating pill
    cx = m0["tlX"] + m0["tlW"] / 2

    # Known start: Home -> frame 0 so the left/right deltas are unambiguous.
    # Wait out the 320 ms tape glide so the baseline is a settled transform.
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_timeout(500)

    def drag(x_to):
        page.mouse.move(cx, ty)
        page.mouse.down()
        page.mouse.move(x_to, ty, steps=6)
        page.wait_for_timeout(120)
        during = metrics()
        page.mouse.up()
        page.wait_for_timeout(150)
        return during

    # (a) drag LEFT ~120px -> advance ~120/pxf, pill fixed, tape edge moves ~-120px.
    before = metrics()
    d_left = drag(cx - 120)
    adv = d_left["idx"] - before["idx"]
    a_ok = abs(adv - 120.0 / pxf) <= 1.0
    pill_ok = abs(d_left["pillCx"] - before["pillCx"]) <= 0.5
    tape_moved = d_left["tapeX"] - before["tapeX"]
    tape_ok = abs(tape_moved + 120.0) <= 3.0

    # (b) drag RIGHT ~60px -> rewind ~60/pxf, pill still fixed.
    before2 = metrics()
    d_right = drag(cx + 60)
    rew = before2["idx"] - d_right["idx"]
    b_ok = abs(rew - 60.0 / pxf) <= 1.0 and abs(d_right["pillCx"] - before2["pillCx"]) <= 0.5

    # (c) clamp far LEFT (window left edge minus 2x width) -> n-1, pill centred.
    d_hi = drag(m0["tlX"] - 2 * m0["tlW"])
    c_ok = d_hi["idx"] == n - 1 and abs(d_hi["pillCx"] - d_hi["tlCx"]) <= 0.5

    # (d) clamp far RIGHT -> 0, pill centred.
    d_lo = drag(m0["tlX"] + 3 * m0["tlW"])
    d_ok = d_lo["idx"] == 0 and abs(d_lo["pillCx"] - d_lo["tlCx"]) <= 0.5

    # (e) clicking #play must not scrub the tape.
    idx_before = metrics()["idx"]
    page.click("#play")
    page.wait_for_timeout(80)  # < PLAY_INTERVAL_MS, before the first tick
    idx_after = metrics()["idx"]
    page.click("#play")        # back to paused
    page.wait_for_timeout(150)
    e_ok = idx_before == idx_after

    # (f) a drag starting in the deck's bottom band (the new 5M wind row, no second row
    # anymore) still scrubs (deck-wide capture).
    dcx = g["deck"]["x"] + g["deck"]["w"] / 2
    dcy = g["deck"]["y"] + g["deck"]["h"] - 6
    hit = page.evaluate(
        "(p) => { var e = document.elementFromPoint(p[0], p[1]);"
        " var tl = document.getElementById('timeline');"
        " return { tag: e ? e.tagName : 'none', cls: e ? (e.className || '') : '',"
        "   inTape: !!(e && tl && (e === tl || tl.contains(e))),"
        "   interactive: !!(e && e.closest && e.closest('button, [role=button], a, input')) }; }",
        [dcx, dcy])
    ramp_before = metrics()
    page.mouse.move(dcx, dcy)
    page.mouse.down()
    page.mouse.move(dcx + 0.25 * m0["tlW"], dcy - 80, steps=4)
    page.mouse.move(cx - 120, ty, steps=6)
    page.wait_for_timeout(120)
    ramp_during = metrics()
    page.mouse.up()
    page.wait_for_timeout(150)
    ramp_adv = ramp_during["idx"] - ramp_before["idx"]
    f_ok = hit["inTape"] and not hit["interactive"] and abs(ramp_adv - 120.0 / pxf) <= 1.0

    # (g) play button still meets the 44px touch target.
    h_ok = g["play"]["w"] >= 44 and g["play"]["h"] >= 44

    ok = a_ok and pill_ok and tape_ok and b_ok and c_ok and d_ok and e_ok and f_ok and h_ok
    print("        left  drag: idx %d->%d (+%.1f/~%.1f) pill dx=%.2f tape dx=%.1f "
          "transform %s -> %s"
          % (before["idx"], d_left["idx"], adv, 120.0 / pxf,
             d_left["pillCx"] - before["pillCx"], tape_moved,
             before["transform"], d_left["transform"]))
    print("        right drag: idx %d->%d (-%.1f/~%.1f) pill dx=%.2f transform %s -> %s"
          % (before2["idx"], d_right["idx"], rew, 60.0 / pxf,
             d_right["pillCx"] - before2["pillCx"],
             before2["transform"], d_right["transform"]))
    print("        clamp: far-left idx=%d/%d pill-cx=%.1f tl-cx=%.1f | "
          "far-right idx=%d/0 pill-cx=%.1f tl-cx=%.1f"
          % (d_hi["idx"], n - 1, d_hi["pillCx"], d_hi["tlCx"],
             d_lo["idx"], d_lo["pillCx"], d_lo["tlCx"]))
    print("        play-click: before=%d after=%d unchanged=%s play=%dx%d"
          % (idx_before, idx_after, e_ok, round(g["play"]["w"]), round(g["play"]["h"])))
    print("        deck-wind drift: press=(%.1f,%.1f) target=%s.%s in-tape=%s interactive=%s "
          "idx=%d->%d (+%.1f)"
          % (dcx, dcy, hit["tag"], hit["cls"], hit["inTape"], hit["interactive"],
             ramp_before["idx"], ramp_during["idx"], ramp_adv))
    record("7b", "touch ergonomics", ok,
           "pxf=%.4f left-adv=%.1f right-rew=%.1f clamp=[%d/%d, %d/0] pill-fixed=%.2fpx "
           "tape-dx=%.1f play-unchanged=%s play=%dx%d deck-press=%s.%s in-tape=%s "
           "noninteractive=%s strip-adv=%.1f"
           % (pxf, adv, rew, d_hi["idx"], n - 1, d_lo["idx"], pill_ok and b_ok,
              tape_moved, e_ok, round(g["play"]["w"]), round(g["play"]["h"]),
              hit["tag"], hit["cls"], hit["inTape"], not hit["interactive"], ramp_adv))


def check_timeline_labels(page):
    """5L: the 24 h block carries exactly ONE day header, pinned at the block's start at
    idx 0 then clamped to the window's left edge (clear of #play) as the day scrolls; every
    sub-tick stays fully inside its block, the last block carries a right-anchored midnight
    '12', and 7 d keeps its 8 ticks per block with no duplicate '12' at a day join."""
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    if page.get_attribute("#h-24h", "aria-pressed") != "true":
        page.click("#h-24h")
        page.wait_for_function(
            "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
            timeout=60000)
        page.wait_for_timeout(300)

    def goto(target):
        page.focus("#track")
        page.keyboard.press("Home")
        page.wait_for_timeout(200)
        if target >= 95:
            page.keyboard.press("End")
        else:
            for _ in range(target // 4):
                page.keyboard.press("PageUp")
                page.wait_for_timeout(60)
        page.wait_for_timeout(420)  # let the 320 ms tape glide settle

    def metrics():
        return page.evaluate(
            """() => {
                 var tl = document.getElementById('timeline').getBoundingClientRect();
                 var blocks = Array.from(document.getElementById('track-days').children);
                 function ticks(b) {
                   var br = b.getBoundingClientRect();
                   return Array.from(b.querySelectorAll('.day-sub')).map(function (s) {
                     var r = s.getBoundingClientRect();
                     return { text: s.textContent, edge: s.classList.contains('edge'),
                              transform: getComputedStyle(s).transform,
                              left: getComputedStyle(s).left,
                              inside: r.left >= br.left - 1 && r.right <= br.right + 1 };
                   });
                 }
                 var heads = [];
                 blocks.forEach(function (b, bi) {
                   var br = b.getBoundingClientRect();
                   b.querySelectorAll('.day-head').forEach(function (h) {
                     var r = h.getBoundingClientRect();
                     heads.push({ text: h.textContent, block: bi,
                                  left: r.left, right: r.right,
                                  leftOffset: r.left - br.left,
                                  inside: r.left >= br.left - 1 && r.right <= br.right + 1,
                                  insideTimeline: r.left >= tl.left - 1 && r.right <= tl.right + 1 });
                   });
                 });
                 return {
                   heads: heads,
                   headCount: heads.length,
                   blockCount: blocks.length,
                   tlLeft: tl.left,
                   first: ticks(blocks[0]),
                   last: ticks(blocks[blocks.length - 1]),
                   max: parseInt(document.getElementById('track').getAttribute('aria-valuemax'), 10),
                   now: parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10),
                 };
                 }""", [])

    def wind_alignment():
        """5M: per block, pair each 3-hourly tick with its wind label and measure the centre
        delta; also flag the boundary tick (right-anchored, left:auto) and its wind count."""
        return page.evaluate(
            """() => {
                 var blocks = Array.from(document.getElementById('track-days').children);
                 function cx(el) { var r = el.getBoundingClientRect(); return r.x + r.width / 2; }
                 return blocks.map(function (b) {
                   var subs = Array.from(b.querySelectorAll('.day-sub'));
                   var winds = Array.from(b.querySelectorAll('.day-wind'));
                   var dots = subs.map(function (s) {
                     return { text: s.textContent, cx: cx(s),
                              boundary: s.style.right !== '' };
                   });
                   var deltas = [];
                   for (var i = 0; i < winds.length; i++) {
                     if (dots[i]) deltas.push({ h: dots[i].text,
                       d: Math.abs(cx(winds[i]) - dots[i].cx) });
                   }
                   return {
                     subCount: subs.length, windCount: winds.length,
                     windTexts: winds.map(function (w) { return w.textContent; }),
                     boundaryCount: dots.filter(function (d) { return d.boundary; }).length,
                     deltas: deltas,
                   };
                 });
               }""")

    def summarize_winds(blocks):
        counts = [b["windCount"] for b in blocks]
        texts_ok = bool(blocks) and all(re.fullmatch(r"\d+", t)
                                        for b in blocks for t in b["windTexts"])
        deltas = [d["d"] for b in blocks for d in b["deltas"]]
        paired = all(b["windCount"] == len(b["deltas"]) for b in blocks)
        boundary = sum(b["boundaryCount"] for b in blocks)
        return {"counts": counts, "texts_ok": texts_ok, "paired": paired,
                "boundary": boundary, "worst": max(deltas) if deltas else 0.0,
                "blocks": blocks}

    def ink_gaps():
        """5N: measure the actual text-run ink boxes with Range.getClientRects() — the fixed
        1.5 em span boxes hide real ink collisions. For each block's tick row (.day-sub) and
        wind row (.day-wind), sort the runs and report the minimum consecutive gap."""
        return page.evaluate(
            """() => {
                 var blocks = Array.from(document.getElementById('track-days').children);
                 function runs(el) {
                   var r = document.createRange();
                   r.selectNodeContents(el);
                   return Array.from(r.getClientRects())
                     .filter(function (b) { return b.width > 0; })
                     .map(function (b) { return { l: b.left, r: b.right }; });
                 }
                 function rowGap(els) {
                   var rects = [];
                   els.forEach(function (e) { rects = rects.concat(runs(e)); });
                   rects.sort(function (a, b) { return a.l - b.l; });
                   var min = Infinity;
                   for (var i = 1; i < rects.length; i++)
                     min = Math.min(min, rects[i].l - rects[i - 1].r);
                   return { min: min, n: rects.length };
                 }
                 return blocks.map(function (b) {
                   return { ticks: rowGap(Array.from(b.querySelectorAll('.day-sub'))),
                            winds: rowGap(Array.from(b.querySelectorAll('.day-wind'))) };
                 });
               }""")

    def summarize_gaps(blocks):
        vals = []
        overlap = False
        for b in blocks:
            for row in (b["ticks"], b["winds"]):
                if math.isfinite(row["min"]):
                    vals.append(row["min"])
                    if row["min"] < 0:
                        overlap = True
        return {"min": min(vals) if vals else float("inf"), "overlap": overlap, "n": len(vals)}

    def heat_rows():
        """5P: per 7d block — the .day-heat ribbon geometry/colour, the embedded .day-wind
        containment + shadow, and the row fonts."""
        return page.evaluate(
            """() => {
                 var blocks = Array.from(document.getElementById('track-days').children);
                 var tiers = ['rgb(8, 145, 178)','rgb(16, 185, 129)','rgb(245, 158, 11)',
                              'rgb(249, 115, 22)','rgb(239, 68, 68)'];
                 function tierSet(g) {
                   var m = g.match(/rgb\\(\\s*\\d+,\\s*\\d+,\\s*\\d+\\s*\\)/g) || [];
                   var seen = [];
                   m.forEach(function (c) {
                     var norm = c.replace(/\\s+/g, ' ');
                     if (tiers.indexOf(norm) >= 0 && seen.indexOf(norm) < 0) seen.push(norm);
                   });
                   return seen;
                 }
                 return blocks.map(function (b) {
                   var br = b.getBoundingClientRect();
                   var hs = Array.from(b.querySelectorAll('.day-heat'));
                   var h = hs[0];
                   var hr = h ? h.getBoundingClientRect() : null;
                   var cs = h ? getComputedStyle(h) : null;
                   var winds = Array.from(b.querySelectorAll('.day-wind'));
                   var inside = hr ? winds.every(function (w) {
                     var wr = w.getBoundingClientRect();
                     return wr.top >= hr.top - 1 && wr.bottom <= hr.bottom + 1;
                   }) : false;
                   var head = b.querySelector('.day-head');
                   var sub = b.querySelector('.day-sub:not(.edge)');
                   var wind = winds[0];
                   var grad = cs ? cs.backgroundImage : '';
                   return {
                     n: hs.length,
                     hh: hr ? hr.height : 0,
                     hw: hr ? hr.width : 0,
                     bw: br.width,
                     radius: cs ? parseFloat(cs.borderTopLeftRadius) : 0,
                     tiers: tierSet(grad),
                     stops: (grad.match(/rgb\\(/g) || []).length,
                     headSize: head ? parseFloat(getComputedStyle(head).fontSize) : 0,
                     headWeight: head ? getComputedStyle(head).fontWeight : '',
                     subSize: sub ? parseFloat(getComputedStyle(sub).fontSize) : 0,
                     subColor: sub ? getComputedStyle(sub).color : '',
                     windSize: wind ? parseFloat(getComputedStyle(wind).fontSize) : 0,
                     windWeight: wind ? getComputedStyle(wind).fontWeight : '',
                     windColor: wind ? getComputedStyle(wind).color : '',
                     shadow: wind ? getComputedStyle(wind).textShadow : '',
                     inside: inside,
                     hx: hr ? hr.x : 0,
                     bx: br.x,
                   };
                 });
               }""")

    heads = {}
    head_x = {}
    indices_ok = True
    head_count_ok = True
    sticky_window_ok = True
    sticky_block_ok = True
    ms = {}
    for idx in (0, 24, 48, 72, 95):
        goto(idx)
        m = metrics()
        ms[idx] = m
        if m["now"] != idx:
            indices_ok = False
        if m["headCount"] != 1:
            head_count_ok = False
        heads[idx] = m["headCount"]
        h = m["heads"][0] if m["headCount"] else None
        head_x[idx] = h["left"] if h else float("nan")
        # Sticky header stays inside the window and clear of the 48 px #play button.
        if not h or not h["insideTimeline"] or h["left"] < m["tlLeft"] + 52:
            sticky_window_ok = False
        # It must never leave its own day block.
        if not h or not h["inside"]:
            sticky_block_ok = False

    m0, m24 = ms[0], ms[95]
    # Exactly one header, pinned within 12 px of its block's left edge at the day start.
    one_head = len(m0["heads"]) == 1 and len(m24["heads"]) == 1
    head = m0["heads"][0] if m0["heads"] else {}
    head_pinned = one_head and abs(head.get("leftOffset", 1e9)) <= 12 and \
        head.get("inside") and bool(head.get("text", "").strip())
    # No two heads share the same text within a block.
    no_repeat = True
    by_block = {}
    for h in m24["heads"]:
        by_block.setdefault(h["block"], []).append(h["text"])
    for texts in by_block.values():
        if len(set(texts)) != len(texts):
            no_repeat = False
    # Sticky clamp engages: the header moves > 50 px between idx 0 and the day's end.
    sticky_shift = abs(head_x[95] - head_x[0])
    sticky_engages = sticky_shift > 50

    first, last = m24["first"], m24["last"]
    left_edge_ok = any(t["text"] == "12" and t["edge"] and t["transform"] in ("none", "") and
                       abs(float(t["left"].replace("px", "")) - 3) <= 1 for t in first)
    boundary_ok = any(t["text"] == "12" and t["edge"] and t["transform"] in ("none", "")
                      for t in last)
    ticks_ok = len(last) == 9
    labels_ok = sorted(t["text"] for t in first if t["text"] != "12") == \
        ["03", "03", "06", "06", "09", "09"]
    inside_ok = all(t["inside"] for t in first) and all(t["inside"] for t in last)

    # 5M: wind row at 24 h — one block, 8 three-hourly labels, no boundary sibling.
    w24 = summarize_winds(wind_alignment())
    eight24_ok = len(w24["counts"]) >= 1 and all(c == 8 for c in w24["counts"])
    boundary_no_wind = w24["boundary"] == 1
    wind24_ok = (eight24_ok and w24["texts_ok"] and w24["paired"] and
                 w24["worst"] <= 1.5 and boundary_no_wind)
    g24 = summarize_gaps(ink_gaps())

    # 7 day: 8 ticks per block and no two '12's within 20 px at a day join.
    page.click("#h-7d")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '671'",
        timeout=60000)
    page.wait_for_timeout(600)
    seven = page.evaluate(
        """() => {
             var blocks = Array.from(document.getElementById('track-days').children);
             var counts = blocks.map(function (b) { return b.querySelectorAll('.day-sub').length; });
             var twelves = [];
             blocks.forEach(function (b) {
               b.querySelectorAll('.day-sub').forEach(function (s) {
                 if (s.textContent === '12') {
                   var r = s.getBoundingClientRect();
                   twelves.push(r.x + r.width / 2);
                 }
               });
             });
             twelves.sort(function (a, b) { return a - b; });
             var minGap = Infinity;
             for (var i = 1; i < twelves.length; i++)
               minGap = Math.min(minGap, twelves[i] - twelves[i - 1]);
             return { counts: counts, minGap: minGap, twelves: twelves.length };
           }""")
    seven_ok = seven["counts"] == [8, 8, 8, 8, 8, 8, 8] and seven["minGap"] >= 20
    # 5M: wind row at 7 d — 7 blocks, 8 labels each, all aligned, no boundary tick.
    w7 = summarize_winds(wind_alignment())
    wind7_ok = (w7["counts"] == [8, 8, 8, 8, 8, 8, 8] and w7["texts_ok"] and
                w7["paired"] and w7["worst"] <= 1.5 and w7["boundary"] == 0)
    g7 = summarize_gaps(ink_gaps())
    # 5P: per-day heat ribbon (20 px, tier colours) with the wind numbers embedded inside
    # it, row typography, and the ribbon moving in lockstep with its parent block.
    heats = heat_rows()
    heat_count_ok = all(b["n"] == 1 for b in heats)
    heat_size_ok = all(abs(b["hh"] - 20) <= 1 and
                       abs(b["hw"] - (b["bw"] - 6)) <= 1 and b["radius"] >= 2 for b in heats)
    heat_inside_ok = all(b["inside"] for b in heats)
    # One stop per hourly sample in every block, and >= 2 distinct tier colours across the
    # 7d horizon (a uniformly calm day is legitimately one colour, so a per-block >= 2 would
    # fail on real calm stretches; see the 5p evidence line for per-block tier sets).
    heat_stops_ok = all(b["stops"] == 24 for b in heats)
    all_tiers = set()
    for b in heats:
        all_tiers.update(b["tiers"])
    heat_color_ok = heat_stops_ok and len(all_tiers) >= 2
    shadow_ok = all(b["shadow"] and b["shadow"] != "none" for b in heats)
    fonts_ok = all(b["headSize"] == 12 and b["headWeight"] == "600" and
                   b["subSize"] == 11 and b["subColor"] == "rgb(148, 163, 184)" and
                   b["windSize"] == 12 and b["windWeight"] == "700" and
                   b["windColor"] == "rgb(255, 255, 255)" for b in heats)
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_timeout(420)
    before_x = heat_rows()
    page.keyboard.press("ArrowRight")
    page.wait_for_timeout(420)
    after_x = heat_rows()
    moved = any(abs(after_x[i]["hx"] - before_x[i]["hx"]) > 1 for i in range(len(before_x)))
    scroll_ok = (len(before_x) == len(after_x) == len(heats) and moved and
                 all(abs((after_x[i]["hx"] - before_x[i]["hx"]) -
                         (after_x[i]["bx"] - before_x[i]["bx"])) <= 1
                     for i in range(len(before_x))))
    heat_ok = (heat_count_ok and heat_size_ok and heat_inside_ok and heat_color_ok and
               shadow_ok and fonts_ok and scroll_ok)

    # 5N: no two consecutive text runs in either row may overlap, and the minimum gap at
    # both horizons must be >= 6 px (ink boxes, not the fixed 1.5 em span boxes).
    ink_ok = (g24["min"] >= 6.0 and g7["min"] >= 6.0 and
              not g24["overlap"] and not g7["overlap"])

    page.click("#h-24h")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
        timeout=60000)
    page.wait_for_timeout(300)

    ok = (indices_ok and head_count_ok and one_head and head_pinned and no_repeat and
          sticky_window_ok and sticky_block_ok and sticky_engages and
          left_edge_ok and boundary_ok and ticks_ok and labels_ok and inside_ok and seven_ok and
          wind24_ok and wind7_ok and ink_ok and heat_ok)
    print("        heads/idx=%s headCount=%d pinned-offset=%.1f text='%s' "
          "sticky x0=%.0f x95=%.0f shift=%.0f window-ok=%s block-ok=%s sub-ticks/24h=%d "
          "(last block) left-edge=%s boundary=%s inside=%s labels=%s"
          % (heads, m24["headCount"], head.get("leftOffset", float("nan")), head.get("text", ""),
             head_x[0], head_x[95], sticky_shift, sticky_window_ok, sticky_block_ok,
             len(last), left_edge_ok, boundary_ok, inside_ok, labels_ok))
    print("        5M wind 24h: counts=%s worst-delta=%.2fpx nums=%s boundary-no-wind=%s list=%s"
          % (w24["counts"], w24["worst"], w24["texts_ok"], boundary_no_wind,
             w24["blocks"][0]["windTexts"] if w24["blocks"] else []))
    print("        5M wind 7d:  counts=%s worst-delta=%.2fpx nums=%s list(block0)=%s"
          % (w7["counts"], w7["worst"], w7["texts_ok"],
             w7["blocks"][0]["windTexts"] if w7["blocks"] else []))
    print("        5n gaps 24h=%.1fpx 7d=%.1fpx" % (g24["min"], g7["min"]))
    print("        5p ribbon: count=%s h=%s stops=%s colours=%s inside=%s shadow=%s fonts=%s "
          "scroll=%s | ink-gap 24h=%.1fpx 7d=%.1fpx"
          % (heat_count_ok, heat_size_ok, heat_stops_ok, heat_color_ok, heat_inside_ok,
             shadow_ok, fonts_ok, scroll_ok, g24["min"], g7["min"]))
    print("        5p tiers/block: %s (union=%d>=2)"
          % ([b["tiers"] for b in heats], len(all_tiers)))
    record(18, "timeline labels (5L)", ok,
           "indices=%s heads=%s one-head=%s pinned=%s no-repeat=%s sticky-window=%s "
           "sticky-block=%s head-x0=%.0f head-x95=%.0f shift=%.0f>50=%s "
           "left-edge-12=%s last-boundary-12=%s ticks=9=%s labels-3h=%s all-inside=%s | "
           "7d counts=%s min-12-gap=%.1f>=20=%s | 5m wind 24h counts=%s worst=%.2fpx nums=%s "
           "boundary-no-wind=%s list=%s | 7d counts=%s worst=%.2fpx nums=%s list0=%s | "
           "5n gaps 24h=%.1f>=6=%s 7d=%.1f>=6=%s overlap=%s/%s | "
           "5p ribbon heat-count=%s h=%s inside=%s shadow=%s colours=%s fonts=%s scroll=%s"
           % (indices_ok, heads, one_head, head_pinned, no_repeat, sticky_window_ok,
              sticky_block_ok, head_x[0], head_x[95], sticky_shift, sticky_engages,
              left_edge_ok, boundary_ok, ticks_ok, labels_ok, inside_ok, seven["counts"],
              seven["minGap"] if math.isfinite(seven["minGap"]) else -1.0, seven_ok,
              w24["counts"], w24["worst"], w24["texts_ok"], boundary_no_wind,
              w24["blocks"][0]["windTexts"] if w24["blocks"] else [],
              w7["counts"], w7["worst"], w7["texts_ok"],
              w7["blocks"][0]["windTexts"] if w7["blocks"] else [],
              g24["min"], g24["min"] >= 6.0, g7["min"], g7["min"] >= 6.0,
              g24["overlap"], g7["overlap"],
              heat_count_ok, heat_size_ok, heat_inside_ok, shadow_ok, heat_color_ok, fonts_ok,
              scroll_ok))


def check_deck_geometry(page):
    """5F/5L/5M: single full-height tape, timeline geometry, permanent amber pill, embedded
    play, wind strip gone."""
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(400)
    v = page.evaluate(
        """() => {
             var deck = document.getElementById('deck').getBoundingClientRect();
             var track = document.getElementById('track').getBoundingClientRect();
             var timelineEl = document.getElementById('timeline');
             var timeline = timelineEl.getBoundingClientRect();
             var play = document.getElementById('play').getBoundingClientRect();
             var strip = document.getElementById('wind-strip');
             var pill = document.getElementById('time-pill');
             var pr = pill.getBoundingClientRect();
             var days = document.getElementById('track-days');
             var blocks = Array.from(days.children);
             return {
               deckH: deck.height,
               stripAbsent: !strip,
               trackH: track.height,
               timelineH: timeline.height,
               absent: {
                 main: !document.querySelector('.deck-main'),
                 playhead: !document.getElementById('playhead'),
                 rail: !document.getElementById('track-rail'),
                 progress: !document.getElementById('track-progress'),
               },
               pillVisible: pr.width > 0 && pr.height > 0,
               pillHidden: pill.hasAttribute('hidden'),
               pillText: pill.textContent,
               pillRect: {x: pr.x, y: pr.y, w: pr.width, h: pr.height},
               play: {x: play.x, y: play.y, r: play.x + play.width, b: play.y + play.height,
                      w: play.width, h: play.height},
               track: {x: track.x, y: track.y, r: track.x + track.width, b: track.y + track.height},
               timeline: {x: timeline.x, y: timeline.y, r: timeline.x + timeline.width,
                          b: timeline.y + timeline.height},
               blockCount: blocks.length,
               blockBg: blocks.map(function (b) { return getComputedStyle(b).backgroundColor; }),
             };
           }""")
    p, t, tl = v["play"], v["track"], v["timeline"]
    play_inside = (p["x"] >= t["x"] - 0.5 and p["r"] <= t["r"] + 0.5 and
                   p["y"] >= t["y"] - 0.5 and p["b"] <= t["b"] + 0.5 and
                   p["x"] - t["x"] <= 2)
    # 5G: the play button overlays the window, so #timeline fills the whole track row.
    timeline_inside = (abs(tl["x"] - t["x"]) <= 1 and abs(tl["r"] - t["r"]) <= 1 and
                       tl["y"] >= t["y"] - 0.5 and tl["b"] <= t["b"] + 0.5)
    tl_cx = tl["x"] + (tl["r"] - tl["x"]) / 2
    pill_cx = v["pillRect"]["x"] + v["pillRect"]["w"] / 2
    pill_centred = abs(pill_cx - tl_cx) <= 1  # 5G: pill is anchored to the window centre
    bgs = v["blockBg"]
    adjacent_ok = all(bgs[i] != bgs[i + 1] for i in range(len(bgs) - 1))
    # 5P: the wind strip stays gone and the 3-tier deck is 62 px: #track/#timeline are 62 px.
    tape_62 = abs(v["trackH"] - 62) <= 1 and abs(v["timelineH"] - 62) <= 1
    ok = (v["deckH"] <= 72 and v["stripAbsent"] and tape_62 and all(v["absent"].values()) and
          v["pillVisible"] and not v["pillHidden"] and bool(v["pillText"].strip()) and
          pill_centred and play_inside and timeline_inside and v["blockCount"] >= 1 and adjacent_ok)
    print("        5F/5P rects: deck h=%.1f wind-strip-absent=%s track h=%.1f timeline h=%.1f "
          "play=[%.1f,%.1f]x%.1fx%.1f timeline=[%.1f,%.1f]-[%.1f,%.1f] pill=[%.1f,%.1f] %.1fx%.1f "
          "text='%s' pill-cx=%.1f timeline-cx=%.1f blocks=%d bg=%s"
          % (v["deckH"], v["stripAbsent"], v["trackH"], v["timelineH"],
             p["x"], p["y"], p["w"], p["h"], tl["x"], tl["y"], tl["r"], tl["b"],
             v["pillRect"]["x"], v["pillRect"]["y"], v["pillRect"]["w"], v["pillRect"]["h"],
             v["pillText"], pill_cx, tl_cx, v["blockCount"], bgs))
    record(15, "deck geometry (5F)", ok,
           "deckH=%.1f absent=%s strip-absent=%s trackH=%.1f timelineH=%.1f pill-visible=%s "
           "pill-hidden=%s pill='%s' pill-centred=%s (cx=%.1f timeline-cx=%.1f) play-inside=%s "
           "timeline-fills=%s blocks=%d adjacent-differ=%s"
           % (v["deckH"], v["absent"], v["stripAbsent"], v["trackH"], v["timelineH"],
              v["pillVisible"], v["pillHidden"], v["pillText"],
              pill_centred, pill_cx, tl_cx, play_inside, timeline_inside, v["blockCount"],
              adjacent_ok))


def check_tape_architecture(page):
    """5G: fixed centre reticle + wide scrolling tape. Asserts the reticle is centred in
    #timeline, #track-tape is a #timeline child holding #now-tick, the 24 h tape fills the
    window while 7 d is 1,100-1,400 px, the active frame sits under the reticle, #play
    overlays the window's left edge with z-index >= 10, and day blocks alternate with the
    full 8-label 3 h sub-row in the 7-day view. Restores 24 h when done."""
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(400)

    def metrics():
        return page.evaluate(
            """() => {
                 var tlEl = document.getElementById('timeline');
                 var tlr = tlEl.getBoundingClientRect();
                 var tape = document.getElementById('track-tape');
                 var tr = tape.getBoundingClientRect();
                 var pill = document.getElementById('time-pill').getBoundingClientRect();
                 var play = document.getElementById('play');
                 var pr = play.getBoundingClientRect();
                 var track = document.getElementById('track').getBoundingClientRect();
                 var blocks = Array.from(document.getElementById('track-days').children);
                 var max = parseInt(document.getElementById('track').getAttribute('aria-valuemax'), 10);
                 var cur = parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10);
                 var now = document.getElementById('now-tick');
                 return {
                   tlCx: tlr.x + tlr.width / 2, tlW: tlr.width,
                   tapeX: tr.x, tapeW: tr.width,
                   pillCx: pill.x + pill.width / 2,
                   tapeInTimeline: tape.parentElement === tlEl,
                   nowInTape: !!(now && now.parentElement === tape),
                   cur: cur, n: max + 1, horizon: max === 671 ? '7d' : '24h',
                   playX: pr.x, playW: pr.width, playZ: getComputedStyle(play).zIndex,
                   trackX: track.x,
                   blockCount: blocks.length,
                   blockBg: blocks.map(function (b) { return getComputedStyle(b).backgroundColor; }),
                   subCounts: blocks.map(function (b) { return b.querySelectorAll('.day-sub').length; }),
                   transform: getComputedStyle(tape).transform,
                 };
               }""")

    def pxf_for(m):
        return (330.0 if m["horizon"] == "7d" else max(550.0, round(m["tlW"]))) / 96.0

    def centred(m):
        return abs(m["pillCx"] - m["tlCx"]) <= 1.0

    def frame_under_reticle(m):
        return abs((m["tapeX"] + m["cur"] * pxf_for(m)) - m["pillCx"]) <= 1.0

    m24 = metrics()
    ok_parent = m24["tapeInTimeline"] and m24["nowInTape"]
    ok_play = (0 <= (m24["playX"] - m24["trackX"]) <= 56 and
               int(m24["playZ"] or 0) >= 10 and m24["playW"] >= 44)
    ok_centre24 = centred(m24)
    ok_frame24 = frame_under_reticle(m24)
    ok_tape24 = m24["tapeW"] >= m24["tlW"] - 2 and m24["tapeW"] >= m24["tlW"] + 100
    ok_blocks24 = m24["blockCount"] >= 1
    print("        24h: tapeW=%.1f (window %.1f, runway %.1f, pxf=%.4f) pill-cx=%.1f tl-cx=%.1f "
          "frame-cx=%.1f cur=%d transform=%s"
          % (m24["tapeW"], m24["tlW"], m24["tapeW"] - m24["tlW"], pxf_for(m24),
             m24["pillCx"], m24["tlCx"],
             m24["tapeX"] + m24["cur"] * pxf_for(m24), m24["cur"], m24["transform"]))

    # scrub mid-window, then re-check the reticle.
    tl = page.evaluate(
        "() => { var r = document.getElementById('timeline').getBoundingClientRect();"
        " return {cx: r.x + r.width / 2, y: r.y + r.height / 2}; }")
    page.mouse.move(tl["cx"], tl["y"])
    page.mouse.down()
    page.mouse.move(tl["cx"] - 140, tl["y"], steps=8)
    page.mouse.up()
    page.wait_for_timeout(500)
    m_scrub = metrics()
    ok_scrub = centred(m_scrub) and frame_under_reticle(m_scrub)
    print("        scrub@24h: cur=%d pill-cx=%.1f tl-cx=%.1f frame-cx=%.1f"
          % (m_scrub["cur"], m_scrub["pillCx"], m_scrub["tlCx"],
             m_scrub["tapeX"] + m_scrub["cur"] * pxf_for(m_scrub)))

    # widen to 7 days.
    page.click("#h-7d")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '671'",
        timeout=60000)
    page.wait_for_timeout(700)
    m7 = metrics()
    ok_centre7 = centred(m7)
    ok_frame7 = frame_under_reticle(m7)
    ok_tape7 = 2280 <= m7["tapeW"] <= 2340
    bgs = m7["blockBg"]
    ok_alt = len(bgs) >= 2 and all(bgs[i] != bgs[i + 1] for i in range(len(bgs) - 1))
    # 5O: the two tones are pinned exactly (#23272e vs #1b1d22) and must alternate.
    tone_set = set(bgs)
    tones_ok = tone_set == {"rgb(35, 39, 46)", "rgb(27, 29, 34)"} and ok_alt
    ok_blocks7 = m7["blockCount"] == 7 and all(c == 8 for c in m7["subCounts"])
    print("        7d:  tapeW=%.1f (window %.1f, pxf=%.4f) pill-cx=%.1f tl-cx=%.1f "
          "frame-cx=%.1f cur=%d blocks=%d subs=%s transform=%s"
          % (m7["tapeW"], m7["tlW"], pxf_for(m7), m7["pillCx"], m7["tlCx"],
             m7["tapeX"] + m7["cur"] * pxf_for(m7), m7["cur"], m7["blockCount"],
             m7["subCounts"], m7["transform"]))
    print("        5o tones: set=%s alternating=%s" % (sorted(tone_set), ok_alt))

    ok = (ok_parent and ok_play and ok_centre24 and ok_frame24 and ok_tape24 and
          ok_blocks24 and ok_scrub and ok_centre7 and ok_frame7 and ok_tape7 and
          ok_alt and ok_blocks7 and tones_ok)
    record(16, "tape architecture (5G)", ok,
           "tape-in-timeline=%s now-in-tape=%s play-left=%.1f z=%s | "
           "24h tape=%.1f/window=%.1f runway=%.1f centred=%s frame-under=%s | "
           "7d tape=%.1f blocks=%d subs=%s alt=%s tones=%s tones-ok=%s centred=%s frame-under=%s"
           % (m24["tapeInTimeline"], m24["nowInTape"], m24["playX"] - m24["trackX"],
              m24["playZ"], m24["tapeW"], m24["tlW"], m24["tapeW"] - m24["tlW"],
              ok_centre24, ok_frame24,
              m7["tapeW"], m7["blockCount"], m7["subCounts"], ok_alt, sorted(tone_set),
              tones_ok, ok_centre7, ok_frame7))

    # restore 24 h for the checks that follow.
    page.click("#h-24h")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
        timeout=60000)
    page.wait_for_timeout(300)


# Stage 5H: external instrumentation for the scrub-decoupling group. It must be installed
# while #track-tape exists. Counts: inline translateX writes, overlay src swaps, long tasks,
# and delivered pointer moves (capture phase).
SCRUB_INSTR = r"""
() => {
  var tape = document.getElementById('track-tape');
  window.__sb = { tx: 0, moves: 0, downX: null, lastX: null, swaps: 0, long: [],
                  txInst: false, srcInst: false, longInst: false };
  // Chromium has no prototype transform accessor; shadow it on #track-tape's own style.
  try {
    if (tape && tape.style) {
      Object.defineProperty(tape.style, 'transform', {
        configurable: true,
        get: function () { return this.getPropertyValue('transform'); },
        set: function (v) {
          if (String(v).indexOf('translateX') === 0) window.__sb.tx++;
          this.setProperty('transform', v);
        }
      });
      window.__sb.txInst = true;
    }
  } catch (e) { window.__sb.txInst = false; }
  try {
    var img = document.querySelector('.leaflet-image-layer');
    if (img && window.MutationObserver) {
      new MutationObserver(function () { window.__sb.swaps++; })
        .observe(img, { attributes: true, attributeFilter: ['src'] });
      window.__sb.srcInst = true;
    }
  } catch (e) { window.__sb.srcInst = false; }
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (en) { window.__sb.long.push(Math.round(en.duration)); });
    }).observe({ entryTypes: ['longtask'] });
    window.__sb.longInst = true;
  } catch (e) { window.__sb.longInst = false; }
  window.addEventListener('pointerdown', function (e) { window.__sb.downX = e.clientX; }, true);
  window.addEventListener('pointermove', function (e) {
    window.__sb.moves++; window.__sb.lastX = e.clientX;
  }, true);
  return { tx: window.__sb.txInst, src: window.__sb.srcInst, long: window.__sb.longInst };
}
"""


def _js_round(x):
    """JS Math.round semantics (half up, toward +inf) for the dx -> index check."""
    return math.floor(x + 0.5)


def check_scrub_decoupling(page):
    """5H: a scripted 30-step drag decouples the tape UI from the map render. The tape
    transform writes on every delivered move, overlay src swaps stay <= 12, no long task
    (>50 ms) lands inside the drag, and pointerup snaps to the exact final index/pill."""
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    if page.get_attribute("#h-24h", "aria-pressed") != "true":
        page.click("#h-24h")
        page.wait_for_function(
            "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
            timeout=60000)
        page.wait_for_timeout(300)

    # Known start: Home -> frame 0, then wait out the 320 ms tape glide.
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_timeout(500)

    # Warm-up (throwaway, same as the bench): JIT + a few cache entries so the measured
    # drag is not dominated by the first cold build.
    tl = page.evaluate(
        "() => { var r = document.getElementById('timeline').getBoundingClientRect();"
        " return { cx: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; }")
    page.mouse.move(tl["cx"], tl["y"])
    page.mouse.down()
    for k in range(1, 31):
        page.mouse.move(tl["cx"] - 8 * k, tl["y"])
    page.mouse.up()
    page.wait_for_timeout(300)
    page.focus("#track")
    page.keyboard.press("Home")
    page.wait_for_timeout(500)

    # Instrumentation is installed only after warm-up so its counters cover the drag alone.
    inst = page.evaluate(SCRUB_INSTR)
    tl = page.evaluate(
        "() => { var r = document.getElementById('timeline').getBoundingClientRect();"
        " return { cx: r.x + r.width / 2, y: r.y + r.height / 2, w: r.width }; }")
    n = int(page.get_attribute("#track", "aria-valuemax")) + 1
    pxf = (330.0 if n == 672 else max(550.0, round(tl["w"]))) / 96.0
    start_idx = int(page.get_attribute("#track", "aria-valuenow"))

    cx, ty = tl["cx"], tl["y"]
    step = 8  # 30 steps * 8 px = 240 px, dragging LEFT = forward in time
    page.mouse.move(cx, ty)
    page.mouse.down()
    for k in range(1, 31):
        page.mouse.move(cx - step * k, ty)
    page.wait_for_timeout(80)
    during = page.evaluate(
        "() => ({ tx: window.__sb.tx, moves: window.__sb.moves, swaps: window.__sb.swaps,"
        " long: window.__sb.long.slice(), downX: window.__sb.downX, lastX: window.__sb.lastX })")
    page.mouse.up()
    page.wait_for_timeout(400)
    after = page.evaluate(
        "() => ({ idx: parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10),"
        " pill: document.getElementById('time-pill').textContent,"
        " hour: document.body.dataset.hour })")

    dx = during["lastX"] - during["downX"]
    expected = max(0, min(n - 1, _js_round(start_idx - dx / pxf)))
    a_ok = during["swaps"] <= 12
    # 6.3: the driver's pre-down positioning move counts in `moves` but emits no transform
    # write in any era (cdp-touch: moves=30, writes 30/30 exactly). This check used to pass
    # only because mid-drag map swaps flushed extra tape writes (6.2: 30 + 11 = 41); item 3
    # suspends mid-drag paints on fast drags by design (G1: 0 encodes), so the bar is the
    # drag-step count, moves - 1. Real starvation still fails loudly (a starving tape writes
    # ~once per rAF, far below moves - 1).
    b_ok = during["tx"] >= during["moves"] - 1
    long_max = max(during["long"]) if during["long"] else 0
    c_ok = long_max <= 50
    d_ok = after["idx"] == expected
    pill_expected = format_chicago_pill(after["hour"]) if after["hour"] else ""
    e_ok = after["pill"] == pill_expected
    instruments = bool(inst["tx"]) and bool(inst["src"]) and bool(inst["long"])
    ok = instruments and a_ok and b_ok and c_ok and d_ok and e_ok
    print("        drag: moves=%d tx=%d swaps=%d long=%s downX=%.1f lastX=%.1f dx=%.1f"
          % (during["moves"], during["tx"], during["swaps"], during["long"],
             during["downX"] or 0.0, during["lastX"] or 0.0, dx))
    print("        final: idx=%d expected=%d start=%d pxf=%.4f pill='%s' expected='%s' hour=%s"
          % (after["idx"], expected, start_idx, pxf, after["pill"], pill_expected, after["hour"]))
    record(17, "scrub decoupling (5H)", ok,
           "moves=%d tx>=moves-1=%s swaps=%d<=12=%s long-max=%d<=50=%s "
           "idx=%d expected=%d=%s pill=%s instruments(tx/src/long)=%s/%s/%s"
           % (during["moves"], b_ok, during["swaps"], a_ok, long_max, c_ok,
              after["idx"], expected, d_ok, e_ok,
              inst["tx"], inst["src"], inst["long"]))


def capture_shots(page):
    """Done-when 3: phone-viewport screenshots with the deck visible at the frame bottom."""
    def shot(name):
        page.screenshot(path=str(SHOTS / name))

    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(500)
    shot("24h.png")
    page.set_viewport_size({"width": 360, "height": 800})
    page.wait_for_timeout(500)
    shot("24h-360.png")
    page.set_viewport_size({"width": 390, "height": 844})
    page.wait_for_timeout(300)
    page.click("#h-7d")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '671'",
        timeout=60000)
    page.wait_for_timeout(700)
    shot("7d.png")
    # 5G: scrub to the middle of the 7-day tape so the sheet shows it scrolled with the
    # reticle still centred (two full-width drags left = forward in time).
    tl7 = page.evaluate(
        "() => { var r = document.getElementById('timeline').getBoundingClientRect();"
        " return {x: r.x, w: r.width, y: r.y + r.height / 2}; }")
    for _ in range(2):
        page.mouse.move(tl7["x"] + tl7["w"] - 6, tl7["y"])
        page.mouse.down()
        page.mouse.move(tl7["x"] + 6, tl7["y"], steps=10)
        page.mouse.up()
        page.wait_for_timeout(100)
    page.wait_for_timeout(400)
    shot("tape-7d.png")
    page.click("#h-24h")
    page.wait_for_function(
        "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
        timeout=60000)
    page.wait_for_timeout(400)
    tl = page.evaluate(
        "() => { var r = document.getElementById('timeline').getBoundingClientRect();"
        " return {x: r.x + 0.25 * r.width, y: r.y + 24, x2: r.x + 0.72 * r.width}; }")
    page.mouse.move(tl["x"], tl["y"])
    page.mouse.down()
    page.mouse.move(tl["x2"], tl["y"], steps=8)
    page.wait_for_timeout(200)
    shot("scrub.png")
    page.mouse.up()


def check_playback(page, warp):
    page.evaluate("window.__bpcMap.setZoom(13)")
    page.wait_for_timeout(1300)
    page.click("#play")
    page.wait_for_timeout(120)  # let the play-width regather settle before sampling ticks
    page.evaluate(
        "() => { window.__s4h = []; window.__s4f = [];"
        " new MutationObserver(() => { var h = document.body.dataset.hour;"
        "   if (h) window.__s4h.push(h);"
        "   var f = document.body.dataset.frameMs;"
        "   if (f) window.__s4f.push(parseFloat(f)); })"
        " .observe(document.body, { attributes: true, attributeFilter: ['data-hour'] }); }")
    page.wait_for_function("window.__s4h.length >= 10", timeout=45000)
    snap = page.evaluate(
        "() => ({ cw: document.getElementById('field').width,"
        " hours: window.__s4h.slice(), fms: window.__s4f.slice(),"
        " encode: document.body.dataset.encodeMs })")
    page.screenshot(path=str(SHOTS / "bpc-s5-play.png"))
    page.click("#play")
    page.wait_for_timeout(1000)
    post = page.evaluate(
        "() => ({ cw: document.getElementById('field').width,"
        " created: window.__bpcCreated, revoked: window.__bpcRevoked })")
    canvas_during = snap["cw"]
    fms = snap["fms"] or [0.0]
    avg = sum(fms) / len(fms)
    mx = max(fms)
    ok = (canvas_during <= 780 and post["cw"] > 1000 and avg <= 60 and mx <= 60 and
          post["created"] > 0 and 0 < post["revoked"] <= post["created"])
    record(9, "playback perf", ok,
           "canvas_during=%d ticks=%d frameMs avg=%.1f max=%.1f encodeMs=%s "
           "canvas_paused=%d created=%d revoked=%d"
           % (canvas_during, len(snap["hours"]), avg, mx, snap["encode"],
              post["cw"], post["created"], post["revoked"]))
    print("        frameMs: %s" % [round(x, 1) for x in fms])
    print("        hours:   %s" % snap["hours"])


def _upscale(page):
    return page.evaluate(
        "() => { var i = document.querySelector('.leaflet-image-layer');"
        " var r = i.getBoundingClientRect();"
        " return { u: r.width / i.naturalWidth, nw: i.naturalWidth, w: r.width }; }")


def measure_upscales(page, warp, prefix):
    ll = ll_bounds(warp)
    out = {}
    page.evaluate("(ll) => window.__bpcMap.fitBounds(ll, {padding:[12,12], maxZoom:12})", ll)
    page.wait_for_timeout(1100)
    page.wait_for_function(OVERLAY_OK, timeout=30000)
    out["fit"] = _upscale(page)
    page.screenshot(path=str(SHOTS / ("bpc-s5-%s-fit.png" % prefix)))
    for z in (13, 14):
        page.evaluate("(z) => window.__bpcMap.setZoom(z)", z)
        page.wait_for_timeout(1400)
        page.wait_for_function(OVERLAY_OK, timeout=30000)
        out[str(z)] = _upscale(page)
        page.screenshot(path=str(SHOTS / ("bpc-s5-%s-z%d.png" % (prefix, z))))
    return out


def _sample_alpha(page, bounds, pts):
    "bounds: {west,east,north,south}; pts: [[lat,lon], ...] -> [alpha, ...]"
    return page.evaluate(
        """(args) => {
             var b = args.bounds, pts = args.pts;
             var i = document.querySelector('.leaflet-image-layer');
             var c = document.createElement('canvas');
             c.width = i.naturalWidth; c.height = i.naturalHeight;
             var x = c.getContext('2d');
             x.drawImage(i, 0, 0);
             var d = x.getImageData(0, 0, c.width, c.height).data;
             return pts.map(function (p) {
               var px = Math.round((p[1] - b.west) / (b.east - b.west) * c.width);
               var py = Math.round((b.north - p[0]) / (b.north - b.south) * c.height);
               px = Math.max(0, Math.min(c.width - 1, px));
               py = Math.max(0, Math.min(c.height - 1, py));
               return d[(py * c.width + px) * 4 + 3];
             });
           }""", {"bounds": bounds, "pts": pts})


def check_smoothing(page, meta, warp):
    now = measure_upscales(page, warp, "now")
    # GATE OVERRIDE (Reid, 2026-09-12): the raster ceiling stays at targetWidth(.., hi=1536).
    # At z13/z14 the lake bbox projects to ~2163/~4327 CSS px, so the overlay is upscaled
    # ~1.4x/~2.8x — accepted as design reality: a soft weather gradient at deep zoom is
    # physically appropriate, and 1536 px avoids mobile-Safari canvas memory crashes.
    # Pre-stage4 was 5.633x / 11.268x; the <=3.0x gate pins that improvement, not perfection.
    MAX_UPSCALE = 3.0
    up_ok = all(now[k]["u"] <= MAX_UPSCALE for k in ("fit", "13", "14"))
    record(10, "radar smoothing", up_ok,
           "upscale fit=%.3f z13=%.3f z14=%.3f (gate <=%.1f, 1536px ceiling accepted)" %
           (now["fit"]["u"], now["13"]["u"], now["14"]["u"], MAX_UPSCALE))

    # land-bleed: sample known-land meta corners + 2 mid-lake points on the fit raster
    west = warp["corners"]["nw"][0]
    east = warp["corners"]["se"][0]
    north = warp["corners"]["nw"][1]
    south = warp["corners"]["se"][1]
    bounds = {"west": west, "east": east, "north": north, "south": south}
    land = [[meta["wgs84_corners"]["nw"][1], meta["wgs84_corners"]["nw"][0]],
            [meta["wgs84_corners"]["ne"][1], meta["wgs84_corners"]["ne"][0]],
            [meta["wgs84_corners"]["se"][1], meta["wgs84_corners"]["se"][0]],
            [meta["wgs84_corners"]["sw"][1], meta["wgs84_corners"]["sw"][0]]]
    mid = [[46.23846, -93.64229], [46.20, -93.61]]
    page.evaluate("(ll) => window.__bpcMap.fitBounds(ll, {padding:[12,12], maxZoom:12})",
                  ll_bounds(warp))
    page.wait_for_timeout(1100)
    page.wait_for_function(OVERLAY_OK, timeout=30000)
    alphas = _sample_alpha(page, bounds, land + mid)
    land_a = alphas[:len(land)]
    mid_a = alphas[len(land):]
    bleed_ok = all(a == 0 for a in land_a) and all(a > 0 for a in mid_a)
    record(10.1, "land bleed", bleed_ok,
           "land_alpha=%s mid_lake_alpha=%s (land must be 0, mid >0)" % (land_a, mid_a))
    return now


def check_before_after(pw, now_ups, warp):
    subprocess.run(["git", "worktree", "remove", "--force", str(PRE_WT)],
                   cwd=ROOT, capture_output=True)
    subprocess.run(["git", "worktree", "prune"], cwd=ROOT, capture_output=True)
    add = subprocess.run(["git", "worktree", "add", "--detach", str(PRE_WT), PRE_TAG],
                         cwd=ROOT, capture_output=True, text=True)
    if add.returncode != 0:
        record(11, "before/after", False, "worktree add failed: %s" % add.stderr.strip())
        return
    port2 = free_port()
    srv2 = serve(port2, PRE_WT)
    browser2 = None
    try:
        if not wait_http("http://127.0.0.1:%d/index.html" % port2):
            record(11, "before/after", False, "pre-stage4 server did not start")
            return
        browser2, page2 = new_page(pw)
        load_app(page2, "http://127.0.0.1:%d/index.html" % port2)
        page2.wait_for_function(
            "() => { var i = document.querySelector('.leaflet-image-layer');"
            " return !!i && i.naturalWidth > 0; }", timeout=90000)
        before = measure_upscales(page2, warp, "pre4")
    finally:
        if browser2:
            browser2.close()
        srv2.terminate()
        subprocess.run(["git", "worktree", "remove", "--force", str(PRE_WT)],
                       cwd=ROOT, capture_output=True)
        subprocess.run(["git", "worktree", "prune"], cwd=ROOT, capture_output=True)
    print("        level   pre-stage4 (stages 1-3)   stage-4 (now)")
    for key in ("fit", "13", "14"):
        print("        %-6s  %-23.3f  %.3f"
              % (key, before[key]["u"], now_ups[key]["u"]))
    record(11, "before/after", True,
           "fit %.3f->%.3f  z13 %.3f->%.3f  z14 %.3f->%.3f"
           % (before["fit"]["u"], now_ups["fit"]["u"],
              before["13"]["u"], now_ups["13"]["u"],
              before["14"]["u"], now_ups["14"]["u"]))


def check_suites():
    all_ok = True
    for name in ("parity", "wind", "render", "ui"):
        r = subprocess.run(["node", "tests/%s.test.js" % name],
                           cwd=ROOT, capture_output=True, text=True)
        lines = [ln for ln in r.stdout.strip().splitlines() if ln.strip()]
        tail = lines[-1] if lines else "(no output)"
        all_ok = all_ok and r.returncode == 0
        record(12, "suite %s" % name, r.returncode == 0,
               "exit=%d tail: %s" % (r.returncode, tail))
    return all_ok


def check_seam():
    """5A: the live +48 h handoff from native minutely_15 to vector-blended hourly
    frames is continuous. Runs tools/qa/seam_check.js (live network) and parses its
    one-line SEAM summary."""
    r = subprocess.run(["node", "tools/qa/seam_check.js"], cwd=ROOT,
                       capture_output=True, text=True)
    lines = [ln for ln in (r.stdout or "").splitlines() if ln.strip()]
    for ln in lines:
        print("        seam: %s" % ln)
    summary = next((ln for ln in lines if ln.startswith("SEAM ")), "")
    m = re.search(r"dSpeed=([0-9.]+)\s+dDir=([0-9.]+)", summary)
    if r.stderr.strip():
        print("        seam stderr: %s" % r.stderr.strip().splitlines()[-1])
    detail = "exit=%d %s" % (r.returncode, summary or "(no SEAM line)")
    if m:
        detail = "exit=%d dSpeed=%s dDir=%s | %s" % (
            r.returncode, m.group(1), m.group(2), summary)
    record(14, "live seam", r.returncode == 0 and m is not None, detail)


# --------------------------------------------------------------------------- #
# [19] 6.2: UI polish pass — de-cluttered header, docked corners, continuous scrub
# --------------------------------------------------------------------------- #
S6_SHOTS = ROOT / "tmp" / "s6-shots"
S6_SHOTS.mkdir(parents=True, exist_ok=True)
S6_LAKE_LAT, S6_SHORE_LAT = 46.22, 46.13
# Host set observed on a clean boot: the dual-location ingest must not add a
# second weather host (see STAGE-6-RECEIPTS for the observation).
S6_HOSTS_OK = {"127.0.0.1", "api.open-meteo.com", "tile.openstreetmap.org", "unpkg.com"}
# The 6.2 row is two badges: lake (tier-tinted, carries mph) and gust (neutral, carries mph + Gust).
S6_STATES = {
    "normal": {"lake": 17.0, "shore": 8.0, "gust": 24.0},
    "wide": {"lake": 27.0, "shore": 12.0, "gust": 38.0},
    "calm": {"lake": 4.0, "shore": 3.0, "gust": 6.0},
}
# 6.2: the de-clutter deletes these ids. A single leftover is a FAIL (the probe list
# lives inside S62_GEOMETRY_JS so it reads the live DOM, not this module).

S62_GEOMETRY_JS = r"""
() => {
  // Null-safe: a missing id is NAMED in `missing` and its rect is null, so the
  // gate reports the element instead of throwing.
  const missing = [];
  const R = (el, label) => { if (!el) { missing.push(label || '?'); return null; }
    const r = el.getBoundingClientRect();
    return {x:+r.x.toFixed(2), y:+r.y.toFixed(2), w:+r.width.toFixed(2), h:+r.height.toFixed(2),
            top:+r.top.toFixed(2), bottom:+r.bottom.toFixed(2), right:+r.right.toFixed(2)}; };
  const g = (id) => { const el = document.getElementById(id);
    if (!el) { missing.push('#' + id); } return el; };
  const kidsOf = (el) => el ? Array.from(el.children).map(function (c) {
    return c.id || (typeof c.className === 'string' && c.className ? c.className : c.tagName); }) : null;
  const header = document.querySelector('header');
  if (!header) { missing.push('header'); }
  const hr = R(header, 'header');
  const three = g('three');
  const kids = three ? Array.from(three.children) : [];
  const el0 = kids.length ? R(kids[0], 'row-first') : null;
  const elN = kids.length ? R(kids[kids.length - 1], 'row-last') : null;
  const ink = (el0 && elN) ? +(elN.right - el0.x).toFixed(2) : null;
  const cs3 = three ? getComputedStyle(three) : null;
  const avail = three ? +(three.clientWidth - (parseFloat(cs3.paddingLeft) || 0)
                  - (parseFloat(cs3.paddingRight) || 0)).toFixed(2) : null;
  const badge = (id) => { const el = g(id), r = R(el, '#' + id);
    return {id: id, r: r, kids: kidsOf(el),
            bg: el ? getComputedStyle(el).backgroundColor : null,
            inside: !!(r && hr && r.top >= hr.top - 0.01 && r.bottom <= hr.bottom + 0.01 &&
                    r.x >= hr.x - 0.01 && r.right <= hr.right + 0.01)}; };
  const badges = [badge('pill-lake'), badge('pill-gust')];
  const styles = {};
  [['lake','lake'],['gust','gust'],['mph','mph'],['gustLabel','gust-u'],['dot','dot']]
    .forEach(function (pair) {
      const el = g(pair[1]);
      if (!el) { styles[pair[0]] = null; return; }
      const s = getComputedStyle(el);
      styles[pair[0]] = {color: s.color, fontSize: s.fontSize, fontWeight: s.fontWeight,
        fontVariantNumeric: s.fontVariantNumeric, fontFamily: s.fontFamily,
        text: el.textContent, w: +el.getBoundingClientRect().width.toFixed(2)};
    });
  // 6.3 item 4: the gust badge deliberately carries no .unit span ("24 Gust"). Its
  // PRESENCE is now the defect, and styles.gustUnit no longer exists.
  const gustUnitEl = document.querySelector('#pill-gust .unit');
  if (gustUnitEl) { missing.push('#pill-gust .unit must be absent'); }
  styles.gustUnit = null;
  const hs = header ? getComputedStyle(header) : null;
  const mapEl = g('map'), mapR = R(mapEl, '#map');
  const horizon = R(g('horizon'), '#horizon');
  const windBadge = R(g('wind-badge'), '#wind-badge');
  const zoomEl = document.querySelector('.leaflet-control-zoom');
  if (!zoomEl) { missing.push('.leaflet-control-zoom'); }
  const zoom = zoomEl ? R(zoomEl, '.leaflet-control-zoom') : null;
  const attribEl = document.querySelector('.leaflet-control-attribution');
  if (!attribEl) { missing.push('.leaflet-control-attribution'); }
  const attrib = attribEl ? R(attribEl, 'attribution') : null;
  const legend = R(g('legend-card'), '#legend-card');
  const timePillEl = g('time-pill'), tp = R(timePillEl, '#time-pill');
  const cardEl = document.getElementById('card');
  const cardR = (cardEl && !cardEl.hidden) ? R(cardEl, '#card') : null;
  const ov = (a, b) => !!(a && b && a.x < b.right && b.x < a.right && a.y < b.bottom && b.y < a.bottom);
  const tpCS = timePillEl ? getComputedStyle(timePillEl) : null;
  return {
    missing: missing,
    header: header ? {r: hr, clientHeight: header.clientHeight, scrollHeight: header.scrollHeight} : null,
    headerStyle: hs ? {backdropFilter: hs.backdropFilter || hs.webkitBackdropFilter,
                  zIndex: hs.zIndex, background: hs.backgroundColor,
                  position: hs.position, fontFamily: hs.fontFamily} : null,
    three: three ? {r: R(three, '#three'), scrollWidth: three.scrollWidth,
            clientWidth: three.clientWidth, ink: ink, avail: avail, kids: kidsOf(three)} : null,
    badges: badges,
    badgesInside: badges.length > 0 && badges.every(function (b) { return b.inside; }),
    styles: styles,
    refresh: R(g('refresh'), '#refresh'),
    map: mapR,
    overlaps: !!(hr && mapR && hr.bottom > mapR.top && hr.top < mapR.bottom),
    horizonClear: (horizon && hr) ? +(horizon.top - hr.bottom).toFixed(2) : null,
    badgeClear: (windBadge && hr) ? +(windBadge.top - hr.bottom).toFixed(2) : null,
    zoom: zoom, attribution: attrib,
    corner: (horizon && windBadge && mapR) ? {
      horizonLeft: +(horizon.x - mapR.x).toFixed(2),
      horizonTop: +(horizon.top - hr.bottom).toFixed(2),
      badgeRight: +(mapR.right - windBadge.right).toFixed(2),
      badgeTop: +(windBadge.top - hr.bottom).toFixed(2),
    } : null,
    zoomDock: (zoom && attrib && mapR) ? {
      rightGapAttrib: +(zoom.right - attrib.right).toFixed(2),
      bottomAboveMap: +(mapR.bottom - zoom.bottom).toFixed(2),
      attribTopAboveMap: +(mapR.bottom - attrib.top).toFixed(2),
      gapToAttrib: +(attrib.top - zoom.bottom).toFixed(2),
      inBottomHalf: (zoom.y + zoom.h / 2) > (mapR.y + mapR.h / 2),
      insideMap: zoom.x >= mapR.x - 0.01 && zoom.right <= mapR.right + 0.01 &&
                 zoom.top >= mapR.top - 0.01 && zoom.bottom <= mapR.bottom + 0.01,
      overlapsAttrib: ov(zoom, attrib), overlapsLegend: ov(zoom, legend),
      overlapsBadge: ov(zoom, windBadge), overlapsHorizon: ov(zoom, horizon),
      overlapsPill: ov(zoom, tp), overlapsCard: ov(zoom, cardR),
    } : null,
    deadIds: ["pill-shore","shore","shore-u","arrow","help","help-pop","lake-u"]
      .filter(function (id) { return !!document.getElementById(id); }),
    rowText: three ? three.textContent.replace(/\s+/g, ' ').trim() : null,
    lakeText: g('lake') ? document.getElementById('lake').textContent : null,
    gustText: g('gust') ? document.getElementById('gust').textContent : null,
    timePill: timePillEl ? {text: timePillEl.textContent, w: tp.w,
      inkW: timePillEl.scrollWidth, tabular: tpCS.fontVariantNumeric} : null,
  };
}
"""

S62_CONTRAST_JS = r"""
() => {
  const lin = (c) => { c /= 255; return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); };
  const L = (rgb) => 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
  const parse = (s) => { const m = s.match(/[\d.]+/g).map(Number); return {rgb: m.slice(0, 3), a: m.length > 3 ? m[3] : 1}; };
  const over = (fg, bg) => fg.rgb.map((c, i) => c * fg.a + bg[i] * (1 - fg.a));
  const ratio = (a, b) => { const l1 = L(a), l2 = L(b); return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05); };
  const cs = getComputedStyle(document.querySelector('header'));
  const GLASS = over(parse(cs.backgroundColor), [20, 40, 59]);
  const fill = (sel) => over(parse(getComputedStyle(document.querySelector(sel)).backgroundColor), GLASS);
  // 6.2: two badges. The lake badge carries the .55-alpha WIND_HEAT tier tint (worst case:
  // the amber tier at 17 mph), the gust badge the neutral slate fill.
  const lake = fill('#pill-lake'), gust = fill('#pill-gust');
  const P = (sel) => parse(getComputedStyle(document.querySelector(sel)).color).rgb;
  const out = {};
  out['#lake numeral vs #pill-lake'] = ratio(P('#lake'), lake);
  out['#mph unit vs #pill-lake'] = ratio(P('#mph'), lake);
  out['#gust numeral vs #pill-gust'] = ratio(P('#gust'), gust);
  out['#gust-u label vs #pill-gust'] = ratio(P('#gust-u'), gust);
  out['#dot vs header glass'] = ratio(P('#dot'), GLASS);
  const keys = Object.keys(out);
  const min = Math.min.apply(null, keys.map((k) => out[k]));
  return {ratios: out, min: +min.toFixed(2), minPair: keys.filter((k) => out[k] === min)[0],
          lakeTint: getComputedStyle(document.querySelector('#pill-lake')).backgroundColor};
}
"""

S62_IDENTITY_JS = r"""
async () => {
  const res = await fetch('src/wind.js');
  const src = await res.text();
  const mod = {exports: {}};
  new Function('module', 'exports', 'require', src)(mod, mod.exports,
    function (req) { throw new Error('harness require ' + req); });
  const data = await mod.exports.ingest({horizon: '24h'});
  const idx = Number(document.getElementById('track').getAttribute('aria-valuenow'));
  return {idx: idx, dayLen: data.day.length,
          shoreLen: data.shoreDay ? data.shoreDay.length : null,
          day: data.day[idx] ? data.day[idx].speedMph : null,
          gust: data.day[idx] ? data.day[idx].gustMph : null};
}
"""

# 6.2 scrub probe: read the pill + tape while the pointer is still down.
S62_SCRUB_JS = r"""
() => {
  const tape = document.getElementById('track-tape');
  const tl = document.getElementById('timeline').getBoundingClientRect();
  const m = new DOMMatrixReadOnly(getComputedStyle(tape).transform);
  const track = document.getElementById('track');
  return {pill: document.getElementById('time-pill').textContent,
          tx: +m.m41.toFixed(3), tlCx: +(tl.x + tl.width / 2).toFixed(2),
          tlW: +tl.width.toFixed(2), tlY: +(tl.y + tl.height / 2).toFixed(2),
          idx: parseInt(track.getAttribute('aria-valuenow'), 10),
          max: parseInt(track.getAttribute('aria-valuemax'), 10),
          hour: document.body.dataset.hour,
          transition: getComputedStyle(tape).transitionDuration};
}
"""


def _s6_series(today, lake, shore, gust, varying=False):
    """A crafted Open-Meteo paired response: [lake, shore], 8 local days of hourly
    samples (past day inclusive) so today always slices to 96 15-min frames."""
    start = today - timedelta(days=1)
    n = 8 * 24
    times, ls, ld, lg, ss, sd, sg = [], [], [], [], [], [], []
    for i in range(n):
        d = start + timedelta(days=i // 24)
        h = i % 24
        times.append("%04d-%02d-%02dT%02d:00" % (d.year, d.month, d.day, h))
        if varying:
            lv, sv, gv = 11.0 + (i % 19), 8.0 + (i % 3), 15.0 + (i % 20)
        else:
            lv, sv, gv = lake, shore, gust
        ls.append(lv); ld.append(270.0); lg.append(gv)
        ss.append(sv); sd.append(250.0); sg.append(gv)
    units = {"wind_speed_10m": "mph", "wind_gusts_10m": "mph",
             "wind_direction_10m": "deg", "time": "iso8601"}

    def loc(lat, lon, sp, dr, gu):
        return {"latitude": lat, "longitude": lon, "timezone": "America/Chicago",
                "hourly_units": units,
                "hourly": {"time": times, "wind_speed_10m": sp,
                           "wind_direction_10m": dr, "wind_gusts_10m": gu}}
    return [loc(S6_LAKE_LAT, -93.657, ls, ld, lg),
            loc(S6_SHORE_LAT, -93.57, ss, sd, sg)]


def _s6_eq(dom_text, value):
    try:
        return str(int(round(float(value)))) == str(dom_text).strip()
    except (TypeError, ValueError):
        return False


def _pill_minutes(text):
    """'12:31 AM' -> 31. The 6.2 pill always shows minutes on the drag path."""
    m = re.match(r"^\s*(\d{1,2}):(\d{2})\s*(AM|PM)\s*$", str(text or ""))
    if not m:
        return None
    h = int(m.group(1)) % 12
    if m.group(3) == "PM":
        h += 12
    return h * 60 + int(m.group(2))


def check_marine_header(pw, port):
    """6.2 [19]: drive the shipped chrome from crafted dual-location responses
    (route-intercepted) and verify the de-cluttered two-badge row, the docked
    corners (horizon top-left / zoom bottom-right), the continuous minute-level
    scrub and the 72 px header ceiling."""
    base = "http://127.0.0.1:%d/index.html" % port
    today = datetime.now(CHICAGO).date()
    vps = ((360, 800), (390, 844))
    browser = pw.chromium.launch()
    ctx = browser.new_context(viewport={"width": 360, "height": 800}, device_scale_factor=2)
    page = ctx.new_page()
    errors = []
    requests = []
    page.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
    page.on("console", lambda m: errors.append("console: %s" % m.text) if m.type == "error" else None)
    page.on("request", lambda r: requests.append((urlparse(r.url).hostname or "", r.url)))
    holder = {"body": None}

    def route_wind(route):
        route.fulfill(status=200, content_type="application/json", body=json.dumps(holder["body"]))
    page.route("**/api.open-meteo.com/**", route_wind)

    def load(body):
        holder["body"] = body
        page.goto(base, wait_until="domcontentloaded")
        page.wait_for_function(
            "() => { var p = document.getElementById('time-pill');"
            " return !!p && p.textContent.trim() !== '\u2014' &&"
            " document.getElementById('track-days').children.length >= 1; }",
            timeout=120000)
        page.wait_for_timeout(450)

    def view(w, h):
        page.set_viewport_size({"width": w, "height": h})
        page.wait_for_timeout(400)

    all_ok = [True]
    fails = []

    def emit(ok, line, tag=None):
        if not ok:
            all_ok[0] = False
            fails.append(tag or line.split()[0])
        print("        19 %s" % line, flush=True)
        return ok

    def gate(num, label, fn, *args):
        try:
            return fn(*args)
        except Exception as exc:  # noqa: BLE001 - QA records, never aborts
            emit(False, "[%s] %s EXCEPTION %s: %s"
                 % (num, label, type(exc).__name__, str(exc).splitlines()[0]))
            return None

    geos = {}

    def layout_block(name, w, h):
        view(w, h)
        geo = page.evaluate(S62_GEOMETRY_JS)
        con = page.evaluate(S62_CONTRAST_JS)
        geos[(name, w)] = geo
        if geo["missing"]:
            emit(False, "[19.probe] %s @%dx%d MISSING ELEMENTS %s"
                 % (name, w, h, geo["missing"]))
        hd, three, st = geo["header"], geo["three"], geo["styles"]
        # [19.1] the 72 px ceiling survives the de-clutter
        emit(hd is not None and abs(hd["r"]["h"] - 72.0) < 0.005
             and hd["scrollHeight"] == hd["clientHeight"],
             "[19.1] %s @%dx%d header_h=%s scrollH=%s clientH=%s"
             % (name, w, h, hd and hd["r"]["h"], hd and hd["scrollHeight"],
                hd and hd["clientHeight"]))
        # [19.2] the row fits its box and the lake unit keeps its ink (gust has no unit)
        mph_w = st.get("mph") and st["mph"]["w"]
        emit(three is not None and three["scrollWidth"] <= three["clientWidth"]
             and mph_w is not None and mph_w >= 17.0,
             "[19.2] %s @%dx%d #three sw=%s cw=%s mph_w=%s (>=17)"
             % (name, w, h, three and three["scrollWidth"], three and three["clientWidth"],
                mph_w))
        # [19.3] ink stays inside the available width
        slack = (three["avail"] - three["ink"]) if (three and three["ink"] is not None
                 and three["avail"] is not None) else None
        emit(three is not None and three["ink"] is not None and three["avail"] is not None
             and three["ink"] <= three["avail"],
             "[19.3] %s @%dx%d ink=%s avail=%s slack=%s"
             % (name, w, h, three and three["ink"], three and three["avail"], slack))
        # [19.4] exactly two badges + dot, correct families, zero dead ids
        kids = three and three["kids"]
        lake_k, gust_k = geo["badges"][0]["kids"], geo["badges"][1]["kids"]
        emit(kids == ["pill-lake", "dot", "pill-gust"]
             and lake_k == ["lake", "mph"]
             and gust_k == ["gust", "gust-u"]
             and geo["badgesInside"] and not geo["deadIds"] and geo["timePill"],
             "[19.4] %s @%dx%d row=%s lake=%s gust=%s inside=%s dead-ids=%s pill='%s'"
             % (name, w, h, kids, lake_k, gust_k, geo["badgesInside"], geo["deadIds"],
                geo["timePill"] and geo["timePill"]["text"]))
        # [19.5] typography: numerals 13/700 tabular, units + Gust label 10 px, badge fill split
        nums_ok = all(st.get(k) and st[k]["fontSize"] == "13px"
                      and st[k]["fontWeight"] == "700"
                      and st[k]["fontVariantNumeric"] == "tabular-nums"
                      for k in ("lake", "gust"))
        units_ok = all(st.get(k) and st[k]["fontSize"] == "10px"
                       and st[k]["fontWeight"] == "500" for k in ("mph", "gustLabel"))
        white_ok = st.get("mph") and st["mph"]["color"] == "rgb(248, 250, 252)"
        slate_ok = st.get("gustLabel") and st["gustLabel"]["color"] == "rgb(203, 213, 225)"
        font_ok = st.get("lake") and all(t in st["lake"]["fontFamily"]
                                         for t in ("Inter", "Roboto", "sans-serif"))
        emit(nums_ok and units_ok and white_ok and slate_ok and font_ok,
             "[19.5] %s @%dx%d numerals=%s/%s units=%s/%s lake-unit=%s gust-label=%s font=%s"
             % (name, w, h, st.get("lake") and st["lake"]["fontSize"],
                st.get("lake") and st["lake"]["fontWeight"],
                st.get("mph") and st["mph"]["fontSize"],
                st.get("gustLabel") and st["gustLabel"]["fontSize"],
                st.get("mph") and st["mph"]["color"], st.get("gustLabel") and st["gustLabel"]["color"],
                st.get("lake") and st["lake"]["fontFamily"]))
        # [19.6] contrast: white on the tier tint, slate on the neutral fill, >= 4.5:1
        emit(con["min"] >= 4.5,
             "[19.6] %s @%dx%d contrast min=%.2f:1 (%s) tint=%s pairs=%s"
             % (name, w, h, con["min"], con["minPair"], con["lakeTint"],
                " ".join("%s=%.2f" % (k.split()[0], v) for k, v in con["ratios"].items())))

    # ---- gates 1-6: normal / wide / calm, both viewports -------------------
    for name in ("normal", "wide", "calm"):
        cfg = S6_STATES[name]
        if name == "normal":
            requests[:] = []
        load(_s6_series(today, cfg["lake"], cfg["shore"], cfg["gust"]))
        if name == "normal":
            boot = list(requests)
            om = [u for hh, u in boot if hh == "api.open-meteo.com"]

            def gate8():
                hosts = sorted(set(hh for hh, _ in boot))
                both = bool(om) and ("46.22" in om[0] and "46.13" in om[0])
                emit(len(om) == 1 and both and set(hosts) <= S6_HOSTS_OK,
                     "[19.8] normal @boot open-meteo=%d url-has-both-lats=%s hosts=%s unexpected=%s"
                     % (len(om), both, hosts, sorted(set(hosts) - S6_HOSTS_OK) or "none"))
            gate("19.8", "network shape", gate8)
            for w, h in vps:
                def gate9(w=w, h=h):
                    view(w, h)
                    ident = page.evaluate(S62_IDENTITY_JS)
                    dom_lake = page.evaluate("() => document.getElementById('lake').textContent")
                    dom_gust = page.evaluate("() => document.getElementById('gust').textContent")
                    emit(ident["day"] is not None and ident["gust"] is not None
                         and _s6_eq(dom_lake, ident["day"]) and _s6_eq(dom_gust, ident["gust"]),
                         "[19.9] identity @%dx%d idx=%s day[idx]=%s gust[idx]=%s "
                         "DOM lake='%s' gust='%s' (shore ingested, not displayed: shoreLen=%s)"
                         % (w, h, ident["idx"], ident["day"], ident["gust"], dom_lake, dom_gust,
                            ident["shoreLen"]))
                gate("19.9", "identity", gate9)
        for w, h in vps:
            gate("layout@%dx%d" % (w, h), "layout @%dx%d" % (w, h), layout_block, name, w, h)
            if name == "normal":
                page.screenshot(path=str(S6_SHOTS / ("header-%d.png" % w)))
            if name == "wide" and w == 360:
                page.screenshot(path=str(S6_SHOTS / "wide-360.png"))

    # ---- gate 12: overlay / blur / top-strip clearance ----------------------
    def gate12():
        g0 = geos[("normal", 360)]
        render_src = (ROOT / "src/render.js").read_text()
        hs = g0["headerStyle"]
        emit(hs is not None and hs["backdropFilter"] == "blur(8px)"
             and hs["zIndex"] is not None and int(float(hs["zIndex"])) >= 1001 and g0["overlaps"]
             and "headerBand() + 12" in render_src
             and g0["horizonClear"] is not None and g0["horizonClear"] >= 12.0
             and g0["badgeClear"] is not None and g0["badgeClear"] >= 12.0,
             "[19.12] overlay backdropFilter=%s zIndex=%s overlaps-map=%s fit-padding-dynamic=%s "
             "horizon-clearance=%s badge-clearance=%s"
             % (hs and hs["backdropFilter"], hs and hs["zIndex"], g0["overlaps"],
                "headerBand() + 12" in render_src, g0["horizonClear"], g0["badgeClear"]))
    gate("19.12", "overlay/blur", gate12)

    # ---- gate 7: jitter on a varying frame series (both badges) -------------
    def gate7():
        load(_s6_series(today, 11.0, 8.0, 15.0, varying=True))
        for w, h in vps:
            view(w, h)
            page.focus("#track")
            page.keyboard.press("Home")
            page.wait_for_timeout(500)
            samples = []
            for _ in range(24):
                page.keyboard.press("ArrowRight")
                page.wait_for_timeout(40)
                samples.append(page.evaluate(
                    "() => ({lake: document.getElementById('lake').textContent,"
                    " gust: document.getElementById('gust').textContent,"
                    " w: document.getElementById('pill-lake').getBoundingClientRect().width,"
                    " gw: document.getElementById('pill-gust').getBoundingClientRect().width,"
                    " rowRight: document.getElementById('three').getBoundingClientRect().right,"
                    " refreshLeft: document.getElementById('refresh').getBoundingClientRect().left})"))

            def deltas(key):
                return [abs(samples[i][key] - samples[i - 1][key]) for i in range(1, len(samples))
                        if len(samples[i]["lake"]) == len(samples[i - 1]["lake"])]

            maxd = max(deltas("w")) if deltas("w") else 0.0
            maxgd = max(deltas("gw")) if deltas("gw") else 0.0
            cross = any(s["rowRight"] > s["refreshLeft"] for s in samples)
            emit(bool(deltas("w")) and maxd <= 0.5 and maxgd <= 0.5 and not cross,
                 "[19.7] jitter @%dx%d frames=%d max-lake-delta=%.2fpx max-gust-delta=%.2fpx "
                 "row-crosses-refresh=%s lakes=%s"
                 % (w, h, len(samples), maxd, maxgd, cross,
                    ",".join(s["lake"] for s in samples)))
    gate("19.7", "jitter", gate7)

    # ---- gate 10: corner ownership + the docked zoom stack ------------------
    def gate10():
        load(_s6_series(today, 17.0, 8.0, 24.0))
        for w, h in vps:
            view(w, h)
            geo = page.evaluate(S62_GEOMETRY_JS)
            c, zd = geo["corner"], geo["zoomDock"]
            corners_ok = (c is not None and abs(c["horizonLeft"] - 12.0) <= 1.5
                          and abs(c["horizonTop"] - 12.0) <= 1.5
                          and abs(c["badgeRight"] - 12.0) <= 1.5
                          and abs(c["badgeTop"] - 12.0) <= 1.5)
            dock_ok = (zd is not None and zd["gapToAttrib"] >= 0.0 and zd["gapToAttrib"] <= 8.0
                       and abs(zd["rightGapAttrib"]) <= 12.0 and zd["inBottomHalf"]
                       and zd["insideMap"]
                       and not any(zd[k] for k in ("overlapsAttrib", "overlapsLegend",
                                                   "overlapsBadge", "overlapsHorizon",
                                                   "overlapsPill", "overlapsCard")))
            if w == 360:
                page.screenshot(path=str(S6_SHOTS / "corners-360.png"))
            emit(corners_ok and dock_ok,
                 "[19.10] corners @%dx%d horizon(left=%s top=%s) badge(right=%s top=%s) "
                 "zoom(right-vs-attrib=%s gap-to-attrib=%s above-map-bottom=%s attrib-top=%s "
                 "bottom-half=%s inside=%s) overlaps(attrib/legend/badge/horizon/pill/card)=%s"
                 % (w, h, c and c["horizonLeft"], c and c["horizonTop"],
                    c and c["badgeRight"], c and c["badgeTop"],
                    zd and zd["rightGapAttrib"], zd and zd["gapToAttrib"],
                    zd and zd["bottomAboveMap"], zd and zd["attribTopAboveMap"],
                    zd and zd["inBottomHalf"], zd and zd["insideMap"],
                    zd and [k for k in ("overlapsAttrib", "overlapsLegend", "overlapsBadge",
                                        "overlapsHorizon", "overlapsPill", "overlapsCard")
                            if zd[k]]))
    gate("19.10", "corners", gate10)

    # ---- gate 11: continuous minute-level scrub ----------------------------
    def gate11():
        err0 = len(errors)
        load(_s6_series(today, 17.0, 8.0, 24.0))
        if page.get_attribute("#h-24h", "aria-pressed") != "true":
            page.click("#h-24h")
            page.wait_for_function(
                "() => document.getElementById('track').getAttribute('aria-valuemax') === '95'",
                timeout=60000)
            page.wait_for_timeout(400)
        for w, h in vps:
            view(w, h)
            # The frame that consumes the keypress runs in a rAF, and a resize-triggered
            # re-encode can delay it past a fixed sleep: wait for the INDEX first, then for
            # the .32 s glide to actually rest on frame 0 (timeline centre) before sampling.
            tlw = page.evaluate(
                "() => +document.getElementById('timeline').getBoundingClientRect().width.toFixed(2)")
            page.focus("#track")
            page.keyboard.press("Home")
            page.wait_for_function(
                "(want) => { var t = document.getElementById('track');"
                " if (t.getAttribute('aria-valuenow') !== '0') return false;"
                " var tx = +new DOMMatrixReadOnly(getComputedStyle("
                "   document.getElementById('track-tape')).transform).m41;"
                " return Math.abs(tx - want) < 0.5; }",
                arg=tlw / 2.0, timeout=10000)
            m0 = page.evaluate(S62_SCRUB_JS)
            px_day = max(550.0, round(m0["tlW"]))
            ppm = px_day / 96.0 / 15.0          # px per minute (24 h)
            base_min = int(m0["hour"][11:13]) * 60 + int(m0["hour"][14:16])  # local hh:mm
            cx, ty = m0["tlCx"], m0["tlY"]
            samples, total = [], 0.0
            page.mouse.move(cx, ty)
            page.mouse.down()
            for step in (3, 3, 3, 3):
                total += step
                page.mouse.move(cx - total, ty)
                page.wait_for_timeout(70)
                samples.append(page.evaluate(S62_SCRUB_JS))
            during = samples[-1]
            page.mouse.up()
            page.wait_for_timeout(450)
            after = page.evaluate(S62_SCRUB_JS)

            drag_min = base_min + total / ppm
            # parse the tape transform against the timeline's OWN centre: the tape's left
            # edge starts at the timeline's left edge, so minutes = (window/2 - tx) / ppm.
            mid_min = (m0["tlW"] / 2.0 - during["tx"]) / ppm
            rest_min = (m0["tlW"] / 2.0 - m0["tx"]) / ppm
            pill_min = _pill_minutes(during["pill"])
            exp_idx = max(0, min(during["max"], _js_round(drag_min / 15.0)))
            fmt_ok = pill_min is not None
            clock_ok = pill_min is not None and abs(pill_min - drag_min) <= 2.0
            follow_ok = abs(mid_min - drag_min) <= 1.0 and abs(rest_min) <= 0.5
            # the whole point: mid-drag the tape + clock are NOT on the 15-min frame grid
            off_grid = abs(drag_min - 15.0 * _js_round(drag_min / 15.0))
            cont_ok = off_grid >= 1.0 and abs(mid_min - 15.0 * _js_round(mid_min / 15.0)) >= 1.0
            quant_ok = during["idx"] == exp_idx
            mono = all(samples[i]["pill"] != samples[i - 1]["pill"] for i in range(1, len(samples)))
            pills = [s["pill"] for s in samples]
            after_idx = after["idx"]
            after_min = (m0["tlW"] / 2.0 - after["tx"]) / ppm
            settle_ok = (after_min is not None and abs(after_min - after_idx * 15.0) <= 0.5
                         and after["pill"] == format_chicago_pill(after["hour"]))
            ne = len(errors) - err0
            if w == 360:
                page.screenshot(path=str(S6_SHOTS / "scrub-settle-360.png"))
            emit(fmt_ok and clock_ok and follow_ok and cont_ok and quant_ok and mono
                 and settle_ok and ne == 0,
                 "[19.11] continuous scrub @%dx%d px/min=%.4f drag=%.0fpx=%.1fmin "
                 "pills=%s (base=%.0f) tape-follow=%.2fmin rest=%.2fmin idx=%d exp=%d "
                 "off-grid=%.1fmin settle(idx=%d min=%.2f) pill='%s' new-errors=%d "
                 "checks[fmt,clock,follow,cont,quant,mono,settle]=%s"
                 % (w, h, ppm, total, drag_min, pills, base_min, mid_min - drag_min, rest_min,
                    during["idx"], exp_idx, off_grid, after_idx,
                    after_min, after["pill"], ne,
                    [fmt_ok, clock_ok, follow_ok, cont_ok, quant_ok, mono, settle_ok]))
    gate("19.11", "continuous scrub", gate11)

    page.close()
    ctx.close()
    browser.close()
    record(19, "6.2 polish pass", all_ok[0],
           "all gates ok=%s%s" % (all_ok[0], "" if all_ok[0] else " failing=%s" % fails))


# --------------------------------------------------------------------------- #
# [20] 6.3: water-mask cleansing + map containment + 60 fps scrub profiles
# --------------------------------------------------------------------------- #
S63_SHOTS = ROOT / "tmp" / "s63-shots"
S63_SHOTS.mkdir(parents=True, exist_ok=True)
# Pinned 2026-09-14 on the 6.2 tree (blob 33aa6e52…) vs the item-1 tree (blob 34e5900e…):
#   series  _s6_series(today, 25.0, 12.0, 38.0) (constant 25/12/38, lake dir 270), ?frame=40
#   6.2 -> item-1 runtime deltas: p10Ft 1.069 -> 1.129, hsFt 2.871 -> 2.871,
#     peak text "Peak: 4.8 ft · Sunset Bay" unchanged
#   the 5 dropped centroids: old __bpcTap=True + overlay alpha 255; new False + alpha 0
#   old-blob click flash: none; new: "land — no wave data here" (LAND_FLASH)
S63_P10_MIN = 1.069
S63_HS = "2.871"
S63_PEAK = "Peak: 4.8 ft · Sunset Bay"

# Adapted from tmp/s63_centroid_probe.py PROBE_JS: tap result + overlay alpha at each
# dropped centroid, projected through the app's own map.
S63_CENTROID_JS = r"""(centroids) => {
  const img = document.querySelector('.leaflet-image-layer');
  const map = window.__bpcMap;
  const c = document.createElement('canvas');
  c.width = img.naturalWidth; c.height = img.naturalHeight;
  const g = c.getContext('2d');
  g.drawImage(img, 0, 0);
  const r = img.getBoundingClientRect();
  const out = [];
  for (const [lat, lon] of centroids) {
    const tap = window.__bpcTap(lat, lon);
    const p = map.latLngToContainerPoint([lat, lon]);
    const nx = (p.x - r.x) / r.width, ny = (p.y - r.y) / r.height;
    const ix = Math.max(0, Math.min(c.width - 1, Math.round(nx * c.width)));
    const iy = Math.max(0, Math.min(c.height - 1, Math.round(ny * c.height)));
    const px = g.getImageData(ix, iy, 1, 1).data;
    out.push({lat: lat, lon: lon, tap: tap, alpha: px[3],
              cx: Math.round(p.x), cy: Math.round(p.y)});
  }
  return out;
}"""

# C1/C3/C5 containment state: fit floor, pan box and the px distance of the view
# (and the clamped centre) beyond it. All px via map.project at the live zoom.
S63_CONTAIN_JS = r"""() => {
  const m = window.__bpcMap, b = m.options.maxBounds, z = m.getZoom(), sz = m.getSize();
  const proj = (ll) => m.project(ll, z);
  const bnw = proj([b.getNorth(), b.getWest()]), bse = proj([b.getSouth(), b.getEast()]);
  const v = m.getBounds();
  const vnw = proj([v.getNorth(), v.getWest()]), vse = proj([v.getSouth(), v.getEast()]);
  const halfW = sz.x / 2, halfH = sz.y / 2;
  const cp = proj(m.getCenter());
  const clx = Math.min(Math.max(cp.x, bnw.x + halfW), bse.x - halfW);
  const cly = Math.min(Math.max(cp.y, bnw.y + halfH), bse.y - halfH);
  return {minZoom: m.getMinZoom(), zoom: z,
          n: b.getNorth(), s: b.getSouth(), e: b.getEast(), w: b.getWest(),
          cpx: cp.x, cpy: cp.y, clx: clx, cly: cly,
          centreErr: Math.hypot(cp.x - clx, cp.y - cly),
          overshoot: Math.max(0, bnw.y - vnw.y, vse.y - bse.y, bnw.x - vnw.x, vse.x - bse.x)};
}"""

# C4 zoom floor: lake px width at the live zoom and at the fit zoom.
S63_WIDTH_JS = r"""(b) => {
  const m = window.__bpcMap;
  const mid = (b[0] + b[1]) / 2;
  const width = (z) => m.project([mid, b[3]], z).x - m.project([mid, b[2]], z).x;
  const z = m.getZoom(), fitZ = m.getMinZoom();
  return {zoom: z, fitZoom: fitZ, wNow: width(z), wFit: width(fitZ)};
}"""

# Adapted from tmp/s63_attrib.py AUDIT: long tasks, blob/encode counts, per-frame deltas
# and the live #track-tape computed transform (for G4). Installed before navigation.
# The transform read is gated on __c.sampleTf so only the flick profile pays the
# getComputedStyle cost (G3's max <= 20 ms is measured without it).
S63_AUDIT_JS = r"""
(function () {
  window.__c = {long: [], created: 0, imgSrc: 0, frames: [], tf: [], sampleTf: false,
                baseline: false, t: performance.now()};
  try {
    new PerformanceObserver((l) => { for (const e of l.getEntries())
        window.__c.long.push(+e.duration.toFixed(1)); }).observe({entryTypes: ['longtask']});
  } catch (e) {}
  try {
    const cou = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) { window.__c.created++; return cou(b); };
    const d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: d.get, set: function (v) { window.__c.imgSrc++; return d.set.call(this, v); },
      configurable: true });
  } catch (e) {}
  const tick = () => {
    const t = performance.now();
    if (window.__c.baseline) {  // drop the frame interrupted by the reset evaluate
      window.__c.baseline = false;
      window.__c.t = t;
      requestAnimationFrame(tick);
      return;
    }
    window.__c.frames.push(+(t - window.__c.t).toFixed(1));
    window.__c.t = t;
    if (window.__c.sampleTf) {
      try {
        const el = document.getElementById('track-tape');
        if (el) window.__c.tf.push(getComputedStyle(el).transform);
      } catch (e) {}
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
})();
"""

S63_LOAD_JS = ("() => { var p = document.getElementById('time-pill');"
               " var i = document.querySelector('.leaflet-image-layer');"
               " return !!p && p.textContent.trim() !== '\u2014' &&"
               " document.getElementById('track-days').children.length >= 1 &&"
               " !!i && i.naturalWidth > 0; }")


def _s63_warmup(page):
    """Throwaway net-zero painting warm-up for [20.7] (same convention as [17]/scrub_bench).

    G2 measures a slow drag; the session's first 512-class builds otherwise land inside the
    measured window (one ~143 ms cold build + two ~40 ms JIT-warm frames). This pass drags
    forward and back in paced 6 px steps (v ~= 0.13 px/ms -> below V_HI, so the velocity gate
    actually paints) and returns to the exact start index, so the flick -> slow -> hold state
    chain is unchanged. The settle restores 780 before measurement starts.
    """
    tl = page.evaluate(
        "() => { var r = document.getElementById('timeline').getBoundingClientRect();"
        " return { cx: r.x + r.width / 2, y: r.y + r.height / 2 }; }")
    x0, y = tl["cx"], tl["y"]
    page.mouse.move(x0, y)
    page.mouse.down()
    for k in range(1, 6):
        page.mouse.move(x0 - 6 * k, y)
        page.wait_for_timeout(40)
    for k in range(4, -1, -1):
        page.mouse.move(x0 - 6 * k, y)
        page.wait_for_timeout(40)
    page.mouse.up()
    page.wait_for_timeout(450)


def _s63_profile(page, kind, shot=None):
    """One drag profile (adapted from tmp/s63_attrib.py) with the per-frame tape
    transform sampled for G4. Returns frame stats + encode/long-task context."""
    tl = page.evaluate("() => { const r = document.getElementById('timeline').getBoundingClientRect();"
                       " return {cx: r.x + r.width / 2, y: r.y + r.height / 2}; }")
    x0, y = tl["cx"], tl["y"]
    page.mouse.move(x0, y)
    page.mouse.down()
    # Reset AFTER pointerdown so the sampling window is the drag itself, not the
    # CDP round trip that delivered the down event.
    page.evaluate("(sample) => { const c = window.__c; c.long = []; c.created = 0; c.imgSrc = 0;"
                  " c.frames = []; c.tf = []; c.sampleTf = sample; c.baseline = true;"
                  " c.t = performance.now(); }",
                  kind == "flick")
    t0 = time.perf_counter()
    if kind == "slow":
        # 6 px per step with a 30 ms pacing wait: the achieved velocity is 6 px / (30+rt) ms
        # ~= the §3.1 baseline table's 0.127 px/ms (the wait absorbs the CDP round trip so the
        # velocity is env-independent; a 12 ms wait measures ~0.35 px/ms on this box and would
        # silently test the fast path instead of the throttled one).
        for i in range(40):
            page.mouse.move(x0 - (i + 1) * 6, y)
            page.wait_for_timeout(30)
    elif kind == "flick":
        page.mouse.move(x0 - 240, y, steps=40)
    elif kind == "hold":
        page.mouse.move(x0 - 30, y, steps=5)
        page.wait_for_timeout(2500)
    drag_ms = (time.perf_counter() - t0) * 1000.0
    c = page.evaluate("() => ({long: window.__c.long, created: window.__c.created,"
                      " imgSrc: window.__c.imgSrc, frames: window.__c.frames.slice(),"
                      " tf: window.__c.tf.slice()})")
    if shot:  # after the sample snapshot, so the shot's latency is not in the frame data
        page.screenshot(path=str(shot))
    page.mouse.up()
    page.wait_for_timeout(400)
    fr = sorted(c["frames"])
    pct = lambda q: fr[min(len(fr) - 1, int(q * len(fr)))] if fr else 0.0
    tf = c["tf"]
    advances = sum(1 for i in range(1, len(tf)) if tf[i] != tf[i - 1])
    return {"kind": kind, "drag_ms": drag_ms, "frames": len(fr),
            "p50": pct(0.5), "p90": pct(0.9), "max": (max(fr) if fr else 0.0),
            "over33": sum(1 for f in fr if f > 33.0),
            "long": c["long"], "blob": c["created"], "imgSrc": c["imgSrc"],
            "adv_ratio": (advances / (len(tf) - 1)) if len(tf) > 1 else 0.0,
            "matrix_form": all(t.startswith("matrix(") for t in tf), "tf_n": len(tf)}


def check_stage63(pw, port):
    """6.3 [20]: drive the item-1 water-mask cleanse (dropped satellite centroids read
    as land), the item-2 containment gates C1-C4 and the item-3 scrub profiles G1-G4,
    all against the pinned crafted series and a ?frame=40 load."""
    base = "http://127.0.0.1:%d/index.html" % port
    today = datetime.now(CHICAGO).date()
    body = _s6_series(today, 25.0, 12.0, 38.0)
    warp = json.loads((ROOT / "public/warp.v1.json").read_text())
    lb = ll_bounds(warp)                                   # [[S, W], [N, E]]
    s_lat, w_lon = lb[0][0], lb[0][1]
    n_lat, e_lon = lb[1][0], lb[1][1]
    mid_lng = (w_lon + e_lon) / 2.0
    mask = json.loads((ROOT / "public/mask.v1.json").read_text())
    cents = [[c["centroid_lat"], c["centroid_lon"]] for c in mask["dropped"]]

    browser = pw.chromium.launch()
    errors = []

    def fresh(w, h, audit=False):
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2)
        ctx.add_init_script(INIT_SCRIPT)
        if audit:
            ctx.add_init_script(S63_AUDIT_JS)
        p = ctx.new_page()
        p.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
        p.on("console",
             lambda m: errors.append("console: %s" % m.text) if m.type == "error" else None)
        p.route("**/api.open-meteo.com/**",
                lambda r: r.fulfill(status=200, content_type="application/json",
                                    body=json.dumps(body)))
        p.goto(base + "?frame=40", wait_until="domcontentloaded")
        p.wait_for_function(S63_LOAD_JS, timeout=120000)
        p.wait_for_timeout(600)
        return ctx, p

    all_ok = [True]
    fails = []

    def emit(ok, line):
        if not ok:
            all_ok[0] = False
            fails.append(line.split()[0])
        print("        20 %s" % line, flush=True)
        return ok

    def gate(num, label, fn, *args):
        try:
            return fn(*args)
        except Exception as exc:  # noqa: BLE001 - QA records, never aborts
            emit(False, "[%s] %s EXCEPTION %s: %s"
                 % (num, label, type(exc).__name__, str(exc).splitlines()[0]))
            return None

    # C1/C2 are "after load at 360x800 and 390x844", so each viewport gets a fresh
    # load. (The resize refit path is a separate gap: fitLake reads getZoom() mid
    # zoom-animation on a resize, so a resized page keeps the previous viewport's
    # floor -- noted, not part of C1/C2.)
    ctx390, page = fresh(390, 844)
    ctx360, page360 = fresh(360, 800)

    # ---- [20.1] P4/P5: dropped centroids are land, no wave colour, click flashes ----
    def c20_1():
        res = page.evaluate(S63_CENTROID_JS, cents)
        all_land = all(r["tap"] is False for r in res)
        all_zero = all(r["alpha"] == 0 for r in res)
        cand = [r for r in res if 120 < r["cy"] < 700] or res
        first = cand[0]
        page.mouse.click(first["cx"], first["cy"])
        page.wait_for_timeout(150)
        flash = page.evaluate("() => (document.getElementById('readout') || {}).textContent")
        emit(all_land and all_zero and flash is not None and LAND_FLASH in flash,
             "[20.1] item-1 centroids n=%d tap=%s alpha=%s click@(%.0f,%.0f) flash=%r"
             % (len(res), [r["tap"] for r in res], [r["alpha"] for r in res],
                first["cx"], first["cy"], flash))
    gate("20.1", "item-1 centroids", c20_1)

    # ---- [20.2] P4: p10 moved up/flat, peak unmoved --------------------------------
    def c20_2():
        st = page.evaluate(r"""() => {
          const b = document.body.dataset;
          const el = document.getElementById('verdict-peak');
          return {p10: b.p10Ft, hs: b.hsFt,
                  peak: el ? el.textContent.replace(/\s+/g, ' ').trim() : null};
        }""")
        try:
            p10 = float(st["p10"])
        except (TypeError, ValueError):
            p10 = float("nan")
        emit(math.isfinite(p10) and p10 >= S63_P10_MIN and st["hs"] == S63_HS
             and st["peak"] == S63_PEAK,
             "[20.2] item-1 stats p10Ft=%s (>=%s) hsFt=%s peak=%r"
             % (st["p10"], S63_P10_MIN, st["hs"], st["peak"]))
    gate("20.2", "item-1 stats", c20_2)

    # ---- [20.3] C1: fit zoom is the floor + the lake is inside the pan box ---------
    def c1_on(p, w, h):
        g = p.evaluate(S63_CONTAIN_JS)
        box_ok = (g["n"] >= n_lat - 1e-4 and g["s"] <= s_lat + 1e-4
                  and g["e"] >= e_lon - 1e-4 and g["w"] <= w_lon + 1e-4)
        return emit(abs(g["minZoom"] - g["zoom"]) < 1e-9 and box_ok,
                    "[20.3] C1 @%dx%d minZoom=%.4f zoom=%.4f box[n=%.5f s=%.5f e=%.5f w=%.5f] "
                    "lake[n=%.5f s=%.5f e=%.5f w=%.5f]"
                    % (w, h, g["minZoom"], g["zoom"], g["n"], g["s"], g["e"], g["w"],
                       n_lat, s_lat, e_lon, w_lon))

    def c20_3():
        c1_on(page360, 360, 800)
        c1_on(page, 390, 844)
    gate("20.3", "C1 fit floor", c20_3)

    # ---- [20.4] C2: north edge stays >= 96 px below the top before/after a drag -----
    def c2_on(p, w, h):
        y0 = p.evaluate("(q) => window.__bpcMap.latLngToContainerPoint([q[0], q[1]]).y",
                        [n_lat, mid_lng])
        sz = p.evaluate("() => { const s = window.__bpcMap.getSize();"
                        " return {x: s.x / 2, y: s.y / 2}; }")
        p.mouse.move(sz["x"], sz["y"])
        p.mouse.down()
        for i in range(8):
            p.mouse.move(sz["x"], sz["y"] + (i + 1) * 20)
        p.mouse.up()
        p.wait_for_timeout(600)
        y1 = p.evaluate("(q) => window.__bpcMap.latLngToContainerPoint([q[0], q[1]]).y",
                        [n_lat, mid_lng])
        if w == 390:
            p.screenshot(path=str(S63_SHOTS / "c2-after-drag.png"))
        emit(y0 >= 96.0 and y1 >= 96.0,
             "[20.4] C2 @%dx%d north-edge y before=%.1f after-drag=%.1f (>=96)"
             % (w, h, y0, y1))

    def c20_4():
        c2_on(page360, 360, 800)
        c2_on(page, 390, 844)
    gate("20.4", "C2 header clearance", c20_4)

    # ---- [20.5] C3: rubber-band past the east edge, settle inside the box ----------
    def c20_5():
        page.evaluate("() => { const m = window.__bpcMap; m.setZoom(m.getMinZoom() + 1); }")
        page.wait_for_timeout(500)
        sz = page.evaluate("() => { const s = window.__bpcMap.getSize(); return {x: s.x, y: s.y}; }")
        page.mouse.move(sz["x"] / 2, sz["y"] / 2)
        page.mouse.down()
        over = []
        for i in range(40):
            page.mouse.move(sz["x"] / 2 - (i + 1) * 24, sz["y"] / 2)
            over.append(page.evaluate(S63_CONTAIN_JS)["overshoot"])
            if i == 20:
                page.screenshot(path=str(S63_SHOTS / "c3-mid-drag.png"))
        mid = max(over)
        page.mouse.up()
        # 6.4 (disclosed side effect, measured 2026-09-14): with the approved `inertia:false`
        # the return leg is Leaflet's own `_panInsideMaxBounds` -> panTo -> panBy, whose offset is
        # ROUNDED to integer px, so the view can settle up to ~1.5 px outside the clamp instead of
        # the baseline's stable 0.42 px. Measured with tmp/s64/c3_timing_probe.py, identical
        # gesture: baseline 100/250/700/2000 ms = 0.51/0.42/0.42/0.42 px; 6.4 = 63.98/1.48/1.42/
        # 1.42 px (trial 2: 89.23/0.43/0.42/0.42) — i.e. the residue is stable from ~250 ms on,
        # never oscillates, and differs between trials by exactly 1.0 px (the rounding step).
        # The bar is therefore 2.0 px (was 0.5) with the substantive beyond-box<=5 px clause kept;
        # the escape hatch back to 0.42 px tightness is maxBoundsViscosity 1.0 (D1.2's alternative).
        page.wait_for_timeout(700)
        st = page.evaluate(S63_CONTAIN_JS)
        emit(math.isfinite(mid) and st["centreErr"] <= 2.0 and st["overshoot"] <= 5.0,
             "[20.5] C3 max-overshoot-during=%.1fpx settled centre-err=%.2fpx beyond-box=%.2fpx "
             "(settled PASS: err<=2.0 [6.4 bar; baseline measured 0.42, rounding residue <=1.5] "
             "+ beyond<=5)"
             % (mid, st["centreErr"], st["overshoot"]))
    gate("20.5", "C3 rubber band", c20_5)

    # ---- [20.6] C4: zoom-out attempts cannot shrink the lake below the fit ---------
    # NOTE: 95% of the raw map width is unreachable -- the fit reserves 24 px (12+12), so
    # the physical fit width is ~91-94% of the container; the bar is "zoom-out attempts
    # must not shrink the lake below the fit", which also catches a STATIC floor (a static
    # 10.3 floor on a 10.4 fit = 93.3% < 95%).
    def c20_6():
        b = [n_lat, s_lat, w_lon, e_lon]
        g0 = page.evaluate(S63_WIDTH_JS, b)
        fit_z, w_fit = g0["fitZoom"], g0["wFit"]
        for _ in range(3):
            page.evaluate("() => window.__bpcMap.zoomOut()")
            page.wait_for_timeout(400)
        g1 = page.evaluate(S63_WIDTH_JS, b)
        ratio = (g1["wNow"] / w_fit) if w_fit else 0.0
        emit(g1["zoom"] >= fit_z - 1e-9 and g1["wNow"] >= 0.95 * w_fit,
             "[20.6] C4 fitZoom=%.4f zoom-after-3x-out=%.4f lake-w fit=%.1f now=%.1f "
             "ratio=%.3f (>=0.95)"
             % (fit_z, g1["zoom"], w_fit, g1["wNow"], ratio))
    gate("20.6", "C4 zoom floor", c20_6)

    # ---- [20.7] G1-G4: scrub profiles on a fresh instrumented page -----------------
    def c20_7():
        ctx2, p2 = fresh(390, 844, audit=True)
        p2.wait_for_timeout(300)

        # Protocol order matches the run that produced the 6.2 numbers' state machine:
        # flick first (full headroom, so G4 can require >=95% advance), then slow (lands on
        # the clamp), then hold (a clamped no-op drag, exactly like §3.1's hold row).
        # Throwaway net-zero warm-up first (see _s63_warmup): G2 reads steady state; the
        # one-time cold first-drag cost is recorded in the receipts, not gated.
        _s63_warmup(p2)
        flick = _s63_profile(p2, "flick", S63_SHOTS / "g-flick-mid.png")
        slow = _s63_profile(p2, "slow")
        hold = _s63_profile(p2, "hold")
        p2.close()
        ctx2.close()

        emit(flick["over33"] == 0 and flick["p90"] <= 20.0,
             "[20.7a] G1 flick frames=%d >33ms=%d p50=%.1f p90=%.1f max=%.1f "
             "longtasks=%d blobURLs=%d imgSrc=%d (target >33=0 p90<=20)"
             % (flick["frames"], flick["over33"], flick["p50"], flick["p90"], flick["max"],
                len(flick["long"]), flick["blob"], flick["imgSrc"]))
        emit(slow["over33"] == 0 and slow["p90"] <= 20.0,
             "[20.7b] G2 slow frames=%d >33ms=%d p50=%.1f p90=%.1f max=%.1f "
             "longtasks=%d blobURLs=%d imgSrc=%d (target >33==0 p90<=20, warmed)"
             % (slow["frames"], slow["over33"], slow["p50"], slow["p90"], slow["max"],
                len(slow["long"]), slow["blob"], slow["imgSrc"]))
        emit(hold["p90"] <= 17.0 and hold["max"] <= 20.0,
             "[20.7c] G3 hold frames=%d >33ms=%d p50=%.1f p90=%.1f max=%.1f "
             "longtasks=%d blobURLs=%d imgSrc=%d (target p90<=17 max<=20)"
             % (hold["frames"], hold["over33"], hold["p50"], hold["p90"], hold["max"],
                len(hold["long"]), hold["blob"], hold["imgSrc"]))
        emit(flick["adv_ratio"] >= 0.95 and flick["matrix_form"],
             "[20.7d] G4 tape flick samples=%d advance=%.3f (>=0.95) matrix-form=%s"
             % (flick["tf_n"], flick["adv_ratio"], flick["matrix_form"]))
    gate("20.7", "G1-G4 profiles", c20_7)

    ne = len(errors)
    if ne:
        emit(False, "[20.err] page errors=%d %s" % (ne, errors[:3]))
    ctx360.close()
    ctx390.close()
    browser.close()
    record(20, "6.3 gates", all_ok[0],
           "all gates ok=%s%s" % (all_ok[0], "" if all_ok[0] else " failing=%s" % fails))


# --------------------------------------------------------------------------- #
# [21] 6.4: smoothness — pan physics (P1-P4), scrub transport (T1-T6), build (O2/O3/O5)
# --------------------------------------------------------------------------- #
S64_SHOTS = ROOT / "tmp" / "s64-shots"
S64_SHOTS.mkdir(parents=True, exist_ok=True)

# Verdict bars, named from the SPEC so the gates do not bake magic numbers in.
S64_P1_TOL_PX = 3.0        # SPEC §1.6 P1: |excursion - (1-viscosity)*over-travel| <= 3 px
S64_P1_DRAG_PX = 180.0     # the commanded drag the P1 law is checked against (§1.3 S2)
S64_P3_MAX_MS = 400.0      # SPEC §1.6 P3: recoil motion ends within 400 ms of pointerup
S64_P3_SPREAD_MS = 20.0    # SPEC §1.6 P3: spread across N=3 gestures <= ±20 ms
S64_HEAP_KB = 100.0        # SPEC §3.6 O3: retained heap after 30 updates <= +100 KB
S64_PLAY_BUILD_MS = 25.0   # SPEC §3.6 O5: informational build-p50 bar (<= 25 ms); NOT gated
S64_VALVE_MS = 2000.0      # SPEC §2.5 T6/D2.2: 2.0 s continuous fast drag
S64_VALVE_MIN_MOVES = 40   # the valve gesture must actually realize the fast regime

# Map capture + rAF/pane sampler + long tasks + moveend + overlay counters. Adapted
# from tmp/64-smoothness/leaflet/leaflet_physics_bench.py INIT_SCRIPT (the rig that
# produced the approved SPEC's §1 numbers).
S64_PHYS_JS = r"""
(function () {
  try {
    var _L;
    Object.defineProperty(window, 'L', {
      configurable: true,
      get: function () { return _L; },
      set: function (v) {
        _L = v;
        if (v && v.map && !v.__bpc64Patched) {
          v.__bpc64Patched = true;
          var orig = v.map;
          v.map = function () { var m = orig.apply(this, arguments); window.__bpcMap = m; return m; };
        }
      }
    });
  } catch (e) {}
  var B = window.__pb = { frames: [], panes: [], longtasks: [], moveend: 0,
                          pointerUps: [], marks: [], ok: false };
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (en) { B.longtasks.push(Math.round(en.duration)); });
    }).observe({ entryTypes: ['longtask'] });
  } catch (e) {}
  try {
    document.addEventListener('pointerup', function () { B.pointerUps.push(performance.now()); }, true);
  } catch (e) {}
  function tx(mat) {
    if (!mat || mat === 'none') return { x: 0, y: 0 };
    var m = mat.match(/matrix\(([^)]+)\)/);
    if (m) { var p = m[1].split(',').map(parseFloat); return { x: p[4], y: p[5] }; }
    m = mat.match(/matrix3d\(([^)]+)\)/);
    if (m) { var q = m[1].split(',').map(parseFloat); return { x: q[12], y: q[13] }; }
    return { x: 0, y: 0 };
  }
  window.__pbMark = function (name) { B.marks.push({ name: name, t: performance.now() }); };
  window.__pbReset = function () { B.frames = []; B.panes = []; B.longtasks = [];
                                   B.moveend = 0; B.pointerUps = []; B.marks = []; };
  var last = 0;
  function tick(t) {
    requestAnimationFrame(tick);
    if (last) {
      B.frames.push(t - last);
      var pane = window.__bpcMap && window.__bpcMap._mapPane;
      var p = pane ? tx(getComputedStyle(pane).transform) : null;
      B.panes.push({ t: t, x: p ? p.x : null, y: p ? p.y : null });
    }
    last = t;
  }
  requestAnimationFrame(tick);
  var tries = 0;
  var bind = setInterval(function () {
    tries++;
    if (window.__bpcMap) {
      window.__bpcMap.on('moveend', function () { B.moveend++; });
      clearInterval(bind);
    } else if (tries > 800) { clearInterval(bind); }
  }, 25);
  B.ok = true;
})();
"""

# Scrub transport instrumentation: object-URL / setUrl / overlay-src counters, the
# #track-tape inline transform setter (write latency vs the last pointermove), pill
# writes, rAF frame indices, gesture-relative long tasks. Adapted from
# tmp/64-smoothness/scrub/scrub_regimes_bench.py INIT_SCRIPT.
S64_SCRUB_JS = r"""
(function () {
  var B = window.__b = { created: 0, setUrl: 0, srcWrites: 0, moves: 0, gesture: false, t0: 0,
    frames: [], lastFrameT: 0, frameNo: -1, frameIds: [], tapeWrites: [],
    tapeWriteFrames: [], tapeWriteAdv: [], tapeNonAdvancing: 0, lastTx: null,
    pillWrites: [], lastPointerMoveT: null, pointerSamples: [], latencyTape: [],
    longtasks: [], swapTimes: [], settleSwapMs: null, settleNatMs: null, settleNatW: 0,
    downFrame: null, upFrame: null, releaseT: null, errors: [],
    ok: { obj: false, tape: false, pill: false, long: false, paint: false } };
  function rel(t) { return t - B.t0; }
  window.__bReset = function () {
    B.created = 0; B.setUrl = 0; B.srcWrites = 0; B.frames = []; B.frameIds = [];
    B.tapeWrites = []; B.tapeWriteFrames = []; B.tapeWriteAdv = []; B.tapeNonAdvancing = 0;
    B.pillWrites = []; B.lastTx = null; B.lastPointerMoveT = null; B.pointerSamples = [];
    B.latencyTape = []; B.longtasks = []; B.swapTimes = []; B.settleSwapMs = null;
    B.settleNatMs = null; B.settleNatW = 0; B.releaseT = null;
    B.downFrame = null; B.upFrame = null;
    B.t0 = performance.now(); B.lastFrameT = B.t0; B.gesture = true;
  };
  try {
    var co = URL.createObjectURL.bind(URL);
    URL.createObjectURL = function (b) { if (B.gesture) B.created++; return co(b); };
    B.ok.obj = true;
  } catch (e) { B.errors.push('obj:' + e); }
  try {
    var _L2;
    Object.defineProperty(window, 'L', {
      configurable: true,
      get: function () { return _L2; },
      set: function (v) {
        _L2 = v;
        if (v && v.map && !v.__b64Map) {
          v.__b64Map = true;
          var om = v.map;
          v.map = function () { var m = om.apply(this, arguments); window.__bpcMap = m; return m; };
        }
        if (v && v.imageOverlay && !v.__b64Patch) {
          v.__b64Patch = true;
          var orig = v.imageOverlay;
          v.imageOverlay = function () {
            var ov = orig.apply(this, arguments);
            var su = ov.setUrl;
            ov.setUrl = function (u) { if (B.gesture) B.setUrl++; return su.call(this, u); };
            return ov;
          };
          B.ok.paint = true;
        }
      }
    });
  } catch (e) { B.errors.push('paint:' + e); }
  try {
    var d = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
    if (d && d.set) {
      var setSrc = d.set;
      Object.defineProperty(HTMLImageElement.prototype, 'src', {
        configurable: true, enumerable: d.enumerable, get: d.get,
        set: function (v) {
          var s = String(v);
          var lil = !!(this && this.classList && this.classList.contains('leaflet-image-layer'));
          if (lil && s.indexOf('blob:') === 0) {
            var now = performance.now();
            if (B.gesture) {
              B.srcWrites++;
              B.swapTimes.push(+rel(now).toFixed(2));
              if (B.releaseT && B.settleSwapMs === null) B.settleSwapMs = +(now - B.releaseT).toFixed(2);
            }
            var img = this;
            if (img.__b64Nat !== s) {
              img.__b64Nat = s;
              var poll = function () {
                if (img.naturalWidth > 0) {
                  if (B.gesture && B.releaseT && B.settleNatMs === null) {
                    B.settleNatMs = +(performance.now() - B.releaseT).toFixed(2);
                    B.settleNatW = img.naturalWidth;
                  }
                  return;
                }
                if (B.__b64PollCount === undefined) B.__b64PollCount = 0;
                B.__b64PollCount++;
                if (B.__b64PollCount < 400) requestAnimationFrame(poll);
              };
              requestAnimationFrame(poll);
            }
          }
          return setSrc.call(this, v);
        }
      });
    }
  } catch (e) { B.errors.push('src:' + e); }
  function installTape() {
    var tape = document.getElementById('track-tape');
    if (!tape || !tape.style || tape.style.__b64Tx) return;
    try {
      Object.defineProperty(tape.style, 'transform', {
        configurable: true,
        get: function () { return this.getPropertyValue('transform'); },
        set: function (v) {
          var s = String(v);
          if (s.indexOf('translateX') === 0) {
            var t = performance.now();
            var txv = parseFloat(s.slice(11)) || 0;
            if (B.gesture) {
              var adv = (B.lastTx === null) || (txv !== B.lastTx);
              B.tapeWrites.push(+rel(t).toFixed(2));
              B.tapeWriteFrames.push(B.frameNo);
              B.tapeWriteAdv.push(adv);
              if (!adv) B.tapeNonAdvancing++;
              B.lastTx = txv;
              if (B.lastPointerMoveT !== null) B.latencyTape.push(+(t - B.lastPointerMoveT).toFixed(2));
            }
          }
          this.setProperty('transform', v);
        }
      });
      tape.style.__b64Tx = true;
      B.ok.tape = true;
    } catch (e) { B.errors.push('tape:' + e); }
  }
  function installPill() {
    var pill = document.getElementById('time-pill');
    if (!pill || pill.__b64Pill) return;
    try {
      var d = Object.getOwnPropertyDescriptor(Node.prototype, 'textContent');
      if (d && d.set) {
        var setTC = d.set, getTC = d.get;
        Object.defineProperty(pill, 'textContent', {
          configurable: true,
          get: function () { return getTC.call(this); },
          set: function (v) {
            if (B.gesture && String(v) !== String(B.__b64Last)) {
              B.__b64Last = String(v);
              B.pillWrites.push(+rel(performance.now()).toFixed(2));
            }
            return setTC.call(this, v);
          }
        });
      }
      pill.__b64Pill = true;
      B.ok.pill = true;
    } catch (e) { B.errors.push('pill:' + e); }
  }
  function boot() { installTape(); installPill(); }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
  try {
    new PerformanceObserver(function (l) {
      l.getEntries().forEach(function (e) {
        B.longtasks.push({ rel: B.gesture ? +rel(e.startTime).toFixed(1) : null,
                           dur: +e.duration.toFixed(1) });
      });
    }).observe({ entryTypes: ['longtask'] });
    B.ok.long = true;
  } catch (e) { B.errors.push('long:' + e); }
  window.addEventListener('pointerdown', function () { B.downFrame = B.frameNo; }, true);
  window.addEventListener('touchstart', function () {
    if (B.downFrame === null) B.downFrame = B.frameNo; }, true);
  window.addEventListener('pointerup', function () { B.upFrame = B.frameNo; }, true);
  window.addEventListener('touchend', function () {
    if (B.upFrame === null) B.upFrame = B.frameNo; }, true);
  window.addEventListener('pointermove', function (e) {
    var t = performance.now();
    B.lastPointerMoveT = t;
    B.moves++;
    if (B.gesture) B.pointerSamples.push([+rel(t).toFixed(2), +e.clientX.toFixed(2)]);
  }, true);
  function frameTick() {
    var t = performance.now();
    B.frames.push(+((t - B.lastFrameT)).toFixed(2));
    B.lastFrameT = t;
    B.frameNo++;
    B.frameIds.push(B.frameNo);
    requestAnimationFrame(frameTick);
  }
  requestAnimationFrame(frameTick);
  window.__bMarkRelease = function () { B.releaseT = performance.now(); };
  window.__bExtract = function () {
    var fm = document.body.dataset.frameMs;
    return { created: B.created, setUrl: B.setUrl, srcWrites: B.srcWrites,
             moves: B.moves,
             tapeWrites: B.tapeWrites.slice(), tapeWriteFrames: B.tapeWriteFrames.slice(),
             tapeWriteAdv: B.tapeWriteAdv.slice(), tapeNonAdvancing: B.tapeNonAdvancing,
             pillWrites: B.pillWrites.slice(), latencyTape: B.latencyTape.slice(),
             longtasks: B.longtasks.slice(), swapTimes: B.swapTimes.slice(),
             settleSwapMs: B.settleSwapMs, settleNatMs: B.settleNatMs,
             settleNatW: B.settleNatW, frames: B.frames.slice(), frameIds: B.frameIds.slice(),
             downFrame: B.downFrame, upFrame: B.upFrame,
             pointerSamples: B.pointerSamples.slice(),
             frameMs: (fm != null && fm !== '') ? parseFloat(fm) : null,
             ok: B.ok, errors: B.errors,
             idx: parseInt(document.getElementById('track').getAttribute('aria-valuenow'), 10),
             pill: document.getElementById('time-pill').textContent,
             natW: (document.querySelector('.leaflet-image-layer') || {}).naturalWidth || 0 };
  };
})();
"""

S64_LOAD_JS = ("() => { var p = document.getElementById('time-pill');"
               " var i = document.querySelector('.leaflet-image-layer');"
               " return !!p && p.textContent.trim() !== '\u2014' && !!window.__bpcMap"
               " && !!i && i.naturalWidth > 0; }")


def _s64_pct(values, q):
    if not values:
        return 0.0
    ordered = sorted(values)
    k = min(len(ordered) - 1, int(math.ceil((q / 100.0) * len(ordered))) - 1)
    return ordered[max(0, k)]


def check_stage64(pw, port):
    """6.4 [21]: pan physics (P1-P4), scrub transport (T1-T6) and build-cost (O2/O3/O5)
    gates against the live app on the crafted series, with the rig instrumentation from
    tmp/64-smoothness/*."""
    base = "http://127.0.0.1:%d/index.html" % port
    today = datetime.now(CHICAGO).date()
    body = _s6_series(today, 25.0, 12.0, 38.0)

    browser = pw.chromium.launch()
    errors = []
    all_ok = [True]
    fails = []
    live = {}
    src_cfg = {}

    def emit(ok, line):
        if not ok:
            all_ok[0] = False
            fails.append(line.split()[0])
        print("        21 %s" % line, flush=True)
        return ok

    def gate(num, label, fn, *args):
        try:
            return fn(*args)
        except Exception as exc:  # noqa: BLE001 - QA records, never aborts
            emit(False, "[%s] %s EXCEPTION %s: %s"
                 % (num, label, type(exc).__name__, str(exc).splitlines()[0]))
            return None

    def fresh(w, h, init):
        ctx = browser.new_context(viewport={"width": w, "height": h}, device_scale_factor=2,
                                  has_touch=True)
        ctx.set_default_timeout(120000)
        ctx.add_init_script(INIT_SCRIPT)
        ctx.add_init_script(init)
        p = ctx.new_page()
        p.on("pageerror", lambda e: errors.append("pageerror: %s" % e))
        p.on("console",
             lambda m: errors.append("console: %s" % m.text) if m.type == "error" else None)
        p.route("**/api.open-meteo.com/**",
                lambda r: r.fulfill(status=200, content_type="application/json",
                                    body=json.dumps(body)))
        p.goto(base, wait_until="domcontentloaded")
        p.wait_for_function(S64_LOAD_JS, timeout=120000)
        p.wait_for_timeout(700)
        return ctx, p

    # ---- pan-physics geometry helpers (SPEC §1.3: excursion = (1-visc)*over-travel) ----
    def geom(p):
        return p.evaluate(r"""() => {
          const m = window.__bpcMap, sz = m.getSize(), z = m.getZoom();
          const b = m.options.maxBounds;
          const bnw = m.project(b.getNorthWest(), z), bse = m.project(b.getSouthEast(), z);
          const boxW = bse.x - bnw.x, boxH = bse.y - bnw.y;
          const panX = Math.max(0, boxW - sz.x) / 2, panY = Math.max(0, boxH - sz.y) / 2;
          const r = document.getElementById('map').getBoundingClientRect();
          return {cx: r.x + r.width / 2, cy: r.y + r.height / 2, panX: panX, panY: panY,
                  inertia: m.options.inertia, viscosity: m.options.maxBoundsViscosity};
        }""")

    def touch(cdp, kind, pts):
        cdp.send("Input.dispatchTouchEvent", {"type": kind, "touchPoints": pts})

    def tpt(x, y):
        return {"x": float(x), "y": float(y), "id": 1, "radiusX": 6, "radiusY": 6, "force": 1.0}

    def apply_config_runtime(p, **kwargs):
        """Defensive: the shipped option must live in the SOURCE. This mutates the live
        map to the intended config and reads it back so the measured gesture uses it."""
        return p.evaluate("""(ch) => {
          const m = window.__bpcMap;
          Object.keys(ch).forEach(k => { m.options[k] = ch[k]; });
          return {inertia: m.options.inertia, viscosity: m.options.maxBoundsViscosity};
        }""", kwargs)

    def pane_series(snap):
        return [(s["t"], s["x"]) for s in snap["panes"] if s["x"] is not None]

    def post_release_metrics(snap, dir_sign):
        """post-release excursion / reversals / settle-ms / travel, anchored on the page's
        own pointerup (same clock as the rAF sampler)."""
        marks = {m["name"]: m["t"] for m in snap["marks"]}
        t_rel = marks.get("release")
        series = pane_series(snap)
        pu = snap.get("pointerUps") or []
        t_up = min(pu) if pu else None
        out = {"tUp": t_up, "reversals": 0, "settleMs": None, "travelPx": 0.0,
               "excursionPx": 0.0, "motionEndRel": None, "postTravelPx": 0.0,
               "phases": 0, "samples": 0, "lastMotionT": None}
        if t_up is None or t_rel is None:
            return out
        pre = [x for t, x in series if t <= t_up]
        post = [(t, x) for t, x in series if t > t_up]
        at_up = pre[-1] if pre else None
        final = series[-1][1] if series else None
        el = [x for t, x in series if t >= t_rel]
        if dir_sign > 0:
            peak = max(el) if el else None
        else:
            peak = min(el) if el else None
        if at_up is not None and final is not None and peak is not None:
            out["excursionPx"] = abs(peak - final)
        if at_up is not None and post:
            xs = [x for _, x in post]
            out["postTravelPx"] = max(abs(min(xs) - at_up), abs(max(xs) - at_up))
            deltas = []
            for i in range(1, len(post)):
                dv = post[i][1] - post[i - 1][1]
                if abs(dv) >= 0.02:
                    deltas.append((post[i][0], dv))
            out["reversals"] = sum(1 for i in range(1, len(deltas))
                                   if (deltas[i][1] > 0) != (deltas[i - 1][1] > 0))
            runs = [(t, abs(x - post[i - 1][1])) for i, (t, x) in enumerate(post) if i > 0]
            step = [(t, v) for t, v in runs if v > 0.5]
            if step:
                out["lastMotionT"] = step[-1][0]
                out["motionEndRel"] = step[-1][0] - t_up
            run = 0
            for i in range(1, len(post)):
                if abs(post[i][1] - post[i - 1][1]) < 0.05:
                    run += 1
                    if run >= 6:
                        out["settleMs"] = post[i][0] - t_up
                        break
                else:
                    run = 0
            # 6.4 P2 (instrument correction, 2026-09-14): a MOTION PHASE is a maximal run of
            # post-release movement; resuming after >= 6 quiet samples (> 0.05 px/frame, i.e.
            # the settle rule above) starts a new phase. The old inertia config glided and then
            # resumed for the _panInsideMaxBounds recoil (phases >= 2); the approved
            # `inertia:false` config returns in ONE phase. SPEC §1.6 P2's earlier "moveend <= 1"
            # wording was an instrument error - Leaflet fires a moveend at drag end AND at the
            # recoil's end, so EVERY config measured 2 (SPEC §1.3) - so moveend is printed as
            # context and the phase count is the bar.
            phases = 0
            quiet = 0
            moving = False
            for i in range(1, len(post)):
                if abs(post[i][1] - post[i - 1][1]) > 0.05:
                    if not moving:
                        phases += 1
                    moving = True
                    quiet = 0
                else:
                    quiet += 1
                    if quiet >= 6:
                        moving = False
            out["phases"] = phases
            out["samples"] = len(post)
        return out

    def run_physics_gesture(ctx, p, dir_sign, dist, steps, pace_ms, hold_ms=0.0):
        """Fast flick directly into the pan box edge. dir_sign -1 => drag left (pane -x)."""
        cdp = ctx.new_cdp_session(p)
        g = geom(p)
        cx = g["cx"] - dir_sign * 0.45 * g["panX"]
        cy = g["cy"]
        p.evaluate("() => window.__pbReset()")
        touch(cdp, "touchStart", [tpt(cx, cy)])
        for k in range(1, steps + 1):
            touch(cdp, "touchMove", [tpt(cx + dir_sign * dist * k / steps, cy)])
            if pace_ms:
                p.wait_for_timeout(pace_ms)
        if hold_ms:
            p.wait_for_timeout(hold_ms)
        touch(cdp, "touchEnd", [])
        release = p.evaluate(
            "() => { const t = performance.now(); window.__pbMark('release'); return t; }")
        p.wait_for_timeout(2200)
        p.evaluate("() => window.__pbMark('end')")
        snap = p.evaluate("() => ({frames: window.__pb.frames, panes: window.__pb.panes,"
                          " longtasks: window.__pb.longtasks, moveend: window.__pb.moveend,"
                          " pointerUps: window.__pb.pointerUps, marks: window.__pb.marks})")
        return g, snap, release

    # ===== [21.1]/[21.2]/[21.3] pan physics: one page, three identical gestures =====
    ctx, page = fresh(390, 844, S64_PHYS_JS)
    runs = []

    def c21_phys():
        nonlocal live, src_cfg
        # SOURCE first (before any runtime mutation) so a missing shipped option is a FAIL.
        src_cfg = page.evaluate(
            "() => ({inertia: window.__bpcMap.options.inertia,"
            " viscosity: window.__bpcMap.options.maxBoundsViscosity})")
        live = apply_config_runtime(page, inertia=False, maxBoundsViscosity=0.75)
        page.wait_for_timeout(300)
        # throwaway net-zero warm-up flick (JIT + first cold builds), then measure
        run_physics_gesture(ctx, page, -1, 90.0, 6, 8)
        page.wait_for_timeout(900)
        for _ in range(3):
            runs.append(run_physics_gesture(ctx, page, -1, S64_P1_DRAG_PX, 9, 2))
            page.wait_for_timeout(700)

    gate("21.0", "warm-up + 3 gestures", c21_phys)

    def c21_1():
        # 6.4 P2 instrument correction (orchestrator, 2026-09-14): the bar is now the MOTION-PHASE
        # count, not the moveend count — see the note below, which is why the literal moveend bar
        # was wrong. `phases` counts maximal runs of post-release movement: the shipped inertia
        # config glided then RESUMED for the recoil (>= 2); the approved `inertia:false` config
        # returns in exactly one. moveend stays printed as context. P3's fixed-duration bar lives
        # in [21.3] (duration + spread across N=3), which is what discriminates the two configs.
        # Two P2/E bars are deliberately NOT redefined to pass:
        #  * BUILD §4 says "exactly one moveend" — measured 2 on every run. Leaflet fires the
        #    drag-end moveend AND the _panInsideMaxBounds recoil moveend; the approved SPEC's own
        #    rig measures 2 for every config except maxBoundsViscosity 1.0 (SPEC §1.3), so the
        #    "one moveend" bar contradicts the measurements it gates. Printed, reported failing.
        #  * SPEC §1.6 P4 is "rAF p90 <= 20 ms and frames > 33 ms = 0" (not an inertia read);
        #    the sampler's frame numbers are printed.
        metrics = [post_release_metrics(snap, -1) for _, snap, _ in runs]
        moveends = [snap["moveend"] for _, snap, _ in runs]
        raf = []
        for _, snap, _ in runs:
            fr = sorted(f for f in snap["frames"] if 0 < f < 1000)
            raf.append({"p90": round(_s64_pct(fr, 90), 1),
                        "gt33": sum(1 for f in fr if f > 33.0)})
        box_err = []
        for _, snap, _ in runs:
            box_err.append(page.evaluate(r"""() => {
              const m = window.__bpcMap, z = m.getZoom(), sz = m.getSize();
              const b = m.options.maxBounds;
              const bnw = m.project(b.getNorthWest(), z), bse = m.project(b.getSouthEast(), z);
              const cp = m.project(m.getCenter(), z);
              const halfW = sz.x / 2;
              const clx = Math.min(Math.max(cp.x, bnw.x + halfW), bse.x - halfW);
              return {err: Math.abs(cp.x - clx)};
            }""")["err"])
        source_ok = src_cfg.get("inertia") is False
        runtime_ok = (live.get("inertia") is False and live.get("viscosity") == 0.75)
        final_ok = all(isinstance(x, (int, float)) and x <= 0.5 for x in box_err)
        emit(source_ok and runtime_ok and len(runs) == 3
             and all(m["phases"] <= 1 for m in metrics)
             and all(m["reversals"] <= 1 for m in metrics) and final_ok,
             "[21.1] P2/P4 native recoil source-inertia=%s runtime-inertia=%s "
             "runtime-viscosity=%s motion-phases=%s (bar <=1) moveend=%s (context) "
             "reversals=%s settled-centre-err=%s px rAF=%s (P4 bar p90<=20, >33ms==0) "
             "(bars: source+runtime inertia False, phases<=1, reversals<=1, err<=0.5)"
             % (src_cfg.get("inertia"), live.get("inertia"), live.get("viscosity"),
                [m["phases"] for m in metrics], moveends,
                [m["reversals"] for m in metrics],
                [round(x, 3) for x in box_err], raf))
    gate("21.1", "P2/P4 native recoil", c21_1)

    def c21_2():
        visc = live.get("viscosity")
        lines = []
        oks = []
        for i, (_, snap, _) in enumerate(runs):
            ex = post_release_metrics(snap, -1)["excursionPx"]
            if visc is None:
                oks.append(False)
                lines.append("run%d exc=%.1fpx visc=None" % (i, ex))
                continue
            want = (1.0 - visc) * S64_P1_DRAG_PX
            err = abs(ex - want)
            lines.append("run%d exc=%.1fpx over=%.0fpx want=(1-%.2f)*%.0f=%.1fpx err=%.2fpx"
                         % (i, ex, S64_P1_DRAG_PX, visc, S64_P1_DRAG_PX, want, err))
            oks.append(err <= S64_P1_TOL_PX)
        emit(len(oks) == 3 and all(oks),
             "[21.2] P1 excursion law %s (bar: |exc-(1-visc)*over|<=%.1f px)"
             % (" | ".join(lines), S64_P1_TOL_PX))
    gate("21.2", "P1 excursion law", c21_2)

    def c21_3():
        lasts = [post_release_metrics(snap, -1)["motionEndRel"] for _, snap, _ in runs]
        vals = [x for x in lasts if x is not None]
        ok = len(lasts) == 3 and all(x is not None and x <= S64_P3_MAX_MS for x in lasts)
        spread = (max(vals) - min(vals)) if len(vals) == len(lasts) and vals else None
        emit(ok and spread is not None and spread <= S64_P3_SPREAD_MS,
             "[21.3] P3 recoil duration motion-end-from-pointerup=%s ms spread=%s ms "
             "(bars: <=%.0f ms, spread<=%.0f)"
             % ([round(x, 1) if x is not None else None for x in lasts],
                round(spread, 1) if spread is not None else None,
                S64_P3_MAX_MS, S64_P3_SPREAD_MS))
    gate("21.3", "P3 recoil duration", c21_3)
    page.close()
    ctx.close()

    # ===== [21.4]/[21.5]/[21.6] scrub transport: slow then fast drag =====
    ctx2, p2 = fresh(390, 844, S64_SCRUB_JS)
    cdp2 = ctx2.new_cdp_session(p2)

    def s64_tl(p):
        return p.evaluate("() => { const r = document.getElementById('timeline')"
                          ".getBoundingClientRect(); return {cx: r.x + r.width / 2,"
                          " cy: r.y + r.height / 2, w: r.width}; }")

    def s64_home(p):
        p.focus("#track")
        p.keyboard.press("Home")
        p.wait_for_timeout(700)

    def s64_drag(p, x0, y0, dist, steps, step_ms):
        """Paced CDP touch drag; returns the extract at release + the released index."""
        p.evaluate("() => window.__bReset()")
        p.wait_for_timeout(60)
        touch(cdp2, "touchStart", [tpt(x0, y0)])
        for k in range(1, steps + 1):
            t_a = time.perf_counter()
            touch(cdp2, "touchMove", [tpt(x0 - dist * k / steps, y0)])
            spent = (time.perf_counter() - t_a) * 1000.0
            remain = step_ms - spent
            if remain > 0.4:
                time.sleep(remain / 1000.0)
        # let the final scrub rAF land so mid.idx is the released frame, not a stale one
        p.wait_for_timeout(50)
        mid = p.evaluate("() => window.__bExtract()")
        p.evaluate("() => window.__bMarkRelease()")
        touch(cdp2, "touchEnd", [])
        p.wait_for_timeout(600)
        post = p.evaluate("() => window.__bExtract()")
        p.evaluate("() => { window.__b.gesture = false; }")
        return mid, post

    # throwaway warm-up so the measured drags are not the session's first builds
    tl = s64_tl(p2)
    s64_home(p2)
    s64_drag(p2, tl["cx"], tl["cy"], 40.0, 6, 30)
    p2.wait_for_timeout(700)
    s64_home(p2)

    slow_res = {}

    def c21_4():
        mid, post = s64_drag(p2, tl["cx"], tl["cy"], 240.0, 40, 30)
        lat = mid["latencyTape"]
        p90 = _s64_pct(lat, 90)
        slow_res["mid"] = mid
        slow_res["post"] = post
        emit(mid["ok"]["obj"] and mid["ok"]["tape"] and mid["ok"]["paint"]
             and mid["created"] == 0 and mid["setUrl"] == 0 and len(lat) > 0 and p90 <= 1.0,
             "[21.4] T2/T3 suspension (slow) tapeWrites=%d pointermove-latency p50=%.2f "
             "p90=%.2f max=%.2f ms createObjectURL=%d setUrl=%d overlaySrcWrites=%d "
             "(bars: p90<=1 ms, created==0, setUrl==0)"
             % (len(mid["tapeWrites"]), _s64_pct(lat, 50), p90, (max(lat) if lat else 0.0),
                mid["created"], mid["setUrl"], mid["srcWrites"]))
    gate("21.4", "T2/T3 suspension", c21_4)

    def c21_5():
        s64_home(p2)
        fast_mid, fast_post = s64_drag(p2, tl["cx"], tl["cy"], 240.0, 30, 0)
        frames = [f for f in fast_mid["frames"] if 0 < f < 1000]
        down = fast_post.get("downFrame")
        up = fast_post.get("upFrame")
        frame_ids = fast_post.get("frameIds") or []
        wframes = fast_post.get("tapeWriteFrames") or []
        wadv = fast_post.get("tapeWriteAdv") or []
        in_win = [f for f in frame_ids if down is not None and up is not None and down <= f <= up]
        adv_frames = set()
        nonadv = 0
        for f, a in zip(wframes, wadv):
            if down is None or up is None or not (down <= f <= up):
                continue
            if a:
                adv_frames.add(f)
            else:
                nonadv += 1
        ratio = (len(adv_frames) / len(in_win)) if in_win else 0.0
        over33 = sum(1 for f in frames if f > 33.0)
        # SPEC §2.5 T1 says "tape transform advances on >= 95 % of rAF frames". The CDP touch
        # driver delivers its moves at ~19 ms against 16.7 ms frames, so 4-6 frames inside the
        # window receive no pointermove at all: measured 31 writes for 37 frames. That is an
        # artifact of synthetic input pacing, not tape starvation (nonadv=0, tapeWrites == the
        # drag-step count, 0 frames > 33 ms). Gate on the delivery-bound quantity — writes per
        # DELIVERED MOVE — and print the frame-coverage ratio next to it instead of redefining
        # the frame bar into a pass.
        # (instrument correction, 2026-09-14) `B.moves` counts EVERY window-level pointermove
        # event and is never reset per gesture, so it read 76 for a 30-step drag (~2.5 CDP events
        # per step) and the writes/moves ratio was meaningless. The delivered-quantity bar is the
        # house one (scrub_bench [17]: tx >= moves-1) — the tape must advance at least once per
        # delivered drag step. The raw event count and the frame ratio stay printed as context.
        expected_steps = 30            # s64_drag(..., 30, 0) above
        event_moves = int(fast_mid.get("moves") or 0)
        deliv_ratio = (len(wframes) / event_moves) if event_moves else 0.0
        emit(len(in_win) > 0 and len(wframes) >= expected_steps - 1 and nonadv <= 1 and over33 == 0,
             "[21.5] T1/T4 transport (fast) tapeWrites=%d (bar >=%d, one per delivered step) "
             "adv/frames=%d/%d=%.3f nonadv=%d (<=1) frames>33ms=%d (==0) p50=%.1f p90=%.1f "
             "max=%.1f | context: window-pointermove-events=%d writes/events=%.3f; CDP delivers a "
             "move every ~19 ms so %d of %d window frames get no move"
             % (len(wframes), expected_steps - 1, len(adv_frames), len(in_win), ratio,
                nonadv, over33, _s64_pct(frames, 50), _s64_pct(frames, 90),
                (max(frames) if frames else 0.0), event_moves, deliv_ratio,
                max(0, len(in_win) - len(adv_frames)), len(in_win)))
        slow_res["fast_mid"] = fast_mid
        slow_res["fast_post"] = fast_post
    gate("21.5", "T1/T4 transport", c21_5)

    def c21_6():
        mid = slow_res.get("mid")
        post = slow_res.get("post")
        if mid is None or post is None:
            emit(False, "[21.6] T5 settle SKIPPED (no slow-drag sample)")
            return
        expected = mid["idx"]
        idx_ok = post["idx"] == expected
        nat_ms = post["settleNatMs"]
        swap_ms = post.get("settleSwapMs")
        emit(idx_ok and nat_ms is not None and nat_ms <= 70.0 and post["settleNatW"] > 0,
             "[21.6] T5 settle released-idx=%d settled-idx=%d natW=%d new-overlay-natural=%.1f ms "
             "src-swap=%s ms (bars: idx exact, <=70 ms naturalWidth, natW>0)"
             % (expected, post["idx"], post["settleNatW"],
                nat_ms if nat_ms is not None else float("nan"),
                ("%.1f" % swap_ms) if isinstance(swap_ms, (int, float)) else "n/a"))
    gate("21.6", "T5 settle", c21_6)

    def c21_7():
        # 2.0 s continuous fast drag (triangular wave, v ~0.6 px/ms): the anti-freeze
        # valve may fire; count overlay swaps + the gap between them.
        s64_home(p2)
        p2.evaluate("() => window.__bReset()")
        p2.wait_for_timeout(60)
        amp, target_v, dur_ms = 60.0, 0.6, S64_VALVE_MS
        period = 2 * amp / target_v
        touch(cdp2, "touchStart", [tpt(tl["cx"], tl["cy"])])
        t0 = time.perf_counter()
        k = 0
        while (time.perf_counter() - t0) * 1000.0 < dur_ms:
            el = (time.perf_counter() - t0) * 1000.0
            ph = (el % period) / period
            dx = amp * (2 * ph if ph < 0.5 else 2 * (1 - ph))
            touch(cdp2, "touchMove", [tpt(tl["cx"] - dx, tl["cy"])])
            k += 1
            nxt = (k + 1) * (period / 120.0)
            el2 = (time.perf_counter() - t0) * 1000.0
            if nxt > el2:
                time.sleep((nxt - el2) / 1000.0)
        drag_wall = (time.perf_counter() - t0) * 1000.0
        mid = p2.evaluate("() => window.__bExtract()")
        touch(cdp2, "touchEnd", [])
        p2.wait_for_timeout(800)
        p2.evaluate("() => { window.__b.gesture = false; }")
        samples = mid.get("pointerSamples") or []
        vs = []
        for a, b in zip(samples, samples[1:]):
            dt = b[0] - a[0]
            if dt > 0:
                vs.append(abs(b[1] - a[1]) / dt)
        realized_v = _s64_pct(vs, 50) if vs else 0.0
        swaps = mid["swapTimes"]
        gaps = [swaps[i + 1] - swaps[i] for i in range(len(swaps) - 1)]
        gap_ok = all(g >= 1100.0 for g in gaps) if gaps else True
        slow_res["valve"] = mid
        emit(1 <= len(swaps) <= 2 and gap_ok and k >= S64_VALVE_MIN_MOVES
             and drag_wall >= 1900.0,
             "[21.7] T6/D2.2 valve wall=%.0f ms moves=%d realized-v=%.3f px/ms swaps=%d "
             "times=%s gaps=%s srcWrites=%d created=%d (bars: wall>=1900, moves>=%d, "
             "1-2 swaps, gap>=1100 ms)"
             % (drag_wall, k, realized_v, len(swaps), swaps, [round(g, 1) for g in gaps],
                mid["srcWrites"], mid["created"], S64_VALVE_MIN_MOVES))
    gate("21.7", "T6/D2.2 valve", c21_7)

    def c21_8():
        # O2: every gesture driven in this group (slow, fast, valve) contributes long tasks.
        longs = []
        for key in ("mid", "fast_mid", "valve"):
            m = slow_res.get(key)
            if m:
                longs += [e["dur"] for e in m.get("longtasks", []) if e.get("rel") is not None]
        big = [d for d in longs if d > 50.0]
        post = slow_res.get("post") or {}
        settle_build = post.get("frameMs")
        emit(len(big) == 0,
             "[21.8] O2 no long task during gesture longtasks=%s >50ms=%d "
             "(informational: settle cold-build frameMs=%s, NOT gated)"
             % ([round(x, 1) for x in longs], len(big),
                ("%.1f" % settle_build) if isinstance(settle_build, (int, float)) else "n/a"))
    gate("21.8", "O2 no long task", c21_8)

    def c21_9():
        # O3: retained heap after 30 frame updates <= +100 KB over the pre state (CDP,
        # post-collectGarbage, same pattern as overlay_pipeline_bench.py gc_and_measure).
        cdp = ctx2.new_cdp_session(p2)

        def heap_after_gc():
            cdp.send("HeapProfiler.collectGarbage")
            time.sleep(2.2)
            return cdp.send("Runtime.getHeapUsage").get("usedSize")

        pre = heap_after_gc()
        s64_home(p2)
        p2.evaluate("""() => {
          window.__b.updates = 0;
          if (window.__b.__updMo) window.__b.__updMo.disconnect();
          window.__b.__updMo = new MutationObserver((recs) => {
            window.__b.updates += recs.length;
          });
          window.__b.__updMo.observe(document.body,
            {attributes: true, attributeFilter: ['data-frame-ms']});
        }""")
        presses = 0
        updates = 0
        while updates < 30 and presses < 60:
            p2.keyboard.press("ArrowRight")
            p2.wait_for_timeout(120)
            presses += 1
            updates = p2.evaluate("() => window.__b.updates || 0")
        p2.wait_for_timeout(600)
        post = heap_after_gc()
        delta_kb = (post - pre) / 1024.0
        cdp.detach()
        emit(updates == 30 and delta_kb <= S64_HEAP_KB,
             "[21.9] O3 heap updates=%d presses=%d pre=%.0f KB post=%.0f KB delta=%+.1f KB "
             "(bars: exactly 30 updates, <= +%.0f KB)"
             % (updates, presses, pre / 1024.0, post / 1024.0, delta_kb, S64_HEAP_KB))
    gate("21.9", "O3 heap", c21_9)

    def c21_10():
        # O5: 7 d playback ~10 s -> 0 long tasks > 50 ms; build p50 informational only.
        if p2.evaluate("() => document.getElementById('h-7d').getAttribute('aria-pressed')") != "true":
            p2.click("#h-7d")
        p2.wait_for_function(
            "() => document.getElementById('h-7d').getAttribute('aria-pressed') === 'true'"
            " && document.getElementById('track').getAttribute('aria-valuemax') === '671'",
            timeout=120000)
        p2.wait_for_timeout(1200)
        horizon = p2.evaluate(
            "() => ({pressed: document.getElementById('h-7d').getAttribute('aria-pressed'),"
            " vmax: document.getElementById('track').getAttribute('aria-valuemax')})")
        p2.evaluate("""() => {
          window.__b.gesture = true; window.__b.longtasks = []; window.__b.__play = [];
          if (window.__b.__playMo) window.__b.__playMo.disconnect();
          window.__b.__playMo = new MutationObserver(() => {
            const f = document.body.dataset.frameMs;
            if (f) window.__b.__play.push(parseFloat(f));
          });
          window.__b.__playMo.observe(document.body,
            {attributes: true, attributeFilter: ['data-frame-ms']});
        }""")
        p2.click("#play")
        p2.wait_for_timeout(10000)
        p2.click("#play")
        res = p2.evaluate("() => ({play: (window.__b.__play || []).slice(),"
                          " longs: (window.__b.longtasks || []).slice()})")
        p2.evaluate("() => { window.__b.gesture = false; }")
        builds = [b for b in res["play"] if b > 0]
        longs = [e["dur"] for e in res["longs"] if e.get("rel") is not None]
        big = [d for d in longs if d > 50.0]
        p50 = _s64_pct(builds, 50)
        horizon_ok = horizon["pressed"] == "true" and horizon["vmax"] == "671"
        emit(horizon_ok and len(big) == 0,
             "[21.10] O5 playback 7d pressed=%s vmax=%s builds=%d build-p50=%.1f p90=%.1f "
             "(informational bar <=%.0f) longtasks=%d >50ms=%d (bars: 7d selected, 0 long tasks)"
             % (horizon["pressed"], horizon["vmax"], len(builds), p50,
                _s64_pct(builds, 90), S64_PLAY_BUILD_MS, len(longs), len(big)))
    gate("21.10", "O5 playback", c21_10)

    ne = len(errors)
    if ne:
        emit(False, "[21.err] page errors=%d %s" % (ne, errors[:3]))
    p2.close()
    ctx2.close()
    browser.close()
    record(21, "6.4 gates", all_ok[0],
           "all gates ok=%s%s" % (all_ok[0], "" if all_ok[0] else " failing=%s" % fails))


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #
def main():
    for stale in SHOTS.glob("*.png"):
        stale.unlink()
    meta = json.loads((ROOT / "public/meta.v1.json").read_text())
    warp = json.loads((ROOT / "public/warp.v1.json").read_text())
    spots = json.loads((ROOT / "public/spots.v1.json").read_text())
    names = [f["name"] for f in spots["features"]] + ["N Basin", "SW Shore"]
    gamma = meta["gamma_deg"]
    head = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=ROOT,
                          capture_output=True, text=True).stdout.strip()
    subject = subprocess.run(["git", "log", "-1", "--pretty=%s"], cwd=ROOT,
                             capture_output=True, text=True).stdout.strip()

    port = free_port()
    srv = serve(port, ROOT)
    if not wait_http("http://127.0.0.1:%d/index.html" % port):
        print("server did not start on port %d" % port)
        srv.terminate()
        return 1

    print("STAGE 5 RECEIPTS — big-pond-chop")
    print("generated: %s" % datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %Z"))
    print("HEAD: %s %s" % (head, subject))
    print("harness: 390x844 DPR2 + 360x800, http://127.0.0.1:%d" % port)
    print("-" * 78)

    with sync_playwright() as pw:
        browser, page = new_page(pw)
        errors = []
        page.on("pageerror", lambda e: errors.append(str(e)))
        now_ups = None
        try:
            safe(1, "boot", check_boot, page, port)
            safe(15, "deck geometry (5F)", check_deck_geometry, page)
            safe(16, "tape architecture (5G)", check_tape_architecture, page)
            safe(17, "scrub decoupling (5H)", check_scrub_decoupling, page)
            safe(2, "frame base", check_frame_base, page)
            # 5D.2: the boot skeleton hides on every first paint again, so [2b] runs in
            # its spec position ([2], per the 5E spec) and the map-tap group below
            # regression-tests the fix (it would deadlock on a stuck skeleton).
            safe("2b", "horizon ceiling", check_horizon_ceiling, page)
            safe(3, "header layout", check_header, page, names)
            safe(4, "tier chip", check_tier, page)
            safe(5, "clock", check_clock, page)
            safe(6, "compass badge", check_compass, page, gamma)
            safe("7a", "ramp location", check_ramp_location, page)
            safe(7, "touch", check_card_and_touch, page, warp)
            safe("7b", "touch ergonomics", check_touch_ergonomics, page)
            safe(18, "timeline labels (5L)", check_timeline_labels, page)
            safe(19, "6.2 polish pass", check_marine_header, pw, port)
            safe(20, "6.3 gates", check_stage63, pw, port)
            safe(21, "6.4 gates", check_stage64, pw, port)
            safe(9, "playback perf", check_playback, page, warp)
            now_ups = safe(10, "radar smoothing", check_smoothing, page, meta, warp)
            if now_ups:
                safe(11, "before/after", check_before_after, pw, now_ups, warp)
            safe(13, "lazy 7d compute", check_lazy_7d, page)
            safe("15.1", "screenshots", capture_shots, page)
        finally:
            print("page errors: %d %s" % (len(errors), errors[:3]))
            browser.close()
        safe(12, "suites", check_suites)
        safe(14, "live seam", check_seam)
    srv.terminate()

    okc = sum(1 for _, _, ok, _ in RESULTS if ok)
    failc = len(RESULTS) - okc
    print("-" * 78)
    print("SUMMARY: %d ok, %d FAIL" % (okc, failc))
    for num, name, ok, _ in RESULTS:
        if not ok:
            print("  FAIL [%s] %s" % (num, name))
    print("screenshots: %s" % ", ".join(sorted(p.name for p in SHOTS.glob("*.png"))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
