// Service worker : met en cache les fichiers de l'appli pour qu'elle s'ouvre hors ligne.
// Il ne voit ni ne stocke aucune donnée du carnet (elles restent chiffrées dans le stockage local).
// À chaque modification des fichiers, augmenter VERSION pour que les téléphones récupèrent la mise à jour.

const VERSION = "carnet-v1.0.0";
const FILES = [
  "./",
  "index.html",
  "css/app.css",
  "js/app.js",
  "js/crypto.js",
  "js/defaults.js",
  "manifest.webmanifest",
  "icons/icon-192.png",
  "icons/icon-512.png",
  "icons/icon-maskable-512.png",
  "icons/icon-180.png"
];

self.addEventListener("install", (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(FILES)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// Réseau d'abord pour avoir la dernière version, cache en secours hors ligne.
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET" || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    fetch(req)
      .then((res) => {
        if (res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
      .catch(() => caches.match(req, { ignoreSearch: true }).then((hit) => hit || caches.match("index.html")))
  );
});
