'use strict';

// Pips DB: per-user text documents (the pips-flutter "DB" screen). One JSON
// document per user holds all of their notes; every write snapshots the
// previous content so an old version can be restored. Only hashes and ids are
// client-visible; the raw content never leaves the read endpoint.

const crypto = require('node:crypto');
const { AppError, ConflictError } = require('./errors');
const { pipsDbPath } = require('./paths');

const MAX_DOCS = 100;
const MAX_CONTENT_BYTES = 256 * 1024;
const MAX_VERSIONS = 10;
const MAX_TOTAL_BYTES = 4 * 1024 * 1024;
const NAME_MAX = 80;
const UPDATE_ATTEMPTS = 4;
const ID_RE = /^[a-f0-9]{12}$/;

const validName = (name) => typeof name === 'string' && name.trim().length >= 1 && name.trim().length <= NAME_MAX && !/[\u0000-\u001f]/.test(name);

class PipsDb {
  constructor({ storage, now = Date.now }) {
    this.storage = storage;
    this.now = now;
  }

  async readDoc(userId) {
    const record = await this.storage.readJson(pipsDbPath(userId));
    if (record && record.data && Array.isArray(record.data.files)) return { doc: record.data, sha: record.sha };
    return { doc: { files: [] }, sha: record ? record.sha : null };
  }

  async writeDoc(userId, doc, sha) {
    if (sha === null) {
      const created = await this.storage.createJson(pipsDbPath(userId), doc, `Pips DB for ${userId}`);
      if (created !== true) throw new ConflictError(`${pipsDbPath(userId)} appeared while creating it.`);
      return;
    }
    await this.storage.updateJson(pipsDbPath(userId), doc, sha, `Pips DB for ${userId}`);
  }

  // Read-modify-write with a bounded retry, like the token and manifest stores.
  async withDoc(userId, mutate) {
    let lastError = null;
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
      const { doc, sha } = await this.readDoc(userId);
      const result = mutate(doc);
      try {
        await this.writeDoc(userId, doc, sha);
        return result;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === UPDATE_ATTEMPTS) throw err;
        lastError = err;
      }
    }
    throw lastError;
  }

  live(doc) {
    return doc.files.filter((f) => !f.removed_at);
  }

  view(f) {
    return {
      id: f.id,
      name: f.name,
      version: f.version,
      revisions: f.versions.length,
      size: Buffer.byteLength(f.content, 'utf8'),
      created_at: f.created_at,
      updated_at: f.updated_at,
    };
  }

  checkContent(content) {
    if (typeof content !== 'string') throw new AppError(400, 'INVALID_BODY', 'Content must be a string.');
    if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT_BYTES) {
      throw new AppError(413, 'CONTENT_TOO_LARGE', `A document must be ${Math.floor(MAX_CONTENT_BYTES / 1024)} KB or smaller.`);
    }
  }

  // Snapshot the current content onto the version list, then advance.
  snapshot(f) {
    f.versions.push({ v: f.version, at: f.updated_at, content: f.content });
    while (f.versions.length > MAX_VERSIONS) f.versions.shift();
    f.version += 1;
  }

  totalBytes(doc) {
    return doc.files.reduce((sum, f) => sum + Buffer.byteLength(f.content, 'utf8'), 0);
  }

  async list(userId) {
    const { doc } = await this.readDoc(userId);
    return this.live(doc)
      .map((f) => this.view(f))
      .sort((a, b) => (a.updated_at < b.updated_at ? 1 : -1));
  }

  async create(userId, { name, content }) {
    this.checkContent(content);
    if (!validName(name)) throw new AppError(400, 'INVALID_NAME', `The document name must be 1-${NAME_MAX} characters.`);
    const trimmed = name.trim();
    const now = new Date(this.now()).toISOString();
    const file = {
      id: crypto.randomBytes(6).toString('hex'),
      name: trimmed,
      content,
      version: 1,
      versions: [],
      created_at: now,
      updated_at: now,
      removed_at: null,
    };
    await this.withDoc(userId, (doc) => {
      if (this.live(doc).some((f) => f.name === trimmed)) {
        throw new AppError(409, 'NAME_TAKEN', 'A document with that name already exists.');
      }
      if (this.live(doc).length >= MAX_DOCS) {
        throw new AppError(409, 'TOO_MANY_DOCUMENTS', `At most ${MAX_DOCS} documents per account.`);
      }
      if (this.totalBytes(doc) + Buffer.byteLength(content, 'utf8') > MAX_TOTAL_BYTES) {
        throw new AppError(413, 'DB_TOO_LARGE', 'The Pips DB for this account is full.');
      }
      doc.files.push(file);
    });
    return this.view(file);
  }

  findLive(doc, id) {
    if (!ID_RE.test(String(id))) throw new AppError(404, 'NOT_FOUND', 'No such document.');
    const f = this.live(doc).find((x) => x.id === id);
    if (!f) throw new AppError(404, 'NOT_FOUND', 'No such document.');
    return f;
  }

  // Content of one document.
  async read(userId, id) {
    const { doc } = await this.readDoc(userId);
    return this.findLive(doc, id);
  }

  async write(userId, id, content) {
    this.checkContent(content);
    await this.withDoc(userId, (doc) => {
      const f = this.findLive(doc, id);
      this.snapshot(f);
      f.content = content;
      f.updated_at = new Date(this.now()).toISOString();
    });
    const { doc } = await this.readDoc(userId);
    return this.view(this.findLive(doc, id));
  }

  // Edit a single 1-based line: action insert | replace | delete.
  async editLine(userId, id, { line, action, text }) {
    if (!Number.isInteger(line) || line < 1 || line > 100000) {
      throw new AppError(400, 'INVALID_LINE', 'Line must be an integer from 1 to 100000.');
    }
    if (!['insert', 'replace', 'delete'].includes(action)) {
      throw new AppError(400, 'INVALID_ACTION', 'Action must be insert, replace, or delete.');
    }
    if (text !== undefined && text !== null) {
      if (typeof text !== 'string' || text.length > 4096) throw new AppError(400, 'INVALID_TEXT', 'Text must be a string of at most 4096 characters.');
    }
    await this.withDoc(userId, (doc) => {
      const f = this.findLive(doc, id);
      const lines = f.content.split('\n');
      const idx = line - 1;
      if (action === 'insert') lines.splice(idx, 0, text === undefined || text === null ? '' : text);
      else if (action === 'replace') {
        if (idx >= lines.length) throw new AppError(400, 'LINE_OUT_OF_RANGE', 'That line does not exist yet.');
        lines[idx] = text === undefined || text === null ? '' : text;
      } else {
        if (idx >= lines.length) throw new AppError(400, 'LINE_OUT_OF_RANGE', 'That line does not exist.');
        lines.splice(idx, 1);
      }
      this.snapshot(f);
      f.content = lines.join('\n');
      f.updated_at = new Date(this.now()).toISOString();
    });
    const { doc } = await this.readDoc(userId);
    return this.view(this.findLive(doc, id));
  }

  async move(userId, id, name) {
    if (!validName(name)) throw new AppError(400, 'INVALID_NAME', `The document name must be 1-${NAME_MAX} characters.`);
    const trimmed = name.trim();
    await this.withDoc(userId, (doc) => {
      const f = this.findLive(doc, id);
      if (this.live(doc).some((x) => x.name === trimmed && x.id !== id)) {
        throw new AppError(409, 'NAME_TAKEN', 'A document with that name already exists.');
      }
      f.name = trimmed;
      f.updated_at = new Date(this.now()).toISOString();
    });
    const { doc } = await this.readDoc(userId);
    return this.view(this.findLive(doc, id));
  }

  async remove(userId, id) {
    let removed = false;
    await this.withDoc(userId, (doc) => {
      const f = this.findLive(doc, id);
      f.removed_at = new Date(this.now()).toISOString();
      removed = true;
    });
    return { removed };
  }

  // Restore an old snapshot as the current content (a new revision on top).
  async restore(userId, id, version) {
    if (!Number.isInteger(version) || version < 1) throw new AppError(400, 'INVALID_VERSION', 'Version must be a positive integer.');
    await this.withDoc(userId, (doc) => {
      const f = this.findLive(doc, id);
      const snap = f.versions.find((v) => v.v === version);
      if (!snap) throw new AppError(404, 'VERSION_NOT_FOUND', 'No such saved version.');
      this.snapshot(f);
      f.content = snap.content;
      f.updated_at = new Date(this.now()).toISOString();
    });
    const { doc } = await this.readDoc(userId);
    return this.view(this.findLive(doc, id));
  }
}

module.exports = { PipsDb };
