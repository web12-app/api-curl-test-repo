"""Flask application: pages, auth, apps, API keys, database API, file API, legacy file API.

Create with create_app(). Gunicorn: `gunicorn app:app` (module-level app built from the environment).
"""
import hmac
import json
import logging
import os
import secrets
import time
from datetime import datetime, timezone

from flask import (Blueprint, Flask, Response, jsonify, redirect, render_template, request,
                   send_from_directory, session, url_for)
from werkzeug.exceptions import HTTPException, RequestEntityTooLarge

import accounts
import apps as apps_svc
import files_v1
import paths
import records
from config import ConfigError, load_config
from errors import ApiError, fail, ok, request_id
from storage import GitHubStorage, MemoryStorage, StorageError, json_bytes

log = logging.getLogger("platform")
UNSAFE = ("POST", "PUT", "PATCH", "DELETE")
SIGNUP_PER_IP = (10, 3600)
ALLOWED_HEADERS = "Authorization, Content-Type, X-API-Key, X-CSRF-Token"
ALLOWED_METHODS = "GET, POST, PUT, PATCH, DELETE, OPTIONS"


def _now():
    return datetime.now(timezone.utc).isoformat()


def create_app(cfg=None, storage=None):
    if cfg is None:
        cfg = load_config()
    if storage is None:
        storage = GitHubStorage(cfg.github_token, cfg.private_data_repo)
    if cfg.cookie_samesite == "None" and not cfg.cookie_secure:
        raise ConfigError("COOKIE_SAMESITE=None requires secure cookies.")

    app = Flask(__name__, static_folder="static", static_url_path="/static")
    app.secret_key = cfg.secret_key
    app.config.update(
        SESSION_COOKIE_HTTPONLY=True,
        SESSION_COOKIE_SECURE=cfg.cookie_secure,
        SESSION_COOKIE_SAMESITE=cfg.cookie_samesite,
        SESSION_COOKIE_NAME="pips_session",
        PERMANENT_SESSION_LIFETIME=cfg.session_hours * 3600,
        MAX_CONTENT_LENGTH=cfg.max_request_bytes,
        JSON_SORT_KEYS=False,
    )
    app.extensions["cfg"] = cfg
    app.extensions["storage"] = storage

    # ------------------------------------------------------------ helpers
    def get_json():
        if not request.is_json:
            raise ApiError(400, "INVALID_CONTENT_TYPE", "Send the body as application/json.")
        try:
            body = request.get_json(force=False, silent=False)
        except RequestEntityTooLarge:
            raise
        except Exception:
            raise ApiError(400, "INVALID_JSON", "The request body is not valid JSON.")
        if body is None:
            return {}
        return body

    def csrf_token():
        tok = session.get("csrf")
        if not tok:
            tok = secrets.token_urlsafe(32)
            session["csrf"] = tok
        return tok

    app.jinja_env.globals["csrf_token"] = csrf_token

    def is_api_key_request():
        auth = request.headers.get("Authorization", "")
        return auth.lower().startswith("bearer ") or bool(request.headers.get("X-API-Key"))

    def check_session_expiry():
        iat = session.get("iat")
        if session.get("uid") and (not iat or time.time() - iat > cfg.session_hours * 3600):
            session.clear()

    def require_csrf():
        """Cookie-authenticated, state-changing requests need a token that matches the session."""
        sent = request.headers.get("X-CSRF-Token") or request.form.get("csrf_token", "")
        expected = session.get("csrf", "")
        if not expected or not sent or not hmac.compare_digest(sent, expected):
            raise ApiError(403, "CSRF_FAILED", "Missing or invalid CSRF token. Reload the page and try again.")

    def principal():
        return apps_svc.require_principal(storage, cfg.api_key_hash_secret)

    def user_or_401():
        uid = session.get("uid")
        if not uid:
            raise ApiError(401, "UNAUTHENTICATED", "Log in first.")
        return uid

    def owner_session_or_401():
        """Management endpoints: only a logged-in owner. API keys are refused outright."""
        if is_api_key_request():
            raise ApiError(403, "PERMISSION_DENIED", "API keys cannot manage apps or keys. Log in instead.")
        return user_or_401()

    def log_in(user):
        session.clear()
        session.permanent = True
        session["uid"] = user["id"]
        session["iat"] = time.time()
        csrf_token()

    # ------------------------------------------------------------ request hooks
    @app.before_request
    def _pre():
        request.environ["REQUEST_ID"] = request_id()
        check_session_expiry()
        if request.method == "OPTIONS" and request.path.startswith("/api/"):
            return _cors_preflight()
        if request.method in UNSAFE and not is_api_key_request():
            if request.path.startswith("/api/") or request.path in ("/login", "/signup", "/logout", "/dashboard"):
                if not (request.path.startswith("/api/v1/auth/csrf")):
                    require_csrf()

    def _allowed_origin():
        origin = request.headers.get("Origin", "")
        return origin if origin and origin in cfg.cors_allowed_origins else None

    def _cors_preflight():
        resp = Response(status=204)
        origin = _allowed_origin()
        if origin:
            resp.headers.update({
                "Access-Control-Allow-Origin": origin,
                "Access-Control-Allow-Credentials": "true",
                "Access-Control-Allow-Headers": ALLOWED_HEADERS,
                "Access-Control-Allow-Methods": ALLOWED_METHODS,
                "Access-Control-Max-Age": "600",
            })
        resp.headers["Vary"] = "Origin"
        return resp

    @app.after_request
    def _post(resp):
        origin = _allowed_origin()
        if origin:
            resp.headers["Access-Control-Allow-Origin"] = origin
            resp.headers["Access-Control-Allow-Credentials"] = "true"
            resp.headers["Access-Control-Expose-Headers"] = "X-Request-Id"
        resp.headers["Vary"] = "Origin"
        resp.headers["X-Request-Id"] = request_id()
        resp.headers["X-Content-Type-Options"] = "nosniff"
        resp.headers["Referrer-Policy"] = "same-origin"
        if not request.path.startswith("/static/"):
            resp.headers.setdefault("X-Frame-Options", "DENY")
        if request.path.startswith("/api/"):
            resp.headers["Cache-Control"] = "no-store"
        return resp

    # ------------------------------------------------------------ errors
    @app.errorhandler(ApiError)
    def _api_error(e):
        if request.path.startswith("/api/"):
            return fail(e.status, e.code, e.message)
        return render_template("error.html", message=e.message, status=e.status, user=None), e.status

    @app.errorhandler(StorageError)
    def _storage_error(e):
        return fail(e.status, e.code, str(e))

    @app.errorhandler(RequestEntityTooLarge)
    def _too_large(e):
        return fail(413, "PAYLOAD_TOO_LARGE", "The request is too large.")

    @app.errorhandler(HTTPException)
    def _http(e):
        if request.path.startswith("/api/"):
            return fail(e.code or 500, (e.name or "ERROR").upper().replace(" ", "_"),
                        e.description or "Request failed.")
        return e

    @app.errorhandler(Exception)
    def _unexpected(e):
        # Log only the exception type. Messages can contain request data or upstream details.
        log.error("unhandled %s (request %s)", type(e).__name__, request_id())
        if request.path.startswith("/api/"):
            return fail(500, "INTERNAL_ERROR", "Something went wrong. Quote the request id when reporting it.")
        return render_template("error.html", message="Something went wrong.", status=500), 500

    # ------------------------------------------------------------ pages
    @app.get("/")
    def home():
        return render_template("home.html", user=_page_user())

    def _page_user():
        uid = session.get("uid")
        if not uid:
            return None
        return accounts.load_user(storage, uid)

    @app.route("/signup", methods=["GET", "POST"])
    def signup():
        if request.method == "GET":
            return render_template("auth.html", mode="signup", error=None, user=_page_user())
        try:
            _rate_signup()
            user = accounts.create_user(storage, request.form.get("username", ""),
                                        request.form.get("password", ""))
        except ApiError as e:
            return render_template("auth.html", mode="signup", error=e.message, user=None), e.status
        log_in(user)
        return redirect(url_for("dashboard"))

    @app.route("/login", methods=["GET", "POST"])
    def login():
        if request.method == "GET":
            return render_template("auth.html", mode="login", error=None, user=_page_user())
        try:
            user = accounts.authenticate(storage, request.form.get("username", ""),
                                         request.form.get("password", ""), request.remote_addr or "?")
        except ApiError as e:
            return render_template("auth.html", mode="login", error=e.message, user=None), e.status
        log_in(user)
        return redirect(url_for("dashboard"))

    @app.get("/logout")
    def logout():
        session.clear()
        return redirect(url_for("home"))

    @app.get("/dashboard")
    def dashboard():
        if not session.get("uid"):
            return redirect(url_for("login"))
        return render_template("dashboard.html", user=_page_user())

    def _rate_signup():
        ip = request.remote_addr or "?"
        if not accounts.limiter.allow(f"signup-ip:{ip}", *SIGNUP_PER_IP):
            raise ApiError(429, "RATE_LIMITED", "Too many signups from this network. Try again later.")

    # ------------------------------------------------------------ health
    @app.get("/api/health")
    def health():
        try:
            storage.check()
            store = "ok"
        except StorageError:
            store = "unavailable"
        status = 200 if store == "ok" else 503
        return jsonify({"status": "ok" if store == "ok" else "degraded", "storage": store,
                        "time": _now()}), status

    # ------------------------------------------------------------ auth API
    v1 = Blueprint("v1", __name__)

    @v1.get("/api/v1/auth/csrf")
    def auth_csrf():
        return ok({"csrf_token": csrf_token()})

    @v1.post("/api/v1/auth/signup")
    def auth_signup():
        body = get_json()
        _rate_signup()
        user = accounts.create_user(storage, body.get("username", ""), body.get("password", ""))
        log_in(user)
        return ok({"user": user}, 201)

    @v1.post("/api/v1/auth/login")
    def auth_login():
        body = get_json()
        user = accounts.authenticate(storage, body.get("username", ""), body.get("password", ""),
                                     request.remote_addr or "?")
        log_in(user)
        return ok({"user": user})

    @v1.post("/api/v1/auth/logout")
    def auth_logout():
        session.clear()
        return ok({"logged_out": True})

    @v1.get("/api/v1/auth/me")
    def auth_me():
        return ok({"user": _page_user()})

    @app.get("/api/hello")
    def hello():
        return jsonify(message="Hello from Python!", source="api-curl-test-repo")

    @app.get("/api/time")
    def now():
        return jsonify(utc=_now())

    @app.get("/api/me")  # compatibility alias
    def legacy_me():
        return jsonify(user=(_page_user() or {}).get("username"))

    # ------------------------------------------------------------ apps API (owner session only)
    @v1.post("/api/v1/apps")
    def apps_create():
        uid = owner_session_or_401()
        body = get_json()
        app_meta = apps_svc.create_app(storage, uid, body.get("name", ""), body.get("description", ""))
        return ok({"app": app_meta}, 201)

    @v1.get("/api/v1/apps")
    def apps_list():
        uid = owner_session_or_401()
        return ok({"apps": apps_svc.list_owned_apps(storage, uid)})

    @v1.get("/api/v1/apps/<app_id>")
    def apps_get(app_id):
        p = principal()
        if isinstance(p, apps_svc.KeyPrincipal):
            return ok({"app": apps_svc.require_app_scope(storage, p, app_id, "db:read")})
        return ok({"app": apps_svc.load_owned_app(storage, p.user_id, app_id)})

    @v1.patch("/api/v1/apps/<app_id>")
    def apps_patch(app_id):
        uid = owner_session_or_401()
        return ok({"app": apps_svc.update_app(storage, uid, app_id, get_json())})

    @v1.delete("/api/v1/apps/<app_id>")
    def apps_delete(app_id):
        uid = owner_session_or_401()
        body = get_json()
        return ok(apps_svc.delete_app(storage, cfg.api_key_hash_secret, uid, app_id, body.get("confirm")))

    @v1.post("/api/v1/apps/<app_id>/keys")
    def keys_create(app_id):
        uid = owner_session_or_401()
        apps_svc.load_owned_app(storage, uid, app_id)
        body = get_json()
        key = apps_svc.create_key(storage, cfg.api_key_hash_secret, app_id, body.get("name", ""),
                                  body.get("environment", "development"), body.get("scopes", []),
                                  body.get("expires_in_days"))
        return ok({"key": key, "notice": "Store this key now. It will not be shown again."}, 201)

    @v1.get("/api/v1/apps/<app_id>/keys")
    def keys_list(app_id):
        uid = owner_session_or_401()
        apps_svc.load_owned_app(storage, uid, app_id)
        return ok({"keys": apps_svc.list_keys(storage, app_id)})

    @v1.delete("/api/v1/apps/<app_id>/keys/<key_id>")
    def keys_revoke(app_id, key_id):
        uid = owner_session_or_401()
        apps_svc.load_owned_app(storage, uid, app_id)
        return ok({"key": apps_svc.revoke_key(storage, app_id, key_id)})

    # ------------------------------------------------------------ database API
    def _db_scope(app_id, scope):
        p = principal()
        apps_svc.require_app_scope(storage, p, app_id, scope)
        return p

    @v1.post("/api/v1/db/<app_id>/<collection>")
    def db_create(app_id, collection):
        _db_scope(app_id, "db:write")
        paths.app_id(app_id)
        paths.collection(collection)
        rec = records.create(storage, cfg.max_record_bytes, app_id, collection, get_json())
        return ok({"record": rec}, 201)

    @v1.get("/api/v1/db/<app_id>/<collection>")
    def db_list(app_id, collection):
        _db_scope(app_id, "db:read")
        paths.app_id(app_id)
        paths.collection(collection)
        page = records.list_page(storage, app_id, collection,
                                 request.args.get("limit", records.DEFAULT_PAGE),
                                 request.args.get("cursor", 0))
        return ok(page)

    @v1.get("/api/v1/db/<app_id>/<collection>/<record_id>")
    def db_get(app_id, collection, record_id):
        _db_scope(app_id, "db:read")
        paths.app_id(app_id)
        paths.collection(collection)
        paths.record_id(record_id)
        return ok({"record": records.get(storage, app_id, collection, record_id)})

    def _expected():
        return request.headers.get("If-Match") or request.args.get("expected_version")

    def _envelope(body):
        """Return (payload, expected_version) for {"data": {...}, "expected_version": n} bodies.

        Any other object is the payload itself, so a record may contain a field named "data".
        """
        if isinstance(body, dict) and "data" in body and isinstance(body["data"], dict) \
                and set(body) <= {"data", "expected_version"}:
            return body["data"], body.get("expected_version")
        return body, None

    @v1.put("/api/v1/db/<app_id>/<collection>/<record_id>")
    def db_replace(app_id, collection, record_id):
        _db_scope(app_id, "db:write")
        paths.app_id(app_id)
        paths.collection(collection)
        paths.record_id(record_id)
        data, body_expected = _envelope(get_json())
        expected = body_expected if body_expected is not None else _expected()
        return ok({"record": records.replace(storage, cfg.max_record_bytes, app_id, collection,
                                             record_id, data, expected)})

    @v1.patch("/api/v1/db/<app_id>/<collection>/<record_id>")
    def db_patch(app_id, collection, record_id):
        _db_scope(app_id, "db:write")
        paths.app_id(app_id)
        paths.collection(collection)
        paths.record_id(record_id)
        changes, body_expected = _envelope(get_json())
        expected = body_expected if body_expected is not None else _expected()
        return ok({"record": records.patch(storage, cfg.max_record_bytes, app_id, collection,
                                           record_id, changes, expected)})

    @v1.delete("/api/v1/db/<app_id>/<collection>/<record_id>")
    def db_delete(app_id, collection, record_id):
        _db_scope(app_id, "db:write")
        paths.app_id(app_id)
        paths.collection(collection)
        paths.record_id(record_id)
        return ok(records.delete(storage, app_id, collection, record_id, _expected()), 200)

    # ------------------------------------------------------------ file API (app-scoped)
    @v1.post("/api/v1/files")
    def files_upload():
        p = principal()
        app_id = request.args.get("app_id", "")
        if isinstance(p, apps_svc.KeyPrincipal):
            app_id = p.app_id
        apps_svc.require_app_scope(storage, p, app_id, "files:write")
        f = request.files.get("file")
        if f is None:
            raise ApiError(400, "MISSING_FILE", "Send the file in form field 'file'.")
        data = f.read(cfg.max_file_bytes + 1)
        created_by = ("key:" + p.key_id) if isinstance(p, apps_svc.KeyPrincipal) else ("user:" + p.user_id)
        meta = files_v1.upload(storage, cfg.max_file_bytes, app_id, f.filename or "", data, created_by)
        return ok({"file": meta}, 201)

    @v1.get("/api/v1/files")
    def files_list():
        p = principal()
        app_id = request.args.get("app_id", "")
        if isinstance(p, apps_svc.KeyPrincipal):
            app_id = p.app_id
        apps_svc.require_app_scope(storage, p, app_id, "files:read")
        return ok(files_v1.list_files(storage, app_id, request.args.get("limit", 50),
                                      request.args.get("cursor", 0)))

    @v1.get("/api/v1/files/<file_id>")
    def files_get(file_id):
        p = principal()
        app_id = request.args.get("app_id", "")
        if isinstance(p, apps_svc.KeyPrincipal):
            app_id = p.app_id
        apps_svc.require_app_scope(storage, p, app_id, "files:read")
        paths.file_id(file_id)
        return ok({"file": files_v1.get_public(storage, app_id, file_id)})

    @v1.get("/api/v1/files/<file_id>/download")
    def files_download(file_id):
        p = principal()
        app_id = request.args.get("app_id", "")
        if isinstance(p, apps_svc.KeyPrincipal):
            app_id = p.app_id
        apps_svc.require_app_scope(storage, p, app_id, "files:read")
        paths.file_id(file_id)
        meta, data = files_v1.read_content(storage, cfg.max_file_bytes, app_id, file_id)
        resp = Response(data, mimetype=meta["content_type"])
        resp.headers["Content-Disposition"] = f'attachment; filename="{meta["name"]}"'
        resp.headers["X-Content-Type-Options"] = "nosniff"
        return resp

    @v1.delete("/api/v1/files/<file_id>")
    def files_delete(file_id):
        p = principal()
        app_id = request.args.get("app_id", "")
        if isinstance(p, apps_svc.KeyPrincipal):
            app_id = p.app_id
        apps_svc.require_app_scope(storage, p, app_id, "files:write")
        paths.file_id(file_id)
        return ok(files_v1.delete(storage, app_id, file_id))

    # ------------------------------------------------------------ legacy file API (session or LEGACY_API_KEY)
    legacy = Blueprint("legacy", __name__)

    def _legacy_auth():
        expected = os.environ.get("LEGACY_API_KEY", "").strip()
        given = request.headers.get("X-API-Key", "")
        if expected and given and hmac.compare_digest(given, expected):
            return
        user_or_401()

    @legacy.get("/api/files")
    def legacy_list():
        _legacy_auth()
        items = []
        for it in storage.list("files"):
            if it["type"] == "file":
                items.append({"name": it["name"], "sha": it["sha"]})
        return jsonify(files=items)

    @legacy.get("/api/files/<name>")
    def legacy_download(name):
        _legacy_auth()
        safe = paths.safe_filename(name)
        got = storage.read(f"files/{safe}")
        if got is None:
            return jsonify(error="File not found."), 404
        return Response(got[0], mimetype="application/octet-stream",
                        headers={"Content-Disposition": f'attachment; filename="{safe}"',
                                 "X-Content-Type-Options": "nosniff"})

    @legacy.post("/api/files")
    def legacy_upload():
        _legacy_auth()
        f = request.files.get("file")
        if f is None:
            return jsonify(error="Send the file in form field 'file'."), 400
        data = f.read(cfg.max_file_bytes + 1)
        if len(data) > cfg.max_file_bytes:
            return jsonify(error="File too large."), 413
        safe = paths.safe_filename(f.filename or "")
        path = f"files/{safe}"
        cur = storage.read(path)
        storage.write(path, data, f"upload {safe}", sha=cur[1] if cur else None)
        return jsonify(name=safe, size=len(data), replaced=cur is not None), 201

    @legacy.delete("/api/files/<name>")
    def legacy_delete(name):
        _legacy_auth()
        safe = paths.safe_filename(name)
        got = storage.read(f"files/{safe}")
        if got is None:
            return jsonify(error="File not found."), 404
        storage.delete(f"files/{safe}", got[1], f"delete {safe}")
        return jsonify(deleted=safe)

    app.register_blueprint(v1)
    app.register_blueprint(legacy)
    return app


def _default_app():
    """Module-level app for `gunicorn app:app`. Fails fast with a clear message if config is missing."""
    try:
        return create_app()
    except ConfigError as e:
        # Still start, but every request reports the configuration problem without any secret values.
        message = str(e)
        fallback = Flask(__name__)

        @fallback.route("/", defaults={"p": ""})
        @fallback.route("/<path:p>")
        def _misconfigured(p):
            return jsonify({"success": False, "error": {"code": "NOT_CONFIGURED", "message": message}}), 503

        return fallback


app = _default_app()

if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
