'use strict';

const http = require('node:http');
const { AppError, ConflictError, StorageError } = require('./errors');
const { loadAuthConfig } = require('./config');
const { GitHubStorage } = require('./github-storage');
const { RateLimiter } = require('./rate-limit');
const { signup, login, loadUser } = require('./accounts');
const { COOKIE_NAME, createSession, readSession, parseCookies, sessionCookie, clearSessionCookie } = require('./session');
const pages = require('./pages');

const MAX_BODY_BYTES = 16 * 1024;

// CORS applies to /api/ only. Each allowed origin must be listed exactly (scheme://host[:port], no path, no
// trailing slash). Never "*": the API uses cookies, and browsers refuse credentials with a wildcard anyway.
function parseCorsOrigins(value) {
  const list = (value || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const origin of list) {
    let parsed = null;
    try {
      parsed = new URL(origin);
    } catch {
      parsed = null;
    }
    const secure = parsed && parsed.protocol === 'https:';
    const local = parsed && parsed.protocol === 'http:' && ['localhost', '127.0.0.1'].includes(parsed.hostname);
    if (!parsed || parsed.origin !== origin || !(secure || local)) {
      throw new Error('CORS_ALLOWED_ORIGINS has an invalid entry. Use https://host[:port] with no path or trailing slash.');
    }
  }
  return list;
}

// Login needs three settings. Without them the site still serves its public pages, and auth routes report
// which setting is missing (names only, never values).
function buildAuth(env, overrides = {}) {
  const loaded = loadAuthConfig(env);
  if (!loaded.ok) return { enabled: false, missing: loaded.missing };
  const { config } = loaded;
  const now = overrides.now || Date.now;
  return {
    enabled: true,
    config,
    now,
    storage: overrides.storage || new GitHubStorage({ token: config.githubToken, repo: config.repo }),
    limiter: overrides.limiter || new RateLimiter(now),
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

const sendHtml = (res, status, html, headers = {}) =>
  send(res, status, { 'Content-Type': 'text/html; charset=utf-8', ...headers }, html);

const sendJson = (res, status, body, headers = {}) =>
  send(res, status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }, JSON.stringify(body));

const redirect = (res, location, headers = {}) => send(res, 303, { Location: location, ...headers }, '');

const isApiPath = (ctx) => ctx.url.pathname.startsWith('/api/');

function fail(ctx, status, code, message, headers = {}) {
  if (isApiPath(ctx)) return sendJson(ctx.res, status, { success: false, error: { code, message } }, headers);
  return sendHtml(ctx.res, status, pages.errorPage(status, message), headers);
}

function clientIp(req, auth) {
  if (auth.enabled && auth.config.trustProxy) {
    const forwarded = req.headers['x-forwarded-for'];
    if (forwarded) return String(forwarded).split(',')[0].trim();
  }
  return req.socket.remoteAddress || 'unknown';
}

// Browsers send Origin on cross-site POST requests. Refuse them when the origin is not this host.
function sameOrigin(req, corsOrigins) {
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (corsOrigins.includes(origin)) return true;
  try {
    return new URL(origin).host === req.headers.host;
  } catch {
    return false;
  }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body is too large.'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', () => reject(new AppError(400, 'BAD_REQUEST', 'The request could not be read.')));
  });
}

async function readForm(ctx) {
  const raw = await readBody(ctx.req);
  const type = (ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type === 'application/x-www-form-urlencoded') return Object.fromEntries(new URLSearchParams(raw));
  if (type === 'application/json') return parseJson(raw);
  throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send a form or JSON.');
}

function parseJson(raw) {
  let value;
  try {
    value = JSON.parse(raw || '{}');
  } catch {
    throw new AppError(400, 'INVALID_JSON', 'Request body must be valid JSON.');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AppError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
  }
  return value;
}

async function readJsonBody(ctx) {
  const raw = await readBody(ctx.req);
  const type = (ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send JSON.');
  return parseJson(raw);
}

function requireConfigured(ctx) {
  if (!ctx.auth.enabled) {
    throw new AppError(503, 'NOT_CONFIGURED', `Login is not configured. Missing: ${ctx.auth.missing.join(', ')}.`);
  }
}

async function currentUser(ctx) {
  if (!ctx.auth.enabled) return null;
  const token = parseCookies(ctx.req.headers.cookie)[COOKIE_NAME];
  const session = readSession(ctx.auth.config.sessionSecret, token, ctx.auth.now());
  if (!session) return null;
  return loadUser(ctx.auth.storage, session.uid);
}

function sessionHeader(ctx, user) {
  const { sessionSecret, sessionMs, cookieSecure } = ctx.auth.config;
  const token = createSession(sessionSecret, user.id, sessionMs, ctx.auth.now());
  return sessionCookie(token, { maxAgeSec: Math.floor(sessionMs / 1000), secure: cookieSecure });
}

const logoutHeader = (ctx) => clearSessionCookie({ secure: ctx.auth.enabled ? ctx.auth.config.cookieSecure : true });

// ---- pages

async function pageHome(ctx) {
  sendHtml(ctx.res, 200, pages.homePage(await currentUser(ctx)));
}

function pageAuthForm(mode) {
  return (ctx) => {
    requireConfigured(ctx);
    const error = ctx.url.searchParams.get('error');
    sendHtml(ctx.res, 200, pages.authForm({ mode, error }));
  };
}

async function pageDashboard(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  sendHtml(ctx.res, 200, pages.dashboardPage(user));
}

// ---- form posts (browser pages)

async function formLogin(ctx) {
  requireConfigured(ctx);
  const body = await readForm(ctx);
  const user = await login(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  redirect(ctx.res, '/dashboard', { 'Set-Cookie': sessionHeader(ctx, user) });
}

async function formSignup(ctx) {
  requireConfigured(ctx);
  const body = await readForm(ctx);
  const user = await signup(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  redirect(ctx.res, '/dashboard', { 'Set-Cookie': sessionHeader(ctx, user) });
}

async function formLogout(ctx) {
  redirect(ctx.res, '/', { 'Set-Cookie': logoutHeader(ctx) });
}

// ---- JSON API (same envelope as the earlier platform)

const ok = (ctx, status, data, headers) => sendJson(ctx.res, status, { success: true, data }, headers);

// Plain body, not the envelope: this is the health contract that existing monitors read.
async function apiHealth(ctx) {
  sendJson(ctx.res, 200, { status: 'ok' });
}

async function apiSignup(ctx) {
  requireConfigured(ctx);
  const body = await readJsonBody(ctx);
  const user = await signup(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  ok(ctx, 201, { user }, { 'Set-Cookie': sessionHeader(ctx, user) });
}

async function apiLogin(ctx) {
  requireConfigured(ctx);
  const body = await readJsonBody(ctx);
  const user = await login(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  ok(ctx, 200, { user }, { 'Set-Cookie': sessionHeader(ctx, user) });
}

async function apiLogout(ctx) {
  ok(ctx, 200, {}, { 'Set-Cookie': logoutHeader(ctx) });
}

async function apiMe(ctx) {
  requireConfigured(ctx);
  ok(ctx, 200, { user: await currentUser(ctx) }, {});
}

const ROUTES = [
  { method: 'GET', path: '/', handler: pageHome },
  { method: 'GET', path: '/api/health', handler: apiHealth },
  { method: 'GET', path: '/login', handler: pageAuthForm('login') },
  { method: 'GET', path: '/signup', handler: pageAuthForm('signup') },
  { method: 'POST', path: '/login', handler: formLogin },
  { method: 'POST', path: '/signup', handler: formSignup },
  { method: 'GET', path: '/dashboard', handler: pageDashboard },
  { method: 'POST', path: '/logout', handler: formLogout },
  { method: 'POST', path: '/api/signup', handler: apiSignup },
  { method: 'POST', path: '/api/login', handler: apiLogin },
  { method: 'POST', path: '/api/logout', handler: apiLogout },
  { method: 'GET', path: '/api/me', handler: apiMe },
];

// Where a failed browser form post goes back to, with the error code in the query string.
const FORM_PAGES = { '/login': '/login', '/signup': '/signup' };

async function handleError(ctx, err) {
  if (ctx.res.headersSent) return ctx.res.end();

  if (err instanceof AppError) {
    if (err.status < 500 && ctx.req.method === 'POST' && !isApiPath(ctx) && FORM_PAGES[ctx.url.pathname]) {
      return redirect(ctx.res, `${FORM_PAGES[ctx.url.pathname]}?error=${encodeURIComponent(err.code)}`);
    }
    const headers = err.status === 429 ? { 'Retry-After': '900' } : {};
    return fail(ctx, err.status, err.code, err.message, headers);
  }
  if (err instanceof ConflictError) {
    console.error(`ConflictError: ${err.message}`);
    return fail(ctx, 409, 'CONFLICT', 'The data changed. Try again.');
  }
  if (err instanceof StorageError) {
    console.error(`StorageError: ${err.message}`);
    return fail(ctx, 503, 'UPSTREAM_ERROR', 'The data store is unavailable. Try again shortly.');
  }
  // Log the error type only: messages can contain request data.
  console.error(`Unexpected error: ${err && err.name}`);
  return fail(ctx, 500, 'INTERNAL_ERROR', 'Something went wrong.');
}

async function dispatch(req, res, auth, corsOrigins) {
  const url = new URL(req.url || '/', 'http://localhost');
  const ctx = { req, res, url, auth, ip: clientIp(req, auth) };
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  const isApi = url.pathname.startsWith('/api/');
  const origin = req.headers.origin;
  const corsAllowed = isApi && typeof origin === 'string' && corsOrigins.includes(origin);
  if (isApi) res.setHeader('Vary', 'Origin');
  if (corsAllowed) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Credentials', 'true');
  }
  if (isApi && method === 'OPTIONS') {
    // Preflight. Without an allowed origin there are no CORS headers, so the browser blocks the request.
    if (corsAllowed) {
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    return send(res, 204, {}, '');
  }

  const candidates = ROUTES.filter((r) => r.path === url.pathname);
  const route = candidates.find((r) => r.method === method);
  // Unmatched paths and methods keep the original bodies ({ error: ... }) so existing clients see no change.
  if (!route) {
    if (candidates.length === 0) return sendJson(ctx.res, 404, { error: 'Not found' });
    const methods = new Set(candidates.map((r) => r.method));
    if (methods.has('GET')) methods.add('HEAD');
    return sendJson(ctx.res, 405, { error: 'Method not allowed' }, { Allow: [...methods].sort().join(', ') });
  }

  if (method !== 'GET' && !sameOrigin(req, corsOrigins)) {
    return fail(ctx, 403, 'CROSS_SITE_REFUSED', 'Cross-site requests are refused.');
  }

  try {
    await route.handler(ctx);
  } catch (err) {
    await handleError(ctx, err);
  }
}

function createServer(options = {}) {
  const env = options.env || process.env;
  const auth = buildAuth(env, options);
  const corsOrigins = parseCorsOrigins(env.CORS_ALLOWED_ORIGINS);
  return http.createServer((req, res) => {
    dispatch(req, res, auth, corsOrigins).catch((err) => {
      console.error(`Unhandled error: ${err && err.name}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end();
    });
  });
}

if (require.main === module) {
  const auth = buildAuth(process.env);
  if (!auth.enabled) {
    console.warn(`Login is disabled. Missing configuration: ${auth.missing.join(', ')}`);
  }
  const port = Number(process.env.PORT) || 3000;
  const corsCount = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS).length;
  if (corsCount) console.log(`CORS allowed for ${corsCount} origin(s) on /api/`);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = { createServer, buildAuth, parseCorsOrigins };
