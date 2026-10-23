const CACHE_NAME = 'pacan-chat-v3'; // Меняем версию, чтобы сбросить старый кэш
const urlsToCache = [
  '/',
  '/chat',
  '/profile',
  '/manifest.json'
];

self.addEventListener('install', (event) => {
  self.skipWaiting(); // Принудительно активируем новый Service Worker
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(urlsToCache).catch(() => {});
    })
  );
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

// СТРАТЕГИЯ: Сначала сеть, потом кэш (Network First)
self.addEventListener('fetch', (event) => {
  if (event.request.url.includes('/api/') ||
      event.request.url.includes('/socket.io/') ||
      event.request.url.includes('/avatars/') ||
      event.request.url.includes('/voice/') ||
      event.request.url.includes('/images/')) {
    return;
  }
  
  event.respondWith(
    fetch(event.request)
      .then((response) => {
        // Если сеть ответила, кладём свежую версию в кэш
        const responseClone = response.clone();
        caches.open(CACHE_NAME).then((cache) => {
          cache.put(event.request, responseClone);
        });
        return response;
      })
      .catch(() => {
        // Если сети нет, отдаём из кэша
        return caches.match(event.request);
      })
  );
});