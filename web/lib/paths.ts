/**
 * Validated identifiers and repository path builders.
 *
 * Clients never supply repository paths. Every path is built here from IDs that passed validation.
 */
import { randomBytes } from "node:crypto";
import { ApiError } from "./errors";

const APP_ID_RE = /^[a-z][a-z0-9-]{2,39}$/;
const HEX24_RE = /^[a-f0-9]{24}$/;
const COLLECTION_RE = /^[a-z][a-z0-9_-]{0,47}$/;
const USERNAME_RE = /^[a-z0-9_]{3,32}$/;
const FILENAME_RE = /^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$/;

export function newId(): string {
  return randomBytes(12).toString("hex");
}

function check(value: unknown, re: RegExp, code: string, message: string): string {
  if (typeof value !== "string" || !re.test(value)) {
    throw new ApiError(400, code, message);
  }
  return value;
}

export const appId = (v: unknown) => check(v, APP_ID_RE, "INVALID_APP_ID", "Invalid app id.");
export const userId = (v: unknown) => check(v, HEX24_RE, "INVALID_USER_ID", "Invalid user id.");
export const recordId = (v: unknown) => check(v, HEX24_RE, "INVALID_RECORD_ID", "Invalid record id.");
export const fileId = (v: unknown) => check(v, HEX24_RE, "INVALID_FILE_ID", "Invalid file id.");
export const collection = (v: unknown) => check(v, COLLECTION_RE, "INVALID_COLLECTION", "Invalid collection name.");
export const username = (v: unknown) =>
  check(v, USERNAME_RE, "INVALID_USERNAME", "Username must be 3-32 lowercase letters, digits, or underscores.");

/** Reduce a client-supplied filename to a safe display name. The stored path never uses it. */
export function safeFilename(raw: string | null | undefined): string {
  const base = (raw ?? "").replace(/\\/g, "/").split("/").pop()!.trim();
  const name = base && FILENAME_RE.test(base) ? base : "file";
  return name.slice(0, 120);
}

// ---------------------------------------------------------------- repository paths
export const userPath = (uid: string) => `users/${userId(uid)}.json`;
export const usernameIndexPath = (name: string) => `system/usernames/${username(name)}.json`;
export const ownerIndexPath = (uid: string, aid: string) => `system/owners/${userId(uid)}/${appId(aid)}.json`;
export const ownerIndexDir = (uid: string) => `system/owners/${userId(uid)}`;
export const appMetaPath = (aid: string) => `apps/${appId(aid)}/metadata.json`;
export const keyPath = (aid: string, kid: string) => `apps/${appId(aid)}/api_keys/${recordId(kid)}.json`;
export const keyDir = (aid: string) => `apps/${appId(aid)}/api_keys`;
export const recordDir = (aid: string, coll: string) => `apps/${appId(aid)}/database/collections/${collection(coll)}`;
export const recordPath = (aid: string, coll: string, rid: string) => `${recordDir(aid, coll)}/${recordId(rid)}.json`;
export const fileMetaPath = (aid: string, fid: string) => `apps/${appId(aid)}/files/meta/${fileId(fid)}.json`;
export const fileMetaDir = (aid: string) => `apps/${appId(aid)}/files/meta`;
export const fileBlobPath = (aid: string, fid: string) => `apps/${appId(aid)}/files/blobs/${fileId(fid)}.bin`;
