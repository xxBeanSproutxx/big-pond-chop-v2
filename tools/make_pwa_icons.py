#!/usr/bin/env python3
"""Generate the PWA icons for big-pond-chop from public/favicon.svg.

Re-runnable and deterministic: reads the two wave paths straight out of the
favicon, re-centres that exact geometry inside the 80% maskable safe zone on a
full-bleed #0f172a canvas, and renders public/icon-512.png + public/icon-192.png
with cairosvg. Verifies dimensions, mode, the #0f172a corners and that both
wave strokes survive inside the safe zone.

Run: /home/reid/.hermes/hermes-agent/venv/bin/python tools/make_pwa_icons.py
"""
import re
import sys
from pathlib import Path

import cairosvg
from PIL import Image

ROOT = Path(__file__).resolve().parents[1]
FAVICON = ROOT / "public" / "favicon.svg"
BG = "#0f172a"
SIZES = (512, 192)

# favicon viewBox is 32x32. Scale by k=13 and translate so the wave glyph band
# (x 1.7..30.3, y 12.7..25.3 including the 2.6 stroke) lands centred in the
# safe zone. Derived from the favicon geometry, not hand-waved.
K = 13.0
TX = 256.0 - 16.0 * K     # glyph x-centre 16 -> 256
TY = 256.0 - 19.0 * K     # glyph y-centre 19 -> 256


def wave_paths(svg):
    out = []
    for tag in re.findall(r"<path\b[^>]*>", svg):
        def attr(name):
            m = re.search(r'%s="([^"]+)"' % name, tag)
            return m.group(1) if m else None
        out.append((attr("d"), attr("stroke"), attr("stroke-width"),
                    attr("stroke-linecap") or "round"))
    return out


def compose(svg):
    paths = "\n".join(
        '  <path d="%s" fill="none" stroke="%s" stroke-width="%s" '
        'stroke-linecap="%s" stroke-linejoin="round"/>' % (d, s, w, lc)
        for d, s, w, lc in wave_paths(svg))
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" '
        'width="512" height="512">\n'
        '  <rect width="512" height="512" fill="%s"/>\n'
        '  <g transform="translate(%g,%g) scale(%g)">\n%s\n  </g>\n</svg>\n'
        % (BG, TX, TY, K, paths))


def verify(png, size):
    im = Image.open(png)
    assert im.size == (size, size), "%s size %s != %d" % (png.name, im.size, size)
    assert im.mode in ("RGBA", "RGB"), "%s mode %s" % (png.name, im.mode)
    px = im.convert("RGB").load()
    corners = [(1, 1), (size - 2, 1), (1, size - 2), (size - 2, size - 2)]
    for c in corners:
        got = px[c]
        assert all(abs(a - b) <= 4 for a, b in zip(got, (15, 23, 42))), \
            "%s corner %s = %s (want #0f172a)" % (png.name, c, got)
    lo, hi = int(size * 0.1) + 2, int(size * 0.9) - 2
    cyan = amber = 0
    for y in range(lo, hi, 3):
        for x in range(lo, hi, 3):
            r, g, b = px[x, y]
            if abs(r - 0x06) <= 30 and abs(g - 0xB6) <= 30 and abs(b - 0xD4) <= 30:
                cyan += 1
            if abs(r - 0xF5) <= 30 and abs(g - 0x9E) <= 30 and abs(b - 0x0B) <= 30:
                amber += 1
    assert cyan and amber, "%s strokes missing in safe zone cyan=%d amber=%d" % (
        png.name, cyan, amber)
    print("icon %-14s %dx%d mode=%s corners=#0f172a cyan=%d amber=%d"
          % (png.name, size, size, im.mode, cyan, amber))


def main():
    svg = FAVICON.read_text()
    composed = compose(svg)
    for size in SIZES:
        png = ROOT / "public" / ("icon-%d.png" % size)
        cairosvg.svg2png(bytestring=composed.encode("utf-8"),
                         write_to=str(png), output_width=size, output_height=size)
    for size in SIZES:
        verify(ROOT / "public" / ("icon-%d.png" % size), size)
    return 0


if __name__ == "__main__":
    sys.exit(main())
