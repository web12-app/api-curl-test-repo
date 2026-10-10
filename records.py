"""Database records: structured JSON documents stored one file per record.

Layout: apps/<app_id>/database/collections/<collection>/<record_id>.json

Concurrency:
  * Every stored record has a integer "version" that increments on each write.
  * Clients may send If-Match: <version> (or "expected_version" in the body). A mismatch returns 409.
  * Independently, the storage layer requires the current blob sha, so two writers cannot both
    succeed on the same record (the loser gets 409 and must reload).
  * Batch operations across records are not transactional.

Limits: record payload size is capped by MAX_RECORD_BYTES. Listing reads one file per record
on the page, so keep page sizes small.
"""
import json
from datetime import datetime, timezone

import paths
from errors import ApiError
from storage import json_bytes

MAX_PAGE = 100
DEFAULT_PAGE = 20


def _now():
    return datetime.now(timezone.utc).isoformat()


def _check_payload(data, max_bytes):
    if not isinstance(data, dict):
        raise ApiError(400, "INVALID_BODY", "The body must be a JSON object.")
    size = len(json_bytes(data))
    if size > max_bytes:
        raise ApiError(413, "RECORD_TOO_LARGE", f"Record is larger than the {max_bytes}-byte limit.")
    return data


def _public(rec):
    return {"id": rec["id"], "collection": rec["collection"], "version": rec["version"],
            "created_at": rec["created_at"], "updated_at": rec["updated_at"], "data": rec["data"]}


def _load(storage, aid, coll, rid):
    got = storage.read(paths.record_path(aid, coll, rid))
    if got is None:
        raise ApiError(404, "NOT_FOUND", "Record not found.")
    return json.loads(got[0]), got[1]


def create(storage, max_bytes, aid, coll, data):
    _check_payload(data, max_bytes)
    rid = paths.new_id()
    now = _now()
    rec = {"id": rid, "collection": coll, "version": 1, "created_at": now, "updated_at": now, "data": data}
    storage.write(paths.record_path(aid, coll, rid), json_bytes(rec), f"create record {rid}")
    return _public(rec)


def get(storage, aid, coll, rid):
    rec, _ = _load(storage, aid, coll, rid)
    return _public(rec)


def list_page(storage, aid, coll, limit=DEFAULT_PAGE, cursor=0):
    try:
        limit = int(limit)
        cursor = int(cursor)
    except (TypeError, ValueError):
        raise ApiError(400, "INVALID_PAGINATION", "limit and cursor must be integers.")
    if not (1 <= limit <= MAX_PAGE) or cursor < 0:
        raise ApiError(400, "INVALID_PAGINATION", f"limit must be 1-{MAX_PAGE} and cursor must be 0 or more.")
    names = sorted(i["name"] for i in storage.list(paths.record_dir(aid, coll))
                   if i["type"] == "file" and i["name"].endswith(".json"))
    page = names[cursor:cursor + limit]
    items = []
    for name in page:
        got = storage.read(f"{paths.record_dir(aid, coll)}/{name}")
        if got:
            items.append(_public(json.loads(got[0])))
    next_cursor = cursor + limit if cursor + limit < len(names) else None
    return {"items": items, "next_cursor": next_cursor, "limit": limit}


def _check_version(stored_version, expected):
    if expected is not None and int(expected) != stored_version:
        raise ApiError(409, "VERSION_CONFLICT",
                       f"The record is at version {stored_version}. Reload and try again.")


def _parse_expected(v):
    if v is None or v == "":
        return None
    try:
        n = int(str(v).strip().strip('"'))
    except ValueError:
        raise ApiError(400, "INVALID_VERSION", "The expected version must be an integer.")
    if n < 1:
        raise ApiError(400, "INVALID_VERSION", "The expected version must be an integer.")
    return n


def replace(storage, max_bytes, aid, coll, rid, data, expected=None):
    _check_payload(data, max_bytes)
    rec, sha = _load(storage, aid, coll, rid)
    _check_version(rec["version"], _parse_expected(expected))
    rec.update({"data": data, "version": rec["version"] + 1, "updated_at": _now()})
    storage.write(paths.record_path(aid, coll, rid), json_bytes(rec), f"replace record {rid}", sha=sha)
    return _public(rec)


def patch(storage, max_bytes, aid, coll, rid, changes, expected=None):
    if not isinstance(changes, dict):
        raise ApiError(400, "INVALID_BODY", "The body must be a JSON object.")
    rec, sha = _load(storage, aid, coll, rid)
    _check_version(rec["version"], _parse_expected(expected))
    merged = dict(rec["data"])
    for k, v in changes.items():
        if v is None:
            merged.pop(k, None)   # null removes a field, JSON-merge-patch style
        else:
            merged[k] = v
    _check_payload(merged, max_bytes)
    rec.update({"data": merged, "version": rec["version"] + 1, "updated_at": _now()})
    storage.write(paths.record_path(aid, coll, rid), json_bytes(rec), f"patch record {rid}", sha=sha)
    return _public(rec)


def delete(storage, aid, coll, rid, expected=None):
    rec, sha = _load(storage, aid, coll, rid)
    _check_version(rec["version"], _parse_expected(expected))
    storage.delete(paths.record_path(aid, coll, rid), sha, f"delete record {rid}")
    return {"id": rid, "deleted": True}
