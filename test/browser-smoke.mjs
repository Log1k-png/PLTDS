import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { createMockApi } from './mock-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DEBUG_PORT = 9228;
const chromePath = process.env.CHROME_PATH || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const kill = pid => new Promise(resolve => execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve()));
const freePort = () => new Promise((resolve, reject) => {
  const server = net.createServer();
  server.on('error', reject);
  server.listen(0, '127.0.0.1', () => {
    const { port } = server.address();
    server.close(() => resolve(port));
  });
});

const mock = createMockApi({ initialDay: 227 });
let worker;
let chrome;

try {
  await mock.listen();
  const port = await freePort();
  worker = spawn('cmd.exe', ['/d', '/s', '/c', `npx.cmd wrangler pages dev . --port ${port} --compatibility-date=2026-09-08 --binding API_BASE_URL=${mock.url()}`], {
    cwd: ROOT,
    stdio: 'ignore',
    windowsHide: true,
  });
  const base = `http://127.0.0.1:${port}`;
  let ready = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(base)).ok) {
        ready = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!ready) throw new Error('Wrangler dev server did not start');
  let apiReady = false;
  for (let i = 0; i < 40; i++) {
    try {
      if ((await fetch(`${base}/api/seasons`)).ok) {
        apiReady = true;
        break;
      }
    } catch {}
    await sleep(250);
  }
  if (!apiReady) throw new Error('Worker API binding did not start');

  chrome = spawn(chromePath, [
    '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`,
    `--user-data-dir=${join(tmpdir(), 'pltds-browser-smoke')}`,
    '--no-first-run', '--disable-gpu', 'about:blank',
  ], { stdio: 'ignore' });
  let targets;
  for (let i = 0; i < 40; i++) {
    try { targets = await fetch(`http://127.0.0.1:${DEBUG_PORT}/json`).then(r => r.json()); if (targets.length) break; } catch {}
    await sleep(250);
  }
  const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
  const pending = new Map();
  let id = 0;
  ws.onmessage = event => {
    const message = JSON.parse(event.data);
    if (message.id && pending.has(message.id)) {
      pending.get(message.id)(message);
      pending.delete(message.id);
    }
  };
  await new Promise(resolve => { ws.onopen = resolve; });
  const send = (method, params = {}) => new Promise(resolve => {
    const requestId = ++id;
    pending.set(requestId, resolve);
    ws.send(JSON.stringify({ id: requestId, method, params }));
  });
  const evaluate = async expression => {
    const response = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.result.exceptionDetails) throw new Error(response.result.exceptionDetails.text);
    return response.result.result.value;
  };

  await send('Page.navigate', { url: base });
  await sleep(1500);
  await evaluate(`localStorage.clear(); localStorage.setItem('pltds_tracked_v4', JSON.stringify({ activeLeague: 'Ma ligue', leagues: { 'Ma ligue': { tracked: ['alice', 'bob'], highlighted: null } } }))`);
  await send('Page.reload');
  await sleep(7000);
  const before = await evaluate(`(() => ({
    cells: document.querySelectorAll('.day-cell-btn').length,
    headers: [...document.querySelectorAll('.day-summary-header')].filter(el => !el.disabled).length,
    rows: document.querySelectorAll('#abordable-body tr').length,
    stored: localStorage.getItem('pltds_tracked_v4'),
    season: document.getElementById('season-display').textContent,
    loading: document.getElementById('loading-overlay').className,
    network: document.getElementById('network-error').className
  }))()`);
  await evaluate(`document.getElementById('help-btn').click()`);
  const help = await evaluate(`(() => ({
    open: document.getElementById('help-dialog').open,
    title: document.getElementById('help-title').textContent,
    sections: document.querySelectorAll('.help-section').length,
    locked: document.body.classList.contains('modal-scroll-locked')
  }))()`);
  await evaluate(`document.getElementById('help-close-btn').click()`);
  await sleep(20);
  const helpClosed = await evaluate(`(() => ({ open: document.getElementById('help-dialog').open, locked: document.body.classList.contains('modal-scroll-locked') }))()`);
  await evaluate(`document.querySelector('.day-cell-btn').click()`);
  const playerDialog = await evaluate(`(() => ({ open: document.getElementById('answer-mask-dialog').open, squares: document.querySelectorAll('.answer-mask-square.mask-2').length }))()`);
  await evaluate(`document.getElementById('answer-mask-dialog').close(); document.querySelector('.day-summary-header[data-difficulty="facile"][data-period="today"]').click()`);
  const percentage = await evaluate(`(() => ({
    values: [...document.querySelectorAll('.answer-summary-percentage')].map(el => el.textContent),
    questions: [...document.querySelectorAll('.answer-summary-question')].map(el => el.textContent),
    progress: [...document.querySelectorAll('.answer-summary-square')].map(el => el.style.getPropertyValue('--progress')),
    subtitle: document.getElementById('answer-mask-summary').textContent
  }))()`);
  await evaluate(`document.querySelector('.answer-summary-percentage').click()`);
  const fractions = await evaluate(`([...document.querySelectorAll('.answer-summary-percentage')].map(el => el.textContent))`);

  const expectedPercentages = ['100%', '50%', '0%', '0%', '0%', '50%', '0%', '0%', '0%', '0%'];
  const expectedFractions = ['2/2', '1/2', '0/2', '0/2', '0/2', '1/2', '0/2', '0/2', '0/2', '0/2'];
  const expectedQuestions = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '10'];
  const expectedProgress = ['1', '0.5', '0', '0', '0', '0.5', '0', '0', '0', '0'];
  const passed = before.cells === 4 && before.headers === 4 && help.open && help.locked && help.title === "Mode d'emploi" && help.sections === 5 && !helpClosed.open && !helpClosed.locked && playerDialog.open && playerDialog.squares === 2 &&
    JSON.stringify(percentage.values) === JSON.stringify(expectedPercentages) &&
    JSON.stringify(percentage.questions) === JSON.stringify(expectedQuestions) &&
    JSON.stringify(percentage.progress) === JSON.stringify(expectedProgress) &&
    percentage.subtitle.includes('2 joueurs') && JSON.stringify(fractions) === JSON.stringify(expectedFractions);
  console.log(`${passed ? 'PASS' : 'FAIL'} browser answer-summary smoke test`);
  if (!passed) process.exitCode = 1;
} finally {
  if (chrome?.pid) await kill(chrome.pid);
  if (worker?.pid) await kill(worker.pid);
  await mock.close();
}
