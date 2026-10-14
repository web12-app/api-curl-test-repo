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
  tunnel   https://precision-pledge-fled.ngrok-free.dev/tun/swift-otter-3f2a
  local    http://localhost:5000
  ready    press Ctrl+C to stop
```

No name needed: the server assigns a random one and prints the tunnel URL —
open it and it serves whatever `localhost:5000` serves. Works with any
framework (Express, Flask via `python -m http.server`-style proxies, Vite dev
servers, static `http-server`, anything HTTP). Stop with Ctrl+C.

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
| `./tun start <port>` | Publish with a random name (URL is printed) |
| `./tun login <token>` | Remember a `tunt_…` token so named tunnels stay yours |
| `./tun list` | Show every tunnel connected to the server |
| `./tun close <name>` | Close a tunnel from here |
| `./tun --server <url> ...` | Point the client at another server |

`--server` (or the `TUN_SERVER` environment variable) overrides the default
server, so the same client works behind ngrok, Cloudflare, or any host in
front of the app.

## How it works

- The client registers an app name (a-z, 0-9, `-`, `_`; 1-32 chars) and then
  long-polls the server for incoming requests.
- Each request to `https://<server>/tun/<name>/...` is forwarded to
  `http://localhost:<port>/...` — the `/tun/<name>` prefix is stripped, so a
  local route `/about` stays `/about`.
- Responses (status, headers, body) travel back through the server to the
  visitor. While the client is offline the URL answers 404 with a page that
  retries on its own.

## Notes

- Names reserved by an account (after `tun login`) cannot be taken by other
  callers; two of your own clients can still take the name over — the newest
  wins and the older one is told to exit.
- Windows: run `node tun.js start 5000 test` instead of `./tun`.
- The request body through one proxied call is capped at 10 MB.
