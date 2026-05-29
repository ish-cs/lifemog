const CACHE = 'lifemog-v1';
// Network-first for these — they change often and must always be fresh
const NETWORK_FIRST = ['/prompt.txt', '/prompt-edit.txt', '/index.html'];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(NETWORK_FIRST)));
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);
  if (url.hostname !== self.location.hostname || url.pathname.startsWith('/.netlify/')) return;

  const isNetworkFirst = NETWORK_FIRST.some(p => url.pathname === p || url.pathname === '/');

  if (isNetworkFirst) {
    // Network first — always try live, fall back to cache if offline
    e.respondWith(
      fetch(e.request).then(res => {
        if (res.ok) {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }).catch(() => caches.match(e.request))
    );
  } else {
    // Cache first for static assets
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request).then(res => {
        if (res.ok && e.request.method === 'GET') {
          const clone = res.clone();
          caches.open(CACHE).then(c => c.put(e.request, clone));
        }
        return res;
      }))
    );
  }
});
