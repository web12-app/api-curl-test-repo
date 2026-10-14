'use strict';

// The tunnel.sh installer: a POSIX sh script the user pipes straight into sh:
//   curl -fsSL https://<server>/tunnel.sh | sh
// It checks for Node 18+, downloads the client bundle from the server it came
// from (overridable with TUN_SERVER), unpacks it into $TUNNEL_HOME (default
// ~/.pips-tunnel), links `tun` into ~/.local/bin when that exists, and prints
// the one command to publish a local app. No root, nothing outside $HOME.

function installScript(base) {
  const b = String(base || '').replace(/\/+$/, '');
  return `#!/bin/sh
# Pips Tunnel installer. Run it with:
#   curl -fsSL ${b}/tunnel.sh | sh
# Point it at another server with: TUN_SERVER=https://other-host sh tunnel.sh
set -eu

SERVER="\${TUN_SERVER:-${b}}"
DEST="\${TUNNEL_HOME:-$HOME/.pips-tunnel}"

say() { printf '%s\\n' "  $*"; }

if ! command -v node >/dev/null 2>&1; then
  say "Node.js is required (18 or newer) — install it from https://nodejs.org and retry."
  exit 1
fi
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 18 ]; then
  say "Node.js 18+ is required; found $(node --version 2>/dev/null || echo unknown)."
  exit 1
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

fetch() {
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL -H 'ngrok-skip-browser-warning: 1' -o "$2" "$1"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "$2" --header 'ngrok-skip-browser-warning: 1' "$1"
  else
    say "Need curl or wget to download the client."
    exit 1
  fi
}

say "Downloading the tunnel client from $SERVER ..."
mkdir -p "$DEST"
fetch "$SERVER/api/tunnel/client.tar.gz" "$TMP/tunnel.tar.gz"
tar -xzf "$TMP/tunnel.tar.gz" -C "$DEST" --strip-components=1
chmod +x "$DEST/tun" "$DEST/tun.js"

# Best effort: most Linux PATHs already include ~/.local/bin.
if [ -d "$HOME/.local/bin" ] && [ -w "$HOME/.local/bin" ]; then
  ln -sf "$DEST/tun" "$HOME/.local/bin/tun"
fi

say "Pips Tunnel installed in $DEST"
case ":$PATH:" in
  *":$DEST:"*) ;;
  *":$HOME/.local/bin:"*) ;;
  *) say "Add it to your PATH:  echo 'export PATH=\"$DEST:\\$PATH\"' >> ~/.profile" ;;
esac
say ""
say "Publish a local app (example):"
say "  $DEST/tun start 5000"
say "A random tunnel name is assigned and the $SERVER/tun/... URL is printed."
say ""
say "Want a stable name? Create a token, log in once, then name it:"
say "  curl -X POST $SERVER/api/tunnel/account   # prints a tunt_... token"
say "  $DEST/tun login <token>"
say "  $DEST/tun start 5000 myname               # keeps /tun/myname yours"
say ""
say "Inspect traffic and logs: $SERVER/tun/dashboard"
`;
}

module.exports = { installScript };
