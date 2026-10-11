'use strict';

// Configuration comes only from environment variables. Errors name the variables, never their values.
const path = require('node:path');

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;

function loadAuthConfig(env = process.env) {
  const value = (name) => (env[name] || '').trim();

  const missing = [];
  if (!value('GITHUB_TOKEN')) missing.push('GITHUB_TOKEN');
  if (!value('PRIVATE_DATA_REPO')) missing.push('PRIVATE_DATA_REPO');
  if (!env.SESSION_SECRET || env.SESSION_SECRET.length < 32) missing.push('SESSION_SECRET (at least 32 characters)');
  if (missing.length) return { ok: false, missing };

  const repo = value('PRIVATE_DATA_REPO');
  if (!REPO_RE.test(repo)) return { ok: false, missing: ['PRIVATE_DATA_REPO (must be owner/name)'] };

  const hours = Number(value('SESSION_HOURS') || '12');
  return {
    ok: true,
    config: {
      githubToken: value('GITHUB_TOKEN'),
      repo,
      sessionSecret: env.SESSION_SECRET,
      sessionMs: (Number.isFinite(hours) && hours > 0 ? hours : 12) * 60 * 60 * 1000,
      cookieSecure: env.COOKIE_SECURE !== '0',
      // Only set TRUST_PROXY=1 behind a proxy that overwrites X-Forwarded-For.
      trustProxy: env.TRUST_PROXY === '1',
    },
  };
}

const OWNER_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}$/;
const MIN_CHUNK_BYTES = 256 * 1024;
const MAX_CHUNK_BYTES = 8 * 1024 * 1024;
// Dot-only names such as ".." would become path segments in API URLs, so they are refused.
const STORAGE_REPO_RE = /^(?!\.+$)[A-Za-z0-9._-]{1,100}$/;

// File storage needs two more settings. GITHUB_TOKEN (already required for login) must be able to read and write
// the storage repository. Missing settings disable file routes only; the login pages keep working.
function loadFileConfig(env = process.env, { privateDataRepo } = {}) {
  const value = (name) => (env[name] || '').trim();
  const missing = [];
  if (!value('GITHUB_OWNER')) missing.push('GITHUB_OWNER');
  if (!value('GITHUB_STORAGE_REPO')) missing.push('GITHUB_STORAGE_REPO');
  if (missing.length) return { ok: false, missing };

  if (!OWNER_RE.test(value('GITHUB_OWNER'))) return { ok: false, missing: ['GITHUB_OWNER (not a valid owner name)'] };
  if (!STORAGE_REPO_RE.test(value('GITHUB_STORAGE_REPO'))) {
    return { ok: false, missing: ['GITHUB_STORAGE_REPO (not a valid repository name)'] };
  }
  const repo = `${value('GITHUB_OWNER')}/${value('GITHUB_STORAGE_REPO')}`;
  // File bytes and account data stay in separate repositories.
  if (privateDataRepo && repo.toLowerCase() === privateDataRepo.toLowerCase()) {
    return { ok: false, missing: ['GITHUB_STORAGE_REPO (must differ from PRIVATE_DATA_REPO)'] };
  }

  return { ok: true, config: { storageRepo: repo } };
}

// Optional upload settings. Each keeps its default when unset. A bad value disables file storage and the error names
// the setting (never its value).
function loadUploadSettings(env = process.env) {
  const value = (name) => (env[name] || '').trim();
  const limits = { chunks: {} };
  const chunkRaw = value('UPLOAD_CHUNK_BYTES');
  if (chunkRaw) {
    const bytes = Number(chunkRaw);
    if (!Number.isSafeInteger(bytes) || bytes < MIN_CHUNK_BYTES || bytes > MAX_CHUNK_BYTES) {
      return { ok: false, missing: [`UPLOAD_CHUNK_BYTES (must be a whole number from ${MIN_CHUNK_BYTES} to ${MAX_CHUNK_BYTES})`] };
    }
    limits.chunks.chunkBytes = bytes;
  }
  const hoursRaw = value('UPLOAD_SESSION_HOURS');
  if (hoursRaw) {
    const hours = Number(hoursRaw);
    if (!(hours >= 1 && hours <= 168)) {
      return { ok: false, missing: ['UPLOAD_SESSION_HOURS (must be from 1 to 168)'] };
    }
    limits.chunks.sessionMs = Math.round(hours * 60 * 60 * 1000);
  }
  // Pieces of uploads in progress live here. Keep it on a persistent disk to resume after a restart. Never serve it.
  const tempDir = value('FILE_TEMP_DIR');
  if (tempDir && !path.isAbsolute(tempDir)) {
    return { ok: false, missing: ['FILE_TEMP_DIR (must be an absolute path)'] };
  }
  // URL imports reach only public internet addresses unless this is set. Setting it lets imports reach loopback,
  // private ranges, and internal names on purpose (an internal file server, for example).
  const allowPrivateRaw = (env.IMPORT_ALLOW_PRIVATE || '').trim().toLowerCase();
  limits.importAllowPrivate = ['1', 'true', 'yes', 'on'].includes(allowPrivateRaw);
  return { ok: true, limits, tempDir: tempDir || null };
}

module.exports = { loadAuthConfig, loadFileConfig, loadUploadSettings };
