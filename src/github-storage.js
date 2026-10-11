'use strict';

// Stores JSON documents in the private data repository through the GitHub Contents API.
// Reads retry on server errors. Writes never retry: a conflict is reported to the caller.
const { ConflictError, StorageError } = require('./errors');
const { assertAllowedPath } = require('./paths');

const API_BASE = 'https://api.github.com';
const TIMEOUT_MS = 15000;
const READ_ATTEMPTS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

class GitHubStorage {
  constructor({ token, repo, fetchImpl = globalThis.fetch, apiBase = API_BASE }) {
    if (!token || !repo) throw new Error('GitHubStorage requires a token and a repository');
    this.token = token;
    this.repo = repo;
    this.fetch = fetchImpl;
    this.apiBase = apiBase;
  }

  url(path) {
    return `${this.apiBase}/repos/${this.repo}/contents/${assertAllowedPath(path)}`;
  }

  async request(method, url, body) {
    const headers = {
      Authorization: `Bearer ${this.token}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'User-Agent': 'nodejs-app',
    };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    try {
      return await this.fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch {
      // Do not include the error text: it may echo request details.
      throw new StorageError('The private data store could not be reached.');
    }
  }

  // Returns { data, sha } or null when the file does not exist.
  async readJson(path) {
    const url = this.url(path);
    for (let attempt = 1; attempt <= READ_ATTEMPTS; attempt++) {
      const res = await this.request('GET', url);
      if (res.status === 404) return null;
      if (res.status === 200) {
        const body = await res.json();
        const data = JSON.parse(Buffer.from(body.content, 'base64').toString('utf8'));
        return { data, sha: body.sha };
      }
      const transient = res.status >= 500 || res.status === 429;
      if (transient && attempt < READ_ATTEMPTS) {
        await sleep(200 * attempt);
        continue;
      }
      throw new StorageError(`Reading ${path} failed with HTTP ${res.status}.`);
    }
    throw new StorageError('Reading failed.');
  }

  // Creates a new file. Returns true, or 'exists' if the path is already taken.
  async createJson(path, data, message) {
    const res = await this.request('PUT', this.url(path), {
      message,
      content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64'),
    });
    if (res.status === 201 || res.status === 200) return true;
    if (res.status === 409 || res.status === 422) return 'exists';
    throw new StorageError(`Creating ${path} failed with HTTP ${res.status}.`);
  }

  // Updates an existing file. The sha must be the one from the last read. A mismatch throws ConflictError.
  async updateJson(path, data, sha, message) {
    const res = await this.request('PUT', this.url(path), {
      message,
      sha,
      content: Buffer.from(JSON.stringify(data, null, 2) + '\n').toString('base64'),
    });
    if (res.status === 200 || res.status === 201) return true;
    if (res.status === 409) throw new ConflictError(`${path} changed since it was read.`);
    throw new StorageError(`Updating ${path} failed with HTTP ${res.status}.`);
  }

  // Deletes a file. Returns false if it was already gone.
  async deleteJson(path, sha, message) {
    const res = await this.request('DELETE', this.url(path), { message, sha });
    if (res.status === 200) return true;
    if (res.status === 404) return false;
    if (res.status === 409) throw new ConflictError(`${path} changed since it was read.`);
    throw new StorageError(`Deleting ${path} failed with HTTP ${res.status}.`);
  }
}

module.exports = { GitHubStorage };
