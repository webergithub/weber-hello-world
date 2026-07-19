// LinkTalk service worker — makes the app installable and resilient offline.
//
// Strategy:
//   • Precache the static app shell on install.
//   • Navigations (HTML)  -> network-first, fall back to the cached shell so the
//     room/home screens still open with no connection.
//   • Other GETs (CSS/JS/icons) -> cache-first, then network (and cache it).
//   • /api/* and the WebSocket are never touched — they must always hit the
//     network, and translation/transcription already degrade gracefully.
//
// Bump CACHE when the shell changes to retire the old one on activate.

const CACHE = 'linktalk-v1';
const APP_SHELL = [
  '/',
  '/index.html',
  '/room.html',
  '/css/style.css',
  '/js/langs.js',
  '/js/room.js',
  '/manifest.webmanifest',
  '/icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  const url = new URL(req.url);

  // Only handle same-origin GETs; leave API + everything else to the network.
  if (req.method !== 'GET' || url.origin !== self.location.origin) return;
  if (url.pathname.startsWith('/api/')) return;

  event.respondWith(handle(req));
});

async function handle(req) {
  const cache = await caches.open(CACHE);

  // HTML navigations: prefer fresh, fall back to the cached shell offline.
  if (req.mode === 'navigate') {
    try {
      const net = await fetch(req);
      cache.put(req, net.clone());
      return net;
    } catch {
      return (
        (await cache.match(req, { ignoreSearch: true })) ||
        (await cache.match('/index.html')) ||
        Response.error()
      );
    }
  }

  // Static assets: cache-first, then fill the cache from the network.
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const net = await fetch(req);
    if (net.ok) cache.put(req, net.clone());
    return net;
  } catch {
    return cached || Response.error();
  }
}
