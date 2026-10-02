// Bump this version string every time index.html / app.js change so old
// caches get discarded and the new files are fetched fresh.
const CACHE_VERSION = "v15";
const CACHE_NAME = "gospel-partners-" + CACHE_VERSION;
const APP_SHELL = [
  "./index.html",
  "./app.js",
  "./manifest.json",
  "./icon-192.png",
  "./icon-512.png",
  "./logo-header.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  // Take over immediately instead of waiting for old tabs to close.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))
      )
    )
  );
  self.clients.claim();
});

// Network-first: always try to fetch the latest version from the server.
// Only fall back to the cached copy when the network request fails (offline).
// This means as soon as new files are deployed, the next load picks them up -
// the cache exists purely as an offline safety net, not as the primary source.
self.addEventListener("fetch", (event) => {
  if (event.request.method !== "GET") return;

  event.respondWith(
    fetch(event.request, { cache: "no-store" })
      .then((response) => {
        const copy = response.clone();
        caches.open(CACHE_NAME).then((cache) => cache.put(event.request, copy));
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});

// Let a page ask the waiting worker to activate immediately (used by app.js
// after it detects an update is available).
self.addEventListener("message", (event) => {
  if (event.data === "skipWaiting") {
    self.skipWaiting();
  }
});
