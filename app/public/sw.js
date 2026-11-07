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

const VERSION = 'v1';
const CACHE = `offline-nav-${VERSION}`;
const SCOPE = self.registration.scope; // ends with '/'
const PRECACHE = ['', 'index.html', 'packs/ucl-east.json'].map((p) => new URL(p, SCOPE).toString());

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((c) => c.addAll(PRECACHE))
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
