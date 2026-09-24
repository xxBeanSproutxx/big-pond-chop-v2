// worker/merge.mjs — pure weather merge seam (no network, no fs).
// Policy (A4/A5): AIFS is the base; HRRR overrides any hour it has; IFS fills ONLY
// gust nulls and ONLY where IFS has a value (so gusts stay null past its ~+240 h).

function stamp(v) {
  const s = String(v);
  return new Date(/[Zz]$/.test(s) ? s : s + (s.length <= 16 ? ':00Z' : 'Z')).getTime();
}

export function mergeWeather({ near = [], mid = [], ifs = [], ifsOk = false } = {}) {
  const byT = new Map();
  for (const e of mid) byT.set(e.t, { ...e, src: 'aifs' });
  for (const e of near) byT.set(e.t, { ...e, src: 'hrrr' });
  if (ifsOk) {
    const gustAt = new Map(ifs.map((e) => [e.t, e.gustMph]));
    for (const e of byT.values()) if (e.gustMph == null && gustAt.get(e.t) != null) e.gustMph = gustAt.get(e.t);
  }
  return [...byT.values()].sort((a, b) => stamp(a.t) - stamp(b.t));
}
