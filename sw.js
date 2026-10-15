const CACHE_NAME = 'pacan-chat-v1';
const urlsToCache = [
  '/',
  '/chat',
  '/profile',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache).catch(() => {});
    })
  );
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((names) => {
      return Promise.all(
        names.filter(n => n !== CACHE_NAME).map(n => caches.delete(n))
      );
    })
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  // Не кешируем API-запросы и сокеты
  if (event.request.url.includes('/api/') ||
      event.request.url.includes('/socket.io/') ||
      event.request.url.includes('/avatars/') ||
      event.request.url.includes('/voice/') ||
      event.request.url.includes('/images/')) {
    return;
  }
  event.respondWith(
    fetch(event.request).catch(() => caches.match(event.request))
  );
});