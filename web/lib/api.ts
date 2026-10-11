/**
 * Shared API plumbing for every route handler:
 *   - JSON envelope {success, data | error, request_id}
 *   - request ids, security headers, no-store caching
 *   - CORS allowlist (never wildcard, and never with credentials for unknown origins)
 *   - CSRF check for cookie-authenticated writes (API-key requests are exempt)
 *   - body size limits and error mapping
 *
 * Responses never contain stack traces, environment values, tokens, or repository paths.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { PublicUser } from "./accounts";
import type { Config } from "./config";
import { ConfigError } from "./config";
import { ApiError } from "./errors";
import { resolvePrincipal, type Principal } from "./apps";
import { getServices } from "./services";
import { decodeSession, encodeSession, clearSessionCookie, readCookie, sessionCookie, SESSION_COOKIE, type SessionData } from "./session";
import { StorageError, type Storage } from "./storage";
import { nowSec } from "./util";

export interface Ctx {
  req: Request;
  url: URL;
  requestId: string;
  cfg: Config;
  storage: Storage;
  session: SessionData;
  sessionChanged: boolean;
}

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const ALLOWED_HEADERS = "Authorization, Content-Type, X-API-Key, X-CSRF-Token";
const ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS";
const JSON_TYPE = /^application\/(json|[\w.+-]+\+json)(\s*;|$)/i;

export function newRequestId(): string {
  return randomBytes(8).toString("hex");
}

export function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

export function fail(requestId: string, status: number, code: string, message: string): Response {
  return Response.json({ success: false, error: { code, message }, request_id: requestId }, { status });
}

export function ok(ctx: Ctx, data?: unknown, status = 200): Response {
  const body: Record<string, unknown> = { success: true, request_id: ctx.requestId };
  if (data !== undefined) body.data = data;
  return Response.json(body, { status });
}

/** For legacy endpoints that keep their original response shape. */
export function legacyError(ctx: Ctx, status: number, message: string): Response {
  return Response.json({ error: message }, { status });
}

export function isApiKeyRequest(req: Request): boolean {
  const auth = req.headers.get("authorization") ?? "";
  return auth.toLowerCase().startsWith("bearer ") || Boolean(req.headers.get("x-api-key"));
}

export function clientIp(req: Request): string {
  // Behind a proxy (Render), the last X-Forwarded-For entry is the one the proxy added.
  const xff = req.headers.get("x-forwarded-for") ?? "";
  const parts = xff.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : "unknown";
}

// ---------------------------------------------------------------- session helpers
export function csrfToken(ctx: Ctx): string {
  if (!ctx.session.csrf) {
    ctx.session.csrf = randomBytes(32).toString("base64url");
    ctx.sessionChanged = true;
  }
  return ctx.session.csrf;
}

export function logIn(ctx: Ctx, user: Pick<PublicUser, "id">): void {
  ctx.session = { uid: user.id, iat: nowSec() };
  ctx.sessionChanged = true;
  csrfToken(ctx);
}

export function logOut(ctx: Ctx): void {
  ctx.session = {};
  ctx.sessionChanged = true;
}

function requireCsrf(ctx: Ctx): void {
  const sent = ctx.req.headers.get("x-csrf-token") ?? "";
  const expected = ctx.session.csrf ?? "";
  if (!expected || !sent || !safeEqual(sent, expected)) {
    throw new ApiError(403, "CSRF_FAILED", "Missing or invalid CSRF token. Reload the page and try again.");
  }
}

/** Owner-only management: API keys are refused outright, even alongside a session cookie. */
export function ownerSessionUserId(ctx: Ctx): string {
  if (isApiKeyRequest(ctx.req)) {
    throw new ApiError(403, "PERMISSION_DENIED", "API keys cannot manage apps or keys. Log in instead.");
  }
  if (!ctx.session.uid) throw new ApiError(401, "UNAUTHENTICATED", "Log in first.");
  return ctx.session.uid;
}

export async function principal(ctx: Ctx): Promise<Principal> {
  const p = await resolvePrincipal(ctx.storage, ctx.cfg.apiKeyHashSecret, ctx.req.headers, ctx.session);
  if (!p) throw new ApiError(401, "UNAUTHENTICATED", "Log in or send an API key.");
  return p;
}

/** Legacy file API: accepts LEGACY_API_KEY in X-API-Key, or a logged-in session. */
export function legacyAuth(ctx: Ctx): void {
  const expected = ctx.cfg.legacyApiKey;
  const given = ctx.req.headers.get("x-api-key") ?? "";
  if (expected && given && safeEqual(given, expected)) return;
  if (!ctx.session.uid) throw new ApiError(401, "UNAUTHENTICATED", "Log in first.");
}

// ---------------------------------------------------------------- body reading
function tooLarge(): ApiError {
  return new ApiError(413, "PAYLOAD_TOO_LARGE", "The request is too large.");
}

/** Read the raw body, stopping as soon as it passes `max` bytes. */
export async function readBodyLimited(req: Request, max: number): Promise<Buffer> {
  const declared = Number(req.headers.get("content-length") ?? "0");
  if (Number.isFinite(declared) && declared > max) throw tooLarge();
  if (!req.body) return Buffer.alloc(0);
  const reader = req.body.getReader();
  const chunks: Buffer[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      throw tooLarge();
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks);
}

/** Parse a JSON object body. An empty body is treated as {}. */
export async function readJson(ctx: Ctx): Promise<Record<string, any>> {
  if (!JSON_TYPE.test(ctx.req.headers.get("content-type") ?? "")) {
    throw new ApiError(400, "INVALID_CONTENT_TYPE", "Send the body as application/json.");
  }
  const raw = await readBodyLimited(ctx.req, ctx.cfg.maxRequestBytes);
  const text = raw.toString("utf8");
  if (!text.trim()) return {};
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    throw new ApiError(400, "INVALID_JSON", "The request body is not valid JSON.");
  }
  if (body === null) return {};
  if (typeof body !== "object" || Array.isArray(body)) {
    throw new ApiError(400, "INVALID_BODY", "The body must be a JSON object.");
  }
  return body as Record<string, any>;
}

// ---------------------------------------------------------------- route wrapper
export type Handler<P> = (ctx: Ctx, params: P) => Promise<Response>;

function buildContext(req: Request, requestId: string): Ctx {
  const { config, storage } = getServices(); // throws ConfigError when misconfigured
  let session = decodeSession(readCookie(req.headers.get("cookie"), SESSION_COOKIE), config.secretKey);
  let sessionChanged = false;
  if (session.uid && (!session.iat || nowSec() - session.iat > config.sessionHours * 3600)) {
    session = {};
    sessionChanged = true;
  }
  return { req, url: new URL(req.url), requestId, cfg: config, storage, session, sessionChanged };
}

function errorResponse(requestId: string, err: unknown): Response {
  if (err instanceof ApiError) return fail(requestId, err.status, err.code, err.message);
  if (err instanceof StorageError) return fail(requestId, err.status, err.code, err.message);
  if (err instanceof ConfigError) return fail(requestId, 503, "NOT_CONFIGURED", err.message);
  // Log only the error type. Messages can contain request data or upstream details.
  console.error(`unhandled ${(err as Error)?.name ?? "error"} (request ${requestId})`);
  return fail(requestId, 500, "INTERNAL_ERROR", "Something went wrong. Quote the request id when reporting it.");
}

function finish(req: Request, requestId: string, ctx: Ctx | null, res: Response): Response {
  const origins = ctx?.cfg.corsAllowedOrigins ?? [];
  const origin = req.headers.get("origin") ?? "";
  if (origin && origins.includes(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set("Access-Control-Expose-Headers", "X-Request-Id");
  }
  res.headers.set("Vary", "Origin");
  res.headers.set("X-Request-Id", requestId);
  res.headers.set("X-Content-Type-Options", "nosniff");
  res.headers.set("X-Frame-Options", "DENY");
  res.headers.set("Referrer-Policy", "same-origin");
  res.headers.set("Cache-Control", "no-store");
  if (ctx?.sessionChanged) {
    const hasState = Object.keys(ctx.session).length > 0;
    res.headers.append(
      "Set-Cookie",
      hasState ? sessionCookie(encodeSession(ctx.session, ctx.cfg.secretKey), ctx.cfg) : clearSessionCookie(ctx.cfg),
    );
  }
  return res;
}

/**
 * Wrap a handler with the shared behaviour. Handlers return Response objects (usually ok()).
 * Unsafe methods from cookie sessions must send X-CSRF-Token matching the session.
 */
export function apiRoute<P extends Record<string, string> = Record<string, string>>(handler: Handler<P>) {
  return async function route(req: Request, context?: { params: Promise<P> }): Promise<Response> {
    const requestId = newRequestId();
    let ctx: Ctx | null = null;
    try {
      ctx = buildContext(req, requestId);
      const params = context?.params ? await context.params : ({} as P);
      if (UNSAFE_METHODS.has(req.method) && !isApiKeyRequest(req)) requireCsrf(ctx);
      return finish(req, requestId, ctx, await handler(ctx, params));
    } catch (err) {
      return finish(req, requestId, ctx, errorResponse(requestId, err));
    }
  };
}

/** CORS preflight for OPTIONS requests. Unknown origins get no allow headers. */
export function preflight(req: Request): Response {
  const res = new Response(null, { status: 204 });
  let origins: string[] = [];
  try {
    origins = getServices().config.corsAllowedOrigins;
  } catch {
    origins = [];
  }
  const origin = req.headers.get("origin") ?? "";
  if (origin && origins.includes(origin)) {
    res.headers.set("Access-Control-Allow-Origin", origin);
    res.headers.set("Access-Control-Allow-Credentials", "true");
    res.headers.set("Access-Control-Allow-Headers", ALLOWED_HEADERS);
    res.headers.set("Access-Control-Allow-Methods", ALLOWED_METHODS);
    res.headers.set("Access-Control-Max-Age", "600");
  }
  res.headers.set("Vary", "Origin");
  res.headers.set("X-Content-Type-Options", "nosniff");
  return res;
}
