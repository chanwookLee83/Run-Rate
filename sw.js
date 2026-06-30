const CACHE_NAME = 'runrate-cache-v4';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './firebase-init.js',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(ASSETS)).catch(()=>{})
  );
  self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_NAME).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  // CDN/외부 URL(Firebase SDK 등)은 항상 네트워크에서 직접 가져옴 (SW 캐시 제외)
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  e.respondWith(
    caches.match(e.request).then((cached) => {
      if (cached) return cached;
      return fetch(e.request).then((resp) => {
        const respClone = resp.clone();
        caches.open(CACHE_NAME).then(cache => cache.put(e.request, respClone));
        return resp;
      }).catch(() => cached);
    })
  );
});
