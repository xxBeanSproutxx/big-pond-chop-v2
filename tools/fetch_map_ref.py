
import math, json
import numpy as np, PIL.Image as I
from pyproj import Transformer
PX = 5.0
DEM = "/home/reid/projects/oruxmaps-data/bathy/millelacs_work/ml_dem_utm.tif"
arr = np.array(I.open(DEM), dtype=np.float32); sent = arr >= 1e30
depth = np.where(sent, np.nan, np.abs(arr)).astype(np.float32)
np.minimum(depth, 42.0, out=depth, where=~sent)
H, W = arr.shape; E0, N0 = 436230.0, 5135360.0
ok = (~sent) & (depth >= 1.0)
fwd = Transformer.from_crs("EPSG:32615","EPSG:4326", always_xy=True)

def dp(dy, dx):
    step = PX*math.hypot(dy, dx); F = np.zeros((H, W), dtype=np.float32)
    rows = range(H) if dy <= 0 else range(H-1, -1, -1)
    for y in rows:
        sy = y + dy
        if 0 <= sy < H:
            src = F[sy]
            if dx == -1: s = np.concatenate((np.zeros(1, np.float32), src[:-1]))
            elif dx == 1: s = np.concatenate((src[1:], np.zeros(1, np.float32)))
            else: s = src
        else:
            s = np.zeros(W, np.float32)
        F[y] = np.where(ok[y], s + step, 0.0)
    return F

# 8 lattice bearings (compass): N=(-1,0) NE=(-1,1) E=(0,1) SE=(1,1) S=(1,0) SW=(1,-1) W=(0,-1) NW=(-1,-1)
maps = {0: dp(-1,0), 45: dp(-1,1), 90: dp(0,1), 135: dp(1,1), 180: dp(1,0), 225: dp(1,-1), 270: dp(0,-1), 315: dp(-1,-1)}
print("built 8 fetch maps")
def eff_fetch(theta):
    bears = [theta-45, theta-22.5, theta, theta+22.5, theta+45]
    wts = [math.cos(math.radians(x)) for x in (-45,-22.5,0,22.5,45)]
    sw = sum(wts); acc = np.zeros((H, W), np.float32)
    for b, w in zip(bears, wts):
        b = b % 360
        lo = int(b//45*45) % 360; hi = (lo+45) % 360; t = (b-lo)/45.0
        acc += w*((1-t)*maps[lo] + t*maps[hi])
    return acc/sw
summary = {}
for theta in [0, 45, 90, 135, 180, 225, 270, 315]:
    Fe = eff_fetch(theta)
    m = np.where(ok & (depth >= 25.0), Fe, 0.0)
    iy, ix = np.unravel_index(int(np.argmax(m)), m.shape)
    lon, lat = fwd.transform(E0+ix*PX, N0-iy*PX)
    summary[theta] = dict(max_mi=round(float(Fe[iy,ix]/1609.34),2), lat=round(float(lat),5), lon=round(float(lon),5),
                          depth_ft=round(float(depth[iy,ix]),1))
    print(f"wind from {theta:3d} deg: max effective fetch over basin water {Fe[iy,ix]/1609.34:5.2f} mi at {lat:.4f},{lon:.4f} (depth {depth[iy,ix]:.0f} ft)")
json.dump(summary, open("/tmp/fetch_by_dir.json","w"), indent=1)
