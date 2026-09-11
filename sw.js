/* Service worker : application PWA (mode "offline shell").
 *
 * Seul le "shell" de l'application est mis en cache (HTML, JS, CSS, icones,
 * manifest). Les requetes metier (/api/*) ne sont pas mises en cache : hors
 * ligne, l'interface s'ouvre mais les donnees sont absentes.
 *
 * Strategie : network-first, repli sur le cache hors ligne. Les fichiers
 * servis en ligne rafraichissent le cache (les deploiements sont donc pris
 * en compte), et le cache permet l'ouverture du site sans connexion.
 */

const CACHE = 'pltds-shell-v2';

const SHELL = [
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/favicon.png',
  '/assets/manifest.json',
  '/assets/icon-192.png',
  '/assets/icon-512.png',
  '/assets/apple-touch-icon.png'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      .then((cache) => cache.addAll(SHELL))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  // Navigation : network-first, repli sur le shell en cache.
  if (request.mode === 'navigate') {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put('/index.html', clone));
          return response;
        })
        .catch(() =>
          caches.match(request).then((cached) => cached || caches.match('/index.html'))
        )
    );
    return;
  }

  // Fichiers du shell : network-first, repli cache (et mise a jour du cache).
  if (SHELL.includes(url.pathname)) {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const clone = response.clone();
          caches.open(CACHE).then((cache) => cache.put(request, clone));
          return response;
        })
        .catch(() => caches.match(request))
    );
  }
});