'use strict';

// Signup and login against the storage backend. Passwords are never stored or returned in plain text.
const crypto = require('node:crypto');
const { AppError } = require('./errors');
const { hashPassword, verifyPassword } = require('./passwords');
const { USERNAME_RE, userPath, usernamePath } = require('./paths');

const PASSWORD_MIN = 8;
const PASSWORD_MAX = 256;
const LOGIN_FAILURES_PER_USER = 5;
const LOGIN_ATTEMPTS_PER_IP = 30;
const SIGNUP_PER_IP = 10;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const SIGNUP_WINDOW_MS = 60 * 60 * 1000;

function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function checkPasswordLength(password) {
  if (typeof password !== 'string' || password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw new AppError(400, 'INVALID_PASSWORD', `Password must be ${PASSWORD_MIN}-${PASSWORD_MAX} characters.`);
  }
}

function checkUsername(username) {
  if (!USERNAME_RE.test(username)) {
    throw new AppError(400, 'INVALID_USERNAME', 'Username must be 3-32 letters, digits, or underscores.');
  }
}

// Used for unknown usernames so that login takes about as long as a real check.
let dummyHash = null;
async function equalizeTiming(password) {
  if (!dummyHash) dummyHash = await hashPassword('timing-equalizer-not-a-password');
  await verifyPassword(password, dummyHash);
}

function publicUser(user) {
  return { id: user.id, username: user.username };
}

async function signup(ctx, { username: rawName, password, ip }) {
  const ipKey = `signup:${ip}`;
  if (ctx.limiter.count(ipKey, SIGNUP_WINDOW_MS) >= SIGNUP_PER_IP) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many sign-ups from this network. Try again later.');
  }
  ctx.limiter.record(ipKey);

  const username = normalizeUsername(rawName);
  checkUsername(username);
  checkPasswordLength(password);

  // Claim the username first. The file name is the username, so two signups cannot take the same one.
  const id = crypto.randomBytes(16).toString('hex');
  const indexPath = usernamePath(username);
  const claimed = await ctx.storage.createJson(indexPath, { user_id: id }, `Claim username ${username}`);
  if (claimed === 'exists') {
    throw new AppError(409, 'USERNAME_TAKEN', 'That username is taken.');
  }

  try {
    const passwordHash = await hashPassword(password);
    const created = await ctx.storage.createJson(
      userPath(id),
      { id, username, password_hash: passwordHash, created_at: new Date(ctx.now()).toISOString() },
      `Create user ${id}`,
    );
    if (created !== true) throw new Error('user id already exists');
  } catch (err) {
    // Release the username so it is not stuck on a half-created account. Failures here are not reported.
    try {
      const claim = await ctx.storage.readJson(indexPath);
      if (claim) await ctx.storage.deleteJson(indexPath, claim.sha, `Release username ${username}`);
    } catch {
      /* best effort */
    }
    throw err;
  }

  return publicUser({ id, username });
}

async function login(ctx, { username: rawName, password, ip }) {
  const username = normalizeUsername(rawName);
  const userKey = `login-user:${username}`;
  const ipKey = `login-ip:${ip}`;
  if (
    ctx.limiter.count(userKey, LOGIN_WINDOW_MS) >= LOGIN_FAILURES_PER_USER ||
    ctx.limiter.count(ipKey, LOGIN_WINDOW_MS) >= LOGIN_ATTEMPTS_PER_IP
  ) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many login attempts. Try again in 15 minutes.');
  }

  const invalid = () => {
    ctx.limiter.record(userKey);
    ctx.limiter.record(ipKey);
    return new AppError(401, 'INVALID_CREDENTIALS', 'Wrong username or password.');
  };

  const validShape = USERNAME_RE.test(username) && typeof password === 'string' && password.length <= PASSWORD_MAX;
  if (!validShape) {
    await equalizeTiming(typeof password === 'string' ? password.slice(0, PASSWORD_MAX) : '');
    throw invalid();
  }

  const claim = await ctx.storage.readJson(usernamePath(username));
  let user = null;
  if (claim) {
    const stored = await ctx.storage.readJson(userPath(claim.data.user_id));
    user = stored ? stored.data : null;
  }

  const ok = user ? await verifyPassword(password, user.password_hash) : (await equalizeTiming(password), false);
  if (!ok) throw invalid();

  ctx.limiter.clear(userKey);
  return publicUser(user);
}

// Looks up the user for an existing session. Returns null if the account no longer exists.
async function loadUser(storage, userId) {
  try {
    const stored = await storage.readJson(userPath(userId));
    return stored ? publicUser(stored.data) : null;
  } catch (err) {
    if (err instanceof TypeError || /invalid user id/.test(err.message)) return null;
    throw err;
  }
}

module.exports = { signup, login, loadUser, PASSWORD_MIN, PASSWORD_MAX };
