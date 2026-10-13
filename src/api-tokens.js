'use strict';

// Per-user API tokens: unique credentials for non-browser clients (curl, mobile
// apps, scripts). Every signup and login mints a fresh token; each token is
// scoped to exactly its own user and can be revoked at any time. Only SHA-256
// hashes are stored, so the data repository never holds a usable token.

const crypto = require('node:crypto');
const { ConflictError } = require('./errors');
const { tokensPath } = require('./paths');

const TOKEN_PREFIX = 'sat_';
// sat_<user id hex>.<base64url secret> - the user id inside the token makes the
// lookup a single document read instead of a scan over every account.
const API_TOKEN_RE = /^sat_([a-f0-9]{32})\.([A-Za-z0-9_-]{40,})$/;
const SECRET_BYTES = 32;
const TOKEN_ID_BYTES = 6; // 12 hex characters
const MAX_TOKENS_PER_USER = 40;
const UPDATE_ATTEMPTS = 4;

const sha256 = (value) => crypto.createHash('sha256').update(value, 'utf8').digest('hex');

function isApiToken(value) {
  return typeof value === 'string' && API_TOKEN_RE.test(value);
}

// True when the Authorization header carries a Bearer API token. Such a request
// carries its credential in the header, so the cookie CSRF checks do not apply.
function isBearerHeader(value) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(value || '').trim());
  return Boolean(m) && isApiToken(m[1]);
}

function fromHeader(value) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(value || '').trim());
  return m ? m[1] : null;
}

async function readTokenDoc(storage, userId) {
  const record = await storage.readJson(tokensPath(userId));
  if (!record) return { doc: { tokens: [] }, sha: null };
  const doc = record.data && Array.isArray(record.data.tokens) ? record.data : { tokens: [] };
  return { doc, sha: record.sha };
}

// Read-modify-write with a bounded retry: a concurrent token write bumps the
// sha, so the next attempt re-reads the document and replays the mutation.
async function withTokenDoc(storage, userId, mutate) {
  let lastError = null;
  for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
    const { doc, sha } = await readTokenDoc(storage, userId);
    const result = mutate(doc);
    try {
      if (sha === null) {
        const created = await storage.createJson(tokensPath(userId), doc, `API tokens for ${userId}`);
        if (created !== true) throw new ConflictError(`${tokensPath(userId)} appeared while creating it.`);
      } else {
        await storage.updateJson(tokensPath(userId), doc, sha, `API tokens for ${userId}`);
      }
      return result;
    } catch (err) {
      if (!(err instanceof ConflictError) || attempt === UPDATE_ATTEMPTS) throw err;
      lastError = err;
    }
  }
  throw lastError;
}

// Mint one token. The raw value is returned ONCE; only its hash is kept.
async function issueToken(storage, userId, nowMs) {
  const secret = crypto.randomBytes(SECRET_BYTES).toString('base64url');
  const token = `${TOKEN_PREFIX}${userId}.${secret}`;
  const entry = {
    id: crypto.randomBytes(TOKEN_ID_BYTES).toString('hex'),
    hash: sha256(token),
    created_at: new Date(nowMs).toISOString(),
    revoked_at: null,
  };
  await withTokenDoc(storage, userId, (doc) => {
    while (doc.tokens.length >= MAX_TOKENS_PER_USER) {
      // Retire the oldest revoked token first; otherwise the oldest live one.
      const oldestRevoked = doc.tokens.findIndex((t) => t.revoked_at);
      doc.tokens.splice(oldestRevoked === -1 ? 0 : oldestRevoked, 1);
    }
    doc.tokens.push(entry);
  });
  return { token, id: entry.id, created_at: entry.created_at };
}

// Resolve a Bearer token to its owner: { userId, tokenId }, or null for
// unknown, malformed, or revoked tokens.
async function resolveToken(storage, token) {
  if (!isApiToken(token)) return null;
  const userId = API_TOKEN_RE.exec(token)[1];
  const { doc } = await readTokenDoc(storage, userId);
  const entry = doc.tokens.find((t) => t.hash === sha256(token));
  if (!entry || entry.revoked_at) return null;
  return { userId, tokenId: entry.id };
}

// Metadata only - never the hash and never the raw secret.
async function listTokens(storage, userId) {
  const { doc } = await readTokenDoc(storage, userId);
  return doc.tokens.map(({ id, created_at, revoked_at }) => ({ id, created_at, revoked_at }));
}

async function revokeByRaw(storage, token, nowMs) {
  if (!isApiToken(token)) return false;
  const userId = API_TOKEN_RE.exec(token)[1];
  const revokedAt = new Date(nowMs === undefined ? Date.now() : nowMs).toISOString();
  let revoked = false;
  await withTokenDoc(storage, userId, (doc) => {
    const entry = doc.tokens.find((t) => t.hash === sha256(token) && !t.revoked_at);
    if (entry) {
      entry.revoked_at = revokedAt;
      revoked = true;
    }
  });
  return revoked;
}

async function revokeById(storage, userId, tokenId, nowMs) {
  if (!/^[a-f0-9]{12}$/.test(String(tokenId))) return false;
  const revokedAt = new Date(nowMs === undefined ? Date.now() : nowMs).toISOString();
  let revoked = false;
  await withTokenDoc(storage, userId, (doc) => {
    const entry = doc.tokens.find((t) => t.id === tokenId && !t.revoked_at);
    if (entry) {
      entry.revoked_at = revokedAt;
      revoked = true;
    }
  });
  return revoked;
}

module.exports = {
  TOKEN_PREFIX,
  API_TOKEN_RE,
  isApiToken,
  isBearerHeader,
  fromHeader,
  issueToken,
  resolveToken,
  listTokens,
  revokeByRaw,
  revokeById,
};
