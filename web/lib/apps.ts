/**
 * Applications, API keys, and request principals.
 *
 * A principal is who the request acts as:
 *   KeyPrincipal  - an application API key. Bound to one app and to explicit scopes.
 *   UserPrincipal - a logged-in user (session cookie). Owners get every scope on their own apps.
 *
 * Application access is always checked against the stored owner or key binding, never against
 * client-supplied paths.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ApiError } from "./errors";
import type { SessionData } from "./session";
import * as paths from "./paths";
import { Conflict, NotFound, jsonBytes, type Storage } from "./storage";
import { nowIso, isPlainObject } from "./util";

export const SCOPES = ["db:read", "db:write", "files:read", "files:write"] as const;
export const ENVIRONMENTS = ["development", "production"] as const;
const KEY_TOUCH_MS = 60 * 60 * 1000;

export interface KeyPrincipal {
  kind: "key";
  appId: string;
  keyId: string;
  scopes: string[];
}

export interface UserPrincipal {
  kind: "user";
  userId: string;
}

export type Principal = KeyPrincipal | UserPrincipal;

// ---------------------------------------------------------------- keys
function hashSecret(secret: string, pepper: string): string {
  return createHmac("sha256", pepper).update(secret).digest("hex");
}

function publicKey(rec: Record<string, any>) {
  return {
    id: rec.id,
    name: rec.name,
    environment: rec.environment,
    scopes: rec.scopes,
    created_at: rec.created_at,
    last_used_at: rec.last_used_at ?? null,
    expires_at: rec.expires_at ?? null,
    revoked_at: rec.revoked_at ?? null,
  };
}

export async function createKey(
  storage: Storage,
  pepper: string,
  aid: string,
  name: unknown,
  environment: unknown,
  scopes: unknown,
  expiresInDays?: unknown,
) {
  if (typeof environment !== "string" || !(ENVIRONMENTS as readonly string[]).includes(environment)) {
    throw new ApiError(400, "INVALID_ENVIRONMENT", "environment must be development or production.");
  }
  if (!Array.isArray(scopes) || scopes.length === 0 || scopes.some((s) => !(SCOPES as readonly string[]).includes(s))) {
    throw new ApiError(400, "INVALID_SCOPES", `scopes must be a non-empty list of: ${SCOPES.join(", ")}.`);
  }
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 80) {
    throw new ApiError(400, "INVALID_NAME", "Key name must be 1-80 characters.");
  }
  let expiresAt: string | null = null;
  if (expiresInDays !== undefined && expiresInDays !== null) {
    if (typeof expiresInDays !== "number" || !Number.isInteger(expiresInDays) || expiresInDays < 1 || expiresInDays > 365) {
      throw new ApiError(400, "INVALID_EXPIRY", "expires_in_days must be between 1 and 365.");
    }
    expiresAt = new Date(Date.now() + expiresInDays * 86400_000).toISOString();
  }

  const kid = paths.newId();
  const secret = randomBytes(32).toString("base64url"); // 43 url-safe characters, never a "."
  const record = {
    id: kid,
    name: name.trim(),
    environment,
    scopes: [...new Set(scopes as string[])].sort(),
    hash: hashSecret(secret, pepper),
    created_at: nowIso(),
    last_used_at: null,
    expires_at: expiresAt,
    revoked_at: null,
  };
  await storage.write(paths.keyPath(aid, kid), jsonBytes(record), `create api key ${kid}`);
  // The full key is returned only once. It is never stored, logged, or shown again.
  return { ...publicKey(record), api_key: `${aid}.${kid}.${secret}` };
}

export async function listKeys(storage: Storage, aid: string) {
  const out = [];
  for (const item of await storage.list(paths.keyDir(aid))) {
    if (item.type !== "file") continue;
    const got = await storage.read(`${paths.keyDir(aid)}/${item.name}`);
    if (got) out.push(publicKey(JSON.parse(got.data.toString("utf8"))));
  }
  return out;
}

export async function revokeKey(storage: Storage, aid: string, kid: string) {
  const path = paths.keyPath(aid, kid);
  const got = await storage.read(path);
  if (!got) throw new ApiError(404, "NOT_FOUND", "API key not found.");
  const rec = JSON.parse(got.data.toString("utf8"));
  if (rec.revoked_at) return publicKey(rec);
  rec.revoked_at = nowIso();
  await storage.write(path, jsonBytes(rec), `revoke api key ${kid}`, got.sha);
  return publicKey(rec);
}

/** Return a KeyPrincipal, or null if the key is malformed, unknown, revoked, or expired. */
export async function verifyKey(storage: Storage, pepper: string, rawKey: string): Promise<KeyPrincipal | null> {
  const parts = (rawKey ?? "").split(".");
  if (parts.length !== 3) return null;
  const [aid, kid, secret] = parts;
  try {
    paths.appId(aid);
    paths.recordId(kid);
  } catch {
    return null;
  }
  const got = await storage.read(paths.keyPath(aid, kid));
  if (!got) return null;
  const rec = JSON.parse(got.data.toString("utf8"));
  if (rec.revoked_at) return null;
  if (rec.expires_at && new Date(rec.expires_at).getTime() <= Date.now()) return null;
  const a = Buffer.from(String(rec.hash ?? ""), "utf8");
  const b = Buffer.from(hashSecret(secret, pepper), "utf8");
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  await touchKey(storage, aid, kid, rec, got.sha);
  return { kind: "key", appId: aid, keyId: kid, scopes: rec.scopes };
}

/** Record last use at most once per hour. Best effort: a failed update never blocks a request. */
async function touchKey(storage: Storage, aid: string, kid: string, rec: Record<string, any>, sha: string): Promise<void> {
  const last = rec.last_used_at ? new Date(rec.last_used_at).getTime() : 0;
  if (last && Date.now() - last < KEY_TOUCH_MS) return;
  rec.last_used_at = nowIso();
  try {
    await storage.write(paths.keyPath(aid, kid), jsonBytes(rec), `touch api key ${kid}`, sha);
  } catch (e) {
    if (!(e instanceof Conflict) && !(e instanceof NotFound)) throw e;
  }
}

// ---------------------------------------------------------------- apps
function slug(name: string): string {
  let s = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 33).replace(/-+$/, "");
  if (!s || !/^[a-z]/.test(s)) s = "app-" + s;
  return s.slice(0, 33).replace(/-+$/, "") || "app";
}

export async function createApp(storage: Storage, ownerId: string, name: unknown, description: unknown = "") {
  if (typeof name !== "string" || name.trim().length < 1 || name.trim().length > 80) {
    throw new ApiError(400, "INVALID_NAME", "App name must be 1-80 characters.");
  }
  const desc = description === null || description === undefined ? "" : description;
  if (typeof desc !== "string" || desc.length > 500) {
    throw new ApiError(400, "INVALID_DESCRIPTION", "Description must be at most 500 characters.");
  }
  for (let attempt = 0; attempt < 3; attempt++) {
    const aid = `${slug(name)}-${randomBytes(3).toString("hex")}`;
    const now = nowIso();
    const meta = {
      id: aid,
      name: name.trim(),
      description: desc,
      owner_id: ownerId,
      status: "active",
      created_at: now,
      updated_at: now,
    };
    try {
      await storage.write(paths.appMetaPath(aid), jsonBytes(meta), `create app ${aid}`);
    } catch (e) {
      if (e instanceof Conflict) continue;
      throw e;
    }
    await storage.write(paths.ownerIndexPath(ownerId, aid), jsonBytes({ app_id: aid }), `index app ${aid}`);
    return meta;
  }
  throw new ApiError(503, "RETRY_LATER", "Could not allocate an app id. Try again.");
}

export async function loadApp(storage: Storage, aid: string): Promise<Record<string, any> | null> {
  const got = await storage.read(paths.appMetaPath(aid));
  return got ? JSON.parse(got.data.toString("utf8")) : null;
}

/** Owner-only access. Returns the app, or 404 for anything else (no existence leak). */
export async function loadOwnedApp(storage: Storage, ownerId: string, aid: string) {
  try {
    paths.appId(aid);
  } catch {
    throw new ApiError(404, "NOT_FOUND", "App not found.");
  }
  const app = await loadApp(storage, aid);
  if (!app || app.owner_id !== ownerId || app.status !== "active") {
    throw new ApiError(404, "NOT_FOUND", "App not found.");
  }
  return app;
}

export async function listOwnedApps(storage: Storage, ownerId: string, limit = 100) {
  const out: Record<string, any>[] = [];
  const entries = (await storage.list(paths.ownerIndexDir(ownerId))).slice(0, limit);
  for (const item of entries) {
    if (item.type !== "file") continue;
    const got = await storage.read(`${paths.ownerIndexDir(ownerId)}/${item.name}`);
    if (!got) continue;
    const aid = JSON.parse(got.data.toString("utf8")).app_id;
    const app = aid ? await loadApp(storage, aid) : null;
    if (app && app.owner_id === ownerId && app.status === "active") out.push(app);
  }
  return out;
}

export async function updateApp(storage: Storage, ownerId: string, aid: string, changes: unknown) {
  const app = await loadOwnedApp(storage, ownerId, aid);
  const allowed = new Set(["name", "description"]);
  if (!isPlainObject(changes) || Object.keys(changes).length === 0 || Object.keys(changes).some((k) => !allowed.has(k))) {
    throw new ApiError(400, "INVALID_FIELDS", "Only name and description can be changed.");
  }
  if ("name" in changes) {
    const n = changes.name;
    if (typeof n !== "string" || n.trim().length < 1 || n.trim().length > 80) {
      throw new ApiError(400, "INVALID_NAME", "App name must be 1-80 characters.");
    }
    app.name = n.trim();
  }
  if ("description" in changes) {
    const d = changes.description ?? "";
    if (typeof d !== "string" || d.length > 500) {
      throw new ApiError(400, "INVALID_DESCRIPTION", "Description must be at most 500 characters.");
    }
    app.description = d;
  }
  app.updated_at = nowIso();
  const got = await storage.read(paths.appMetaPath(aid));
  await storage.write(paths.appMetaPath(aid), jsonBytes(app), `update app ${aid}`, got?.sha);
  return app;
}

/**
 * Soft delete: the app is hidden, every key is revoked, and data is kept.
 * Hard purge is intentionally not automatic. It needs a separate, explicit administrator action.
 */
export async function deleteApp(storage: Storage, pepper: string, ownerId: string, aid: string, confirm: unknown) {
  const app = await loadOwnedApp(storage, ownerId, aid);
  if (confirm !== aid) {
    throw new ApiError(400, "CONFIRMATION_REQUIRED", 'Send {"confirm": "<app_id>"} to delete this app.');
  }
  for (const k of await listKeys(storage, aid)) {
    if (!k.revoked_at) await revokeKey(storage, aid, k.id);
  }
  const got = await storage.read(paths.appMetaPath(aid));
  app.status = "deleted";
  app.deleted_at = nowIso();
  await storage.write(paths.appMetaPath(aid), jsonBytes(app), `delete app ${aid}`, got?.sha);
  try {
    const idx = await storage.read(paths.ownerIndexPath(ownerId, aid));
    if (idx) await storage.delete(paths.ownerIndexPath(ownerId, aid), idx.sha, `unindex app ${aid}`);
  } catch (e) {
    if (!(e instanceof Conflict) && !(e instanceof NotFound)) throw e;
  }
  return { id: aid, status: "deleted" };
}

// ---------------------------------------------------------------- principals
/** Identify the caller from Authorization (preferred) or X-API-Key. Falls back to the session. */
export async function resolvePrincipal(
  storage: Storage,
  pepper: string,
  headers: Headers,
  session: SessionData,
): Promise<Principal | null> {
  const auth = headers.get("authorization") ?? "";
  let raw = "";
  if (auth.toLowerCase().startsWith("bearer ")) {
    raw = auth.slice(7).trim();
  } else if (headers.get("x-api-key")) {
    raw = (headers.get("x-api-key") ?? "").trim();
  }
  if (raw) {
    const kp = await verifyKey(storage, pepper, raw);
    if (!kp) throw new ApiError(401, "INVALID_API_KEY", "Invalid, revoked, or expired API key.");
    return kp;
  }
  if (session.uid) return { kind: "user", userId: session.uid };
  return null;
}

export async function requireAppScope(storage: Storage, principal: Principal, aid: string, scope: string) {
  if (principal.kind === "key") {
    if (principal.appId !== aid) {
      throw new ApiError(403, "PERMISSION_DENIED", "This API key cannot access that app.");
    }
    if (!principal.scopes.includes(scope)) {
      throw new ApiError(403, "PERMISSION_DENIED", "This API key does not have the required permission.");
    }
    const app = await loadApp(storage, aid);
    if (!app || app.status !== "active") throw new ApiError(404, "NOT_FOUND", "App not found.");
    return app;
  }
  return loadOwnedApp(storage, principal.userId, aid);
}
