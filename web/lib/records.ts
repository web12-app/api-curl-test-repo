/**
 * Database records: structured JSON documents stored one file per record.
 *
 * Layout: apps/<app_id>/database/collections/<collection>/<record_id>.json
 *
 * Concurrency:
 *   - Each stored record has an integer "version" that increments on every write.
 *   - Clients may send If-Match: <version> (or "expected_version" in the body). A mismatch is 409.
 *   - Independently, storage requires the current blob sha, so two writers cannot both succeed on
 *     the same record (the loser gets 409 and must reload).
 *   - Batch operations across records are not transactional.
 *
 * Limits: record payload size is capped by MAX_RECORD_BYTES. Listing reads one file per record on
 * the page, so keep page sizes small.
 */
import { ApiError } from "./errors";
import * as paths from "./paths";
import { jsonBytes, type Storage } from "./storage";
import { isPlainObject, nowIso, parseIntStrict } from "./util";

export const MAX_PAGE = 100;
export const DEFAULT_PAGE = 20;

interface RecordDoc {
  id: string;
  collection: string;
  version: number;
  created_at: string;
  updated_at: string;
  data: Record<string, any>;
}

function checkPayload(data: unknown, maxBytes: number): Record<string, any> {
  if (!isPlainObject(data)) throw new ApiError(400, "INVALID_BODY", "The body must be a JSON object.");
  const size = Buffer.byteLength(JSON.stringify(data));
  if (size > maxBytes) {
    throw new ApiError(413, "RECORD_TOO_LARGE", `Record is larger than the ${maxBytes}-byte limit.`);
  }
  return data;
}

function publicRecord(rec: RecordDoc) {
  return {
    id: rec.id,
    collection: rec.collection,
    version: rec.version,
    created_at: rec.created_at,
    updated_at: rec.updated_at,
    data: rec.data,
  };
}

async function load(storage: Storage, aid: string, coll: string, rid: string): Promise<{ rec: RecordDoc; sha: string }> {
  const got = await storage.read(paths.recordPath(aid, coll, rid));
  if (!got) throw new ApiError(404, "NOT_FOUND", "Record not found.");
  return { rec: JSON.parse(got.data.toString("utf8")), sha: got.sha };
}

export async function create(storage: Storage, maxBytes: number, aid: string, coll: string, data: unknown) {
  checkPayload(data, maxBytes);
  const rid = paths.newId();
  const now = nowIso();
  const rec: RecordDoc = { id: rid, collection: coll, version: 1, created_at: now, updated_at: now, data: data as Record<string, any> };
  await storage.write(paths.recordPath(aid, coll, rid), jsonBytes(rec), `create record ${rid}`);
  return publicRecord(rec);
}

export async function get(storage: Storage, aid: string, coll: string, rid: string) {
  const { rec } = await load(storage, aid, coll, rid);
  return publicRecord(rec);
}

export async function listPage(storage: Storage, aid: string, coll: string, limit: unknown = DEFAULT_PAGE, cursor: unknown = 0) {
  const lim = parseIntStrict(limit);
  const cur = parseIntStrict(cursor);
  if (lim === null || cur === null) {
    throw new ApiError(400, "INVALID_PAGINATION", "limit and cursor must be integers.");
  }
  if (lim < 1 || lim > MAX_PAGE || cur < 0) {
    throw new ApiError(400, "INVALID_PAGINATION", `limit must be 1-${MAX_PAGE} and cursor must be 0 or more.`);
  }
  const names = (await storage.list(paths.recordDir(aid, coll)))
    .filter((i) => i.type === "file" && i.name.endsWith(".json"))
    .map((i) => i.name)
    .sort();
  const items = [];
  for (const name of names.slice(cur, cur + lim)) {
    const got = await storage.read(`${paths.recordDir(aid, coll)}/${name}`);
    if (got) items.push(publicRecord(JSON.parse(got.data.toString("utf8"))));
  }
  const next = cur + lim < names.length ? cur + lim : null;
  return { items, next_cursor: next, limit: lim };
}

/**
 * Return [payload, expected_version] for {"data": {...}, "expected_version": n} bodies.
 * Any other object is the payload itself, so a record may contain a field named "data".
 */
export function unwrapEnvelope(body: unknown): [unknown, unknown] {
  if (isPlainObject(body) && "data" in body && isPlainObject(body.data)) {
    const extra = Object.keys(body).filter((k) => k !== "data" && k !== "expected_version");
    if (extra.length === 0) return [body.data, body.expected_version];
  }
  return [body, undefined];
}

function parseExpected(v: unknown): number | null {
  if (v === undefined || v === null || v === "") return null;
  const n = parseIntStrict(String(v).trim().replace(/^"+|"+$/g, ""));
  if (n === null || n < 1) throw new ApiError(400, "INVALID_VERSION", "The expected version must be an integer.");
  return n;
}

function checkVersion(stored: number, expected: number | null): void {
  if (expected !== null && expected !== stored) {
    throw new ApiError(409, "VERSION_CONFLICT", `The record is at version ${stored}. Reload and try again.`);
  }
}

export async function replace(storage: Storage, maxBytes: number, aid: string, coll: string, rid: string, data: unknown, expected?: unknown) {
  checkPayload(data, maxBytes);
  const { rec, sha } = await load(storage, aid, coll, rid);
  checkVersion(rec.version, parseExpected(expected));
  rec.data = data as Record<string, any>;
  rec.version += 1;
  rec.updated_at = nowIso();
  await storage.write(paths.recordPath(aid, coll, rid), jsonBytes(rec), `replace record ${rid}`, sha);
  return publicRecord(rec);
}

export async function patch(storage: Storage, maxBytes: number, aid: string, coll: string, rid: string, changes: unknown, expected?: unknown) {
  if (!isPlainObject(changes)) throw new ApiError(400, "INVALID_BODY", "The body must be a JSON object.");
  const { rec, sha } = await load(storage, aid, coll, rid);
  checkVersion(rec.version, parseExpected(expected));
  const merged: Record<string, any> = { ...rec.data };
  for (const [k, v] of Object.entries(changes)) {
    if (v === null) delete merged[k]; // null removes a field, JSON-merge-patch style
    else merged[k] = v;
  }
  checkPayload(merged, maxBytes);
  rec.data = merged;
  rec.version += 1;
  rec.updated_at = nowIso();
  await storage.write(paths.recordPath(aid, coll, rid), jsonBytes(rec), `patch record ${rid}`, sha);
  return publicRecord(rec);
}

export async function remove(storage: Storage, aid: string, coll: string, rid: string, expected?: unknown) {
  const { rec, sha } = await load(storage, aid, coll, rid);
  checkVersion(rec.version, parseExpected(expected));
  await storage.delete(paths.recordPath(aid, coll, rid), sha, `delete record ${rid}`);
  return { id: rid, deleted: true };
}
