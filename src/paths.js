'use strict';

// The only paths this app writes to in the private data repository. Client input never becomes a path
// unless it matches these patterns exactly.
const USER_ID_RE = /^[a-f0-9]{32}$/;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const ALLOWED_PATH_RE = /^(users\/[a-f0-9]{32}\.json|system\/usernames\/[a-z0-9_]{3,32}\.json|uploads\/[a-f0-9]{32}\/manifest\.json|shares\/[a-f0-9]{64}\.json)$/;
const SHARE_HASH_RE = /^[a-f0-9]{64}$/;

function userPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `users/${userId}.json`;
}

function usernamePath(username) {
  if (!USERNAME_RE.test(username)) throw new Error('invalid username');
  return `system/usernames/${username}.json`;
}

function manifestPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `uploads/${userId}/manifest.json`;
}

// One index file per share link. It maps the hash of the link's token to its owner and file. The owner's
// manifest is the source of truth: a link works only while the manifest entry still holds the same hash.
function sharePath(tokenHash) {
  if (!SHARE_HASH_RE.test(tokenHash)) throw new Error('invalid share hash');
  return `shares/${tokenHash}.json`;
}

function assertAllowedPath(path) {
  if (!ALLOWED_PATH_RE.test(path)) throw new Error('path not allowed');
  return path;
}

module.exports = { USERNAME_RE, userPath, usernamePath, manifestPath, sharePath, assertAllowedPath };
