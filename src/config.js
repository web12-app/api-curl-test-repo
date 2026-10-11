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

module.exports = { loadAuthConfig };
