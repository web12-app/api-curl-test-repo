'use strict';

// Tunnel DB: accounts, reserved names, traffic counters and request logs for
// Pips Tunnel, persisted as one JSON document (system/tunnel.json). Same
// storage discipline as pipsdb.js: read/create/update through the storage
// abstraction with sha tracking and a bounded ConflictError retry.

const crypto = require('node:crypto');
const { AppError, ConflictError } = require('./errors');
const { tunnelDbPath } = require('./paths');

const TOKEN_PREFIX = 'tunt_';
// Same shape as src/tunnel.js NAME_RE (kept local so the store has no import cycle):
// 1-32 chars, a-z 0-9 "-" "_", starting with a letter or digit.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
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

  // Tunnel accounts may be anonymous (the CLI's POST /api/tunnel/account) or
  // owned by a signed-in site user (the /tunnel manager). Ownership is what
  // accountsForUser/assertOwned/revokeAccount are keyed on.
  async createAccount(label, { userId = null, username = null } = {}) {
    await this.load();
    const account = {
      id: randomId(),
      tokenHash: '',
      tokenMask: '',
      label: String(label || '').trim().slice(0, 64),
      createdAt: this.now(),
      userId: userId ? String(userId) : null,
      username: username ? String(username) : null,
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
      userId: account.userId,
      username: account.username,
    });
    this.markDirty();
    return { account, token };
  }

  // Every tunnel token a site user created, with a count of names it holds.
  // Masks only - the full token was shown once when the token was created.
  accountsForUser(userId) {
    return this.doc.accounts
      .filter((a) => a.userId && a.userId === userId)
      .map((a) => ({
        id: a.id,
        label: a.label,
        tokenMask: a.tokenMask,
        createdAt: a.createdAt,
        names: Object.values(this.doc.names).filter((n) => n.accountId === a.id).length,
      }));
  }

  // Returns the account when it exists and belongs to this site user; any
  // other case is the same not-found error (no existence leak).
  assertOwned(accountId, userId) {
    const account = this.accountById(accountId);
    if (!account || !userId || account.userId !== userId) {
      throw new AppError(404, 'TUNNEL_TOKEN_NOT_FOUND', 'No such tunnel token.');
    }
    return account;
  }

  // Revoke one of the user's tunnel tokens: release every name it had claimed
  // (so others can take them) and drop the account. Returns the released names.
  async revokeAccount(accountId, userId) {
    await this.load();
    const account = this.assertOwned(accountId, userId);
    const released = [];
    for (const [name, rec] of Object.entries(this.doc.names)) {
      if (rec.accountId === account.id) {
        rec.accountId = null;
        released.push(name);
      }
    }
    this.doc.accounts = this.doc.accounts.filter((a) => a.id !== account.id);
    this.markDirty();
    return released;
  }

  // Reserve a stable name for a tunnel account. Valid names only; a name held
  // by a different account is taken, a free (or re-claimed by its owner) name
  // is (re)attached. The account must already be ownership-checked.
  claimName(rawName, accountId) {
    const name = String(rawName || '').trim().toLowerCase();
    if (!NAME_RE.test(name)) {
      throw new AppError(400, 'INVALID_NAME', 'App name must be 1-32 characters: a-z, 0-9, "-" or "_", starting with a letter or digit.');
    }
    const existing = this.doc.names[name];
    if (existing && existing.accountId && existing.accountId !== accountId) {
      throw new AppError(409, 'NAME_TAKEN', 'That tunnel name is already reserved.');
    }
    const record = this.ensureName(name, accountId);
    this.markDirty();
    return { name, ...record };
  }

  // Give a reserved name back: the record survives (traffic history stays)
  // but becomes free for anyone to claim again.
  releaseName(rawName, accountId) {
    const name = String(rawName || '').trim().toLowerCase();
    const rec = this.doc.names[name];
    if (!rec || !rec.accountId) {
      throw new AppError(404, 'NAME_NOT_FOUND', 'No reserved tunnel name goes by that name.');
    }
    if (rec.accountId !== accountId) {
      throw new AppError(403, 'NAME_NOT_YOURS', 'That tunnel name belongs to a different tunnel token.');
    }
    rec.accountId = null;
    this.markDirty();
    return { name, released: true };
  }

  // ---- Protected names: an optional per-name access gate for /tun/<name>.

  // The name record behind the 404/403 ownership dance (shared by protect,
  // unprotect and logs). Anonymous (unowned) names count as not found: there
  // is no account that could own the gate.
  ownedNameRecord(rawName, accountId) {
    const name = String(rawName || '').trim().toLowerCase();
    const rec = this.doc.names[name];
    if (!rec || !rec.accountId) {
      throw new AppError(404, 'NAME_NOT_FOUND', 'No reserved tunnel name goes by that name.');
    }
    if (rec.accountId !== accountId) {
      throw new AppError(403, 'NAME_NOT_YOURS', 'That tunnel name belongs to a different tunnel token.');
    }
    return rec;
  }

  // Attach an access gate to a name the account owns. The full token comes
  // back exactly once; the store keeps only its sha256 hash and a mask. The
  // token is caller-supplied (16-128 chars) or a random 32-hex string.
  protectName(rawName, accountId, rawToken) {
    const rec = this.ownedNameRecord(rawName, accountId);
    let token;
    if (rawToken !== undefined && rawToken !== null && String(rawToken) !== '') {
      token = String(rawToken);
      if (token.length < 16 || token.length > 128) {
        throw new AppError(400, 'INVALID_ACCESS_TOKEN', 'The access token must be 16-128 characters.');
      }
    } else {
      token = crypto.randomBytes(16).toString('hex');
    }
    rec.access = { tokenHash: sha256(token), tokenMask: maskToken(token) };
    this.markDirty();
    return { token, tokenMask: rec.access.tokenMask };
  }

  // Take the gate off. The record (and its traffic history) stays.
  unprotectName(rawName, accountId) {
    const rec = this.ownedNameRecord(rawName, accountId);
    delete rec.access;
    this.markDirty();
    return { name: String(rawName || '').trim().toLowerCase(), protected: false };
  }

  isProtected(name) {
    const rec = this.doc.names[String(name || '').trim().toLowerCase()];
    return Boolean(rec && rec.access && rec.access.tokenHash);
  }

  // True when the name has no gate, or the visitor token hashes to the value
  // the owner set. Callers gate on isProtected() first for the 401 path.
  checkAccess(name, visitorToken) {
    const rec = this.doc.names[String(name || '').trim().toLowerCase()];
    if (!rec || !rec.access) return true;
    return rec.access.tokenHash === sha256(String(visitorToken || ''));
  }

  // How many names currently carry an access gate (stats + dashboard).
  countProtected() {
    return Object.values(this.doc.names).filter((n) => n.access && n.access.tokenHash).length;
  }

  // The request-log ring for one owned name (noteTraffic caps it at LOG_LIMIT).
  logsFor(rawName, accountId) {
    const rec = this.ownedNameRecord(rawName, accountId);
    return { name: String(rawName || '').trim().toLowerCase(), logs: rec.logs || [] };
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
