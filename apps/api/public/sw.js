// Service worker Loreforge (SPEC §8.3) : PWA installable + hors-ligne
// minimal. Assets ET API en réseau d'abord avec repli cache — le
// stale-while-revalidate initial servait l'ancien front après chaque
// déploiement (constaté : l'utilisateur retestait un bug déjà corrigé).
// Jamais de cache sur les mutations ni sur les flux SSE.

const VERSION = "lf-v2";
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

  // Assets : réseau d'abord (toujours le front à jour en ligne), repli
  // cache pour le hors-ligne / écran verrouillé.
  event.respondWith(
    fetch(event.request)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(ASSET_CACHE).then((cache) => cache.put(event.request, copy));
        }
        return res;
      })
      .catch(async () => {
        const cached = await caches.match(event.request);
        return cached || Response.error();
      }),
  );
});
