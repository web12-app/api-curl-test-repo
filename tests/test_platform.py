import io
import json

import pytest

import paths
from config import ConfigError, load_config
from conftest import bearer, create_app_as, create_key, csrf, login, signup
from storage import Conflict, MemoryStorage


# ================================================================ configuration
def test_missing_required_config_names_variables_not_values():
    with pytest.raises(ConfigError) as e:
        load_config(env={"SECRET_KEY": "super-secret-value-123"})
    msg = str(e.value)
    assert "API_KEY_HASH_SECRET" in msg and "GITHUB_TOKEN" in msg
    assert "super-secret-value-123" not in msg


def test_wildcard_and_non_https_cors_origins_rejected():
    base = {"SECRET_KEY": "a", "API_KEY_HASH_SECRET": "b", "GITHUB_TOKEN": "c",
            "PRIVATE_DATA_REPO": "web12-app/private"}
    with pytest.raises(ConfigError):
        load_config(env={**base, "CORS_ALLOWED_ORIGINS": "*"})
    with pytest.raises(ConfigError):
        load_config(env={**base, "CORS_ALLOWED_ORIGINS": "http://evil.example.com"})


def test_samesite_none_requires_secure_cookies(make_app):
    with pytest.raises(ConfigError):
        make_app(cookie_samesite="None", cookie_secure=False)


def test_bad_repo_name_rejected():
    with pytest.raises(ConfigError):
        load_config(env={"SECRET_KEY": "a", "API_KEY_HASH_SECRET": "b", "GITHUB_TOKEN": "c",
                         "PRIVATE_DATA_REPO": "../etc"})


# ================================================================ accounts and sessions
def test_signup_stores_hash_not_plaintext(client, storage):
    user = signup(client, "alice_01", "my-secret-pass-9")
    assert user["username"] == "alice_01" and "password_hash" not in user
    stored = [json.loads(v[0]) for k, v in storage._files.items() if k.startswith("users/")]
    assert len(stored) == 1
    assert "my-secret-pass-9" not in json.dumps(stored[0])
    assert stored[0]["password_hash"].startswith(("scrypt:", "pbkdf2:"))


def test_duplicate_username_rejected(make_app):
    app = make_app()
    signup(app.test_client(), "bob_user")
    c2 = app.test_client()
    r = c2.post("/api/v1/auth/signup", json={"username": "bob_user", "password": "another-pass-1"},
                headers={"X-CSRF-Token": csrf(c2)})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "USERNAME_TAKEN"


def test_wrong_password_and_unknown_user_look_the_same(client):
    signup(client, "carol_02", "right-password-1")
    c2 = client.application.test_client()
    a = c2.post("/api/v1/auth/login", json={"username": "carol_02", "password": "wrong-password"},
                headers={"X-CSRF-Token": csrf(c2)})
    b = c2.post("/api/v1/auth/login", json={"username": "nobody_99", "password": "wrong-password"},
                headers={"X-CSRF-Token": csrf(c2)})
    assert a.status_code == b.status_code == 401
    assert a.get_json()["error"] == b.get_json()["error"]


def test_login_rate_limit_blocks_after_repeated_failures(client):
    signup(client, "dave_03", "right-password-1")
    c2 = client.application.test_client()
    for _ in range(5):
        r = c2.post("/api/v1/auth/login", json={"username": "dave_03", "password": "bad-password-x"},
                    headers={"X-CSRF-Token": csrf(c2)})
        assert r.status_code == 401
    r = c2.post("/api/v1/auth/login", json={"username": "dave_03", "password": "right-password-1"},
                headers={"X-CSRF-Token": csrf(c2)})
    assert r.status_code == 429 and r.get_json()["error"]["code"] == "RATE_LIMITED"


def test_me_and_logout(client):
    assert client.get("/api/v1/auth/me").get_json()["data"]["user"] is None
    signup(client, "erin_04")
    assert client.get("/api/v1/auth/me").get_json()["data"]["user"]["username"] == "erin_04"
    client.post("/api/v1/auth/logout", headers={"X-CSRF-Token": csrf(client)})
    assert client.get("/api/v1/auth/me").get_json()["data"]["user"] is None


def test_session_expires_server_side(make_app):
    app = make_app()
    c = app.test_client()
    signup(c, "frank_05")
    with c.session_transaction() as s:
        s["iat"] = 0  # far in the past
    r = c.get("/api/v1/auth/me")
    assert r.get_json()["data"]["user"] is None


def test_invalid_json_and_bad_username_are_400(client):
    r = client.post("/api/v1/auth/signup", data="{not json", content_type="application/json",
                    headers={"X-CSRF-Token": csrf(client)})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "INVALID_JSON"
    r = client.post("/api/v1/auth/signup", json={"username": "../../x", "password": "long-enough-1"},
                    headers={"X-CSRF-Token": csrf(client)})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "INVALID_USERNAME"


# ================================================================ CSRF
def test_session_write_without_csrf_token_is_rejected(client):
    signup(client, "gina_06")
    r = client.post("/api/v1/apps", json={"name": "No token"})
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "CSRF_FAILED"


def test_session_write_with_wrong_csrf_token_is_rejected(client):
    signup(client, "hank_07")
    csrf(client)
    r = client.post("/api/v1/apps", json={"name": "Bad token"}, headers={"X-CSRF-Token": "forged"})
    assert r.status_code == 403


def test_api_key_requests_do_not_need_csrf(client):
    signup(client, "ivy_08")
    aid = create_app_as(client)
    key = create_key(client, aid)
    r = client.post(f"/api/v1/db/{aid}/notes", json={"text": "hi"}, headers=bearer(key["api_key"]))
    assert r.status_code == 201


# ================================================================ apps and ownership
def test_app_create_list_and_owner_isolation(make_app):
    app = make_app()
    alice, bob = app.test_client(), app.test_client()
    signup(alice, "alice_app")
    signup(bob, "bob_app")
    aid = create_app_as(alice, "Alice Notes")

    listed = alice.get("/api/v1/apps").get_json()["data"]["apps"]
    assert [a["id"] for a in listed] == [aid]
    assert bob.get("/api/v1/apps").get_json()["data"]["apps"] == []

    assert bob.get(f"/api/v1/apps/{aid}").status_code == 404
    r = bob.patch(f"/api/v1/apps/{aid}", json={"name": "hacked"}, headers={"X-CSRF-Token": csrf(bob)})
    assert r.status_code == 404
    r = bob.post(f"/api/v1/apps/{aid}/keys", json={"name": "x", "environment": "development",
                                                   "scopes": ["db:read"]},
                 headers={"X-CSRF-Token": csrf(bob)})
    assert r.status_code == 404


def test_app_rename_by_owner(client):
    signup(client, "jack_09")
    aid = create_app_as(client, "Old Name")
    r = client.patch(f"/api/v1/apps/{aid}", json={"name": "New Name"}, headers={"X-CSRF-Token": csrf(client)})
    assert r.status_code == 200 and r.get_json()["data"]["app"]["name"] == "New Name"


def test_app_delete_requires_confirmation_and_revokes_keys(client):
    signup(client, "kate_10")
    aid = create_app_as(client)
    key = create_key(client, aid)
    r = client.delete(f"/api/v1/apps/{aid}", json={}, headers={"X-CSRF-Token": csrf(client)})
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "CONFIRMATION_REQUIRED"
    r = client.delete(f"/api/v1/apps/{aid}", json={"confirm": aid}, headers={"X-CSRF-Token": csrf(client)})
    assert r.status_code == 200 and r.get_json()["data"]["status"] == "deleted"
    assert client.get("/api/v1/apps").get_json()["data"]["apps"] == []
    r = client.get(f"/api/v1/db/{aid}/notes", headers=bearer(key["api_key"]))
    assert r.status_code in (401, 404)


# ================================================================ API keys
def test_key_secret_shown_once_and_never_stored_in_plaintext(client, storage):
    signup(client, "liam_11")
    aid = create_app_as(client)
    key = create_key(client, aid, scopes=("db:read",))
    secret = key["api_key"].split(".")[2]
    assert key["api_key"].startswith(aid + ".")
    listed = client.get(f"/api/v1/apps/{aid}/keys").get_json()["data"]["keys"]
    assert secret not in json.dumps(listed) and "api_key" not in json.dumps(listed)
    for path, (raw, _) in storage._files.items():
        if path.startswith(f"apps/{aid}/api_keys/"):
            assert secret.encode() not in raw


def test_key_scopes_are_enforced(client):
    signup(client, "mia_12")
    aid = create_app_as(client)
    read_only = create_key(client, aid, scopes=("db:read",))
    assert client.post(f"/api/v1/db/{aid}/notes", json={"a": 1}, headers=bearer(read_only["api_key"])).status_code == 403


def test_key_cannot_access_another_app(client):
    signup(client, "noah_13")
    a1 = create_app_as(client, "First")
    a2 = create_app_as(client, "Second")
    k1 = create_key(client, a1)
    r = client.post(f"/api/v1/db/{a2}/notes", json={"a": 1}, headers=bearer(k1["api_key"]))
    assert r.status_code == 403 and r.get_json()["error"]["code"] == "PERMISSION_DENIED"


def test_revoked_key_stops_working(client):
    signup(client, "olga_14")
    aid = create_app_as(client)
    key = create_key(client, aid)
    assert client.post(f"/api/v1/db/{aid}/notes", json={"a": 1}, headers=bearer(key["api_key"])).status_code == 201
    r = client.delete(f"/api/v1/apps/{aid}/keys/{key['id']}", headers={"X-CSRF-Token": csrf(client)})
    assert r.status_code == 200
    r = client.post(f"/api/v1/db/{aid}/notes", json={"a": 2}, headers=bearer(key["api_key"]))
    assert r.status_code == 401 and r.get_json()["error"]["code"] == "INVALID_API_KEY"


def test_malformed_and_forged_keys_rejected(client):
    signup(client, "pete_15")
    aid = create_app_as(client)
    key = create_key(client, aid)
    _, kid, secret = key["api_key"].split(".")
    for bad in ["nonsense", f"{aid}.{kid}.wrongsecret", f"../x.{kid}.{secret}", f"{aid}.{'0'*24}.{secret}"]:
        r = client.post(f"/api/v1/db/{aid}/notes", json={"a": 1}, headers=bearer(bad))
        assert r.status_code == 401, bad


def test_x_api_key_header_is_supported(client):
    signup(client, "quin_16")
    aid = create_app_as(client)
    key = create_key(client, aid)
    r = client.get(f"/api/v1/db/{aid}/notes", headers={"X-API-Key": key["api_key"]})
    assert r.status_code == 200


def test_key_expiry_is_enforced(client, storage):
    signup(client, "ruth_17")
    aid = create_app_as(client)
    key = create_key(client, aid)
    rec_path = paths.key_path(aid, key["id"])
    raw, sha = storage.read(rec_path)
    rec = json.loads(raw)
    rec["expires_at"] = "2000-01-01T00:00:00+00:00"
    storage.write(rec_path, json.dumps(rec).encode(), "test", sha=sha)
    assert client.get(f"/api/v1/db/{aid}/notes", headers=bearer(key["api_key"])).status_code == 401


def test_only_owner_session_manages_keys_not_api_keys(client):
    signup(client, "sam_18")
    aid = create_app_as(client)
    key = create_key(client, aid)
    r = client.post(f"/api/v1/apps/{aid}/keys", json={"name": "x", "environment": "development",
                                                      "scopes": ["db:read"]},
                    headers={**bearer(key["api_key"]), "X-CSRF-Token": csrf(client)})
    assert r.status_code == 403  # refused even though the browser session belongs to the owner


# ================================================================ database API
def _app_with_key(client, scopes=("db:read", "db:write")):
    import secrets
    signup(client, "u" + secrets.token_hex(6))
    aid = create_app_as(client)
    return aid, create_key(client, aid, scopes=scopes)["api_key"]


def test_record_crud_and_pagination(client):
    aid, key = _app_with_key(client)
    h = bearer(key)
    ids = []
    for i in range(5):
        r = client.post(f"/api/v1/db/{aid}/notes", json={"n": i, "title": "t"}, headers=h)
        assert r.status_code == 201
        ids.append(r.get_json()["data"]["record"]["id"])
    got = client.get(f"/api/v1/db/{aid}/notes/{ids[0]}", headers=h).get_json()["data"]["record"]
    assert got["data"] == {"n": 0, "title": "t"} and got["version"] == 1

    page1 = client.get(f"/api/v1/db/{aid}/notes?limit=2", headers=h).get_json()["data"]
    assert len(page1["items"]) == 2 and page1["next_cursor"] == 2
    page3 = client.get(f"/api/v1/db/{aid}/notes?limit=2&cursor=4", headers=h).get_json()["data"]
    assert len(page3["items"]) == 1 and page3["next_cursor"] is None

    r = client.patch(f"/api/v1/db/{aid}/notes/{ids[0]}", json={"title": None, "extra": True}, headers=h)
    data = r.get_json()["data"]["record"]
    assert data["version"] == 2 and data["data"] == {"n": 0, "extra": True}

    r = client.delete(f"/api/v1/db/{aid}/notes/{ids[0]}", headers=h)
    assert r.status_code == 200
    assert client.get(f"/api/v1/db/{aid}/notes/{ids[0]}", headers=h).status_code == 404


def test_put_replaces_and_stale_version_is_rejected(client):
    aid, key = _app_with_key(client)
    h = bearer(key)
    rid = client.post(f"/api/v1/db/{aid}/notes", json={"a": 1}, headers=h).get_json()["data"]["record"]["id"]
    r = client.put(f"/api/v1/db/{aid}/notes/{rid}", json={"a": 2}, headers={**h, "If-Match": "1"})
    assert r.status_code == 200 and r.get_json()["data"]["record"]["version"] == 2
    r = client.put(f"/api/v1/db/{aid}/notes/{rid}", json={"a": 3}, headers={**h, "If-Match": "1"})
    assert r.status_code == 409 and r.get_json()["error"]["code"] == "VERSION_CONFLICT"


def test_envelope_with_expected_version_in_body(client):
    aid, key = _app_with_key(client)
    h = bearer(key)
    rid = client.post(f"/api/v1/db/{aid}/notes", json={"a": 1}, headers=h).get_json()["data"]["record"]["id"]
    r = client.patch(f"/api/v1/db/{aid}/notes/{rid}", json={"data": {"b": 2}, "expected_version": 9}, headers=h)
    assert r.status_code == 409


def test_storage_level_conflict_on_stale_sha(storage):
    storage.write("x/a.json", b"one", "create")
    _, sha = storage.read("x/a.json")
    storage.write("x/a.json", b"two", "update", sha=sha)
    with pytest.raises(Conflict):
        storage.write("x/a.json", b"three", "stale", sha=sha)


def test_invalid_body_and_collection_names(client):
    aid, key = _app_with_key(client)
    h = bearer(key)
    r = client.post(f"/api/v1/db/{aid}/notes", data="[1,2", content_type="application/json", headers=h)
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "INVALID_JSON"
    r = client.post(f"/api/v1/db/{aid}/notes", json=[1, 2], headers=h)
    assert r.status_code == 400 and r.get_json()["error"]["code"] == "INVALID_BODY"
    for bad in ["..%2Fsecrets", "Bad%20Name", "UPPER", "a%2Fb"]:
        r = client.post(f"/api/v1/db/{aid}/{bad}", json={"a": 1}, headers=h)
        assert r.status_code in (400, 404, 405), bad  # routing may reject before validation
        assert r.status_code != 201


def test_record_ids_cannot_traverse(client):
    aid, key = _app_with_key(client)
    h = bearer(key)
    for bad in ["..%2F..%2Fusers%2Fx", "%2e%2e", "abc"]:
        r = client.get(f"/api/v1/db/{aid}/notes/{bad}", headers=h)
        assert r.status_code in (400, 404), bad


def test_oversized_record_rejected(make_app):
    app = make_app(max_record_bytes=200)
    c = app.test_client()
    aid, key = _app_with_key(c)
    r = c.post(f"/api/v1/db/{aid}/notes", json={"blob": "x" * 500}, headers=bearer(key))
    assert r.status_code == 413 and r.get_json()["error"]["code"] == "RECORD_TOO_LARGE"


def test_oversized_request_body_rejected(make_app):
    app = make_app(max_request_bytes=1024)
    c = app.test_client()
    aid, key = _app_with_key(c)
    r = c.post(f"/api/v1/db/{aid}/notes", json={"blob": "x" * 5000}, headers=bearer(key))
    assert r.status_code == 413


# ================================================================ file API
def _upload(c, aid, key, name, data, ctype="text/plain"):
    return c.post(f"/api/v1/files?app_id={aid}", data={"file": (io.BytesIO(data), name, ctype)},
                  headers=bearer(key))


def test_file_upload_list_download_delete(client):
    aid, key = _app_with_key(client, scopes=("files:read", "files:write"))
    r = _upload(client, aid, key, "notes.txt", b"hello files")
    assert r.status_code == 201
    meta = r.get_json()["data"]["file"]
    assert meta["name"] == "notes.txt" and meta["size"] == 11 and meta["content_type"] == "text/plain"
    assert client.get(f"/api/v1/files?app_id={aid}", headers=bearer(key)).get_json()["data"]["items"][0]["id"] == meta["id"]

    d = client.get(f"/api/v1/files/{meta['id']}/download", headers=bearer(key))
    assert d.status_code == 200 and d.data == b"hello files"
    assert d.headers["Content-Disposition"].startswith("attachment;")
    assert d.headers["X-Content-Type-Options"] == "nosniff"

    assert client.delete(f"/api/v1/files/{meta['id']}", headers=bearer(key)).status_code == 200
    assert client.get(f"/api/v1/files/{meta['id']}/download", headers=bearer(key)).status_code == 404


def test_client_filename_is_sanitized_and_html_is_not_served_as_html(client):
    aid, key = _app_with_key(client, scopes=("files:read", "files:write"))
    meta = _upload(client, aid, key, "../../etc/passwd", b"x", "text/html").get_json()["data"]["file"]
    assert meta["name"] == "passwd"
    html = _upload(client, aid, key, "page.html", b"<script>x</script>", "text/html").get_json()["data"]["file"]
    assert html["content_type"] == "application/octet-stream"


def test_oversized_and_empty_uploads_rejected(make_app):
    app = make_app(max_file_bytes=100)
    c = app.test_client()
    aid, key = _app_with_key(c, scopes=("files:write",))
    r = _upload(c, aid, key, "big.txt", b"x" * 101)
    assert r.status_code == 413 and r.get_json()["error"]["code"] == "FILE_TOO_LARGE"
    r = _upload(c, aid, key, "empty.txt", b"")
    assert r.status_code == 400


def test_file_scope_and_cross_app_access(app):
    owner_a, owner_b = app.test_client(), app.test_client()
    aid1, key1 = _app_with_key(owner_a, scopes=("files:read", "files:write"))
    aid2, key2 = _app_with_key(owner_b, scopes=("files:read", "files:write"))
    c = app.test_client()
    meta = _upload(c, aid1, key1, "a.txt", b"secret").get_json()["data"]["file"]
    leak = c.get(f"/api/v1/files/{meta['id']}?app_id={aid1}", headers=bearer(key2))
    assert leak.status_code == 404 and b"a.txt" not in leak.data  # app 2 key only ever sees app 2
    readonly = create_key(owner_a, aid1, scopes=("db:read",))["api_key"]
    assert _upload(c, aid1, readonly, "b.txt", b"nope").status_code == 403


def test_bad_file_ids_rejected(client):
    aid, key = _app_with_key(client, scopes=("files:read",))
    assert client.get(f"/api/v1/files/..%2F..%2Fx?app_id={aid}", headers=bearer(key)).status_code in (400, 404)


# ================================================================ GitHub storage failure handling
class _Resp:
    def __init__(self, status, body=None, headers=None):
        self.status_code = status
        self._body = body
        self.headers = headers or {}
        self.content = json.dumps(body).encode() if body is not None else b""

    def json(self):
        return self._body


def test_github_storage_conflict_maps_to_409(monkeypatch):
    import storage as st
    gh = st.GitHubStorage("tok-SHOULD-NOT-LEAK", "owner/repo")
    monkeypatch.setattr(st.requests, "request", lambda *a, **k: _Resp(409, {"message": "conflict"}))
    with pytest.raises(st.Conflict):
        gh.write("apps/x/a.json", b"{}", "msg", sha="abc")


def test_github_read_retries_then_fails_safely(monkeypatch):
    import storage as st
    calls = {"n": 0}

    def boom(*a, **k):
        calls["n"] += 1
        return _Resp(500, {"message": "internal tok-SHOULD-NOT-LEAK"})
    monkeypatch.setattr(st.requests, "request", boom)
    monkeypatch.setattr(st.time, "sleep", lambda s: None)
    gh = st.GitHubStorage("tok-SHOULD-NOT-LEAK", "owner/repo", read_retries=2)
    with pytest.raises(st.Upstream) as e:
        gh.read("apps/x/a.json")
    assert calls["n"] == 3
    assert "tok-SHOULD-NOT-LEAK" not in str(e.value)


def test_github_writes_are_not_retried(monkeypatch):
    import storage as st
    calls = {"n": 0}

    def fail(*a, **k):
        calls["n"] += 1
        return _Resp(500, {})
    monkeypatch.setattr(st.requests, "request", fail)
    gh = st.GitHubStorage("t", "owner/repo")
    with pytest.raises(st.Upstream):
        gh.write("apps/x/a.json", b"{}", "msg")
    assert calls["n"] == 1


def test_github_rate_limit_maps_to_429(monkeypatch):
    import storage as st
    monkeypatch.setattr(st.requests, "request",
                        lambda *a, **k: _Resp(403, {}, headers={"x-ratelimit-remaining": "0"}))
    with pytest.raises(st.Busy) as e:
        st.GitHubStorage("t", "owner/repo").read("a.json")
    assert e.value.status == 429


def test_github_network_error_is_upstream(monkeypatch):
    import requests
    import storage as st

    def down(*a, **k):
        raise requests.ConnectionError("tok-SHOULD-NOT-LEAK")
    monkeypatch.setattr(st.requests, "request", down)
    with pytest.raises(st.Upstream) as e:
        st.GitHubStorage("tok-SHOULD-NOT-LEAK", "owner/repo", read_retries=0).read("a.json")
    assert "tok-SHOULD-NOT-LEAK" not in str(e.value)


def test_upstream_failure_in_api_is_sanitized(client, storage, monkeypatch):
    signup(client, "tina_19")
    aid = create_app_as(client)
    key = create_key(client, aid, scopes=("db:read",))
    from storage import Upstream
    monkeypatch.setattr(storage, "read", lambda *a, **k: (_ for _ in ()).throw(Upstream("Storage read failed.")))
    r = client.get(f"/api/v1/db/{aid}/notes/{'a' * 24}", headers=bearer(key["api_key"]))
    assert r.status_code == 502
    body = r.get_data(as_text=True)
    assert "Traceback" not in body and "ghp_" not in body and key["api_key"] not in body


def test_unexpected_errors_hide_details(client, monkeypatch):
    import records
    signup(client, "uma_20")
    aid = create_app_as(client)
    key = create_key(client, aid, scopes=("db:read",))
    monkeypatch.setattr(records, "list_page", lambda *a, **k: (_ for _ in ()).throw(RuntimeError("secret-internal-detail")))
    r = client.get(f"/api/v1/db/{aid}/notes", headers=bearer(key["api_key"]))
    assert r.status_code == 500 and r.get_json()["error"]["code"] == "INTERNAL_ERROR"
    assert "secret-internal-detail" not in r.get_data(as_text=True)


# ================================================================ CORS
def test_public_static_endpoints_exist(client):
    assert client.get("/api/hello").get_json()["message"] == "Hello from Python!"
    assert "utc" in client.get("/api/time").get_json()


def test_cors_allows_only_configured_origins_with_credentials(client):
    r = client.get("/api/hello", headers={"Origin": "https://frontend.example.com"})
    assert r.status_code == 200
    assert r.headers["Access-Control-Allow-Origin"] == "https://frontend.example.com"
    assert r.headers["Access-Control-Allow-Credentials"] == "true"
    r = client.get("/api/hello", headers={"Origin": "https://evil.example.com"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_cors_preflight(client):
    r = client.open("/api/v1/apps", method="OPTIONS",
                    headers={"Origin": "https://frontend.example.com",
                             "Access-Control-Request-Method": "POST"})
    assert r.status_code == 204
    assert r.headers["Access-Control-Allow-Origin"] == "https://frontend.example.com"
    assert "X-CSRF-Token" in r.headers["Access-Control-Allow-Headers"]
    r = client.open("/api/v1/apps", method="OPTIONS", headers={"Origin": "https://evil.example.com"})
    assert "Access-Control-Allow-Origin" not in r.headers


def test_no_wildcard_cors_anywhere(client):
    for path in ["/api/hello", "/api/health", "/api/v1/auth/csrf"]:
        r = client.get(path, headers={"Origin": "https://x.example.com"})
        assert r.headers.get("Access-Control-Allow-Origin") != "*"


# ================================================================ health and legacy
def test_health_reports_status_without_secrets(client, storage, monkeypatch):
    r = client.get("/api/health")
    assert r.status_code == 200 and r.get_json()["storage"] == "ok"
    from storage import Upstream
    monkeypatch.setattr(storage, "check", lambda: (_ for _ in ()).throw(Upstream("down")))
    r = client.get("/api/health")
    assert r.status_code == 503 and r.get_json()["storage"] == "unavailable"
    assert "token" not in r.get_data(as_text=True).lower()


def test_legacy_files_api_still_works_for_logged_in_users(client):
    signup(client, "vic_21")
    token = csrf(client)
    r = client.post("/api/files", data={"file": (io.BytesIO(b"legacy"), "old.txt")},
                    headers={"X-CSRF-Token": token})
    assert r.status_code == 201
    assert client.get("/api/files").get_json()["files"][0]["name"] == "old.txt"
    assert client.get("/api/files/old.txt").data == b"legacy"


def test_legacy_files_reject_anonymous(client):
    assert client.get("/api/files").status_code == 401


def test_protected_routes_reject_anonymous(client):
    assert client.get("/api/v1/apps").status_code == 401
    aid = "demo-app-abc123"
    assert client.get(f"/api/v1/db/{aid}/notes").status_code == 401
    assert client.get(f"/api/v1/files?app_id={aid}").status_code == 401


def test_pages_render(client):
    assert client.get("/").status_code == 200
    assert client.get("/login").status_code == 200
    assert client.get("/signup").status_code == 200
    r = client.get("/dashboard")
    assert r.status_code == 302
