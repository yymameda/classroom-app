// Service Worker for 教室管理アプリ PWA
// キャッシュファースト + バージョン管理
const CACHE_VERSION = 'v1.8.91';
const CACHE_NAME = 'classroom-app-' + CACHE_VERSION;
const ASSETS = [
  './',
  './index.html',
  './pf.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png',
  './libs/html2canvas.min.js',
  './libs/jspdf.umd.min.js'
];

self.addEventListener('install', function(e) {
  e.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return Promise.all(ASSETS.map(function(url) {
        return fetch(url, { cache: 'reload' }).then(function(response) {
          if (!response.ok) throw new Error('fetch failed: ' + url + ' ' + response.status);
          return cache.put(url, response);
        });
      }));
    }).then(function() { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function(e) {
  e.waitUntil(
    caches.keys().then(function(keys) {
      return Promise.all(
        keys.filter(function(k) { return k !== CACHE_NAME; })
            .map(function(k) { return caches.delete(k); })
      );
    }).then(function() { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function(e) {
  e.respondWith(
    caches.match(e.request, { ignoreSearch: true }).then(function(cached) {
      if (cached) return cached;
      return fetch(e.request).catch(function() {
        if (e.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
        return new Response('', { status: 504, statusText: 'Gateway Timeout (offline)' });
      });
    })
  );
});

self.addEventListener('message', function(e) {
  if (e.data && e.data.type === 'SKIP_WAITING') { self.skipWaiting(); }
  if (e.data && e.data.type === 'GET_VERSION') {
    e.source.postMessage({ type: 'VERSION', version: CACHE_VERSION });
  }
});
