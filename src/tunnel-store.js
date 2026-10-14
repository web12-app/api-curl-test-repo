'use strict';

// Tunnel DB: accounts, reserved names, traffic counters and request logs for
// Pips Tunnel, persisted as one JSON document (system/tunnel.json). Same
// storage discipline as pipsdb.js: read/create/update through the storage
// abstraction with sha tracking and a bounded ConflictError retry.

const crypto = require('node:crypto');
const { ConflictError } = require('./errors');
const { tunnelDbPath } = require('./paths');

const TOKEN_PREFIX = 'tunt_';
const LOG_LIMIT = 50; // recent request log rows kept per tunnel name
const UPDATE_ATTEMPTS = 4;
const ID_RE = /^[a-f0-9]{24}$/;

const randomId = () => crypto.randomBytes(12).toString('hex');
const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const maskToken = (t) => `${t.slice(0, 10)}…${t.slice(-4)}`;

const emptyDoc = () => ({ v: 1, accounts: [], names: {} });

class TunnelStore {
  constructor({ storage, now = Date.now, saveDelayMs = 5000 } = {}) {
    this.storage = storage || null;
    this.now = now;
    this.saveDelayMs = Math.max(0, Number(saveDelayMs) || 0);
    this.doc = emptyDoc();
    this.sha = null;
    this.loaded = null;
    this.timer = null;
  }

  // One-shot load from storage; memoized so handlers can await it cheaply.
  async load() {
    if (this.loaded) return this.loaded;
    this.loaded = (async () => {
      if (!this.storage) return this; // storage not configured: run in memory only
      const record = await this.storage.readJson(tunnelDbPath());
      if (record && record.data && typeof record.data === 'object') {
        this.doc = {
          ...emptyDoc(),
          ...record.data,
          accounts: Array.isArray(record.data.accounts) ? record.data.accounts : [],
          names: record.data.names && typeof record.data.names === 'object' ? record.data.names : {},
        };
        this.sha = record.sha || null;
      }
      return this;
    })();
    return this.loaded;
  }

  // name -> accountId for every claimed (reserved) name.
  claims() {
    const m = new Map();
    for (const [name, rec] of Object.entries(this.doc.names)) {
      if (rec.accountId) m.set(name, rec.accountId);
    }
    return m;
  }

  async createAccount(label) {
    await this.load();
    const account = {
      id: randomId(),
      tokenHash: '',
      tokenMask: '',
      label: String(label || '').trim().slice(0, 64),
      createdAt: this.now(),
    };
    const token = TOKEN_PREFIX + crypto.randomBytes(20).toString('hex');
    account.tokenHash = sha256(token);
    account.tokenMask = maskToken(token);
    this.doc.accounts.push({
      id: account.id,
      tokenHash: account.tokenHash,
      tokenMask: account.tokenMask,
      label: account.label,
      createdAt: account.createdAt,
    });
    this.markDirty();
    return { account, token };
  }

  async verify(token) {
    await this.load();
    const hash = sha256(String(token || ''));
    return this.doc.accounts.find((a) => a.tokenHash === hash) || null;
  }

  accountById(id) {
    if (!ID_RE.test(String(id))) return null;
    return this.doc.accounts.find((a) => a.id === id) || null;
  }

  ensureName(name, accountId) {
    if (!this.doc.names[name]) {
      this.doc.names[name] = { accountId: accountId || null, createdAt: this.now(), served: 0, bytes: 0, lastSeen: 0, logs: [] };
    } else if (accountId && !this.doc.names[name].accountId) {
      this.doc.names[name].accountId = accountId;
    }
    return this.doc.names[name];
  }

  noteRegister(name, accountId) {
    this.ensureName(String(name), accountId);
    this.markDirty();
  }

  noteClose(name) {
    const rec = this.doc.names[String(name)];
    if (rec) {
      rec.lastSeen = this.now();
      this.markDirty();
    }
  }

  noteTraffic(name, entry) {
    const rec = this.ensureName(String(name), null);
    rec.served = (rec.served || 0) + 1;
    rec.bytes = (rec.bytes || 0) + (Number(entry.bytes) || 0);
    rec.lastSeen = this.now();
    rec.logs.unshift({
      t: this.now(),
      method: String(entry.method || 'GET').slice(0, 8),
      path: String(entry.path || '/').slice(0, 256),
      status: Number(entry.status) || 0,
      ms: Math.max(0, Math.round(Number(entry.ms) || 0)),
      bytes: Number(entry.bytes) || 0,
    });
    if (rec.logs.length > LOG_LIMIT) rec.logs.length = LOG_LIMIT;
    this.markDirty();
  }

  namesFor(accountId) {
    return Object.entries(this.doc.names)
      .filter(([, r]) => r.accountId === accountId)
      .map(([name, r]) => ({ name, ...r }));
  }

  markDirty() {
    if (this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      this.flush().catch(() => {});
    }, this.saveDelayMs);
    if (this.timer.unref) this.timer.unref();
  }

  // Write the whole document, mirroring pipsdb.writeDoc: create when we hold
  // no sha yet, otherwise a compare-and-swap update, with a bounded
  // re-read-the-sha-and-retry on ConflictError. The in-memory document stays
  // authoritative: a retry overwrites whatever changed remotely.
  async flush() {
    if (!this.storage) return;
    let lastError = null;
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
      try {
        if (this.sha === null) {
          const created = await this.storage.createJson(tunnelDbPath(), this.doc, 'Pips Tunnel DB');
          if (created !== true) {
            // The document already exists (a restart lost our sha, or a racing
            // writer got there first): adopt its sha, then update over it.
            const existing = await this.storage.readJson(tunnelDbPath());
            this.sha = existing ? existing.sha : null;
            if (this.sha === null) throw new ConflictError(`${tunnelDbPath()} appeared and vanished while creating it.`);
          }
        }
        if (this.sha !== null) {
          await this.storage.updateJson(tunnelDbPath(), this.doc, this.sha, 'Pips Tunnel DB');
        }
        const fresh = await this.storage.readJson(tunnelDbPath());
        if (fresh) this.sha = fresh.sha;
        return;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === UPDATE_ATTEMPTS) throw err;
        lastError = err;
        const fresh = await this.storage.readJson(tunnelDbPath());
        this.sha = fresh ? fresh.sha : null; // vanished: the next attempt creates it again
      }
    }
    throw lastError;
  }
}

module.exports = { TunnelStore, TOKEN_PREFIX, emptyDoc };
