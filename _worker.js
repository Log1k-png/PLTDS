/**
 * Cloudflare Pages _worker.js (Advanced Mode)
 * Intercepte toutes les requetes. Si le chemin commence par /api/,
 * on fait office de proxy vers l'API de La Table des Savoirs.
 * Sinon, on ne sert que les fichiers statiques de la liste ALLOWED_STATIC
 * (tout le reste, y compris README.md, repond 404).
 *
 * Les reponses API sont toujours `no-store` : le navigateur ne conserve pas
 * de donnees metier et chaque chargement demande des donnees fraiches.
 *
 * L'URL de l'API upstream peut etre surchargee via la variable d'environnement
 * API_BASE_URL (permettant le developpement contre un mock local).
 */

// Seuls ces fichiers sont servis publiquement. Ajoutez ici tout nouveau
// fichier du site (image, page, etc.) pour le rendre accessible.
const ALLOWED_STATIC = new Set([
  '/',
  '/index.html',
  '/app.js',
  '/style.css',
  '/favicon.png',
  '/og-image.png',
  '/robots.txt',
  '/sitemap.xml',
  '/sw.js',
]);

// Dossier(s) servis en entier (tout fichier qu'ils contiennent est public).
const ALLOWED_PREFIXES = ['/assets/'];

const API_BASE_DEFAULT = 'https://api.latabledessavoirs.fr';

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const apiBase = env.API_BASE_URL || API_BASE_DEFAULT;

    // Proxy /api/* vers l'API externe
    if (url.pathname.startsWith('/api/')) {
      // Recupere le chemin API sans le prefixe /api/
      const apiPath = url.pathname.slice(5); // enleve '/api/'

      // Valide le chemin : non vide, pas de traverse, prefixes connus uniquement.
      // The profile history route is intentionally exact rather than exposing
      // the complete public-profile API surface.
      const ALLOWED_PREFIXES = ['seasons', 'leaderboards'];
      const isPublicProfileHistory = /^public-profile\/[^/]+\/season-progress\/\d+$/.test(apiPath);
      const isAllowed =
        apiPath &&
        !apiPath.includes('..') &&
        (ALLOWED_PREFIXES.some(p => apiPath === p || apiPath.startsWith(p + '/')) || isPublicProfileHistory);
      if (!isAllowed) {
        return new Response('Not found', { status: 404 });
      }

      const targetUrl = new URL(`${apiBase}/${apiPath}`);
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });

      try {
        const upstream = await fetch(new Request(targetUrl, {
          method: request.method,
          headers: { 'Accept': 'application/json' },
        }));
        return new Response(upstream.body, {
          status: upstream.status,
          statusText: upstream.statusText,
          headers: {
            'content-type': upstream.headers.get('content-type') || 'application/json',
            'cache-control': 'no-store',
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
          status: 502,
          headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
        });
      }
    }

    // Pour les autres requetes, ne servir que les fichiers de la liste blanche
    const normalized = url.pathname === '/'
      ? '/'
      : url.pathname.replace(/\/+$/, '') || '/';
    if (
      ALLOWED_STATIC.has(normalized) ||
      ALLOWED_STATIC.has(normalized + '/index.html') ||
      ALLOWED_PREFIXES.some(prefix => normalized.startsWith(prefix))
    ) {
      // Sitemap et robots.txt : renvoyer une reponse explicite, bien identifiable
      // par les crawlers (Content-Type, Vary: Accept-Encoding, cache positif).
      // Le passthrough brut via env.ASSETS.fetch ne fournit pas toujours
      // l'en-tete Vary, ce qui peut faire echouer la lecture du sitemap dans GSC.
      if (normalized === '/sitemap.xml' || normalized === '/robots.txt') {
        const asset = await env.ASSETS.fetch(request);
        const body = await asset.arrayBuffer();
        const isXml = normalized === '/sitemap.xml';
        const headers = new Headers(asset.headers);
        headers.set('content-type', isXml ? 'application/xml; charset=utf-8' : 'text/plain; charset=utf-8');
        headers.set('cache-control', 'public, max-age=3600');
        headers.set('vary', 'Accept-Encoding');
        return new Response(body, { status: asset.status, statusText: asset.statusText, headers });
      }
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404, headers: { 'cache-control': 'no-store' } });
  }
};
