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

async function req(url, { post = null } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const res = await fetch(url, {
      method: post ? 'POST' : 'GET',
      cache: 'no-store',
      signal: ctrl.signal,
      headers: post ? { 'content-type': 'application/json' } : {},
      body: post ? JSON.stringify(post) : undefined,
    });
    return { status: res.status, headers: res.headers, text: await res.text() };
  } finally {
    clearTimeout(timer);
  }
}

const parse = text => JSON.parse(text);
const scoreMap = body => Object.fromEntries(body.entries.map(e => [e.username, e.score]));
const names = body => Object.keys(scoreMap(body)).sort();
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
  await req(`${mockUrl}/__control`, { post: { clearLog: true } });
  const devPort = await freePort();

  const cmdLine = `npx.cmd wrangler pages dev . --port ${devPort} --compatibility-date=${COMPAT_DATE} --binding API_BASE_URL=${mockUrl} --binding PROGRESS_TTL_MS=0`;
  proc = spawn('cmd.exe', ['/d', '/s', '/c', cmdLine], {
    cwd: ROOT,
    env: { ...process.env, API_BASE_URL: mockUrl, PROGRESS_TTL_MS: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let logs = '';
  proc.stdout.on('data', d => (logs += d));
  proc.stderr.on('data', d => (logs += d));
  await new Promise(resolve => setTimeout(resolve, 1500));

  const base = `http://127.0.0.1:${devPort}`;
  check('dev server ready on /', await waitFor(`${base}/`), logs ? 'output captured' : 'no output');

  const as = (d, users) =>
    `${base}/api/leaderboards/day/${d}/facile/top?limit=0&users=${encodeURIComponent(users)}`;
  const dayTopHits = async () => {
    const log = parse((await req(`${mockUrl}/__log`)).text);
    return log.requests.filter(r => r.method === 'GET' && r.path.startsWith('/leaderboards/day/')).length;
  };

  // A) immutable-headers regression: serve path must NOT throw (was 500)
  const a = as(227, 'alice,bob');
  const ra1 = await req(a);
  const ra2 = await req(a);
  const h1 = await dayTopHits();
  check('A1 fresh fetch 200', ra1.status === 200);
  check('A1 no-store + no x-cache-day', noStore(ra1.headers) && !ra1.headers.get('x-cache-day'));
  check('A2 cache-served 200 (no immutable-headers 500)', ra2.status === 200, `status=${ra2.status}`);
  check('A2 still no-store + no x-cache-day', noStore(ra2.headers) && !ra2.headers.get('x-cache-day'));
  check('A2 names alice,bob', JSON.stringify(names(parse(ra2.text))) === '["alice","bob"]');
  check('A2 served from cache (mock untouched)', h1 === 1, `hits=${h1}`);

  // B) today: new players appear via the missing-player presence check
  const b = as(227, 'alice,bob,carol,dave');
  const rb1 = await req(b); // different key -> fresh; roster still alice,bob
  check('B1 fresh, only alice,bob in roster', JSON.stringify(names(parse(rb1.text))) === '["alice","bob"]');
  await req(`${mockUrl}/__control`, { post: { roster: { '227': ['alice', 'bob', 'carol', 'dave'] } } });
  const rb2 = await req(b); // presence check: carol,dave missing -> blocking refresh
  check('B2 refresh, carol+dave now present', JSON.stringify(names(parse(rb2.text))) === '["alice","bob","carol","dave"]');
  const hB3 = await dayTopHits();
  const rb3 = await req(b);
  check(
    'B3 now cache-served, 4 players (mock untouched)',
    hB3 === (await dayTopHits()) && JSON.stringify(names(parse(rb3.text))) === '["alice","bob","carol","dave"]',
    `hits=${hB3}`
  );

  // C) rollover: yesterday's bonus bust (the original bug)
  await req(`${mockUrl}/__control`, {
    post: { currentDay: 228, bonus: ['227'], roster: { '227': ['alice', 'bob'] } },
  });
  const rc1 = await req(a); // day 227 now yesterday; cached marker 227 != 228 -> refresh
  check('C1 marker mismatch -> refresh with bonus', scoreMap(parse(rc1.text)).alice === 250, `alice=${scoreMap(parse(rc1.text)).alice}`);
  const hC2 = await dayTopHits();
  const rc2 = await req(a);
  check(
    'C2 bonus persisted via cache (mock untouched)',
    hC2 === (await dayTopHits()) && scoreMap(parse(rc2.text)).alice === 250,
    `hits=${hC2} alice=${scoreMap(parse(rc2.text)).alice}`
  );

  // D) old days (>=2) unaffected by rollover
  const d1 = as(226, 'alice');
  await req(`${mockUrl}/__control`, { post: { currentDay: 229 } });
  const rd1 = await req(d1);
  check('D1 old day fresh, no-store', rd1.status === 200 && noStore(rd1.headers));
  await req(`${mockUrl}/__control`, { post: { currentDay: 230 } });
  const hD2 = await dayTopHits();
  const rd2 = await req(d1);
  check('D2 old day cache-served despite rollover', hD2 === (await dayTopHits()), `hits=${hD2}`);

  // E) refresh=1 always bypasses the cache
  const hE = await dayTopHits();
  await req(`${a}&refresh=1`);
  check('E1 refresh=1 forced upstream fetch', (await dayTopHits()) === hE + 1, `hits=${hE}`);

  // F) static regression
  const rf = await req(`${base}/`);
  const rnf = await req(`${base}/README.md`);
  check('F1 / serves html', rf.status === 200 && (rf.headers.get('content-type') || '').includes('text/html'));
  check('F2 unknown path 404', rnf.status === 404);

  // G) proxied /api/seasons/progress -> no-store
  const rg = await req(`${base}/api/seasons/progress`);
  check('G1 progress proxied, no-store', rg.status === 200 && noStore(rg.headers));

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