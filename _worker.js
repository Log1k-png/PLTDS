/**
 * Cloudflare Pages _worker.js (Advanced Mode)
 * Intercepte toutes les requetes. Si le chemin commence par /api/,
 * on fait office de proxy vers l'API de La Table des Savoirs.
 * Sinon, Pages sert les fichiers statiques normalement.
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Proxy /api/* vers l'API externe
    if (url.pathname.startsWith('/api/')) {
      // Recupere le chemin API sans le prefixe /api/
      const apiPath = url.pathname.slice(5); // enleve '/api/'

      // Valide le chemin : non vide, pas de traverse, prefixes connus uniquement
      const ALLOWED_PREFIXES = ['seasons', 'leaderboards'];
      const isAllowed =
        apiPath &&
        !apiPath.includes('..') &&
        ALLOWED_PREFIXES.some(p => apiPath === p || apiPath.startsWith(p + '/'));
      if (!isAllowed) {
        return new Response('Not found', { status: 404 });
      }

      const targetUrl = new URL(`https://api.latabledessavoirs.fr/${apiPath}`);
      // Copie les query strings
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });

      const modifiedRequest = new Request(targetUrl, {
        method: request.method,
        headers: {
          'Accept': 'application/json',
        },
      });

      try {
        const response = await fetch(modifiedRequest);
        return new Response(response.body, {
          status: response.status,
          statusText: response.statusText,
          headers: {
            'content-type': response.headers.get('content-type') || 'application/json',
            'cache-control': 'no-cache',
          },
        });
      } catch (err) {
        return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
          status: 502,
          headers: { 'content-type': 'application/json' },
        });
      }
    }

    // Pour toutes les autres requetes, servir les assets statiques normalement
    return env.ASSETS.fetch(request);
  }
};
