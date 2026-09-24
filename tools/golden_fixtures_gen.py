
import math, json, time
import numpy as np, PIL.Image as I
from pyproj import Transformer
g = 9.81; FT = 0.3048
t0 = time.time()
DEM = "/home/reid/projects/oruxmaps-data/bathy/millelacs_work/ml_dem_utm.tif"
arr = np.array(I.open(DEM), dtype=np.float32); sent = arr >= 1e30
depth = np.where(sent, np.nan, np.abs(arr)).astype(np.float32)
np.minimum(depth, 42.0, out=depth, where=~sent)
H, W = arr.shape; E0, N0, PX = 436230.0, 5135360.0, 5.0
fwd = Transformer.from_crs("EPSG:32615","EPSG:4326", always_xy=True)
inv = Transformer.from_crs("EPSG:4326","EPSG:32615", always_xy=True)

# ---- exact 315-degree fetch map by DP along the diagonal (NW = -x, -y in pixel space) ----
step = PX*math.sqrt(2.0)
F315 = np.zeros((H, W), dtype=np.float32)
water_ok = (~sent) & (depth >= 1.0)
for y in range(1, H):
    prev = F315[y-1, :-1]
    cur = np.where(water_ok[y, 1:], prev + step, 0.0)
    F315[y, 1:] = cur
iy3, ix3 = np.unravel_index(int(np.argmax(F315)), F315.shape)
print("max 315-fetch cell: (ix,iy)=", ix3, iy3, " fetch %.2f mi" % (F315[iy3, ix3]/1609.34), "%.1fs" % (time.time()-t0), flush=True)

main = depth.copy(); main[:, :1100] = np.nan
iy1, ix1 = np.unravel_index(int(np.nanargmax(main)), main.shape)

# Garrison: box around the town
Eg, Ng = inv.transform(-93.8269, 46.2945); gx, gy = int((Eg-E0)/PX), int((N0-Ng)/PX)
# P2: shallow bar (6-14 ft) with real fetch, western half (Garrison territory)
cand = np.where(water_ok & (depth >= 6.0) & (depth <= 14.0), F315, 0.0)
cand[:, 3000:] = 0.0
for thresh_mi in (5.0, 3.0, 1.5):
    ok = cand >= thresh_mi*1609.34
    if ok.any():
        tmp = np.where(ok, depth, np.nan)
        iy2, ix2 = np.unravel_index(int(np.nanargmin(tmp)), tmp.shape)
        print("P2 threshold %.1f mi -> depth %.1f ft" % (thresh_mi, depth[iy2, ix2]), flush=True)
        break
# P3: far SE reach among cells at least 10 ft deep
deep_ok = water_ok & (depth >= 10.0)
cand3 = np.where(deep_ok, F315, 0.0)
iy3b, ix3b = np.unravel_index(int(np.argmax(cand3)), cand3.shape)
print("P3 (depth>=10 ft) fetch %.2f mi, depth %.1f ft" % (cand3[iy3b, ix3b]/1609.34, depth[iy3b, ix3b]), flush=True)
P1 = (ix1, iy1); P2 = (ix2, iy2); P3 = (ix3b, iy3b)
print("P1", P1, "P2", P2, "P3", P3, flush=True)

def ray(ix, iy, bearing, step_m=40.0):
    th = math.radians(bearing); dx, dy = math.sin(th), -math.cos(th); st = step_m/PX
    x, y = float(ix), float(iy); fetch = 0.0; dsum = 0.0; n = 0
    while True:
        x += dx*st; y += dy*st
        xi, yi = int(x), int(y)
        if xi < 0 or yi < 0 or xi >= W or yi >= H or sent[yi, xi]: break
        d = depth[yi, xi]
        if not (d >= 1.0): break
        fetch += step_m; dsum += d; n += 1
    return fetch, (dsum/n if n else 0.0)

def dispersion(T, h_m):
    w_ = 2*math.pi/T; lo, hi = 1e-5, 50.0
    for _ in range(120):
        k = 0.5*(lo+hi)
        if g*k*math.tanh(k*h_m) - w_*w_ > 0: hi = k
        else: lo = k
    k = 0.5*(lo+hi); c = (2*math.pi/T)/k
    return 0.5*(1 + 2*k*h_m/math.sinh(2*k*h_m))*c, 2*math.pi/k

def cell(ix, iy, wind_deg=315.0, U_mph=30.0):
    Ua = 0.71*(U_mph*0.44704)**1.23
    ds = (-45.0, -22.5, 0.0, 22.5, 45.0); ws = [math.cos(math.radians(d)) for d in ds]; sw = sum(ws)
    F_m = 0.0; dp_ft = 0.0
    for d, w in zip(ds, ws):
        f, pd = ray(ix, iy, wind_deg + d); F_m += f*w; dp_ft += pd*w
    F_m /= sw; dp_ft /= sw
    dloc_ft = float(depth[iy, ix])
    ht = g*(dp_ft*FT)/(Ua*Ua); P1f = math.tanh(0.530*ht**0.75); P2f = math.tanh(0.833*ht**0.375)
    Hs_m = 0.283*(Ua*Ua/g)*P1f*math.tanh(0.00565*math.sqrt(g*F_m/(Ua*Ua))/P1f)
    T = 7.54*(Ua/g)*P2f*math.tanh(0.0379*(g*F_m/(Ua*Ua))**(1/3)/P2f)
    cgp, _ = dispersion(T, dp_ft*FT); cgl, L_local = dispersion(T, dloc_ft*FT)
    Ks = min(1.6, max(0.7, math.sqrt(cgp/cgl)))
    Hs_ft = Hs_m/FT; hs_ks = Hs_ft*Ks
    return dict(F_mi=F_m/1609.34, dpath_ft=dp_ft, dlocal_ft=dloc_ft, Hs_ft=Hs_ft, T_s=T, Ks=Ks,
                Hs_after_Ks_ft=hs_ks, capped_ft=min(hs_ks, 0.6*dloc_ft),
                roller_ft=min(1.67*hs_ks, 0.78*dloc_ft), HL=(hs_ks*FT)/L_local)

out = {}
for (ix, iy), label in [(P1, "deep_mud_basin"), (P2, "garrison_reef"), (P3, "cove_bay_se_reach")]:
    E, N = E0+ix*PX, N0-iy*PX; lon, lat = fwd.transform(E, N)
    r = cell(ix, iy)
    out[label] = dict(utm_E=round(E,1), utm_N=round(N,1), lat=round(lat,6), lon=round(lon,6),
                      **{k: round(float(v),4) for k,v in r.items()})
    print(f"{label}: lat {lat:.6f} lon {lon:.6f} | dloc {r['dlocal_ft']:.1f} ft")
    print(f"   F_eff {r['F_mi']:.2f} mi | pathd {r['dpath_ft']:.1f} ft | Hs {r['Hs_ft']:.3f} ft | T {r['T_s']:.2f} s | Ks {r['Ks']:.3f}")
    print(f"   after Ks {r['Hs_after_Ks_ft']:.3f} | capped {r['capped_ft']:.3f} | roller {r['roller_ft']:.2f} | H/L {r['HL']:.3f}")
json.dump(out, open("/home/reid/projects/big-pond-chop/.golden-fixtures.json","w"), indent=1)
print("written %.1fs" % (time.time()-t0))
