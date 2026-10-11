'use strict';

// Shared setup for the chunked-upload and URL-import tests. Everything stays local:
// - GitHub is the fake in fake-github.js, reached over HTTP.
// - Origins for URL imports are plain HTTP servers on 127.0.0.1. Tests reach them through an injected transport,
//   so the real validation (scheme, names, DNS answers, redirects, limits) still runs. Only the TLS hop is replaced.
// - Name resolution is a fake table. No public host is ever contacted, and no real credential is used.
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { createServer } = require('../src/server');
const { GitHubStorage } = require('../src/github-storage');
const { GitHubReleases } = require('../src/github-releases');
const { startFakeGitHub } = require('./fake-github');
const { sessionFrom } = require('./helpers');

const TOKEN = 'ghp_test_token_not_real';
const DATA_REPO = 'owner/private-data';
const STORE_REPO = 'owner/files';
const ENV = {
  GITHUB_TOKEN: TOKEN,
  PRIVATE_DATA_REPO: DATA_REPO,
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-1234',
  COOKIE_SECURE: '0',
  GITHUB_OWNER: 'owner',
  GITHUB_STORAGE_REPO: 'files',
};

const KB = 1024;
const MB = 1024 * 1024;

async function startFake() {
  return startFakeGitHub({
    privateRepos: {
      [DATA_REPO]: { private: true, push: true },
      [STORE_REPO]: { private: true, push: true },
    },
  });
}

// One running app. Each call builds fresh clients, so state lives only in the fake GitHub and the temp dir.
async function startApp(fake, { env = ENV, limits, clock = { t: Date.now() }, tmpDir, urlImport, importLimits } = {}) {
  const dir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'chunk-test-'));
  const storage = new GitHubStorage({ token: TOKEN, repo: DATA_REPO, apiBase: fake.base });
  const releases = new GitHubReleases({ token: TOKEN, repo: STORE_REPO, apiBase: fake.base, uploadBase: fake.uploadBase });
  const server = createServer({
    env,
    storage,
    releases,
    limits,
    now: () => clock.t,
    tmpDir: dir,
    urlImport,
    importLimits,
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    clock,
    tmpDir: dir,
    services: server.fileServices,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function withApp(fake, opts, fn) {
  const app = await startApp(fake, opts);
  try {
    await fn(app);
  } finally {
    await app.close();
  }
}

const uniqueName = (prefix) => `${prefix}_${crypto.randomBytes(3).toString('hex')}`;

async function signup(app, username = uniqueName('user'), password = 'password-one') {
  const res = await fetch(`${app.base}/api/signup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Origin: app.base },
    body: JSON.stringify({ username, password }),
  });
  if (res.status !== 201) throw new Error(`signup failed with ${res.status}`);
  const body = await res.json();
  return { username, cookie: sessionFrom(res), userId: body.data.user.id };
}

// An authenticated request. Sends the CSRF header and the same-origin header a browser would send.
const authed = (app, cookie, urlPath, init = {}) =>
  fetch(`${app.base}${urlPath}`, {
    ...init,
    headers: { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base, ...(init.headers || {}) },
  });

const json = async (res) => ({ status: res.status, body: await res.json() });

// ---- chunked uploads

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

// Cuts bytes into pieces of chunkBytes, the way the client does.
function pieces(bytes, chunkBytes) {
  const out = [];
  for (let off = 0; off < bytes.length; off += chunkBytes) out.push(bytes.subarray(off, off + chunkBytes));
  return out;
}

async function initUpload(app, cookie, { name, size, uploadId = crypto.randomUUID(), chunkBytes } = {}) {
  const body = { name, size, uploadId };
  if (chunkBytes !== undefined) body.chunkBytes = chunkBytes;
  return json(
    await authed(app, cookie, '/api/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
  );
}

// Sends one piece as a raw body. `sha` defaults to the true checksum of `bytes`.
async function sendChunk(app, cookie, sessionId, index, bytes, { sha = sha256(bytes), headers = {} } = {}) {
  const hdrs = { Cookie: cookie, 'X-Requested-With': 'fetch', Origin: app.base, 'Content-Type': 'application/octet-stream', ...headers };
  if (sha !== null) hdrs['X-Chunk-Sha256'] = sha;
  return json(
    await fetch(`${app.base}/api/uploads/${sessionId}/chunks/${index}`, { method: 'POST', headers: hdrs, body: bytes }),
  );
}

const getUpload = (app, cookie, sessionId) => authed(app, cookie, `/api/uploads/${sessionId}`).then(json);
const completeUpload = (app, cookie, sessionId) =>
  authed(app, cookie, `/api/uploads/${sessionId}/complete`, { method: 'POST' }).then(json);
const cancelUpload = (app, cookie, sessionId) => authed(app, cookie, `/api/uploads/${sessionId}`, { method: 'DELETE' }).then(json);

// Sends every piece of bytes in order and completes. Returns the completion response.
async function uploadAllChunks(app, cookie, name, bytes, chunkBytes) {
  const init = await initUpload(app, cookie, { name, size: bytes.length, chunkBytes });
  const id = init.body.data.session.id;
  const parts = pieces(bytes, init.body.data.session.chunkBytes);
  for (let i = 0; i < parts.length; i += 1) {
    const sent = await sendChunk(app, cookie, id, i, parts[i]);
    if (sent.status !== 201) throw new Error(`piece ${i} failed with ${sent.status}`);
  }
  return { sessionId: id, complete: await completeUpload(app, cookie, id) };
}

// Assets in the storage repo, as the fake holds them.
const storedAssets = (fake) => fake.assetsIn(STORE_REPO);

async function listFiles(app, cookie) {
  const { body } = await json(await authed(app, cookie, '/api/files'));
  return body.data;
}

async function downloadFile(app, cookie, fileId) {
  const res = await authed(app, cookie, `/api/files/${fileId}/download`);
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
}

// ---- URL imports

// A plain HTTP origin on 127.0.0.1. `handler(req, res)` answers; `requests` records what it received.
async function startOrigin(handler) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((req, res) => {
    requests.push({ method: req.method, path: req.url, headers: { ...req.headers } });
    handler(req, res);
  });
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: server.address().port,
    requests,
    openSockets: () => sockets.size,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((resolve) => server.close(resolve));
    },
  };
}

// Name resolution from a table. Records every lookup. An unknown name fails like a missing DNS record.
function fakeDns(table) {
  const lookups = [];
  const lookup = async (hostname) => {
    lookups.push(hostname);
    if (!(hostname in table)) {
      const err = new Error('not found');
      err.code = 'ENOTFOUND';
      throw err;
    }
    return table[hostname].map((address) => ({ address, family: net.isIP(address) }));
  };
  return { lookup, lookups };
}

// Transport that connects to the origin instead of the checked address. It records each hop, including the
// addresses the check produced, so tests can see that the connection used exactly those.
function originTransport(originPort) {
  const hops = [];
  const transport = (url, { addresses, signal, connectTimeoutMs }) => {
    hops.push({ host: url.hostname, path: `${url.pathname}${url.search}`, addresses: [...addresses], connectTimeoutMs });
    return new Promise((resolve, reject) => {
      const req = http.request(
        {
          host: '127.0.0.1',
          port: originPort,
          method: 'GET',
          path: `${url.pathname}${url.search}`,
          headers: { Host: url.host, 'Accept-Encoding': 'identity' },
          agent: false,
        },
        (res) => resolve(res),
      );
      req.on('error', reject);
      if (signal) {
        if (signal.aborted) req.destroy(new Error('aborted'));
        else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
      }
      req.end();
    });
  };
  return { transport, hops };
}

// A started import, polled until it reaches a finished state (or until the timeout).
async function waitForImport(app, cookie, uploadId, { timeoutMs = 5000 } = {}) {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await json(await authed(app, cookie, `/api/files/upload-from-url/${uploadId}`));
    const state = body.data && body.data.import ? body.data.import.state : null;
    if (state === 'completed' || state === 'failed' || state === 'cancelled') return body.data.import;
    if (Date.now() > until) throw new Error(`import still ${state} after ${timeoutMs} ms`);
    await new Promise((r) => setTimeout(r, 15));
  }
}

const startImport = (app, cookie, url, uploadId = crypto.randomUUID()) =>
  authed(app, cookie, '/api/files/upload-from-url', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, uploadId }),
  }).then(async (res) => ({ uploadId, ...(await json(res)) }));

// Lists every temp file the app wrote under its temp dir, relative to the dir. Used to prove cleanup.
function tempFiles(dir) {
  const out = [];
  const walk = (d) => {
    for (const name of fs.existsSync(d) ? fs.readdirSync(d) : []) {
      const p = path.join(d, name);
      if (fs.statSync(p).isDirectory()) walk(p);
      else out.push(path.relative(dir, p));
    }
  };
  walk(dir);
  return out;
}

module.exports = {
  TOKEN,
  DATA_REPO,
  STORE_REPO,
  ENV,
  KB,
  MB,
  startFake,
  startApp,
  withApp,
  signup,
  authed,
  json,
  sha256,
  pieces,
  initUpload,
  sendChunk,
  getUpload,
  completeUpload,
  cancelUpload,
  uploadAllChunks,
  storedAssets,
  listFiles,
  downloadFile,
  startOrigin,
  fakeDns,
  originTransport,
  waitForImport,
  startImport,
  tempFiles,
};
