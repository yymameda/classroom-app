// Service Worker for 教室管理アプリ PWA
// キャッシュファースト + バージョン管理

const CACHE_VERSION = 'v1.6.4';
const CACHE_NAME = 'classroom-app-' + CACHE_VERSION;
const ASSETS = [
  './',
  './index.html',
  './pf.html',
  './manifest.json',
  './icon-192.png',
  './icon-512.png'
];
