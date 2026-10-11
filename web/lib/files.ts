/**
 * App-scoped file storage.
 *
 * Each file has metadata (apps/<app>/files/meta/<id>.json) and content
 * (apps/<app>/files/blobs/<id>.bin). Ids are server generated. The client filename is only a
 * display name and is never used in a repository path.
 *
 * Limits: content is capped by MAX_FILE_BYTES (the Contents API does not return content for files
 * over about 1 MB), so large files are rejected instead of streamed.
 */
import { createHash } from "node:crypto";
import { ApiError } from "./errors";
import * as paths from "./paths";
import { jsonBytes, NotFound, type Storage } from "./storage";
import { nowIso, parseIntStrict } from "./util";

// Only these types are ever served with their own type. Everything else is octet-stream.
const SAFE_TYPES: Record<string, string> = {
  ".txt": "text/plain",
  ".csv": "text/csv",
  ".json": "application/json",
  ".pdf": "application/pdf",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};
export const MAX_LIST = 100;

export function contentType(name: string): string {
  const dot = name.lastIndexOf(".");
  const ext = dot >= 0 ? name.slice(dot).toLowerCase() : "";
  return SAFE_TYPES[ext] ?? "application/octet-stream";
}

interface FileMeta {
  id: string;
  name: string;
  size: number;
  content_type: string;
  sha256: string;
  created_at: string;
  created_by: string;
}

function publicMeta(m: FileMeta) {
  return { id: m.id, name: m.name, size: m.size, content_type: m.content_type, sha256: m.sha256, created_at: m.created_at };
}

export async function upload(storage: Storage, maxBytes: number, aid: string, displayName: string, data: Buffer, createdBy: string) {
  if (data.length === 0) throw new ApiError(400, "EMPTY_FILE", "The file is empty.");
  if (data.length > maxBytes) throw new ApiError(413, "FILE_TOO_LARGE", `File is larger than the ${maxBytes}-byte limit.`);
  const fid = paths.newId();
  const name = paths.safeFilename(displayName);
  const meta: FileMeta = {
    id: fid,
    name,
    size: data.length,
    content_type: contentType(name),
    sha256: createHash("sha256").update(data).digest("hex"),
    created_at: nowIso(),
    created_by: createdBy,
  };
  await storage.write(paths.fileBlobPath(aid, fid), data, `store file ${fid}`);
  try {
    await storage.write(paths.fileMetaPath(aid, fid), jsonBytes(meta), `file metadata ${fid}`);
  } catch (e) {
    await tryDelete(storage, paths.fileBlobPath(aid, fid), `rollback file ${fid}`);
    throw e;
  }
  return publicMeta(meta);
}

async function tryDelete(storage: Storage, path: string, message: string): Promise<void> {
  try {
    const got = await storage.read(path);
    if (got) await storage.delete(path, got.sha, message);
  } catch {
    // Best effort. The caller reports the original error.
  }
}

export async function getMeta(storage: Storage, aid: string, fid: string): Promise<FileMeta> {
  const got = await storage.read(paths.fileMetaPath(aid, fid));
  if (!got) throw new ApiError(404, "NOT_FOUND", "File not found.");
  return JSON.parse(got.data.toString("utf8"));
}

export async function getPublic(storage: Storage, aid: string, fid: string) {
  return publicMeta(await getMeta(storage, aid, fid));
}

export async function listFiles(storage: Storage, aid: string, limit: unknown = 50, cursor: unknown = 0) {
  const lim = parseIntStrict(limit);
  const cur = parseIntStrict(cursor);
  if (lim === null || cur === null) throw new ApiError(400, "INVALID_PAGINATION", "limit and cursor must be integers.");
  if (lim < 1 || lim > MAX_LIST || cur < 0) {
    throw new ApiError(400, "INVALID_PAGINATION", `limit must be 1-${MAX_LIST}.`);
  }
  const names = (await storage.list(paths.fileMetaDir(aid)))
    .filter((i) => i.type === "file" && i.name.endsWith(".json"))
    .map((i) => i.name)
    .sort();
  const items = [];
  for (const name of names.slice(cur, cur + lim)) {
    const got = await storage.read(`${paths.fileMetaDir(aid)}/${name}`);
    if (got) items.push(publicMeta(JSON.parse(got.data.toString("utf8"))));
  }
  const next = cur + lim < names.length ? cur + lim : null;
  return { items, next_cursor: next, limit: lim };
}

export async function readContent(storage: Storage, aid: string, fid: string): Promise<{ meta: FileMeta; data: Buffer }> {
  const meta = await getMeta(storage, aid, fid);
  const got = await storage.read(paths.fileBlobPath(aid, fid));
  if (!got) throw new ApiError(404, "NOT_FOUND", "File content not found.");
  return { meta, data: got.data };
}

export async function remove(storage: Storage, aid: string, fid: string) {
  await getMeta(storage, aid, fid);
  const blob = await storage.read(paths.fileBlobPath(aid, fid));
  if (blob) await storage.delete(paths.fileBlobPath(aid, fid), blob.sha, `delete file ${fid}`);
  const meta = await storage.read(paths.fileMetaPath(aid, fid));
  if (meta) {
    try {
      await storage.delete(paths.fileMetaPath(aid, fid), meta.sha, `delete file meta ${fid}`);
    } catch (e) {
      if (!(e instanceof NotFound)) throw e;
    }
  }
  return { id: fid, deleted: true };
}
