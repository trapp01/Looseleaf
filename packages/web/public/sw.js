// Caches the app shell so the app opens without a network. Notes never pass
// through here: they live in IndexedDB and sync over /sync and /api.

// The build writes the real values here (the precache plugin in vite.config.ts).
const BUILD = 'dev';
const ASSETS = [];

const CACHE = `looseleaf-shell-v2-${BUILD}`;

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(['./', './index.html', ...ASSETS])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

const isHtml = (response) => (response.headers.get('content-type') || '').includes('text/html');

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  if (/\/(api|sync)(\/|$)/.test(url.pathname)) return;

  // Pages: the network first so a new version shows, the cached shell when
  // offline or on a 5xx. Other replies (a proxy's 401, say) pass through uncached.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          if (response.status >= 500) return caches.match('./index.html').then((cached) => cached || response);
          if (!response.ok || !isHtml(response)) return response;
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put('./index.html', copy));
          return response;
        })
        .catch(() => caches.match('./index.html')),
    );
    return;
  }

  // Hashed assets never change: the cache first, filled on first use. An HTML
  // reply under an asset URL is a fallback page, never the asset.
  event.respondWith(
    caches.match(request).then(
      (cached) =>
        cached ||
        fetch(request).then((response) => {
          if (response.ok && !isHtml(response)) {
            const copy = response.clone();
            caches.open(CACHE).then((cache) => cache.put(request, copy));
          }
          return response;
        }),
    ),
  );
});
