// オフライン対応：必要なファイルを事前キャッシュし、キャッシュ優先で返す。
// ファイルを更新したら CACHE のバージョンを上げる（景品データは IndexedDB にあり影響しない）。
const CACHE = 'omikuji-v3';
const FILES = [
  './',
  './index.html',
  './styles.css',
  './js/app.js',
  './js/db.js',
  './js/lottery.js',
  './manifest.webmanifest',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/apple-touch-icon.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE).then((c) => c.addAll(FILES)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  event.respondWith(
    caches.match(req, { ignoreSearch: true }).then((hit) => {
      if (hit) return hit;
      if (req.mode === 'navigate') {
        return caches.match('./index.html').then((page) => page || fetch(req));
      }
      return fetch(req);
    })
  );
});
