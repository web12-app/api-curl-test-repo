# api-curl-test-repo — GitHub-backed app database and file storage

A small, reusable backend for storing JSON records and files per application. Data lives in a
**private** GitHub repository, accessed only by the backend through the GitHub Contents API.
The public repository holds code and documentation only.

> **Status:** core backend is implemented and tested (accounts, apps, API keys, database API,
> file API, CSRF, CORS, rate limits). The JavaScript SDK, database browser UI, schema validation,
> and admin tools are **not built yet**. See *Not yet implemented*.

## Architecture

```
GitHub Pages (static)  ──links──►  Backend (Flask, separately hosted)  ──Contents API──►  Private data repo
  pages/ + Pages home                app.py, accounts.py, apps.py,                         users/, system/,
                                     records.py, files_v1.py, storage.py                   apps/<app_id>/...
```

GitHub Pages only serves static files, so it cannot run the Python backend. Login cookies are set
by the backend's own domain, so the Pages site links to the backend's login pages.

| File | Role |
| --- | --- |
| `app.py` | Flask app factory, routes, CSRF, CORS, security headers, error envelope |
| `config.py` | Startup configuration and validation (no secret values in errors) |
| `storage.py` | Storage engine: GitHub Contents API implementation + in-memory twin for tests |
| `paths.py` | ID validation and every repository path. Clients never supply paths. |
| `accounts.py` | Users, password hashing, login rate limiting |
| `apps.py` | Applications, API keys, request principals, scope checks |
| `records.py` | Database records (versioned JSON documents) |
| `files_v1.py` | App-scoped file storage |
| `errors.py` | Response envelope: `{success, data|error, request_id}` |
| `build_static.py`, `pages/` | GitHub Pages build (static home, login links, public JSON) |
| `tests/` | 54 automated tests (no GitHub access needed) |

## Local setup

```bash
pip install -r requirements.txt -r tests/requirements-dev.txt
cp .env.example .env          # then fill in values; never commit .env
set -a; . ./.env; set +a
python app.py                 # http://127.0.0.1:5000
python -m pytest -q tests     # 54 unit tests, no GitHub calls
```

## Environment configuration

Read only from the hosting environment (or `.env` locally). See `.env.example` for every variable.

| Variable | Required | Notes |
| --- | --- | --- |
| `SECRET_KEY` | yes | Signs sessions |
| `API_KEY_HASH_SECRET` | yes | Peppers stored API-key hashes. Changing it invalidates all keys. |
| `GITHUB_TOKEN` | yes | Fine-grained token, Contents read/write on the private repo only |
| `PRIVATE_DATA_REPO` | yes | `owner/name` of the private repo |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated `https://` origins. Wildcards are rejected. |
| `COOKIE_SAMESITE` | no | `Lax` by default. Use `None` only with a cross-site frontend (requires secure cookies). |

The app refuses to start when a required variable is missing. The error names the variables,
never their values.

**GitHub secret names cannot start with `GITHUB_`.** If you store the token as a GitHub Actions or
environment secret, name it something like `PRIVATE_DATA_TOKEN`, and map it to `GITHUB_TOKEN` on
the host.

## Private data repository

1. Create a private repository (for example `web12-app/api-curl-private-data`).
2. Create a fine-grained token limited to that repository with **Contents: read and write**.
3. Set `PRIVATE_DATA_REPO` and `GITHUB_TOKEN` on the backend host.

Layout (created on demand, not pre-populated):

```
users/<user_id>.json                       account (password hash, username, created)
system/usernames/<username>.json           username -> user_id
system/owners/<user_id>/<app_id>.json      app ownership index
apps/<app_id>/metadata.json                app metadata and owner
apps/<app_id>/api_keys/<key_id>.json       key metadata and HMAC hash (never the secret)
apps/<app_id>/database/collections/<collection>/<record_id>.json
apps/<app_id>/files/meta/<file_id>.json    file metadata
apps/<app_id>/files/blobs/<file_id>.bin    file content
files/<name>                               legacy /api/files store
```

Keep this repository private. Anyone who can read it can read all stored data.

## Backend deployment

Any host that runs Python 3.10+ and gunicorn works (Render, Railway, Fly.io, a VPS).

- Build command: `pip install -r requirements.txt`
- Start command: `gunicorn app:app`
- Set the environment variables above on the host.
- Check `GET /api/health`. It reports `storage: ok` only when the backend can read the private repo.

Run more than one worker or instance only after moving the rate limiter to a shared store (see
Security notes).

## GitHub Pages deployment

The workflow `.github/workflows/pages.yml` runs `build_static.py` and publishes `pages/` and the
public JSON under `/api/`. It does not need any secrets.

Set the repository **variable** `APP_URL` (Settings → Secrets and variables → Actions → Variables)
to the backend's public URL, then re-run the workflow. Without `APP_URL`, the login and signup
buttons on the Pages site are disabled.

## Authentication

- **Signup:** `POST /api/v1/auth/signup` `{username, password}`. Usernames are 3–32 lowercase letters,
  digits, or `_`. Passwords are 8–200 characters and stored with Werkzeug's salted hash.
- **Login:** `POST /api/v1/auth/login`. Sets an HTTP-only session cookie that expires after
  `SESSION_HOURS` (default 12). Logout: `POST /api/v1/auth/logout`. Current user: `GET /api/v1/auth/me`.
- **Rate limits:** 5 failed logins per account per 15 minutes, 30 login attempts per IP per 15
  minutes, 10 signups per IP per hour. Responses are 429.
- **CSRF:** every state-changing request that uses the session cookie needs `X-CSRF-Token` (from
  `GET /api/v1/auth/csrf`) or a `csrf_token` form field. API-key requests don't need it.

## API keys

Each application has its own keys. Owners manage keys with their session (never with an API key).

```bash
# create an app (session + CSRF)
POST /api/v1/apps                       {"name": "Notes", "description": "..."}
# create a key (the full key is returned ONCE)
POST /api/v1/apps/<app_id>/keys         {"name": "web", "environment": "development",
                                         "scopes": ["db:read", "db:write", "files:read", "files:write"],
                                         "expires_in_days": 90}
GET  /api/v1/apps/<app_id>/keys         (metadata only, never the secret)
DELETE /api/v1/apps/<app_id>/keys/<key_id>   (revoke)
```

Keys look like `<app_id>.<key_id>.<secret>`. Send them as `Authorization: Bearer <key>` (or
`X-API-Key: <key>`). A key works only for its own app and only with the scopes it was given.

## Database API

Base: `/api/v1/db/<app_id>/<collection>`. Collections: lowercase, start with a letter, up to 48 characters.

| Method | Path | Scope | Body / notes |
| --- | --- | --- | --- |
| POST | `/…/<collection>` | db:write | JSON object. Returns 201 with the record. |
| GET | `/…/<collection>?limit=20&cursor=0` | db:read | `limit` 1–100. Returns `items` and `next_cursor`. |
| GET | `/…/<collection>/<record_id>` | db:read | |
| PUT | `/…/<collection>/<record_id>` | db:write | Replaces `data`. |
| PATCH | `/…/<collection>/<record_id>` | db:write | Merges fields. `null` removes a field. |
| DELETE | `/…/<collection>/<record_id>` | db:write | 200 with `{id, deleted}`. |

Versioning: each record has a `version` that increases on every write. Send `If-Match: <version>`
(or `"expected_version"` in the body) to avoid overwriting newer changes. A mismatch returns 409.

Records are limited to `MAX_RECORD_BYTES` (default 64 KB). Schema validation is not implemented yet.

## File API

Base: `/api/v1/files`. Use a key, or a logged-in session with `?app_id=<app_id>`.

| Method | Path | Scope | Notes |
| --- | --- | --- | --- |
| POST | `/api/v1/files` | files:write | multipart field `file`. Max `MAX_FILE_BYTES` (≤1 MB). |
| GET | `/api/v1/files` | files:read | Paged metadata (`limit`, `cursor`). |
| GET | `/api/v1/files/<file_id>` | files:read | Metadata. |
| GET | `/api/v1/files/<file_id>/download` | files:read | Served as an attachment with `nosniff`. |
| DELETE | `/api/v1/files/<file_id>` | files:write | |

The client filename is only a display name. It is reduced to its basename and never used in a path.
Only a few extensions keep their own content type. Everything else is `application/octet-stream`.

## Responses and errors

```json
{"success": true, "data": {...}, "request_id": "..."}
{"success": false, "error": {"code": "PERMISSION_DENIED", "message": "..."}, "request_id": "..."}
```

Common codes: `UNAUTHENTICATED` (401), `INVALID_API_KEY` (401), `PERMISSION_DENIED` (403),
`CSRF_FAILED` (403), `NOT_FOUND` (404), `CONFLICT` / `VERSION_CONFLICT` (409),
`PAYLOAD_TOO_LARGE` / `RECORD_TOO_LARGE` / `FILE_TOO_LARGE` (413), `RATE_LIMITED` / `STORAGE_RATE_LIMITED` (429),
`UPSTREAM_ERROR` (502), `INTERNAL_ERROR` (500). Responses never include stack traces, tokens,
environment values, or repository paths.

## Security notes

- Every repository path is built from validated IDs (`paths.py`). Client input never becomes a path.
- App access is checked against the owner (sessions) or the key's app and scopes (API keys) on
  every request. Unknown or foreign apps return 404 for owners, and 403 for key mismatches.
- API keys are stored only as HMAC-SHA256 hashes with a server-side pepper.
- Passwords are stored only as salted hashes.
- Login uses a rate limiter kept in process memory. **With more than one worker, limits are per
  worker.** Move the limiter to a shared store (Redis) before scaling out.
- CORS allows only configured origins, with credentials. There is no wildcard.
- Deleting an app is a **soft delete**: the app is hidden, its keys are revoked, and data is kept.
  Permanent purge is not automatic.

## Storage limitations (GitHub Contents API)

- **Not a transactional database.** Each write is a separate commit. Changes across several records
  are not atomic.
- **Concurrency:** writes use the current blob SHA, so a stale write returns 409 instead of silently
  overwriting. Callers must reload and retry.
- **Retries:** reads retry a few times on transient errors. Writes are never retried automatically.
- **Rate limits:** GitHub limits API calls per token. Listing and reading many records costs one API
  call per record on a page. Expect slower responses as collections grow.
- **Size:** file and record contents over about 1 MB cannot be read through the Contents API, so
  file uploads are capped at 1 MB.
- **Listings:** a directory listing returns at most 1,000 entries.
- **History:** every change creates a Git commit. Deleted data remains in Git history.

## Tests

```bash
python -m pytest -q tests
```

The unit tests use an in-memory storage with the same concurrency rules and mock the GitHub HTTP
layer for failure cases (conflicts, 5xx retries, rate limits, network errors, token leakage). They
never contact GitHub and need no credentials.

An end-to-end check against a real private repo is run separately with production-like credentials
and cleans up the data it creates. It was run once for this release: 13 of 13 checks passed.

## Not yet implemented

- JavaScript SDK (`DatabaseClient` and file helpers)
- Database browser and record editor UI; API documentation page in the frontend
- Schema validation for collections
- Admin role and purge tooling
- Shared rate-limit store (needed for multiple workers)
- Streaming for files larger than 1 MB (the Contents API cannot provide them)
- Frontend pages on GitHub Pages that call the backend directly (today the Pages site only links)

## Troubleshooting

- **Backend returns 503 `NOT_CONFIGURED`:** a required variable is missing. The message names it.
- **`/api/health` returns 503 `storage: unavailable`:** the token is missing, expired, or lacks
  access to `PRIVATE_DATA_REPO`.
- **Login works locally but not on Pages:** set `APP_URL`, and set `CORS_ALLOWED_ORIGINS` to the
  Pages origin. Use `COOKIE_SAMESITE=None` only for a cross-site setup.
- **Every API call returns 403 `CSRF_FAILED`:** send `X-CSRF-Token` from `GET /api/v1/auth/csrf`.
