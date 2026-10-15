'use strict';

// Single source of truth for the Pips Tunnel documentation. Everything the
// site serves — the HTML guide page (/docs/tunnel), the plain markdown version
// (/docs/tunnel.md), llms.txt and llms-full.txt — is rendered from GUIDE with
// the tiny dependency-free renderer below, so the docs cannot drift from each
// other. The content mirrors the code exactly: tunnel-client/tun.js (CLI),
// src/server.js (routes, error codes, env knobs), src/tunnel.js (limits),
// src/tunnel-store.js (persistence) and src/tunnel-install.js (installer).

const SERVER = 'https://precision-pledge-fled.ngrok-free.dev';

// ---- The guide ------------------------------------------------------------

const GUIDE = [
  {
    id: 'what-is-pips-tunnel',
    title: 'What is Pips Tunnel?',
    md: `Pips Tunnel publishes an app that runs on your own machine — a dev server, a local API, anything that speaks HTTP — under a public URL on the Pips server: **${SERVER}/tun/<name>**.

It is a long-poll gateway, not an open port. A small client (\`tun\`) runs next to your app, registers a tunnel name, and holds a long-poll open to the server. Every visitor request to \`/tun/<name>\` is queued for that client, forwarded to \`http://localhost:<port>\`, and the response travels back to the visitor. No inbound ports, no firewall changes, no SSH.

Highlights:

- One command to publish; traffic flows only while the client is running.
- Anonymous tunnels get a friendly random name (like \`swift-otter-3f2a\`); reserved names stay stable across restarts.
- Browsers get friendly error pages — the offline page retries itself every 10 seconds — while API clients get plain JSON.
- Traffic counters and recent request logs per name, inspectable at \`/tun/dashboard\`.
- Zero dependencies. The client needs Node 18+ (it uses the global \`fetch\`).`,
  },
  {
    id: 'install',
    title: 'Install',
    md: `The client is a single Node script shipped with a launcher. Requirements: Node 18+ (it checks \`node --version\`) and \`curl\` or \`wget\` for the download. It never asks for root and writes nothing outside \`$HOME\`.

### One-line install

\`\`\`sh
curl -fsSL ${SERVER}/tunnel.sh | sh
\`\`\`

The installer is pinned to the host it was fetched from. It checks for Node 18+, downloads the client bundle from the same server, unpacks it into \`$TUNNEL_HOME\` (default \`~/.pips-tunnel\`), makes \`tun\` executable, and symlinks it into \`~/.local/bin\` when that directory is on your PATH. To install against another server:

\`\`\`sh
TUN_SERVER=https://other-host.example sh tunnel.sh
\`\`\`

### Manual install

Download and unpack the tarball yourself:

\`\`\`sh
curl -fsSL -o tunnel.tar.gz ${SERVER}/api/tunnel/client.tar.gz
tar -xzf tunnel.tar.gz && cd tunnel
chmod +x tun          # first time only
./tun start 5000
\`\`\`

Windows: run \`node tun.js start 5000\` instead of \`./tun\`.`,
  },
  {
    id: 'quick-start',
    title: 'Quick start',
    md: `### Anonymous (random name)

Run the client with your app's local port. The server assigns a random name and prints the public URL:

\`\`\`sh
./tun start 5000
\`\`\`

\`\`\`text
  tunnel   ${SERVER}/tun/swift-otter-3f2a
  local    http://localhost:5000
  ready    press Ctrl+C to stop
\`\`\`

Open the printed URL — it now serves whatever \`localhost:5000\` serves. The \`/tun/<name>\` prefix is stripped before your app sees the request, so local routes keep working unchanged. Stop with Ctrl+C.

### Reserved (stable name)

Anonymous tunnels get a fresh random name on every run. To keep a name across restarts, create a token, log in once, then name the tunnel:

\`\`\`sh
curl -X POST ${SERVER}/api/tunnel/account
# → {"success":true,"data":{ "token":"tunt_…", … }}   (shown once — save it)

./tun login tunt_…
./tun start 5000 myname
# → ${SERVER}/tun/myname  (reserved)
\`\`\`

Argument order does not matter: \`./tun start myname 5000\` is the same command.`,
  },
  {
    id: 'tokens-and-accounts',
    title: 'Tokens and accounts',
    md: `A tunnel token (prefix \`tunt_\`) ties named tunnels to an account. Tokens are stored only as a SHA-256 hash plus a mask (\`tunt_1234567890…abcd\`); the full token exists in exactly one response — the one that creates it.

### Create a token from the CLI

\`\`\`sh
curl -X POST ${SERVER}/api/tunnel/account \\
  -H 'Content-Type: application/json' \\
  -d '{"label":"laptop"}'
\`\`\`

The 201 response carries the full token exactly once:

\`\`\`json
{"success":true,"data":{"accountId":"5f…c3","token":"tunt_<40 hex chars>","label":"laptop","tokenMask":"tunt_1234567890…abcd"}}
\`\`\`

### Create tokens in the site UI

Signed-in site users can create, list and revoke any number of tokens on the [tunnel manager](/tunnel) page. A new token is shown in a one-time banner — copy it immediately, it cannot be retrieved later. Revoking a token also releases every tunnel name it had reserved.

### Where the CLI keeps the token

\`tun login <token>\` validates the token against \`/api/tunnel/whoami\` first, then stores it at \`$TUNNEL_HOME/token\` (default \`~/.pips-tunnel/token\`, written with mode 0600). The \`TUN_TOKEN\` environment variable overrides the stored token for a single run.`,
  },
  {
    id: 'tunnel-names',
    title: 'Tunnel names',
    md: `A tunnel name is 1-32 characters: \`a-z\`, \`0-9\`, \`-\` or \`_\`, starting with a letter or digit. Anonymous tunnels get friendly random names shaped like \`swift-otter-3f2a\`.

- **Random name (anonymous):** every \`./tun start <port>\` without a token picks a fresh random name. A name requested by an anonymous caller is ignored — the server always assigns one.
- **Reserved name (with token):** the first \`./tun start 5000 myname\` after \`tun login\` attaches \`myname\` to your account. You can also reserve a name in advance on the [tunnel manager](/tunnel) page, then start the client whenever you like.
- A reserved name refuses other callers at register time with **NAME_RESERVED** (403). Trying to claim it in the UI while another account holds it fails with **NAME_TAKEN** (409).
- Releasing a name (the Release button) or revoking its token frees the name for anyone to claim. The traffic record survives, so counters and logs are not lost.`,
  },
  {
    id: 'cli-reference',
    title: 'CLI reference',
    md: `\`tun\` ships as the launcher script plus \`tun.js\`; run it as \`./tun\` (\`node tun.js\` on Windows).

| Command | What it does |
| --- | --- |
| \`tun start <port> <app-name>\` | Publish \`http://localhost:<port>\` at \`/tun/<app-name>\` (name first also works: \`tun start test 5000\`; omit the name and the server assigns one) |
| \`tun login <token>\` | Remember a \`tunt_…\` token so named tunnels stay reserved for your account |
| \`tun list\` | Show tunnels connected to the server |
| \`tun close <app-name>\` | Close a tunnel from here |
| \`tun --server <url> ...\` | Use another server (default: \`$TUN_SERVER\`) |
| \`tun --help\` (\`-h\`) | Show the usage text |
| \`tun --version\` (\`-v\`) | Print \`tun 1.0.0\` |

\`tun list\` sample output:

\`\`\`text
  name            pending  served  answered  age
  myapp           0        12      12        45s
\`\`\`

While a tunnel runs, the client logs one line per request — method, path, upstream status, duration and response size:

\`\`\`text
  GET / → 200  12 ms  1234 B
\`\`\`

Environment variables: \`TUN_SERVER\` (target server), \`TUN_TOKEN\` (tunnel token for one run), \`TUNNEL_HOME\` (state directory, default \`~/.pips-tunnel\`).`,
  },
  {
    id: 'site-ui-guide',
    title: 'Site UI guide',
    md: `Three pages, all in the same dark tunnel theme:

- **/tun — landing.** The installer one-liner, the three-step quickstart, the client download button, and the list of currently connected tunnels with pending/answered counters.
- **/tunnel — manager (site login required).** Create tunnel tokens with an optional label (one-time display), revoke them, reserve stable names per token, and release names again. Names show LIVE/OFFLINE badges plus served/bytes counters.
- **/tun/dashboard — inspector.** Paste a \`tunt_…\` token to log in (\`GET /tun/dashboard?token=…\` or the POST form). Shows every name the token owns with live/offline state, traffic counters, and the most recent proxied requests — up to 50 rows per name with method, path, status, duration and size. A wrong token returns 401 with the login form again.`,
  },
  {
    id: 'error-pages-for-visitors',
    title: 'Error pages for visitors',
    md: `When a tunnel cannot serve a request, browsers (requests whose \`Accept\` header includes \`text/html\`) get a styled explanation page. Every other client — curl, scripts, monitors — gets the JSON error envelope with the same status code.

| Page | Status | When |
| --- | --- | --- |
| Tunnel offline | 404 | No client is connected to \`/tun/<name>\`. The page reloads itself every 10 seconds, so a client that connects a moment later picks the visitor up without a manual refresh. |
| Local app not answering | 502 | The tunnel is connected, but \`http://localhost\` on the other side refused the connection or timed out. |
| Tunnel did not answer in time | 504 | The local app accepted the request but did not answer within \`TUNNEL_WAIT_MS\`. |
| Tunnel is busy | 503 | Too many requests are queued for that tunnel (\`TUNNEL_MAX_QUEUE\`); the queue drains as the local app answers. |

The 429 \`TUNNEL_LIMIT\` case renders the busy page as well. Raw clients receive \`{"success":false,"error":{"code":"…","message":"…"}}\` instead. When the local app itself answers 502, that answer passes through untouched — only the tunnel's own \`x-tunnel-error: local-unreachable\` marker is turned into the "Local app not answering" page for browsers.`,
  },
  {
    id: 'http-api-reference',
    title: 'HTTP API reference',
    md: `All JSON endpoints answer with the envelope \`{"success":true,"data":…}\`; errors use \`{"success":false,"error":{"code":"…","message":"…"}}\` with a matching HTTP status. Examples use \`${SERVER}\` — the same routes work on whatever host serves them.

### POST /api/tunnel/register

Connect a tunnel. Auth optional: \`Authorization: Bearer tunt_…\` enables reserved names; anonymous callers always get a random name.

\`\`\`sh
curl -X POST ${SERVER}/api/tunnel/register \\
  -H 'Content-Type: application/json' \\
  -H 'Authorization: Bearer tunt_…' \\
  -d '{"name":"myname"}'
\`\`\`

\`\`\`json
{"success":true,"data":{"name":"myname","clientId":"9b1c…","reserved":true,"account":"tunt_1234567890…abcd"}}
\`\`\`

Anonymous register: omit the token (and the name) — \`name\` comes back random, \`reserved\` is \`false\`, \`account\` is \`null\`. Errors: INVALID_NAME 400, NAME_RESERVED 403, INVALID_TOKEN 401, TUNNEL_LIMIT 429.

### GET /api/tunnel/poll?name=&client=

The client's long-poll. Blocks up to \`TUNNEL_POLL_WAIT_MS\`, then returns \`{"request":null}\`; a queued visitor request returns \`{"request":{"id":"…","method":"GET","path":"/a?b=1","headers":{…},"body":"<base64>"}}\`. Errors: INVALID_NAME 400, TUNNEL_OFFLINE 410 (re-register), TUNNEL_REPLACED 410 (another client took the name — exit).

### POST /api/tunnel/respond

Answer one forwarded request.

\`\`\`sh
curl -X POST ${SERVER}/api/tunnel/respond \\
  -H 'Content-Type: application/json' \\
  -d '{"name":"myname","client":"<clientId>","id":"<request id>","status":200,"headers":{"content-type":"text/html"},"body":"PGgxPmhpPC9oMT4="}'
\`\`\`

\`body\` is base64. The response body is capped at 25 MB. Returns \`{"delivered":true}\` (\`false\` if the visitor already timed out). Errors: INVALID_BODY 400, TUNNEL_REPLACED 410.

### POST /api/tunnel/close

Close a tunnel by name: \`{"name":"myname"}\` → \`{"closed":true}\` (\`false\` when nothing by that name is connected). The CLI sends this on Ctrl+C.

### GET /api/tunnel/list

Every connected tunnel, no auth: \`{"tunnels":[{"name":"myapp","pending":0,"served":12,"answered":12,"ageMs":45000,"reserved":true}]}\`, sorted by name.

### GET /api/tunnel/stats

Server-wide totals, no auth: \`{"tunnels":3,"pending":0,"served":42,"answered":41,"accounts":2,"names":2,"uptimeMs":987654}\`.

### POST /api/tunnel/account

Create a tunnel account (no auth): \`{"label":"laptop"}\` → 201 \`{"accountId":"…","token":"tunt_…","label":"laptop","tokenMask":"tunt_…"}\`. The token is shown once.

### GET /api/tunnel/whoami

Validate a token: \`Authorization: Bearer tunt_…\` → \`{"account":{"id":"…","label":"…","tokenMask":"…","createdAt":…},"names":[{"name":"myname",…}]}\`. Errors: INVALID_TOKEN 401.

### GET /api/tunnel/tokens

List the signed-in site user's tunnel tokens: \`{"tokens":[{"id":"…","label":"laptop","tokenMask":"tunt_…","createdAt":…,"names":1}]}\`. Masks only — the full token was shown once at creation.

### POST /api/tunnel/tokens

Create a tunnel token for the signed-in site user: \`{"label":"ci"}\` → 201 \`{"id":"…","token":"tunt_…","tokenMask":"tunt_…","label":"ci"}\`. Full token in this one response only.

### DELETE /api/tunnel/tokens/:id

Revoke one of the user's tokens: \`{"revoked":true,"released":["myname"]}\` — every name the token held is released.

### POST /api/tunnel/claim

Reserve a stable name for one of the user's tokens: \`{"name":"myname","accountId":"…"}\` → 201 \`{"name":"myname","accountId":"…","reserved":true}\`. Errors: INVALID_NAME 400, TUNNEL_TOKEN_NOT_FOUND 404, NAME_TAKEN 409.

### POST /api/tunnel/release

Release a reserved name: \`{"name":"myname"}\` → \`{"released":true,"name":"myname"}\`. Errors: NAME_NOT_FOUND 404, NAME_NOT_YOURS 403.

The five manager endpoints above need a signed-in site session (or a \`Bearer sat_\` API token). Mutating requests must send the \`X-Requested-With: fetch\` header — the site's own pages do this automatically — and are same-origin checked.

### GET /tun/dashboard

The traffic inspector (HTML). \`GET /tun/dashboard?token=tunt_…\` or POST the login form field \`token\`. Renders the account's names with LIVE/OFFLINE badges, counters and the latest request logs; a wrong token returns 401 with the login form.

### GET /tun/<name> — the proxy

Any method, any sub-path: \`/tun/<name>/<rest>?query\` is queued for the connected client and answered by its localhost app. The \`/tun/<name>\` prefix is stripped and the query string is kept. Visitor request bodies are capped at 10 MB (PAYLOAD_TOO_LARGE 413). Tunnel-side failures (offline, busy, slow, limit) become HTML error pages for browsers and JSON for everyone else.

### Assets

- \`GET /api/tunnel/client.tar.gz\` — the client bundle as \`tunnel.tar.gz\` (\`application/gzip\`, ETag with 304 support; BUNDLE_MISSING 500 if unavailable).
- \`GET /tunnel.sh\` — the POSIX installer script (\`text/x-shellscript\`), pinned to the host the request reached.`,
  },
  {
    id: 'error-codes',
    title: 'Error codes',
    md: `Every error carries a stable \`code\` in \`{"success":false,"error":{"code":"…"}}\`.

| Code | HTTP | Where | Meaning |
| --- | --- | --- | --- |
| INVALID_NAME | 400 | register, poll, claim | Missing or malformed name (1-32 chars: a-z 0-9 - _, letter/digit first). |
| INVALID_TOKEN | 401 | register, whoami | Unknown or invalid tunnel token. |
| INVALID_BODY | 400 | respond | Missing \`name\` or \`id\` in the respond payload. |
| PAYLOAD_TOO_LARGE | 413 | proxy | Visitor request body over the 10 MB cap. |
| NAME_RESERVED | 403 | register | The name is reserved by a different account. |
| NAME_TAKEN | 409 | claim | The name is already reserved by another token. |
| NAME_NOT_FOUND | 404 | release | No reserved name goes by that name. |
| NAME_NOT_YOURS | 403 | release | The name belongs to a different tunnel token. |
| TUNNEL_TOKEN_NOT_FOUND | 404 | manager endpoints | No such tunnel token for this site user. |
| TUNNEL_OFFLINE | 404 | proxy, poll | No client is connected (server restarted?). Clients re-register. |
| TUNNEL_REPLACED | 410 | poll, respond | Another client took the name over; this client should exit. |
| TUNNEL_CLOSED | 410 | proxy (in-flight) | The tunnel closed while a request was still waiting. |
| TUNNEL_TIMEOUT | 504 | proxy | The client did not answer within \`TUNNEL_WAIT_MS\`. |
| TUNNEL_BUSY | 503 | proxy | More than \`TUNNEL_MAX_QUEUE\` requests queued for this tunnel. |
| TUNNEL_LIMIT | 429 | register, proxy | Server-wide tunnel cap (\`TUNNEL_MAX_TUNNELS\`) reached. |
| BUNDLE_MISSING | 500 | client.tar.gz | The client bundle is not available on this deployment. |`,
  },
  {
    id: 'limits-and-environment-knobs',
    title: 'Limits and environment knobs',
    md: `Server-side knobs (environment variables, all optional):

| Knob | Default | Meaning |
| --- | --- | --- |
| \`TUNNEL_WAIT_MS\` | 30000 | How long \`/tun/<name>\` waits for the client's response before TUNNEL_TIMEOUT (504). |
| \`TUNNEL_POLL_WAIT_MS\` | 20000 | How long a client long-poll blocks before answering "no request yet". |
| \`TUNNEL_TTL_MS\` | 90000 | A tunnel is dropped after this long without any client activity. |
| \`TUNNEL_MAX_TUNNELS\` | 200 | Connected tunnels at once; over that register fails with TUNNEL_LIMIT (429). |
| \`TUNNEL_MAX_QUEUE\` | 64 | Queued requests per tunnel; over that visitors get TUNNEL_BUSY (503). |
| \`TUNNEL_SAVE_MS\` | 5000 | Debounce for persisting \`system/tunnel.json\`. |

Fixed limits:

- **10 MB** — visitor → client request body cap (PAYLOAD_TOO_LARGE 413).
- **25 MB** — client → server respond body cap (base64).
- **16 KB** — generic JSON API body cap (everything except the proxy and respond endpoints).
- **50 rows** — recent request log kept per tunnel name.
- **1-32 chars** — tunnel name length; tokens are \`tunt_\` + 40 hex characters.`,
  },
  {
    id: 'how-it-works',
    title: 'How it works',
    md: `1. **Register.** The client POSTs \`/api/tunnel/register\` (optionally with its token) and receives a name and a \`clientId\`. Registering a name that already has a client is a takeover: the new client wins immediately, and the old one is answered with TUNNEL_REPLACED (410) on its next poll and exits.
2. **Long-poll.** The client repeatedly GETs \`/api/tunnel/poll\`. The server holds each poll up to \`TUNNEL_POLL_WAIT_MS\`; a queued visitor request is returned immediately as JSON with a base64 body. On network errors the client retries with a 500 ms backoff capped at 5 s.
3. **Forward.** Every request that arrives at \`/tun/<name>/…\` is queued for that tunnel. Hop-by-hop and framing headers (\`host\`, \`connection\`, \`keep-alive\`, \`transfer-encoding\`, \`upgrade\`, \`te\`, \`trailer\`, \`proxy-*\`, \`content-length\`, \`accept-encoding\`, \`content-encoding\`) are stripped in both directions — the two HTTP legs re-derive them themselves. \`HEAD\` is served as \`GET\`.
4. **Respond.** The client calls its localhost app and POSTs status, headers and base64 body back to \`/api/tunnel/respond\`. The server hands the response to the waiting visitor (status clamped to 100-599) and restores multi-value \`Set-Cookie\` headers that would otherwise be collapsed.
5. **Sweep.** Tunnels with no client activity for \`TUNNEL_TTL_MS\` are dropped, and queued requests nobody picked up expire. A client that sees TUNNEL_OFFLINE re-registers on its own.

WebSocket proxying is not supported — the \`upgrade\` header is stripped, so the tunnel carries plain HTTP only.`,
  },
  {
    id: 'persistence',
    title: 'Persistence',
    md: `Accounts, reserved names and traffic live in one JSON document at \`system/tunnel.json\`, written through the same storage abstraction as the rest of the app — SHA compare-and-swap updates with a bounded ConflictError retry — debounced by \`TUNNEL_SAVE_MS\` (default 5 s). Without configured storage everything runs in memory.

What survives a restart:

- Tunnel accounts: the SHA-256 hash and mask of each \`tunt_\` token — never the token itself.
- Reserved names and which account holds them (claims are reloaded from the store on the first register/proxy).
- Traffic counters per name (served, bytes, last seen) and the 50 most recent request log rows.

What does not survive: live connections. After a restart the server answers TUNNEL_OFFLINE and every running client re-registers automatically — random names get a fresh random one, reserved names keep theirs.`,
  },
  {
    id: 'troubleshooting-and-faq',
    title: 'Troubleshooting and FAQ',
    md: `- **404 Tunnel offline right after a server restart** — expected: live connections are not persisted. Your running client re-registers within seconds; if it exited, start it again.
- **"Local app not answering" (502)** — the tunnel is fine; the local app on the published port is down or refused the connection. Start it and retry.
- **"this tunnel was taken over by another client"** — a second client registered the same reserved name (another terminal, a teammate). The newest client wins; stop the duplicate if this was not intentional.
- **NAME_RESERVED when starting a named tunnel** — the name is claimed by a token you have not logged in with. Run \`tun login <token>\` with the owning token.
- **Sharing a dev server with a teammate** — reserve a name and hand out the \`/tun/<name>\` URL. Teammates cannot take the name (NAME_RESERVED) and see the self-retrying offline page while your client is down.
- **Running behind another CDN or host** — pass \`--server https://your-host\` (or set \`TUN_SERVER\`) so the client talks to that host; the installer and the /tun quickstart always pin themselves to whatever host actually reached the server.
- **413 PAYLOAD_TOO_LARGE on uploads** — visitor request bodies are capped at 10 MB; the respond leg allows 25 MB.
- **A ngrok browser-warning interstitial** — the client already sends \`ngrok-skip-browser-warning: 1\` on its own API calls.

### FAQ

- **Do I need to open ports or configure DNS?** No. The client makes outbound HTTPS long-polls only.
- **What happens on Ctrl+C?** The client POSTs \`/api/tunnel/close\`; visitors get the offline page, which retries every 10 seconds.
- **Can I run several tunnels at once?** Yes — one \`tun start\` per app/port, each with its own name (random or reserved).
- **Where do I see live traffic?** \`/tun/dashboard\` with your \`tunt_\` token: per-name counters and the latest requests with method, path, status, duration and size.`,
  },
];

// ---- Markdown renderer (minimal, dependency-free) --------------------------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function slugify(text) {
  const slug = String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
  return slug || 'section';
}

// Inline markdown (code, bold, links) on top of already-escaped text.
function inlineSpans(text) {
  let out = text.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, label, url) => `<a href="${url}">${label}</a>`);
  return out;
}

// Renders exactly the subset the guide uses: #/##/### headings (slug ids,
// deduped), ``` fenced code blocks, inline `code` / **bold** / [text](url),
// - unordered lists, 1. ordered lists, pipe tables, --- rules and paragraphs.
// All text nodes are HTML-escaped before inline transforms run.
function renderMarkdown(md, { headingIds = true } = {}) {
  const lines = String(md).split('\n');
  const out = [];
  const usedIds = new Set();
  const headingId = (title) => {
    const base = slugify(title);
    let id = base;
    for (let n = 2; usedIds.has(id); n++) id = `${base}-${n}`;
    usedIds.add(id);
    return id;
  };
  const spans = (s) => inlineSpans(escapeHtml(s));
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = line.match(/^```(\w*)\s*$/);
    if (fence) {
      const buf = [];
      i++;
      while (i < lines.length && !/^```\s*$/.test(lines[i])) buf.push(lines[i++]);
      i++; // past the closing fence
      const lang = fence[1] ? ` class="language-${fence[1]}"` : '';
      out.push(`<pre><code${lang}>${escapeHtml(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^-{3,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    const heading = line.match(/^(#{1,3})\s+(.*)$/);
    if (heading) {
      const level = heading[1].length;
      const title = heading[2].trim();
      const id = headingIds ? ` id="${headingId(title)}"` : '';
      out.push(`<h${level}${id}>${spans(title)}</h${level}>`);
      i++;
      continue;
    }
    const isRow = (l) => /^\|.*\|\s*$/.test(l);
    if (isRow(line) && i + 1 < lines.length && /^\|[\s:|-]+\|\s*$/.test(lines[i + 1])) {
      const cells = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isRow(lines[i])) rows.push(cells(lines[i++]));
      const th = head.map((c) => `<th>${spans(c)}</th>`).join('');
      const body = rows.map((r) => `<tr>${r.map((c) => `<td>${spans(c)}</td>`).join('')}</tr>`).join('');
      out.push(`<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`);
      continue;
    }
    if (/^[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i])) items.push(lines[i++].replace(/^[-*]\s+/, ''));
      out.push(`<ul>${items.map((it) => `<li>${spans(it)}</li>`).join('')}</ul>`);
      continue;
    }
    if (/^\d+[.)]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\d+[.)]\s+/, ''));
      out.push(`<ol>${items.map((it) => `<li>${spans(it)}</li>`).join('')}</ol>`);
      continue;
    }
    const para = [line];
    i++;
    while (
      i < lines.length &&
      !/^\s*$/.test(lines[i]) &&
      !/^(#{1,3}\s|```|[-*]\s|\d+[.)]\s|\||-{3,}\s*$)/.test(lines[i])
    ) {
      para.push(lines[i++]);
    }
    out.push(`<p>${spans(para.join(' '))}</p>`);
  }
  return out.join('\n');
}

// ---- Composed documents -----------------------------------------------------

// The whole guide as one markdown document: # title, then '## <section>' per entry.
function guideMarkdown() {
  return [
    '# Pips Tunnel — Full guide',
    '',
    'Pips Tunnel publishes a localhost app on the Pips server\'s public URL at `/tun/<name>`. This guide covers install, the CLI, the HTTP API, error codes, limits, persistence and troubleshooting.',
    '',
    GUIDE.map((s) => `## ${s.title}\n\n${s.md}`).join('\n\n'),
    '',
  ].join('\n');
}

const DOCS_CSS = `
      * { box-sizing: border-box; }
      body.tun { margin: 0; font-family: system-ui, sans-serif; color: #e6edf3; background: #0b1020; overflow-x: hidden; }
      body.tun a { color: #7ee2ff; }
      .tun .glow { position: fixed; width: 46rem; height: 46rem; border-radius: 50%; filter: blur(90px); opacity: .16; pointer-events: none; z-index: 0; }
      .tun .g1 { background: #7a5cff; top: -18rem; left: -14rem; }
      .tun .g2 { background: #4f8cff; bottom: -20rem; right: -16rem; }
      .docs { position: relative; z-index: 1; max-width: 860px; margin: 0 auto; padding: 1.8rem 1rem 2.6rem; }
      .docs-head { background: linear-gradient(160deg, #16132e 0%, #101522 70%); border: 1px solid #2a2d52; border-radius: 20px; padding: 1.7rem 1.4rem 1.5rem; text-align: center; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
      .docs-head h1 { margin: 0; font-size: 1.7rem; letter-spacing: -.02em; color: #fff; }
      .docs-head .tagline { margin: .4rem 0 0; color: #9aa8c0; font-size: .95rem; line-height: 1.5; }
      .docs-btns { display: flex; gap: .7rem; justify-content: center; flex-wrap: wrap; margin-top: 1.2rem; }
      .docs-btn { display: inline-block; padding: .7rem 1.2rem; border-radius: 12px; background: linear-gradient(135deg, #7a5cff, #4f8cff); color: #fff; font-weight: 800; text-decoration: none; font-size: .95rem; box-shadow: 0 10px 26px rgba(79,90,255,.35); }
      .docs-btn.ghost { background: #1c2740; border: 1px solid #33406b; color: #c6d0e2; box-shadow: none; }
      .toc { background: #12182a; border: 1px solid #232c44; border-radius: 16px; padding: 1rem 1.25rem 1.1rem; margin: 1rem 0; }
      .toc h2 { margin: 0 0 .6rem; font-size: 1rem; color: #fff; }
      .toc nav { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: .25rem .9rem; }
      .toc a { color: #7ee2ff; text-decoration: none; font-size: .88rem; line-height: 1.7; }
      .toc a:hover { text-decoration: underline; }
      .doc-sec { background: #12182a; border: 1px solid #232c44; border-radius: 16px; padding: 1.2rem 1.4rem 1.4rem; margin: 1rem 0; overflow-wrap: break-word; }
      .doc-sec h2 { margin: 0 0 .8rem; font-size: 1.2rem; color: #fff; padding-bottom: .5rem; border-bottom: 1px solid #232c44; }
      .doc-sec h3 { margin: 1.3rem 0 .4rem; font-size: 1.02rem; color: #c6d0e2; }
      .doc-sec p { color: #b9c4d8; font-size: .92rem; line-height: 1.65; margin: .5rem 0; }
      .doc-sec ul, .doc-sec ol { color: #b9c4d8; font-size: .92rem; line-height: 1.65; padding-left: 1.4rem; margin: .5rem 0; }
      .doc-sec li { margin: .25rem 0; }
      .doc-sec code { background: #0a0f1d; border: 1px solid #232c44; border-radius: 6px; padding: .08rem .35rem; color: #9fe8c3; font: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85em; }
      .doc-sec pre { background: #0a0f1d; border: 1px solid #232c44; border-radius: 10px; padding: .8rem .9rem; overflow-x: auto; margin: .8rem 0; }
      .doc-sec pre code { background: none; border: 0; padding: 0; color: #9fe8c3; font-size: .84rem; line-height: 1.6; }
      .doc-sec table { border-collapse: collapse; width: 100%; margin: .8rem 0; font-size: .86rem; }
      .doc-sec th, .doc-sec td { border: 1px solid #232c44; padding: .45rem .6rem; text-align: left; vertical-align: top; color: #b9c4d8; }
      .doc-sec th { background: #0a0f1d; color: #e6edf3; }
      .doc-sec hr { border: 0; border-top: 1px solid #232c44; margin: 1.2rem 0; }
      .tun-foot { text-align: center; color: #5c6a85; font-size: .82rem; display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }
      .tun-foot a { color: #7ee2ff; text-decoration: none; }
      .tun-foot a:hover { text-decoration: underline; }`;

// The full HTML docs page: same dark tunnel palette as pages.js TUNNEL_CSS,
// header with the two main actions, a TOC, then every rendered section.
function docsPageHtml({ base = '' } = {}) {
  const toc = GUIDE.map((s) => `<a href="#${s.id}">${escapeHtml(s.title)}</a>`).join('');
  const sections = GUIDE.map(
    (s) => `<section class="doc-sec">${renderMarkdown(`## ${s.title}\n\n${s.md}`, { headingIds: true })}</section>`,
  ).join('\n');
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    <title>Pips Tunnel — Full guide</title>
    <style>${DOCS_CSS}
    </style>
  </head>
  <body class="tun">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="docs">
      <header class="docs-head">
        <h1>Pips Tunnel — Full guide</h1>
        <p class="tagline">Publish any localhost app on this server's public URL. Install, quickstart, CLI, HTTP API, limits and troubleshooting — everything in one place.</p>
        <div class="docs-btns">
          <a class="docs-btn" href="/api/tunnel/client.tar.gz" download>Download client</a>
          <a class="docs-btn ghost" href="/tun/dashboard">Open dashboard</a>
        </div>
      </header>
      <section class="toc">
        <h2>Contents</h2>
        <nav>${toc}</nav>
      </section>
      ${sections}
      <footer class="tun-foot">
        <a href="/docs">App API docs</a>
        <a href="/llms.txt">llms.txt</a>
        <a href="/llms-full.txt">llms-full.txt</a>
        <a href="/tunnel.sh">tunnel.sh installer</a>
        <a href="/tun">Pips Tunnel home</a>
      </footer>
    </main>
  </body>
</html>
`;
}

// llms.txt: the LLM-readable index of the tunnel docs and endpoints.
function llmsTxt({ base = '' } = {}) {
  const b = String(base || '').replace(/\/+$/, '');
  return [
    '# Pips Tunnel',
    '',
    '> Publish any localhost app on this server\'s public URL at /tun/<name> — one command, a long-poll gateway, no inbound ports.',
    '',
    `Pips Tunnel is a reverse proxy built into this site. A small zero-dependency client (needs Node 18+) runs next to your local app, registers a tunnel name, long-polls the server for HTTP requests, forwards them to http://localhost:<port> and posts the responses back. Anonymous tunnels get a random name; a tunt_ token reserves stable names. Examples below use ${SERVER} — every route works on whatever host serves it.`,
    '',
    '## Docs',
    `- [Tunnel full guide](${b}/docs/tunnel.md): the complete guide — install, quickstart, CLI, HTTP API, error codes, limits, persistence, troubleshooting.`,
    `- [App API docs](${b}/docs): the complete HTTP API reference for the whole app — every endpoint, both auth schemes, error codes, limits.`,
    `- [llms-full.txt](${b}/llms-full.txt): the entire guide as one plain markdown document.`,
    `- [Landing page](${b}/tun): installer one-liner, quickstart and the currently connected tunnels.`,
    `- [Tunnel dashboard](${b}/tun/dashboard): paste a tunt_ token to inspect per-name traffic and request logs.`,
    `- [Manage tokens & names](${b}/tunnel): signed-in site users create/revoke CLI tokens and reserve/release stable names.`,
    `- [Client bundle](${b}/api/tunnel/client.tar.gz): tunnel.tar.gz — the tun client, rebuilt from source on every request.`,
    `- [Installer script](${b}/tunnel.sh): \`curl -fsSL <server>/tunnel.sh | sh\` installs into ~/.pips-tunnel.`,
    '',
    '## API',
    '- GET /tun — tunnel landing page (HTML).',
    '- GET /tun/<name>[/rest] — reverse proxy to the connected client\'s localhost app (any method; browsers get HTML error pages, other clients JSON).',
    '- GET /tun/dashboard — token-login traffic inspector (HTML; ?token=… or POST form field token).',
    '- GET /tunnel — tunnel manager page for signed-in site users (HTML).',
    '- GET /tunnel.sh — POSIX installer script for the client (text/x-shellscript).',
    '- GET /api/tunnel/client.tar.gz — the client bundle as tunnel.tar.gz (application/gzip, ETag).',
    '- POST /api/tunnel/register — connect a tunnel; Bearer tunt_ optional; 201 { name, clientId, reserved, account }.',
    '- GET /api/tunnel/poll?name=&client= — client long-poll; returns one queued visitor request or null.',
    '- POST /api/tunnel/respond — answer a forwarded request (status, headers, base64 body; 25 MB cap).',
    '- POST /api/tunnel/close — close a tunnel by name.',
    '- GET /api/tunnel/list — every connected tunnel with counters (no auth).',
    '- GET /api/tunnel/stats — server-wide tunnel totals, accounts, names, uptime (no auth).',
    '- POST /api/tunnel/account — create a tunnel account; returns a tunt_ token once.',
    '- GET /api/tunnel/whoami — validate a Bearer tunt_ token and list its reserved names.',
    '- GET /api/tunnel/tokens — list the signed-in site user\'s tunnel tokens (session or Bearer sat_).',
    '- POST /api/tunnel/tokens — create a tunnel token for the signed-in site user (full token shown once).',
    '- DELETE /api/tunnel/tokens/:id — revoke a token and release the names it held.',
    '- POST /api/tunnel/claim — reserve a stable name for one of the user\'s tokens.',
    '- POST /api/tunnel/release — release a reserved name.',
    '',
  ].join('\n');
}

// llms-full.txt: the llms.txt header block plus the entire guide as markdown.
function llmsFullTxt() {
  return [
    '# Pips Tunnel',
    '',
    '> Publish any localhost app on this server\'s public URL at /tun/<name> — one command, a long-poll gateway, no inbound ports.',
    '',
    'The full documentation follows in plain markdown.',
    '',
    guideMarkdown(),
  ].join('\n');
}

module.exports = { GUIDE, guideMarkdown, renderMarkdown, docsPageHtml, llmsTxt, llmsFullTxt, slugify, escapeHtml };
