"""User accounts: signup, password verification, and login rate limiting.

Users are stored by stable user id: users/<user_id>.json. Usernames map to ids through
system/usernames/<username>.json, which is created with "no sha" so two signups for the same
name cannot both succeed.
"""
import json
import threading
import time
from collections import defaultdict, deque
from datetime import datetime, timezone

from werkzeug.security import check_password_hash, generate_password_hash

import paths
from errors import ApiError
from storage import Conflict, json_bytes

MIN_PASSWORD = 8
MAX_PASSWORD = 200


class RateLimiter:
    """Sliding-window limiter kept in process memory.

    Limits reset on restart and are per process. Use a shared store (Redis) if the backend
    runs with more than one worker or instance.
    """

    def __init__(self):
        self._hits = defaultdict(deque)
        self._lock = threading.Lock()

    def allow(self, key, limit, window_seconds):
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window_seconds:
                q.popleft()
            if len(q) >= limit:
                return False
            q.append(now)
            return True

    def record_failure(self, key, window_seconds):
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            while q and now - q[0] > window_seconds:
                q.popleft()
            q.append(now)

    def count(self, key, window_seconds):
        now = time.monotonic()
        with self._lock:
            q = self._hits[key]
            return sum(1 for t in q if now - t <= window_seconds)

    def clear(self, key):
        with self._lock:
            self._hits.pop(key, None)


limiter = RateLimiter()
LOGIN_WINDOW = 15 * 60
LOGIN_FAILURES_PER_USER = 5
LOGIN_ATTEMPTS_PER_IP = 30


def validate_credentials(username, password):
    name = paths.username((username or "").strip().lower())
    if not isinstance(password, str) or not (MIN_PASSWORD <= len(password) <= MAX_PASSWORD):
        raise ApiError(400, "INVALID_PASSWORD",
                       f"Password must be {MIN_PASSWORD}-{MAX_PASSWORD} characters.")
    return name


def create_user(storage, username, password):
    name = validate_credentials(username, password)
    uid = paths.new_id()
    try:
        # Claim the username first. Without a sha, GitHub (and MemoryStorage) refuse to overwrite.
        storage.write(paths.username_index_path(name), json_bytes({"user_id": uid}),
                      f"claim username {name}")
    except Conflict:
        raise ApiError(409, "USERNAME_TAKEN", "That username is already taken.")
    user = {"id": uid, "username": name,
            "password_hash": generate_password_hash(password),
            "created_at": _now()}
    try:
        storage.write(paths.user_path(uid), json_bytes(user), f"create user {uid}")
    except Exception:
        _best_effort_delete(storage, paths.username_index_path(name), f"rollback username {name}")
        raise
    return public_user(user)


def authenticate(storage, username, password, ip):
    """Check credentials and rate limits. Returns the public user dict or raises ApiError."""
    try:
        name = paths.username((username or "").strip().lower())
    except ApiError:
        name = None
    if not limiter.allow(f"login-ip:{ip}", LOGIN_ATTEMPTS_PER_IP, LOGIN_WINDOW):
        raise ApiError(429, "RATE_LIMITED", "Too many login attempts. Try again later.")
    if name and limiter.count(f"login-user:{name}", LOGIN_WINDOW) >= LOGIN_FAILURES_PER_USER:
        raise ApiError(429, "RATE_LIMITED", "Too many failed logins for this account. Try again later.")

    user = None
    if name:
        idx = storage.read(paths.username_index_path(name))
        if idx is not None:
            uid = json.loads(idx[0]).get("user_id")
            got = storage.read(paths.user_path(uid)) if uid else None
            user = json.loads(got[0]) if got else None
    stored_hash = user["password_hash"] if user else _dummy_hash()
    ok = check_password_hash(stored_hash, password or "") and user is not None
    if not ok:
        if name:
            limiter.record_failure(f"login-user:{name}", LOGIN_WINDOW)
        raise ApiError(401, "INVALID_CREDENTIALS", "Wrong username or password.")
    limiter.clear(f"login-user:{name}")
    return public_user(user)


def load_user(storage, uid):
    try:
        uid = paths.user_id(uid)
    except ApiError:
        return None
    got = storage.read(paths.user_path(uid))
    return public_user(json.loads(got[0])) if got else None


def public_user(u):
    return {"id": u["id"], "username": u["username"], "created_at": u.get("created_at")}


_DUMMY = None


def _dummy_hash():
    global _DUMMY
    if _DUMMY is None:
        _DUMMY = generate_password_hash("not-a-real-password")
    return _DUMMY


def _best_effort_delete(storage, path, message):
    try:
        got = storage.read(path)
        if got is not None:
            storage.delete(path, got[1], message)
    except Exception:
        pass


def _now():
    return datetime.now(timezone.utc).isoformat()
