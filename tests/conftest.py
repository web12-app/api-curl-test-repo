import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
sys.path.insert(0, ROOT)

import pytest  # noqa: E402

import accounts  # noqa: E402
from app import create_app  # noqa: E402
from config import load_config  # noqa: E402
from storage import MemoryStorage  # noqa: E402


@pytest.fixture(autouse=True)
def _reset_rate_limits():
    accounts.limiter._hits.clear()
    yield
    accounts.limiter._hits.clear()


@pytest.fixture
def storage():
    return MemoryStorage()


@pytest.fixture
def make_app(storage):
    def _make(**overrides):
        cfg = load_config(env={}, testing=True)
        if overrides:
            from dataclasses import replace
            cfg = replace(cfg, **overrides)
        return create_app(cfg=cfg, storage=storage)
    return _make


@pytest.fixture
def app(make_app):
    return make_app(cors_allowed_origins=("https://frontend.example.com",))


@pytest.fixture
def client(app):
    return app.test_client()


# ---------------------------------------------------------------- helpers
def csrf(c):
    return c.get("/api/v1/auth/csrf").get_json()["data"]["csrf_token"]


def signup(c, username, password="correct-horse-1"):
    r = c.post("/api/v1/auth/signup", json={"username": username, "password": password},
               headers={"X-CSRF-Token": csrf(c)})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["data"]["user"]


def login(c, username, password="correct-horse-1"):
    r = c.post("/api/v1/auth/login", json={"username": username, "password": password},
               headers={"X-CSRF-Token": csrf(c)})
    assert r.status_code == 200, r.get_json()
    return r.get_json()["data"]["user"]


def create_app_as(c, name="Demo App"):
    r = c.post("/api/v1/apps", json={"name": name, "description": "test"},
               headers={"X-CSRF-Token": csrf(c)})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["data"]["app"]["id"]


def create_key(c, aid, scopes=("db:read", "db:write", "files:read", "files:write"), environment="development"):
    r = c.post(f"/api/v1/apps/{aid}/keys",
               json={"name": "k", "environment": environment, "scopes": list(scopes)},
               headers={"X-CSRF-Token": csrf(c)})
    assert r.status_code == 201, r.get_json()
    return r.get_json()["data"]["key"]


def bearer(key):
    return {"Authorization": f"Bearer {key}"}
