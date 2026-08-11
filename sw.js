const CACHE_NAME = 'runrate-cache-v27';
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
  // 네트워크 우선(network-first): 항상 최신 파일을 받아오고, 오프라인일 때만 캐시 사용.
  // { cache: 'no-store' }로 브라우저 HTTP 캐시까지 우회해야 배포 직후에도 즉시 최신본을 받는다.
  // (그냥 fetch(e.request)만 쓰면 GitHub Pages의 Cache-Control 유효기간 동안 새로고침해도 이전 파일이 나올 수 있음)
  e.respondWith(
    fetch(e.request, { cache: 'no-store' }).then((resp) => {
      const respClone = resp.clone();
      caches.open(CACHE_NAME).then(cache => cache.put(e.request, respClone));
      return resp;
    }).catch(() => caches.match(e.request))
  );
});
