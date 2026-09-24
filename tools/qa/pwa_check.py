#!/usr/bin/env python3
"""Stage 7.0 PWA installability gates — big-pond-chop.

Local mode (default) rehearses the GitHub Pages subpath exactly:
  /tmp/bpc-pages-root/big-pond-chop  ->  <repo>
and drives http://127.0.0.1:PORT/big-pond-chop/index.html in headless
Chromium. `--live` runs the HTTP/manifest/installability subset against the
deployed site plus a cache-busted marker check.

Every check prints `ok`/`FAIL` with the measured value. The harness always runs
to completion, exits 0, and ends with `SUMMARY: N ok, M FAIL`.

Run: /home/reid/.hermes/hermes-agent/venv/bin/python tools/qa/pwa_check.py [--live]
"""
import argparse
import functools
import http.server
import json
import shutil
import socket
import statistics
import subprocess
import sys
import threading
import time
import urllib.error
import urllib.request
from pathlib import Path
from urllib.parse import urljoin

try:
    from playwright.sync_api import sync_playwright
except ImportError:  # pragma: no cover
    print("playwright is required: run with /home/reid/.hermes/hermes-agent/venv/bin/python")
    sys.exit(2)

ROOT = Path(__file__).resolve().parents[2]
PAGES_ROOT = Path("/tmp/bpc-pages-root")
LIVE_ROOT = "https://xxbeansproutxx.github.io/big-pond-chop/"
APP_TITLE = "Big Pond Chop | Mille Lacs Lake Wave Forecast"

RESULTS = []

PRECACHE = [
    "./", "./index.html",
    "./src/tables.js", "./src/wave-math.js", "./src/wind.js", "./src/ui.js", "./src/render.js",
    "./public/vendor/leaflet/leaflet.js", "./public/vendor/leaflet/leaflet.css",
    "./public/vendor/leaflet/images/layers.png", "./public/vendor/leaflet/images/layers-2x.png",
    "./public/vendor/leaflet/images/marker-icon.png", "./public/vendor/leaflet/images/marker-icon-2x.png",
    "./public/vendor/leaflet/images/marker-shadow.png",
    "./public/meta.v1.json", "./public/mask.v1.json", "./public/spots.v1.json",
    "./public/warp.v1.json", "./public/tables.v1.bin",
    "./public/favicon.svg", "./public/icon-192.png", "./public/icon-512.png",
    "./manifest.webmanifest",
]

BOOT_PRED = ("() => !!document.getElementById('map') && "
             "document.getElementById('track-days').children.length >= 1")

# The app's own documented degraded state: map is up but the Open-Meteo wind
# fetch failed, so the deck is empty and the #note toast is *shown*. The static
# #note-msg text is always present (hidden via display:none), so visibility must
# be part of the predicate or it matches mid-boot and the gate measures nothing.
WIND_DOWN_PRED = ("() => { const m = document.getElementById('map');"
                  " const n = document.getElementById('note-msg');"
                  " const note = document.getElementById('note');"
                  " return !!m && !!n && !!note &&"
                  " getComputedStyle(note).display !== 'none' &&"
                  " n.textContent.indexOf('wind unavailable') !== -1; }")

READY_PRED = ("() => (%s)() || (%s)()" % (BOOT_PRED, WIND_DOWN_PRED))

MANIFEST = {
    "name": "Big Pond Chop v2",
    "short_name": "Big Pond Chop v2",
    "description": "Live wave and wind forecast for Mille Lacs Lake.",
    "start_url": "./",
    "scope": "./",
    "display": "standalone",
    "background_color": "#0f172a",
    "theme_color": "#0f172a",
    "orientation": "portrait-primary",
    "prefer_related_applications": False,
    "icons": [
        {"src": "public/icon-192.png", "sizes": "192x192", "type": "image/png",
         "purpose": "any maskable"},
        {"src": "public/icon-512.png", "sizes": "512x512", "type": "image/png",
         "purpose": "any maskable"},
    ],
}


# --------------------------------------------------------------------------- #
# harness plumbing
# --------------------------------------------------------------------------- #
def record(num, name, ok, detail):
    RESULTS.append((num, name, bool(ok), detail))
    print("[%s] %-24s %s %s" % (num, name, "ok  " if ok else "FAIL", detail), flush=True)


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


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = dict(http.server.SimpleHTTPRequestHandler.extensions_map)
    extensions_map[".webmanifest"] = "application/manifest+json"
    extensions_map[".json"] = "application/manifest+json"

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, no-cache, must-revalidate")
        self.send_header("Pragma", "no-cache")
        self.send_header("Expires", "0")
        super().end_headers()

    def log_message(self, *args):
        pass


def serve(port):
    httpd = http.server.ThreadingHTTPServer(
        ("127.0.0.1", port), functools.partial(Handler, directory=str(PAGES_ROOT)))
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd


def wait_http(url, timeout=15):
    end = time.time() + timeout
    while time.time() < end:
        try:
            with urllib.request.urlopen(url, timeout=2) as r:
                if r.status == 200:
                    return True
        except Exception:  # noqa: BLE001
            time.sleep(0.2)
    return False


def http_get(url, timeout=20):
    req = urllib.request.Request(url, headers={"Cache-Control": "no-cache", "Pragma": "no-cache"})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, {k.lower(): v for k, v in r.headers.items()}, r.read()
    except urllib.error.HTTPError as e:
        return e.code, {k.lower(): v for k, v in e.headers.items()}, b""


def png_dims(data):
    assert data[:8] == b"\x89PNG\r\n\x1a\n", "not a PNG"
    return int.from_bytes(data[16:20], "big"), int.from_bytes(data[20:24], "big")


# --------------------------------------------------------------------------- #
# HTTP checks
# --------------------------------------------------------------------------- #
def check_precache(base):
    bad = []
    for u in PRECACHE:
        code, _, _ = http_get(urljoin(base, u))
        if code != 200:
            bad.append("%s=%s" % (u, code))
    record(1, "precache 200", not bad,
           "%d/%d 200; non-200=%s" % (len(PRECACHE) - len(bad), len(PRECACHE), bad or "none"))


def check_manifest_http(base):
    code, headers, body = http_get(urljoin(base, "manifest.webmanifest"))
    ctype = headers.get("content-type", "")
    try:
        parsed = json.loads(body)
        parse_ok = True
    except Exception:  # noqa: BLE001
        parsed, parse_ok = None, False
    record(2, "manifest served", code == 200 and "manifest+json" in ctype and parse_ok,
           "HTTP %d ctype='%s' json=%s" % (code, ctype, parse_ok))
    return parsed


def check_manifest_fields(parsed):
    if not isinstance(parsed, dict):
        record(3, "manifest fields", False, "manifest not a JSON object")
        return
    mism, extra = [], [k for k in parsed if k not in MANIFEST]
    for k, v in MANIFEST.items():
        good = parsed.get(k) == v
        if not good:
            mism.append("%s: got %r want %r" % (k, parsed.get(k), v))
        print("        field %-26s %s" % (k, "ok" if good else "MISMATCH"))
    record(3, "manifest fields", not mism and not extra,
           "checked=%d mismatches=%d extra=%s" % (len(MANIFEST), len(mism), extra or "none"))
    for m in mism:
        print("        %s" % m)


def check_url_math(base):
    murl = urljoin(base, "manifest.webmanifest")
    start = urljoin(murl, MANIFEST["start_url"])
    scope = urljoin(murl, MANIFEST["scope"])
    record(4, "URL math", start == base and scope == base,
           "start=%s scope=%s app-root=%s" % (start, scope, base))


def check_icons(base, parsed):
    icons = (parsed or {}).get("icons", [])
    ok, details = bool(icons), []
    for icon in icons:
        code, headers, data = http_get(urljoin(base, icon["src"]))
        try:
            dims = png_dims(data)
        except Exception:  # noqa: BLE001
            dims = None
        want = tuple(int(x) for x in icon["sizes"].split("x"))
        good = (code == 200 and headers.get("content-type", "").startswith("image/png")
                and dims == want)
        ok = ok and good
        details.append("%s HTTP %d %s dims=%s want=%s" % (
            icon["src"], code, headers.get("content-type"), dims, want))
    record(5, "icon urls", ok, "; ".join(details))


# --------------------------------------------------------------------------- #
# browser checks
# --------------------------------------------------------------------------- #
def boot_diagnostics(attempt, page, elapsed, bad_requests, response_lines):
    lines = ["  [attempt %d] timed out after %.1fs" % (attempt, elapsed)]
    try:
        lines.append("  document.readyState=%s" % page.evaluate("() => document.readyState"))
    except Exception as exc:  # noqa: BLE001 - diagnostics must never mask the FAIL
        lines.append("  document.readyState=<unavailable %s>" % type(exc).__name__)
    try:
        note = page.evaluate(
            "() => { const n = document.getElementById('note-msg');"
            " return n ? n.textContent.trim() : null; }")
    except Exception as exc:  # noqa: BLE001
        note = "<unavailable %s>" % type(exc).__name__
    lines.append("  #note-msg=%r" % note)
    lines.append("  failed/4xx recorded=%d" % len(bad_requests))
    lines.append("  last responses>=400=%s" % (response_lines[-5:] or "none"))
    return lines


def _is_open_meteo(console_error):
    """An error attributable to the external weather API — by message or source URL.

    A 503 surfaces as two console errors: the browser's own
    'Failed to load resource...503' (open-meteo only in its location URL, not its
    text) and the app's `Error: open-meteo HTTP 503`. Both are external evidence.
    """
    return ("open-meteo" in console_error["text"]
            or "open-meteo" in console_error["url"])


def check_fresh(page, page_url, page_errors, console_errors, bad_requests, response_lines):
    diags, boot, attempt = [], None, 0
    for attempt in (1, 2):
        t0 = time.time()
        try:
            page.goto(page_url, wait_until="load", timeout=60000)
            page.wait_for_function(READY_PRED, timeout=60000)
        except Exception:  # noqa: BLE001 - a transient cold-boot hang gets one retry
            diags.extend(boot_diagnostics(attempt, page, time.time() - t0,
                                          bad_requests, response_lines))
            continue
        boot = time.time() - t0
        break
    other = [b for b in bad_requests if "/favicon.ico" not in b]
    if boot is None:
        for line in diags:
            print(line, flush=True)
        record(6, "fresh load clean", False,
               "boot=FAIL attempts=%d pageerror=%d console.error=%d other-failed=%s" % (
                   attempt, len(page_errors), len(console_errors), other or "none"))
        return None

    booted = page.evaluate(BOOT_PRED)
    wind_down = page.evaluate(WIND_DOWN_PRED)
    if booted:
        ok = not page_errors and not console_errors and not other
        detail = "boot=%.1fs attempt=%d wind=live pageerror=%d console.error=%d other-failed=%s" % (
            boot, attempt, len(page_errors), len(console_errors), other or "none")
    else:
        # Tolerated ONLY as the app's own degraded retry state, and ONLY when the
        # captured errors all point at Open-Meteo, with no other failed request.
        om_errors = [ce for ce in console_errors if _is_open_meteo(ce)]
        all_om = all(_is_open_meteo(ce) for ce in console_errors)
        other_foreign = [b for b in other if "open-meteo" not in b]
        for line in om_errors[:3]:
            print("        console.error: %s" % line["text"], flush=True)
        ok = (wind_down and not page_errors and bool(om_errors) and all_om
              and not other_foreign)
        detail = ("boot=%.1fs attempt=%d wind=DOWN(external) open-meteo-errors=%d "
                  "pageerror=%d other-failed=%s" % (
                      boot, attempt, len(om_errors), len(page_errors),
                      other_foreign or "none"))
    record(6, "fresh load clean", ok, detail)
    return boot


def check_sw(page, base):
    page.wait_for_function(
        "async () => { const r = await navigator.serviceWorker.ready;"
        " return !!(r.active && r.active.state === 'activated'); }", timeout=60000)
    scope = page.evaluate("async () => (await navigator.serviceWorker.ready).scope")
    state = page.evaluate("async () => (await navigator.serviceWorker.ready).active.state")
    record(7, "SW registered", scope == base and state == "activated",
           "scope=%s state=%s want=%s" % (scope, state, base))


def check_sw_controls(page):
    page.reload(wait_until="load", timeout=60000)
    # NB: a sync predicate — Playwright does not await an async one, so it would
    # resolve immediately on the truthy Promise and read the deck before boot.
    # Same wind-down tolerance as [6]: a controlled, mapped page passes when it
    # has either a populated deck or is showing the app's own retry state.
    handle = page.wait_for_function(
        "() => { if (!navigator.serviceWorker.controller) return null;"
        " const m = document.getElementById('map');"
        " if (!m) return null;"
        " const d = document.getElementById('track-days');"
        " const deck = d ? d.children.length : 0;"
        " const n = document.getElementById('note-msg');"
        " const note = document.getElementById('note');"
        " const down = !!(n && note &&"
        " getComputedStyle(note).display !== 'none' &&"
        " n.textContent.indexOf('wind unavailable') !== -1);"
        " if (deck < 1 && !down) return null;"
        " return {controller: true, map: true, deck: deck,"
        " wind: down ? 'DOWN(external)' : 'live'}; }",
        timeout=120000)
    m = handle.json_value()
    record(8, "SW controls page", m["controller"] and m["map"] and (m["deck"] >= 1 or m["wind"] != "live"),
           "controller=%s map=%s deck-ticks=%d wind=%s" % (
               m["controller"], m["map"], m["deck"], m["wind"]))


def check_cdp(ctx, page):
    cdp = ctx.new_cdp_session(page)
    cdp.send("Page.enable")
    man = cdp.send("Page.getAppManifest")
    m_errors = man.get("errors") or []
    install = cdp.send("Page.getInstallabilityErrors").get("installabilityErrors", [])
    record(9, "CDP installable", not m_errors and not install,
           "manifest-url=%s parse-errors=%s installabilityErrors=%s" % (
               man.get("url"), m_errors or "none", install or "none"))


def check_offline(ctx, page):
    ctx.set_offline(True)
    try:
        page.reload(wait_until="load", timeout=60000)
        title = page.title()
        has_map = page.evaluate("() => !!document.getElementById('map')")
    finally:
        ctx.set_offline(False)
    record(10, "offline shell", has_map and title == APP_TITLE,
           "title='%s' map=%s" % (title, has_map))


def check_regression():
    r = subprocess.run(["git", "status", "--porcelain", "src/"], cwd=ROOT,
                       capture_output=True, text=True)
    src_clean = r.stdout.strip() == ""
    suite_ok, tails = True, []
    for name in ("parity", "wind", "render", "ui"):
        s = subprocess.run(["node", "tests/%s.test.js" % name], cwd=ROOT,
                           capture_output=True, text=True)
        tails.append("%s:%s" % (name, "pass" if s.returncode == 0 else "FAIL"))
        suite_ok = suite_ok and s.returncode == 0
    record(11, "regression guard", src_clean and suite_ok,
           "src-clean=%s suites=%s" % (src_clean, " ".join(tails)))


def check_deploy_markers(base):
    cb = int(time.time())
    mcode, mheaders, mbody = http_get(urljoin(base, "manifest.webmanifest?cb=%d" % cb))
    scode, _, sbody = http_get(urljoin(base, "sw.js?cb=%d" % cb))
    man_marker = b"Big Pond Chop v2" in mbody
    sw_marker = b"bpc-cache-v2" in sbody
    record(12, "deploy markers",
           mcode == 200 and scode == 200 and man_marker and sw_marker,
           "manifest HTTP %d ctype=%s marker=%s; sw HTTP %d marker=%s" % (
               mcode, mheaders.get("content-type"), man_marker, scode, sw_marker))


# --------------------------------------------------------------------------- #
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--repeat", type=int, default=1)
    args = ap.parse_args()
    reps = max(1, args.repeat)

    httpd = None
    if args.live:
        base = LIVE_ROOT
        print("STAGE 7.0 PWA GATES — big-pond-chop (LIVE)")
    else:
        PAGES_ROOT.mkdir(parents=True, exist_ok=True)
        link = PAGES_ROOT / "big-pond-chop"
        if link.is_symlink():
            link.unlink()
        elif link.is_dir():
            shutil.rmtree(link)
        elif link.exists():
            link.unlink()
        link.symlink_to(ROOT)
        port = free_port()
        httpd = serve(port)
        base = "http://127.0.0.1:%d/big-pond-chop/" % port
        if not wait_http(urljoin(base, "index.html")):
            print("server did not start on port %d" % port)
            httpd.shutdown()
            return 1
        print("STAGE 7.0 PWA GATES — big-pond-chop")
        print("serving %s  at  %s" % (PAGES_ROOT, base))
    print("generated: %s" % time.strftime("%Y-%m-%d %H:%M:%S %Z"))
    print("-" * 78)

    page_url = urljoin(base, "index.html")
    try:
        safe(1, "precache 200", check_precache, base)
        parsed = safe(2, "manifest served", check_manifest_http, base)
        safe(3, "manifest fields", check_manifest_fields, parsed)
        safe(4, "URL math", check_url_math, base)
        safe(5, "icon urls", check_icons, base, parsed)

        boot_times, hangs = [], 0
        with sync_playwright() as pw:
            browser = pw.chromium.launch()
            for _run in range(reps):
                ctx = browser.new_context(viewport={"width": 390, "height": 844},
                                          device_scale_factor=2)
                page = ctx.new_page()
                page_errors, console_errors, bad_requests, response_lines = [], [], [], []
                ok_urls = set()
                page.on("pageerror", lambda e: page_errors.append(str(e)))
                page.on("console",
                        lambda m: console_errors.append(
                            {"text": m.text, "url": (m.location or {}).get("url", "")})
                        if m.type == "error" else None)
                # Chromium can emit a spurious net::ERR_ABORTED for a fetch whose body
                # already arrived as a 2xx (observed on tables.v1.bin); only count a
                # requestfailed when that URL never produced a successful response.
                page.on("requestfailed",
                        lambda r: bad_requests.append("failed %s" % r.url)
                        if r.url not in ok_urls else None)
                page.on("response",
                        lambda r: (ok_urls.add(r.url) if r.status < 400 else
                                   (bad_requests.append("%d %s" % (r.status, r.url)),
                                    response_lines.append("%d %s" % (r.status, r.url)))))
                try:
                    bt = safe(6, "fresh load clean", check_fresh, page, page_url,
                              page_errors, console_errors, bad_requests, response_lines)
                    if bt is None:
                        hangs += 1
                    else:
                        boot_times.append(bt)
                    if not args.live:
                        safe(7, "SW registered", check_sw, page, base)
                        safe(8, "SW controls page", check_sw_controls, page)
                    safe(9, "CDP installable", check_cdp, ctx, page)
                    if not args.live:
                        safe(10, "offline shell", check_offline, ctx, page)
                finally:
                    ctx.close()
            browser.close()

        if args.live:
            safe(12, "deploy markers", check_deploy_markers, base)
        else:
            safe(11, "regression guard", check_regression)
    finally:
        if httpd:
            httpd.shutdown()

    okc = sum(1 for _, _, ok, _ in RESULTS if ok)
    failc = len(RESULTS) - okc
    print("-" * 78)
    print("SUMMARY: %d ok, %d FAIL" % (okc, failc))
    if reps > 1:
        if boot_times:
            print("boot times: [%s] min=%.1f median=%.1f max=%.1f spread=%.1f hangs=%d/%d" % (
                ", ".join("%.1f" % b for b in boot_times), min(boot_times),
                statistics.median(boot_times), max(boot_times),
                max(boot_times) - min(boot_times), hangs, reps))
        else:
            print("boot times: [] min=n/a median=n/a max=n/a spread=n/a hangs=%d/%d" % (
                hangs, reps))
    for num, name, ok, _ in RESULTS:
        if not ok:
            print("  FAIL [%s] %s" % (num, name))
    return 0


if __name__ == "__main__":
    sys.exit(main())
