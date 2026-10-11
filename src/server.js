'use strict';

const fs = require('node:fs');
const http = require('node:http');
const { Readable } = require('node:stream');
const { AppError, ConflictError, StorageError } = require('./errors');
const { loadAuthConfig, loadFileConfig } = require('./config');
const { GitHubStorage } = require('./github-storage');
const { GitHubReleases } = require('./github-releases');
const { RateLimiter } = require('./rate-limit');
const { signup, login, loadUser, loadAccountRecord, sessionsValidAfter, revokeSessions, publicUser } = require('./accounts');
const { COOKIE_NAME, createSession, readSession, parseCookies, sessionCookie, clearSessionCookie } = require('./session');
const { FileService } = require('./files');
const { receiveUpload, removeFile } = require('./upload');
const { TYPES, ALLOWED_EXTENSIONS, CATEGORIES, sanitizeFilename, extensionOf, asciiFallback, encodeFilenameStar, contentMatches } = require('./file-types');
const pages = require('./pages');

const MAX_BODY_BYTES = 16 * 1024;
// Room for the multipart headers and the upload id on top of the file itself.
const UPLOAD_OVERHEAD_BYTES = 64 * 1024;
const UPLOADS_PER_HOUR = 60;
const UPLOAD_WINDOW_MS = 60 * 60 * 1000;

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

// Login needs three settings. File storage needs two more (see loadFileConfig). Without them the site still
// serves its public pages, and the routes that need them report which setting is missing (names only, never values).
function buildAuth(env, overrides = {}) {
  const loaded = loadAuthConfig(env);
  const now = overrides.now || Date.now;
  const storage = loaded.ok
    ? overrides.storage || new GitHubStorage({ token: loaded.config.githubToken, repo: loaded.config.repo })
    : null;
  const files = buildFiles(env, loaded.ok ? loaded.config : null, storage, now, overrides);
  if (!loaded.ok) return { enabled: false, missing: loaded.missing, files };
  return {
    enabled: true,
    config: loaded.config,
    now,
    storage,
    limiter: overrides.limiter || new RateLimiter(now),
    files,
  };
}

function buildFiles(env, authConfig, storage, now, overrides) {
  const loaded = loadFileConfig(env, { privateDataRepo: authConfig ? authConfig.repo : env.PRIVATE_DATA_REPO });
  if (!loaded.ok) return { enabled: false, missing: loaded.missing, service: null };
  if (!authConfig) return { enabled: false, missing: [], service: null };
  const releases =
    overrides.releases ||
    new GitHubReleases({
      token: authConfig.githubToken,
      repo: loaded.config.storageRepo,
      apiBase: overrides.githubApiBase,
      uploadBase: overrides.githubUploadBase,
    });
  const service = new FileService({ storage, releases, now, limits: overrides.limits });
  return { enabled: true, missing: [], service, storageRepo: loaded.config.storageRepo };
}

// Headers on every response. Downloads add their own on top.
function securityHeaders() {
  return {
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'DENY',
    // Not "no-referrer": Chromium sends "Origin: null" on form posts under that policy, and the origin
    // check refuses "null". "same-origin" keeps the Origin of same-site posts and sends no referrer cross-site.
    'Referrer-Policy': 'same-origin',
    'Cache-Control': 'no-store',
  };
}

function send(res, status, headers, body) {
  res.writeHead(status, { ...securityHeaders(), ...headers });
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

// File routes need login and the storage settings. Returns the file service.
function requireFileStorage(ctx) {
  requireConfigured(ctx);
  if (!ctx.auth.files.enabled) {
    const missing = ctx.auth.files.missing.length ? ctx.auth.files.missing.join(', ') : 'storage settings';
    throw new AppError(503, 'FILES_NOT_CONFIGURED', `File storage is not configured. Missing: ${missing}.`);
  }
  return ctx.auth.files.service;
}

// The session cookie is valid only if it is signed, unexpired, and issued after the last logout.
function currentSessionOf(ctx) {
  if (!ctx.auth.enabled) return null;
  const token = parseCookies(ctx.req.headers.cookie)[COOKIE_NAME];
  return readSession(ctx.auth.config.sessionSecret, token, ctx.auth.now());
}

async function currentUser(ctx) {
  const session = currentSessionOf(ctx);
  if (!session) return null;
  const record = await loadAccountRecord(ctx.auth.storage, session.uid);
  if (!record) return null;
  const validAfter = record.data.sessions_valid_after;
  if (typeof validAfter === 'number' && session.iat <= validAfter) return null;
  return publicUser(record.data);
}

async function requireUser(ctx) {
  const user = await currentUser(ctx);
  if (!user) throw new AppError(401, 'NOT_AUTHENTICATED', 'Sign in to continue.');
  return user;
}

// Mutating file routes must send this header. A cross-site page cannot add it without a CORS preflight,
// which the allowlist refuses. This is the CSRF check for the JSON and upload routes.
function requireCsrfHeader(ctx) {
  if (ctx.req.headers['x-requested-with'] !== 'fetch') {
    throw new AppError(403, 'CSRF_HEADER_REQUIRED', 'This request must include the X-Requested-With: fetch header.');
  }
}

// A new session's iat is always above the account's revocation floor. Otherwise a login in the same
// millisecond as a logout would be refused by its own check.
async function sessionHeader(ctx, user) {
  const { sessionSecret, sessionMs, cookieSecure } = ctx.auth.config;
  const floor = await sessionsValidAfter(ctx.auth.storage, user.id);
  const iat = Math.max(ctx.auth.now(), floor + 1);
  const token = createSession(sessionSecret, user.id, sessionMs, iat);
  return sessionCookie(token, { maxAgeSec: Math.floor(sessionMs / 1000), secure: cookieSecure });
}

// Logout ends the session on the server too, so a copied cookie stops working. The browser cookie is cleared
// either way. If the account write fails, the failure is logged and the cookie is still cleared.
async function endSession(ctx) {
  if (!ctx.auth.enabled) return;
  const session = currentSessionOf(ctx);
  if (!session) return;
  try {
    await revokeSessions(ctx.auth.storage, session.uid, ctx.auth.now());
  } catch (err) {
    console.error(`Logout could not revoke sessions: ${err && err.name}`);
  }
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
  const files = ctx.auth.files;
  sendHtml(
    ctx.res,
    200,
    pages.dashboardPage(user, {
      filesEnabled: files.enabled,
      maxBytes: files.enabled ? files.service.limits.maxFileBytes : 0,
      allowed: ALLOWED_EXTENSIONS,
    }),
  );
}

// ---- form posts (browser pages)

async function formLogin(ctx) {
  requireConfigured(ctx);
  const body = await readForm(ctx);
  const user = await login(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  redirect(ctx.res, '/dashboard', { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function formSignup(ctx) {
  requireConfigured(ctx);
  const body = await readForm(ctx);
  const user = await signup(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  redirect(ctx.res, '/dashboard', { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function formLogout(ctx) {
  await endSession(ctx);
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
  ok(ctx, 201, { user }, { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function apiLogin(ctx) {
  requireConfigured(ctx);
  const body = await readJsonBody(ctx);
  const user = await login(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  ok(ctx, 200, { user }, { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function apiLogout(ctx) {
  await endSession(ctx);
  ok(ctx, 200, {}, { 'Set-Cookie': logoutHeader(ctx) });
}

async function apiMe(ctx) {
  requireConfigured(ctx);
  ok(ctx, 200, { user: await currentUser(ctx) }, {});
}

// ---- file storage API

async function apiListFiles(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  const q = (ctx.url.searchParams.get('q') || '').slice(0, 100);
  const category = ctx.url.searchParams.get('category') || '';
  if (category && !CATEGORIES.includes(category)) {
    throw new AppError(400, 'INVALID_CATEGORY', `Category must be one of: ${CATEGORIES.join(', ')}.`);
  }
  ok(ctx, 200, await service.list(user.id, { q, category }));
}

// Global cap on uploads running at once. Each one holds a temp file on disk and a GitHub request open.
// Requests over the cap get 429 right away and are not queued.
async function apiUploadFile(ctx) {
  const service = requireFileStorage(ctx);
  if (service.inFlight >= service.limits.maxConcurrentUploads) {
    ctx.res.setHeader('Connection', 'close');
    throw new AppError(429, 'TOO_MANY_UPLOADS', 'The server is busy with other uploads. Try again shortly.');
  }
  service.inFlight += 1;
  try {
    await uploadFileInner(ctx, service);
  } finally {
    service.inFlight -= 1;
  }
}

async function uploadFileInner(ctx, service) {
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const { limits } = service;

  const type = String(ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'multipart/form-data') {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Send the file as multipart/form-data.');
  }
  // Refused before the body is read. Chunked uploads have no length here and are limited while streaming.
  const declared = ctx.req.headers['content-length'];
  if (declared !== undefined && Number(declared) > limits.maxFileBytes + UPLOAD_OVERHEAD_BYTES) {
    ctx.res.setHeader('Connection', 'close');
    throw new AppError(413, 'FILE_TOO_LARGE', `Files must be ${Math.floor(limits.maxFileBytes / 1024 / 1024)} MB or smaller.`);
  }

  const rateKey = `upload:${user.id}`;
  if (ctx.auth.limiter.count(rateKey, UPLOAD_WINDOW_MS) >= UPLOADS_PER_HOUR) {
    ctx.res.setHeader('Connection', 'close');
    throw new AppError(429, 'RATE_LIMITED', 'Too many uploads. Try again later.');
  }
  ctx.auth.limiter.record(rateKey);

  let received;
  try {
    received = await receiveUpload(ctx.req, { maxFileBytes: limits.maxFileBytes, tmpDir: service.tmpDir });
  } catch (err) {
    ctx.res.setHeader('Connection', 'close');
    throw err;
  }
  const tmp = received.file.path;
  try {
    const name = sanitizeFilename(received.file.filename);
    if (!name) throw new AppError(400, 'INVALID_FILENAME', 'Use a file name with letters or digits and an extension.');
    const ext = extensionOf(name);
    const spec = TYPES[ext];
    if (!spec) throw new AppError(415, 'UNSUPPORTED_FILE_TYPE', `Allowed types: ${ALLOWED_EXTENSIONS.join(', ')}.`);
    const { size } = await fs.promises.stat(tmp);
    if (size === 0) throw new AppError(400, 'EMPTY_FILE', 'The file is empty.');
    if (!(await contentMatches(spec, tmp))) {
      throw new AppError(415, 'FILE_CONTENT_MISMATCH', 'The file contents do not match its type.');
    }
    const result = await service.upload(user.id, {
      uploadId: received.fields.uploadId || '',
      tmpPath: tmp,
      size,
      name,
      spec,
      ext,
    });
    ok(ctx, result.duplicate ? 200 : 201, { file: result.file });
  } finally {
    await removeFile(tmp);
  }
}

// Content-Disposition is always attachment, so a stored file never renders in the browser.
function contentDisposition(name) {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeFilenameStar(name)}`;
}

async function apiDownloadFile(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  const { file, res: upstream } = await service.download(user.id, ctx.params.id);

  const length = upstream.headers.get('content-length');
  if (!upstream.body || (length !== null && Number(length) !== file.size)) {
    await upstream.body?.cancel?.().catch(() => {});
    throw new StorageError('The stored file did not match its record.');
  }
  if (ctx.req.method === 'HEAD') {
    await upstream.body.cancel().catch(() => {});
    ctx.res.writeHead(200, { ...securityHeaders(), 'Content-Type': file.type, 'Content-Length': String(file.size) });
    ctx.res.end();
    return;
  }
  ctx.res.writeHead(200, {
    ...securityHeaders(),
    'Content-Type': file.type,
    'Content-Length': String(file.size),
    'Content-Disposition': contentDisposition(file.name),
  });
  const body = Readable.fromWeb(upstream.body);
  body.on('error', () => ctx.res.destroy());
  ctx.res.on('close', () => body.destroy());
  body.pipe(ctx.res);
}

async function apiDeleteFile(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  ok(ctx, 200, await service.remove(user.id, ctx.params.id));
}

const FILE_ID = '([a-f0-9]{32})';

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
  { method: 'GET', path: '/api/files', handler: apiListFiles },
  { method: 'POST', path: '/api/files/upload', handler: apiUploadFile },
  { method: 'GET', pattern: new RegExp(`^/api/files/${FILE_ID}/download$`), handler: apiDownloadFile },
  { method: 'DELETE', pattern: new RegExp(`^/api/files/${FILE_ID}$`), handler: apiDeleteFile },
];

// Returns every route whose path matches, with any path parameters.
function matchRoutes(pathname) {
  const hits = [];
  for (const route of ROUTES) {
    if (route.path) {
      if (route.path === pathname) hits.push({ route, params: {} });
    } else {
      const m = route.pattern.exec(pathname);
      if (m) hits.push({ route, params: { id: m[1] } });
    }
  }
  return hits;
}

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
  const ctx = { req, res, url, auth, ip: clientIp(req, auth), params: {} };
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
      res.setHeader('Access-Control-Max-Age', '600');
    }
    return send(res, 204, {}, '');
  }

  const hits = matchRoutes(url.pathname);
  const hit = hits.find((h) => h.route.method === method);
  // Unmatched paths and methods keep the original bodies ({ error: ... }) so existing clients see no change.
  if (!hit) {
    if (hits.length === 0) return sendJson(ctx.res, 404, { error: 'Not found' });
    const methods = new Set(hits.map((h) => h.route.method));
    if (methods.has('GET')) methods.add('HEAD');
    return sendJson(ctx.res, 405, { error: 'Method not allowed' }, { Allow: [...methods].sort().join(', ') });
  }
  ctx.params = hit.params;

  if (method !== 'GET' && !sameOrigin(req, corsOrigins)) {
    return fail(ctx, 403, 'CROSS_SITE_REFUSED', 'Cross-site requests are refused.');
  }

  try {
    await hit.route.handler(ctx);
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
  if (!auth.files.enabled) {
    console.warn(`File storage is disabled. Missing configuration: ${auth.files.missing.join(', ') || 'login settings'}`);
  }
  const port = Number(process.env.PORT) || 3000;
  const corsCount = parseCorsOrigins(process.env.CORS_ALLOWED_ORIGINS).length;
  if (corsCount) console.log(`CORS allowed for ${corsCount} origin(s) on /api/`);
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = { createServer, buildAuth, parseCorsOrigins, matchRoutes };
