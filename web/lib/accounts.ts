/**
 * User accounts: signup, password verification, and login rate limiting.
 *
 * Users are stored by stable id: users/<user_id>.json. Usernames map to ids through
 * system/usernames/<username>.json, which is created without a sha so two signups for the
 * same name cannot both succeed.
 */
import { ApiError } from "./errors";
import { hashPassword, verifyPassword } from "./passwords";
import * as paths from "./paths";
import { limiter } from "./ratelimit";
import { Conflict, jsonBytes, type Storage } from "./storage";
import { nowIso } from "./util";

export const MIN_PASSWORD = 8;
export const MAX_PASSWORD = 200;
export const LOGIN_WINDOW_SEC = 15 * 60;
export const LOGIN_FAILURES_PER_USER = 5;
export const LOGIN_ATTEMPTS_PER_IP = 30;

export interface PublicUser {
  id: string;
  username: string;
  created_at: string | null;
}

export function publicUser(u: Record<string, any>): PublicUser {
  return { id: u.id, username: u.username, created_at: u.created_at ?? null };
}

function validateCredentials(username: unknown, password: unknown): string {
  const name = paths.username(String(username ?? "").trim().toLowerCase());
  if (typeof password !== "string" || password.length < MIN_PASSWORD || password.length > MAX_PASSWORD) {
    throw new ApiError(400, "INVALID_PASSWORD", `Password must be ${MIN_PASSWORD}-${MAX_PASSWORD} characters.`);
  }
  return name;
}

export async function createUser(storage: Storage, username: unknown, password: unknown): Promise<PublicUser> {
  const name = validateCredentials(username, password);
  const uid = paths.newId();
  try {
    // Claim the username first. Without a sha, storage refuses to overwrite an existing claim.
    await storage.write(paths.usernameIndexPath(name), jsonBytes({ user_id: uid }), `claim username ${name}`);
  } catch (e) {
    if (e instanceof Conflict) throw new ApiError(409, "USERNAME_TAKEN", "That username is already taken.");
    throw e;
  }
  const user = {
    id: uid,
    username: name,
    password_hash: hashPassword(password as string),
    created_at: nowIso(),
  };
  try {
    await storage.write(paths.userPath(uid), jsonBytes(user), `create user ${uid}`);
  } catch (e) {
    await bestEffortDelete(storage, paths.usernameIndexPath(name), `rollback username ${name}`);
    throw e;
  }
  return publicUser(user);
}

let dummy: string | null = null;
/** Hash checked when the username does not exist, so response timing does not reveal accounts. */
function dummyHash(): string {
  if (dummy === null) dummy = hashPassword("not-a-real-password");
  return dummy;
}

export async function authenticate(storage: Storage, username: unknown, password: unknown, ip: string): Promise<PublicUser> {
  let name: string | null;
  try {
    name = paths.username(String(username ?? "").trim().toLowerCase());
  } catch {
    name = null;
  }
  if (!limiter.allow(`login-ip:${ip}`, LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW_SEC)) {
    throw new ApiError(429, "RATE_LIMITED", "Too many login attempts. Try again later.");
  }
  if (name && limiter.count(`login-user:${name}`, LOGIN_WINDOW_SEC) >= LOGIN_FAILURES_PER_USER) {
    throw new ApiError(429, "RATE_LIMITED", "Too many failed logins for this account. Try again later.");
  }

  let user: Record<string, any> | null = null;
  if (name) {
    const idx = await storage.read(paths.usernameIndexPath(name));
    if (idx) {
      const uid = JSON.parse(idx.data.toString("utf8")).user_id;
      const got = uid ? await storage.read(paths.userPath(uid)) : null;
      user = got ? JSON.parse(got.data.toString("utf8")) : null;
    }
  }
  const stored = typeof user?.password_hash === "string" ? user.password_hash : dummyHash();
  const pw = typeof password === "string" ? password : "";
  const ok = verifyPassword(stored, pw) && user !== null;
  if (!ok) {
    if (name) limiter.recordFailure(`login-user:${name}`, LOGIN_WINDOW_SEC);
    throw new ApiError(401, "INVALID_CREDENTIALS", "Wrong username or password.");
  }
  if (name) limiter.clear(`login-user:${name}`);
  return publicUser(user!);
}

export async function loadUser(storage: Storage, uid: string | undefined): Promise<PublicUser | null> {
  if (!uid) return null;
  try {
    paths.userId(uid);
  } catch {
    return null;
  }
  const got = await storage.read(paths.userPath(uid));
  return got ? publicUser(JSON.parse(got.data.toString("utf8"))) : null;
}

export async function bestEffortDelete(storage: Storage, path: string, message: string): Promise<void> {
  try {
    const got = await storage.read(path);
    if (got) await storage.delete(path, got.sha, message);
  } catch {
    // Best effort only. The original error is what the caller reports.
  }
}
