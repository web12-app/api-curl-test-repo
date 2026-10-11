# API reference

All JSON routes return one of two shapes:

```json
{ "success": true,  "data": { } }
{ "success": false, "error": { "code": "FILE_TOO_LARGE", "message": "Files must be 25 MB or smaller." } }
```

Clients should branch on `error.code`, not on `message`, which may change.

Pages and file downloads are not JSON. Errors on those routes show a plain HTML page with the same status code.

## Headers and rules

| Rule | Applies to | Detail |
| --- | --- | --- |
| Session cookie | Routes that need a user | `session` cookie set at login. `HttpOnly`, `SameSite=Lax`. |
| `X-Requested-With: fetch` | Every state-changing route (`POST`, `PUT`, `DELETE`) that uses a session | Missing it returns `403 CSRF_HEADER_REQUIRED`. Protects against cross-site form posts. |
| Same origin | Every non-`GET` request | If the request has an `Origin` header, it must match the host (or be in `CORS_ALLOWED_ORIGINS`). Otherwise `403 CROSS_SITE_REFUSED`. Requests with no `Origin` are allowed. |
| Public upload links | `POST /u/<token>/upload` | Exempt from the same-origin and CSRF-header checks, because the link token is the credential. |
| CORS | `/api/` only | Allowed origins come from `CORS_ALLOWED_ORIGINS`. Methods: `GET, POST, PUT, DELETE`. Headers: `Content-Type` only. |

> **Browser note.** Because CORS allows only `Content-Type`, a browser page on another origin cannot send `X-Requested-With`. It can read responses from allowed origins, but it cannot make state-changing calls. Use the app's own pages, or a non-browser client, for changes.

## Accounts

| Method and path | Body | Success | Errors |
| --- | --- | --- | --- |
| `POST /api/signup` | `{"username","password"}` | `201`, sets cookie, `data.user` | `400 INVALID_USERNAME`, `400 INVALID_PASSWORD`, `409 USERNAME_TAKEN`, `429 RATE_LIMITED`, `503 NOT_CONFIGURED` |
| `POST /api/login` | `{"username","password"}` | `200`, sets cookie, `data.user` | `401 INVALID_CREDENTIALS`, `429 RATE_LIMITED`, `503 NOT_CONFIGURED` |
| `POST /api/logout` | none | `200`, clears cookie, ends the session on the server | |
| `GET /api/me` | none | `200`, `data.user` (`null` when signed out) | |
| `GET /api/health` | none | `200 {"status":"ok"}` | |

`data.user` is `{ "id", "username" }`. Password hashes are never returned.

Form versions for browsers: `POST /signup` and `POST /login` (form posts, redirect on success, `?error=CODE` on failure), and `POST /logout`.

## Files

All routes below need a session and `X-Requested-With: fetch` where marked.

### List

`GET /api/files?q=<text>&category=<name>`

- `q` (optional, up to 100 characters): case-insensitive name search.
- `category` (optional): one of `image`, `document`, `archive`, `video`, `audio`, `other`. Anything else is `400 INVALID_CATEGORY`.

Response `200`:

```json
{
  "success": true,
  "data": {
    "files": [
      {
        "id": "32 lowercase hex characters",
        "name": "trip.mp4",
        "type": "video/mp4",
        "category": "video",
        "size": 1234567,
        "uploadedAt": "2026-10-11T05:11:36.938Z",
        "status": "ready",
        "visibility": "private",
        "sharePath": null,
        "viaLink": false,
        "previewable": true
      }
    ],
    "quota": { "usedBytes": 1234567, "count": 1, "maxFiles": 200 }
  }
}
```

`quota.usedBytes` is informational. There is no byte limit. `status` is `ready` or `deleting`. `visibility` is `public` only while a share link is active; then `sharePath` is `/s/<token>`.

### Upload

`POST /api/files/upload` with `multipart/form-data` (needs `X-Requested-With: fetch`).

| Field | Required | Rules |
| --- | --- | --- |
| `file` | yes | One file. The name is cleaned (path parts and control characters removed). |
| `uploadId` | yes | A UUID you create per file. Reusing it returns the stored file (`200`, `duplicate` semantics) instead of storing a second copy. |

Response `201` (or `200` for a repeat) with `data.file`, the same shape as list items.

Errors: `400 INVALID_UPLOAD_ID`, `400 INVALID_FILENAME`, `400 EMPTY_FILE`, `400 FILE_REQUIRED`, `400 INVALID_MULTIPART`, `400 TOO_MANY_PARTS`, `400 TOO_MANY_FILES`, `400 UPLOAD_INTERRUPTED`, `413 FILE_TOO_LARGE` (over 25 MB; refused before the body is read when `Content-Length` says so, otherwise while streaming), `415 UNSUPPORTED_MEDIA_TYPE` (not multipart), `415 FILE_CONTENT_MISMATCH`, `409 UPLOAD_ID_USED`, `409 UPLOAD_IN_PROGRESS`, `507 FILE_LIMIT_REACHED` (200 files), `429 RATE_LIMITED` (60 per hour), `429 TOO_MANY_UPLOADS` (4 at once), `503 BUSY`, `503 UPSTREAM_ERROR`.

Example with curl:

```bash
curl -b cookies.txt -H 'X-Requested-With: fetch' -H 'Origin: http://localhost:3000' \
  -F "uploadId=$(uuidgen)" -F "file=@./trip.mp4" \
  http://localhost:3000/api/files/upload
```

### Download

`GET /api/files/<id>/download`

Returns the bytes with `Content-Disposition: attachment` (name in ASCII and in `filename*`), `X-Content-Type-Options: nosniff`, `Cache-Control: no-store`. Unknown types have `Content-Type: application/octet-stream`.

### Preview

`GET /api/files/<id>/preview`

Only for previewable types. Other types get `415 PREVIEW_NOT_AVAILABLE`.

- `Content-Disposition: inline`
- `X-Frame-Options: SAMEORIGIN` (only this site can frame it)
- For PDF: `Content-Security-Policy: default-src 'none'; object-src 'self'; frame-ancestors 'self'`
- For everything else: `Content-Security-Policy: default-src 'none'; style-src 'unsafe-inline'; img-src 'self'; sandbox`

### Sharing

`PUT /api/files/<id>/sharing` (needs `X-Requested-With: fetch`)

```json
{ "public": true }
```

`true` creates a new random link (or keeps the current one if already public). `false` ends the link. Response `200` with `data.file`, whose `sharePath` is the link path.

Errors: `400 INVALID_BODY` (not a boolean `public`), `404 NOT_FOUND` (not your file, or unknown), `409 UPLOAD_IN_PROGRESS`, `409 FILE_BUSY`.

### Delete

`DELETE /api/files/<id>` (needs `X-Requested-With: fetch`)

Removes the stored bytes, the release, and the record. Its share link (if any) returns `404` from then on. Response `200`. Retrying after a failure is safe; a file that failed partway stays `deleting` until a retry finishes.

Errors: `404 NOT_FOUND`, `404 FILE_MISSING` (the stored bytes were removed outside the app), `409 FILE_BUSY`, `409 CONFLICT`, `503 UPSTREAM_ERROR`.

## Public share pages (no login)

| Method and path | What it returns |
| --- | --- |
| `GET /s/<token>` | HTML page: name, size, type, preview if allowed, Download button. |
| `GET /s/<token>/download` | The bytes as an attachment. |
| `GET /s/<token>/preview` | Inline preview, for previewable types only. |

`<token>` is 43 URL-safe characters. Anything else, and any token that is not an active share, returns `404`. Requests from one address are limited to 300 per 15 minutes (`429 RATE_LIMITED`). Responses never contain GitHub names, tags, or asset URLs.

## Upload links

### Owner routes (session, `X-Requested-With: fetch`)

| Method and path | Body | Success |
| --- | --- | --- |
| `GET /api/upload-links` | none | `200`, `data.links` |
| `POST /api/upload-links` | `{"label"?: string}` (label up to 60 characters; control characters removed) | `201`, `data.link` |
| `DELETE /api/upload-links/<id>` | none | `200`, `data.link` (revoked) |

A link object:

```json
{
  "id": "32 hex characters",
  "label": "Trip photos",
  "createdAt": "2026-10-11T05:11:36.938Z",
  "revokedAt": null,
  "active": true,
  "uploadPath": "/u/<token>",
  "uploads": 3,
  "usedBytes": 4096
}
```

`uploadPath` is `null` once the link is revoked. The list only counts files that are `ready`.

Errors: `400 INVALID_LABEL`, `409 TOO_MANY_LINKS` (20 active), `404 NOT_FOUND` (not your link).

### Public routes (no login, no CSRF header)

| Method and path | What it does |
| --- | --- |
| `GET /u/<token>` | HTML form with a file field and a hidden `uploadId`. No script. |
| `POST /u/<token>/upload` | Accepts one `multipart/form-data` file. Returns an HTML "was stored" page (`200`). |

Both routes are limited to 300 requests per 15 minutes per address (`429`). Uploads through links are also limited to 30 per hour per address.

Errors on the upload route: `404` for an unknown, revoked, or wrong token; `507 LINK_FILE_LIMIT` (20 files); `507 LINK_SIZE_LIMIT` (500 MB); `507 FILE_LIMIT_REACHED` (the owner's 200-file limit); `413 FILE_TOO_LARGE`; `415 FILE_CONTENT_MISMATCH`; `429 RATE_LIMITED`.

The stored file records `linkId` only. The uploader's address is never stored.

## Status codes at a glance

| Code | Meaning in this API |
| --- | --- |
| 200 | Success, or a repeated upload |
| 201 | Created (account, file, upload link) |
| 400 | The request is malformed or fails validation |
| 401 | No valid session |
| 403 | Missing `X-Requested-With`, or a cross-site request |
| 404 | Not found, or not yours (the API does not say which) |
| 409 | Conflict: name taken, busy record, or a collision |
| 413 | File too large |
| 415 | Wrong media type, content mismatch, or not previewable |
| 429 | Rate limit or too many concurrent uploads |
| 503 | Not configured, storage unavailable, or GitHub rate limit |
| 507 | Storage limit reached (files or link limits) |
