/**
 * Cloudflare Pages _worker.js (Advanced Mode)
 * Intercepte toutes les requetes. Si le chemin commence par /api/,
 * on fait office de proxy vers l'API de La Table des Savoirs.
 * Sinon, on ne sert que les fichiers statiques de la liste ALLOWED_STATIC
 * (tout le reste, y compris README.md, repond 404).
 *
 * Cache : les tops du jour de jours anciens (day <= currentDay - 2) sont mis
 * en cache via la Cache API (7 jours). Aujourd'hui et hier ne sont jamais
 * caches. Un parametre `refresh=1` ignore le cache et re-ecrit l'entree.
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
  '/google8cc9053260b18b8f.html',
]);

const DAY_CACHE_TTL = 60 * 60 * 24 * 7; // 7 jours (secondes)
const CACHE_AFTER_DAYS = 2; // on ne cache que les jours finis depuis >= 2 jours
const PROGRESS_TTL_MS = 60 * 1000; // memoisation de /seasons/progress

let progressMemo = { day: null, at: 0 };

async function getCurrentDay() {
  const now = Date.now();
  if (progressMemo.day != null && now - progressMemo.at < PROGRESS_TTL_MS) {
    return progressMemo.day;
  }
  try {
    const resp = await fetch('https://api.latabledessavoirs.fr/seasons/progress', {
      headers: { 'Accept': 'application/json' },
    });
    if (resp.ok) {
      const data = await resp.json();
      const day = data && data.currentDay;
      if (day) {
        progressMemo = { day, at: now };
        return day;
      }
    }
  } catch (err) {
    // En cas d'echec, pas de cache : la reponse est passee telle quelle.
  }
  return null;
}

export default {
  async fetch(request, env, ctx) {
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

      // `refresh=1` : ignore le cache et re-ecrit l'entree.
      const fresh = url.searchParams.get('refresh') === '1';
      if (fresh) url.searchParams.delete('refresh');

      const targetUrl = new URL(`https://api.latabledessavoirs.fr/${apiPath}`);
      // Copie les query strings
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });

      // Un top du jour est mis en cache si le jour est fini depuis >= 2 jours.
      const dayMatch = apiPath.match(/^leaderboards\/day\/(\d+)\/(facile|difficile)\/top$/);
      let cacheKey = null;
      if (dayMatch) {
        const dayNum = parseInt(dayMatch[1], 10);
        const currentDay = await getCurrentDay();
        if (currentDay != null && dayNum <= currentDay - CACHE_AFTER_DAYS) {
          cacheKey = new Request(url.toString(), request);
          if (!fresh) {
            const cached = await caches.default.match(cacheKey);
            if (cached) return cached;
          }
        }
      }

      // Filtre cote serveur : si un parametre `users` est fourni sur un top du jour,
      // on ne renvoie que les entrees correspondant a ces pseudonymes (reduit la bande passante).
      const usersParam = url.searchParams.get('users');
      let resp;
      if (usersParam && apiPath.startsWith('leaderboards/day/') && apiPath.endsWith('/top')) {
        const wanted = new Set(usersParam.split(',').map(u => u.trim()).filter(Boolean));
        targetUrl.searchParams.delete('users');
        try {
          const upstream = await fetch(targetUrl, {
            headers: { 'Accept': 'application/json' },
          });
          const data = await upstream.json();
          const entries = Array.isArray(data.entries)
            ? data.entries
                .filter(e => wanted.has(e.username))
                .map(e => ({ username: e.username, score: e.score, correctCount: e.correctCount }))
            : [];
          resp = new Response(JSON.stringify({
            dayNumber: data.dayNumber,
            difficulty: data.difficulty,
            entries,
          }), {
            status: upstream.status,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-cache' },
          });
        } catch (err) {
          resp = new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
      } else {
        const modifiedRequest = new Request(targetUrl, {
          method: request.method,
          headers: {
            'Accept': 'application/json',
          },
        });

        try {
          const upstream = await fetch(modifiedRequest);
          resp = new Response(upstream.body, {
            status: upstream.status,
            statusText: upstream.statusText,
            headers: {
              'content-type': upstream.headers.get('content-type') || 'application/json',
              'cache-control': 'no-cache',
            },
          });
        } catch (err) {
          resp = new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
            status: 502,
            headers: { 'content-type': 'application/json' },
          });
        }
      }

      if (cacheKey && resp.ok) {
        resp.headers.set('cache-control', `public, max-age=${DAY_CACHE_TTL}`);
        ctx.waitUntil(caches.default.put(cacheKey, resp.clone()));
      }
      return resp;
    }

    // Pour les autres requetes, ne servir que les fichiers de la liste blanche
    const normalized = url.pathname === '/'
      ? '/'
      : url.pathname.replace(/\/+$/, '') || '/';
    if (ALLOWED_STATIC.has(normalized) || ALLOWED_STATIC.has(normalized + '/index.html')) {
      return env.ASSETS.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  }
};
