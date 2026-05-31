/* ===== Constants ===== */
const API_BASE = 'https://api.latabledessavoirs.fr';
const STORAGE_KEY = 'pltds_leaderboard_v3';
const DIFFICULTIES = ['facile', 'difficile'];
const DISPLAY_NAMES = { facile: 'Niveau Abordable', difficile: 'Niveau Expert' };

/* ===== State ===== */
let currentSeason = null;
let activeSeason = null;
let allSeasons = [];
let networkDown = false;

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

/* ===== API Helpers ===== */
async function apiGet(path, params = {}) {
  const url = new URL(API_BASE + path);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, v));
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10000);

  try {
    const resp = await fetch(url.toString(), {
      headers: { 'Accept': 'application/json' },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
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

/* ===== Storage ===== */
function loadData() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : { tracked: [], seasons: {} };
  } catch {
    return { tracked: [], seasons: {} };
  }
}

function saveData(data) {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
}

function getSeasonCache(data, season) {
  return data.seasons[season] || {};
}

function setPlayerScore(data, username, season, difficulty, entry) {
  if (!data.seasons[season]) data.seasons[season] = {};
  if (!data.seasons[season][username]) {
    data.seasons[season][username] = { username, facile: null, difficile: null };
  }
  data.seasons[season][username][difficulty] = { score: entry.score, rank: entry.rank };
}

function getPlayerScore(data, username, season) {
  const seasonCache = getSeasonCache(data, season);
  return seasonCache[username] || null;
}

function addTrackedPlayer(username) {
  const data = loadData();
  if (!data.tracked.includes(username)) {
    data.tracked.push(username);
    saveData(data);
  }
}

function removeTrackedPlayer(username) {
  const data = loadData();
  data.tracked = data.tracked.filter(u => u !== username);
  Object.keys(data.seasons).forEach(season => {
    if (data.seasons[season][username]) {
      delete data.seasons[season][username];
    }
  });
  saveData(data);
  renderAllTables();
}

function clearAll() {
  if (!confirm('Voulez-vous vraiment vider votre liste de joueurs ?')) return;
  saveData({ tracked: [], seasons: {} });
  renderAllTables();
}

function addPlayer(entry, difficulty) {
  const data = loadData();
  addTrackedPlayer(entry.username);
  setPlayerScore(data, entry.username, activeSeason, difficulty, entry);
  saveData(data);
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

function getSortedTrackedForSeason(season) {
  const data = loadData();
  const tracked = data.tracked;
  const players = tracked.map(username => {
    const info = getPlayerScore(data, username, season);
    return info || { username, facile: null, difficile: null };
  });

  return {
    facile: [...players].sort((a, b) => {
      const aHas = a.facile && a.facile.score != null;
      const bHas = b.facile && b.facile.score != null;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (aHas && bHas) return b.facile.score - a.facile.score;
      return a.username.localeCompare(b.username);
    }),
    difficile: [...players].sort((a, b) => {
      const aHas = a.difficile && a.difficile.score != null;
      const bHas = b.difficile && b.difficile.score != null;
      if (aHas && !bHas) return -1;
      if (!aHas && bHas) return 1;
      if (aHas && bHas) return b.difficile.score - a.difficile.score;
      return a.username.localeCompare(b.username);
    }),
  };
}

function renderDifficultyTable(difficulty) {
  const data = loadData();
  const tracked = data.tracked;

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

    const tr = document.createElement('tr');
    if (idx < 3) tr.classList.add(`rank-${idx + 1}`);

    tr.innerHTML = `
      <td class="rank-cell">${pos}</td>
      <td class="user-cell">${escapeHtml(p.username)}</td>
      <td class="score-cell">${score}</td>
      <td class="rank-off-cell">${rank}</td>
    `;
    t.body.appendChild(tr);
  });
}

function renderBoardStats() {
  const data = loadData();
  const seasonCache = getSeasonCache(data, activeSeason);

  function calcStats(difficulty) {
    let count = 0;
    let sum = 0;
    data.tracked.forEach(username => {
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
  const data = loadData();
  const tracked = data.tracked;
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

/* ===== Auto-refresh on season switch ===== */
async function refreshTrackedForSeason(season) {
  const data = loadData();
  const tracked = data.tracked;
  if (tracked.length === 0) return;

  const seasonCache = getSeasonCache(data, season);
  const missing = tracked.filter(u => !seasonCache[u]);
  if (missing.length === 0) return;

  showSpinner(`Mise à jour des scores pour la saison ${season}…`);
  let updated = 0;

  for (let i = 0; i < missing.length; i++) {
    const username = missing[i];
    updateSpinnerProgress(
      `Mise à jour des scores… ${i + 1}/${missing.length}`,
      i + 1,
      missing.length
    );
    for (const diff of DIFFICULTIES) {
      try {
        const list = await searchLeaderboard(season, diff, username);
        if (Array.isArray(list) && list.length > 0) {
          setPlayerScore(data, username, season, diff, list[0]);
          updated++;
        }
      } catch (err) {
        console.warn(`Refresh failed for ${username} / ${diff}:`, err);
      }
    }
  }

  if (updated > 0) saveData(data);
  hideSpinner();
}

/* ===== Share ===== */
function generateShareUrl() {
  const data = loadData();
  const tracked = data.tracked;
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
  const data = loadData();
  let added = 0;

  for (let i = 0; i < usernames.length; i++) {
    const username = usernames[i];
    updateSpinnerProgress(
      `Chargement de ${usernames.length} joueur(s)… ${i + 1}/${usernames.length}`,
      i + 1,
      usernames.length
    );
    if (!data.tracked.includes(username)) {
      data.tracked.push(username);
      added++;
    }
    for (const diff of DIFFICULTIES) {
      try {
        const list = await searchLeaderboard(activeSeason, diff, username);
        if (Array.isArray(list) && list.length > 0) {
          setPlayerScore(data, username, activeSeason, diff, list[0]);
        }
      } catch (err) {
        console.warn(`Auto-load failed for ${username} / ${diff}:`, err);
      }
    }
  }

  saveData(data);
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
    refreshTrackedForSeason(activeSeason).then(() => renderAllTables());
  }
}

function goToNextSeason() {
  const sorted = [...allSeasons].sort((a, b) => a.number - b.number);
  const idx = sorted.findIndex(s => s.number === activeSeason);
  if (idx < sorted.length - 1) {
    activeSeason = sorted[idx + 1].number;
    updateSeasonNav();
    renderAllTables();
    refreshTrackedForSeason(activeSeason).then(() => renderAllTables());
  }
}

/* ===== Migration ===== */
function migrateOldStorage() {
  try {
    const v2 = localStorage.getItem('pltds_leaderboard_v2');
    if (v2) {
      const old = JSON.parse(v2);
      const data = { tracked: [], seasons: {} };
      Object.entries(old).forEach(([season, seasonData]) => {
        if (seasonData && seasonData.players) {
          Object.entries(seasonData.players).forEach(([username, player]) => {
            if (!data.tracked.includes(username)) data.tracked.push(username);
            data.seasons[season] = data.seasons[season] || {};
            data.seasons[season][username] = {
              username,
              facile: player.facile,
              difficile: player.difficile,
            };
          });
        }
      });
      saveData(data);
      localStorage.removeItem('pltds_leaderboard_v2');
      return;
    }

    const v1 = localStorage.getItem('pltds_leaderboard');
    if (v1) {
      const old = JSON.parse(v1);
      if (old && old.players && !old.seasons) {
        const data = { tracked: Object.keys(old.players), seasons: {} };
        if (currentSeason) {
          data.seasons[currentSeason] = old.players;
        }
        saveData(data);
        localStorage.removeItem('pltds_leaderboard');
      }
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
    renderAllTables();
    await autoLoadFromUrl();
    await refreshTrackedForSeason(activeSeason);
    renderAllTables();
  }
  hideSpinner();
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
