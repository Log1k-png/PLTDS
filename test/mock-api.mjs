import http from 'node:http';

const BASE_SCORE = { alice: 200, bob: 150, carol: 300, dave: 175 };

/**
 * Mock de l'API de La Table des Savoirs pour tests deterministes.
 * - /seasons et /seasons/progress retournent la saison courante.
 * - /leaderboards/season/:season/:diff/search retourne un joueur suivi.
 * - /public-profile/:pseudo/season-progress/:season retourne un historique joueur.
 */
export function createMockApi({ initialDay = 227 } = {}) {
  const day = initialDay;

  function historyFor(username, seasonNumber) {
    const answerMask = username === 'bob'
      ? [2, 2, 4, 4, 8, 8, 1, 1, 0, 0]
      : [2, 4, 8, 1, 0, 2, 4, 8, 1, 0];
    const days = {};
    for (let d = 220; d <= day; d++) {
      const score = BASE_SCORE[username] + d - 220;
      days[d] = {
        facile: { completed: true, score, answerMask },
        difficile: { completed: true, score: score + 100, answerMask: new Array(10).fill(2) },
      };
    }
    return {
      username,
      season: { seasonNumber, name: 'Septembre 2026', dayStart: 220, dayEnd: 249 },
      firstDayDate: '2026-01-25T10:00:00.000Z',
      currentDay: day,
      days,
    };
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if ((req.method === 'GET' || req.method === 'HEAD') && url.pathname === '/seasons') {
      const season = { seasonNumber: 9, name: 'Septembre 2026', dayStart: 220, dayEnd: 249 };
      send(200, { currentSeason: season, seasons: [season] });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/seasons/slow') {
      setTimeout(() => send(200, { ok: true }), 10500);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/seasons/progress') {
      send(200, {
        season: { seasonNumber: 9, name: 'Septembre 2026', dayStart: 220, dayEnd: 249 },
        firstDayDate: '2026-01-25T10:00:00.000Z',
        currentDay: day,
        days: {},
      });
      return;
    }

    const search = url.pathname.match(/^\/leaderboards\/season\/(\d+)\/(facile|difficile)\/search$/);
    if (req.method === 'GET' && search) {
      const username = url.searchParams.get('q');
      if (!Object.prototype.hasOwnProperty.call(BASE_SCORE, username)) {
        send(200, []);
        return;
      }
      const score = BASE_SCORE[username] + (search[2] === 'difficile' ? 100 : 0);
      send(200, [{ username, score, rank: 1 }]);
      return;
    }

    const profile = url.pathname.match(/^\/public-profile\/([^/]+)\/season-progress\/(\d+)$/);
    if (req.method === 'GET' && profile) {
      const username = decodeURIComponent(profile[1]);
      if (!Object.prototype.hasOwnProperty.call(BASE_SCORE, username)) {
        send(404, { error: 'not found' });
        return;
      }
      send(200, historyFor(username, Number(profile[2])));
      return;
    }

    send(404, { error: 'not found' });
  });

  const listen = () =>
    new Promise(resolve => {
      server.listen(0, '127.0.0.1', () => resolve(server.address().port));
    });

  const close = () =>
    new Promise(resolve => server.close(resolve));

  return { listen, close, url: () => `http://127.0.0.1:${server.address().port}` };
}
