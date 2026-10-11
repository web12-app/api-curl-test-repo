# Configuration

All configuration comes from **environment variables**. Nothing is read from a config file in the repo. Error messages name the variable that is missing, never its value.

Never put a value in the repository, in static JSON, or in browser JavaScript. Set values in your host's environment settings, or in GitHub under *Settings > Secrets and variables > Actions*.

## Login and accounts

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes, for login and files | GitHub token. Needs read and write on the private data repo and the storage repo only. |
| `PRIVATE_DATA_REPO` | yes | `owner/name` of the private data repo. |
| `SESSION_SECRET` | yes | At least 32 random characters. Signs session cookies. Generate with `openssl rand -hex 32`. |
| `SESSION_HOURS` | no | Session length in hours. Default `12`. Values that are not positive numbers fall back to 12. |
| `COOKIE_SECURE` | no | Default: cookies are `Secure`. Set `0` only for plain-http local runs. |
| `TRUST_PROXY` | no | Set `1` only behind a proxy that overwrites `X-Forwarded-For`. It decides which client address is used for rate limits. |
| `PORT` | no | Listening port. Default `3000`. |
| `CORS_ALLOWED_ORIGINS` | no | Comma-separated **exact** origins (`https://host.example`) allowed to call `/api/` from a browser with cookies. No paths, no wildcards. Empty means no cross-origin access. |

Session cookies are `HttpOnly`, `SameSite=Lax`, `Path=/`, and `Secure` unless `COOKIE_SECURE=0`.

## File storage

File storage is switched on when these two variables are set. Missing values turn off the file routes and the dashboard files section. Login keeps working.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_OWNER` | yes, for files | Owner (user or organization) of the storage repo. |
| `GITHUB_STORAGE_REPO` | yes, for files | Name of the storage repo. Must be private and must differ from `PRIVATE_DATA_REPO`. |

The app checks that the storage repo is private before it accepts any upload, and caches that answer briefly. A public storage repo gets a 503 error.

## Limits

These are set in code (`src/files.js`, `DEFAULT_LIMITS`). Change them there and run the tests.

| Limit | Default | Where it applies |
| --- | --- | --- |
| Per-file size | 25 MB | Every upload: owner, chunked, and upload link. |
| Files per account | 200 | Counts ready and in-progress files. Upload-link uploads count too. |
| Uploads per user per hour | 60 | Owner uploads (in `src/server.js`). |
| Concurrent uploads | 4 | The whole server. More gets `429 TOO_MANY_UPLOADS`. |
| Active upload links per account | 20 | `maxLinks` |
| Files per upload link | 20 | `linkMaxFiles` |
| Bytes per upload link | 500 MB | `linkMaxBytes` |
| Upload-link uploads per address per hour | 30 | `LINK_UPLOADS_PER_HOUR` (in `src/server.js`) |

There is **no total storage quota**. The only storage limit is the file count.

## Repository variables and secrets (GitHub Actions)

The `live-tunnel` workflow reads these. Names only; keep values in GitHub.

**Secrets** (*Settings > Secrets and variables > Actions > Secrets*):

| Name | Purpose |
| --- | --- |
| `NGROK_AUTHTOKEN` | ngrok authentication for the tunnel. |
| `PRIVATE_DATA_TOKEN` | GitHub token passed to the app as `GITHUB_TOKEN`. |
| `SESSION_SECRET` | Session signing key, at least 32 characters. |

**Variables** (*Settings > Secrets and variables > Actions > Variables*):

| Name | Passed to the app as | Notes |
| --- | --- | --- |
| `FILE_STORAGE_OWNER` | `GITHUB_OWNER` | GitHub does not allow variable names that begin with `GITHUB_`, so the workflow uses this name. |
| `FILE_STORAGE_REPO` | `GITHUB_STORAGE_REPO` | Same reason. |

The workflow file also sets `PRIVATE_DATA_REPO`, `CORS_ALLOWED_ORIGINS`, and the ngrok domain. These are not secret, and they are written in the workflow file.

## Variables you should never see in the repo

- `.env` (ignored by git)
- Tokens, session secrets, or ngrok tokens in code, tests, logs, or static pages
- Real repo names of private data in test fixtures. The tests use a fake GitHub.
