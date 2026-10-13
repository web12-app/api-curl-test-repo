'use strict';

// The only paths this app writes to in the private data repository. Client input never becomes a path
// unless it matches these patterns exactly.
const USER_ID_RE = /^[a-f0-9]{32}$/;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
// system/tube.json is the single Tube document (channels + published videos), shared by every user.
const ALLOWED_PATH_RE = /^(users\/[a-f0-9]{32}\.json|system\/usernames\/[a-z0-9_]{3,32}\.json|system\/tube\.json|uploads\/[a-f0-9]{32}\/manifest\.json|shares\/[a-f0-9]{64}\.json|upload-links\/[a-f0-9]{64}\.json|tokens\/[a-f0-9]{32}\.json|pipsdb\/[a-f0-9]{32}\.json|devices\/[a-f0-9]{32}\.json|follows\/[a-f0-9]{32}\.json|inbox\/[a-f0-9]{32}\.json|notifications\/[a-f0-9]{32}\.json|messages\/[a-f0-9]{32}\.[a-f0-9]{32}\.json|attachments\/[a-f0-9]{32}\.json)$/;
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

// One index file per upload link, keyed by the hash of the link's token. It names the owner and the link.
function uploadLinkPath(tokenHash) {
  if (!SHARE_HASH_RE.test(tokenHash)) throw new Error('invalid link hash');
  return `upload-links/${tokenHash}.json`;
}

// One API-token index per user. It holds only SHA-256 hashes of that user's Bearer tokens.
function tokensPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `tokens/${userId}.json`;
}

// Pips app companion stores, one document per user.
function pipsDbPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `pipsdb/${userId}.json`;
}

function devicesPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `devices/${userId}.json`;
}

function followsPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `follows/${userId}.json`;
}

function inboxPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `inbox/${userId}.json`;
}

function notificationsPath(userId) {
  if (!USER_ID_RE.test(userId)) throw new Error('invalid user id');
  return `notifications/${userId}.json`;
}

// One DM thread document per user pair, keyed by the sorted pair of ids.
function messagesPath(userIdA, userIdB) {
  const [a, b] = [String(userIdA), String(userIdB)].sort();
  if (!USER_ID_RE.test(a) || !USER_ID_RE.test(b)) throw new Error('invalid user id');
  return `messages/${a}.${b}.json`;
}

// One grant document per shared-into-a-chat (or avatar) file: it names the
// owner and the peers allowed to read it.
function attachmentsPath(fileId) {
  if (!/^[a-f0-9]{32}$/.test(String(fileId))) throw new Error('invalid file id');
  return `attachments/${fileId}.json`;
}

// The single Tube document: every channel and every published video, in one JSON file.
function tubePath() {
  return 'system/tube.json';
}

function assertAllowedPath(path) {
  if (!ALLOWED_PATH_RE.test(path)) throw new Error('path not allowed');
  return path;
}

module.exports = { USERNAME_RE, userPath, usernamePath, manifestPath, sharePath, uploadLinkPath, tokensPath, pipsDbPath, devicesPath, followsPath, inboxPath, notificationsPath, messagesPath, attachmentsPath, tubePath, assertAllowedPath };
