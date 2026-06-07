// Service worker for Fantasy Football Command Center.
//
// Strategy: NETWORK-FIRST for same-origin app files. When online, every file is
// fetched fresh from the network in the same load, so you can never get a stale
// mix of old + new ES modules (the cause of post-deploy white screens). A copy
// is cached so the app still launches OFFLINE, falling back to the last good
// version. Cross-origin requests (the Sleeper API) are left untouched — the app
// manages its own API caching/offline handling.

const CACHE = 'ffcc-v1';
const CORE = ['./', './index.html', './app.webmanifest', './css/styles.css', './js/main.js'];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // activate the new worker immediately
  event.waitUntil(
    caches.open(CACHE).then((c) => Promise.all(CORE.map((u) => c.add(u).catch(() => {})))),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim(); // take control of open pages right away
  })());
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // let Sleeper API calls pass through

  event.respondWith((async () => {
    try {
      const fresh = await fetch(req);
      if (fresh && fresh.ok) {
        const cache = await caches.open(CACHE);
        cache.put(req, fresh.clone());
      }
      return fresh;
    } catch {
      const cached = await caches.match(req);
      if (cached) return cached;
      if (req.mode === 'navigate') {
        const shell = await caches.match('./index.html');
        if (shell) return shell;
      }
      throw new Error('offline and not cached');
    }
  })());
});
