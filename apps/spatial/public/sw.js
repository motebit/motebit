// Service worker for motebit spatial PWA.
// Cache-first for app shell, network-first for API calls.

const CACHE_NAME = "motebit-spatial-v1";
const APP_SHELL = ["/", "/index.html"];

// Install: pre-cache app shell
self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

// Activate: clean old caches
self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))),
      ),
  );
  self.clients.claim();
});

// Fetch: cache-first for app shell, network-first for API
self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);

  // Network-first for API calls and external resources
  if (
    url.pathname.startsWith("/api/") ||
    url.origin !== self.location.origin ||
    url.pathname.includes("openai.com")
  ) {
    event.respondWith(fetch(event.request).catch(() => caches.match(event.request)));
    return;
  }

  // Cache-first for app shell assets
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;
      return fetch(event.request).then((response) => {
        // Cache successful responses for app assets
        if (response.ok && event.request.method === "GET") {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(event.request, clone));
        }
        return response;
      });
    }),
  );
});
