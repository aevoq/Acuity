// Service worker: makes the app and the area pack load with no network.
//
// - On install it pre-caches the page and the area pack.
// - Same-origin GETs: cache first, then network (and the response is cached),
//   so every built JS/CSS file and model file is kept after its first load.
// - Page navigations: network first (to pick up new builds), cache when offline.
// - Cross-origin requests (Gemini proxy, TfL, model CDNs) are not touched here;
//   online features go through src/net/online.ts and fall back themselves.
//
// Registered only in production builds (npm run build && npm run preview),
// because it would fight Vite's dev server. Bump VERSION to drop old caches.

const VERSION = 'v2';
const CACHE = `offline-nav-${VERSION}`;
const SCOPE = self.registration.scope; // ends with '/'
const url = (p) => new URL(p, SCOPE).toString();
const PRECACHE = ['', 'index.html', 'packs/ucl-east.json', 'map/style.json', 'map/manifest.json'].map(url);

// The offline base map (tiles, fonts, icons for the box around the venue),
// listed in map/manifest.json by scripts/map/fetch-offline-map.mjs. Cached
// whole on install, so the map works with Wi-Fi off even in parts not yet viewed.
async function precacheMap(cache) {
  const res = await fetch(url('map/manifest.json'));
  if (!res.ok) return;
  const { files } = await res.json();
  const urls = files.map((p) => url(`map/ofm/${p.split('/').map(encodeURIComponent).join('/')}`));
  for (let i = 0; i < urls.length; i += 20) await cache.addAll(urls.slice(i, i + 20));
}

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then(async (c) => {
        await c.addAll(PRECACHE);
        await precacheMap(c);
      })
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith('offline-nav-') && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(CACHE).then((c) => c.put(req, copy));
          return res;
        })
        .catch(() => caches.match(req).then((hit) => hit || caches.match(new URL('index.html', SCOPE).toString()))),
    );
    return;
  }

  event.respondWith(
    caches.match(req).then(
      (hit) =>
        hit ||
        fetch(req).then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((c) => c.put(req, copy));
          }
          return res;
        }),
    ),
  );
});
