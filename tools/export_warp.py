#!/usr/bin/env python3
"""Stage 2 export: least-squares affine warp between the bathy grid and WGS84.

Implements docs/BUILD-SPEC-STAGE2.md section 4. Fits two 2-D affine maps over the
292x285 / 100 m bathy grid using pyproj EPSG:32615 <-> EPSG:4326:

  grid_to_lonlat      lon = a*col + b*row + c   (coeffs [a,b,c])
  grid_to_lonlat_row  lat = a*col + b*row + c
  lonlat_to_grid      col = a*lon + b*lat + c
  lonlat_to_grid_row  row = a*lon + b*lat + c

Residual is the worst-case Euclidean error in metres, measured by pushing the
affine prediction back through pyproj to UTM and comparing to the exact UTM
coordinate. numpy + pyproj only (no GDAL/rasterio).
"""
import json
import os
import time
import numpy as np
from pyproj import Transformer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "public", "warp.v1.json")

E0, N0, CELL = 436230.0, 5135360.0, 100.0
ROWS, COLS = 292, 285
EPSG = "EPSG:32615"


def main():
    t0 = time.time()
    fwd = Transformer.from_crs(EPSG, "EPSG:4326", always_xy=True)
    inv = Transformer.from_crs("EPSG:4326", EPSG, always_xy=True)

    cc, rr = np.meshgrid(np.arange(COLS, dtype=np.float64),
                         np.arange(ROWS, dtype=np.float64))
    E = E0 + cc * CELL
    N = N0 - rr * CELL
    lon, lat = fwd.transform(E.ravel(), N.ravel())
    lon = np.asarray(lon, np.float64).ravel()
    lat = np.asarray(lat, np.float64).ravel()

    # forward fit (grid -> lon/lat)
    A = np.column_stack([cc.ravel(), rr.ravel(), np.ones(cc.size)])
    glon, *_ = np.linalg.lstsq(A, lon, rcond=None)
    glat, *_ = np.linalg.lstsq(A, lat, rcond=None)

    # inverse fit (lon/lat -> grid)
    B = np.column_stack([lon, lat, np.ones(lon.size)])
    gcol, *_ = np.linalg.lstsq(B, cc.ravel(), rcond=None)
    grow, *_ = np.linalg.lstsq(B, rr.ravel(), rcond=None)

    # residual of the forward affine, measured back in UTM metres
    Ep, Np = inv.transform(A @ glon, A @ glat)
    err_fwd = float(np.max(np.hypot(np.asarray(Ep) - E.ravel(),
                                    np.asarray(Np) - N.ravel())))
    # residual of the inverse affine, grid cells -> UTM metres
    Ep2 = E0 + (B @ gcol) * CELL
    Np2 = N0 - (B @ grow) * CELL
    err_inv = float(np.max(np.hypot(Ep2 - E.ravel(), Np2 - N.ravel())))
    residual = max(err_fwd, err_inv)

    # axis-aligned lat/lng bbox of the projected grid corners
    corners_px = [(0, 0), (COLS - 1, 0), (COLS - 1, ROWS - 1), (0, ROWS - 1)]
    lons, lats = [], []
    for (c, r) in corners_px:
        lo = glon[0] * c + glon[1] * r + glon[2]
        la = glat[0] * c + glat[1] * r + glat[2]
        lons.append(lo)
        lats.append(la)

    warp = {
        "dims": [COLS, ROWS],
        "corners": {
            "nw": [round(float(min(lons)), 8), round(float(max(lats)), 8)],
            "se": [round(float(max(lons)), 8), round(float(min(lats)), 8)],
        },
        "grid_to_lonlat": [round(float(v), 12) for v in glon],
        "grid_to_lonlat_row": [round(float(v), 12) for v in glat],
        "lonlat_to_grid": [round(float(v), 12) for v in gcol],
        "lonlat_to_grid_row": [round(float(v), 12) for v in grow],
        "max_residual_m": round(residual, 3),
        "source": "pyproj EPSG:32615 <-> EPSG:4326 least-squares affine over the bathy grid",
    }
    with open(OUT, "w") as f:
        json.dump(warp, f, indent=1)

    print(f"wrote {os.path.relpath(OUT, ROOT)}  ({ROWS}x{COLS} grid, {CELL:.0f} m)")
    print(f"  grid_to_lonlat      = {warp['grid_to_lonlat']}")
    print(f"  grid_to_lonlat_row  = {warp['grid_to_lonlat_row']}")
    print(f"  lonlat_to_grid      = {warp['lonlat_to_grid']}")
    print(f"  lonlat_to_grid_row  = {warp['lonlat_to_grid_row']}")
    print(f"  corners nw/se       = {warp['corners']['nw']} / {warp['corners']['se']}")
    print(f"  residual forward    = {err_fwd:.3f} m")
    print(f"  residual inverse    = {err_inv:.3f} m")
    print(f"  max_residual_m      = {warp['max_residual_m']} m")
    print(f"done in {time.time() - t0:.2f}s")


if __name__ == "__main__":
    main()
