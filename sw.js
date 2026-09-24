// Big Pond Chop v2 service worker — repo root == app root on GitHub Pages.
// Shell precache + versioned frame/wind data. App code and the document are
// network-first so a deploy never serves stale code. Precomputed data under /data/
// is network-first with a cache fallback (live data on open, offline still maps).
// Bump CACHE_NAME on every future deploy.
const CACHE_NAME = 'bpc-cache-v2';

const SHELL = [
  './', './index.html',
  './src/tables.js', './src/wave-math.js', './src/wind.js', './src/ui.js', './src/render.js',
  './public/vendor/leaflet/leaflet.js', './public/vendor/leaflet/leaflet.css',
  './public/vendor/leaflet/images/layers.png', './public/vendor/leaflet/images/layers-2x.png',
  './public/vendor/leaflet/images/marker-icon.png', './public/vendor/leaflet/images/marker-icon-2x.png',
  './public/vendor/leaflet/images/marker-shadow.png',
  './public/meta.v1.json', './public/mask.v1.json', './public/spots.v1.json',
  './public/warp.v1.json', './public/tables.v1.bin',
  './public/favicon.svg', './public/icon-192.png', './public/icon-512.png',
  './manifest.webmanifest'
];

// Network-first, cache fallback. The cache key drops the query string so a ?cb=
// cache-buster still hits the stored copy when offline.
function dataFirst(req) {
  const url = new URL(req.url);
  const key = new Request(url.origin + url.pathname);
  return fetch(req)
    .then((res) => {
      const copy = res.clone();
      caches.open(CACHE_NAME).then((c) => c.put(key, copy));
      return res;
    })
    .catch(() => caches.match(key));
}

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // tiles + any external host: never cached

  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  if (/\/src\/[^/]*\.js$/.test(url.pathname) || /\/public\/vendor\/.*\.(js|css|png)$/.test(url.pathname)) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
    return;
  }

  if (/\/data\/[^/]*\.(json|bin)$/.test(url.pathname)) {
    e.respondWith(dataFirst(req));
    return;
  }

  if (/\/public\/[^/]*\.v1\.(json|bin)$/.test(url.pathname) ||
      /\/public\/(favicon\.svg|icon-192\.png|icon-512\.png)$/.test(url.pathname) ||
      /\/manifest\.webmanifest$/.test(url.pathname)) {
    e.respondWith(
      caches.match(req).then((r) => r || fetch(req).then((res) => {
        const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); return res;
      }))
    );
  }
});
