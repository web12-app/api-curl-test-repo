'use strict';

// Configuration comes only from environment variables. Errors name the variables, never their values.

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

module.exports = { loadAuthConfig, loadFileConfig };
