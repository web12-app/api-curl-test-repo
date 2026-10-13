'use strict';

// Resolves the latest published Pips Android release from the GitHub API so the
// /app install page always offers the current APK. One upstream call per TTL
// window (the result is cached in memory); any failure falls back to the
// hardcoded FALLBACK release below, so the install page never breaks even when
// the GitHub API is unreachable or rate-limited.

const http = require('http');
const https = require('https');

const REPO = 'web12-app/pips-flutter';
const TTL_MS = 10 * 60 * 1000;
const TIMEOUT_MS = 3000;
const MAX_BODY_BYTES = 1e6;

// Matches the v3.26.2 release (pips-v3.26.2.apk, 240,880,028 bytes).
const FALLBACK = Object.freeze({
  version: '3.26.2',
  sizeBytes: 240880028,
  apkUrl: `https://github.com/${REPO}/releases/download/v3.26.2/pips-v3.26.2.apk`,
  updated: '2026-10-13',
  releasesUrl: `https://github.com/${REPO}/releases`,
  stale: true,
});

let cache = { at: 0, info: null };

function getJson(url) {
  return new Promise((resolve, reject) => {
    const mod = url.startsWith('http://') ? http : https;
    const req = mod.get(
      url,
      { headers: { 'User-Agent': 'file-vault-install-page', Accept: 'application/vnd.github+json' }, timeout: TIMEOUT_MS },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`release lookup failed: HTTP ${res.statusCode}`));
        }
        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          if (body.length > MAX_BODY_BYTES) req.destroy(new Error('release payload too large'));
        });
        res.on('end', () => {
          try {
            resolve(JSON.parse(body));
          } catch (err) {
            reject(new Error(`release lookup returned invalid JSON: ${err.message}`));
          }
        });
      },
    );
    req.on('timeout', () => req.destroy(new Error('release lookup timed out')));
    req.on('error', reject);
  });
}

// Maps a GitHub release object to the small info shape the install page needs.
// Returns null when the release is not usable (no published APK asset).
function fromReleaseJson(input) {
  if (!input || typeof input !== 'object' || input.draft || input.prerelease) return null;
  const assets = Array.isArray(input.assets) ? input.assets : [];
  const apk = assets.find((a) => a && typeof a.name === 'string' && /^pips-.*\.apk$/i.test(a.name) && a.browser_download_url) || null;
  if (!apk) return null;
  const version = String(input.tag_name || '').replace(/^v/i, '') || FALLBACK.version;
  return {
    version,
    sizeBytes: Number(apk.size) || 0,
    apkUrl: apk.browser_download_url,
    updated: String(input.published_at || '').slice(0, 10),
    releasesUrl: `https://github.com/${REPO}/releases`,
    stale: false,
  };
}

// Latest release info for the install page. Never throws: on any upstream
// problem it returns the newest cached info when one exists, else FALLBACK.
async function latestRelease({ apiBase = 'https://api.github.com', now = Date.now } = {}) {
  if (cache.info && now() - cache.at < TTL_MS) return cache.info;
  const base = String(apiBase || '').replace(/\/+$/, '') || 'https://api.github.com';
  try {
    const doc = await getJson(`${base}/repos/${REPO}/releases/latest`);
    const info = fromReleaseJson(doc);
    if (!info) throw new Error('release lookup returned no usable APK asset');
    cache = { at: now(), info };
    return info;
  } catch (err) {
    if (cache.info) return cache.info;
    return { ...FALLBACK };
  }
}

// Tests use this to clear the module-level TTL cache between cases.
function resetCache() {
  cache = { at: 0, info: null };
}

module.exports = { latestRelease, fromReleaseJson, resetCache, FALLBACK };
