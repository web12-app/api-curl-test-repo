'use strict';

// A small local stand-in for the GitHub endpoints this app calls. It runs on a real HTTP port, so the app's
// real fetch code is tested. It supports the Contents API (with SHA checks), releases, tags, and assets.
// Failures can be injected per request, and every request is recorded so tests can check what was sent.
const crypto = require('node:crypto');
const http = require('node:http');

const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

async function startFakeGitHub({ privateRepos = {} } = {}) {
  const repoInfo = new Map(Object.entries(privateRepos)); // "owner/name" -> { private, push }
  const contents = new Map(); // "repo:path" -> { buf, sha }
  const releases = new Map(); // "repo:id" -> { id, tag, name, assets: [assetId] }
  const tags = new Map(); // "repo:tag" -> releaseId
  const assets = new Map(); // "repo:assetId" -> { id, name, buf, releaseId, contentType }
  const blobs = new Map(); // signed blob path -> assetKey
  const calls = [];
  const faults = [];
  let nextId = 1000;

  // skip: let this many matching requests through before the fault applies.
  function fault(method, pattern, status, { times = 1, skip = 0, headers = {}, body = null } = {}) {
    faults.push({ method, pattern, status, times, skip, headers, body });
  }

  function takeFault(method, path) {
    const f = faults.find((x) => x.times > 0 && x.method === method && x.pattern.test(path));
    if (!f) return null;
    if (f.skip > 0) {
      f.skip -= 1;
      return null;
    }
    f.times -= 1;
    return f;
  }

  function sendJson(res, status, body, headers = {}) {
    res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
    res.end(body === null ? '' : JSON.stringify(body));
  }

  function readRaw(req) {
    return new Promise((resolve, reject) => {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => resolve(Buffer.concat(chunks)));
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fake');
    const path = url.pathname;
    const method = req.method;
    const authed = Boolean(req.headers.authorization);
    calls.push({ method, path, authed, at: Date.now() });

    // Signed blob URLs are served without credentials, like GitHub's storage host.
    if (method === 'GET' && path.startsWith('/blob/')) {
      const key = blobs.get(path);
      const asset = key && assets.get(key);
      if (!asset) return sendJson(res, 404, { message: 'Not Found' });
      res.writeHead(200, { 'Content-Type': asset.contentType, 'Content-Length': String(asset.buf.length) });
      return res.end(asset.buf);
    }

    if (!authed) return sendJson(res, 401, { message: 'Bad credentials' });

    const injected = takeFault(method, path);
    if (injected) {
      const body = injected.body !== null ? injected.body : { message: 'Injected failure' };
      return sendJson(res, injected.status, body, injected.headers);
    }

    // ---- repository
    const repoMatch = path.match(/^\/repos\/([^/]+\/[^/]+)(\/.*)?$/);
    if (path.startsWith('/uploads/repos/')) {
      const m = path.match(/^\/uploads\/repos\/([^/]+\/[^/]+)\/releases\/(\d+)\/assets$/);
      if (method !== 'POST' || !m) return sendJson(res, 404, { message: 'Not Found' });
      const [, repo, releaseId] = m;
      const release = releases.get(`${repo}:${releaseId}`);
      if (!release) return sendJson(res, 404, { message: 'Not Found' });
      const name = url.searchParams.get('name');
      const buf = await readRaw(req);
      const clash = release.assets.some((id) => assets.get(`${repo}:${id}`).name === name);
      if (clash) return sendJson(res, 422, { message: 'already_exists' });
      if (Number(req.headers['content-length']) !== buf.length) {
        return sendJson(res, 400, { message: 'Content-Length mismatch' });
      }
      const id = nextId++;
      assets.set(`${repo}:${id}`, { id, name, buf, releaseId: Number(releaseId), contentType: req.headers['content-type'] });
      release.assets.push(id);
      return sendJson(res, 201, { id, name, size: buf.length });
    }

    if (!repoMatch) return sendJson(res, 404, { message: 'Not Found' });
    const repo = repoMatch[1];
    const rest = repoMatch[2] || '';

    if (rest === '') {
      if (method !== 'GET') return sendJson(res, 405, { message: 'Method Not Allowed' });
      const info = repoInfo.get(repo);
      if (!info) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, { full_name: repo, private: info.private, permissions: { push: info.push } });
    }

    // ---- contents API
    if (rest.startsWith('/contents/')) {
      const filePath = decodeURIComponent(rest.slice('/contents/'.length));
      const key = `${repo}:${filePath}`;
      if (method === 'GET') {
        const f = contents.get(key);
        if (!f) return sendJson(res, 404, { message: 'Not Found' });
        return sendJson(res, 200, { sha: f.sha, content: f.buf.toString('base64'), encoding: 'base64' });
      }
      if (method === 'PUT') {
        const body = JSON.parse((await readRaw(req)).toString('utf8'));
        const buf = Buffer.from(body.content, 'base64');
        const existing = contents.get(key);
        if (!existing) {
          if (body.sha) return sendJson(res, 422, { message: 'sha given for new file' });
        } else if (body.sha !== existing.sha) {
          return sendJson(res, 409, { message: 'is at a different sha' });
        }
        const sha = sha1(buf);
        contents.set(key, { buf, sha });
        return sendJson(res, existing ? 200 : 201, { content: { sha }, commit: { sha: sha1(Buffer.from(String(nextId++))) } });
      }
      if (method === 'DELETE') {
        const body = JSON.parse((await readRaw(req)).toString('utf8'));
        const existing = contents.get(key);
        if (!existing) return sendJson(res, 404, { message: 'Not Found' });
        if (body.sha !== existing.sha) return sendJson(res, 409, { message: 'is at a different sha' });
        contents.delete(key);
        return sendJson(res, 200, { commit: { sha: sha1(Buffer.from(String(nextId++))) } });
      }
      return sendJson(res, 405, { message: 'Method Not Allowed' });
    }

    // ---- releases
    if (rest === '/releases' && method === 'POST') {
      const body = JSON.parse((await readRaw(req)).toString('utf8'));
      if (tags.has(`${repo}:${body.tag_name}`)) return sendJson(res, 422, { message: 'tag already exists' });
      const id = nextId++;
      releases.set(`${repo}:${id}`, { id, tag: body.tag_name, name: body.name, assets: [] });
      tags.set(`${repo}:${body.tag_name}`, id);
      return sendJson(res, 201, { id, tag_name: body.tag_name });
    }

    const tagMatch = rest.match(/^\/releases\/tags\/(.+)$/);
    if (tagMatch && method === 'GET') {
      const releaseId = tags.get(`${repo}:${decodeURIComponent(tagMatch[1])}`);
      const release = releaseId && releases.get(`${repo}:${releaseId}`);
      if (!release) return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 200, {
        id: release.id,
        tag_name: release.tag,
        assets: release.assets.map((id) => ({ id, name: assets.get(`${repo}:${id}`).name })),
      });
    }

    const releaseMatch = rest.match(/^\/releases\/(\d+)$/);
    if (releaseMatch && method === 'DELETE') {
      const key = `${repo}:${releaseMatch[1]}`;
      const release = releases.get(key);
      if (!release) return sendJson(res, 404, { message: 'Not Found' });
      release.assets.forEach((id) => assets.delete(`${repo}:${id}`));
      releases.delete(key);
      return sendJson(res, 204, null);
    }

    const assetMatch = rest.match(/^\/releases\/assets\/(\d+)$/);
    if (assetMatch) {
      const key = `${repo}:${assetMatch[1]}`;
      const asset = assets.get(key);
      if (method === 'GET') {
        if (!asset) return sendJson(res, 404, { message: 'Not Found' });
        const signed = `/blob/${crypto.randomBytes(12).toString('hex')}`;
        blobs.set(signed, key);
        // Redirect to a storage host, the way GitHub does for asset downloads.
        res.writeHead(302, { Location: `http://${req.headers.host}${signed}` });
        return res.end();
      }
      if (method === 'DELETE') {
        if (!asset) return sendJson(res, 404, { message: 'Not Found' });
        const release = releases.get(`${repo}:${asset.releaseId}`);
        if (release) release.assets = release.assets.filter((id) => id !== asset.id);
        assets.delete(key);
        return sendJson(res, 204, null);
      }
    }

    const refMatch = rest.match(/^\/git\/refs\/tags\/(.+)$/);
    if (refMatch && method === 'DELETE') {
      const key = `${repo}:${decodeURIComponent(refMatch[1])}`;
      if (!tags.has(key)) return sendJson(res, 422, { message: 'Reference does not exist' });
      tags.delete(key);
      return sendJson(res, 204, null);
    }

    return sendJson(res, 404, { message: 'Not Found' });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const base = `http://127.0.0.1:${port}`;

  return {
    base,
    uploadBase: `${base}/uploads`,
    calls,
    fault,
    // Test helpers: direct views of what is stored.
    contents,
    releases,
    tags,
    assets,
    setRepo(name, info) {
      repoInfo.set(name, info);
    },
    assetsIn(repo) {
      return [...assets.keys()].filter((k) => k.startsWith(`${repo}:`)).map((k) => assets.get(k));
    },
    resetCalls() {
      calls.length = 0;
    },
    // Clears stored data, faults, and calls. Repo settings stay.
    reset() {
      contents.clear();
      releases.clear();
      tags.clear();
      assets.clear();
      blobs.clear();
      faults.length = 0;
      calls.length = 0;
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

module.exports = { startFakeGitHub };
