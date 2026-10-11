# Architecture and security

## Components

```
Browser ──HTTPS──> Node.js server (src/server.js)
                     ├─ accounts.js   signup, login, password hashing (scrypt), sessions
                     ├─ files.js      FileService: manifests, reservations, sharing, upload links
                     ├─ upload.js     streams multipart uploads to a temp file (busboy)
                     ├─ file-types.js extensions, signatures, previewable types
                     ├─ github-storage.js    Contents API client for the private data repo
                     └─ github-releases.js   Releases API client for the storage repo
                                  │
          ┌───────────────────────┴───────────────────────┐
          ▼                                               ▼
  Private data repo                                Storage repo (private)
  users/, system/usernames/,                       one release per upload,
  uploads/<id>/manifest.json,                      tag upload-<fileId>,
  shares/, upload-links/                           asset <fileId><ext>
```

- `src/server.js` owns routing, cookies, CSRF and origin checks, rate limits, and the HTML pages (through `src/pages.js`). The logged-in app pages (`/home`, `/explore`) are React shells: the server sends styles, a JSON bootstrap block, and `/assets/app.js` - the compiled React bundle from `client/` (built with esbuild, committed under `public/assets/`).
- Nothing is cached in memory across requests except rate-limit counters and the storage-repo privacy check.
- The app has one runtime dependency, `busboy`, for streaming multipart parsing.

## Data layout

### Private data repo

| Path | Contents | Written by |
| --- | --- | --- |
| `system/usernames/<name>.json` | Claims a username: `{ "user_id" }` | signup |
| `users/<id>.json` | `{ id, username, password_hash, created_at }` | signup |
| `uploads/<id>/manifest.json` | Every file and upload link of one user (below) | file routes |
| `shares/<sha256 of token>.json` | `{ uid, fileId }`: resolves a share token to its owner | enabling sharing |
| `upload-links/<sha256 of token>.json` | `{ uid, linkId }`: resolves an upload-link token to its owner | creating a link |

Only these path shapes are ever written. Client input never becomes a path unless it matches the allowlist in `src/paths.js`.

### Manifest (`uploads/<id>/manifest.json`)

```json
{
  "version": 1,
  "files": [
    {
      "id": "32 hex",
      "uploadId": "UUID from the client",
      "name": "trip.mp4",
      "type": "video/mp4",
      "category": "video",
      "ext": ".mp4",
      "size": 1234567,
      "status": "ready",
      "createdAt": "...", "reservedAt": 1791695496938, "readyAt": "...",
      "tag": "upload-<id>", "assetId": 1294,
      "linkId": null,
      "visibility": "private", "shareToken": null, "shareHash": null, "sharedAt": null
    }
  ],
  "uploadLinks": [
    { "id": "32 hex", "label": "Trip photos", "createdAt": "...", "revokedAt": null,
      "tokenHash": "64 hex", "token": "43 chars" }
  ]
}
```

File `status` values:

| Status | Meaning |
| --- | --- |
| `pending` | Reserved; the bytes are being stored. Counts toward limits. |
| `ready` | Stored and listed. |
| `deleting` | A delete started and has not finished. Retrying finishes it. |
| `failed` | Storing failed. Not listed. A later write cleans it up. |

The owner's manifest is the **source of truth**. A share or upload-link index file is only a lookup. A link works only while the manifest entry still holds the same hash, so a leftover index does nothing.

The raw share token and upload-link token are kept in the owner's manifest so the owner can see the link again. Anyone who can read the private data repo can read those tokens. Keep that repo private.

### Storage repo

- One release per upload: tag `upload-<fileId>`, not a draft, not marked latest.
- One asset per release, named `<fileId><extension>`, with the file's own content type.
- Release names and assets never carry the user's name. Users see names only through the app.

## How an upload works

1. **Check.** Size is checked against `Content-Length` when present. The upload rate limit is checked.
2. **Receive.** `busboy` streams the file to a temp directory, with the size limit enforced while bytes arrive. Chunked uploads are limited the same way.
3. **Validate.** The name is cleaned. The extension picks a type. Empty files are refused. Known types must match their signature.
4. **Reserve.** Under the manifest lock (read, change, write with the file's SHA), a `pending` entry is added. The file count, the per-link limits, and the upload id (for repeats) are checked here.
5. **Store.** The release is created, then the asset is uploaded to it.
6. **Mark ready.** The entry becomes `ready` in the manifest. The temp file is deleted.

Piece-by-piece uploads run the same steps, with two extra stages. Each piece is written to the temp directory under a per-session lock, and it counts as received only once its `.sha256` file exists (that file is written last). A repeated identical piece is a no-op, and different bytes for the same piece are refused with `CHUNK_CONFLICT`. Completion joins the pieces, checks each piece's hash again, and then runs the same checks and the same `FileService.upload` step as a whole-file upload. Because `FileService.upload` is idempotent on the upload id, a repeated completion returns the stored file. A completed session keeps only a small record, so a repeat can be answered after its pieces are removed.

If step 5 fails, the reservation is removed or left `failed` and cleaned up later. Writes are never retried automatically; a conflict returns `409`. This keeps the manifest consistent without a database.

## How sharing works

1. Enabling sharing generates 32 random bytes, encoded as 43 URL-safe characters: the token.
2. The app stores the token in the manifest entry, stores `sha256(token)` as `shareHash`, and writes `shares/<sha256>.json`.
3. A public request hashes the token, reads the index, then reads the owner's manifest. It serves the file only when the entry is still public **and** its `shareHash` matches.
4. Turning sharing off clears the token and deletes the index. Turning it on again makes a new token, so the old one fails.
5. Deleting the file removes the entry, so the link returns `404`.

## How upload links work

The same token pattern is used for `/u/<token>`. The owner's manifest holds the link (`uploadLinks`). Each file that comes through a link records `linkId`, and the limits per link count files with that `linkId`. Revoking sets `revokedAt` and removes the index. The public upload route checks the link under the same manifest lock as every other reservation, so a revoke and an upload cannot both succeed.

## How URL import works

1. **Start.** The request is checked (session, `X-Requested-With`, Origin, rate limit) and the link is validated: `http://` or `https://` of any shape (any port, an IP literal, `user:password@` for basic auth), or a `data:` link whose bytes are decoded directly. Host names on the blocked list and private addresses are refused unless `IMPORT_ALLOW_PRIVATE=1`; network links are at most 2048 characters. A job is recorded under `owner:uploadId` before any network work starts, so two identical requests at the same moment start one download.
2. **Resolve.** An IP-literal host is used as it is; every other address the host name resolves to must be public (or allowed by `IMPORT_ALLOW_PRIVATE`). One private address refuses the whole name. The connection is made to an address that was already checked, so a second DNS lookup cannot point it somewhere else.
3. **Download.** Only a few headers are sent, plus one Basic auth header when the link carries a user name and password. Redirects are followed up to three times, and each new address is checked again. Connect, silence, and total timeouts stop the job. The body is written to the temp directory and stops at the 2 GB ceiling. Imports run in the background; the browser only watches.
4. **Store.** The downloaded file goes through the same checks and `FileService.upload` as an upload from the dashboard. The temp file is deleted however the job ends.

Jobs are kept in memory. Only the owner can see or cancel a job. Logs and stored records hold no link, host, or path, and names are masked.

## Security model

| Control | How it works |
| --- | --- |
| Passwords | scrypt, per-user salt. Only the hash is stored. Never returned or logged. |
| Sessions | Signed cookies (`HttpOnly`, `SameSite=Lax`, `Secure` by default). Logout ends the session on the server too. |
| CSRF | Every state-changing session route needs `X-Requested-With: fetch`, and a request with an `Origin` must match the host or an allowed origin. |
| Public links | Credentials are random 256-bit tokens. Only their hashes are used for lookup. Revoke, re-enable, and delete all end old links. |
| Downloads | `Content-Disposition: attachment`, `nosniff`, `Cache-Control: no-store`. Unknown types are `application/octet-stream`. |
| Previews | Only previewable types. Inline with a sandboxed CSP; media types also get `media-src 'self'` so a tab can play them. Frames only from this site. HTML and SVG are never previewed. |
| Content checks | Known types are checked by signature (first 16 bytes), text by UTF-8 validity, so a renamed file is refused. |
| Names | Path parts and control characters are removed. Storage paths never come from the user's name. |
| Storage repo | Must be private. The app checks before accepting any upload. |
| Credentials | The GitHub token stays on the server. Browsers see only this app's routes, never GitHub URLs, tags, or asset IDs. |
| Logs | Upload and link events log masked data only (see below). Errors log the error type, not the message. |
| Rate limits | Login, signup, uploads per hour, share requests, and upload-link requests (per address). In memory, per process. |

### Masked logs

Log lines for uploads, links, and sharing never contain a full name, a full token, or a full link. Helpers are in `src/redact.js`:

- a name is shown as its first character, `…`, and its extension: `Q…txt`
- an identifier is shown as the first 8 characters of its SHA-256: `id=3f2a9c1e`

Example:

```
upload stored: file=Q…txt id=8c1f0d2a owner=4c3090e1
upload stored: file=B…pdf id=5e0a7b11 owner=4c3090e1 link=42259b23
upload link created: link=42259b23 owner=4c3090e1
share enabled: file=Q…txt id=8c1f0d2a
```

This matters because the repository is public, so GitHub Actions logs are public too. Tests capture `console.log` and fail if a full name, label, token, link, or file id appears.

## Known limits and gaps

- **No range requests.** Browsers can play video, but seeking may not work. Adding `Range` support is future work.
- **Rate limits are per process.** Several instances would each count separately. The single-runner workflow is one process.
- **PDF and media playback** in the preview depend on the browser's built-in viewer and are not checked in automated tests.
- **Cross-origin browser clients cannot make changes.** CORS allows only `Content-Type` (see [API reference](api.md#headers-and-rules)).
- **Broad token.** The GitHub token used by the workflow is a classic personal access token with broad scopes. Replace it with a fine-grained token limited to the two repos.
- **URL imports are in memory.** A restart stops running imports, and the browser learns that on its next poll (the row offers a retry). Files that finished are still in the file list.
- **Pieces need a disk that survives restarts** to resume after one. Set `FILE_TEMP_DIR` to a persistent path. Without it, pieces go to the OS temp directory.
- **No antivirus scanning.** Stored files are not scanned. Downloads are forced to attachments for unknown types, which limits the risk.
