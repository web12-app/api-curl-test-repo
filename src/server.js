'use strict';

const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { Readable } = require('node:stream');
const { AppError, ConflictError, StorageError } = require('./errors');
const { loadAuthConfig, loadFileConfig, loadUploadSettings } = require('./config');
const { GitHubStorage } = require('./github-storage');
const { GitHubReleases } = require('./github-releases');
const { RateLimiter } = require('./rate-limit');
const { signup, login, loadUser, loadAccountRecord, sessionsValidAfter, revokeSessions, publicUser } = require('./accounts');
const { COOKIE_NAME, createSession, readSession, parseCookies, sessionCookie, clearSessionCookie } = require('./session');
const { FileService, SHARE_TOKEN_RE } = require('./files');
const { receiveUpload, removeFile } = require('./upload');
const { CATEGORIES, sanitizeFilename, extensionOf, asciiFallback, encodeFilenameStar, isPreviewable } = require('./file-types');
const { checkStoredFile } = require('./file-checks');
const { ChunkedUploads, SESSION_ID_RE } = require('./chunked-uploads');
const { ImportJobs } = require('./import-jobs');
const { TubeService } = require('./tube');
const { USERNAME_RE } = require('./paths');
const { ModelChat } = require('./model-chat');
const { ChatJobs } = require('./chat-jobs');
const pages = require('./pages');
const offlinePage = require('./offline-page');

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
  const settings = loadUploadSettings(env);
  if (!settings.ok) return { enabled: false, missing: settings.missing, service: null };
  const limits = { ...settings.limits, ...(overrides.limits || {}) };
  const tmpDir = overrides.tmpDir || settings.tempDir || undefined;
  const service = new FileService({ storage, releases, now, limits, tmpDir });
  const url = overrides.urlImport || {};
  return {
    enabled: true,
    missing: [],
    service,
    storageRepo: loaded.config.storageRepo,
    chunks: new ChunkedUploads({ service, now }),
    imports: new ImportJobs({
      service,
      now,
      lookup: url.lookup,
      transport: url.transport,
      timeouts: url.timeouts,
      limits: overrides.importLimits,
      allowPrivate: url.allowPrivate !== undefined ? url.allowPrivate === true : limits.importAllowPrivate === true,
    }),
    // Tube (channels + published videos) rides on the same data-repo storage and the file service.
    tube: new TubeService({ storage, files: service, now }),
  };
}

// The site chat: a real llama.cpp llama-server supervised in-process. Disabled
// unless LLAMA_SERVER_BIN + MODEL_GGUF_PATH are set (or CHAT_AUTOPROVISION=1
// asks the server to fetch both). Every failure lands in chat.status(); the
// rest of the site is never affected by the model runtime.
function buildModelChat(env, overrides = {}) {
  const chat = new ModelChat(env, { upstreamBase: overrides.upstreamBase });
  const jobs = new ChatJobs(chat, { now: overrides.now });
  return { chat, jobs };
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

function fail(ctx, status, code, message, headers = {}, details) {
  if (isApiPath(ctx)) {
    const error = details === undefined ? { code, message } : { code, message, details };
    return sendJson(ctx.res, status, { success: false, error }, headers);
  }
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

function readBody(req, limit = MAX_BODY_BYTES) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
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

// Chat bodies carry the conversation history, so they get a larger cap than
// the 16 KiB default. The client caps history before sending; this is the hard stop.
async function readChatJsonBody(ctx) {
  const raw = await readBody(ctx.req, 256 * 1024);
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

// Same checks, but returns the whole file bundle (service, chunked uploads, URL imports).
function fileServices(ctx) {
  requireFileStorage(ctx);
  return ctx.auth.files;
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

// The public welcome page. A signed-in visitor never sees it: they go straight to the app home page.
async function pageHome(ctx) {
  const user = await currentUser(ctx);
  if (user) return redirect(ctx.res, '/home');
  sendHtml(ctx.res, 200, pages.welcomePage());
}

function pageAuthForm(mode) {
  return (ctx) => {
    requireConfigured(ctx);
    const error = ctx.url.searchParams.get('error');
    sendHtml(ctx.res, 200, pages.authForm({ mode, error }));
  };
}

// The app shell CSP: styles are inline (server-rendered CSS), scripts only from this origin (the React
// bundle), and the bootstrap block is JSON data, not script. Everything else stays same-origin.
const APP_SHELL_CSP =
  "default-src 'self'; style-src 'unsafe-inline'; img-src 'self' data:; media-src 'self'; frame-src 'self'; connect-src 'self'; base-uri 'none'; form-action 'self'; object-src 'none'";

// The app home page: overview, stats, quick actions. No file list here - that lives on /explore.
async function pageAppHome(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  sendHtml(
    ctx.res,
    200,
    pages.appHomePage(user, { filesEnabled: ctx.auth.files.enabled, maxBytes: ctx.auth.files.enabled ? ctx.auth.files.service.limits.maxFileBytes : 0 }),
    { 'Content-Security-Policy': APP_SHELL_CSP },
  );
}

// The file explorer: uploads, the file list, and upload links.
async function pageExplore(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  const files = ctx.auth.files;
  sendHtml(
    ctx.res,
    200,
    pages.explorePage(user, {
      filesEnabled: files.enabled,
      maxBytes: files.enabled ? files.service.limits.maxFileBytes : 0,
      linkMaxFiles: files.enabled ? files.service.limits.linkMaxFiles : 0,
      linkMaxBytes: files.enabled ? files.service.limits.linkMaxBytes : 0,
    }),
    { 'Content-Security-Policy': APP_SHELL_CSP },
  );
}

// Old links keep working: the dashboard is now the app home page.
async function pageDashboard(ctx) {
  return redirect(ctx.res, '/home');
}

// ---- Tube pages. The same React shell as /home and /explore: styles, an empty root, and a JSON
// bootstrap block with the page data. Everything is behind login, like the rest of the app.

async function pageTube(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  const files = ctx.auth.files;
  const enabled = files.enabled;
  sendHtml(
    ctx.res,
    200,
    pages.tubeFeedPage({
      page: 'tube',
      user: { username: user.username },
      filesEnabled: enabled,
      channel: enabled ? await files.tube.getChannel(user) : null,
      feed: { videos: enabled ? await files.tube.feed() : [] },
    }),
    { 'Content-Security-Policy': APP_SHELL_CSP },
  );
}

// The watch screen. A video that is not published (or whose file is gone) is a plain 404 page.
async function pageTubeWatch(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  const files = ctx.auth.files;
  const view = files.enabled ? await files.tube.videoView(ctx.params.fileId) : null;
  if (!view) throw new AppError(404, 'NOT_FOUND', 'This video is not available.');
  sendHtml(
    ctx.res,
    200,
    pages.tubeWatchPage({
      page: 'tube-watch',
      user: { username: user.username },
      filesEnabled: files.enabled,
      video: view.video,
      channel: view.channel,
      myChannel: await files.tube.getChannel(user),
    }),
    { 'Content-Security-Policy': APP_SHELL_CSP },
  );
}

async function pageTubeChannel(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  const files = ctx.auth.files;
  const view = files.enabled ? await files.tube.channelPage(ctx.params.user) : null;
  if (!view) throw new AppError(404, 'NOT_FOUND', 'No such channel.');
  sendHtml(
    ctx.res,
    200,
    pages.tubeChannelPage({
      page: 'tube-channel',
      user: { username: user.username },
      filesEnabled: files.enabled,
      channel: view.channel,
      videos: view.videos,
      myChannel: await files.tube.getChannel(user),
    }),
    { 'Content-Security-Policy': APP_SHELL_CSP },
  );
}

// ---- form posts (browser pages)

async function formLogin(ctx) {
  requireConfigured(ctx);
  const body = await readForm(ctx);
  const user = await login(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  redirect(ctx.res, '/home', { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function formSignup(ctx) {
  requireConfigured(ctx);
  const body = await readForm(ctx);
  const user = await signup(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  redirect(ctx.res, '/home', { 'Set-Cookie': await sessionHeader(ctx, user) });
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
async function withUploadSlot(service, fn) {
  if (service.inFlight >= service.limits.maxConcurrentUploads) {
    throw new AppError(429, 'TOO_MANY_UPLOADS', 'The server is busy with other uploads. Try again shortly.');
  }
  service.inFlight += 1;
  try {
    return await fn();
  } finally {
    service.inFlight -= 1;
  }
}

async function apiUploadFile(ctx) {
  const service = requireFileStorage(ctx);
  await withUploadSlot(service, () => uploadFileInner(ctx, service));
}

async function uploadFileInner(ctx, service) {
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const result = await storeUpload(ctx, service, {
    uid: user.id,
    linkId: null,
    rateKey: `upload:${user.id}`,
    perHour: UPLOADS_PER_HOUR,
  });
  ok(ctx, result.duplicate ? 200 : 201, { file: result.file });
}

// Receives one multipart upload and stores it under uid. Used by the owner's upload and by an upload link.
// Any file type is accepted. Known types are checked against their signature. Unknown types are stored as
// application/octet-stream and only ever sent as attachments.
async function storeUpload(ctx, service, { uid, linkId, rateKey, perHour }) {
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

  if (ctx.auth.limiter.count(rateKey, UPLOAD_WINDOW_MS) >= perHour) {
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
    const { name, ext, spec, size } = await checkStoredFile(received.file.filename, tmp);
    return await service.upload(uid, {
      uploadId: received.fields.uploadId || '',
      tmpPath: tmp,
      size,
      name,
      spec,
      ext,
      linkId,
    });
  } finally {
    await removeFile(tmp);
  }
}

// The app pages run the React bundle from public/assets. Only plain file names are served, from one
// directory, so there is no path traversal. Cached briefly: a redeploy swaps the bundle and old pages
// fetch the new one within minutes.
const ASSETS_DIR = path.join(__dirname, '..', 'public', 'assets');
const ASSET_TYPES = {
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

async function serveAsset(ctx) {
  const ext = path.extname(ctx.params.name).toLowerCase();
  const type = ASSET_TYPES[ext];
  if (!type) throw new AppError(404, 'NOT_FOUND', 'Not found');
  let body;
  try {
    body = await fs.promises.readFile(path.join(ASSETS_DIR, ctx.params.name));
  } catch {
    throw new AppError(404, 'NOT_FOUND', 'Not found');
  }
  send(ctx.res, 200, { 'Content-Type': type, 'Content-Length': String(body.length), 'Cache-Control': 'public, max-age=300' }, body);
}

// ---- offline fallback. sw-register.js registers sw.js on every page; the worker precaches
// /offline.html and shows it when a page navigation fails or ngrok answers with its error page.
// All three are public (like /assets) and must never be cached, so a redeploy replaces them quickly.

const OFFLINE_HTML_HEADERS = {
  'Cache-Control': 'no-cache',
  // Inline script and style are required: the page is a single self-contained document.
  'Content-Security-Policy':
    "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:",
};

async function pageOfflineHtml(ctx) {
  sendHtml(ctx.res, 200, offlinePage.offlineHtml(), OFFLINE_HTML_HEADERS);
}

async function pageSwJs(ctx) {
  send(
    ctx.res,
    200,
    { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache', 'Service-Worker-Allowed': '/' },
    offlinePage.swJs(),
  );
}

async function pageSwRegisterJs(ctx) {
  send(
    ctx.res,
    200,
    { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-cache' },
    offlinePage.swRegisterJs(),
  );
}

// Content-Disposition is always attachment, so a stored file never renders in the browser.
function contentDisposition(name) {
  return `attachment; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeFilenameStar(name)}`;
}

// Streams one stored file to the response. The stored size is checked against the record first, so a mismatch
// is an error and not a truncated file. HEAD sends the headers only.
async function streamFile(ctx, { file, res: upstream }, { disposition, extra = {} }) {
  const length = upstream.headers.get('content-length');
  if (!upstream.body || (length !== null && Number(length) !== file.size)) {
    await upstream.body?.cancel?.().catch(() => {});
    throw new StorageError('The stored file did not match its record.');
  }
  const headers = { ...securityHeaders(), 'Content-Type': file.type, 'Content-Length': String(file.size), ...extra };
  if (disposition) headers['Content-Disposition'] = disposition;
  if (ctx.req.method === 'HEAD') {
    await upstream.body.cancel().catch(() => {});
    ctx.res.writeHead(200, headers);
    ctx.res.end();
    return;
  }
  ctx.res.writeHead(200, headers);
  const body = Readable.fromWeb(upstream.body);
  body.on('error', () => ctx.res.destroy());
  ctx.res.on('close', () => body.destroy());
  body.pipe(ctx.res);
}

// Inline display. Only previewable types reach here (see isPreviewable). The sandbox policy stops a previewed
// file from running script or reaching the page. The frame is same-origin only, so the dashboard can embed it.
// PDF needs the browser's built-in viewer, which the sandbox policy would block, so PDF gets a narrower policy.
// Video and audio get media-src 'self' so a browser tab (or an embed) may play them.
const MEDIA_PREVIEW_EXTS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.mp3', '.wav', '.ogg', '.m4a']);

function previewHeaders(name) {
  const ext = extensionOf(name);
  const pdf = ext === '.pdf';
  const media = MEDIA_PREVIEW_EXTS.has(ext);
  return {
    'X-Frame-Options': 'SAMEORIGIN',
    'Content-Security-Policy': pdf
      ? "default-src 'none'; object-src 'self'; frame-ancestors 'self'"
      : media
        ? "default-src 'none'; media-src 'self'; img-src 'self'; sandbox"
        : "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; sandbox",
  };
}

const previewDisposition = (name) => `inline; filename="${asciiFallback(name)}"; filename*=UTF-8''${encodeFilenameStar(name)}`;

// Resolves a fileId for a signed-in reader. The owner reads their own manifest entry as always. The
// Tube access rule extends this: a file that is published as a Tube video, or is in use as a channel
// logo, may be streamed by ANY signed-in user (read-only). Unpublished files keep the old rules.
async function entryForReader(files, user, fileId) {
  try {
    return { entry: await files.service.readReady(user.id, fileId), viaTube: false };
  } catch (err) {
    if (err instanceof AppError && err.status === 404 && files.tube) {
      const pub = await files.tube.resolvePublic(fileId);
      if (pub) return { entry: pub.entry, viaTube: true };
    }
    throw err;
  }
}

async function apiDownloadFile(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  const { entry } = await entryForReader(files, user, ctx.params.id);
  const opened = await files.service.openEntry(entry);
  await streamFile(ctx, opened, { disposition: contentDisposition(opened.file.name) });
}

async function apiPreviewFile(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  const { entry, viaTube } = await entryForReader(files, user, ctx.params.id);
  // A published Tube video may always be shown inline: its stored type is video/*, and the one
  // extension missing from the preview list (.mkv) is covered by the media preview headers.
  const publishedVideo = viaTube && String(entry.type).startsWith('video/');
  if (!isPreviewable(entry.name) && !publishedVideo) {
    throw new AppError(415, 'PREVIEW_NOT_AVAILABLE', 'This file type cannot be previewed. Download it instead.');
  }
  const opened = await files.service.openEntry(entry);
  await streamFile(ctx, opened, {
    disposition: previewDisposition(entry.name),
    extra: previewHeaders(entry.name),
  });
}

// Turns sharing on or off. The body must be {"public": true} or {"public": false}.
async function apiSetSharing(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  if (!body || typeof body.public !== 'boolean') {
    throw new AppError(400, 'INVALID_BODY', 'Send {"public": true} or {"public": false}.');
  }
  const { file } = await service.setSharing(user.id, ctx.params.id, body.public);
  ok(ctx, 200, { file });
}

// ---- chunked uploads. Large files are sent in numbered pieces with a checksum each. See chunked-uploads.js.

const CHUNK_REQUESTS_PER_HOUR = 6000; // per account: far above a 25 MB file in 256 KB pieces, with room for retries

// Refuses when the account has used up its hourly budget for a kind of request. `record` counts this request.
function hourlyLimit(ctx, key, perHour, message) {
  if (ctx.auth.limiter.count(key, UPLOAD_WINDOW_MS) >= perHour) {
    throw new AppError(429, 'RATE_LIMITED', message);
  }
  ctx.auth.limiter.record(key);
}

// Starts a chunked upload, or resumes the unfinished one with the same upload id (200), or reports a finished one.
async function apiInitUpload(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  // Counts as one upload, the same as a whole-file upload. Resuming an existing session does not count again.
  const { view, created } = await files.chunks.init(user.id, body, {
    checkLimit: () => {
      if (ctx.auth.limiter.count(`upload:${user.id}`, UPLOAD_WINDOW_MS) >= UPLOADS_PER_HOUR) {
        throw new AppError(429, 'RATE_LIMITED', 'Too many uploads. Try again later.');
      }
    },
    countStart: () => ctx.auth.limiter.record(`upload:${user.id}`),
  });
  ok(ctx, created ? 201 : 200, { session: view });
}

// Sends one piece. The body is the raw bytes of the piece, and X-Chunk-Sha256 is its SHA-256 in hex.
async function apiPutChunk(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  // Any refusal below happens before the body is read, so the connection is closed afterwards.
  ctx.res.setHeader('Connection', 'close');
  const declared = ctx.req.headers['content-length'];
  const contentLength = declared === undefined ? undefined : Number(declared);
  if (contentLength !== undefined && !Number.isSafeInteger(contentLength)) {
    throw new AppError(400, 'INVALID_CONTENT_LENGTH', 'The Content-Length header is not valid.');
  }
  hourlyLimit(ctx, `chunk:${user.id}`, CHUNK_REQUESTS_PER_HOUR, 'Too many pieces sent. Try again later.');
  const result = await withUploadSlot(files.service, () =>
    files.chunks.putChunk(user.id, ctx.params.sessionId, ctx.params.index, {
      source: ctx.req,
      contentLength,
      sha256: ctx.req.headers['x-chunk-sha256'],
    }),
  );
  ctx.res.removeHeader('Connection');
  ok(ctx, result.duplicate ? 200 : 201, { index: result.index, duplicate: result.duplicate });
}

async function apiUploadStatus(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { session: await files.chunks.status(user.id, ctx.params.sessionId) });
}

// Joins the pieces and stores the file. Missing pieces are listed in details.missing.
async function apiCompleteUpload(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const result = await withUploadSlot(files.service, () => files.chunks.complete(user.id, ctx.params.sessionId));
  ok(ctx, result.duplicate ? 200 : 201, { file: result.file });
}

async function apiCancelUpload(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  ok(ctx, 200, await files.chunks.cancel(user.id, ctx.params.sessionId));
}

// ---- upload from URL. A job runs in the background: POST starts it (202), GET reports it, DELETE cancels it.

const IMPORT_FINISHED = new Set(['completed', 'failed', 'cancelled']);

async function apiStartImport(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `import:${user.id}`, files.imports.limits.importsPerHour, 'Too many imports. Try again later.');
  const { job } = await files.imports.start(user.id, { url: body.url, uploadId: body.uploadId });
  const view = files.imports.view(user.id, job.uploadId);
  ok(ctx, IMPORT_FINISHED.has(view.state) ? 200 : 202, { import: view });
}

async function apiImportStatus(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { import: files.imports.get(user.id, ctx.params.uploadId) });
}

async function apiCancelImport(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  ok(ctx, 200, { import: files.imports.cancel(user.id, ctx.params.uploadId) });
}

// ---- public share links. No login. Anyone with the link can read the file it names, and nothing else.

const SHARE_WINDOW_MS = 15 * 60 * 1000;
const SHARE_REQUESTS_PER_WINDOW = 300; // per client address; the 256-bit token already makes guessing impractical

function shareRateLimit(ctx) {
  const key = `share:${ctx.ip}`;
  if (ctx.auth.limiter.count(key, SHARE_WINDOW_MS) >= SHARE_REQUESTS_PER_WINDOW) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
  }
  ctx.auth.limiter.record(key);
}

// script-src 'self' admits only the static sw-register.js, so the service worker is registered here too.
const SHARE_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src 'self'; frame-src 'self'; base-uri 'none'; form-action 'none'";

async function pageShare(ctx) {
  const service = requireFileStorage(ctx);
  shareRateLimit(ctx);
  const token = ctx.params.id;
  const found = await service.resolveShare(token);
  if (!found) throw new AppError(404, 'NOT_FOUND', 'This link is not available.');
  const e = found.entry;
  sendHtml(
    ctx.res,
    200,
    pages.sharePage({ name: e.name, size: e.size, type: e.type, previewable: isPreviewable(e.name) }, token),
    { 'Content-Security-Policy': SHARE_PAGE_CSP },
  );
}

async function shareDownload(ctx) {
  const service = requireFileStorage(ctx);
  shareRateLimit(ctx);
  const opened = await service.downloadShared(ctx.params.id);
  await streamFile(ctx, opened, { disposition: contentDisposition(opened.file.name) });
}

async function sharePreview(ctx) {
  const service = requireFileStorage(ctx);
  shareRateLimit(ctx);
  const found = await service.resolveShare(ctx.params.id);
  if (!found || !isPreviewable(found.entry.name)) {
    throw new AppError(404, 'NOT_FOUND', 'This link is not available.');
  }
  const opened = await service.openEntry(found.entry);
  await streamFile(ctx, opened, {
    disposition: previewDisposition(found.entry.name),
    extra: previewHeaders(found.entry.name),
  });
}

// ---- upload links. The owner creates a link. Anyone with the link can add one file at a time, with no login.

async function apiListUploadLinks(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { links: await service.listUploadLinks(user.id) });
}

async function apiCreateUploadLink(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = (await readJsonBody(ctx)) || {};
  if (typeof body.label !== 'undefined' && typeof body.label !== 'string') {
    throw new AppError(400, 'INVALID_LABEL', 'The label must be text.');
  }
  // Labels are shown to people who use the link. Control characters are removed and the length is capped.
  const label = (body.label || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 60);
  ok(ctx, 201, { link: await service.createUploadLink(user.id, label) });
}

async function apiRevokeUploadLink(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  ok(ctx, 200, { link: await service.revokeUploadLink(user.id, ctx.params.id) });
}

// ---- public upload page for a link. No login, no cookies. The link token is the credential.

const LINK_WINDOW_MS = 15 * 60 * 1000;
const LINK_REQUESTS_PER_WINDOW = 300; // per client address, for every /u/ request
const LINK_UPLOADS_PER_HOUR = 30; // per client address, for uploads through any link

function linkRateLimit(ctx) {
  const key = `link:${ctx.ip}`;
  if (ctx.auth.limiter.count(key, LINK_WINDOW_MS) >= LINK_REQUESTS_PER_WINDOW) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many requests. Try again later.');
  }
  ctx.auth.limiter.record(key);
}

// script-src 'self' admits only the static sw-register.js, so the service worker is registered here too.
const UPLOAD_PAGE_CSP = "default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'";

// A closed link (revoked, or never existed) answers 404 with no hint which.
async function openLinkOr404(ctx, service) {
  const open = await service.resolveUploadLink(ctx.params.id);
  if (!open) throw new AppError(404, 'NOT_FOUND', 'This upload link is not available.');
  return open;
}

async function pageUploadLink(ctx) {
  const service = requireFileStorage(ctx);
  linkRateLimit(ctx);
  const open = await openLinkOr404(ctx, service);
  sendHtml(
    ctx.res,
    200,
    pages.uploadPage({ label: open.link.label, token: ctx.params.id, maxBytes: service.limits.maxFileBytes }),
    { 'Content-Security-Policy': UPLOAD_PAGE_CSP },
  );
}

// Plain multipart form post. No script is needed. The token is the credential, so this route is exempt from
// the same-origin check that guards the other POST routes. It takes no cookies and is rate-limited per address.
async function postUploadLink(ctx) {
  const service = requireFileStorage(ctx);
  linkRateLimit(ctx);
  const open = await openLinkOr404(ctx, service);
  const result = await withUploadSlot(service, () =>
    storeUpload(ctx, service, {
      uid: open.uid,
      linkId: open.link.id,
      rateKey: `linkupload:${ctx.ip}`,
      perHour: LINK_UPLOADS_PER_HOUR,
    }),
  );
  sendHtml(
    ctx.res,
    200,
    pages.uploadDonePage({ name: result.file.name, token: ctx.params.id }),
    { 'Content-Security-Policy': UPLOAD_PAGE_CSP },
  );
}

async function apiDeleteFile(ctx) {
  const service = requireFileStorage(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  ok(ctx, 200, await service.remove(user.id, ctx.params.id));
}

// ---- Tube JSON API. Every route requires login; the writes add the same CSRF header check as the
// other mutating JSON routes, and a modest hourly cap, since each one rewrites the shared document.

const TUBE_WRITES_PER_HOUR = 120;

async function apiTubeFeed(ctx) {
  const files = fileServices(ctx);
  await requireUser(ctx);
  ok(ctx, 200, { videos: await files.tube.feed() });
}

async function apiTubeMyChannelGet(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { channel: await files.tube.getChannel(user) });
}

async function apiTubeMyChannelPut(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  ok(ctx, 200, { channel: await files.tube.putChannel(user, body) });
}

async function apiTubeChannelGet(ctx) {
  const files = fileServices(ctx);
  await requireUser(ctx);
  const view = await files.tube.channelPage(ctx.params.user);
  if (!view) throw new AppError(404, 'NOT_FOUND', 'No such channel.');
  ok(ctx, 200, view);
}

async function apiTubePublish(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const { video, created } = await files.tube.publishVideo(ctx.params.fileId, user, body);
  ok(ctx, created ? 201 : 200, { video });
}

async function apiTubeUnpublish(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  await files.tube.unpublishVideo(ctx.params.fileId, user);
  ok(ctx, 200, { ok: true });
}

// ---- Model chat API. Every route requires login. The model runs locally in a
// supervised llama-server; a chat POST creates a job, the client polls it, and
// DELETE cancels. Status never exposes more than model facts and state names.

// What the browser is allowed to see about the runtime. Internal paths, the
// port, PIDs, and log lines stay on the server.
function publicChatStatus(ctx) {
  const st = ctx.chat.chat.status();
  return {
    enabled: st.enabled,
    state: st.state,
    detail: st.detail,
    error: st.error,
    runtime_version: st.runtime_version,
    context: st.context,
    max_tokens: st.max_tokens,
    timeout_ms: st.timeout_ms,
    model: st.model
      ? {
          repo: st.model.repo,
          quant: st.model.quant,
          file: st.model.file,
          bytes: st.model.bytes,
          arch: st.model.arch,
          license: st.model.license,
          validated_live: st.model.validated_live,
        }
      : null,
  };
}

async function pageChat(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  sendHtml(
    ctx.res,
    200,
    pages.chatPage({ page: 'chat', user: { username: user.username }, chat: publicChatStatus(ctx) }),
    { 'Content-Security-Policy': APP_SHELL_CSP },
  );
}

async function apiChatStatus(ctx) {
  await requireUser(ctx);
  ok(ctx, 200, publicChatStatus(ctx));
}

async function apiChatSend(ctx) {
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readChatJsonBody(ctx);
  ctx.chat.jobs.cleanup();
  const view = ctx.chat.jobs.create(user, body);
  ok(ctx, 202, view);
}

async function apiChatJob(ctx) {
  const user = await requireUser(ctx);
  const view = ctx.chat.jobs.get(ctx.params.jobId, user);
  if (!view) throw new AppError(404, 'NOT_FOUND', 'No such chat job.');
  ok(ctx, 200, view);
}

async function apiChatCancel(ctx) {
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const view = ctx.chat.jobs.cancel(ctx.params.jobId, user);
  if (!view) throw new AppError(404, 'NOT_FOUND', 'No such chat job.');
  ok(ctx, 200, view);
}

const FILE_ID = '([a-f0-9]{32})';
const LINK_ID = '([a-f0-9]{32})';
const SESSION = `(${SESSION_ID_RE.source.slice(1, -1)})`;
const UUID = '([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})';
const TOKEN = SHARE_TOKEN_RE.source.slice(1, -1);

const ROUTES = [
  { method: 'GET', path: '/', handler: pageHome },
  { method: 'GET', path: '/home', handler: pageAppHome },
  { method: 'GET', path: '/explore', handler: pageExplore },
  { method: 'GET', pattern: /^\/assets\/([A-Za-z0-9][A-Za-z0-9._-]*)$/, handler: serveAsset, keys: ['name'] },
  { method: 'GET', path: '/offline.html', handler: pageOfflineHtml },
  { method: 'GET', path: '/sw.js', handler: pageSwJs },
  { method: 'GET', path: '/sw-register.js', handler: pageSwRegisterJs },
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
  { method: 'POST', path: '/api/uploads/init', handler: apiInitUpload },
  { method: 'GET', pattern: new RegExp(`^/api/uploads/${SESSION}$`), handler: apiUploadStatus, keys: ['sessionId'] },
  { method: 'DELETE', pattern: new RegExp(`^/api/uploads/${SESSION}$`), handler: apiCancelUpload, keys: ['sessionId'] },
  { method: 'POST', pattern: new RegExp(`^/api/uploads/${SESSION}/complete$`), handler: apiCompleteUpload, keys: ['sessionId'] },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/uploads/${SESSION}/chunks/([^/]{1,12})$`),
    handler: apiPutChunk,
    keys: ['sessionId', 'index'],
  },
  { method: 'POST', path: '/api/files/upload-from-url', handler: apiStartImport },
  { method: 'GET', pattern: new RegExp(`^/api/files/upload-from-url/${UUID}$`), handler: apiImportStatus, keys: ['uploadId'] },
  { method: 'DELETE', pattern: new RegExp(`^/api/files/upload-from-url/${UUID}$`), handler: apiCancelImport, keys: ['uploadId'] },
  { method: 'GET', pattern: new RegExp(`^/api/files/${FILE_ID}/download$`), handler: apiDownloadFile },
  { method: 'DELETE', pattern: new RegExp(`^/api/files/${FILE_ID}$`), handler: apiDeleteFile },
  { method: 'GET', pattern: new RegExp(`^/api/files/${FILE_ID}/preview$`), handler: apiPreviewFile },
  { method: 'PUT', pattern: new RegExp(`^/api/files/${FILE_ID}/sharing$`), handler: apiSetSharing },
  { method: 'GET', pattern: new RegExp(`^/s/(${TOKEN})$`), handler: pageShare },
  { method: 'GET', pattern: new RegExp(`^/s/(${TOKEN})/download$`), handler: shareDownload },
  { method: 'GET', pattern: new RegExp(`^/s/(${TOKEN})/preview$`), handler: sharePreview },
  { method: 'GET', path: '/api/upload-links', handler: apiListUploadLinks },
  { method: 'POST', path: '/api/upload-links', handler: apiCreateUploadLink },
  { method: 'DELETE', pattern: new RegExp(`^/api/upload-links/${LINK_ID}$`), handler: apiRevokeUploadLink },
  { method: 'GET', pattern: new RegExp(`^/u/(${TOKEN})$`), handler: pageUploadLink },
  { method: 'POST', pattern: new RegExp(`^/u/(${TOKEN})/upload$`), handler: postUploadLink, csrfExempt: true },
  // ---- Tube: channels and published videos. All behind login, like the rest of the app.
  { method: 'GET', path: '/api/tube/feed', handler: apiTubeFeed },
  { method: 'GET', path: '/api/tube/my-channel', handler: apiTubeMyChannelGet },
  { method: 'PUT', path: '/api/tube/my-channel', handler: apiTubeMyChannelPut },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/tube/channels/(${USERNAME_RE.source.slice(1, -1)})$`),
    handler: apiTubeChannelGet,
    keys: ['user'],
  },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/publish$`), handler: apiTubePublish, keys: ['fileId'] },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/unpublish$`), handler: apiTubeUnpublish, keys: ['fileId'] },
  { method: 'GET', path: '/tube', handler: pageTube },
  { method: 'GET', pattern: new RegExp(`^/tube/watch/${FILE_ID}$`), handler: pageTubeWatch, keys: ['fileId'] },
  {
    method: 'GET',
    pattern: new RegExp(`^/tube/channel/(${USERNAME_RE.source.slice(1, -1)})$`),
    handler: pageTubeChannel,
    keys: ['user'],
  },
  // ---- Model chat: page and JSON API. All behind login, like the rest of the app.
  { method: 'GET', path: '/chat', handler: pageChat },
  { method: 'GET', path: '/api/chat/status', handler: apiChatStatus },
  { method: 'POST', path: '/api/chat', handler: apiChatSend },
  { method: 'GET', pattern: new RegExp(`^/api/chat/jobs/${UUID}$`), handler: apiChatJob, keys: ['jobId'] },
  { method: 'DELETE', pattern: new RegExp(`^/api/chat/jobs/${UUID}$`), handler: apiChatCancel, keys: ['jobId'] },
];

// Returns every route whose path matches, with any path parameters.
function matchRoutes(pathname) {
  const hits = [];
  for (const route of ROUTES) {
    if (route.path) {
      if (route.path === pathname) hits.push({ route, params: {} });
    } else {
      const m = route.pattern.exec(pathname);
      if (m) {
        const keys = route.keys || ['id'];
        hits.push({ route, params: Object.fromEntries(keys.map((k, i) => [k, m[i + 1]])) });
      }
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
    return fail(ctx, err.status, err.code, err.message, headers, err.details);
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

async function dispatch(req, res, auth, corsOrigins, modelChat) {
  const url = new URL(req.url || '/', 'http://localhost');
  const ctx = { req, res, url, auth, chat: modelChat, ip: clientIp(req, auth), params: {} };
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
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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

  // csrfExempt routes are protected by their own credential (the link token), so the same-origin check does not apply.
  if (method !== 'GET' && !hit.route.csrfExempt && !sameOrigin(req, corsOrigins)) {
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
  const modelChat = buildModelChat(env, options);
  const server = http.createServer((req, res) => {
    dispatch(req, res, auth, corsOrigins, modelChat).catch((err) => {
      console.error(`Unhandled error: ${err && err.name}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end();
    });
  });
  // Tests use this to run the cleanup sweep directly. Nothing in the app reads it.
  server.fileServices = auth.files;
  // Tests use these to drive the chat with a stubbed upstream.
  server.modelChat = modelChat.chat;
  server.chatJobs = modelChat.jobs;
  if (modelChat.chat.enabled) {
    console.log('Model chat: enabled. Starting the llama.cpp runtime in the background.');
    modelChat.chat.start();
  }
  server.on('close', () => modelChat.chat.stop());
  return server;
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
  const server = createServer().listen(port, '0.0.0.0', () => {
    console.log(`Listening on port ${port}`);
  });
  // Make sure the supervised llama-server does not outlive this process.
  const shutdown = () => {
    try { server.modelChat.stop(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = { createServer, buildAuth, parseCorsOrigins, matchRoutes };
