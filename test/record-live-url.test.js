const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const path = require('node:path');
const { execFile } = require('node:child_process');

const SCRIPT = path.join(__dirname, '..', 'scripts', 'record_live_url.py');
const TOKEN = 'tok-secret-456';
const SHA = '824df55' + 'a'.repeat(33);
const BASE_ENV = {
  PUBLIC_URL: 'https://challenging-rod-hundred-closes.trycloudflare.com',
  GITHUB_REPOSITORY: 'web12-app/api-curl-test-repo',
  GITHUB_RUN_ID: '38993988915',
  GITHUB_SHA: SHA,
  GITHUB_EVENT_NAME: 'workflow_dispatch',
  RUN_STATUS: 'cancelled',
};

function mock({ branchExists = false, fileExists = false, releaseExists = false } = {}) {
  const calls = [];
  const state = { branch: branchExists, file: fileExists ? { sha: 'oldsha' } : null, releaseExists };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const u = req.url.split('?')[0];
      calls.push({ method: req.method, url: req.url, auth: req.headers.authorization, type: req.headers['content-type'], body: raw });
      const send = (code, obj) => { res.writeHead(code, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.method === 'GET' && u.endsWith('/git/ref/heads/live-url')) return state.branch ? send(200, { ref: 'x' }) : send(404, {});
      if (req.method === 'POST' && u.endsWith('/git/refs')) { state.branch = true; return send(201, {}); }
      if (req.method === 'GET' && u.endsWith('/contents/live-url.json')) return state.file ? send(200, state.file) : send(404, {});
      if (req.method === 'PUT' && u.endsWith('/contents/live-url.json')) { state.file = { sha: 'newsha' }; return send(201, {}); }
      if (req.method === 'POST' && u.endsWith('/releases')) {
        if (state.releaseExists) return send(422, {});
        return send(201, { id: 77 });
      }
      if (req.method === 'GET' && u.includes('/releases/tags/')) return state.releaseExists ? send(200, { id: 5 }) : send(404, {});
      if (req.method === 'POST' && u.includes('/releases/77/assets')) return send(201, { name: 'live-url.json' });
      send(500, {});
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({
    calls,
    base: `http://127.0.0.1:${server.address().port}`,
    close: () => server.close(),
  })));
}

function run(env, args = []) {
  const merged = { ...process.env, ...env };
  for (const k of ['PUBLIC_URL', 'GH_TOKEN', 'GITHUB_TOKEN']) if (!(k in env)) delete merged[k];
  return new Promise((resolve) => execFile('python3', [SCRIPT, ...args], { env: merged }, (err, stdout, stderr) => {
    resolve({ code: err ? err.code : 0, stdout, stderr });
  }));
}

test('dry-run prints the payload and calls nothing', async () => {
  const r = await run({ ...BASE_ENV, GITHUB_API_URL: 'http://127.0.0.1:1' }, ['--dry-run']);
  assert.equal(r.code, 0, r.stderr);
  const p = JSON.parse(r.stdout);
  assert.equal(p.tag, 'live-38993988915');
  assert.equal(p.run_url, 'https://github.com/web12-app/api-curl-test-repo/actions/runs/38993988915');
  assert.equal(p.run_status, 'cancelled');
});

test('rejects bad input without calling anything', async () => {
  const bad = [
    { PUBLIC_URL: 'javascript:alert(1)' },
    { PUBLIC_URL: 'https://x-y-z.trycloudflare.com/path' },
    { GITHUB_RUN_ID: 'abc' },
    { GITHUB_SHA: 'main' },
    { GITHUB_REPOSITORY: 'no-slash' },
  ];
  for (const change of bad) {
    const r = await run({ ...BASE_ENV, ...change, GH_TOKEN: TOKEN });
    assert.equal(r.code, 2, JSON.stringify(change));
  }
});

test('first run: creates the branch, writes the JSON, creates the tag/release, attaches the file', async () => {
  const m = await mock();
  try {
    const r = await run({ ...BASE_ENV, GH_TOKEN: TOKEN, GITHUB_API_URL: m.base, GITHUB_UPLOADS_URL: m.base });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /Live URL saved: live-38993988915/);
    const methods = m.calls.map((c) => `${c.method} ${c.url.split('?')[0]}`);
    assert.ok(methods.includes('POST /repos/web12-app/api-curl-test-repo/git/refs'));
    const put = m.calls.find((c) => c.method === 'PUT');
    const written = JSON.parse(Buffer.from(JSON.parse(put.body).content, 'base64').toString());
    assert.equal(written.url, BASE_ENV.PUBLIC_URL);
    assert.equal(written.run_id, 38993988915);
    const rel = JSON.parse(m.calls.find((c) => c.method === 'POST' && c.url.endsWith('/releases')).body);
    assert.equal(rel.tag_name, 'live-38993988915');
    assert.equal(rel.target_commitish, SHA);
    assert.equal(rel.prerelease, true);
    const upload = m.calls.find((c) => c.url.includes('/assets?name=live-url.json'));
    assert.equal(upload.type, 'application/json');
    assert.deepEqual(JSON.parse(upload.body), written);
    assert.ok(m.calls.every((c) => c.auth === 'Bearer ' + TOKEN));
    assert.ok(!r.stdout.includes(TOKEN) && !r.stderr.includes(TOKEN));
  } finally { m.close(); }
});

test('reruns update the file with its sha and leave an existing release alone', async () => {
  const m = await mock({ branchExists: true, fileExists: true, releaseExists: true });
  try {
    const r = await run({ ...BASE_ENV, GH_TOKEN: TOKEN, GITHUB_API_URL: m.base, GITHUB_UPLOADS_URL: m.base });
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /already saved/);
    const put = m.calls.find((c) => c.method === 'PUT');
    assert.equal(JSON.parse(put.body).sha, 'oldsha');
    assert.ok(!m.calls.some((c) => c.url.includes('/assets?name=')), 'no second asset upload');
  } finally { m.close(); }
});

test('an API failure exits 1 and says what failed', async () => {
  const srv = http.createServer((req, res) => { res.writeHead(500); res.end('{}'); });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const r = await run({ ...BASE_ENV, GH_TOKEN: TOKEN, GITHUB_API_URL: `http://127.0.0.1:${srv.address().port}`, GITHUB_UPLOADS_URL: `http://127.0.0.1:${srv.address().port}` });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Could not save the live URL/);
    assert.ok(!r.stderr.includes(TOKEN));
  } finally { srv.close(); }
});
