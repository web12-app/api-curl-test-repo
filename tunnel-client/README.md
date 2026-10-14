# Pips Tunnel client (`tun`)

Publish any app running on your machine on the Pips server's public URL.

## Quick start

Needs Node 18+ (`node --version`).

```sh
tar -xzf tunnel.tar.gz && cd tunnel
chmod +x tun                       # first time only
./tun start 5000
```

Output:

```
  Pips Tunnel
  ────────────────────────────────────────
  Application : swift-otter-3f2a
  Local URL   : http://127.0.0.1:5000
  Provider    : precision-pledge-fled.ngrok-free.dev
  Status      : Connecting...

  Application registered.
  Transport connected.
  Public routing enabled.

  Public URL:
  https://precision-pledge-fled.ngrok-free.dev/tun/swift-otter-3f2a

  Local target:
  http://127.0.0.1:5000

  Status: Connected
```

No name needed: the server assigns a random one and prints the tunnel URL —
open it and it serves whatever `localhost:5000` serves. Works with any
framework (Express, Flask via `python -m http.server`-style proxies, Vite dev
servers, static `http-server`, anything HTTP). Stop with Ctrl+C.

If nothing is listening on the port yet, `tun start` says so and keeps going —
start your app whenever; the tunnel picks it up.

## A stable URL (optional)

Anonymous tunnels get a fresh random name on every run. To keep a name:

```sh
curl -X POST https://precision-pledge-fled.ngrok-free.dev/api/tunnel/account
# → {"token":"tunt_…"}   (save it; it is shown once)

./tun login tunt_…                # stores the token in ~/.pips-tunnel/token
./tun start 5000 myname           # /tun/myname stays reserved for you
```

Inspect traffic, counters and recent request logs for your names at
**/tun/dashboard** on the server (paste your token to log in).

## Commands

| Command | What it does |
| --- | --- |
| `./tun start <port> <name>` | Publish `http://localhost:<port>` at `/tun/<name>` |
| `./tun start <name> <port>` | Same, argument order does not matter |
| `./tun start --name <n> <port>` | Same, `--name` wins over positional names |
| `./tun start <port>` | Publish with a random name (URL is printed) |
| `./tun status [name]` | Connected tunnels: LIVE/OFFLINE, pending, served, age, port/proto |
| `./tun logs <name>` | Recent requests for one of your tunnels (needs a token) |
| `./tun doctor [--port N]` | Environment checklist: node, server, token, cloudflared, local port |
| `./tun cloudflared [--url <t>]` | Temporary Cloudflare Quick Tunnel in front of `<t>` |
| `./tun login <token>` | Remember a `tunt_…` token so named tunnels stay yours |
| `./tun list` | Show every tunnel connected to the server |
| `./tun close [name]` | Close a tunnel; with no name it closes the last one you started |
| `./tun --server <url> ...` | Point the client at another server |

`--server` (or the `TUN_SERVER` environment variable) overrides the default
server, so the same client works behind ngrok, Cloudflare, or any host in
front of the app.

### `tun status`

`./tun status` lists every connected tunnel with its LIVE state, queued and
served counts, age since registration, and the local port/proto the client
registered (`./tun start 5000 myapp` reports `127.0.0.1:5000 (proto 2)`).
`./tun status myapp` checks one name — an unconnected name prints
`OFFLINE (not connected)`. When a token is stored, its mask (never the token
itself) is shown after a `whoami` check. If the server cannot be reached, the
client prints the reason and exits 1.

### `tun logs`

`./tun logs myapp` prints the recent request ring the server keeps for names
owned by your token (up to 50 rows, newest first): time, method, path, status,
duration, bytes. It needs `tun login <token>` (or `TUN_TOKEN`); anonymous
names have no owner, so they have no logs view.

### `tun doctor`

`./tun doctor` checks, with ✓/✗ lines: node ≥ 18, that the server answers
`/api/tunnel/stats` (with the current tunnel count), whether a stored token is
valid (mask only) or absent, that a `cloudflared` binary is available, and —
with `--port N` — that something is listening on `127.0.0.1:N`. Exit code is 1
only when the server is unreachable; every other finding is informational.

### `tun cloudflared`

`./tun cloudflared` runs `cloudflared tunnel --url <target> --no-autoupdate`
for a temporary, no-account Quick Tunnel. The default target is
`$TUN_CLOUDFLARED_TARGET`, then the configured server — the ingress must point
at the host serving the `/tun` routes, otherwise the tunnel has nothing to
forward to. `--url` overrides the target. The CLI scans cloudflared's own
output for the `…trycloudflare.com` URL and prints it once it appears; it
never invents one. If no URL shows up within 90 s it prints cloudflared's
actual last output and exits 1. `TUN_CLOUDFLARED_BIN` overrides the binary
path.

## How it works

- The client registers an app name (a-z, 0-9, `-`, `_`; 1-32 chars) with its
  local port and proto, then long-polls the server for incoming requests
  (the long-poll is the heartbeat: while this process runs, the tunnel is
  LIVE; idle tunnels the client abandons are dropped by the server after a
  TTL and visitors see the tunnel as offline).
- Each request to `https://<server>/tun/<name>/...` is forwarded to
  `http://localhost:<port>/...` — the `/tun/<name>` prefix is stripped, so a
  local route `/about` stays `/about`. The server replaces anything the
  visitor claimed about the proxy chain, so your app sees a clean
  `x-forwarded-*` set.
- Responses (status, headers, body) travel back through the server to the
  visitor. While the client is offline the URL answers 404 with a page that
  retries on its own.

## Honest limitations

- **No WebSocket forwarding.** Upgrade requests are refused with 501
  (`WEBSOCKET_UNSUPPORTED`); tunnel plain HTTP instead.
- **Buffered responses, 25 MB cap.** Each response is read fully into memory
  before it is sent back through the tunnel; request bodies are capped at
  10 MB.
- **Long-poll heartbeat, no push.** Requests reach you only while the client
  process runs and polls; there is no server-to-client push channel.
- **Android/Termux.** Install Node 18+ via `pkg install nodejs`; the client
  works inside proot distributions. Keep the device awake (disable battery
  optimization or acquire a wakelock) or Android will freeze the poll loop
  and the tunnel will look offline.

## Notes

- Names reserved by an account (after `tun login`) cannot be taken by other
  callers; two of your own clients can still take the name over — the newest
  wins and the older one is told to exit.
- Windows: run `node tun.js start 5000 test` instead of `./tun`.
- The request body through one proxied call is capped at 10 MB.
