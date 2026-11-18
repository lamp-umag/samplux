// samplux — service worker for interviewer mode (encuestador.html) offline use.
// Network first, cache as fallback: online behaviour is unchanged for every page;
// offline, whatever was fetched before (app shell, Firebase SDK, survey base files)
// is served from the cache. Registered only by encuestador.html.
const CACHE = 'samplux-shell-v1';
const CDN_HOSTS = ['www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', event => event.waitUntil(self.clients.claim()));

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  const sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && !CDN_HOSTS.includes(url.hostname)) return;   // Firestore/Auth traffic is never touched

  event.respondWith(
    fetch(req).then(res => {
      if (res.ok) {
        const copy = res.clone();
        caches.open(CACHE).then(cache => cache.put(req, copy)).catch(() => {});
      }
      return res;
    }).catch(async () => {
      // Survey base files are requested with a cache-busting query string.
      const hit = await caches.match(req, { ignoreSearch: sameOrigin });
      return hit || Response.error();
    })
  );
});
