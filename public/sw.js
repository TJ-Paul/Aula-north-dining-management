// Demo service worker: answers /api/files/<name> (photos and posters) from this browser, since the
// demo has no server. Pictures a visitor uploads are in Cache Storage; the demo's posters ship in demo/files/.
const BASE = new URL(self.registration.scope).pathname.replace(/\/$/, '');

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin || !url.pathname.startsWith('/api/files/')) return;
  const name = url.pathname.slice('/api/files/'.length);
  e.respondWith((async () => {
    const cache = await caches.open('aula-demo-files');
    const kept = await cache.match(url.href);
    if (kept) return kept;
    return fetch(`${BASE}/demo/files/${name}`);
  })());
});
