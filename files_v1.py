"""App-scoped file storage.

Each file has metadata (apps/<app>/files/meta/<id>.json) and content
(apps/<app>/files/blobs/<id>.bin). Ids are server generated. The client filename is only a
display name and is never used in a repository path.

Limits: content is capped by MAX_FILE_BYTES (the Contents API does not return content for files
over about 1 MB), so large files are rejected instead of streamed.
"""
import hashlib
import json
import mimetypes
from datetime import datetime, timezone

import paths
from errors import ApiError
from storage import NotFound, TooLarge, json_bytes

# Only these types are ever served with their own type. Everything else is octet-stream.
SAFE_TYPES = {
    ".txt": "text/plain", ".csv": "text/csv", ".json": "application/json",
    ".pdf": "application/pdf", ".png": "image/png", ".jpg": "image/jpeg",
    ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
}
MAX_LIST = 100


def _now():
    return datetime.now(timezone.utc).isoformat()


def _content_type(name):
    ext = "." + name.rsplit(".", 1)[-1].lower() if "." in name else ""
    return SAFE_TYPES.get(ext, "application/octet-stream")


def _public(meta):
    return {k: meta[k] for k in ("id", "name", "size", "content_type", "sha256", "created_at")}


def upload(storage, max_bytes, aid, display_name, data, created_by):
    if len(data) == 0:
        raise ApiError(400, "EMPTY_FILE", "The file is empty.")
    if len(data) > max_bytes:
        raise ApiError(413, "FILE_TOO_LARGE", f"File is larger than the {max_bytes}-byte limit.")
    fid = paths.new_id()
    name = paths.safe_filename(display_name)
    meta = {"id": fid, "name": name, "size": len(data), "content_type": _content_type(name),
            "sha256": hashlib.sha256(data).hexdigest(), "created_at": _now(), "created_by": created_by}
    storage.write(paths.file_blob_path(aid, fid), data, f"store file {fid}")
    try:
        storage.write(paths.file_meta_path(aid, fid), json_bytes(meta), f"file metadata {fid}")
    except Exception:
        _try_delete(storage, paths.file_blob_path(aid, fid), f"rollback file {fid}")
        raise
    return _public(meta)


def _try_delete(storage, path, message):
    try:
        got = storage.read(path)
        if got is not None:
            storage.delete(path, got[1], message)
    except Exception:
        pass


def get_meta(storage, aid, fid):
    got = storage.read(paths.file_meta_path(aid, fid))
    if got is None:
        raise ApiError(404, "NOT_FOUND", "File not found.")
    return json.loads(got[0])


def get_public(storage, aid, fid):
    return _public(get_meta(storage, aid, fid))


def list_files(storage, aid, limit=50, cursor=0):
    try:
        limit, cursor = int(limit), int(cursor)
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_PAGINATION", "limit and cursor must be integers.")
    if not (1 <= limit <= MAX_LIST) or cursor < 0:
        raise ApiError(400, "INVALID_PAGINATION", f"limit must be 1-{MAX_LIST}.")
    names = sorted(i["name"] for i in storage.list(paths.file_meta_dir(aid))
                   if i["type"] == "file" and i["name"].endswith(".json"))
    items = []
    for name in names[cursor:cursor + limit]:
        got = storage.read(f"{paths.file_meta_dir(aid)}/{name}")
        if got:
            items.append(_public(json.loads(got[0])))
    next_cursor = cursor + limit if cursor + limit < len(names) else None
    return {"items": items, "next_cursor": next_cursor, "limit": limit}


def read_content(storage, max_bytes, aid, fid):
    meta = get_meta(storage, aid, fid)
    try:
        got = storage.read(paths.file_blob_path(aid, fid))
    except TooLarge:
        raise
    if got is None:
        raise ApiError(404, "NOT_FOUND", "File content not found.")
    return meta, got[0]


def delete(storage, aid, fid):
    meta = get_meta(storage, aid, fid)
    blob = storage.read(paths.file_blob_path(aid, fid))
    if blob is not None:
        storage.delete(paths.file_blob_path(aid, fid), blob[1], f"delete file {fid}")
    m = storage.read(paths.file_meta_path(aid, fid))
    if m is not None:
        storage.delete(paths.file_meta_path(aid, fid), m[1], f"delete file meta {fid}")
    return {"id": fid, "deleted": True}
