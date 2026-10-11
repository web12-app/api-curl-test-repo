'use strict';

// Stores file contents as release assets in the dedicated private storage repository.
// Git tags are created only by the release calls (one per upload). Metadata is not stored here.
// Reads retry on server errors and rate limits. Writes never retry: a failed write is reported to the caller.
const fs = require('node:fs');
const { StorageError } = require('./errors');

const API_BASE = 'https://api.github.com';
const UPLOAD_BASE = 'https://uploads.github.com';
const JSON_TIMEOUT_MS = 30000;
const UPLOAD_TIMEOUT_MS = 10 * 60 * 1000;
const READ_ATTEMPTS = 3;
const PRIVACY_CACHE_MS = 5 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// A GitHub failure. `rateLimited` is set when GitHub says the quota is used up.
class GitHubError extends StorageError {
  constructor(message, { status, rateLimited = false }) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
    this.rateLimited = rateLimited;
  }
}

function isRateLimited(res) {
  if (res.status !== 403 && res.status !== 429) return false;
  return res.headers.get('x-ratelimit-remaining') === '0' || res.headers.get('retry-after') !== null;
}

// The signed URL must be https. Plain http is allowed only when the API itself is plain http (a local test fake).
function safeSignedUrl(location, apiBase) {
  if (typeof location !== 'string') return null;
  let url;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  const apiIsHttps = new URL(apiBase).protocol === 'https:';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && !apiIsHttps)) return null;
  if (url.username || url.password) return null;
  return url.href;
}

class GitHubReleases {
  constructor({ token, repo, fetchImpl = globalThis.fetch, apiBase = API_BASE, uploadBase = UPLOAD_BASE }) {
    if (!token || !repo) throw new Error('GitHubReleases requires a token and a repository');
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl;
    this.apiBase = apiBase;
    this.uploadBase = uploadBase;
    this.privacyCheckedAt = 0;
  }

  headers(extra = {}) {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nodejs-app',
      ...extra,
    };
  }

  // One request. Network failures are reported without their details, which can echo request data.
  async send(method, url, { headers, body, timeoutMs = JSON_TIMEOUT_MS, duplex, redirect } = {}) {
    const init = { method, headers: this.headers(headers), signal: AbortSignal.timeout(timeoutMs) };
    if (body !== undefined) init.body = body;
    if (duplex) init.duplex = duplex;
    if (redirect) init.redirect = redirect;
    try {
      return await this.fetch(url, init);
    } catch {
      throw new GitHubError('GitHub could not be reached.', { status: 0 });
    }
  }

  // Reads retry transient failures. Used only for GET requests.
  async read(url, opts = {}) {
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      const res = await this.send('GET', url, opts);
      const transient = res.status >= 500 || res.status === 429 || isRateLimited(res);
      if (transient && attempt < READ_ATTEMPTS) {
        await res.body?.cancel?.().catch(() => {});
        await sleep(300 * attempt);
        continue;
      }
      return res;
    }
    throw new GitHubError('GitHub read failed.', { status: 0 });
  }

  failure(action, res) {
    const rateLimited = isRateLimited(res);
    const message = rateLimited
      ? 'GitHub API rate limit reached. Try again later.'
      : `${action} failed with HTTP ${res.status}.`;
    return new GitHubError(message, { status: res.status, rateLimited });
  }

  repoUrl(suffix = '') {
    return `${this.apiBase}/repos/${this.repo}${suffix}`;
  }

  // Storage must be private and writable by this token. Checked before any upload, and cached briefly.
  async verifyStorage() {
    if (Date.now() - this.privacyCheckedAt < PRIVACY_CACHE_MS) return;
    const res = await this.read(this.repoUrl());
    if (res.status === 404 || res.status === 401 || res.status === 403) {
      await res.body?.cancel?.().catch(() => {});
      throw new GitHubError('The storage repository cannot be accessed with this token.', { status: res.status });
    }
    if (res.status !== 200) throw this.failure('Checking the storage repository', res);
    const repo = await res.json();
    if (repo.private !== true) {
      throw new GitHubError('The storage repository must be private.', { status: 200 });
    }
    if (!repo.permissions || repo.permissions.push !== true) {
      throw new GitHubError('This token cannot write to the storage repository.', { status: 200 });
    }
    this.privacyCheckedAt = Date.now();
  }

  // Creates a release for one upload. `make_latest: false` keeps it from replacing the repo's latest release.
  async createRelease(tag, name, body) {
    const res = await this.send('POST', this.repoUrl('/releases'), {
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tag_name: tag, name, body, draft: false, prerelease: false, make_latest: 'false' }),
    });
    if (res.status !== 201) {
      await res.body?.cancel?.().catch(() => {});
      throw this.failure('Creating the release', res);
    }
    const data = await res.json();
    return { id: data.id };
  }

  // Returns { id, assetCount } for the release on a tag, or null if there is none.
  async findReleaseByTag(tag) {
    const res = await this.read(this.repoUrl(`/releases/tags/${encodeURIComponent(tag)}`));
    if (res.status === 404) return null;
    if (res.status !== 200) throw this.failure('Looking up the release', res);
    const data = await res.json();
    return { id: data.id, assetCount: Array.isArray(data.assets) ? data.assets.length : 0 };
  }

  async deleteRelease(releaseId) {
    const res = await this.send('DELETE', this.repoUrl(`/releases/${releaseId}`));
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 204 || res.status === 404) return;
    throw this.failure('Deleting the release', res);
  }

  async deleteTag(tag) {
    const res = await this.send('DELETE', this.repoUrl(`/git/refs/tags/${encodeURIComponent(tag)}`));
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 204 || res.status === 404 || res.status === 422) return;
    throw this.failure('Deleting the tag', res);
  }

  // Uploads one file as a release asset, streamed from disk with a known length. Never overwrites: a new
  // release is used for each upload, and GitHub rejects a duplicate asset name anyway.
  async uploadAsset(releaseId, name, filePath, size, contentType) {
    const url = `${this.uploadBase}/repos/${this.repo}/releases/${releaseId}/assets?name=${encodeURIComponent(name)}`;
    const res = await this.send('POST', url, {
      headers: { 'Content-Type': contentType, 'Content-Length': String(size) },
      body: fs.createReadStream(filePath),
      duplex: 'half',
      timeoutMs: UPLOAD_TIMEOUT_MS,
    });
    if (res.status !== 201) {
      await res.body?.cancel?.().catch(() => {});
      throw this.failure('Uploading the file', res);
    }
    const data = await res.json();
    if (data.size !== size) throw new GitHubError('The stored file size did not match.', { status: 201 });
    return { id: data.id, size: data.size };
  }

  // Streams one asset. GitHub answers with a redirect to a short-lived signed URL. That URL is fetched with
  // no credentials, so the token never reaches the storage host. Returns the response, or null if the asset is gone.
  async openAsset(assetId) {
    const res = await this.read(this.repoUrl(`/releases/assets/${assetId}`), {
      headers: { Accept: 'application/octet-stream' },
      timeoutMs: UPLOAD_TIMEOUT_MS,
      redirect: 'manual',
    });
    if (res.status === 404) return null;
    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get('location');
      await res.body?.cancel?.().catch(() => {});
      const target = safeSignedUrl(location, this.apiBase);
      if (!target) throw new GitHubError('Reading the file failed: unexpected redirect.', { status: 502 });
      let blob;
      try {
        blob = await this.fetch(target, { method: 'GET', redirect: 'error', signal: AbortSignal.timeout(UPLOAD_TIMEOUT_MS) });
      } catch {
        throw new GitHubError('GitHub could not be reached.', { status: 0 });
      }
      if (blob.status !== 200) {
        await blob.body?.cancel?.().catch(() => {});
        throw this.failure('Reading the file', blob);
      }
      return blob;
    }
    if (res.status !== 200) throw this.failure('Reading the file', res);
    return res;
  }

  // Returns true if deleted, false if it was already gone.
  async deleteAsset(assetId) {
    const res = await this.send('DELETE', this.repoUrl(`/releases/assets/${assetId}`));
    await res.body?.cancel?.().catch(() => {});
    if (res.status === 204) return true;
    if (res.status === 404) return false;
    throw this.failure('Deleting the file', res);
  }
}

module.exports = { GitHubReleases, GitHubError };
