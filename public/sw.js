// Bump CACHE_VERSION whenever the app shell or the precache list changes.
// An unversioned name survives upgrades, so a cached document keeps pointing
// at content-hashed chunks the new build no longer ships.
const CACHE_VERSION = 'v3';
const CACHE_NAME = `just-write-ehis-${CACHE_VERSION}`;
const STATIC_ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

// Install: cache static assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      return cache.addAll(STATIC_ASSETS);
    })
  );
  self.skipWaiting();
});

// Activate: drop every cache that is not the current version, so an upgraded
// install can never be served a document from a previous build. The desktop
// shell needs no host sniffing here: index.html unregisters the worker and
// clears caches from the page, where the Tauri check is authoritative, and the
// version bump below is what retires a cache a previous build poisoned.
self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const cacheNames = await caches.keys();
      await Promise.all(
        cacheNames
          .filter((name) => name !== CACHE_NAME)
          .map((name) => caches.delete(name))
      );
      await self.clients.claim();
    })()
  );
});

/**
 * Documents are network-first, always. Serving HTML from cache is what turns a
 * routine update into a dead app: the document names a hashed entry chunk, the
 * new build ships a different one, and the cached page requests a file that no
 * longer exists. Hashed build assets are content-addressed, so cache-first is
 * safe and correct for them.
 */
function isDocumentRequest(request) {
  return (
    (request.mode === 'navigate' ||
      (request.headers.get('accept') || '').includes('text/html')) &&
    !new URL(request.url).pathname.startsWith('/assets/')
  );
}

function isHashedAsset(url) {
  return url.pathname.startsWith('/assets/');
}

// Fetch: documents network-first, hashed assets cache-first, rest stale-while-revalidate
self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // Skip non-GET requests
  if (request.method !== 'GET') return;

  // Skip external requests
  if (url.origin !== location.origin) return;

  // Documents: network-first, cache only as the offline fallback.
  if (isDocumentRequest(request)) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse.ok) {
            const copy = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
          }
          return networkResponse;
        })
        .catch(() =>
          caches.match(request).then(
            (cached) =>
              cached ||
              caches.match('./index.html').then(
                (shell) =>
                  shell ||
                  new Response('Offline', {
                    status: 503,
                    statusText: 'Service Unavailable',
                  })
              )
          )
        )
    );
    return;
  }

  // Hashed build assets are immutable: cache-first, no revalidation cost.
  if (isHashedAsset(url)) {
    event.respondWith(
      caches.match(request).then(
        (cached) =>
          cached ||
          fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              const copy = networkResponse.clone();
              caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
            }
            return networkResponse;
          })
      )
    );
    return;
  }

  // Everything else same-origin: serve fast, refresh in the background.
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      if (cachedResponse) {
        // Return cached response, update in background
        event.waitUntil(
          fetch(request).then((networkResponse) => {
            if (networkResponse.ok) {
              caches.open(CACHE_NAME).then((cache) => {
                cache.put(request, networkResponse.clone());
              });
            }
          }).catch(() => { /* offline, ignore */ })
        );
        return cachedResponse;
      }

      // Not in cache, fetch from network
      return fetch(request).then((networkResponse) => {
        // Cache successful responses
        if (networkResponse.ok) {
          const responseToCache = networkResponse.clone();
          caches.open(CACHE_NAME).then((cache) => {
            cache.put(request, responseToCache);
          });
        }
        return networkResponse;
      }).catch(() => {
        // Return offline response for other assets
        return new Response('Offline', { status: 503, statusText: 'Service Unavailable' });
      });
    })
  );
});

// Capture notification tap (Android "notification" capture method):
// open the app at the capture box, focusing an already-open client.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = (event.notification.data && event.notification.data.url) || './?capture=inbox';
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      for (const client of clients) {
        if ('focus' in client) {
          client.postMessage({ type: 'SHARED_CONTENT', payload: { text: '' } });
          return client.focus();
        }
      }
      if (self.clients.openWindow) return self.clients.openWindow(target);
    })
  );
});

// Handle share target
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SHARED_CONTENT') {
    // Forward shared content to the app
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
      clients.forEach((client) => {
        client.postMessage({
          type: 'SHARED_CONTENT',
          payload: event.data.payload
        });
      });
    });
  }
});

// Background sync for pending writes
self.addEventListener('sync', (event) => {
  if (event.tag === 'pending-writes') {
    event.waitUntil(syncPendingWrites());
  }
});

async function syncPendingWrites() {
  const db = await openDB();
  const pending = await db.getAll('pending-writes');
  for (const write of pending) {
    try {
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(write)
      });
      await db.delete('pending-writes', write.id);
    } catch (e) {
      console.error('Failed to sync write:', e);
    }
  }
}

function openDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('just-write-ehis', 1);
    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains('pending-writes')) {
        db.createObjectStore('pending-writes', { keyPath: 'id', autoIncrement: true });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}