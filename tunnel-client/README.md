# Pips Tunnel client (`tun`)

Publish any app running on your machine on the Pips server's public URL.

## Quick start

Needs Node 18+ (`node --version`).

```sh
tar -xzf tunnel.tar.gz && cd tunnel
chmod +x tun                       # first time only
./tun start 5000 test
```

Output:

```
  tunnel   https://precision-pledge-fled.ngrok-free.dev/tun/test
  local    http://localhost:5000
  ready    press Ctrl+C to stop
```

Open the tunnel URL — it now serves whatever `localhost:5000` serves. Works
with any framework (Express, Flask via `python -m http.server`-style proxies,
Vite dev servers, static `http-server`, anything HTTP). Stop with Ctrl+C.

## Commands

| Command | What it does |
| --- | --- |
| `./tun start <port> <name>` | Publish `http://localhost:<port>` at `/tun/<name>` |
| `./tun start <name> <port>` | Same, argument order does not matter |
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
  visitor. Nothing is stored; while the client is offline the URL answers 404.

## Notes

- Two clients cannot hold the same name: the newest wins and the older one is
  told to exit.
- Windows: run `node tun.js start 5000 test` instead of `./tun`.
- The request body through one proxied call is capped at 10 MB.
