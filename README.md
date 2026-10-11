# Pips platform

A small, reusable platform for apps: user accounts, apps, scoped API keys, a JSON database, and file storage.
The web UI and the API are one Next.js application in [`web/`](web/). All private data is stored in a
separate **private** GitHub repository, so this public repo contains no data and no secrets.

## How it fits together

- **`web/`**: Next.js 16 (App Router). Pages: `/`, `/signup`, `/login`, `/dashboard`. API: `/api/...`.
- **Private data repo** (`PRIVATE_DATA_REPO`, for example `web12-app/api-curl-private-data`): users, apps,
  API keys, records, and files as JSON or binary files. Only the server reads and writes it, using `GITHUB_TOKEN`.
- **Hosting**: the app runs on Render (see `render.yaml`).
- **Welcome page**: `pages/` is a static site on GitHub Pages (`.github/workflows/pages.yml`). It has no Python and
  no API. Its Log in and Sign up buttons point at the Render app, set by the `APP_URL` variable.

Nothing in this repo may contain a token, password, or key. Configuration comes only from environment variables.

## Configuration

| Variable | Required | Notes |
| --- | --- | --- |
| `SECRET_KEY` | yes | Signs session cookies. Random, at least 32 bytes. |
| `API_KEY_HASH_SECRET` | yes | Pepper for hashing API keys. Changing it revokes all keys. |
| `GITHUB_TOKEN` | yes | Fine-grained token with Contents read and write on the private data repo only. |
| `PRIVATE_DATA_REPO` | yes | `owner/name` of the private data repo. |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated https origins that may call the API from a browser. Never `*`. |
| `COOKIE_SECURE` | no | Default on. Set `0` only for local http development. |
| `COOKIE_SAMESITE` | no | `Lax` (default), `Strict`, or `None` (needs secure cookies). |
| `SESSION_HOURS` | no | Session lifetime. Default 12. |
| `MAX_RECORD_BYTES` | no | Record size limit. Default 65536. |
| `MAX_FILE_BYTES` | no | File size limit. Default and maximum 1,000,000 (GitHub Contents API limit). |
| `LEGACY_API_KEY` | no | Enables the legacy `/api/files` endpoints for `X-API-Key`. |

Missing or invalid settings are reported at startup by variable name only. Values are never printed.
A `.env.example` lists the variables with placeholders.

## Run locally

```bash
cd web
npm ci
export SECRET_KEY=$(openssl rand -hex 32) API_KEY_HASH_SECRET=$(openssl rand -hex 32)
export GITHUB_TOKEN=... PRIVATE_DATA_REPO=owner/private-data COOKIE_SECURE=0
npm run dev            # or: npm run build && npm start
```

Tests (no network, no GitHub calls; storage is in memory):

```bash
cd web
npm test               # vitest: config, passwords, paths, storage, and API flows
npm run typecheck
```

## Deploy on Render

1. In Render: **New → Blueprint**, pick this repo and the `platform-v1` branch (or `main` after merge).
2. Enter `GITHUB_TOKEN` when prompted. `SECRET_KEY` and `API_KEY_HASH_SECRET` are generated.
3. Open the service URL. Sign up, create an app, and create a key.
4. Optional: in the `github-pages` environment, set the variable `APP_URL` to the Render URL, for example
   `https://pips-platform.onrender.com`. Until it is set, the Pages welcome page disables its buttons.

The free plan sleeps when idle, so the first request after a quiet period can take about a minute.

## Concepts

- **Owners** sign up and log in with a username and password. Passwords are hashed with scrypt.
  Existing werkzeug hashes from the earlier Flask version still verify.
- **Apps** belong to one owner. Only the owner can create, change, list, or delete them. Deleting an app is a
  soft delete: it requires `{"confirm": "<app_id>"}`, revokes all its keys, and keeps the data.
- **API keys** belong to one app and have scopes: `db:read`, `db:write`, `files:read`, `files:write`.
  The full key (`<app_id>.<key_id>.<secret>`) is shown once. Only an HMAC hash is stored. A key can expire
  after 1 to 365 days (optional) and can be revoked. API keys can never manage apps or keys.
- **Requests** authenticate with `Authorization: Bearer <key>` (or `X-API-Key`), or with the session cookie
  for the owner UI. Cookie-authenticated writes must send `X-CSRF-Token` (from `GET /api/v1/auth/csrf`).

## API reference

All `/api/v1` responses use this envelope:

```json
{ "success": true, "data": { }, "request_id": "..." }
{ "success": false, "error": { "code": "VERSION_CONFLICT", "message": "..." }, "request_id": "..." }
```

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/api/health` | none | Storage status. No configuration values. |
| GET | `/api/v1/auth/csrf` | none | CSRF token for this session. |
| POST | `/api/v1/auth/signup` | CSRF | `{username, password}`. Logs in. |
| POST | `/api/v1/auth/login` | CSRF | `{username, password}`. Rate limited. |
| POST | `/api/v1/auth/logout` | CSRF | Ends the session. |
| GET | `/api/v1/auth/me` | optional | Current user or `null`. |
| GET, POST | `/api/v1/apps` | owner session | List or create apps. |
| GET, PATCH, DELETE | `/api/v1/apps/{appId}` | owner (GET also a key with `db:read`) | Read, change name/description, or soft-delete. |
| GET, POST | `/api/v1/apps/{appId}/keys` | owner | List or create keys. The secret is returned once. |
| DELETE | `/api/v1/apps/{appId}/keys/{keyId}` | owner | Revoke a key. |
| GET, POST | `/api/v1/db/{appId}/{collection}` | key or owner | List records (`limit` 1-100; `cursor` is a numeric offset, starting at 0) or create one. |
| GET, PUT, PATCH, DELETE | `/api/v1/db/{appId}/{collection}/{recordId}` | key or owner | Read, replace, merge (`null` removes a field), or delete. |
| GET, POST | `/api/v1/files` | key or owner (`?app_id=`) | List files or upload (multipart field `file`). |
| GET, DELETE | `/api/v1/files/{fileId}` | key or owner | File metadata or delete. |
| GET | `/api/v1/files/{fileId}/download` | key or owner | Download. Always `attachment`, `nosniff`. |
| GET, POST | `/api/files`, `/api/files/{name}` | session or `X-API-Key: LEGACY_API_KEY` | Legacy file API (unchanged shape). |
| GET | `/api/hello`, `/api/time`, `/api/me` | none | Legacy endpoints (unchanged shape). |

**Concurrency.** Records have a `version`. Send `If-Match: <version>` (or `expected_version`) to update safely.
A mismatch returns `409 VERSION_CONFLICT`. Writes to GitHub also use the current blob SHA, so a stale write
returns `409` and is never retried automatically.

**Limits.** Request body 2 MB. Record 64 KB. File 1,000,000 bytes. Page size 100. Collection names start with
a lowercase letter, then lowercase letters, digits, `_` or `-` (48 characters at most).

**Error codes** (examples): `UNAUTHENTICATED`, `INVALID_API_KEY`, `PERMISSION_DENIED`, `CSRF_FAILED`,
`INVALID_JSON`, `INVALID_BODY`, `RECORD_TOO_LARGE`, `FILE_TOO_LARGE`, `EMPTY_FILE`, `MISSING_FILE`,
`VERSION_CONFLICT`, `RATE_LIMITED`, `PAYLOAD_TOO_LARGE`, `NOT_CONFIGURED`, `UPSTREAM_ERROR`, `INTERNAL_ERROR`.

## Data layout (private repo)

```
users/<user_id>.json
system/usernames/<username>.json          -> user_id
system/owners/<user_id>/<app_id>.json     -> app index
apps/<app_id>/metadata.json
apps/<app_id>/api_keys/<key_id>.json      -> HMAC hash, scopes, expiry, revocation
apps/<app_id>/database/collections/<collection>/<record_id>.json
apps/<app_id>/files/meta/<file_id>.json
apps/<app_id>/files/blobs/<file_id>.bin
files/<name>                              -> legacy file API
```

Client filenames are only display names. They never become repository paths.

## Limits and known gaps

- Rate limits (login, signup) are in memory. They reset on restart and apply per instance. Run one instance,
  or add a shared store before scaling out.
- Each record write is one GitHub commit. Multi-record changes are not transactional.
- Listing reads one file per item on the page, so keep page sizes small.
- Not yet built: a JavaScript SDK, a database browser UI, schema validation, and an admin purge tool.
- The legacy `/api/hello` response still says "Hello from Python!" because clients may depend on it.
  Changing it is a breaking change, so it is left as is.

## Security notes

- CORS allows only listed origins and never sends credentials to others.
- Sessions are signed, HttpOnly, and `SameSite=Lax` by default. Owner routes refuse API keys.
- Error responses never include stack traces, tokens, or repository paths.
- Uploaded files are served as `attachment` with `X-Content-Type-Options: nosniff`. Only a short list of
  safe types keeps its own content type; everything else is `application/octet-stream`.
- Report a leaked key or token immediately, and rotate it in Render and GitHub.
