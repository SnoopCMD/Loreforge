// Service worker Loreforge (SPEC §8.3) : PWA installable + hors-ligne
// minimal. Assets en cache-first (versionné), API en réseau d'abord avec
// repli cache pour la relecture (sessions terminées, bibliothèque).
// Jamais de cache sur les mutations ni sur les flux SSE.

const VERSION = "lf-v1";
const ASSET_CACHE = VERSION + "-assets";
const API_CACHE = VERSION + "-api";

const ASSETS = [
  "/",
  "/styles.css",
  "/app.js",
  "/core.js",
  "/manifest.webmanifest",
  "/icon.svg",
  "/icon-maskable.svg",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(ASSET_CACHE).then((cache) => cache.addAll(ASSETS)),
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => !key.startsWith(VERSION))
          .map((key) => caches.delete(key)),
      ),
    ),
  );
  self.clients.claim();
});

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET" || url.origin !== self.location.origin) {
    return; // mutations et cross-origin (fonts) : réseau direct
  }

  if (url.pathname.startsWith("/api/")) {
    // Réseau d'abord ; en cas d'échec (hors-ligne, écran verrouillé),
    // repli sur la dernière réponse vue — assez pour relire une session.
    event.respondWith(
      fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(API_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(event.request);
          return (
            cached ||
            new Response(JSON.stringify({ error: "offline" }), {
              status: 503,
              headers: { "content-type": "application/json" },
            })
          );
        }),
    );
    return;
  }

  // Assets : stale-while-revalidate — réponse cache immédiate, mise à jour
  // en arrière-plan (le prochain chargement a la nouvelle version).
  event.respondWith(
    caches.match(event.request).then((cached) => {
      const refresh = fetch(event.request)
        .then((res) => {
          if (res.ok) {
            const copy = res.clone();
            caches.open(ASSET_CACHE).then((cache) => cache.put(event.request, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || refresh;
    }),
  );
});
