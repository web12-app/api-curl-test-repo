const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'publish-live-url.py');
const URL_A = 'https://aaa-bbb-ccc.trycloudflare.com';
const URL_B = 'https://ddd-eee-fff.trycloudflare.com';
const TOKEN = 'test-token-do-not-print';

function startMock({ conflictOnce = false, getStatus = null } = {}) {
  const state = { file: null, sha: null, puts: [], gets: 0, conflictLeft: conflictOnce ? 1 : 0 };
  const server = http.createServer((req, res) => {
    const auth = req.headers.authorization || '';
    if (auth !== 'Bearer ' + TOKEN) { res.writeHead(401); return res.end('{}'); }
    if (req.url.startsWith('/repos/o/r/contents/live.json') && req.method === 'GET') {
      state.gets++;
      if (getStatus) { res.writeHead(getStatus); return res.end('{}'); }
      if (!state.file) { res.writeHead(404); return res.end('{}'); }
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ sha: state.sha }));
    }
    if (req.url.startsWith('/repos/o/r/contents/live.json') && req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const body = JSON.parse(raw);
        state.puts.push(body);
        if (state.conflictLeft > 0) { state.conflictLeft--; res.writeHead(409); return res.end('{}'); }
        state.file = Buffer.from(body.content, 'base64').toString('utf8');
        state.sha = 'sha' + state.puts.length;
        res.writeHead(201, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ commit: { sha: 'c0ffee1234567890' } }));
      });
      return;
    }
    res.writeHead(404); res.end('{}');
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () =>
    resolve({ state, base: `http://127.0.0.1:${server.address().port}`, close: () => server.close() })));
}

function run(args, env = {}) {
  const base = { ...process.env, ...env };
  delete base.GITHUB_STEP_SUMMARY;
  if (!('LIVE_PUBLISH_TOKEN' in env)) delete base.LIVE_PUBLISH_TOKEN;
  return new Promise((resolve) => execFile('python3', [SCRIPT, ...args], { env: base }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, stdout, stderr });
  }));
}

test('dry-run prints the live.json body without any network call', async () => {
  const r = await run([URL_A, '--dry-run'], { GITHUB_RUN_ID: '42' });
  assert.equal(r.code, 0);
  const body = JSON.parse(r.stdout);
  assert.equal(body.url, URL_A);
  assert.equal(body.run_id, '42');
});

test('no token: warns, exits 0, and makes no request', async () => {
  const m = await startMock();
  try {
    const r = await run([URL_A], { GITHUB_API_BASE: m.base, LIVE_PUBLISH_REPO: 'o/r' });
    assert.equal(r.code, 0);
    assert.match(r.stdout, /::warning::LIVE_PUBLISH_TOKEN is not set/);
    assert.equal(m.state.gets + m.state.puts.length, 0);
  } finally { m.close(); }
});

test('rejects anything that is not a bare https origin', async () => {
  const r = await run(['javascript:alert(1)'], { LIVE_PUBLISH_TOKEN: TOKEN });
  assert.equal(r.code, 2);
  const r2 = await run(['https://x.trycloudflare.com/path'], { LIVE_PUBLISH_TOKEN: TOKEN });
  assert.equal(r2.code, 2);
});

test('creates live.json when it does not exist yet', async () => {
  const m = await startMock();
  try {
    const r = await run([URL_A], { GITHUB_API_BASE: m.base, LIVE_PUBLISH_REPO: 'o/r', LIVE_PUBLISH_TOKEN: TOKEN });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(m.state.puts.length, 1);
    assert.equal(m.state.puts[0].sha, undefined);
    assert.equal(JSON.parse(m.state.file).url, URL_A);
    assert.match(r.stdout, /Published https:\/\/aaa-bbb-ccc\.trycloudflare\.com to o\/r\/live\.json/);
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN), 'token must never be printed');
  } finally { m.close(); }
});

test('updates an existing live.json with the file sha, so each new Cloudflare URL replaces the old one', async () => {
  const m = await startMock();
  try {
    const env = { GITHUB_API_BASE: m.base, LIVE_PUBLISH_REPO: 'o/r', LIVE_PUBLISH_TOKEN: TOKEN };
    assert.equal((await run([URL_A], env)).code, 0);
    assert.equal((await run([URL_B], env)).code, 0);
    assert.equal(m.state.puts[1].sha, 'sha1');
    assert.equal(JSON.parse(m.state.file).url, URL_B);
  } finally { m.close(); }
});

test('retries once on a 409 conflict and then succeeds', async () => {
  const m = await startMock({ conflictOnce: true });
  try {
    const r = await run([URL_A], { GITHUB_API_BASE: m.base, LIVE_PUBLISH_REPO: 'o/r', LIVE_PUBLISH_TOKEN: TOKEN });
    assert.equal(r.code, 0, r.stderr);
    assert.equal(m.state.puts.length, 2);
    assert.equal(JSON.parse(m.state.file).url, URL_A);
  } finally { m.close(); }
});

test('a failed read exits 1 with a clear error and no token in output', async () => {
  const m = await startMock({ getStatus: 500 });
  try {
    const r = await run([URL_A], { GITHUB_API_BASE: m.base, LIVE_PUBLISH_REPO: 'o/r', LIVE_PUBLISH_TOKEN: TOKEN });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Could not read o\/r\/live\.json \(HTTP 500\)/);
    assert.ok(!r.stderr.includes(TOKEN));
  } finally { m.close(); }
});
