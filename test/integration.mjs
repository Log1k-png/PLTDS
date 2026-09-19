import { spawn, execFile } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createMockApi } from './mock-api.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const COMPAT_DATE = '2026-09-08';

const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const isOk = r => r.ok || r.status === 200;

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const { port } = srv.address();
      srv.close(() => resolve(port));
    });
  });
}

async function req(url) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      cache: 'no-store',
      signal: ctrl.signal,
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

const parse = text => JSON.parse(text);
const noStore = h => (h.get('cache-control') || '').includes('no-store');

async function waitFor(url, timeoutMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if (isOk(await req(url))) return true;
    } catch {
      // not ready yet
    }
    await new Promise(r => setTimeout(r, 700));
  }
  return false;
}

function taskkillTree(pid) {
  return new Promise(resolve => execFile('taskkill', ['/pid', String(pid), '/t', '/f'], () => resolve()));
}

const mock = createMockApi({ initialDay: 227 });
let proc = null;

try {
  await mock.listen();
  const mockUrl = mock.url();
  const devPort = await freePort();

  const cmdLine = `npx.cmd wrangler pages dev . --port ${devPort} --compatibility-date=${COMPAT_DATE} --binding API_BASE_URL=${mockUrl}`;
  proc = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
    cwd: ROOT,
    env: { ...process.env, API_BASE_URL: mockUrl },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let logs = '';
  proc.stdout.on('data', d => (logs += d));
  proc.stderr.on('data', d => (logs += d));
  await new Promise(resolve => setTimeout(resolve, 1500));

  const base = `http://127.0.0.1:${devPort}`;
  check('dev server ready on /', await waitFor(`${base}/`), logs ? 'output captured' : 'no output');

  // A) static allowlist.
  const rf = await req(`${base}/`);
  const rnf = await req(`${base}/README.md`);
  check('A1 / serves html', rf.status === 200 && (rf.headers.get('content-type') || '').includes('text/html'));
  check('A2 unknown path 404', rnf.status === 404);

  // B) bootstrap proxy routes remain uncached.
  const rs = await req(`${base}/api/seasons`);
  const rg = await req(`${base}/api/seasons/progress`);
  check('B1 seasons proxied, no-store', rs.status === 200 && noStore(rs.headers) && parse(rs.text).currentSeason.seasonNumber === 9);
  check('B2 progress proxied, no-store', rg.status === 200 && noStore(rg.headers) && parse(rg.text).currentDay === 227);

  // C) seasonal score/rank lookup remains available.
  const rSearch = await req(`${base}/api/leaderboards/season/9/facile/search?q=alice`);
  const searched = parse(rSearch.text);
  check('C1 seasonal search proxied, no-store', rSearch.status === 200 && noStore(rSearch.headers));
  check('C2 seasonal search returns rank', searched.length === 1 && searched[0].username === 'alice' && searched[0].rank === 1);

  // D) only the public player history route is proxied; it remains uncached.
  const rh = await req(`${base}/api/public-profile/alice/season-progress/9`);
  const history = parse(rh.text);
  const todayHistory = history.days[String(history.currentDay)].facile;
  check('D1 public player history proxied, no-store', rh.status === 200 && noStore(rh.headers));
  check('D2 history preserves every answer-mask value', todayHistory.score > 0 && JSON.stringify(todayHistory.answerMask) === '[2,4,8,1,0,2,4,8,1,0]');
  const rBlockedProfile = await req(`${base}/api/public-profile/alice/stats/9`);
  check('D3 unrelated public profile path blocked', rBlockedProfile.status === 404);

  if (logs) {
    const lines = logs.trim().split('\n').filter(l => /error|exception|failed/i.test(l));
    if (lines.length) check('no worker errors in output', false, lines.join(' | ').slice(0, 300));
  }
} catch (err) {
  check('harness error', false, (err && err.message) || String(err));
} finally {
  if (proc && proc.pid) await taskkillTree(proc.pid);
  try {
    await mock.close();
  } catch {
    // server was never listening
  }
}

const failed = results.filter(r => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
