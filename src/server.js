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
const { ModelCache } = require('./model-cache');
const search = require('./search');
const { OpenAiCompat, sendV1Error, sendV1Json } = require('./openai-compat');
const apiTokens = require('./api-tokens');
const { PipsDb } = require('./pipsdb');
const { Devices } = require('./devices');
const { Social } = require('./social');
const appRelease = require('./app-release');
const { Tunnels, randomName } = require('./tunnel');
const { TunnelStore } = require('./tunnel-store');
const { clientBundle } = require('./tunnel-package');
const { installScript } = require('./tunnel-install');
const tunnelDocs = require('./tunnel-docs');
const appDocs = require('./app-docs');
const pages = require('./pages');
const offlinePage = require('./offline-page');

const MAX_BODY_BYTES = 16 * 1024;
// Tunnel proxy bodies: uploads posted through /tun/<name> need far more than
// the API default. The respond endpoint accepts base64 (4/3 overhead) of that.
const TUNNEL_PROXY_BODY_LIMIT = 10 * 1024 * 1024;
const TUNNEL_RESPOND_BODY_LIMIT = 25 * 1024 * 1024;
// Headers the tunnel strips in both directions: hop-by-hop plus framing that
// the two HTTP legs of the tunnel must re-derive themselves.
const TUNNEL_STRIPPED_HEADERS = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'content-length', 'accept-encoding', 'content-encoding',
]);
const TUNNEL_PROXY_PATTERN = '^/tun/([a-z0-9][a-z0-9_-]{0,31})(/.*)?$';
const TUNNEL_REGISTER_WINDOW_MS = 60 * 1000; // per-IP budget window for register/account

function positiveInt(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
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
    // Pips app companions: per-user notes DB, device registry, social layer.
    pips: new PipsDb({ storage, now }),
    devices: new Devices({ storage, now }),
    social: new Social({ storage, files: service, now }),
  };
}

// The site chat: a real llama.cpp llama-server supervised in-process. Disabled
// unless LLAMA_SERVER_BIN + MODEL_GGUF_PATH are set (or CHAT_AUTOPROVISION=1
// asks the server to fetch both). Every failure lands in chat.status(); the
// rest of the site is never affected by the model runtime.
function buildModelChat(env, overrides = {}) {
  const cache = overrides.modelCache !== undefined ? overrides.modelCache : buildModelCache(env, overrides);
  const chat = new ModelChat(env, { upstreamBase: overrides.upstreamBase, cache });
  const jobs = new ChatJobs(chat, { now: overrides.now });
  // OpenAI-compatible /v1 endpoints: local llama.cpp runtime by default,
  // or a transparent proxy when AI_BASE_URL points at an external provider.
  const v1 = new OpenAiCompat({
    chat,
    upstreamBase: overrides.aiBaseUrl !== undefined ? overrides.aiBaseUrl : env.AI_BASE_URL,
    upstreamApiKey: env.AI_API_KEY,
    upstreamModelsPath: env.AI_MODELS_PATH,
    apiKey: env.V1_API_KEY,
    maxConcurrent: Number.isInteger(Number(env.AI_MAX_CONCURRENT)) && Number(env.AI_MAX_CONCURRENT) >= 1
      ? Number(env.AI_MAX_CONCURRENT)
      : 2,
    now: overrides.now,
    fetchImpl: overrides.aiFetch,
  });
  return { chat, jobs, v1 };
}

// The release cache for chat models: every downloaded model is saved once as
// release assets in the private data repository (tag model-cache/<id>), and
// later starts restore it from there instead of re-downloading ~10 GiB from
// the Hugging Face CDN. Active whenever the data-repo credentials exist;
// MODEL_CACHE=off turns it off. Cache problems degrade to the normal download.
function buildModelCache(env, overrides = {}) {
  if (!env.GITHUB_TOKEN || !env.PRIVATE_DATA_REPO || env.MODEL_CACHE === 'off') return null;
  const releases = overrides.modelCacheReleases || new GitHubReleases({
    token: env.GITHUB_TOKEN,
    repo: env.PRIVATE_DATA_REPO,
    apiBase: overrides.githubApiBase,
    uploadBase: overrides.githubUploadBase,
  });
  return new ModelCache({ releases, log: (line) => console.log(`[model-cache] ${line}`) });
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

// Optional JSON body: {} when the client sends nothing (or not JSON).
async function readOptionalJson(ctx) {
  const type = (ctx.req.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
  if (type !== 'application/json') return {};
  return parseJson(await readBody(ctx.req));
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

// API tokens (Authorization: Bearer sat_...) identify the same accounts as
// session cookies, and their access is scoped to exactly their own user.
async function currentUser(ctx) {
  if (!ctx.auth.enabled) return null;
  const bearer = apiTokens.fromHeader(ctx.req.headers.authorization);
  if (bearer) {
    ctx.authVia = 'api-token';
    const resolved = await apiTokens.resolveToken(ctx.auth.storage, bearer);
    if (!resolved) return null;
    return loadUser(ctx.auth.storage, resolved.userId);
  }
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
  // A Bearer API token is not a cookie: a cross-site page cannot attach one to a
  // form post, so the browser-only CSRF header check does not apply to it.
  if (apiTokens.isBearerHeader(ctx.req.headers.authorization)) return;
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

// ---- Pips Android install page (/app). Public on purpose: phone users land here straight from a
// shared link, signed in or not. The download target is the latest published APK from GitHub;
// app-release.latestRelease never throws, so the page renders even when GitHub is unreachable.
const INSTALL_PAGE_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

// Overridable for tests (the fake GitHub API in test suites runs on localhost).
let releaseApiBase = 'https://api.github.com';

async function pageAppInstall(ctx) {
  const info = await appRelease.latestRelease({ apiBase: releaseApiBase });
  sendHtml(ctx.res, 200, pages.appInstallPage(info), { 'Content-Security-Policy': INSTALL_PAGE_CSP });
}

// Old shared links keep working: /install is an alias of /app.
async function pageInstallAlias(ctx) {
  return redirect(ctx.res, '/app');
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

// Live status for the home page. createServer fills this in from the environment. PUBLIC_URL and
// LIVE_RUN_ID are set by the live-tunnel workflow; locally both are absent.
let liveStatusInfo = { publicUrl: null, runId: null, startedAt: new Date() };

function liveStatusFromEnv(env) {
  const raw = String(env.PUBLIC_URL || '').trim();
  const publicUrl = /^https:\/\/[A-Za-z0-9.-]+(:[0-9]+)?$/.test(raw) ? raw : null;
  const runId = String(env.LIVE_RUN_ID || '').replace(/[^0-9]/g, '') || null;
  return { publicUrl, runId, startedAt: new Date() };
}

// Public and read-only: the URL, run number, start time, and uptime. No account or secret data.
async function apiLiveStatus(ctx) {
  const now = Date.now();
  const info = liveStatusInfo;
  sendJson(ctx.res, 200, {
    status: 'live',
    url: info.publicUrl,
    runId: info.runId,
    startedAt: info.startedAt.toISOString(),
    uptimeSeconds: Math.floor((now - info.startedAt.getTime()) / 1000),
    checkedAt: new Date(now).toISOString(),
  });
}

// Every signup and login also mints a unique API token. It is shown once and
// stored only as a SHA-256 hash; API clients send it as `Authorization: Bearer <token>`.
async function apiSignup(ctx) {
  requireConfigured(ctx);
  const body = await readJsonBody(ctx);
  const user = await signup(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  const api_token = await apiTokens.issueToken(ctx.auth.storage, user.id, ctx.auth.now());
  ok(ctx, 201, { user, api_token }, { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function apiLogin(ctx) {
  requireConfigured(ctx);
  const body = await readJsonBody(ctx);
  const user = await login(ctx.auth, { username: body.username, password: body.password, ip: ctx.ip });
  const api_token = await apiTokens.issueToken(ctx.auth.storage, user.id, ctx.auth.now());
  ok(ctx, 200, { user, api_token }, { 'Set-Cookie': await sessionHeader(ctx, user) });
}

async function apiLogout(ctx) {
  // A Bearer logout revokes exactly that API token. A cookie logout ends the
  // browser sessions and leaves API tokens valid until revoked themselves.
  let api_token_revoked = false;
  const bearer = apiTokens.fromHeader(ctx.req.headers.authorization);
  if (bearer && ctx.auth.enabled && apiTokens.isApiToken(bearer)) {
    api_token_revoked = await apiTokens.revokeByRaw(ctx.auth.storage, bearer, ctx.auth.now());
  }
  await endSession(ctx);
  ok(ctx, 200, { api_token_revoked }, { 'Set-Cookie': logoutHeader(ctx) });
}

async function apiMe(ctx) {
  requireConfigured(ctx);
  ok(ctx, 200, { user: await currentUser(ctx) }, {});
}

// ---- API token management (Bearer credentials for non-browser clients)

async function apiListTokens(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  const tokens = await apiTokens.listTokens(ctx.auth.storage, user.id);
  const bearer = apiTokens.fromHeader(ctx.req.headers.authorization);
  let current = null;
  if (bearer) {
    const resolved = await apiTokens.resolveToken(ctx.auth.storage, bearer);
    current = resolved ? resolved.tokenId : null;
  }
  ok(ctx, 200, { tokens, current });
}

async function apiCreateToken(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  const limitKey = `api-token:${user.id}`;
  if (ctx.auth.limiter.count(limitKey, 60 * 60 * 1000) >= 20) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many API tokens created. Try again later.');
  }
  ctx.auth.limiter.record(limitKey);
  const body = await readOptionalJson(ctx);
  ok(ctx, 201, { api_token: await apiTokens.issueToken(ctx.auth.storage, user.id, ctx.auth.now(), body.name) });
}

async function apiRevokeToken(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  const revoked = await apiTokens.revokeById(ctx.auth.storage, user.id, ctx.params.id, ctx.auth.now());
  if (!revoked) throw new AppError(404, 'TOKEN_NOT_FOUND', 'No such API token.');
  ok(ctx, 200, { revoked: true });
}

// ---- File detail + rename (pips-flutter file views)

async function apiFileGet(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, await files.service.get(user.id, ctx.params.id));
}

async function apiFilePatch(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  if (!body || typeof body.name !== 'string') {
    throw new AppError(400, 'INVALID_BODY', 'Send {"name": "new-name"}.');
  }
  ok(ctx, 200, await files.service.rename(user.id, ctx.params.id, body.name));
}

// ---- Pips DB: per-user text documents (the pips-flutter DB screen)

function pipsDb(ctx) {
  requireFileStorage(ctx);
  return ctx.auth.files.pips;
}

async function apiPipsDbList(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { files: await db.list(user.id) });
}

async function apiPipsDbCreate(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 201, { file: await db.create(user.id, { name: body.name, content: body.content }) });
}

async function apiPipsDbRead(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  const f = await db.read(user.id, ctx.params.id);
  ok(ctx, 200, { file: { id: f.id, name: f.name, version: f.version, updated_at: f.updated_at }, content: f.content });
}

async function apiPipsDbWrite(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, { file: await db.write(user.id, ctx.params.id, body.content) });
}

async function apiPipsDbEditLine(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, { file: await db.editLine(user.id, ctx.params.id, { line: body.line, action: body.action, text: body.text }) });
}

async function apiPipsDbMove(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, { file: await db.move(user.id, ctx.params.id, body.name) });
}

async function apiPipsDbRemove(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  ok(ctx, 200, await db.remove(user.id, ctx.params.id));
}

async function apiPipsDbRestore(ctx) {
  const db = pipsDb(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, { file: await db.restore(user.id, ctx.params.id, body.version) });
}

// ---- Devices: which phones reach the account (pips-flutter profile)

function devicesOf(ctx) {
  requireFileStorage(ctx);
  return ctx.auth.files.devices;
}

async function apiDevicesHeartbeat(ctx) {
  const devices = devicesOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, { device: await devices.heartbeat(user.id, { id: body.id, name: body.name, platform: body.platform }) });
}

async function apiDevicesList(ctx) {
  const devices = devicesOf(ctx);
  const user = await requireUser(ctx);
  const current = String(ctx.req.headers['x-device-id'] || '');
  ok(ctx, 200, { devices: await devices.list(user.id, current) });
}

async function apiDevicesRemove(ctx) {
  const devices = devicesOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const removed = await devices.remove(user.id, ctx.params.id);
  if (!removed) throw new AppError(404, 'DEVICE_NOT_FOUND', 'No such device.');
  ok(ctx, 200, { removed });
}

// ---- Social: follows, direct messages, notifications, avatars

function socialOf(ctx) {
  requireFileStorage(ctx);
  return ctx.auth.files.social;
}

async function apiSocialUsers(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  const q = (ctx.url.searchParams.get('q') || '').slice(0, 60);
  ok(ctx, 200, { users: await social.users(q, user.username) });
}

async function apiSocialFollow(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, await social.follow(user.id, user.username, body.username));
}

async function apiSocialUnfollow(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, await social.unfollow(user.id, user.username, body.username));
}

async function apiSocialInbox(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { threads: await social.inbox(user.id, user.username) });
}

async function apiSocialThread(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { messages: await social.thread(user.id, user.username, ctx.params.user) });
}

async function apiSocialSend(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  const message = await social.send(user.id, user.username, body.to, { text: body.text, fileId: body.fileId });
  ok(ctx, 201, { message });
}

async function apiSocialLike(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, await social.like(user.id, user.username, body.peer, body.messageId));
}

async function apiSocialNotifications(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { items: await social.notifications(user.id) });
}

async function apiSocialNotificationsRead(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readOptionalJson(ctx);
  ok(ctx, 200, await social.notificationsRead(user.id, body.id));
}

async function apiSocialAvatarPut(ctx) {
  const social = socialOf(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  if (!body || typeof body.fileId !== 'string' || !body.fileId) {
    throw new AppError(400, 'INVALID_BODY', 'Send {"fileId": "<id>"} of an uploaded picture.');
  }
  ok(ctx, 200, await social.setAvatar(user.id, body.fileId));
}

// Avatars are read by other users' apps, so this one route stays login-free.
async function apiSocialAvatarGet(ctx) {
  const social = socialOf(ctx);
  ok(ctx, 200, { url: await social.avatarUrl(ctx.params.user) });
}

async function apiSocialReport(ctx) {
  const social = socialOf(ctx);
  await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  ok(ctx, 200, await social.report(body.message || body.text || ''));
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
  '.png': 'image/png',
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
    // DM attachments and avatars: the grants doc names the owner and the readers.
    if (err instanceof AppError && err.status === 404) {
      const granted = await files.service.resolveGrant(fileId, user.username);
      if (granted) return { entry: granted, viaTube: false };
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

// ---- Search: videos, channels and files; suggestions; an AI answer that cites the results.
const AI_PER_HOUR = 30;
const AI_WINDOW_MS = 60 * 60 * 1000;

async function apiSearch(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  const q = ctx.url.searchParams.get('q') || '';
  const kind = ctx.url.searchParams.get('kind') || 'all';
  ok(ctx, 200, await search.run({ tube: files.tube, files: files.service, uid: user.id, username: user.username, q, kind }));
}

async function apiSearchSuggest(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  const q = ctx.url.searchParams.get('q') || '';
  ok(ctx, 200, await search.suggest({ tube: files.tube, files: files.service, uid: user.id, username: user.username, q }));
}

async function apiSearchAi(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  const q = String(body.q || '').trim();
  if (ctx.auth.limiter.count(`ai:${user.id}`, AI_WINDOW_MS) > AI_PER_HOUR) {
    throw new AppError(429, 'AI_RATE_LIMITED', 'Too many AI questions this hour. Try again later.');
  }
  const results = await search.run({
    tube: files.tube, files: files.service, uid: user.id, username: user.username, q, kind: 'all', limit: 8,
  });
  ok(ctx, 200, await search.answer({ query: q, results }));
}

async function apiTubeFeed(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { videos: await files.tube.feed(user.username) });
}

async function apiTubeMyChannelGet(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { channel: await files.tube.getChannel(user, user.username) });
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
  const user = await requireUser(ctx);
  const view = await files.tube.channelPage(ctx.params.user, user.username);
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

// Text-only posts: same publish contract without a file id (a synthetic id is assigned).
async function apiTubePostCreate(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const { video, created } = await files.tube.publishVideo('', user, { ...body, kind: 'post' });
  ok(ctx, created ? 201 : 200, { video });
}

// Owner-only edit of a published item (title, description, thumbnail, duration).
async function apiTubeVideoPatch(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const { video } = await files.tube.patchVideo(ctx.params.fileId, user, body);
  ok(ctx, 200, { video });
}

// Deletes the signed-in user's own channel along with its published items.
async function apiTubeMyChannelDelete(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const removed = await files.tube.deleteChannel(user);
  if (!removed) throw new AppError(404, 'NOT_FOUND', 'No such channel.');
  ok(ctx, 200, { ok: true });
}

// Records a unique view (one per user per item). Like the other tube writes it rewrites the shared
// document, so the same CSRF and hourly-cap rules apply.
async function apiTubeView(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const { views } = await files.tube.recordView(ctx.params.fileId, user.username);
  ok(ctx, 200, { views });
}

// Like / dislike a published item; same vote again toggles off.
async function apiTubeVote(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const vote = typeof body.vote === 'string' ? body.vote : '';
  ok(ctx, 200, await files.tube.voteVideo(ctx.params.fileId, vote, user.username));
}

async function apiTubeCommentsList(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { comments: await files.tube.listComments(ctx.params.fileId, user.username) });
}

async function apiTubeCommentsAdd(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const { comment } = await files.tube.addComment(ctx.params.fileId, user.username, body ? body.text : undefined);
  ok(ctx, 201, { comment });
}

async function apiTubeCommentVote(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readJsonBody(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  const vote = typeof body.vote === 'string' ? body.vote : '';
  ok(ctx, 200, await files.tube.voteComment(ctx.params.fileId, ctx.params.commentId, vote, user.username));
}

// Toggles a subscription to the channel owned by :user.
async function apiTubeSubscribe(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  hourlyLimit(ctx, `tube-write:${user.id}`, TUBE_WRITES_PER_HOUR, 'Too many Tube changes. Try again later.');
  ok(ctx, 200, { ok: true, ...(await files.tube.subscribeChannel(ctx.params.user, user.username)) });
}

// The signed-in user's watch history, newest view first.
async function apiTubeHistory(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  ok(ctx, 200, { videos: await files.tube.historyFor(user.username) });
}

// The owner's per-item viewer list, newest first.
async function apiTubeViewers(ctx) {
  const files = fileServices(ctx);
  const user = await requireUser(ctx);
  const viewers = await files.tube.viewList(ctx.params.fileId, user);
  ok(ctx, 200, { views: viewers });
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
    loaded_model: st.loaded_model || null,
    default_model: st.default_model || null,
    // The verified model registry the chat can load, one at a time.
    models: Array.isArray(st.models)
      ? st.models.map((m) => ({
          id: m.id,
          label: m.label,
          repo: m.repo,
          quant: m.quant,
          bytes: m.bytes,
          arch: m.arch,
          license: m.license,
        }))
      : [],
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
    // Model release cache (one-time download, fast auto-load later).
    cache: {
      enabled: Boolean(st.cache && st.cache.enabled),
      publishing: st.cache && Array.isArray(st.cache.publishing) ? st.cache.publishing : [],
    },
    // Last runtime lines (provisioning, llama-server boot). No secrets are logged.
    log_tail: Array.isArray(st.log_tail) ? st.log_tail : [],
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

// ---- OpenAI-compatible /v1 (no session; optional V1_API_KEY bearer auth)

async function apiV1Models(ctx) {
  if (!ctx.chat.v1.authorize(ctx.req)) {
    return sendV1Json(ctx.res, 401, OpenAiCompat.errorBody('invalid api key.', 'auth_error', 'INVALID_API_KEY'));
  }
  try {
    sendV1Json(ctx.res, 200, await ctx.chat.v1.listModels());
  } catch (err) {
    sendV1Error(ctx.res, err);
  }
}

async function apiV1ChatCompletions(ctx) {
  if (!ctx.chat.v1.authorize(ctx.req)) {
    return sendV1Json(ctx.res, 401, OpenAiCompat.errorBody('invalid api key.', 'auth_error', 'INVALID_API_KEY'));
  }
  let body;
  try {
    body = await readChatJsonBody(ctx);
  } catch (err) {
    return sendV1Error(ctx.res, err);
  }
  try {
    await ctx.chat.v1.chatCompletions(ctx.req, ctx.res, body);
  } catch (err) {
    if (!ctx.res.headersSent) sendV1Error(ctx.res, err);
    else ctx.res.end();
  }
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

// ---- Pips Tunnel: publish a localhost app under /tun/<name>.
// The client (tunnel-client/, shipped as tunnel.tar.gz) registers a name,
// long-polls for forwarded requests, calls http://localhost:<port>, and posts
// responses back. register/respond/close are csrfExempt: the caller is a CLI
// on another machine, not a browser session on this site.

// G8: optional register enrichment — which local port/proto the client
// forwards to. Parsed once here, stored on the live tunnel record, shown in
// the list() rows.
function parseTunnelPort(value) {
  if (value === undefined || value === null || value === '') return null;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 65535) {
    throw new AppError(400, 'INVALID_PORT', 'port must be an integer from 1 to 65535.');
  }
  return n;
}

function parseTunnelProto(value) {
  if (value === undefined || value === null || value === '') return 1;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1 || n > 9) {
    throw new AppError(400, 'INVALID_PROTO', 'proto must be an integer from 1 to 9.');
  }
  return n;
}

// G9: per-IP budget shared by the tunnel registration surfaces (register +
// account). The default of 240/min is generous enough that normal CLI use
// never trips it; TUNNEL_REGISTER_RATE tightens it. The limiter is created in
// createServer and hangs off the Tunnels instance.
function checkTunnelRate(ctx) {
  const limiter = ctx.tunnel.registerLimiter;
  if (!limiter) return;
  const key = `tunreg:${ctx.ip}`;
  if (limiter.count(key, TUNNEL_REGISTER_WINDOW_MS) >= ctx.tunnel.registerRate) {
    throw new AppError(429, 'RATE_LIMITED', 'Too many tunnel registrations from this address; try again in a minute.');
  }
  limiter.record(key);
}

async function apiTunnelRegister(ctx) {
  const body = await readJsonBody(ctx);
  checkTunnelRate(ctx);
  await ctx.tunnel.store.load();
  const port = parseTunnelPort(body ? body.port : undefined);
  const proto = parseTunnelProto(body ? body.proto : undefined);
  // Refresh the reserved-name map from the persisted store (a cheap Map
  // rebuild) so claims survive restarts and are correct on the first register.
  ctx.tunnel.claims = ctx.tunnel.store.claims();
  let account = null;
  const token = bearerToken(ctx.req);
  if (token) {
    account = await ctx.tunnel.store.verify(token);
    if (!account) throw new AppError(401, 'INVALID_TOKEN', 'Unknown or invalid tunnel token. Create one with: curl -X POST <server>/api/tunnel/account');
  }
  let out;
  if (account && body.name !== undefined && body.name !== null && String(body.name) !== '') {
    out = ctx.tunnel.register(String(body.name), { accountId: account.id, port, proto });
  } else if (account) {
    out = ctx.tunnel.register(randomName(), { port, proto });
  } else {
    // Anonymous callers get a fresh random name; their requested name is ignored.
    let lastErr = null;
    for (let i = 0; i < 5; i++) {
      try {
        out = ctx.tunnel.register(randomName(), { port, proto });
        lastErr = null;
        break;
      } catch (err) {
        if (err && err.code === 'NAME_RESERVED') {
          lastErr = err;
          continue;
        }
        throw err;
      }
    }
    if (lastErr) throw lastErr;
  }
  ctx.tunnel.store.noteRegister(out.name, account ? account.id : null);
  ok(ctx, 201, { name: out.name, clientId: out.clientId, reserved: out.reserved, account: account ? account.tokenMask : null });
}

async function apiTunnelPoll(ctx) {
  const name = String(ctx.url.searchParams.get('name') || '');
  const client = String(ctx.url.searchParams.get('client') || '');
  if (!name) throw new AppError(400, 'INVALID_NAME', 'Send ?name=<app-name>&client=<client-id>.');
  const out = await ctx.tunnel.poll(name, client);
  if (out.gone === 'offline') throw new AppError(410, 'TUNNEL_OFFLINE', 'This tunnel is not connected (server restarted?). Re-register.');
  if (out.gone === 'replaced') throw new AppError(410, 'TUNNEL_REPLACED', 'This tunnel was taken over by another client.');
  ok(ctx, 200, { request: out.request });
}

async function apiTunnelRespond(ctx) {
  const body = parseJson(await readBody(ctx.req, TUNNEL_RESPOND_BODY_LIMIT));
  if (!body.name || !body.id) throw new AppError(400, 'INVALID_BODY', 'Send { name, client, id, status, headers, body }.');
  const out = ctx.tunnel.respond(String(body.name), String(body.client || ''), String(body.id), {
    status: Number(body.status) || 200,
    headers: body.headers && typeof body.headers === 'object' && !Array.isArray(body.headers) ? body.headers : {},
    body: typeof body.body === 'string' ? body.body : '',
  });
  if (!out.delivered && out.reason === 'replaced') {
    throw new AppError(410, 'TUNNEL_REPLACED', 'This tunnel was taken over by another client.');
  }
  ok(ctx, 200, { delivered: out.delivered });
}

async function apiTunnelClose(ctx) {
  const body = await readJsonBody(ctx);
  const closed = ctx.tunnel.close(String(body.name || ''));
  if (closed) ctx.tunnel.store.noteClose(String(body.name || ''));
  ok(ctx, 200, { closed });
}

async function apiTunnelList(ctx) {
  ok(ctx, 200, { tunnels: ctx.tunnel.list() });
}

// The downloadable client bundle, built fresh from tunnel-client/ on every
// request so the download always matches the deployed source.
async function apiTunnelClientTar(ctx) {
  const bundle = clientBundle();
  if (!bundle) throw new AppError(500, 'BUNDLE_MISSING', 'The tunnel client bundle is not available.');
  const headers = {
    'Content-Type': 'application/gzip',
    'Content-Disposition': 'attachment; filename="tunnel.tar.gz"',
    ETag: bundle.etag,
    'Cache-Control': 'public, max-age=300',
  };
  if (ctx.req.headers['if-none-match'] === bundle.etag) return send(ctx.res, 304, headers, '');
  return send(ctx.res, 200, headers, bundle.body);
}

async function pageTunnelHome(ctx) {
  sendHtml(ctx.res, 200, pages.tunnelPage({ tunnels: ctx.tunnel.list(), base: publicBase(ctx.req) }), {
    'Content-Security-Policy': INSTALL_PAGE_CSP,
  });
}

// The base URL as the visitor sees it: the installer and the quickstart on
// /tun are pinned to whatever host the request actually reached, so the same
// responses stay correct behind ngrok, Cloudflare, or localhost.
function hostProto(req) {
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || '');
  const local = /^(localhost|\[::1\]|127\.0\.0\.1)(:\d+)?$/i.test(host);
  const proto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() || (local ? 'http' : 'https');
  return { host, proto };
}

// The base URL as the visitor sees it: the installer and the quickstart on
// /tun are pinned to whatever host the request actually reached, so the same
// responses stay correct behind ngrok, Cloudflare, or localhost.
function publicBase(req) {
  const { host, proto } = hostProto(req);
  return host ? `${proto}://${host}` : '';
}

// The tunnel token from an Authorization: Bearer header (CLI clients).
function bearerToken(req) {
  const h = String(req.headers.authorization || '');
  return h.startsWith('Bearer ') ? h.slice(7).trim() : '';
}

// Browser visitors get friendly tunnel error pages; API clients get JSON.
function wantsHtml(req) {
  return String(req.headers.accept || '').includes('text/html');
}

// One-line installer for the tunnel client, consumed as
// `curl -fsSL <server>/tunnel.sh | sh`. Pinned to the host it came from.
async function apiTunnelInstallScript(ctx) {
  send(ctx.res, 200, {
    'Content-Type': 'text/x-shellscript; charset=utf-8',
    'Cache-Control': 'public, max-age=60',
  }, installScript(publicBase(ctx.req)));
}

// Raw buffer (readBody would decode utf8 and corrupt binary uploads).
function readRawBody(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > limit) {
        reject(new AppError(413, 'PAYLOAD_TOO_LARGE', 'Tunnel request body is too large (10 MB cap).'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', () => reject(new AppError(400, 'BAD_REQUEST', 'The request could not be read.')));
  });
}

// Reverse proxy: /tun/<name>/... → the connected client → its localhost app.
async function apiTunnelProxy(ctx) {
  const name = ctx.params.name;
  // WebSocket honesty: the tunnel forwards plain HTTP only. An Upgrade header
  // never reaches the local app — it is refused here with a clear 501 instead
  // of silently degrading into a normal GET.
  if (ctx.req.headers.upgrade !== undefined) {
    if (wantsHtml(ctx.req)) {
      return sendHtml(ctx.res, 501, pages.tunnelErrorPage({ kind: 'websocket', name, base: publicBase(ctx.req) }), {
        'Content-Security-Policy': INSTALL_PAGE_CSP,
      });
    }
    return sendJson(ctx.res, 501, { success: false, error: { code: 'WEBSOCKET_UNSUPPORTED', message: 'WebSocket forwarding is not supported.' } });
  }
  // HEAD is forwarded as HEAD (no hidden GET behind it); the visitor reply at
  // the bottom ships that response's headers only.
  const method = ctx.req.method;
  const raw = ['GET', 'HEAD'].includes(method) ? Buffer.alloc(0) : await readRawBody(ctx.req, TUNNEL_PROXY_BODY_LIMIT);
  // Path hardening: refuse paths that are too long or carry control characters
  // (raw or percent-decoded) before anything is queued for the tunnel client.
  // Handled here (not via throw) so non-browser clients get JSON on /tun paths.
  const path = String(ctx.params.rest || '/') + String(ctx.url.search || '');
  const decoded = (() => { try { return decodeURIComponent(path); } catch { return path; } })();
  const badPath = (message) => (wantsHtml(ctx.req)
    ? sendHtml(ctx.res, 400, pages.errorPage(400, message))
    : sendJson(ctx.res, 400, { success: false, error: { code: 'INVALID_PATH', message } }));
  if (path.length > 2048) return badPath('The path is too long (2048 characters max).');
  if (/[\x00-\x1f\x7f]/.test(path) || /[\x00-\x1f\x7f]/.test(decoded)) {
    return badPath('The path contains control characters.');
  }
  // Protected names (G6): the owner can gate /tun/<name> behind an access
  // token. Visitors pass it as ?access= or an x-tunnel-access header; the
  // gate is checked against the store's hash before anything is forwarded.
  if (ctx.tunnel.store) {
    await ctx.tunnel.store.load();
    if (ctx.tunnel.store.isProtected(name)) {
      const access = ctx.url.searchParams.get('access') || String(ctx.req.headers['x-tunnel-access'] || '');
      if (!ctx.tunnel.store.checkAccess(name, access)) {
        if (wantsHtml(ctx.req)) {
          return sendHtml(ctx.res, 401, pages.tunnelErrorPage({ kind: 'protected', name, base: publicBase(ctx.req) }), {
            'Content-Security-Policy': INSTALL_PAGE_CSP,
          });
        }
        return sendJson(ctx.res, 401, { success: false, error: { code: 'ACCESS_REQUIRED', message: 'This tunnel requires an access token. Append ?access=<token> or send an x-tunnel-access header.' } });
      }
    }
  }
  // Header hygiene: the visitor is not trusted. Whatever it claims about the
  // proxy chain (x-forwarded-*) or about the tunnel itself (x-tunnel-* — the
  // client's error marker included) is dropped; a small trusted set is built
  // below from the socket address and the same host/proto rules publicBase() uses.
  const headers = {};
  for (const [k, v] of Object.entries(ctx.req.headers)) {
    const lk = k.toLowerCase();
    if (TUNNEL_STRIPPED_HEADERS.has(lk)) continue;
    if (lk.startsWith('x-forwarded-') || lk.startsWith('x-tunnel-')) continue;
    headers[lk] = Array.isArray(v) ? v.join(', ') : String(v);
  }
  headers['x-forwarded-for'] = clientIp(ctx.req, ctx.auth);
  const { host, proto } = hostProto(ctx.req);
  headers['x-forwarded-host'] = host;
  headers['x-forwarded-proto'] = proto;
  if (ctx.tunnel.store) await ctx.tunnel.store.load();
  const t0 = Date.now();
  let out;
  try {
    out = await ctx.tunnel.forward({ name, method, path, headers, body: raw.toString('base64') });
  } catch (err) {
    // Browser visitors get a friendly (self-retrying) page; other clients get JSON.
    const codes = ['TUNNEL_OFFLINE', 'TUNNEL_UNAVAILABLE', 'TUNNEL_TIMEOUT', 'TUNNEL_BUSY', 'TUNNEL_LIMIT'];
    if (err instanceof AppError && codes.includes(err.code)) {
      if (wantsHtml(ctx.req)) {
        const kindMap = { TUNNEL_OFFLINE: 'offline', TUNNEL_UNAVAILABLE: 'offline', TUNNEL_TIMEOUT: 'slow', TUNNEL_BUSY: 'busy', TUNNEL_LIMIT: 'busy' };
        return sendHtml(ctx.res, err.status, pages.tunnelErrorPage({ kind: kindMap[err.code], name, base: publicBase(ctx.req) }), {
          'Content-Security-Policy': INSTALL_PAGE_CSP,
        });
      }
      return sendJson(ctx.res, err.status, { success: false, error: { code: err.code, message: err.message } });
    }
    throw err;
  }
  const bodyBuf = Buffer.from(String(out.body || ''), 'base64');
  const status = Math.min(599, Math.max(100, Math.round(Number(out.status) || 200)));
  const noteTraffic = () => {
    if (ctx.tunnel.store) {
      ctx.tunnel.store.noteTraffic(name, { method, path, status, bytes: bodyBuf.length, ms: Date.now() - t0 });
    }
  };
  // The tunnel is connected but the local app refused or timed out (the client
  // marks that with x-tunnel-error): browsers get an explanation, not a bare 502.
  if (out.status === 502 && /local-unreachable/i.test(String((out.headers || {})['x-tunnel-error'] || '')) && wantsHtml(ctx.req)) {
    noteTraffic();
    return sendHtml(ctx.res, 502, pages.tunnelErrorPage({ kind: 'down', name, base: publicBase(ctx.req) }), {
      'Content-Security-Policy': INSTALL_PAGE_CSP,
    });
  }
  const resHeaders = {};
  for (const [k, v] of Object.entries(out.headers || {})) {
    const lk = String(k).toLowerCase();
    if (TUNNEL_STRIPPED_HEADERS.has(lk)) continue;
    if (lk === 'set-cookie') resHeaders['Set-Cookie'] = Array.isArray(v) ? v : [v];
    else resHeaders[k] = v;
  }
  noteTraffic();
  // HEAD visitors asked for headers only — strip any body the client sent back.
  send(ctx.res, status, resHeaders, method === 'HEAD' ? Buffer.alloc(0) : bodyBuf);
}

// ---- Tunnel accounts, dashboard and stats (v2)

async function apiTunnelAccount(ctx) {
  const body = await readJsonBody(ctx);
  checkTunnelRate(ctx);
  const { account, token } = await ctx.tunnel.store.createAccount(body && body.label);
  ok(ctx, 201, { accountId: account.id, token, label: account.label, tokenMask: account.tokenMask });
}

async function apiTunnelWhoami(ctx) {
  const account = await ctx.tunnel.store.verify(bearerToken(ctx.req));
  if (!account) throw new AppError(401, 'INVALID_TOKEN', 'Send Authorization: Bearer <tunnel token>.');
  ok(ctx, 200, { account: { id: account.id, label: account.label, tokenMask: account.tokenMask, createdAt: account.createdAt }, names: ctx.tunnel.store.namesFor(account.id) });
}

async function apiTunnelStats(ctx) {
  if (ctx.tunnel.store) await ctx.tunnel.store.load();
  const s = ctx.tunnel.stats();
  ok(ctx, 200, {
    ...s,
    accounts: ctx.tunnel.store ? ctx.tunnel.store.doc.accounts.length : 0,
    names: ctx.tunnel.store ? Object.keys(ctx.tunnel.store.doc.names).length : 0,
    uptimeMs: Math.round(process.uptime() * 1000),
  });
}

// ---- Protected names + logs (G6/G7): owned by the tunnel token that owns
// the name. csrfExempt like the other CLI endpoints; Bearer tunt_ auth.

async function apiTunnelProtect(ctx) {
  const body = await readJsonBody(ctx);
  await ctx.tunnel.store.load();
  const account = await ctx.tunnel.store.verify(bearerToken(ctx.req));
  if (!account) throw new AppError(401, 'INVALID_TOKEN', 'Send Authorization: Bearer <tunnel token>.');
  const name = String((body && body.name) || '').trim().toLowerCase();
  const out = ctx.tunnel.store.protectName(name, account.id, body ? body.token : undefined);
  ok(ctx, 201, { name, protected: true, token: out.token, tokenMask: out.tokenMask });
}

async function apiTunnelUnprotect(ctx) {
  const body = await readJsonBody(ctx);
  await ctx.tunnel.store.load();
  const account = await ctx.tunnel.store.verify(bearerToken(ctx.req));
  if (!account) throw new AppError(401, 'INVALID_TOKEN', 'Send Authorization: Bearer <tunnel token>.');
  const out = ctx.tunnel.store.unprotectName(String((body && body.name) || ''), account.id);
  ok(ctx, 200, { name: out.name, protected: false });
}

// The recent request ring for one owned name (noteTraffic caps it at 50 rows).
async function apiTunnelLogs(ctx) {
  const name = String(ctx.url.searchParams.get('name') || '').trim().toLowerCase();
  if (!name) throw new AppError(400, 'INVALID_NAME', 'Send ?name=<app-name>.');
  await ctx.tunnel.store.load();
  const account = await ctx.tunnel.store.verify(bearerToken(ctx.req));
  if (!account) throw new AppError(401, 'INVALID_TOKEN', 'Send Authorization: Bearer <tunnel token>.');
  ok(ctx, 200, ctx.tunnel.store.logsFor(name, account.id));
}

// ---- Tunnel tokens + reserved names for signed-in site users (the /tunnel manager)

// The manager page. Same login shape as pageAppHome: signed-in users only.
async function pageTunnelManage(ctx) {
  requireConfigured(ctx);
  const user = await currentUser(ctx);
  if (!user) return redirect(ctx.res, '/login');
  await ctx.tunnel.store.load();
  const tokens = ctx.tunnel.store.accountsForUser(user.id);
  const ownedIds = new Set(tokens.map((t) => t.id));
  const masks = new Map(tokens.map((t) => [t.id, t.tokenMask]));
  const live = ctx.tunnel.list();
  const names = Object.entries(ctx.tunnel.store.doc.names)
    .filter(([, rec]) => rec.accountId && ownedIds.has(rec.accountId))
    .map(([name, rec]) => ({
      name,
      served: rec.served || 0,
      bytes: rec.bytes || 0,
      tokenMask: masks.get(rec.accountId) || '',
      live: live.some((t) => t.name === name),
    }));
  sendHtml(ctx.res, 200, pages.tunnelManagePage({ user, tokens, names, error: ctx.url.searchParams.get('error') || '' }));
}

// Create a tunnel token owned by the signed-in user. The full token is in this
// one response only - the store keeps the hash and shows the mask everywhere else.
async function apiTunnelTokensCreate(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  const body = await readOptionalJson(ctx);
  const label = body && typeof body.label === 'string' ? body.label : '';
  const { account, token } = await ctx.tunnel.store.createAccount(label, { userId: user.id, username: user.username });
  ok(ctx, 201, { id: account.id, token, tokenMask: account.tokenMask, label: account.label });
}

async function apiTunnelTokensList(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  await ctx.tunnel.store.load();
  ok(ctx, 200, { tokens: ctx.tunnel.store.accountsForUser(user.id) });
}

async function apiTunnelTokensRevoke(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  await ctx.tunnel.store.load();
  const released = await ctx.tunnel.store.revokeAccount(ctx.params.id, user.id);
  ok(ctx, 200, { revoked: true, released });
}

// Reserve a stable /tun/<name> for one of the user's tunnel tokens.
async function apiTunnelClaim(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  await ctx.tunnel.store.load();
  const body = await readJsonBody(ctx);
  const account = ctx.tunnel.store.assertOwned(body.accountId, user.id);
  const record = ctx.tunnel.store.claimName(body.name, account.id);
  ok(ctx, 201, { name: record.name, accountId: account.id, reserved: true });
}

async function apiTunnelRelease(ctx) {
  requireConfigured(ctx);
  const user = await requireUser(ctx);
  requireCsrfHeader(ctx);
  await ctx.tunnel.store.load();
  const body = await readJsonBody(ctx);
  const name = String(body.name || '');
  const rec = ctx.tunnel.store.doc.names[name.trim().toLowerCase()];
  const accountId = rec ? rec.accountId : null;
  const owned = accountId && ctx.tunnel.store.accountsForUser(user.id).some((t) => t.id === accountId);
  if (!owned) throw new AppError(404, 'NAME_NOT_FOUND', 'No reserved tunnel name goes by that name.');
  ctx.tunnel.store.releaseName(name, accountId);
  ok(ctx, 200, { released: true, name: name.trim().toLowerCase() });
}

// ---- Tunnel documentation: HTML guide, plain markdown and llms.txt indexes.
// All public on purpose (no secrets in the docs); same CSP as the other
// standalone tunnel pages. Markdown/plain variants are cacheable a short while.

function pageTunnelDocs(ctx) {
  sendHtml(ctx.res, 200, tunnelDocs.docsPageHtml({ base: publicBase(ctx.req) }), {
    'Content-Security-Policy': INSTALL_PAGE_CSP,
  });
}

// The whole-app API reference: every route, both auth schemes, the error-code
// table and the server limits. Public, cached briefly like the tunnel docs.
function pageAppDocs(ctx) {
  sendHtml(ctx.res, 200, appDocs.appDocsHtml({ base: publicBase(ctx.req) }), {
    'Content-Security-Policy': INSTALL_PAGE_CSP,
    'Cache-Control': 'public, max-age=300',
  });
}

function apiTunnelDocsMd(ctx) {
  send(ctx.res, 200, {
    'Content-Type': 'text/markdown; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  }, tunnelDocs.guideMarkdown());
}

function apiTunnelLlms(ctx) {
  send(ctx.res, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  }, tunnelDocs.llmsTxt({ base: publicBase(ctx.req) }));
}

function apiTunnelLlmsFull(ctx) {
  send(ctx.res, 200, {
    'Content-Type': 'text/plain; charset=utf-8',
    'Cache-Control': 'public, max-age=300',
  }, tunnelDocs.llmsFullTxt());
}

// Visitor-facing traffic inspector. GET ?token=... or POST the login form.
async function pageTunnelDashboard(ctx) {
  let token = '';
  if (ctx.req.method === 'POST') {
    // The login form submits urlencoded (readForm accepts JSON bodies too).
    const body = await readForm(ctx);
    token = String(body.token || '');
  } else {
    token = ctx.url.searchParams.get('token') || '';
  }
  const account = token ? await ctx.tunnel.store.verify(token) : null;
  if (!account) {
    const err = token ? 'That token was not recognized. Check it and try again.' : '';
    return sendHtml(ctx.res, token ? 401 : 200, pages.tunnelLoginPage({ error: err, base: publicBase(ctx.req) }), {
      'Content-Security-Policy': INSTALL_PAGE_CSP,
    });
  }
  const live = ctx.tunnel.list();
  const names = ctx.tunnel.store.namesFor(account.id).map((n) => ({ ...n, live: live.some((t) => t.name === n.name) }));
  sendHtml(ctx.res, 200, pages.tunnelDashboardPage({ account, names, tunnels: live, base: publicBase(ctx.req) }), {
    'Content-Security-Policy': INSTALL_PAGE_CSP,
  });
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
  { method: 'GET', path: '/api/live-status', handler: apiLiveStatus },
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
  { method: 'GET', path: '/api/tokens', handler: apiListTokens },
  { method: 'POST', path: '/api/tokens', handler: apiCreateToken },
  { method: 'DELETE', pattern: new RegExp('^/api/tokens/([a-f0-9]{12})$'), handler: apiRevokeToken, keys: ['id'] },
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
  // ---- Pips app: file detail/rename, DB documents, devices, social
  { method: 'GET', pattern: new RegExp(`^/api/files/${FILE_ID}$`), handler: apiFileGet },
  { method: 'PATCH', pattern: new RegExp(`^/api/files/${FILE_ID}$`), handler: apiFilePatch, keys: ['id'] },
  { method: 'GET', path: '/api/db', handler: apiPipsDbList },
  { method: 'POST', path: '/api/db', handler: apiPipsDbCreate },
  { method: 'GET', pattern: new RegExp('^/api/db/([a-f0-9]{12})$'), handler: apiPipsDbRead, keys: ['id'] },
  { method: 'PUT', pattern: new RegExp('^/api/db/([a-f0-9]{12})$'), handler: apiPipsDbWrite, keys: ['id'] },
  { method: 'DELETE', pattern: new RegExp('^/api/db/([a-f0-9]{12})$'), handler: apiPipsDbRemove, keys: ['id'] },
  { method: 'POST', pattern: new RegExp('^/api/db/([a-f0-9]{12})/line$'), handler: apiPipsDbEditLine, keys: ['id'] },
  { method: 'POST', pattern: new RegExp('^/api/db/([a-f0-9]{12})/move$'), handler: apiPipsDbMove, keys: ['id'] },
  { method: 'POST', pattern: new RegExp('^/api/db/([a-f0-9]{12})/restore$'), handler: apiPipsDbRestore, keys: ['id'] },
  { method: 'POST', path: '/api/devices', handler: apiDevicesHeartbeat },
  { method: 'GET', path: '/api/devices', handler: apiDevicesList },
  { method: 'DELETE', pattern: new RegExp('^/api/devices/([A-Za-z0-9_-]{8,64})$'), handler: apiDevicesRemove, keys: ['id'] },
  { method: 'GET', path: '/api/social/users', handler: apiSocialUsers },
  { method: 'POST', path: '/api/social/follow', handler: apiSocialFollow },
  { method: 'POST', path: '/api/social/unfollow', handler: apiSocialUnfollow },
  { method: 'GET', path: '/api/social/inbox', handler: apiSocialInbox },
  { method: 'GET', path: '/api/social/notifications', handler: apiSocialNotifications },
  { method: 'POST', path: '/api/social/notifications/read', handler: apiSocialNotificationsRead },
  { method: 'POST', path: '/api/social/chat', handler: apiSocialSend },
  { method: 'POST', path: '/api/social/chat/like', handler: apiSocialLike },
  { method: 'GET', pattern: new RegExp(`^/api/social/chat/(${USERNAME_RE.source.slice(1, -1)})$`), handler: apiSocialThread, keys: ['user'] },
  { method: 'GET', pattern: new RegExp(`^/api/social/avatar/(${USERNAME_RE.source.slice(1, -1)})$`), handler: apiSocialAvatarGet, keys: ['user'] },
  { method: 'PUT', path: '/api/social/avatar', handler: apiSocialAvatarPut },
  { method: 'POST', path: '/api/social/report', handler: apiSocialReport },
  { method: 'GET', pattern: new RegExp(`^/u/(${TOKEN})$`), handler: pageUploadLink },
  { method: 'POST', pattern: new RegExp(`^/u/(${TOKEN})/upload$`), handler: postUploadLink, csrfExempt: true },
  // ---- Tube: channels and published videos. All behind login, like the rest of the app.
  { method: 'GET', path: '/api/tube/feed', handler: apiTubeFeed },
  { method: 'GET', path: '/api/search', handler: apiSearch },
  { method: 'GET', path: '/api/search/suggest', handler: apiSearchSuggest },
  { method: 'POST', path: '/api/search/ai', handler: apiSearchAi },
  { method: 'GET', path: '/api/tube/my-channel', handler: apiTubeMyChannelGet },
  { method: 'PUT', path: '/api/tube/my-channel', handler: apiTubeMyChannelPut },
  {
    method: 'GET',
    pattern: new RegExp(`^/api/tube/channels/(${USERNAME_RE.source.slice(1, -1)})$`),
    handler: apiTubeChannelGet,
    keys: ['user'],
  },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/publish$`), handler: apiTubePublish, keys: ['fileId'] },
  { method: 'POST', path: '/api/tube/posts', handler: apiTubePostCreate },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/unpublish$`), handler: apiTubeUnpublish, keys: ['fileId'] },
  { method: 'PATCH', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}$`), handler: apiTubeVideoPatch, keys: ['fileId'] },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/view$`), handler: apiTubeView, keys: ['fileId'] },
  { method: 'GET', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/views$`), handler: apiTubeViewers, keys: ['fileId'] },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/vote$`), handler: apiTubeVote, keys: ['fileId'] },
  { method: 'GET', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/comments$`), handler: apiTubeCommentsList, keys: ['fileId'] },
  { method: 'POST', pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/comments$`), handler: apiTubeCommentsAdd, keys: ['fileId'] },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/tube/videos/${FILE_ID}/comments/([a-f0-9]{12})/vote$`),
    handler: apiTubeCommentVote,
    keys: ['fileId', 'commentId'],
  },
  {
    method: 'POST',
    pattern: new RegExp(`^/api/tube/channels/(${USERNAME_RE.source.slice(1, -1)})/subscribe$`),
    handler: apiTubeSubscribe,
    keys: ['user'],
  },
  { method: 'GET', path: '/api/tube/history', handler: apiTubeHistory },
  { method: 'DELETE', path: '/api/tube/my-channel', handler: apiTubeMyChannelDelete },
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
  { method: 'GET', path: '/app', handler: pageAppInstall },
  { method: 'GET', path: '/install', handler: pageInstallAlias },
  { method: 'GET', path: '/api/chat/status', handler: apiChatStatus },
  { method: 'GET', path: '/v1/models', handler: apiV1Models },
  { method: 'POST', path: '/v1/chat/completions', handler: apiV1ChatCompletions, csrfExempt: true },
  { method: 'POST', path: '/api/chat', handler: apiChatSend },
  { method: 'GET', pattern: new RegExp(`^/api/chat/jobs/${UUID}$`), handler: apiChatJob, keys: ['jobId'] },
  { method: 'DELETE', pattern: new RegExp(`^/api/chat/jobs/${UUID}$`), handler: apiChatCancel, keys: ['jobId'] },
  // ---- Pips Tunnel: /tun/<name> publishes a localhost app (see tunnel-client/).
  { method: 'GET', path: '/tun', handler: pageTunnelHome },
  { method: 'GET', path: '/tunnel.sh', handler: apiTunnelInstallScript },
  { method: 'GET', path: '/docs', handler: pageAppDocs },
  { method: 'GET', path: '/docs/tunnel', handler: pageTunnelDocs },
  { method: 'GET', path: '/docs/tunnel.md', handler: apiTunnelDocsMd },
  { method: 'GET', path: '/llms.txt', handler: apiTunnelLlms },
  { method: 'GET', path: '/llms-full.txt', handler: apiTunnelLlmsFull },
  { method: 'GET', path: '/api/tunnel/list', handler: apiTunnelList },
  { method: 'GET', path: '/api/tunnel/poll', handler: apiTunnelPoll },
  { method: 'GET', path: '/api/tunnel/client.tar.gz', handler: apiTunnelClientTar },
  { method: 'POST', path: '/api/tunnel/register', handler: apiTunnelRegister, csrfExempt: true },
  { method: 'POST', path: '/api/tunnel/respond', handler: apiTunnelRespond, csrfExempt: true },
  { method: 'POST', path: '/api/tunnel/close', handler: apiTunnelClose, csrfExempt: true },
  { method: 'POST', path: '/api/tunnel/account', handler: apiTunnelAccount, csrfExempt: true },
  { method: 'POST', path: '/api/tunnel/protect', handler: apiTunnelProtect, csrfExempt: true },
  { method: 'POST', path: '/api/tunnel/unprotect', handler: apiTunnelUnprotect, csrfExempt: true },
  { method: 'GET', path: '/api/tunnel/logs', handler: apiTunnelLogs },
  { method: 'GET', path: '/api/tunnel/whoami', handler: apiTunnelWhoami },
  { method: 'GET', path: '/api/tunnel/stats', handler: apiTunnelStats },
  // ---- Tunnel manager for signed-in site users: tokens + reserved names.
  // Mutating routes are NOT csrfExempt: dispatch's same-origin check covers
  // every non-GET (DELETE included), and the handlers additionally require the
  // X-Requested-With: fetch header unless a Bearer sat_ token authenticates.
  { method: 'GET', path: '/tunnel', handler: pageTunnelManage },
  { method: 'GET', path: '/api/tunnel/tokens', handler: apiTunnelTokensList },
  { method: 'POST', path: '/api/tunnel/tokens', handler: apiTunnelTokensCreate },
  { method: 'DELETE', pattern: new RegExp('^/api/tunnel/tokens/([a-f0-9]{24})$'), handler: apiTunnelTokensRevoke, keys: ['id'] },
  { method: 'POST', path: '/api/tunnel/claim', handler: apiTunnelClaim },
  { method: 'POST', path: '/api/tunnel/release', handler: apiTunnelRelease },
  { method: 'GET', path: '/tun/dashboard', handler: pageTunnelDashboard },
  { method: 'POST', path: '/tun/dashboard', handler: pageTunnelDashboard, csrfExempt: true },
  { method: 'GET', pattern: new RegExp(TUNNEL_PROXY_PATTERN), handler: apiTunnelProxy, keys: ['name', 'rest'] },
  { method: 'POST', pattern: new RegExp(TUNNEL_PROXY_PATTERN), handler: apiTunnelProxy, keys: ['name', 'rest'], csrfExempt: true },
  { method: 'PUT', pattern: new RegExp(TUNNEL_PROXY_PATTERN), handler: apiTunnelProxy, keys: ['name', 'rest'], csrfExempt: true },
  { method: 'PATCH', pattern: new RegExp(TUNNEL_PROXY_PATTERN), handler: apiTunnelProxy, keys: ['name', 'rest'], csrfExempt: true },
  { method: 'DELETE', pattern: new RegExp(TUNNEL_PROXY_PATTERN), handler: apiTunnelProxy, keys: ['name', 'rest'], csrfExempt: true },
  // OPTIONS is proxied like POST (the local app owns its OPTIONS answer);
  // csrfExempt so cross-origin preflights are not refused outright.
  { method: 'OPTIONS', pattern: new RegExp(TUNNEL_PROXY_PATTERN), handler: apiTunnelProxy, keys: ['name', 'rest'], csrfExempt: true },
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

async function dispatch(req, res, auth, corsOrigins, modelChat, tunnels) {
  const url = new URL(req.url || '/', 'http://localhost');
  const ctx = { req, res, url, auth, chat: modelChat, tunnel: tunnels, ip: clientIp(req, auth), params: {} };
  const method = req.method === 'HEAD' ? 'GET' : req.method;

  // /v1/* is the OpenAI-compatible surface: same CORS treatment as /api/*.
  const isApi = url.pathname.startsWith('/api/') || url.pathname.startsWith('/v1/');
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
  // A Bearer API token is a header credential: a cross-site form cannot send one, so it needs no origin check either.
  const hasApiToken = apiTokens.isBearerHeader(req.headers.authorization);
  if (method !== 'GET' && !hit.route.csrfExempt && !hasApiToken && !sameOrigin(req, corsOrigins)) {
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
  releaseApiBase = env.PIPS_RELEASE_API_BASE || 'https://api.github.com';
  liveStatusInfo = liveStatusFromEnv(env);
  const auth = buildAuth(env, options);
  const corsOrigins = parseCorsOrigins(env.CORS_ALLOWED_ORIGINS);
  const modelChat = buildModelChat(env, options);
  const tunnels = new Tunnels({
    now: options.now,
    waitMs: positiveInt(env.TUNNEL_WAIT_MS, 30000),
    pollWaitMs: positiveInt(env.TUNNEL_POLL_WAIT_MS, 20000),
    ttlMs: positiveInt(env.TUNNEL_TTL_MS, 90000),
    maxTunnels: positiveInt(env.TUNNEL_MAX_TUNNELS, 200),
    maxQueue: positiveInt(env.TUNNEL_MAX_QUEUE, 64),
  });
  // Tunnel accounts, reserved names and traffic logs persist as one JSON doc.
  // The store loads lazily (memoized); tunnel handlers await store.load().
  const tunnelStore = new TunnelStore({ storage: auth.storage, saveDelayMs: positiveInt(env.TUNNEL_SAVE_MS, 5000) });
  tunnels.store = tunnelStore;
  // Per-IP registration budget for register/account (see checkTunnelRate).
  // TUNNEL_REGISTER_RATE is per window; the default is deliberately generous.
  tunnels.registerLimiter = new RateLimiter(options.now || Date.now);
  tunnels.registerRate = positiveInt(env.TUNNEL_REGISTER_RATE, 240);
  const server = http.createServer((req, res) => {
    dispatch(req, res, auth, corsOrigins, modelChat, tunnels).catch((err) => {
      console.error(`Unhandled error: ${err && err.name}`);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end();
    });
  });
  // A complete WebSocket handshake (Connection: upgrade + Upgrade header) never
  // reaches the route table: Node raises an 'upgrade' event, and with no
  // listener it silently destroys the socket. Answer it honestly instead —
  // nothing here forwards WebSockets.
  server.on('upgrade', (req, socket) => {
    const body = JSON.stringify({ success: false, error: { code: 'WEBSOCKET_UNSUPPORTED', message: 'WebSocket forwarding is not supported.' } });
    socket.end(`HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Type: application/json; charset=utf-8\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  });
  // Tests use this to run the cleanup sweep directly. Nothing in the app reads it.
  server.fileServices = auth.files;
  // Tests use these to drive the chat with a stubbed upstream.
  server.modelChat = modelChat.chat;
  server.chatJobs = modelChat.jobs;
  // Tests use this to seed tunnels without going through the HTTP API.
  server.tunnels = tunnels;
  // Tests use this to inspect/flush the persisted tunnel document.
  server.tunnelStore = tunnelStore;
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
