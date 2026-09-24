// Big Pond Chop service worker — repo root == app root on GitHub Pages.
// Shell precache only. Versioned data is cache-first; app code and the document
// are network-first so a deploy never serves stale code. Weather + tiles are
// never cached. Bump CACHE_NAME on every future deploy.
const CACHE_NAME = 'bpc-cache-v1';

const SHELL = [
  './', './index.html',
  './src/tables.js', './src/wave-math.js', './src/wind.js', './src/ui.js', './src/render.js',
  './public/meta.v1.json', './public/mask.v1.json', './public/spots.v1.json',
  './public/warp.v1.json', './public/tables.v1.bin',
  './public/favicon.svg', './public/icon-192.png', './public/icon-512.png',
  './manifest.webmanifest'
];

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
  if (url.origin !== self.location.origin) return; // open-meteo, unpkg, tiles: never cached

  if (req.mode === 'navigate' || req.destination === 'document') {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req).then((r) => r || caches.match('./index.html')))
    );
    return;
  }

  if (/\/src\/[^/]*\.js$/.test(url.pathname)) {
    e.respondWith(
      fetch(req, { cache: 'no-store' })
        .then((res) => { const copy = res.clone(); caches.open(CACHE_NAME).then((c) => c.put(req, copy)); return res; })
        .catch(() => caches.match(req))
    );
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
