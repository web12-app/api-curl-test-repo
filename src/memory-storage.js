'use strict';

// Same interface as GitHubStorage, kept in memory. Used by the tests.
const crypto = require('node:crypto');
const { ConflictError } = require('./errors');
const { assertAllowedPath } = require('./paths');

class MemoryStorage {
  constructor() {
    this.files = new Map(); // path -> { data, sha }
  }

  shaOf(data) {
    return crypto.createHash('sha1').update(JSON.stringify(data)).digest('hex');
  }

  async readJson(path) {
    const file = this.files.get(assertAllowedPath(path));
    if (!file) return null;
    return { data: JSON.parse(JSON.stringify(file.data)), sha: file.sha };
  }

  async createJson(path, data) {
    assertAllowedPath(path);
    if (this.files.has(path)) return 'exists';
    this.files.set(path, { data: JSON.parse(JSON.stringify(data)), sha: this.shaOf(data) });
    return true;
  }

  async updateJson(path, data, sha) {
    assertAllowedPath(path);
    const file = this.files.get(path);
    if (!file || file.sha !== sha) throw new ConflictError(`${path} changed since it was read.`);
    this.files.set(path, { data: JSON.parse(JSON.stringify(data)), sha: this.shaOf(data) });
    return true;
  }

  async deleteJson(path, sha) {
    assertAllowedPath(path);
    const file = this.files.get(path);
    if (!file) return false;
    if (file.sha !== sha) throw new ConflictError(`${path} changed since it was read.`);
    this.files.delete(path);
    return true;
  }
}

module.exports = { MemoryStorage };
