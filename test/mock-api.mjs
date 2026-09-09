import http from 'node:http';

const BASE_SCORE = { alice: 200, bob: 150, carol: 300, dave: 175 };

/**
 * Mock de l'API de La Table des Savoirs pour tests deterministes.
 * - /seasons/progress retourne un currentDay controlable.
 * - /leaderboards/day/:day/:diff/top retourne les joueurs ayant joue ce jour.
 * - POST /__control pilote l'etat (jour courant, rosters, bonus).
 * - GET /__log expose le journal des requetes upstream (pour prouver les
 *   hits/miss du cache du worker).
 */
export function createMockApi({ initialDay = 227 } = {}) {
  let day = initialDay;
  const rosterByDay = new Map(); // day -> [usernames]
  const bonusByDay = new Set(); // days with bonus applied
  const requests = [];

  function rosterFor(dayNum) {
    if (rosterByDay.has(dayNum)) return rosterByDay.get(dayNum);
    return ['alice', 'bob']; // default
  }

  function entriesFor(dayNum) {
    const bonus = bonusByDay.has(dayNum);
    return rosterFor(dayNum).map((username, i) => ({
      username,
      score: BASE_SCORE[username] + (bonus ? 50 : 0),
      correctCount: 10,
      rank: i + 1,
      correctTimeMs: i * 1000,
    }));
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    requests.push({ method: req.method, path: url.pathname, query: url.search });

    const send = (status, body) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };

    if (req.method === 'POST' && url.pathname === '/__control') {
      let raw = '';
      req.on('data', c => (raw += c));
      req.on('end', () => {
        const ctrl = JSON.parse(raw || '{}');
        if (ctrl.currentDay != null) day = ctrl.currentDay;
        if (ctrl.roster) {
          for (const [d, names] of Object.entries(ctrl.roster)) rosterByDay.set(Number(d), names);
        }
        if (ctrl.bonus) {
          for (const d of ctrl.bonus) bonusByDay.add(Number(d));
        }
        if (ctrl.clearLog) requests.length = 0;
        send(200, { ok: true });
      });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/__log') {
      send(200, { requests });
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

    const m = url.pathname.match(/^\/leaderboards\/day\/(\d+)\/(facile|difficile)\/top$/);
    if (m) {
      const dayNum = Number(m[1]);
      const entries = entriesFor(dayNum);
      send(200, { dayNumber: dayNum, difficulty: m[2], totalEntries: entries.length, entries });
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