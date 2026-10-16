'use strict';

// /docs — the complete HTTP API reference for the whole app (site + tunnel).
// The content lives as markdown and is rendered by the dependency-free
// renderer in src/tunnel-docs.js (renderMarkdown), the same engine behind
// /docs/tunnel — so the two pages stay stylistically and behaviorally identical.

const tunnelDocs = require('./tunnel-docs');
const { renderMarkdown, slugify } = tunnelDocs;

const SECTIONS = [
  'Conventions',
  'Authentication',
  'Site and auth API',
  'Files and uploads API',
  'Sharing and upload links',
  'Pips DB API',
  'Devices API',
  'Social API',
  'Tube API',
  'Model chat API',
  'Tunnel CLI API',
  'Tunnel manager API',
  'Public tunnel routes and docs',
  'Visitor-facing tunnel behavior',
  'Error codes',
  'Limits and environment knobs',
];

const MD = `## Conventions

Every JSON endpoint speaks one envelope. Success:

\`\`\`
{ "success": true, "data": { ... } }
\`\`\`

Failure (a stable \`code\` plus a plain message, HTTP status matches):

\`\`\`
{ "success": false, "error": { "code": "NOT_AUTHENTICATED", "message": "Sign in first." } }
\`\`\`

Paths below are relative to the server origin — on this deployment the base URL is **{{BASE}}**; the same routes work on whatever host serves the app. Browser-facing errors (an \`Accept: text/html\` request) render an HTML error page instead of the JSON envelope. Requests and responses are JSON unless noted. Mutations from the browser require a same-origin request; non-browser clients authenticate with a Bearer token instead (no CSRF check needed).

## Authentication

| Credential | Sent as | Scope | How obtained |
| --- | --- | --- | --- |
| Session cookie | \`session=…\` cookie | Browser pages and all \`/api/*\` site endpoints | \`POST /api/signup\` or \`POST /api/login\` (also the HTML forms \`POST /signup\`, \`POST /login\`) |
| Site API token | \`Authorization: Bearer sat_…\` | The same \`/api/*\` site endpoints from scripts and apps | \`POST /api/tokens\` while signed in |
| Tunnel token | \`Authorization: Bearer tunt_…\` | Tunnel CLI endpoints (register, poll, respond, close, account, protect, unprotect, whoami, logs) | \`POST /api/tunnel/account\`, or \`POST /api/tunnel/tokens\` in the tunnel manager |
| CSRF header | \`X-Requested-With: fetch\` | Browser mutations only | Sent automatically by the app's own fetch calls |

A Bearer token is a header credential: a cross-site page cannot attach one, so Bearer-authenticated requests skip the CSRF origin check. Browser mutations without it must pass the same-origin check or they fail with \`CSRF_HEADER_REQUIRED\` 403.

## Site and auth API

Cookie or \`Bearer sat_…\` unless noted.

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /api/health\` | public | Service status and configuration summary. | — |
| \`GET /api/live-status\` | public | Live status: public URL, run number, start time, and uptime. | — |
| \`POST /api/signup\` | public | Create an account, start a session. | \`INVALID_USERNAME\` 400, \`INVALID_PASSWORD\` 400, \`USERNAME_TAKEN\` 409 |
| \`POST /api/login\` | public | Sign in. | \`INVALID_CREDENTIALS\` 401, \`RATE_LIMITED\` 429 |
| \`POST /api/logout\` | session | End the session (a Bearer logout revokes that API token). | \`NOT_AUTHENTICATED\` 401 |
| \`GET /api/me\` | session | Current account profile. | \`NOT_AUTHENTICATED\` 401 |
| \`GET /api/tokens\` | session | List this account's API tokens. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/tokens\` | session | Mint a new \`sat_\` API token (shown once). | \`NOT_AUTHENTICATED\` 401 |
| \`DELETE /api/tokens/:id\` | session | Revoke an API token. | \`TOKEN_NOT_FOUND\` 404 |

Browser-only counterparts: \`GET /login\`, \`GET /signup\` (forms), \`POST /login\`, \`POST /signup\`, \`POST /logout\` (form posts with CSRF), plus pages \`GET /\`, \`GET /home\`, \`GET /explore\`, \`GET /dashboard\`, \`GET /app\`, \`GET /install\`, \`GET /assets/:name\`, \`GET /offline.html\`, \`GET /sw.js\`, \`GET /sw-register.js\`.

## Files and uploads API

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /api/files\` | session | List the account's files. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/files/upload\` | session | Simple one-shot upload (multipart). | \`FILE_TOO_LARGE\` 413, \`UNSUPPORTED_MEDIA_TYPE\` 415, \`EMPTY_FILE\` 400, \`TOO_MANY_FILES\` 400 |
| \`POST /api/uploads/init\` | session | Begin a chunked upload, returns a session id. | \`TOO_MANY_FILES\` 400, \`INVALID_CHUNK_SIZE\` 400 |
| \`POST /api/uploads/:sid/chunks/:index\` | session | Upload one chunk. | \`CHUNK_TOO_LARGE\` 413, \`INVALID_CHUNK_INDEX\` 400, \`CHUNK_HASH_REQUIRED\` 400, \`CHUNK_SIZE_MISMATCH\` 400 |
| \`GET /api/uploads/:sid\` | session | Chunk status, including any missing chunk numbers. | \`NOT_FOUND\` 404 |
| \`DELETE /api/uploads/:sid\` | session | Cancel a chunked upload. | \`UPLOAD_NOT_OPEN\` 409 |
| \`POST /api/uploads/:sid/complete\` | session | Finish a chunked upload. | \`CHUNKS_MISSING\` 400, \`CHUNK_CORRUPT\` 400, \`UPLOAD_COMPLETED\` 409 |
| \`POST /api/files/upload-from-url\` | session | Import a file from a remote URL. | \`IMPORT_INVALID_URL\` 400, \`IMPORT_BUSY\` 429 |
| \`GET /api/files/upload-from-url/:uid\` | session | Import progress/result. | \`IMPORT_DNS_FAILED\` 502, \`IMPORT_FAILED\` 502 |
| \`DELETE /api/files/upload-from-url/:uid\` | session | Cancel a running import. | \`IMPORT_NOT_CANCELLABLE\` 409, \`IMPORT_ALREADY_DONE\` 409 |
| \`GET /api/files/:id\` | session | File metadata. | \`FILE_MISSING\` 404 |
| \`PATCH /api/files/:id\` | session | Rename or edit metadata. | \`FILE_MISSING\` 404, \`INVALID_FILENAME\` 400 |
| \`DELETE /api/files/:id\` | session | Delete a file. | \`FILE_MISSING\` 404, \`FILE_BUSY\` 409 |
| \`GET /api/files/:id/download\` | session | Download the bytes. | \`FILE_MISSING\` 404 |
| \`GET /api/files/:id/preview\` | session | Inline preview stream. | \`PREVIEW_NOT_AVAILABLE\` 415 |
| \`PUT /api/files/:id/sharing\` | session | Turn sharing on/off, get the share token. | \`FILE_MISSING\` 404 |

## Sharing and upload links

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /s/:token\` | public | Shared file page. | \`FILE_MISSING\` 404 |
| \`GET /s/:token/download\` | public | Download a shared file. | \`FILE_MISSING\` 404 |
| \`GET /s/:token/preview\` | public | Preview a shared file. | \`PREVIEW_NOT_AVAILABLE\` 415 |
| \`GET /api/upload-links\` | session | List upload links. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/upload-links\` | session | Create an upload link (guests upload without an account). | \`TOO_MANY_LINKS\` 409 |
| \`DELETE /api/upload-links/:id\` | session | Revoke an upload link. | \`TOKEN_NOT_FOUND\` 404 |
| \`GET /u/:token\` | public | Upload-link landing page. | \`UPLOAD_LINK_CLOSED\` 404, \`UPLOAD_EXPIRED\` 410 |
| \`POST /u/:token/upload\` | public | Upload through an upload link (form post, CSRF-exempt). | \`LINK_FILE_LIMIT\` 507, \`LINK_SIZE_LIMIT\` 507, \`UPLOAD_LINK_CLOSED\` 404 |

## Pips DB API

A tiny per-account document store (lines of text, SHA-guarded writes).

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /api/db\` | session | List documents. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/db\` | session | Create a document. | \`TOO_MANY_DOCUMENTS\` 409, \`DB_TOO_LARGE\` 413 |
| \`GET /api/db/:id\` | session | Read a document (returns content + SHA). | \`NOT_FOUND\` 404 |
| \`PUT /api/db/:id\` | session | Write content against the SHA you read; stale SHA fails. | \`INVALID_LINE\` 400, \`NOT_FOUND\` 404, conflict 409 |
| \`DELETE /api/db/:id\` | session | Remove a document (trash keeps it restorable). | \`NOT_FOUND\` 404 |
| \`POST /api/db/:id/line\` | session | Edit, insert or delete one line. | \`INVALID_LINE\` 400, \`LINE_OUT_OF_RANGE\` 400 |
| \`POST /api/db/:id/move\` | session | Move a line. | \`LINE_OUT_OF_RANGE\` 400 |
| \`POST /api/db/:id/restore\` | session | Restore a deleted document. | \`NOT_FOUND\` 404 |

## Devices API

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`POST /api/devices\` | session | Heartbeat: register/refresh a device presence. | \`INVALID_DEVICE\` 400 |
| \`GET /api/devices\` | session | List the account's devices. | \`NOT_AUTHENTICATED\` 401 |
| \`DELETE /api/devices/:id\` | session | Remove a device. | \`DEVICE_NOT_FOUND\` 404 |

## Social API

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /api/social/users\` | session | User directory. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/social/follow\` | session | Follow a user. | \`SELF_FOLLOW\` 400, \`USER_NOT_FOUND\` 404 |
| \`POST /api/social/unfollow\` | session | Unfollow a user. | \`USER_NOT_FOUND\` 404 |
| \`GET /api/social/inbox\` | session | Follows and chat activity. | \`NOT_AUTHENTICATED\` 401 |
| \`GET /api/social/notifications\` | session | Notification list. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/social/notifications/read\` | session | Mark notifications read. | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/social/chat\` | session | Send a direct message. | \`SELF_MESSAGE\` 400, \`USER_NOT_FOUND\` 404, \`TEXT_TOO_LARGE\` 400 |
| \`POST /api/social/chat/like\` | session | Like a message. | \`MESSAGE_NOT_FOUND\` 404 |
| \`GET /api/social/chat/:user\` | session | Thread with a user. | \`USER_NOT_FOUND\` 404 |
| \`GET /api/social/avatar/:user\` | public | A user's avatar image. | \`USER_NOT_FOUND\` 404 |
| \`PUT /api/social/avatar\` | session | Set the account avatar. | \`INVALID_LABEL\` 400 |
| \`POST /api/social/report\` | session | Report a user or message. | \`INVALID_TEXT\` 400 |

## Tube API

Video publishing and viewing. Feed, channels and published videos are public; channel management is session-authenticated.

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /api/tube/feed\` | public | The video feed. | — |
| \`GET /api/tube/my-channel\` | session | Your channel. | \`NOT_AUTHENTICATED\` 401 |
| \`PUT /api/tube/my-channel\` | session | Update channel title/description/logo. | \`INVALID_TITLE\` 400, \`INVALID_LOGO\` 400 |
| \`DELETE /api/tube/my-channel\` | session | Delete the channel. | \`NOT_AUTHENTICATED\` 401 |
| \`GET /api/tube/channels/:user\` | public | A user's channel. | \`USER_NOT_FOUND\` 404 |
| \`GET /api/tube/videos/:fileId\` | public | Video metadata (if published or yours). | \`FILE_MISSING\` 404 |
| \`POST /api/tube/videos/:fileId/publish\` | session | Publish an uploaded video. | \`NOT_A_VIDEO\` 415, \`INVALID_DURATION\` 400 |
| \`POST /api/tube/videos/:fileId/unpublish\` | session | Unpublish. | \`FILE_MISSING\` 404 |
| \`PATCH /api/tube/videos/:fileId\` | session | Edit title/category/thumbnail. | \`INVALID_TITLE\` 400, \`INVALID_CATEGORY\` 400, \`INVALID_THUMBNAIL\` 400 |
| \`POST /api/tube/videos/:fileId/view\` | public | Record a view. | \`INVALID_DURATION\` 400 |
| \`GET /api/tube/videos/:fileId/views\` | session | Viewer list. | \`FILE_MISSING\` 404 |
| \`POST /api/tube/videos/:fileId/vote\` | session | Upvote/downvote. | \`INVALID_VOTE\` 400 |
| \`GET /api/tube/videos/:fileId/comments\` | public | Comment list. | \`FILE_MISSING\` 404 |
| \`POST /api/tube/videos/:fileId/comments\` | session | Add a comment. | \`INVALID_COMMENT\` 400 |
| \`POST /api/tube/videos/:fileId/comments/:cid/vote\` | session | Vote on a comment. | \`INVALID_VOTE\` 400 |
| \`POST /api/tube/channels/:user/subscribe\` | session | Subscribe/unsubscribe. | \`INVALID_SUBSCRIBE\` 400 |
| \`GET /api/tube/history\` | session | Watch history. | \`BAD_HISTORY\` 400 |

Browser pages: \`GET /tube\`, \`GET /tube/watch/:fileId\`, \`GET /tube/channel/:user\`.

## Model chat API

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /chat\` | session | Chat page. | — |
| \`GET /api/chat/status\` | session | Model availability and queue state. | \`NOT_CONFIGURED\` 503 |
| \`POST /api/chat\` | session | Start a chat generation job. | \`EMPTY_MESSAGE\` 400, \`PROMPT_TOO_LONG\` 400, \`AI_NOT_CONFIGURED\` 503 |
| \`GET /api/chat/jobs/:jobId\` | session | Poll a job's progress/result. | \`NOT_FOUND\` 404 |
| \`DELETE /api/chat/jobs/:jobId\` | session | Cancel a job. | \`GENERATION_CANCELLED\` 499, \`GENERATION_TIMEOUT\` 504 |
| \`GET /v1/models\` | Bearer sat_ | OpenAI-compatible model list. | \`INVALID_TOKEN\` 401 |
| \`POST /v1/chat/completions\` | Bearer sat_ | OpenAI-compatible chat completions. | \`BAD_MODEL\` 400, \`BAD_MESSAGES\` 400, \`BAD_MAX_TOKENS\` 400, \`MODEL_NOT_AVAILABLE\` 400, \`MODEL_BUSY\` 429, \`MODEL_UPSTREAM_ERROR\` 502 |

## Tunnel CLI API

The endpoints the \`tun\` client speaks. All are CSRF-exempt (CLI callers); all are documented in depth in the [tunnel guide](/docs/tunnel).

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`POST /api/tunnel/account\` | public | Create a tunnel account, returns a \`tunt_\` token. | \`RATE_LIMITED\` 429 |
| \`POST /api/tunnel/register\` | tunt_ optional | Connect a tunnel name; anonymous callers get a random name. | \`INVALID_NAME\` 400, \`NAME_RESERVED\` 403, \`TUNNEL_LIMIT\` 429 |
| \`GET /api/tunnel/poll\` | tunt_ | Long-poll for the next visitor request. | \`INVALID_TOKEN\` 401, \`TUNNEL_OFFLINE\` 404, \`TUNNEL_REPLACED\` 410 |
| \`POST /api/tunnel/respond\` | tunt_ | Post the local app's response back. | \`INVALID_BODY\` 400, \`TUNNEL_REPLACED\` 410 |
| \`POST /api/tunnel/close\` | tunt_ | Close a tunnel. | \`INVALID_TOKEN\` 401 |
| \`GET /api/tunnel/whoami\` | tunt_ | Account, reserved names, live tunnels. | \`INVALID_TOKEN\` 401 |
| \`GET /api/tunnel/stats\` | public | Server-wide tunnel counters and uptime. | — |
| \`GET /api/tunnel/logs?name=…\` | tunt_ | Per-name request log (traffic inspector data). | \`INVALID_NAME\` 400, \`INVALID_TOKEN\` 401 |
| \`POST /api/tunnel/protect\` | tunt_ | Password-protect a tunnel. | \`INVALID_TOKEN\` 401, \`INVALID_ACCESS_TOKEN\` 400 |
| \`POST /api/tunnel/unprotect\` | tunt_ | Remove protection. | \`INVALID_TOKEN\` 401 |

## Tunnel manager API

For signed-in site users (cookie or \`Bearer sat_…\`); page at \`GET /tunnel\`.

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /api/tunnel/tokens\` | session | List CLI tokens (masked). | \`NOT_AUTHENTICATED\` 401 |
| \`POST /api/tunnel/tokens\` | session | Create a \`tunt_\` CLI token. | \`NOT_AUTHENTICATED\` 401 |
| \`DELETE /api/tunnel/tokens/:id\` | session | Revoke a CLI token. | \`TUNNEL_TOKEN_NOT_FOUND\` 404 |
| \`POST /api/tunnel/claim\` | session | Reserve a stable tunnel name. | \`INVALID_NAME\` 400, \`NAME_TAKEN\` 409 |
| \`POST /api/tunnel/release\` | session | Release a reserved name. | \`NAME_NOT_FOUND\` 404, \`NAME_NOT_YOURS\` 403 |

## Public tunnel routes and docs

| Method and path | Auth | What it does | Typical errors |
| --- | --- | --- | --- |
| \`GET /tun\` | public | Tunnel landing page with live tunnels. | — |
| \`GET /tun/dashboard\` | public (token) | Traffic inspector; pass \`?token=…\` or POST the form. | 401 on a bad token |
| \`GET /api/tunnel/list\` | public | Live tunnel names snapshot (JSON). | — |
| \`ANY /tun/:name\` | public | Reverse proxy to the connected local app (any method and sub-path). | see visitor behavior below |
| \`GET /tunnel.sh\` | public | POSIX installer script. | — |
| \`GET /api/tunnel/client.tar.gz\` | public | Client bundle (gzip, ETag). | \`BUNDLE_MISSING\` 500 |
| \`GET /docs\` | public | This page. | — |
| \`GET /docs/tunnel\` | public | Tunnel guide (HTML). | — |
| \`GET /docs/tunnel.md\` | public | Tunnel guide (markdown). | — |
| \`GET /llms.txt\` | public | LLM index of docs and endpoints. | — |
| \`GET /llms-full.txt\` | public | The full guide as one markdown file. | — |

## Visitor-facing tunnel behavior

- Requests to \`/tun/<name>/...\` are forwarded to the client's localhost with the prefix stripped; any method works (\`OPTIONS\` included, so cross-origin preflights reach the local app).
- Request bodies are capped at **10 MB** (\`PAYLOAD_TOO_LARGE\` 413); responses at **25 MB**.
- If no client is connected visitors get \`TUNNEL_OFFLINE\` 404 — an HTML offline page for browsers, the JSON envelope otherwise. If the client dies mid-wait: \`TUNNEL_TIMEOUT\` 504. Queue overflow: \`TUNNEL_BUSY\` 503. Server-wide cap: \`TUNNEL_LIMIT\` 429.
- Password-protected tunnels answer \`ACCESS_REQUIRED\` 400 until the visitor appends \`?access=<token>\` or an \`x-tunnel-access\` header.
- WebSocket upgrades are not forwarded (\`WEBSOCKET_UNSUPPORTED\` 501).

## Error codes

Every error carries a stable \`code\` in \`{"success":false,"error":{"code":"…","message":"…"}}\`. The tunnel codes are shared with the [tunnel guide](/docs/tunnel); the rest come from the site API.

| Code | HTTP | Where | Meaning |
| --- | --- | --- | --- |
| INVALID_JSON | 400 | JSON endpoints | Body is not valid JSON. |
| INVALID_BODY | 400 | respond, misc | Required fields missing. |
| INVALID_USERNAME | 400 | signup | Username fails the format rules. |
| INVALID_PASSWORD | 400 | signup | Password too weak or short. |
| USERNAME_TAKEN | 409 | signup | Account exists. |
| INVALID_CREDENTIALS | 401 | login | Wrong username or password. |
| NOT_AUTHENTICATED | 401 | site API | No session or Bearer token. |
| CSRF_HEADER_REQUIRED | 403 | browser mutations | Missing \`X-Requested-With: fetch\` / cross-origin form. |
| TOKEN_NOT_FOUND | 404 | tokens, upload-links | No such API token or upload link. |
| NOT_FOUND | 404 | misc | No such resource. |
| USER_NOT_FOUND | 404 | social, tube | No such user. |
| FILE_MISSING | 404 | files | No such file (or not shared with you). |
| UPLOAD_LINK_CLOSED | 404 | upload links | Link revoked. |
| UPLOAD_EXPIRED | 410 | upload links | Link TTL elapsed. |
| EMPTY_FILE | 400 | upload | Zero-byte upload refused. |
| FILE_TOO_LARGE | 413 | upload | Over the per-file size cap. |
| UNSUPPORTED_MEDIA_TYPE | 415 | upload | File type not allowed. |
| FILE_CONTENT_MISMATCH | 415 | upload | Bytes do not match the declared type. |
| CHUNK_TOO_LARGE | 413 | chunked upload | Chunk over \`UPLOAD_CHUNK_BYTES\`. |
| CHUNKS_MISSING | 400 | chunked upload | Complete called before every chunk arrived. |
| CHUNK_CORRUPT | 400 | chunked upload | Hash mismatch on a stored chunk. |
| UPLOAD_COMPLETED | 409 | chunked upload | Session already completed. |
| UPLOAD_NOT_OPEN | 409 | chunked upload | Session cancelled or finished. |
| UPLOAD_ID_USED | 409 | chunked upload | Init reused a live session id. |
| TOO_MANY_FILES | 400 | upload | Per-account file-count cap. |
| FILE_LIMIT_REACHED | 507 | upload | Storage quota exhausted. |
| IMPORT_INVALID_URL | 400 | url import | Not a fetchable http(s) URL. |
| IMPORT_DNS_FAILED | 502 | url import | Host did not resolve. |
| IMPORT_BUSY | 429 | url import | Too many concurrent imports. |
| DB_TOO_LARGE | 413 | pips db | Document over the size cap. |
| TOO_MANY_DOCUMENTS | 409 | pips db | Per-account document cap. |
| LINE_OUT_OF_RANGE | 400 | pips db | Line number beyond the document. |
| DEVICE_NOT_FOUND | 404 | devices | No such device id. |
| SELF_FOLLOW | 400 | social | Cannot follow yourself. |
| SELF_MESSAGE | 400 | social | Cannot message yourself. |
| TEXT_TOO_LARGE | 400 | social chat | Message over the length cap. |
| MESSAGE_NOT_FOUND | 404 | social chat | Message gone. |
| RATE_LIMITED | 429 | login, misc | Too many requests — slow down. |
| STORE_FAILED | 500 | storage | Private data store write failed. |
| NOT_CONFIGURED | 503 | misc | Server deployment is missing settings. |
| AI_NOT_CONFIGURED | 503 | chat | No model backend on this deployment. |
| MODEL_BUSY | 429 | chat, completions | Model queue is full. |
| BAD_MODEL | 400 | completions | Unknown model id. |
| PROMPT_TOO_LONG | 400 | chat | Prompt over the token budget. |
| GENERATION_TIMEOUT | 504 | chat | Model did not answer in time. |
| GENERATION_CANCELLED | 499 | chat | Job cancelled by the caller. |
| UPSTREAM_TIMEOUT | 504 | url import, chat | Remote host timed out. |
| INVALID_NAME | 400 | tunnel | Missing or malformed name (1-32 chars: a-z 0-9 - _, letter/digit first). |
| INVALID_TOKEN | 401 | tunnel CLI | Unknown or invalid tunnel token. |
| PAYLOAD_TOO_LARGE | 413 | tunnel proxy | Visitor request body over the 10 MB cap. |
| NAME_RESERVED | 403 | register | The name is reserved by a different account. |
| NAME_TAKEN | 409 | claim | The name is already reserved by another token. |
| NAME_NOT_FOUND | 404 | release | No reserved name goes by that name. |
| NAME_NOT_YOURS | 403 | release | The name belongs to a different tunnel token. |
| TUNNEL_TOKEN_NOT_FOUND | 404 | manager | No such tunnel token for this site user. |
| TUNNEL_OFFLINE | 404 | proxy, poll | No client is connected. |
| TUNNEL_REPLACED | 410 | poll, respond | Another client took the name over. |
| TUNNEL_CLOSED | 410 | proxy | The tunnel closed mid-request. |
| TUNNEL_TIMEOUT | 504 | proxy | Client did not answer within \`TUNNEL_WAIT_MS\`. |
| TUNNEL_BUSY | 503 | proxy | More than \`TUNNEL_MAX_QUEUE\` requests queued. |
| TUNNEL_LIMIT | 429 | register, proxy | Server-wide \`TUNNEL_MAX_TUNNELS\` cap reached. |
| TUNNEL_UNAVAILABLE | 502 | proxy | Tunnel infrastructure error. |
| BUNDLE_MISSING | 500 | client.tar.gz | Client bundle unavailable on this deployment. |

## Limits and environment knobs

| Knob | Default | Meaning |
| --- | --- | --- |
| \`TUNNEL_WAIT_MS\` | 30000 | Client answer deadline before \`TUNNEL_TIMEOUT\` 504. |
| \`TUNNEL_POLL_WAIT_MS\` | 20000 | Long-poll hold time. |
| \`TUNNEL_TTL_MS\` | 90000 | Client heartbeat TTL before a tunnel is declared dead. |
| \`TUNNEL_MAX_TUNNELS\` | 200 | Server-wide tunnel cap. |
| \`TUNNEL_MAX_QUEUE\` | 64 | Per-tunnel queued-request cap. |
| \`TUNNEL_SAVE_MS\` | 5000 | Persistence debounce for tunnel state. |
| \`TUNNEL_REGISTER_RATE\` | 240 | Tunnel registrations per minute. |
| \`UPLOAD_CHUNK_BYTES\` | 8 MB max | Chunked-upload chunk size. |
| — | 10 MB | Tunnel proxy request-body cap. |
| — | 25 MB | Tunnel respond-body cap. |

Deeper tunnel documentation — install, quickstart, the CLI, the wire protocol, persistence and troubleshooting — lives in the [full tunnel guide](/docs/tunnel), also available as [markdown](/docs/tunnel.md), [llms.txt](/llms.txt) and [llms-full.txt](/llms-full.txt).
`;

function appDocsHtml({ base = '' } = {}) {
  const b = String(base || '').replace(/\/+$/, '');
  const body = renderMarkdown(MD.replace('{{BASE}}', b || 'this server'));
  const toc = SECTIONS.map((t) => `<a href="#${slugify(t)}">${t}</a>`).join('');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    <title>Pips API Docs</title>
    <style>
      * { box-sizing: border-box; }
      body.tun { margin: 0; font-family: system-ui, sans-serif; color: #e6edf3; background: #0b1020; overflow-x: hidden; }
      body.tun a { color: #7ee2ff; }
      .glow { position: fixed; width: 46rem; height: 46rem; border-radius: 50%; filter: blur(90px); opacity: .16; pointer-events: none; z-index: 0; }
      .g1 { background: #7a5cff; top: -18rem; left: -14rem; }
      .g2 { background: #4f8cff; bottom: -20rem; right: -16rem; }
      main.docs { position: relative; z-index: 1; max-width: 860px; margin: 0 auto; padding: 2rem 1.2rem 3rem; }
      .docs-head { background: linear-gradient(160deg, #16132e 0%, #101522 70%); border: 1px solid #2a2d52; border-radius: 20px; padding: 1.7rem 1.4rem 1.5rem; text-align: center; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
      .docs-head h1 { margin: 0; font-size: 1.7rem; letter-spacing: -.02em; color: #fff; }
      .docs-head .tagline { margin: .4rem 0 0; color: #9aa8c0; font-size: .95rem; line-height: 1.5; }
      .toc { background: #101522; border: 1px solid #2a2d52; border-radius: 16px; padding: 1rem 1.2rem; margin: 1.4rem 0; }
      .toc h2 { margin: 0 0 .5rem; font-size: 1rem; color: #fff; }
      .toc nav { display: flex; flex-wrap: wrap; gap: .35rem .9rem; font-size: .85rem; }
      article h2 { color: #fff; font-size: 1.25rem; margin: 2.2rem 0 .8rem; padding-bottom: .35rem; border-bottom: 1px solid #2a2d52; }
      article p, article li { line-height: 1.6; color: #c4cfdf; }
      article code { background: #101522; border: 1px solid #2a2d52; border-radius: 6px; padding: .05rem .3rem; font-size: .85em; color: #9fe8ff; }
      article pre { background: #101522; border: 1px solid #2a2d52; border-radius: 12px; padding: .9rem 1rem; overflow-x: auto; }
      article pre code { border: 0; background: none; color: #b7f0c6; padding: 0; }
      table { width: 100%; border-collapse: collapse; margin: 1rem 0 1.4rem; font-size: .86rem; }
      th { text-align: left; color: #fff; background: #16132e; }
      th, td { border: 1px solid #2a2d52; padding: .45rem .55rem; vertical-align: top; }
      td { color: #c4cfdf; }
      .tun-foot { display: flex; flex-wrap: wrap; gap: .6rem 1.4rem; justify-content: center; margin-top: 2.4rem; padding-top: 1.2rem; border-top: 1px solid #2a2d52; font-size: .9rem; }
    </style>
  </head>
  <body class="tun">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="docs">
      <header class="docs-head">
        <h1>Pips API Docs</h1>
        <p class="tagline">The complete HTTP API reference for this app — every endpoint, both auth schemes, the error-code table and the server limits, in one page.</p>
      </header>
      <section class="toc">
        <h2>Contents</h2>
        <nav>${toc}</nav>
      </section>
      <article>
${body}
      </article>
      <footer class="tun-foot">
        <a href="/docs/tunnel">Tunnel full guide</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="/llms-full.txt">llms-full.txt</a>
        <a href="/tunnel.sh">tunnel.sh installer</a>
        <a href="/tun">Pips Tunnel home</a>
        <a href="/api/health">Service status</a>
      </footer>
    </main>
  </body>
</html>
`;
}

module.exports = { appDocsHtml };
