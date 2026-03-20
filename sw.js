// Service Worker for 教室管理アプリ PWA
// キャッシュファースト + バージョン管理

const CACHE_VERSION = 'v1.0.2';
const CACHE_NAME = 'classroom-app-' + CACHE_VERSION;
const ASSETS = [
  './',
  './index.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];

// インストール: アセットをキャッシュ
self.addEventListener('install', function(event) {
  console.log('[SW] Install:', CACHE_VERSION);
  event.waitUntil(
    caches.open(CACHE_NAME).then(function(cache) {
      return cache.addAll(ASSETS);
    }).then(function() {
      // 新バージョンを即座にアクティブ化
      return self.skipWaiting();
    })
  );
});

// アクティベート: 古いキャッシュを削除
self.addEventListener('activate', function(event) {
  console.log('[SW] Activate:', CACHE_VERSION);
  event.waitUntil(
    caches.keys().then(function(keyList) {
      return Promise.all(keyList.map(function(key) {
        if (key !== CACHE_NAME) {
          console.log('[SW] Removing old cache:', key);
          return caches.delete(key);
        }
      }));
    }).then(function() {
      return self.clients.claim();
    })
  );
});

// フェッチ: キャッシュファースト → ネットワークフォールバック
self.addEventListener('fetch', function(event) {
  event.respondWith(
    caches.match(event.request).then(function(cached) {
      if (cached) {
        // キャッシュヒット → バックグラウンドで更新チェック
        var fetchPromise = fetch(event.request).then(function(networkResponse) {
          if (networkResponse && networkResponse.status === 200) {
            var responseClone = networkResponse.clone();
            caches.open(CACHE_NAME).then(function(cache) {
              cache.put(event.request, responseClone);
            });
          }
          return networkResponse;
        }).catch(function() { /* オフライン: 無視 */ });
        return cached;
      }
      // キャッシュなし → ネットワーク
      return fetch(event.request);
    })
  );
});

// メッセージ: アプリからの更新チェック要求
self.addEventListener('message', function(event) {
  if (event.data && event.data.type === 'CHECK_UPDATE') {
    self.registration.update();
  }
  if (event.data && event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});
