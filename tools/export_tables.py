#!/usr/bin/env python3
"""Stage 1 export: bathy grid + directional fetch tables + wave-math point queries.

Implements docs/BUILD-SPEC.md. Point-query ray() semantics are copied verbatim
from tools/golden_fixtures_gen.py (the pinned golden methodology).
"""
import math
import json
import time
import hashlib
import os
import numpy as np
import PIL.Image as I
from pyproj import Transformer
from scipy import ndimage           # scipy 1.17.1 / numpy 2.4.3 verified on this box

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
DEM = "/home/reid/projects/oruxmaps-data/bathy/millelacs_work/ml_dem_utm.tif"
GOLDEN = os.path.join(ROOT, "tests", "fixtures", "golden.json")
OUT_BIN = os.path.join(ROOT, "public", "tables.v1.bin")
OUT_META = os.path.join(ROOT, "public", "meta.v1.json")
OUT_MASK = os.path.join(ROOT, "public", "mask.v1.json")

G = 9.81
FT = 0.3048
E0, N0, PX = 436230.0, 5135360.0, 5.0
BATHY_ROWS, BATHY_COLS = 292, 285
FETCH_DIRS, FETCH_ROWS, FETCH_COLS = 16, 98, 95
DIR_STEP = 22.5
SUB = (-45.0, -22.5, 0.0, 22.5, 45.0)
MAX_FT = 42.0
LAND_U16 = 65535
OFF_DEPTH = 0
OFF_FETCH = BATHY_ROWS * BATHY_COLS * 2            # 166_440
OFF_PATH = OFF_FETCH + FETCH_DIRS * FETCH_ROWS * FETCH_COLS * 2  # 464_360
TOTAL = OFF_PATH + FETCH_DIRS * FETCH_ROWS * FETCH_COLS          # 613_320
GAMMA = -0.474


def load_dem():
    arr = np.array(I.open(DEM), dtype=np.float32)
    sent = arr >= 1e30
    depth = np.where(sent, np.nan, np.abs(arr)).astype(np.float32)
    np.minimum(depth, MAX_FT, out=depth, where=~sent)
    clamped = int(((~sent) & (np.abs(arr) > MAX_FT)).sum())
    return sent, depth, clamped, arr


MASK_RECEIPT = {}


def log_mask_receipt(lab, n_lab, sizes, keep, bd):
    """6.3: persist the water-body component inventory next to the blob.

    Component count, per-component size/area/centroid (grid -> lon/lat via the same
    warp affine the runtime uses) and the dropped inventory with depth stats.
    """
    with open(os.path.join(ROOT, "public", "warp.v1.json")) as f:
        warp = json.load(f)
    A, B = warp["grid_to_lonlat"], warp["grid_to_lonlat_row"]

    def stats(k):
        ys, xs = np.where(lab == k)
        lon = A[0] * xs.mean() + A[1] * ys.mean() + A[2]
        lat = B[0] * xs.mean() + B[1] * ys.mean() + B[2]
        d = bd[lab == k]
        return {"id": int(k), "cells": int(sizes[k]), "area_km2": round(sizes[k] * 0.01, 2),
                "centroid_lat": round(float(lat), 4), "centroid_lon": round(float(lon), 4),
                "depth_ft": {"min": round(float(d.min()), 1),
                             "median": round(float(np.median(d)), 1),
                             "max": round(float(d.max()), 1)}}

    comps = sorted((stats(k) for k in range(1, n_lab + 1) if sizes[k] > 0),
                   key=lambda c: -c["cells"])
    kept = next(c for c in comps if c["id"] == keep)
    dropped = [c for c in comps if c["id"] != keep]
    MASK_RECEIPT.update({
        "version": "6.3", "generated_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "source_dem": os.path.basename(DEM), "connectivity": 4,
        "grid": {"rows": BATHY_ROWS, "cols": BATHY_COLS, "cell_m": 100},
        "components": int(n_lab), "kept": kept, "dropped": dropped,
        "dropped_cells_total": int(sum(c["cells"] for c in dropped)),
        "keep_min_cells_guard": 50000,
    })
    print("mask 6.3: %d components; keep #%d %d cells; dropped %d comps / %d cells (%.2f km2)"
          % (n_lab, keep, kept["cells"], len(dropped), MASK_RECEIPT["dropped_cells_total"],
             MASK_RECEIPT["dropped_cells_total"] * 0.01), flush=True)
    with open(OUT_MASK, "w") as f:
        json.dump(MASK_RECEIPT, f, indent=1)


def build_bathy(sent, depth):
    """100 m min-depth downsample, sentinel-aware. Returns (depth_ft, land)."""
    h, w = depth.shape
    assert h == BATHY_ROWS * 20 and w <= BATHY_COLS * 20
    pad = BATHY_COLS * 20 - w
    sp = np.pad(sent, ((0, 0), (0, pad)), constant_values=True)
    dp = np.pad(depth, ((0, 0), (0, pad)), constant_values=np.nan)
    bs = sp.reshape(BATHY_ROWS, 20, BATHY_COLS, 20)
    bd = dp.reshape(BATHY_ROWS, 20, BATHY_COLS, 20)
    del bs
    import warnings
    with warnings.catch_warnings():
        warnings.simplefilter("ignore", RuntimeWarning)
        out = np.nanmin(bd, axis=(1, 3)).astype(np.float32)
    del bd
    land = ~np.isfinite(out)
    out[land] = 0.0

    # 6.3: keep only the largest contiguous water body (Mille Lacs proper). The DEM mask
    # carries satellite lakes; rays/paints must not see them.
    struct4 = ndimage.generate_binary_structure(2, 1)          # 4-connectivity
    lab, n_lab = ndimage.label(~land, structure=struct4)
    sizes = np.bincount(lab.ravel()); sizes[0] = 0
    keep = int(np.argmax(sizes))
    if sizes[keep] < 50000:      # 6.2 ships 52,738 cells for Mille Lacs
        raise SystemExit("mask regression: largest water body is %d cells" % sizes[keep])
    dropped = (~land) & (lab != keep)
    log_mask_receipt(lab, n_lab, sizes, keep, out)   # new: counts + centroids into the receipt
    land = land | dropped
    return out, land


def build_fetch(bd, land):
    """Effective fetch/path-depth per 16 directions over the bathy grid.

    Ray-cast on the 100 m bathy grid, one-cell (100 m) steps, truncation
    sampling, terminate on land or depth < 1 ft. Effective fetch = cos-weighted
    mean of the 5 bearings at dir +/- {45, 22.5, 0}.
    """
    h, w = bd.shape
    water = ~land
    rows = np.minimum(3 * np.arange(FETCH_ROWS) + 1, BATHY_ROWS - 1)
    cols = np.minimum(3 * np.arange(FETCH_COLS) + 1, BATHY_COLS - 1)
    x0, y0 = np.meshgrid(cols.astype(np.float64), rows.astype(np.float64))
    wts = np.cos(np.radians(SUB))
    wsum = wts.sum()
    maxsteps = h + w
    fetch_out = np.zeros((FETCH_DIRS, FETCH_ROWS, FETCH_COLS), np.uint16)
    path_out = np.zeros((FETCH_DIRS, FETCH_ROWS, FETCH_COLS), np.uint8)
    for di in range(FETCH_DIRS):
        wd = di * DIR_STEP
        facc = np.zeros((FETCH_ROWS, FETCH_COLS), np.float64)
        dacc = np.zeros((FETCH_ROWS, FETCH_COLS), np.float64)
        nacc = np.zeros((FETCH_ROWS, FETCH_COLS), np.int32)
        for weight, delta in zip(wts, SUB):
            th = math.radians(wd + delta)
            dx, dy = math.sin(th), -math.cos(th)
            x, y = x0.copy(), y0.copy()
            alive = np.ones((FETCH_ROWS, FETCH_COLS), bool)
            ff = np.zeros((FETCH_ROWS, FETCH_COLS), np.float64)
            dd = np.zeros((FETCH_ROWS, FETCH_COLS), np.float64)
            nn = np.zeros((FETCH_ROWS, FETCH_COLS), np.int32)
            for _ in range(maxsteps):
                if not alive.any():
                    break
                x[alive] += dx
                y[alive] += dy
                xi, yi = np.floor(x), np.floor(y)
                inb = (xi >= 0) & (xi < w) & (yi >= 0) & (yi < h)
                xc = np.clip(xi, 0, w - 1).astype(np.intp)
                yc = np.clip(yi, 0, h - 1).astype(np.intp)
                ok = inb & water[yc, xc]
                step = alive & ok
                ff[step] += 100.0
                dd[step] += bd[yc[step], xc[step]]
                nn[step] += 1
                alive = alive & ok
            facc += weight * ff
            dacc += weight * np.where(nn > 0, dd / np.maximum(nn, 1), 0.0)
            nacc += nn
        feff = facc / wsum
        deff = dacc / wsum
        invalid = nacc == 0
        fu = np.rint(feff / 10.0)
        np.clip(fu, 0, LAND_U16 - 1, out=fu)
        fu[invalid] = LAND_U16
        pu = np.rint(deff)
        np.clip(pu, 0, 255, out=pu)
        pu[invalid] = 0
        fetch_out[di] = fu.astype(np.uint16)
        path_out[di] = pu.astype(np.uint8)
    return fetch_out, path_out


# ---- pinned point-query methodology (verbatim from golden_fixtures_gen.py) ----
def make_point_query(sent, depth):
    H, W = depth.shape

    def ray(ix, iy, bearing, step_m=40.0):
        th = math.radians(bearing)
        dx, dy = math.sin(th), -math.cos(th)
        st = step_m / PX
        x, y = float(ix), float(iy)
        fetch = 0.0
        dsum = 0.0
        n = 0
        while True:
            x += dx * st
            y += dy * st
            xi, yi = int(x), int(y)
            if xi < 0 or yi < 0 or xi >= W or yi >= H or sent[yi, xi]:
                break
            d = depth[yi, xi]
            if not (d >= 1.0):
                break
            fetch += step_m
            dsum += d
            n += 1
        return fetch, (dsum / n if n else 0.0)

    def dispersion(T, h_m):
        w_ = 2 * math.pi / T
        lo, hi = 1e-5, 50.0
        for _ in range(120):
            k = 0.5 * (lo + hi)
            if G * k * math.tanh(k * h_m) - w_ * w_ > 0:
                hi = k
            else:
                lo = k
        k = 0.5 * (lo + hi)
        c = (2 * math.pi / T) / k
        return 0.5 * (1 + 2 * k * h_m / math.sinh(2 * k * h_m)) * c, 2 * math.pi / k

    def cell(ix, iy, wind_deg=315.0, U_mph=30.0, t_eff_s=8 * 3600.0):
        U_mps = U_mph * 0.44704
        Ua = 0.71 * U_mps ** 1.23
        ds = (-45.0, -22.5, 0.0, 22.5, 45.0)
        ws = [math.cos(math.radians(d)) for d in ds]
        sw = sum(ws)
        F_m = 0.0
        dp_ft = 0.0
        for d, w in zip(ds, ws):
            f, pd = ray(ix, iy, wind_deg + d)
            F_m += f * w
            dp_ft += pd * w
        F_m /= sw
        dp_ft /= sw
        dloc_ft = float(depth[iy, ix])
        F_used = min(F_m, Ua * t_eff_s)
        ht = G * (dp_ft * FT) / (Ua * Ua)
        P1f = math.tanh(0.530 * ht ** 0.75)
        P2f = math.tanh(0.833 * ht ** 0.375)
        Hs_m = 0.283 * (Ua * Ua / G) * P1f * math.tanh(0.00565 * math.sqrt(G * F_used / (Ua * Ua)) / P1f)
        T = 7.54 * (Ua / G) * P2f * math.tanh(0.0379 * (G * F_used / (Ua * Ua)) ** (1 / 3) / P2f)
        cgp, _ = dispersion(T, dp_ft * FT)
        cgl, L_local = dispersion(T, dloc_ft * FT)
        Ks = min(1.6, max(0.7, math.sqrt(cgp / cgl)))
        Hs_ft = Hs_m / FT
        hs_ks = Hs_ft * Ks
        return dict(F_mi=F_m / 1609.34, dpath_ft=dp_ft, dlocal_ft=dloc_ft, Hs_ft=Hs_ft,
                    T_s=T, Ks=Ks, Hs_after_Ks_ft=hs_ks, capped_ft=min(hs_ks, 0.6 * dloc_ft),
                    roller_ft=min(1.67 * hs_ks, 0.78 * dloc_ft), HL=(hs_ks * FT) / L_local)

    return cell


def main():
    t0 = time.time()
    sent, depth, clamped, arr_raw = load_dem()
    print(f"DEM {depth.shape[0]}x{depth.shape[1]} loaded ({time.time()-t0:.1f}s); "
          f"clamped>{MAX_FT:.0f}ft cells: {clamped}", flush=True)

    t1 = time.time()
    bd, bland = build_bathy(sent, depth)
    print(f"bathy {bd.shape} built ({time.time()-t1:.1f}s); water cells "
          f"{int((~bland).sum())}", flush=True)

    t2 = time.time()
    fetch, path = build_fetch(bd, bland)
    assert fetch.shape == (16, 98, 95), fetch.shape
    assert path.shape == (16, 98, 95), path.shape
    print(f"fetch tables {fetch.shape} built ({time.time()-t2:.1f}s)", flush=True)

    depth_u16 = np.rint(bd * 4.0)
    np.clip(depth_u16, 0, LAND_U16 - 1, out=depth_u16)
    depth_u16 = depth_u16.astype(np.uint16)
    depth_u16[bland] = LAND_U16

    blob = (depth_u16.astype("<u2").tobytes()
            + fetch.astype("<u2").tobytes()
            + path.astype("<u1").tobytes())
    assert len(blob) == TOTAL, (len(blob), TOTAL)
    with open(OUT_BIN, "wb") as f:
        f.write(blob)
    sha = hashlib.sha256(blob).hexdigest()

    water_fetch = fetch[fetch != LAND_U16]
    valid_mask = fetch != LAND_U16
    depth_water = depth_u16[depth_u16 != LAND_U16]

    # deep-artifact blob receipt: DEM cells deeper than 60 ft (the design doc's
    # definition), reported in DEM pixel coordinates. 92% of these sit in one
    # west-edge blob; this is the receipt the 42 ft clamp is justified by.
    blob_mask = (~sent) & (np.abs(arr_raw) > 60.0)
    if blob_mask.any():
        by, bx = np.where(blob_mask)
        blob_bbox = {"x_px": [int(bx.min()), int(bx.max())],
                     "y_px": [int(by.min()), int(by.max())],
                     "cells": int(blob_mask.sum()),
                     "median_ft": round(float(np.median(np.abs(arr_raw[blob_mask]))), 1)}
    else:
        blob_bbox = None


    fwd = Transformer.from_crs("EPSG:32615", "EPSG:4326", always_xy=True)
    e_hi = E0 + BATHY_COLS * 100.0
    n_lo = N0 - BATHY_ROWS * 100.0
    corners = {}
    for nm, (e, n) in {"nw": (E0, N0), "ne": (e_hi, N0),
                       "se": (e_hi, n_lo), "sw": (E0, n_lo)}.items():
        lon, lat = fwd.transform(e, n)
        corners[nm] = [round(lon, 6), round(lat, 6)]

    meta = {
        "version": "v1",
        "created_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "bathy_grid": {"rows": BATHY_ROWS, "cols": BATHY_COLS, "cell_m": 100},
        "fetch_grid": {"rows": FETCH_ROWS, "cols": FETCH_COLS, "cell_m": 300,
                       "directions_deg": [round(i * DIR_STEP, 1) for i in range(FETCH_DIRS)]},
        "utm": {"epsg": "EPSG:32615", "zone": "15N", "origin_e": E0, "origin_n": N0},
        "wgs84_corners": corners,
        "gamma_deg": GAMMA,
        "blob": {"file": "tables.v1.bin", "bytes": TOTAL, "sha256": sha,
                 "offsets": {"depth": OFF_DEPTH, "fetchEff": OFF_FETCH, "pathEff": OFF_PATH},
                 "order": "[dir][row][col]"},
        "units": {"depth": "ft x 4 (uint16, 0.25 ft); 65535 = land",
                  "fetchEff": "decametres (10 m), uint16; 65535 = invalid",
                  "pathEff": "ft, uint8; 0 = invalid"},
        "datum": "depths are feet below chart datum; fetch is distance to land",
        "clamped": {"dem_cells_above_42ft": clamped, "max_ft": MAX_FT},
        "blob_bbox": blob_bbox,
        "ranges": {
            "depth_ft": [round(float(depth_water.min()) / 4.0, 3), round(float(depth_water.max()) / 4.0, 3)],
            "fetchEff_decam": [int(water_fetch.min()), int(water_fetch.max())],
            "pathEff_ft": [int(path[valid_mask].min()), int(path[valid_mask].max())],
        },
    }
    with open(OUT_META, "w") as f:
        json.dump(meta, f, indent=1)

    # ---- fixture point queries vs golden.json ----
    cell = make_point_query(sent, depth)
    fixtures = {"deep_mud_basin": (445300.0, 5125830.0),
                "garrison_reef": (450995.0, 5107250.0),
                "cove_bay_se_reach": (463555.0, 5110120.0)}
    golden = json.load(open(GOLDEN))
    worst = 0.0
    print("\n--- fixture point queries vs golden.json ---")
    for name, (e, n) in fixtures.items():
        ix, iy = round((e - E0) / PX), round((N0 - n) / PX)
        r = cell(ix, iy)
        for k in ("F_mi", "dpath_ft", "dlocal_ft", "Hs_ft", "T_s", "Ks", "capped_ft", "roller_ft", "HL"):
            d = abs(r[k] - golden[name][k])
            worst = max(worst, d)
        print(f"{name:20s} ix={ix:5d} iy={iy:5d} F={r['F_mi']:.4f}mi dpath={r['dpath_ft']:.4f}ft "
              f"Hs={r['Hs_ft']:.4f} T={r['T_s']:.4f} Ks={r['Ks']:.4f} capped={r['capped_ft']:.4f}")
    assert worst <= 0.01, f"golden mismatch worst={worst}"

    print("\n--- export receipt ---")
    print(f"bathy grid      : {BATHY_ROWS} x {BATHY_COLS} (100 m)")
    print(f"fetch grid      : {FETCH_DIRS} x {FETCH_ROWS} x {FETCH_COLS} (300 m)")
    print(f"depth range ft  : {meta['ranges']['depth_ft']}")
    print(f"fetch range dm  : {meta['ranges']['fetchEff_decam']}")
    print(f"path range ft   : {meta['ranges']['pathEff_ft']}")
    print(f"clamped cells   : {clamped}")
    print(f"mask receipt    : {MASK_RECEIPT['components']} comps, keep {MASK_RECEIPT['kept']['cells']} cells, "
          f"dropped {len(MASK_RECEIPT['dropped'])} comps / {MASK_RECEIPT['dropped_cells_total']} cells")
    print(f"blob bbox       : {blob_bbox}")
    print(f"byte size       : {TOTAL} bytes")
    print(f"sha256          : {sha}")
    print(f"golden worst abs delta: {worst:.6f}")
    print(f"done in {time.time()-t0:.1f}s")


if __name__ == "__main__":
    main()
