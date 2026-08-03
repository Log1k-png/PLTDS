/* ===== Constants ===== */
const API_BASE = '/api';
const STORAGE_KEY = 'pltds_tracked_v4';
const DIFFICULTIES = ['facile', 'difficile'];
const DISPLAY_NAMES = { facile: 'Niveau Abordable', difficile: 'Niveau Expert' };

/* ===== State ===== */
let currentSeason = null;
let activeSeason = null;
let allSeasons = [];
let networkDown = false;
let liveScores = {}; // In-memory only: { seasonNumber: { username: { facile, difficile } } }
let currentDay = null; // Today's day number from /seasons/progress
let todayScores = null; // { dayNumber, facile: Map<username, entry>, difficile: Map<username, entry> }
let yesterdayScores = null; // same structure for the previous day

/* ===== DOM Elements ===== */
const els = {
  loadingOverlay: document.getElementById('loading-overlay'),
  progressBar: document.querySelector('.progress-bar'),
  progressFill: document.querySelector('.progress-fill'),
  networkError: document.getElementById('network-error'),
  retryBtn: document.getElementById('retry-btn'),
  seasonPrev: document.getElementById('season-prev'),
  seasonNext: document.getElementById('season-next'),
  seasonDisplay: document.getElementById('season-display'),
  input: document.getElementById('username-input'),
  searchBtn: document.getElementById('search-btn'),
  clearSearchBtn: document.getElementById('clear-search-btn'),
  status: document.getElementById('search-status'),
  results: document.getElementById('search-results'),
  clearBtn: document.getElementById('clear-btn'),
  playerList: document.getElementById('player-list'),
  shareBtn: document.getElementById('share-btn'),
  abordableStats: document.getElementById('abordable-stats'),
  expertStats: document.getElementById('expert-stats'),
};

const tables = {
  facile: {
    empty: document.getElementById('abordable-empty'),
    wrap: document.getElementById('abordable-table-wrap'),
    body: document.getElementById('abordable-body'),
  },
  difficile: {
    empty: document.getElementById('expert-empty'),
    wrap: document.getElementById('expert-table-wrap'),
    body: document.getElementById('expert-body'),
  },
};

/* ===== Storage (tracked usernames only) ===== */
function loadTracked() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return data;
    if (data.tracked && Array.isArray(data.tracked)) return data.tracked;
    return [];
  } catch {
    return [];
  }
}

function saveTracked(tracked) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify({ tracked }));
}

/* ===== API Helpers ===== */
async function apiGet(path, params = {}) {
  const url = new URL(API_BASE + path, window.location.origin);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) {
      if (resp.status >= 500) {
        networkDown = true;
        if (els.networkError) els.networkError.classList.remove('hidden');
        throw new Error('Le serveur de La Table des Savoirs est indisponible.');
      }
      throw new Error(`HTTP ${resp.status}`);
    }
    networkDown = false;
    if (els.networkError) els.networkError.classList.add('hidden');
    return resp.json();
  } catch (err) {
    clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      throw new Error('Le serveur met trop de temps à répondre.');
    }
    if (err.message && err.message.includes('Failed to fetch')) {
      networkDown = true;
      if (els.networkError) els.networkError.classList.remove('hidden');
      throw new Error('Impossible de contacter le serveur. Vérifiez votre connexion.');
    }
    throw err;
  }
}

async function fetchSeasons() {
  const data = await apiGet('/seasons');
  return {
    current: data.currentSeason.seasonNumber,
    seasons: data.seasons.map(s => ({ number: s.seasonNumber, name: s.name })),
  };
}

async function searchLeaderboard(season, difficulty, query) {
  return apiGet(`/leaderboards/season/${season}/${difficulty}/search`, { q: query });
}

/* ===== Today / Yesterday Scores ===== */
async function fetchCurrentDay() {
  const data = await apiGet('/seasons/progress');
  return data.currentDay;
}

async function fetchDayEntries(dayNumber, difficulty) {
  const params = { limit: -1 };
  const tracked = loadTracked();
  if (tracked.length > 0) params.users = tracked.join(',');
  const data = await apiGet(`/leaderboards/day/${dayNumber}/${difficulty}/top`, params);
  return Array.isArray(data.entries) ? data.entries : [];
}

async function loadDayScores(dayNumber) {
  const result = { dayNumber };
  await Promise.all(
    DIFFICULTIES.map(async diff => {
      try {
        const entries = await fetchDayEntries(dayNumber, diff);
        result[diff] = new Map(entries.map(e => [e.username, e]));
      } catch (err) {
        console.warn(`Failed to load day ${dayNumber} ${diff}:`, err);
      }
    })
  );
  return result;
}

async function loadRecentScores() {
  if (!currentDay) return;
  if (todayScores && todayScores.dayNumber === currentDay) return;

  const [today, yesterday] = await Promise.all([
    loadDayScores(currentDay),
    loadDayScores(currentDay - 1),
  ]);
  todayScores = today;
  yesterdayScores = yesterday;
}

/* ===== Live Score Fetching ===== */
async function fetchPlayerScores(username, season) {
  const result = { username, facile: null, difficile: null };
  for (const diff of DIFFICULTIES) {
    try {
      const list = await searchLeaderboard(season, diff, username);
      if (Array.isArray(list) && list.length > 0) {
        result[diff] = { score: list[0].score, rank: list[0].rank };
      }
    } catch (err) {
      console.warn(`Fetch failed for ${username}/${diff}:`, err);
    }
  }
  return result;
}

async function fetchAllTrackedScores(season) {
  const tracked = loadTracked();
  if (tracked.length === 0) {
    liveScores[season] = {};
    return;
  }

  showSpinner(`Chargement des scores pour la saison ${season}…`);
  liveScores[season] = {};

  for (let i = 0; i < tracked.length; i++) {
    const username = tracked[i];
    updateSpinnerProgress(
      `Chargement des scores… ${i + 1}/${tracked.length}`,
      i + 1,
      tracked.length
    );
    const scores = await fetchPlayerScores(username, season);
    liveScores[season][username] = scores;
  }

  hideSpinner();
}

/* ===== Data Mutation ===== */
function addTrackedUsername(username) {
  const tracked = loadTracked();
  if (!tracked.includes(username)) {
    tracked.push(username);
    saveTracked(tracked);
  }
}

function removeTrackedPlayer(username) {
  if (!confirm(`Retirer ${username} de votre leaderboard ?`)) return;
  const tracked = loadTracked().filter(u => u !== username);
  saveTracked(tracked);
  Object.values(liveScores).forEach(cache => {
    if (cache[username]) delete cache[username];
  });
  renderAllTables();
}

function clearAll() {
  if (!confirm('Voulez-vous vraiment vider votre liste de joueurs ?')) return;
  saveTracked([]);
  liveScores = {};
  renderAllTables();
}

async function addPlayer(entry, difficulty) {
  addTrackedUsername(entry.username);

  if (!liveScores[activeSeason]) liveScores[activeSeason] = {};
  const scores = await fetchPlayerScores(entry.username, activeSeason);
  liveScores[activeSeason][entry.username] = scores;

  renderAllTables();
}

/* ===== Rendering ===== */
function setStatus(msg, type = '') {
  els.status.textContent = msg;
  els.status.className = 'search-status ' + type;
}

function createResultCard(entry, difficulty) {
  const card = document.createElement('div');
  card.className = 'result-card';
  const diffLabel = DISPLAY_NAMES[difficulty];
  card.innerHTML = `
    <div class="result-info">
      <span class="result-name">${escapeHtml(entry.username)}</span>
      <span class="result-meta">${diffLabel} — Saison ${activeSeason}</span>
    </div>
    <div>
      <div class="result-score">${entry.score.toLocaleString('fr-FR')} pts</div>
      <div class="result-rank">Rang #${entry.rank.toLocaleString('fr-FR')}</div>
    </div>
    <button class="btn primary add-btn">Ajouter</button>
  `;
  const btn = card.querySelector('.add-btn');
  btn.addEventListener('click', () => {
    addPlayer(entry, difficulty);
    btn.textContent = 'Ajouté ✓';
    btn.disabled = true;
  });
  return card;
}

function renderResults(resultsMap) {
  els.results.innerHTML = '';
  let total = 0;
  for (const [difficulty, list] of Object.entries(resultsMap)) {
    if (list && list.length) {
      total += list.length;
      list.forEach(entry => {
        els.results.appendChild(createResultCard(entry, difficulty));
      });
    }
  }
  if (total === 0) {
    els.results.innerHTML = '<p style="color:var(--text-muted);margin:0.4rem 0;">Aucun résultat trouvé.</p>';
  }
}

function compareByRank(a, b) {
  const aHas = a && a.rank != null;
  const bHas = b && b.rank != null;
  if (aHas && !bHas) return -1;
  if (!aHas && bHas) return 1;
  if (aHas && bHas) {
    if (a.rank !== b.rank) return a.rank - b.rank;
    if (a.score !== b.score) return b.score - a.score;
    return 0;
  }
  return 0;
}

function sortPlayersForDifficulty(players, difficulty) {
  return [...players].sort((a, b) => {
    const byRank = compareByRank(a[difficulty], b[difficulty]);
    if (byRank !== 0) return byRank;
    return a.username.localeCompare(b.username);
  });
}

function getSortedTrackedForSeason(season) {
  const tracked = loadTracked();
  const seasonCache = liveScores[season] || {};

  const players = tracked.map(username => {
    return seasonCache[username] || { username, facile: null, difficile: null };
  });

  return {
    facile: sortPlayersForDifficulty(players, 'facile'),
    difficile: sortPlayersForDifficulty(players, 'difficile'),
  };
}

function formatDayCell(entry, isToday) {
  if (!entry) return '—';
  const score = entry.score.toLocaleString('fr-FR');
  const correct = entry.correctCount != null ? `${entry.correctCount}/10` : '';
  return `<span class="day-cell">
    <span class="${isToday ? 'today-score' : 'day-score'}">${score}</span>
    ${correct ? `<span class="day-correct">${correct}</span>` : ''}
  </span>`;
}

function renderDifficultyTable(difficulty) {
  const tracked = loadTracked();

  const t = tables[difficulty];
  if (tracked.length === 0) {
    t.empty.classList.remove('hidden');
    t.wrap.classList.add('hidden');
    return;
  }

  t.empty.classList.add('hidden');
  t.wrap.classList.remove('hidden');

  const sorted = getSortedTrackedForSeason(activeSeason)[difficulty];
  t.body.innerHTML = '';

  sorted.forEach((p, idx) => {
    const info = p[difficulty];
    const pos = info ? idx + 1 : '—';
    const score = info
      ? (idx < 3
          ? `<span class="score-badge">${info.score.toLocaleString('fr-FR')}</span>`
          : info.score.toLocaleString('fr-FR'))
      : '—';
    const rank = info ? '#' + info.rank.toLocaleString('fr-FR') : '—';

    const todayMap = todayScores && todayScores[difficulty];
    const yesterdayMap = yesterdayScores && yesterdayScores[difficulty];
    const todayEntry = todayMap && todayMap.get(p.username);
    const yesterdayEntry = yesterdayMap && yesterdayMap.get(p.username);

    const todayCell = formatDayCell(todayEntry, true);
    const yesterdayCell = formatDayCell(yesterdayEntry, false);

    const tr = document.createElement('tr');
    if (idx < 3) tr.classList.add(`rank-${idx + 1}`);

    tr.innerHTML = `
      <td class="rank-cell">${pos}</td>
      <td class="user-cell">${escapeHtml(p.username)}</td>
      <td class="score-cell">${score}</td>
      <td class="today-cell">${todayCell}</td>
      <td class="yesterday-cell">${yesterdayCell}</td>
      <td class="rank-off-cell">${rank}</td>
    `;
    t.body.appendChild(tr);
  });
}

function renderBoardStats() {
  const tracked = loadTracked();
  const seasonCache = liveScores[activeSeason] || {};

  function calcStats(difficulty) {
    let count = 0;
    let sum = 0;
    tracked.forEach(username => {
      const p = seasonCache[username];
      if (p && p[difficulty] && p[difficulty].score != null) {
        count++;
        sum += p[difficulty].score;
      }
    });
    if (count === 0) return '';
    const avg = Math.round(sum / count);
    return `${count} joueur${count > 1 ? 's' : ''} · Moy. ${avg.toLocaleString('fr-FR')}`;
  }

  if (els.abordableStats) els.abordableStats.textContent = calcStats('facile');
  if (els.expertStats) els.expertStats.textContent = calcStats('difficile');
}

function renderPlayerManager() {
  const tracked = loadTracked();
  els.playerList.innerHTML = '';

  if (tracked.length === 0) {
    els.playerList.innerHTML = '<span class="manager-empty">Aucun joueur suivi.</span>';
    els.clearBtn.style.display = 'none';
    els.shareBtn.style.display = 'none';
    return;
  }

  els.clearBtn.style.display = '';
  els.shareBtn.style.display = '';
  const sorted = [...tracked].sort((a, b) => a.localeCompare(b));
  sorted.forEach(username => {
    const chip = document.createElement('span');
    chip.className = 'player-chip';
    chip.innerHTML = `
      ${escapeHtml(username)}
      <button class="chip-remove" title="Retirer ${escapeHtml(username)}">&times;</button>
    `;
    chip.querySelector('.chip-remove').addEventListener('click', () => removeTrackedPlayer(username));
    els.playerList.appendChild(chip);
  });
}

function renderAllTables() {
  renderDifficultyTable('facile');
  renderDifficultyTable('difficile');
  renderBoardStats();
  renderPlayerManager();
}

/* ===== Search Logic ===== */
async function searchUser(username) {
  const results = { facile: [], difficile: [] };
  for (const diff of DIFFICULTIES) {
    try {
      const list = await searchLeaderboard(activeSeason, diff, username);
      if (Array.isArray(list)) results[diff] = list;
    } catch (err) {
      console.warn(`Search failed for ${username} / ${diff}:`, err);
    }
  }
  return results;
}

async function runSearch() {
  const raw = els.input.value;
  const usernames = raw
    .split(/[\n,]+/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (usernames.length === 0) {
    setStatus('Veuillez entrer au moins un pseudonyme.', 'error');
    return;
  }

  els.results.innerHTML = '';
  showSpinner('Recherche en cours…');
  els.searchBtn.disabled = true;

  try {
    const allResults = { facile: [], difficile: [] };
    for (let i = 0; i < usernames.length; i++) {
      const username = usernames[i];
      updateSpinnerProgress(`Recherche en cours… ${i + 1}/${usernames.length}`, i + 1, usernames.length);
      const res = await searchUser(username);
      for (const diff of DIFFICULTIES) {
        allResults[diff].push(...res[diff]);
      }
    }
    renderResults(allResults);
    const total = allResults.facile.length + allResults.difficile.length;
    setStatus(`${total} résultat(s) trouvé(s).`, 'success');
  } catch (err) {
    console.error(err);
    setStatus(`Erreur : ${err.message}`, 'error');
  } finally {
    hideSpinner();
    els.searchBtn.disabled = false;
  }
}

/* ===== Spinner ===== */
function showSpinner(text = 'Chargement des scores…') {
  if (els.loadingOverlay) {
    els.loadingOverlay.querySelector('p').textContent = text;
    els.loadingOverlay.classList.remove('hidden');
  }
  if (els.progressBar) {
    els.progressBar.classList.remove('visible');
    els.progressFill.style.width = '0%';
  }
}

function updateSpinnerProgress(text, current, total) {
  if (els.loadingOverlay) {
    els.loadingOverlay.querySelector('p').textContent = text;
  }
  if (els.progressBar && els.progressFill && total > 1) {
    els.progressBar.classList.add('visible');
    const pct = Math.round((current / total) * 100);
    els.progressFill.style.width = pct + '%';
  }
}

function hideSpinner() {
  if (els.loadingOverlay) {
    els.loadingOverlay.classList.add('hidden');
  }
  if (els.progressBar) {
    els.progressBar.classList.remove('visible');
    els.progressFill.style.width = '0%';
  }
}

/* ===== Share ===== */
function generateShareUrl() {
  const tracked = loadTracked();
  if (tracked.length === 0) return null;
  const url = new URL(window.location.href);
  url.search = '';
  url.searchParams.set('players', tracked.join(','));
  url.searchParams.set('season', activeSeason);
  return url.toString();
}

async function autoLoadFromUrl() {
  const params = new URLSearchParams(window.location.search);
  const playersParam = params.get('players');
  const seasonParam = parseInt(params.get('season'), 10);

  if (!playersParam) return;

  const usernames = playersParam.split(',').map(s => s.trim()).filter(Boolean);
  if (usernames.length === 0) return;

  if (seasonParam && allSeasons.some(s => s.number === seasonParam)) {
    activeSeason = seasonParam;
  }

  if (window.history && window.history.replaceState) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.search = '';
    window.history.replaceState({}, '', cleanUrl.toString());
  }

  showSpinner(`Chargement de ${usernames.length} joueur(s)…`);
  const tracked = loadTracked();
  let added = 0;

  for (let i = 0; i < usernames.length; i++) {
    const username = usernames[i];
    updateSpinnerProgress(
      `Chargement de ${usernames.length} joueur(s)… ${i + 1}/${usernames.length}`,
      i + 1,
      usernames.length
    );
    if (!tracked.includes(username)) {
      tracked.push(username);
      added++;
    }
    if (!liveScores[activeSeason]) liveScores[activeSeason] = {};
    const scores = await fetchPlayerScores(username, activeSeason);
    liveScores[activeSeason][username] = scores;
  }

  saveTracked(tracked);
  renderAllTables();
  hideSpinner();
  setStatus(`${usernames.length} joueur(s) chargé(s).`, 'success');
}

function shareLeaderboard() {
  const url = generateShareUrl();
  if (!url) {
    setStatus('Aucun joueur à partager.', 'error');
    return;
  }

  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(url).then(() => {
      setStatus('Lien copié dans le presse-papiers !', 'success');
    }).catch(() => {
      prompt('Copiez ce lien :', url);
    });
  } else {
    prompt('Copiez ce lien :', url);
  }
}

/* ===== Utilities ===== */
function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateSeasonNav() {
  if (!activeSeason || allSeasons.length === 0) {
    els.seasonDisplay.textContent = 'Saison inconnue';
    els.seasonPrev.disabled = true;
    els.seasonNext.disabled = true;
    return;
  }
  const sorted = [...allSeasons].sort((a, b) => a.number - b.number);
  const idx = sorted.findIndex(s => s.number === activeSeason);
  const seasonName = sorted[idx]?.name || '';
  els.seasonDisplay.textContent = `Saison ${activeSeason} — ${seasonName}`;
  els.seasonPrev.disabled = idx <= 0;
  els.seasonNext.disabled = idx >= sorted.length - 1;
}

function goToPrevSeason() {
  const sorted = [...allSeasons].sort((a, b) => a.number - b.number);
  const idx = sorted.findIndex(s => s.number === activeSeason);
  if (idx > 0) {
    activeSeason = sorted[idx - 1].number;
    updateSeasonNav();
    renderAllTables();
    fetchAllTrackedScores(activeSeason).then(() => renderAllTables());
  }
}

function goToNextSeason() {
  const sorted = [...allSeasons].sort((a, b) => a.number - b.number);
  const idx = sorted.findIndex(s => s.number === activeSeason);
  if (idx < sorted.length - 1) {
    activeSeason = sorted[idx + 1].number;
    updateSeasonNav();
    renderAllTables();
    fetchAllTrackedScores(activeSeason).then(() => renderAllTables());
  }
}

/* ===== Migration ===== */
function migrateOldStorage() {
  try {
    // v3 format: { tracked: [], seasons: {} }
    const v3 = localStorage.getItem('pltds_leaderboard_v3');
    if (v3) {
      const old = JSON.parse(v3);
      let tracked = [];
      if (old.tracked && Array.isArray(old.tracked) && old.tracked.length > 0) {
        tracked = old.tracked;
      } else if (old.seasons) {
        Object.values(old.seasons).forEach(seasonCache => {
          Object.keys(seasonCache).forEach(username => {
            if (!tracked.includes(username)) tracked.push(username);
          });
        });
      }
      if (tracked.length > 0) saveTracked(tracked);
      localStorage.removeItem('pltds_leaderboard_v3');
      return;
    }

    // v2 format: { "5": { players: {} }, ... }
    const v2 = localStorage.getItem('pltds_leaderboard_v2');
    if (v2) {
      const old = JSON.parse(v2);
      const tracked = [];
      Object.values(old).forEach(seasonData => {
        if (seasonData && seasonData.players) {
          Object.keys(seasonData.players).forEach(username => {
            if (!tracked.includes(username)) tracked.push(username);
          });
        }
      });
      if (tracked.length > 0) saveTracked(tracked);
      localStorage.removeItem('pltds_leaderboard_v2');
      return;
    }

    // v1 format: { players: {} }
    const v1 = localStorage.getItem('pltds_leaderboard');
    if (v1) {
      const old = JSON.parse(v1);
      if (old && old.players) {
        const tracked = Object.keys(old.players);
        if (tracked.length > 0) saveTracked(tracked);
      }
      localStorage.removeItem('pltds_leaderboard');
    }
  } catch (err) {
    console.error('Migration failed', err);
  }
}

/* ===== Init ===== */
async function init() {
  showSpinner('Chargement de la saison…');
  try {
    const seasonsData = await fetchSeasons();
    currentSeason = seasonsData.current;
    allSeasons = seasonsData.seasons;

    migrateOldStorage();

    const urlParams = new URLSearchParams(window.location.search);
    const urlSeason = parseInt(urlParams.get('season'), 10);
    if (urlSeason && allSeasons.some(s => s.number === urlSeason)) {
      activeSeason = urlSeason;
    } else {
      activeSeason = currentSeason;
    }

    updateSeasonNav();
  } catch (err) {
    console.error(err);
    els.seasonDisplay.textContent = 'Saison inconnue';
    els.seasonPrev.disabled = true;
    els.seasonNext.disabled = true;
    activeSeason = null;
    if (networkDown) {
      els.networkError.classList.remove('hidden');
    }
  }

  if (activeSeason) {
    await fetchAllTrackedScores(activeSeason);
    renderAllTables();
    await autoLoadFromUrl();
    updateSeasonNav();
  }
  hideSpinner();

  try {
    currentDay = await fetchCurrentDay();
    await loadRecentScores();
    renderAllTables();
  } catch (err) {
    console.warn('Impossible de charger les infos du jour:', err);
  }
}

/* ===== Event Listeners ===== */
els.searchBtn.addEventListener('click', runSearch);
els.clearSearchBtn.addEventListener('click', () => {
  els.input.value = '';
  els.results.innerHTML = '';
  setStatus('');
});
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) runSearch();
});

els.clearBtn.addEventListener('click', clearAll);
els.shareBtn.addEventListener('click', shareLeaderboard);

els.seasonPrev.addEventListener('click', goToPrevSeason);
els.seasonNext.addEventListener('click', goToNextSeason);
els.retryBtn.addEventListener('click', () => {
  els.networkError.classList.add('hidden');
  init();
});

/* ===== Start ===== */
init();
