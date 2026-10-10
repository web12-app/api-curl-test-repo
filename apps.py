"""Applications, API keys, and request principals.

A principal is who the request acts as:
  * KeyPrincipal  - an application API key. Bound to one app and to explicit scopes.
  * UserPrincipal - a logged-in user (session cookie). Owners get every scope on their own apps.

Application access is always checked against the stored owner or key binding, never against
client-supplied paths.
"""
import hashlib
import hmac
import json
import re
import secrets
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from flask import request, session

import paths
from errors import ApiError
from storage import Conflict, NotFound, json_bytes

SCOPES = ("db:read", "db:write", "files:read", "files:write")
ENVIRONMENTS = ("development", "production")
KEY_TOUCH_INTERVAL = timedelta(hours=1)


@dataclass
class KeyPrincipal:
    app_id: str
    key_id: str
    scopes: tuple


@dataclass
class UserPrincipal:
    user_id: str


# ---------------------------------------------------------------- keys
def _hash_secret(secret: str, pepper: str) -> str:
    return hmac.new(pepper.encode(), secret.encode(), hashlib.sha256).hexdigest()


def _now_dt():
    return datetime.now(timezone.utc)


def _iso(dt):
    return dt.isoformat()


def _parse_dt(s):
    return datetime.fromisoformat(s) if s else None


def create_key(storage, pepper, aid, name, environment, scopes, expires_in_days=None):
    if environment not in ENVIRONMENTS:
        raise ApiError(400, "INVALID_ENVIRONMENT", "environment must be development or production.")
    if not isinstance(scopes, list) or not scopes or any(s not in SCOPES for s in scopes):
        raise ApiError(400, "INVALID_SCOPES", f"scopes must be a non-empty list of: {', '.join(SCOPES)}.")
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 80):
        raise ApiError(400, "INVALID_NAME", "Key name must be 1-80 characters.")
    expires_at = None
    if expires_in_days is not None:
        if not isinstance(expires_in_days, int) or not (1 <= expires_in_days <= 365):
            raise ApiError(400, "INVALID_EXPIRY", "expires_in_days must be between 1 and 365.")
        expires_at = _iso(_now_dt() + timedelta(days=expires_in_days))

    kid = paths.new_id()
    secret = secrets.token_urlsafe(32)  # 43 url-safe chars, contains no "."
    record = {
        "id": kid, "name": name.strip(), "environment": environment,
        "scopes": sorted(set(scopes)), "hash": _hash_secret(secret, pepper),
        "created_at": _iso(_now_dt()), "last_used_at": None,
        "expires_at": expires_at, "revoked_at": None,
    }
    storage.write(paths.key_path(aid, kid), json_bytes(record), f"create api key {kid}")
    public = _public_key(record)
    # The full key is returned only once. It is never stored, logged, or shown again.
    public["api_key"] = f"{aid}.{kid}.{secret}"
    return public


def _public_key(rec):
    return {k: rec.get(k) for k in ("id", "name", "environment", "scopes", "created_at",
                                    "last_used_at", "expires_at", "revoked_at")}


def list_keys(storage, aid):
    out = []
    for item in storage.list(paths.key_dir(aid)):
        if item["type"] != "file":
            continue
        got = storage.read(f"{paths.key_dir(aid)}/{item['name']}")
        if got:
            out.append(_public_key(json.loads(got[0])))
    return out


def revoke_key(storage, aid, kid):
    path = paths.key_path(aid, kid)
    got = storage.read(path)
    if got is None:
        raise ApiError(404, "NOT_FOUND", "API key not found.")
    rec = json.loads(got[0])
    if rec.get("revoked_at"):
        return _public_key(rec)
    rec["revoked_at"] = _iso(_now_dt())
    storage.write(path, json_bytes(rec), f"revoke api key {kid}", sha=got[1])
    return _public_key(rec)


def verify_key(storage, pepper, raw_key):
    """Return a KeyPrincipal, or None if the key is malformed, unknown, revoked, or expired."""
    parts = (raw_key or "").split(".")
    if len(parts) != 3:
        return None
    aid, kid, secret = parts
    try:
        paths.app_id(aid)
        paths.record_id(kid)
    except ApiError:
        return None
    got = storage.read(paths.key_path(aid, kid))
    if got is None:
        return None
    rec, sha = json.loads(got[0]), got[1]
    if rec.get("revoked_at"):
        return None
    exp = _parse_dt(rec.get("expires_at"))
    if exp and exp <= _now_dt():
        return None
    if not hmac.compare_digest(rec["hash"], _hash_secret(secret, pepper)):
        return None
    _touch_key(storage, aid, kid, rec, sha)
    return KeyPrincipal(app_id=aid, key_id=kid, scopes=tuple(rec["scopes"]))


def _touch_key(storage, aid, kid, rec, sha):
    """Record last use at most once per interval. Best effort: a failed update never blocks a request."""
    last = _parse_dt(rec.get("last_used_at"))
    if last and _now_dt() - last < KEY_TOUCH_INTERVAL:
        return
    rec["last_used_at"] = _iso(_now_dt())
    try:
        storage.write(paths.key_path(aid, kid), json_bytes(rec), f"touch api key {kid}", sha=sha)
    except (Conflict, NotFound):
        pass


# ---------------------------------------------------------------- apps
def _slug(name):
    s = re.sub(r"[^a-z0-9]+", "-", name.lower()).strip("-")[:33].strip("-")
    if not s or not s[0].isalpha():
        s = "app-" + s
    return s[:33].rstrip("-") or "app"


def create_app(storage, owner_id, name, description=""):
    if not isinstance(name, str) or not (1 <= len(name.strip()) <= 80):
        raise ApiError(400, "INVALID_NAME", "App name must be 1-80 characters.")
    if description is None:
        description = ""
    if not isinstance(description, str) or len(description) > 500:
        raise ApiError(400, "INVALID_DESCRIPTION", "Description must be at most 500 characters.")
    for _ in range(3):
        aid = f"{_slug(name)}-{secrets.token_hex(3)}"
        meta = {"id": aid, "name": name.strip(), "description": description,
                "owner_id": owner_id, "status": "active",
                "created_at": _iso(_now_dt()), "updated_at": _iso(_now_dt())}
        try:
            storage.write(paths.app_meta_path(aid), json_bytes(meta), f"create app {aid}")
        except Conflict:
            continue
        storage.write(paths.owner_index_path(owner_id, aid), json_bytes({"app_id": aid}),
                      f"index app {aid}")
        return meta
    raise ApiError(503, "RETRY_LATER", "Could not allocate an app id. Try again.")


def load_app(storage, aid):
    got = storage.read(paths.app_meta_path(aid))
    return json.loads(got[0]) if got else None


def load_owned_app(storage, owner_id, aid):
    """Owner-only access. Returns the app, or 404 for anything else (no existence leak)."""
    try:
        paths.app_id(aid)
    except ApiError:
        raise ApiError(404, "NOT_FOUND", "App not found.")
    app = load_app(storage, aid)
    if app is None or app.get("owner_id") != owner_id or app.get("status") != "active":
        raise ApiError(404, "NOT_FOUND", "App not found.")
    return app


def list_owned_apps(storage, owner_id, limit=100):
    out = []
    for item in storage.list(paths.owner_index_dir(owner_id))[:limit]:
        if item["type"] != "file":
            continue
        got = storage.read(f"{paths.owner_index_dir(owner_id)}/{item['name']}")
        if not got:
            continue
        aid = json.loads(got[0]).get("app_id")
        app = load_app(storage, aid) if aid else None
        if app and app.get("owner_id") == owner_id and app.get("status") == "active":
            out.append(app)
    return out


def update_app(storage, owner_id, aid, changes):
    app = load_owned_app(storage, owner_id, aid)
    allowed = {"name", "description"}
    if not changes or set(changes) - allowed:
        raise ApiError(400, "INVALID_FIELDS", "Only name and description can be changed.")
    if "name" in changes:
        if not isinstance(changes["name"], str) or not (1 <= len(changes["name"].strip()) <= 80):
            raise ApiError(400, "INVALID_NAME", "App name must be 1-80 characters.")
        app["name"] = changes["name"].strip()
    if "description" in changes:
        d = changes["description"] or ""
        if not isinstance(d, str) or len(d) > 500:
            raise ApiError(400, "INVALID_DESCRIPTION", "Description must be at most 500 characters.")
        app["description"] = d
    app["updated_at"] = _iso(_now_dt())
    got = storage.read(paths.app_meta_path(aid))
    storage.write(paths.app_meta_path(aid), json_bytes(app), f"update app {aid}", sha=got[1])
    return app


def delete_app(storage, pepper, owner_id, aid, confirm):
    """Soft delete: the app is hidden, every key is revoked, and data is kept.

    Hard purge of repository data is intentionally not automatic. It needs a separate, explicit
    administrator action.
    """
    app = load_owned_app(storage, owner_id, aid)
    if confirm != aid:
        raise ApiError(400, "CONFIRMATION_REQUIRED",
                       "Send {\"confirm\": \"<app_id>\"} to delete this app.")
    for k in list_keys(storage, aid):
        if not k.get("revoked_at"):
            revoke_key(storage, aid, k["id"])
    got = storage.read(paths.app_meta_path(aid))
    app["status"] = "deleted"
    app["deleted_at"] = _iso(_now_dt())
    storage.write(paths.app_meta_path(aid), json_bytes(app), f"delete app {aid}", sha=got[1])
    try:
        idx = storage.read(paths.owner_index_path(owner_id, aid))
        if idx:
            storage.delete(paths.owner_index_path(owner_id, aid), idx[1], f"unindex app {aid}")
    except (Conflict, NotFound):
        pass
    return {"id": aid, "status": "deleted"}


# ---------------------------------------------------------------- principals
def current_principal(storage, pepper):
    """Identify the caller from Authorization (preferred) or X-API-Key. Falls back to the session."""
    auth = request.headers.get("Authorization", "")
    raw = None
    if auth.lower().startswith("bearer "):
        raw = auth[7:].strip()
    elif request.headers.get("X-API-Key"):
        raw = request.headers.get("X-API-Key", "").strip()
    if raw:
        kp = verify_key(storage, pepper, raw)
        if kp is None:
            raise ApiError(401, "INVALID_API_KEY", "Invalid, revoked, or expired API key.")
        return kp
    uid = session.get("uid")
    if uid:
        return UserPrincipal(user_id=uid)
    return None


def require_principal(storage, pepper):
    p = current_principal(storage, pepper)
    if p is None:
        raise ApiError(401, "UNAUTHENTICATED", "Log in or send an API key.")
    return p


def require_app_scope(storage, principal, aid, scope):
    """Authorize an action on an app. Returns the app metadata."""
    if isinstance(principal, KeyPrincipal):
        if principal.app_id != aid:
            raise ApiError(403, "PERMISSION_DENIED", "This API key cannot access that app.")
        if scope not in principal.scopes:
            raise ApiError(403, "PERMISSION_DENIED", "This API key does not have the required permission.")
        app = load_app(storage, aid)
        if app is None or app.get("status") != "active":
            raise ApiError(404, "NOT_FOUND", "App not found.")
        return app
    if isinstance(principal, UserPrincipal):
        return load_owned_app(storage, principal.user_id, aid)
    raise ApiError(401, "UNAUTHENTICATED", "Log in or send an API key.")
