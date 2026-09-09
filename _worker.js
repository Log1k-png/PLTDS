/**
 * Cloudflare Pages _worker.js (Advanced Mode)
 * Intercepte toutes les requetes. Si le chemin commence par /api/,
 * on fait office de proxy vers l'API de La Table des Savoirs.
 * Sinon, on ne sert que les fichiers statiques de la liste ALLOWED_STATIC
 * (tout le reste, y compris README.md, repond 404).
 *
 * Cache : les tops du jour de jours anciens (day <= currentDay - 2) sont mis
 * en cache via la Cache API (7 jours). Aujourd'hui et hier sont caches
 * 2 heures. Chaque entree recente est marquee avec le jour courant (x-cache-day)
 * a l'ecriture : si le jour change (minuit), les tops d'hier, qui reçoivent
 * leurs bonus, ne sont plus servis tels quels et sont rafraichis de maniere
 * bloquante. Un parametre `refresh=1` ignore le cache et re-ecrit l'entree.
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
  '/google8cc9053260b18b8f.html',
]);

const API_BASE_DEFAULT = 'https://api.latabledessavoirs.fr';

const DAY_CACHE_TTL = 60 * 60 * 24 * 7; // 7 jours (secondes)
const RECENT_CACHE_TTL = 60 * 60 * 2; // 2 heures (secondes) pour aujourd'hui et hier
const CACHE_AFTER_DAYS = 2; // on ne cache que les jours finis depuis >= 2 jours
const PROGRESS_TTL_MS = 60 * 1000; // memoisation de /seasons/progress

let progressMemo = { day: null, at: 0 };

async function getCurrentDay(apiBase, ttlMs = PROGRESS_TTL_MS) {
  const now = Date.now();
  if (progressMemo.day != null && now - progressMemo.at < ttlMs) {
    return progressMemo.day;
  }
  try {
    const resp = await fetch(`${apiBase}/seasons/progress`, {
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

/**
 * Decide si une reponse en cache doit etre servie telle quelle.
 *
 * Les entrees recentes (aujourd'hui / hier) sont marquees avec le jour courant
 * (x-cache-day) a l'ecriture. Si ce marqueur differe du jour actuel, l'entree
 * date d'avant le changement de jour : les scores d'hier reçoivent leurs bonus
 * au passage du jour, elle est donc perimee et on refuse de la servir (le
 * handler ira chercher des donnees fraiches de maniere bloquante).
 *
 * Pour le top d'AUJOURD'HUI demande avec `users`, on ne sert en plus la
 * reponse en cache que si chaque joueur demande y est present. Si un joueur
 * est absent (il vient de jouer, sa note n'etait pas encore en cache), on
 * refuse egalement de servir le cache (refresh bloquant).
 */
async function shouldServeCached(cached, recentCache, dayNum, currentDay, usersParam) {
  // Refuser de servir en cas de reponse d'erreur en cache.
  if (!cached.ok) return false;

  // Jour roule : une entree recente dont le marqueur de jour differe du jour
  // actuel est perimee (scores d'hier pre-bonus). On ne la sert pas.
  if (recentCache && cached.headers.get('x-cache-day') !== String(currentDay)) {
    return false;
  }

  // Le controle "joueur manquant" ne concerne que le top d'aujourd'hui,
  // et uniquement quand une liste `users` est fournie.
  if (!(recentCache && dayNum === currentDay && usersParam)) return true;

  try {
    const body = await cached.clone().json();
    const cachedUsers = new Set(
      Array.isArray(body.entries) ? body.entries.map(e => e && e.username).filter(Boolean) : []
    );
    const wanted = usersParam.split(',').map(u => u.trim()).filter(Boolean);
    // Si au moins un joueur demande est absent du cache, ne pas servir.
    return wanted.every(u => cachedUsers.has(u));
  } catch (err) {
    // Impossible de parser la reponse en cache : on ne la sert pas
    // (on retombe sur la recuperation directe).
    return false;
  }
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const apiBase = env.API_BASE_URL || API_BASE_DEFAULT;
    // Permet de desactiver la memoisation de /seasons/progress (tests).
    const progressTtlMs = env.PROGRESS_TTL_MS != null ? Number(env.PROGRESS_TTL_MS) : PROGRESS_TTL_MS;

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

      const targetUrl = new URL(`${apiBase}/${apiPath}`);
      // Copie les query strings
      url.searchParams.forEach((value, key) => {
        targetUrl.searchParams.set(key, value);
      });

      // Parametre `users` : liste de pseudonymes a renvoyer (filtre cote serveur).
      const usersParam = url.searchParams.get('users');

      // Jour en cours, detecte via /seasons/progress (memoise 60s).
      // Utilise pour savoir si une entree en cache appartient a un jour
      // anterieur (les tops d'hier recoivent leurs bonus au changement de jour).
      let currentDay = null;

      // Cache d'un top du jour :
      //   - jours anciens (>= 2 jours) : TTL 7 jours, sans controle particulier.
      //   - hier : TTL 2 heures, mais invalide si le jour courant a change
      //     (bonus appliques aux scores d'hier au passage du jour).
      //   - aujourd'hui : TTL 2 heures, MAIS si un joueur demande (`users`) est
      //     absent de la reponse en cache (il vient de jouer), on rafraichit de
      //     maniere bloquante et on renvoie des donnees fraiches.
      const dayMatch = apiPath.match(/^leaderboards\/day\/(\d+)\/(facile|difficile)\/top$/);
      let cacheKey = null;
      let recentCache = false;
      if (dayMatch) {
        const dayNum = parseInt(dayMatch[1], 10);
        currentDay = await getCurrentDay(apiBase, progressTtlMs);
        if (currentDay != null) {
          if (dayNum <= currentDay - CACHE_AFTER_DAYS) {
            // Jour ancien et clos depuis >= 2 jours.
            cacheKey = new Request(url.toString(), request);
          } else if (dayNum === currentDay - 1 || dayNum === currentDay) {
            // Hier ou aujourd'hui : cache court (2h).
            cacheKey = new Request(url.toString(), request);
            recentCache = true;
          }
        }

        if (cacheKey && !fresh) {
          const cached = await caches.default.match(cacheKey);
          if (cached) {
            const serve = await shouldServeCached(cached, recentCache, dayNum, currentDay, usersParam);
            if (serve) {
              // Ne jamais muter les en-tetes de la reponse venant du cache
              // (Headers immuables -> TypeError). On reconstruit une reponse
              // pour le client : sans le marqueur interne, et sans cache
              // navigateur (c'est le worker qui decide de la fraicheur).
              const headers = new Headers(cached.headers);
              headers.delete('x-cache-day');
              headers.set('cache-control', 'no-store');
              return new Response(cached.body, { status: cached.status, statusText: cached.statusText, headers });
            }
          }
        }
      }

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
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          });
        } catch (err) {
          resp = new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
            status: 502,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
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
              'cache-control': 'no-store',
            },
          });
        } catch (err) {
          resp = new Response(JSON.stringify({ error: 'Proxy error', message: err.message }), {
            status: 502,
            headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
          });
        }
      }

      if (cacheKey && resp.ok) {
        // La copie stockee garde le marqueur du jour et son propre TTL :
        // caches.default lit cache-control (max-age) pour expirer l'entree.
        const cacheResp = resp.clone();
        cacheResp.headers.set('x-cache-day', String(currentDay));
        cacheResp.headers.set('cache-control', `public, max-age=${recentCache ? RECENT_CACHE_TTL : DAY_CACHE_TTL}`);
        ctx.waitUntil(caches.default.put(cacheKey, cacheResp));
        // Le client ne doit jamais mettre en cache : c'est le worker qui
        // decide de servir son cache ou de rafraichir (marqueur / joueur absent).
        resp.headers.set('cache-control', 'no-store');
      }
      return resp;
    }

    // Pour les autres requetes, ne servir que les fichiers de la liste blanche
    const normalized = url.pathname === '/'
      ? '/'
      : url.pathname.replace(/\/+$/, '') || '/';
    if (ALLOWED_STATIC.has(normalized) || ALLOWED_STATIC.has(normalized + '/index.html')) {
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

// Expose la logique de decision (tests unitaires Node, sans effe sur wrangler).
export { shouldServeCached };