'use strict';

// Signed session cookies: base64url(payload).HMAC-SHA256(payload). The payload holds the user id, issue time, and expiry.
const crypto = require('node:crypto');

const COOKIE_NAME = 'session';

function sign(secret, value) {
  return crypto.createHmac('sha256', secret).update(value).digest('base64url');
}

function createSession(secret, userId, ttlMs, now = Date.now()) {
  const payload = Buffer.from(JSON.stringify({ uid: userId, iat: now, exp: now + ttlMs })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

function readSession(secret, token, now = Date.now()) {
  if (typeof token !== 'string') return null;
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(secret, payload));
  if (mac.length !== expected.length || !crypto.timingSafeEqual(mac, expected)) return null;

  let data;
  try {
    data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  // iat is needed so that logout can revoke sessions issued before it. Older tokens without it are refused.
  if (typeof data.uid !== 'string' || typeof data.iat !== 'number' || typeof data.exp !== 'number') return null;
  if (data.exp <= now) return null;
  return data;
}

function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq === -1) continue;
    const name = part.slice(0, eq).trim();
    if (name) out[name] = part.slice(eq + 1).trim();
  }
  return out;
}

function sessionCookie(token, { maxAgeSec, secure }) {
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSec}${secure ? '; Secure' : ''}`;
}

function clearSessionCookie({ secure }) {
  return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? '; Secure' : ''}`;
}

module.exports = { COOKIE_NAME, createSession, readSession, parseCookies, sessionCookie, clearSessionCookie };
