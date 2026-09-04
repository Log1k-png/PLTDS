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
let firstDayDate = null; // Date of day 1, from /seasons/progress
let todayScores = null; // { dayNumber, facile: Map<username, entry>, difficile: Map<username, entry> }
let yesterdayScores = null; // same structure for the previous day
let chartData = null; // { season, days: [dayNumber], players: { username: { dayNumber: entry } } }
let chartMetric = 'score'; // 'score' | 'correct'
let chartDifficulty = 'facile'; // 'facile' | 'difficile'
let chartAvgBase = 'visible'; // 'visible' | 'all'
const CHART_TITLES = {
  score: {
    cumulative: 'Cumul des points',
    daily: 'Points gagnés',
    average: 'Nombre moyen de points obtenus',
  },
  correct: {
    cumulative: 'Cumul du nombre de bonnes réponses',
    daily: 'Nombre de bonnes réponses',
    average: 'Nombre moyen de bonnes réponses',
  },
};
let chartCache = {}; // { 'season-difficulty': data } — persists until page refresh
let chartsVisible = false;
let chartHidden = new Set(); // player names (or '__avg__') toggled off via legend
let forceRefreshAllPending = false; // when true, day-top fetches bypass the worker cache (?refresh=1)
let refreshPending = false; // guards against concurrent refreshAll() runs

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
  refreshBtn: document.getElementById('refresh-btn'),
  exportCsvBtn: document.getElementById('export-csv-btn'),
  input: document.getElementById('username-input'),
  searchBtn: document.getElementById('search-btn'),
  clearSearchBtn: document.getElementById('clear-search-btn'),
  results: document.getElementById('search-results'),
  clearBtn: document.getElementById('clear-btn'),
  playerList: document.getElementById('player-list'),
  playedFacile: document.getElementById('played-facile'),
  playedDifficile: document.getElementById('played-difficile'),
  shareBtn: document.getElementById('share-btn'),
  abordableStats: document.getElementById('abordable-stats'),
  expertStats: document.getElementById('expert-stats'),
  chartsSection: document.getElementById('charts-section'),
  chartsToggleBtn: document.getElementById('charts-toggle-btn'),
  chartsLoading: document.getElementById('charts-loading'),
  chartsProgress: document.getElementById('charts-progress'),
  chartsProgressFill: document.getElementById('charts-progress-fill'),
  chartCumulative: document.getElementById('chart-cumulative'),
  chartDaily: document.getElementById('chart-daily'),
  chartAverage: document.getElementById('chart-average'),
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

/* ===== Storage (tracked usernames + highlighted player) ===== */
function loadState() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const data = JSON.parse(raw);
    if (Array.isArray(data)) return { tracked: data };
    return data && typeof data === 'object' ? data : {};
  } catch {
    return {};
  }
}

function loadTracked() {
  const state = loadState();
  return Array.isArray(state.tracked) ? state.tracked : [];
}

function saveTracked(tracked) {
  const state = loadState();
  state.tracked = tracked;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
}

function getHighlighted() {
  const h = loadState().highlighted;
  return typeof h === 'string' && h.length > 0 ? h : null;
}

function setHighlighted(username) {
  const state = loadState();
  state.highlighted = username || null;
  localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
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
    seasons: data.seasons.map(s => ({ number: s.seasonNumber, name: s.name, dayStart: s.dayStart, dayEnd: s.dayEnd })),
  };
}

async function searchLeaderboard(season, difficulty, query) {
  return apiGet(`/leaderboards/season/${season}/${difficulty}/search`, { q: query });
}

/* ===== Today / Yesterday Scores ===== */
async function fetchCurrentDay() {
  const data = await apiGet('/seasons/progress');
  firstDayDate = data.firstDayDate || firstDayDate;
  return data.currentDay;
}

async function fetchDayEntries(dayNumber, difficulty) {
  const params = { limit: -1 };
  const tracked = loadTracked();
  if (tracked.length > 0) params.users = tracked.join(',');
  if (forceRefreshAllPending) params.refresh = '1';
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

async function loadRecentScores(force = false) {
  if (!currentDay) return;
  if (!force && todayScores && todayScores.dayNumber === currentDay) return;

  const [today, yesterday] = await Promise.all([
    loadDayScores(currentDay),
    loadDayScores(currentDay - 1),
  ]);
  todayScores = today;
  yesterdayScores = yesterday;
}

/* ===== Manual refresh ===== */
async function refreshAll() {
  if (!refreshPending && els.refreshBtn) {
    forceRefreshAllPending = true;
    refreshPending = true;
    els.refreshBtn.disabled = true;
    els.refreshBtn.classList.add('refreshing');
    try {
      if (activeSeason) {
        liveScores[activeSeason] = {};
        await fetchAllTrackedScores(activeSeason);
      }
      chartCache = {};
      chartData = null;
      if (chartsVisible) {
        await fetchCurrentDay();
        await loadRecentScores(true);
        renderAllTables();
        await loadCharts();
      } else {
        currentDay = await fetchCurrentDay();
        await loadRecentScores(true);
      }
      renderAllTables();
    } catch (err) {
      console.warn('Impossible de rafraîchir:', err);
    } finally {
      forceRefreshAllPending = false;
      refreshPending = false;
      els.refreshBtn.disabled = false;
      els.refreshBtn.classList.remove('refreshing');
    }
  }
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

  const cached = liveScores[season];
  if (cached && tracked.every(u => cached[u])) {
    return; // already loaded in memory; keep until page refresh
  }

  showSpinner(`Chargement des scores pour la saison ${season}…`);
  liveScores[season] = cached || {};

  for (let i = 0; i < tracked.length; i++) {
    const username = tracked[i];
    if (liveScores[season][username]) continue;
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
  if (getHighlighted() === username) setHighlighted(null);
  Object.values(liveScores).forEach(cache => {
    if (cache[username]) delete cache[username];
  });
  renderAllTables();
  invalidateCharts();
}

function clearAll() {
  if (!confirm('Voulez-vous vraiment vider votre liste de joueurs ?')) return;
  saveTracked([]);
  setHighlighted(null);
  liveScores = {};
  renderAllTables();
  invalidateCharts();
}

async function addPlayer(entry, difficulty) {
  addTrackedUsername(entry.username);

  if (!liveScores[activeSeason]) liveScores[activeSeason] = {};
  const scores = await fetchPlayerScores(entry.username, activeSeason);
  liveScores[activeSeason][entry.username] = scores;

  try {
    await loadRecentScores(true);
  } catch (err) {
    console.warn('Refresh today scores failed:', err);
  }

  renderAllTables();
  invalidateCharts();
}

/* ===== Rendering ===== */

/* ===== Toasts ===== */
const TOAST_DEFAULT_MS = 3000;
const TOAST_ERROR_MS = 4500;

function showToast(message, type = 'success') {
  const container = document.getElementById('toast-container');
  if (!container) return;
  const toast = document.createElement('div');
  toast.className = `toast toast--${type}`;
  toast.setAttribute('role', type === 'error' ? 'alert' : 'status');

  const text = document.createElement('span');
  text.className = 'toast-message';
  text.textContent = message;

  const close = document.createElement('button');
  close.className = 'toast-close';
  close.type = 'button';
  close.setAttribute('aria-label', 'Fermer');
  close.textContent = '\u00D7';
  close.addEventListener('click', () => dismissToast(toast));

  toast.appendChild(text);
  toast.appendChild(close);
  container.appendChild(toast);

  const duration = type === 'error' ? TOAST_ERROR_MS : TOAST_DEFAULT_MS;
  toast._timer = setTimeout(() => dismissToast(toast), duration);
}

function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  clearTimeout(toast._timer);
  toast.classList.add('toast--leaving');
  toast.addEventListener('transitionend', () => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, { once: true });
  toast.addEventListener('animationend', () => {
    if (toast.parentNode) toast.parentNode.removeChild(toast);
  }, { once: true });
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

function formatDayCell(entry, isToday, isLoading) {
  let scoreLine;
  let correctLine = '<span class="day-correct">&nbsp;</span>';

  if (isLoading) {
    scoreLine = '<span class="day-loading">…</span>';
  } else if (entry) {
    scoreLine = `<span class="${isToday ? 'today-score' : 'day-score'}">${entry.score.toLocaleString('fr-FR')}</span>`;
    if (entry.correctCount != null) {
      correctLine = `<span class="day-correct">${entry.correctCount}/10</span>`;
    }
  } else {
    scoreLine = '<span class="day-score">—</span>';
  }

  return `<span class="day-cell">${scoreLine}${correctLine}</span>`;
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
  t.wrap.classList.toggle('no-days', activeSeason !== currentSeason);

  const sorted = getSortedTrackedForSeason(activeSeason)[difficulty];
  t.body.innerHTML = '';
  const highlighted = getHighlighted();

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

    const todayCell = formatDayCell(todayEntry, true, !todayScores);
    const yesterdayCell = formatDayCell(yesterdayEntry, false, !yesterdayScores);

    const tr = document.createElement('tr');
    if (p.username === highlighted) tr.classList.add('highlighted');
    if (idx < 3) tr.classList.add(`rank-${idx + 1}`);

    tr.innerHTML = `
      <td class="rank-cell">${pos}</td>
      <td class="user-cell" data-username="${escapeHtml(p.username)}" title="${escapeHtml(p.username)}">${escapeHtml(p.username)}</td>
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
  renderPlayedToday();
  renderDifficultyTable('facile');
  renderDifficultyTable('difficile');
  renderBoardStats();
  renderPlayerManager();
}

function bestEntriesFromMap(map, trackedSet) {
  let best = [];
  let bestScore = -Infinity;
  if (!map) return best;
  map.forEach((entry, username) => {
    if (!entry || entry.score == null) return;
    if (trackedSet && !trackedSet.has(username)) return;
    if (entry.score > bestScore) {
      bestScore = entry.score;
      best = [{ name: username, score: entry.score }];
    } else if (entry.score === bestScore) {
      if (!best.some(b => b.name === username)) best.push({ name: username, score: entry.score });
    }
  });
  return best.sort((a, b) => a.name.localeCompare(b.name));
}

function renderPlayedStrip(el, difficulty, scores, yesterdayScores) {
  if (!el) return;
  const tracked = loadTracked();
  const trackedSet = new Set(tracked);

  if (tracked.length === 0) {
    el.innerHTML = `<span>Ajoutez des joueurs pour suivre qui joue aujourd'hui.</span>`;
    return;
  }
  if (!scores) {
    el.innerHTML = `<span class="day-loading">…</span>`;
    return;
  }

  const map = scores[difficulty];
  const played = new Set();
  if (map) {
    map.forEach((entry, username) => {
      if (entry && trackedSet.has(username)) played.add(username);
    });
  }

  const lines = [`<span class="pt-count">${played.size}</span>/<span>${tracked.length}</span> joueur(s) ont joué aujourd'hui`];

  const todayBest = bestEntriesFromMap(map, trackedSet);
  if (todayBest.length > 0) {
    const names = todayBest.map(b => `<span class="pt-best">${escapeHtml(b.name)}</span>`).join(', ');
    lines.push(`Meilleur(s) aujoud'hui : ${names} (${todayBest[0].score} pts)`);
  }

  const yestMap = yesterdayScores ? yesterdayScores[difficulty] : null;
  const yesterdayBest = bestEntriesFromMap(yestMap, trackedSet);
  if (yesterdayBest.length > 0) {
    const names = yesterdayBest.map(b => `<span class="pt-best">${escapeHtml(b.name)}</span>`).join(', ');
    lines.push(`Meilleur(s) hier : ${names} (${yesterdayBest[0].score} pts)`);
  }

  el.innerHTML = lines.map(l => `<span class="pt-line">${l}</span>`).join('');
}

function renderPlayedToday() {
  const onCurrent = activeSeason === currentSeason;
  [[els.playedFacile, 'facile'], [els.playedDifficile, 'difficile']].forEach(([el, diff]) => {
    if (!el) return;
    if (!onCurrent) {
      el.classList.add('hidden');
      return;
    }
    el.classList.remove('hidden');
    renderPlayedStrip(el, diff, todayScores, yesterdayScores);
  });
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
    showToast('Veuillez entrer au moins un pseudonyme.', 'error');
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
    showToast(`${total} résultat(s) trouvé(s).`, 'success');
  } catch (err) {
    console.error(err);
    showToast(`Erreur : ${err.message}`, 'error');
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
  try {
    await loadRecentScores(true);
  } catch (err) {
    console.warn('Refresh today scores failed:', err);
  }
  renderAllTables();
  hideSpinner();
  showToast(`${usernames.length} joueur(s) chargé(s).`, 'success');
}

function writeClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    return navigator.clipboard.writeText(text);
  }
  return Promise.reject(new Error('no-clipboard'));
}

function supportsImageCopy() {
  return !!(navigator.clipboard && navigator.clipboard.write && window.ClipboardItem);
}

function downloadPng(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadCsv(filename, header, rows) {
  const esc = v => {
    const s = v == null ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  const lines = [header.map(esc).join(',')];
  rows.forEach(r => lines.push(r.map(esc).join(',')));
  const csv = '\uFEFF' + lines.join('\r\n');
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  downloadPng(blob, filename);
}

function exportEvolutionCsv() {
  if (!chartData || !chartData.players || !chartData.days) {
    showToast('Les graphiques n\u2019ont pas encore été chargés.', 'error');
    return;
  }
  const players = Object.keys(chartData.players);
  if (players.length === 0) {
    showToast('Aucun joueur à exporter.', 'error');
    return;
  }
  const diffLabel = chartDifficulty === 'facile' ? 'abordable' : 'expert';
  const filename = `pltds-evolution-saison-${chartData.season}-${diffLabel}.csv`;

  const dayToIso = day => {
    if (!firstDayDate) return String(day);
    const d = new Date(new Date(firstDayDate).getTime() + (day - 1) * 86400000);
    return d.toISOString().slice(0, 10);
  };

  const header = ['Jour', 'Pseudo', 'Score', 'Bonnes réponses'];
  const rows = [];
  chartData.days.forEach(day => {
    players.forEach(username => {
      const entry = chartData.players[username][day];
      rows.push([dayToIso(day), username, entry ? entry.score : '', entry ? entry.correctCount : '']);
    });
  });

  downloadCsv(filename, header, rows);
}

const CHART_IMG_BG = '#181f26';
const CHART_IMG_TEXT = '#a6c0d8';
const CHART_IMG_GOLD = '#ecca25';
const CHART_IMG_STYLE = `
  @import url('https://fonts.googleapis.com/css2?family=Lato:wght@400;700;900&display=swap');
  rect.background { fill: ${CHART_IMG_BG}; }
  line.grid { stroke: rgba(255, 255, 255, 0.08); stroke-width: 1; }
  path.data-line, path.avg-line { fill: none; stroke-width: 2.5; stroke-linejoin: round; stroke-linecap: round; }
  path.avg-line { stroke: #d1d5db; stroke-dasharray: 6 4; }
  text { fill: ${CHART_IMG_TEXT}; font-size: 11px; font-weight: 700; font-family: 'Lato', system-ui, -apple-system, sans-serif; }
  text.ylabel { text-anchor: end; }
  text.xlabel { text-anchor: middle; }
  text.xlabel-end { text-anchor: end; }
`;

function loadSvgAsImage(xml) {
  const url = URL.createObjectURL(new Blob([xml], { type: 'image/svg+xml;charset=utf-8' }));
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  }).finally(() => setTimeout(() => URL.revokeObjectURL(url), 1000));
}

function renderChartBlob(svg, title, caption) {
  const clone = svg.cloneNode(true);
  clone.removeAttribute('id');
  const vb = clone.viewBox.baseVal;
  clone.setAttribute('width', vb.width);
  clone.setAttribute('height', vb.height);
  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('class', 'background');
  bg.setAttribute('x', 0);
  bg.setAttribute('y', 0);
  bg.setAttribute('width', vb.width);
  bg.setAttribute('height', vb.height);
  clone.insertBefore(bg, clone.firstChild);
  const style = document.createElementNS(SVG_NS, 'style');
  style.textContent = CHART_IMG_STYLE;
  clone.insertBefore(style, clone.firstChild);

  const legend = svg.parentNode.querySelector('.chart-legend');
  const legendItems = legend ? [...legend.querySelectorAll('.legend-item')] : [];
  const items = legendItems.map(item => {
    const swatch = item.querySelector('.swatch');
    const avg = swatch && swatch.classList.contains('avg');
    const color = avg ? '#d1d5db' : (swatch ? swatch.style.background : '#ffffff');
    return { name: item.childNodes[item.childNodes.length - 1].textContent.trim(), color, avg, hidden: item.classList.contains('hidden-line') };
  });

  const xml = new XMLSerializer().serializeToString(clone);

  return Promise.resolve(document.fonts && document.fonts.load ? document.fonts.load('700 11px Lato').catch(() => {}) : null)
    .then(() => loadSvgAsImage(xml))
    .then(img => {
      const scale = 3;
      const pad = 24;
      const titleSize = 17;
      const captionSize = 12;
      const itemSize = 13;
      const rowGap = 6;
      const legendGap = 14;
      const titleH = titleSize + 8;
      const captionH = caption ? captionSize + 6 : 0;
      const canvasW = img.width;

      let legendRows = 0;
      if (items.length) {
        const c = document.createElement('canvas').getContext('2d');
        c.font = `700 ${itemSize}px Lato, system-ui, sans-serif`;
        let cur = 0;
        legendRows = 1;
        items.forEach(it => {
          const w = c.measureText(it.name).width + 26;
          if (cur + w > canvasW - pad * 2) { legendRows++; cur = w; }
          else cur += w;
        });
      }
      const legendH = legendRows ? legendRows * (itemSize + rowGap) + 6 : 0;

      const canvas = document.createElement('canvas');
      canvas.width = (canvasW + pad * 2) * scale;
      canvas.height = (pad + titleH + captionH + img.height + legendGap + legendH + pad) * scale;
      const ctx = canvas.getContext('2d');
      ctx.scale(scale, scale);

      ctx.fillStyle = CHART_IMG_BG;
      ctx.fillRect(0, 0, canvas.width / scale, canvas.height / scale);

      ctx.fillStyle = CHART_IMG_GOLD;
      ctx.font = `900 ${titleSize}px Lato, system-ui, sans-serif`;
      ctx.fillText(title, pad, pad + titleSize);

      if (caption) {
        ctx.fillStyle = CHART_IMG_TEXT;
        ctx.font = `700 ${captionSize}px Lato, system-ui, sans-serif`;
        ctx.fillText(caption, pad, pad + titleH + captionSize);
      }

      ctx.drawImage(img, pad, pad + titleH + captionH);

      if (items.length) {
        let ly = pad + titleH + captionH + img.height + legendGap;
        ctx.font = `700 ${itemSize}px Lato, system-ui, sans-serif`;
        let cur = pad;
        items.forEach(it => {
          const textW = ctx.measureText(it.name).width;
          const w = textW + 26;
          if (cur + w > canvasW - pad) {
            cur = pad;
            ly += itemSize + rowGap;
          }
          ctx.globalAlpha = it.hidden ? 0.35 : 1;
          if (it.avg) {
            ctx.strokeStyle = it.color;
            ctx.setLineDash([5, 3]);
            ctx.lineWidth = 2;
            ctx.beginPath();
            ctx.moveTo(cur, ly - 4);
            ctx.lineTo(cur + 14, ly - 4);
            ctx.stroke();
            ctx.setLineDash([]);
          } else {
            ctx.fillStyle = it.color;
            ctx.fillRect(cur, ly - itemSize + 3, 14, 3);
          }
          ctx.fillStyle = CHART_IMG_TEXT;
          ctx.fillText(it.name, cur + 20, ly);
          ctx.globalAlpha = 1;
          cur += w;
        });
      }

      return canvas;
    })
    .then(canvas => new Promise((resolve, reject) => {
      canvas.toBlob(blob => blob ? resolve(blob) : reject(new Error('toBlob-failed')), 'image/png');
    }));
}

function copyChartAsImage(svg, title) {
  const season = allSeasons.find(s => s.number === activeSeason);
  const caption = season ? `Saison ${activeSeason} — ${season.name}` : `Saison ${activeSeason}`;

  console.log('[chart-copy]', {
    isSecureContext: window.isSecureContext,
    hasClipboard: !!navigator.clipboard,
    hasWrite: !!(navigator.clipboard && navigator.clipboard.write),
    hasClipboardItem: !!window.ClipboardItem,
    supportsImageCopy: supportsImageCopy(),
  });

  const blobPromise = renderChartBlob(svg, title, caption);

  if (supportsImageCopy()) {
    navigator.clipboard.write([new ClipboardItem({ 'image/png': blobPromise })])
      .then(() => showToast('Image copiée !'))
      .catch(async err => {
        console.warn('Copie d\'image échouée:', err);
        const blob = await blobPromise.catch(() => null);
        if (blob) {
          downloadPng(blob, `pltds-${title.toLowerCase()}.png`);
          showToast('Image téléchargée', 'info');
          showToast(`Impossible de copier l'image sur ce navigateur (${(err && err.name) || 'erreur'}). L'image a été téléchargée à la place.`, 'error');
        } else {
          showToast('Erreur !', 'error');
        }
      });
  } else {
    blobPromise
      .then(blob => {
        downloadPng(blob, `pltds-${title.toLowerCase()}.png`);
        showToast('Image téléchargée', 'info');
      })
      .catch(() => showToast('Erreur !', 'error'));
  }
}

function shareLeaderboard() {
  const url = generateShareUrl();
  if (!url) {
    showToast('Aucun joueur à partager.', 'error');
    return;
  }
  writeClipboard(url)
    .then(() => showToast('Lien copié !'))
    .catch(() => {
      showToast('Presse-papiers indisponible. Copiez le lien dans la boîte de dialogue.', 'error');
      prompt('Copiez ce lien :', url);
    });
}

function copyScoreboard(difficulty) {
  const label = difficulty === 'facile' ? 'Niveau Abordable' : 'Niveau Expert';
  const t = tables[difficulty];
  if (t.wrap.classList.contains('hidden')) {
    showToast('Aucun joueur à copier.', 'error');
    return;
  }

  const visible = el => el.offsetParent !== null;
  const isDay = el => el.classList.contains('col-today') || el.classList.contains('today-cell') || el.classList.contains('yesterday-cell');
  const thead = t.wrap.querySelector('thead');
  const headers = [...thead.querySelectorAll('th')].filter(el => visible(el) && !isDay(el)).map(th => th.textContent.trim());
  const rows = [...t.body.querySelectorAll('tr')].map(tr =>
    [...tr.querySelectorAll('td')].filter(el => visible(el) && !isDay(el)).map(td => td.textContent.trim())
  );

  const matrix = [headers, ...rows];
  const widths = headers.map((_, ci) => Math.max(...matrix.map(r => (r[ci] || '').length)));
  const line = r => r.map((c, ci) => (c || '').padEnd(widths[ci] + 2)).join('').trimEnd();

  const season = (allSeasons.find(s => s.number === activeSeason) || {});
  const text = [
    `La Table des Savoirs — ${label} — Saison ${activeSeason}${season.name ? ` (${season.name})` : ''}`,
    '',
    ...matrix.map(line),
  ].join('\n');

  writeClipboard(text)
    .then(() => showToast('Copié !'))
    .catch(() => {
      showToast('Presse-papiers indisponible. Copiez le texte dans la boîte de dialogue.', 'error');
      prompt('Copiez ce texte :', text);
    });
}

/* ===== Charts (Abordable) ===== */
const CHART_COLORS = ['#2addf3', '#ecca25', '#b48bff', '#34d399', '#f472b6', '#fb923c', '#60a5fa', '#f87171'];

function chartValue(entry, metric) {
  if (!entry) return null;
  return metric === 'score' ? entry.score : entry.correctCount;
}

function fetchSeasonDaySeries(season, difficulty, onProgress) {
  const info = allSeasons.find(s => s.number === season);
  const tracked = loadTracked();
  if (!info || tracked.length === 0) return Promise.resolve(null);
  if (season === currentSeason && !currentDay) return Promise.resolve(null);

  const lastDay = season === currentSeason ? currentDay : info.dayEnd;
  if (!lastDay || lastDay < info.dayStart) return Promise.resolve(null);

  const days = [];
  for (let d = info.dayStart; d <= lastDay; d++) days.push(d);

  let done = 0;
  const total = days.length;

  // Today and yesterday tops are already loaded on page load (todayScores /
  // yesterdayScores). Reuse them on the current season instead of refetching.
  const maps = {
    [currentDay]: todayScores,
    [currentDay - 1]: yesterdayScores,
  };

  return Promise.all(days.map(day => {
    const reusable = (season === currentSeason && maps[day]) ? maps[day][difficulty] : null;
    const promise = reusable
      ? Promise.resolve([...reusable.values()])
      : fetchDayEntries(day, difficulty).catch(() => []);
    return promise.finally(() => {
      done++;
      if (onProgress) onProgress(done, total);
    });
  })).then(results => {
    const players = {};
    tracked.forEach(u => players[u] = {});
    results.forEach((entries, i) => {
      const day = days[i];
      entries.forEach(e => {
        if (players[e.username] !== undefined) players[e.username][day] = e;
      });
    });
    return { season, days, players };
  });
}

function buildChartSeries(days, players, metric) {
  return Object.entries(players).map(([username, data]) => {
    let cum = 0;
    let settled = 0;
    const cumArr = [];
    const dailyArr = [];
    const avgArr = [];
    days.forEach(day => {
      const v = chartValue(data[day], metric);
      if (v !== null) {
        cum += v;
        settled++;
      } else if (day !== currentDay) {
        // Day is over and the player did not play: score is 0, it can no longer change.
        settled++;
      }
      const openToday = v === null && day === currentDay;
      cumArr.push(openToday ? null : cum);
      dailyArr.push(v);
      avgArr.push(openToday ? null : (settled > 0 ? cum / settled : null));
    });
    return { name: username, cum: cumArr, daily: dailyArr, avg: avgArr };
  });
}

function clearChartSvgs() {
  [els.chartCumulative, els.chartDaily, els.chartAverage].forEach(svg => {
    svg.parentNode.querySelectorAll('.chart-legend').forEach(el => el.remove());
    svg.innerHTML = '';
  });
}

function renderCharts() {
  if (!chartData) {
    clearChartSvgs();
    return;
  }
  const series = buildChartSeries(chartData.days, chartData.players, chartMetric);
  drawLineChart(els.chartCumulative, chartData.days, series, s => s.cum);
  drawLineChart(els.chartDaily, chartData.days, series, s => s.daily);
  drawLineChart(els.chartAverage, chartData.days, series, s => s.avg);
}

async function loadCharts() {
  const tracked = loadTracked();
  if (!activeSeason || tracked.length === 0) {
    chartCache = {};
    chartData = null;
    clearChartSvgs();
    els.chartsLoading.textContent = 'Ajoutez des joueurs pour voir les graphiques.';
    els.chartsLoading.classList.remove('hidden');
    return;
  }

  const key = `${activeSeason}-${chartDifficulty}`;
  if (chartCache[key]) {
    chartData = chartCache[key];
    renderCharts();
    return;
  }

  clearChartSvgs();
  els.chartsLoading.textContent = 'Chargement de l\'évolution…';
  els.chartsLoading.classList.remove('hidden');
  els.chartsProgressFill.style.width = '0%';
  els.chartsProgress.classList.add('visible');
  try {
    const data = await fetchSeasonDaySeries(activeSeason, chartDifficulty, (done, total) => {
      const pct = Math.round((done / total) * 100);
      els.chartsProgressFill.style.width = pct + '%';
      els.chartsLoading.textContent = `Chargement de l'évolution… ${done}/${total}`;
    });
    chartCache[key] = data;
    chartData = data;
    renderCharts();
  } catch (err) {
    console.warn('Impossible de charger l\'évolution:', err);
  } finally {
    els.chartsLoading.classList.add('hidden');
    els.chartsProgress.classList.remove('visible');
  }
}

function invalidateCharts() {
  const key = `${activeSeason}-${chartDifficulty}`;
  delete chartCache[key];
  if (chartsVisible) loadCharts();
}

function hideCharts() {
  chartsVisible = false;
  clearChartSvgs();
  els.chartsSection.classList.add('hidden');
  els.chartsToggleBtn.textContent = 'Afficher les graphiques d\'évolution';
}

function toggleCharts() {
  if (chartsVisible) {
    chartsVisible = false;
    els.chartsSection.classList.add('hidden');
    els.chartsToggleBtn.textContent = 'Afficher les graphiques d\'évolution';
    return;
  }
  chartsVisible = true;
  els.chartsSection.classList.remove('hidden');
  els.chartsToggleBtn.textContent = 'Masquer les graphiques d\'évolution';
  loadCharts();
}

function updateChartTitles() {
  const t = CHART_TITLES[chartMetric] || CHART_TITLES.score;
  document.querySelectorAll('.chart-title').forEach(span => {
    const key = span.dataset.for;
    if (t[key]) span.textContent = t[key];
  });
  document.querySelectorAll('.copy-chart-btn').forEach(btn => {
    const key = btn.dataset.chart;
    if (t[key]) btn.dataset.title = t[key];
  });
}

const MAX_Y_LABELS = 15;

function niceStep(raw) {
  if (!(raw > 0)) return 1;
  const pow = Math.pow(10, Math.floor(Math.log10(raw)));
  const n = raw / pow;
  const NICE = [1, 2, 2.5, 5, 10];
  const nice = NICE.find(x => x >= n) || 10;
  return nice * pow;
}

function nextNiceStep(step) {
  const NICE = [1, 2, 2.5, 5, 10];
  const pow = Math.pow(10, Math.floor(Math.log10(step)));
  const n = step / pow;
  const idx = NICE.findIndex(x => x >= n);
  return idx >= NICE.length - 1 ? NICE[0] * pow * 10 : NICE[idx + 1] * pow;
}

function dayToDate(day) {
  if (!firstDayDate) return String(day);
  const d = new Date(new Date(firstDayDate).getTime() + (day - 1) * 86400000);
  return String(d.getDate()).padStart(2, '0') + '/' + String(d.getMonth() + 1).padStart(2, '0');
}

function pickIndices(count, n) {
  if (count <= n) return Array.from({ length: count }, (_, i) => i);
  const out = [];
  for (let k = 0; k < n; k++) out.push(Math.round((k / (n - 1)) * (count - 1)));
  return [...new Set(out)];
}

const SVG_NS = 'http://www.w3.org/2000/svg';

function svgEl(tag, attrs) {
  const el = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  return el;
}

const AVG_COLOR = '#d1d5db';

function drawLineChart(svg, days, allSeries, getValues) {
  const W = Math.max(300, svg.parentNode.clientWidth || 800);
  const H = 300;
  const ML = 46;
  const MR = 12;
  const MT = 12;
  const MB = 26;
  const PW = W - ML - MR;
  const PH = H - MT - MB;

  svg.parentNode.querySelectorAll('.chart-legend').forEach(el => el.remove());
  svg.innerHTML = '';
  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  if (days.length === 0) return;

  const allPlottable = allSeries
    .map(s => ({ name: s.name, values: getValues(s) }))
    .filter(s => s.values.some(v => v !== null))
    .map((s, idx) => ({ ...s, color: CHART_COLORS[idx % CHART_COLORS.length] }));

  const series = allPlottable.filter(s => !chartHidden.has(s.name));

  const showAvg = !chartHidden.has('__avg__');
  const avgSource = chartAvgBase === 'all' ? allPlottable : series;
  const avgValues = days.map((_, i) => {
    const vals = avgSource.map(s => s.values[i]).filter(v => v !== null);
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  });
  const avgVisible = showAvg && avgValues.some(v => v !== null);

  const plotted = [
    ...series.flatMap(s => s.values.filter(v => v !== null)),
    ...(avgVisible ? avgValues.filter(v => v !== null) : []),
  ];

  let yMin = 0;
  let yMax = 1;
  let step = 1;
  if (plotted.length > 0) {
    const dataMin = Math.min(...plotted);
    const dataMax = Math.max(...plotted);
    const span = dataMax - dataMin;
    const raw = span > 0 ? span / 9 : Math.max(Math.abs(dataMax) / 9, 1);
    step = niceStep(raw);
    const bounds = s => [
      Math.min(0, Math.floor(dataMin / s) * s),
      Math.max(0, Math.ceil(dataMax / s) * s),
    ];
    [yMin, yMax] = bounds(step);
    while ((yMax - yMin) / step + 1 > MAX_Y_LABELS) {
      step = nextNiceStep(step);
      [yMin, yMax] = bounds(step);
    }
    if (yMax - yMin < step) yMax = yMin + step;
  }

  const xAt = i => ML + (days.length === 1 ? PW / 2 : (i / (days.length - 1)) * PW);
  const yAt = v => MT + PH - ((v - yMin) / (yMax - yMin)) * PH;

  for (let v = yMin; v <= yMax; v += step) {
    const y = yAt(v);
    svg.appendChild(svgEl('line', { x1: ML, y1: y, x2: W - MR, y2: y, class: 'grid' }));
    const lbl = svgEl('text', { x: ML - 6, y: y + 4, class: 'ylabel' });
    lbl.textContent = String(Math.round(v));
    svg.appendChild(lbl);
  }

  pickIndices(days.length, 6).forEach(i => {
    const x = xAt(i);
    if (x < ML + 18) return;
    const lbl = svgEl('text', { x, y: H - MB + 4, class: 'xlabel' + (i === days.length - 1 ? ' xlabel-end' : '') });
    lbl.textContent = dayToDate(days[i]);
    svg.appendChild(lbl);
  });

  const lineEls = [];
  const isIsolated = (values, i) => {
    if (values[i] === null) return false;
    return values[i - 1] === null && values[i + 1] === null;
  };
  series.forEach(s => {
    let d = '';
    const points = [];
    s.values.forEach((v, i) => {
      if (v === null) return;
      points.push([xAt(i), yAt(v)]);
      d += (d ? ' L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1);
    });
    if (d) {
      const path = svgEl('path', { d, class: 'data-line', stroke: s.color });
      svg.appendChild(path);
      lineEls.push(path);
    }
    // Isolated points (no line segment through them) get a visible dot.
    s.values.forEach((v, i) => {
      if (!isIsolated(s.values, i)) return;
      const [cx, cy] = [xAt(i), yAt(v)];
      svg.appendChild(svgEl('circle', { cx, cy, r: 3.5, class: 'data-dot', fill: s.color }));
    });
  });

  if (avgVisible) {
    let d = '';
    avgValues.forEach((v, i) => {
      if (v === null) return;
      d += (d ? ' L' : 'M') + xAt(i).toFixed(1) + ' ' + yAt(v).toFixed(1);
    });
    if (d) {
      const path = svgEl('path', { d, class: 'avg-line', stroke: AVG_COLOR, 'stroke-dasharray': '6 4' });
      svg.appendChild(path);
      lineEls.push(path);
    }
  }

  // Legend: click a name to toggle that line
  const legend = document.createElement('div');
  legend.className = 'chart-legend';
  const legendByKey = {};
  const addLegendItem = (name, key, color, avg) => {
    const span = document.createElement('span');
    span.className = 'legend-item' + (chartHidden.has(key) ? ' hidden-line' : '');
    span.dataset.name = key;
    span.innerHTML = `<span class="swatch${avg ? ' avg' : ''}"${avg ? '' : ` style="background:${color}"`}></span>${escapeHtml(name)}`;
    legend.appendChild(span);
    legendByKey[key] = span;
  };
  allPlottable.forEach(s => addLegendItem(s.name, s.name, s.color, false));
  addLegendItem('Moyenne', '__avg__', AVG_COLOR, true);
  legend.addEventListener('click', e => {
    const item = e.target.closest('.legend-item');
    if (!item) return;
    const name = item.dataset.name;
    if (chartHidden.has(name)) chartHidden.delete(name);
    else chartHidden.add(name);
    renderCharts();
  });
  svg.insertAdjacentElement('afterend', legend);

  // ---- Hover: fade other lines, show values ----
  const svgSeries = series.map(s => ({
    name: s.name,
    color: s.color,
    points: s.values.map((v, i) => (v === null ? null : { x: xAt(i), y: yAt(v), v })),
  }));
  if (avgVisible) {
    svgSeries.push({
      name: '__avg__',
      color: AVG_COLOR,
      points: avgValues.map((v, i) => (v === null ? null : { x: xAt(i), y: yAt(v), v })),
    });
  }
  const overlay = svgEl('g', { class: 'hover-overlay' });
  svg.appendChild(overlay);

  const fmtVal = v => String(Math.round(v * 10) / 10);

  const highlightSeries = (idx, showDots) => {
    lineEls.forEach((p, i) => { p.style.strokeOpacity = i === idx ? '1' : '0.15'; });
    overlay.innerHTML = '';
    Object.values(legendByKey).forEach(li => li.classList.remove('highlighted'));
    if (idx < 0) {
      lineEls.forEach(p => { p.style.strokeOpacity = '1'; });
      return;
    }
    const s = svgSeries[idx];
    if (s && legendByKey[s.name]) legendByKey[s.name].classList.add('highlighted');
    if (!showDots || !s) return;
    s.points.forEach(pt => {
      if (!pt) return;
      overlay.appendChild(svgEl('circle', { cx: pt.x, cy: pt.y, r: 4, class: 'hover-dot', fill: s.color }));
      let lx = pt.x;
      let anchor = 'middle';
      if (pt.x > W - 30) { anchor = 'end'; lx = pt.x - 6; }
      else if (pt.x < ML + 30) { anchor = 'start'; lx = pt.x + 6; }
      const ly = pt.y - 9 < MT + 2 ? pt.y + 16 : pt.y - 9;
      const lbl = svgEl('text', { x: lx, y: ly, class: 'hover-value', fill: s.color, 'text-anchor': anchor });
      lbl.textContent = fmtVal(pt.v);
      overlay.appendChild(lbl);
    });
  };

  const clearOverlay = () => highlightSeries(-1, false);

  const segDist = (px, py, ax, ay, bx, by) => {
    const dx = bx - ax;
    const dy = by - ay;
    const len2 = dx * dx + dy * dy;
    let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
  };

  const showHover = (mx, my) => {
    let hoveredIdx = null;
    let bestD = Infinity;
    svgSeries.forEach((s, idx) => {
      const pts = s.points.filter(p => p !== null);
      if (pts.length === 0) return;
      for (let i = 0; i < pts.length - 1; i++) {
        const d = segDist(mx, my, pts[i].x, pts[i].y, pts[i + 1].x, pts[i + 1].y);
        if (d < bestD) {
          bestD = d;
          hoveredIdx = idx;
        }
      }
      if (pts.length === 1) {
        const d = Math.hypot(mx - pts[0].x, my - pts[0].y);
        if (d < bestD) {
          bestD = d;
          hoveredIdx = idx;
        }
      }
    });
    if (hoveredIdx === null || bestD > 40) {
      clearOverlay();
      return;
    }
    highlightSeries(hoveredIdx, true);
  };

  // Hovering a legend name highlights its line (and vice versa)
  legend.addEventListener('mouseover', e => {
    const item = e.target.closest('.legend-item');
    if (!item) return;
    const idx = svgSeries.findIndex(s => s.name === item.dataset.name);
    highlightSeries(idx, false);
  });
  legend.addEventListener('mouseleave', () => highlightSeries(-1, false));

  svg._hoverState = { W, H, ML, MT, MB, PW, svgSeries, lineEls, overlay, clearOverlay, showHover };
  if (!svg._hoverBound) {
    svg._hoverBound = true;
    svg.addEventListener('mousemove', e => {
      const st = svg._hoverState;
      const rect = svg.getBoundingClientRect();
      const mx = ((e.clientX - rect.left) / rect.width) * st.W;
      const my = ((e.clientY - rect.top) / rect.height) * st.H;
      st.showHover(mx, my);
    });
    svg.addEventListener('mouseleave', () => {
      svg._hoverState.clearOverlay();
    });
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
    hideCharts();
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
    hideCharts();
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
    updateChartTitles();
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
});
els.input.addEventListener('keydown', e => {
  if (e.key === 'Enter' && e.ctrlKey) runSearch();
});

els.clearBtn.addEventListener('click', clearAll);
els.shareBtn.addEventListener('click', shareLeaderboard);
document.querySelectorAll('.copy-board-btn').forEach(btn => {
  btn.addEventListener('click', () => copyScoreboard(btn.dataset.difficulty));
});

els.chartsToggleBtn.addEventListener('click', toggleCharts);

document.querySelectorAll('.copy-chart-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const svg = document.getElementById('chart-' + btn.dataset.chart);
    if (!svg) return;
    copyChartAsImage(svg, btn.dataset.title);
  });
});

document.querySelectorAll('#chart-diff-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chart-diff-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartDifficulty = btn.dataset.difficulty;
    loadCharts();
  });
});

document.querySelectorAll('#chart-metric-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chart-metric-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartMetric = btn.dataset.metric;
    updateChartTitles();
    renderCharts();
  });
});

document.querySelectorAll('#chart-avg-toggle button').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('#chart-avg-toggle button').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    chartAvgBase = btn.dataset.avg;
    renderCharts();
  });
});

els.seasonPrev.addEventListener('click', goToPrevSeason);
els.seasonNext.addEventListener('click', goToNextSeason);
if (els.refreshBtn) els.refreshBtn.addEventListener('click', refreshAll);
if (els.exportCsvBtn) els.exportCsvBtn.addEventListener('click', exportEvolutionCsv);

/* Charts header kebab menu */
const chartMenuBtn = document.getElementById('chart-menu-btn');
const chartMenuDropdown = document.getElementById('chart-menu-dropdown');
function toggleChartMenu(open) {
  if (!chartMenuBtn || !chartMenuDropdown) return;
  const shouldOpen = open === undefined ? chartMenuDropdown.hidden : open;
  chartMenuDropdown.hidden = !shouldOpen;
  chartMenuBtn.setAttribute('aria-expanded', String(!!shouldOpen));
}
if (chartMenuBtn && chartMenuDropdown) {
  chartMenuBtn.addEventListener('click', e => {
    e.stopPropagation();
    toggleChartMenu();
  });
  document.addEventListener('click', () => toggleChartMenu(false));
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') toggleChartMenu(false);
  });
  chartMenuDropdown.querySelectorAll('.chart-menu-item').forEach(item => {
    item.addEventListener('click', e => e.stopPropagation());
  });
} else if (chartMenuBtn) {
  chartMenuBtn.disabled = true;
}

let chartResizeTimer = null;
window.addEventListener('resize', () => {
  if (!chartsVisible || !chartData) return;
  clearTimeout(chartResizeTimer);
  chartResizeTimer = setTimeout(renderCharts, 150);
});
els.retryBtn.addEventListener('click', () => {
  els.networkError.classList.add('hidden');
  init();
});

/* Tap a pseudo to expand/collapse it; long-press (~500ms) to highlight your player */
const PRESS_MS = 500;

Object.values(tables).forEach(t => {
  let press = null;
  let suppressClick = false;

  const cancelPress = () => {
    if (!press) return;
    clearTimeout(press.timer);
    press.cell.classList.remove('pressing');
    press = null;
  };

  t.body.addEventListener('pointerdown', e => {
    const cell = e.target.closest('.user-cell');
    if (!cell || !cell.dataset.username) return;
    if (e.pointerType === 'mouse' && e.button !== 0) return;
    cancelPress();
    press = {
      cell,
      x: e.clientX,
      y: e.clientY,
      timer: setTimeout(() => {
        const username = press.cell.dataset.username;
        setHighlighted(getHighlighted() === username ? null : username);
        suppressClick = true;
        press = null;
        renderAllTables();
      }, PRESS_MS),
    };
    cell.classList.add('pressing');
  });

  t.body.addEventListener('pointermove', e => {
    if (!press) return;
    if (Math.abs(e.clientX - press.x) > 10 || Math.abs(e.clientY - press.y) > 10) {
      cancelPress();
    }
  });

  t.body.addEventListener('pointerup', cancelPress);
  t.body.addEventListener('pointercancel', cancelPress);

  t.body.addEventListener('click', e => {
    if (suppressClick) {
      suppressClick = false;
      return;
    }
    const cell = e.target.closest('.user-cell');
    if (cell) cell.classList.toggle('expanded');
  });
});

/* ===== Start ===== */
init();
