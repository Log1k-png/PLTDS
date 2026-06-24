/**
 * Cloudflare Pages Function - Proxy API pour La Table des Savoirs
 * Capture toutes les requêtes /api/* et les relaie vers l'API externe.
 * Résout le problème CORS côté navigateur.
 */
export async function onRequest(context) {
  const { request, params } = context;

  // Reconstitue le chemin API à partir des segments capturés
  const apiPath = Array.isArray(params.path) ? params.path.join('/') : (params.path || '');

  // Construit l'URL cible avec les query strings originaux
  const originalUrl = new URL(request.url);
  const targetUrl = new URL(`https://api.latabledessavoirs.fr/${apiPath}`);
  originalUrl.searchParams.forEach((value, key) => {
    targetUrl.searchParams.set(key, value);
  });

  // Prépare la requête vers l'API (depuis le serveur, pas de CORS)
  const modifiedRequest = new Request(targetUrl, {
    method: request.method,
    headers: {
      'Accept': 'application/json',
    },
  });

  try {
    const response = await fetch(modifiedRequest);

    // Clone la réponse pour pouvoir modifier les headers si besoin
    const modifiedResponse = new Response(response.body, {
      status: response.status,
      statusText: response.statusText,
      headers: {
        'content-type': response.headers.get('content-type') || 'application/json',
        // Cache-control pour éviter que le navigateur ne cache trop agressivement
        'cache-control': 'no-cache',
      },
    });

    return modifiedResponse;
  } catch (err) {
    return new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
      status: 502,
      headers: { 'content-type': 'application/json' },
    });
  }
}
