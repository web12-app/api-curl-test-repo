#!/usr/bin/env node
'use strict';

// tun — the Pips tunnel client. Publishes a localhost app on the server's
// public URL:  tun start 5000 test  →  https://<server>/tun/test
//
// Zero dependencies. Needs Node 18+ (global fetch). The client registers an
// app name, long-polls the server for forwarded HTTP requests, calls
// http://localhost:<port>, and posts each response back. Traffic flows only
// while this process runs.

const DEFAULT_SERVER = process.env.TUN_SERVER || 'https://precision-pledge-fled.ngrok-free.dev';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

// Hop-by-hop and framing headers the tunnel handles itself; neither the
// request to localhost nor the response back to the server carries them.
const STRIP = new Set([
  'host', 'connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'te',
  'trailer', 'proxy-connection', 'proxy-authenticate', 'proxy-authorization',
  'content-length', 'accept-encoding', 'content-encoding',
]);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pickHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers || {})) {
    const lk = String(k).toLowerCase();
    if (!STRIP.has(lk) && !lk.startsWith(':') && v !== undefined && v !== null) out[lk] = String(v);
  }
  return out;
}

async function api(server, path, body) {
  const res = await fetch(server.replace(/\/+$/, '') + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'ngrok-skip-browser-warning': '1', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

function usage(message) {
  if (message) console.error(`\n  ${message}\n`);
  console.log(`tun — publish a localhost app on the Pips server

  tun start <port> <app-name>    publish http://localhost:<port> at /tun/<app-name>
                                 (name first also works: tun start test 5000)
  tun list                       show tunnels connected to the server
  tun close <app-name>           close a tunnel from here
  tun --server <url> ...         use another server (default: $TUN_SERVER)
  tun --help | --version

example:
  tar -xzf tunnel.tar.gz && cd tunnel
  ./tun start 5000 test
  open https://precision-pledge-fled.ngrok-free.dev/tun/test`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  let server = DEFAULT_SERVER;
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') server = argv[++i] || DEFAULT_SERVER;
    else if (a === '--help' || a === '-h') usage(null);
    else if (a === '--version' || a === '-v') { console.log('tun 1.0.0'); process.exit(0); }
    else positional.push(a);
  }
  return { server, positional };
}

async function start(server, port, name) {
  const reg = await api(server, '/api/tunnel/register', { name });
  if (reg.status !== 201 || !reg.json || reg.json.success !== true) {
    const msg = (reg.json && reg.json.error && reg.json.error.message) || `HTTP ${reg.status}`;
    console.error(`  could not register "${name}" on ${server}\n  ${msg}`);
    process.exit(1);
  }
  const clientId = reg.json.data.clientId;
  const url = `${server.replace(/\/+$/, '')}/tun/${name}`;
  console.log(`\n  tunnel   ${url}\n  local    http://localhost:${port}\n  ready    press Ctrl+C to stop\n`);
  let closing = false;
  const stop = async () => {
    if (closing) process.exit(0);
    closing = true;
    console.log('\n  closing tunnel...');
    try { await api(server, '/api/tunnel/close', { name, client: clientId }); } catch { /* best effort */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);

  let backoff = 500;
  for (;;) {
    let data;
    try {
      const res = await api(server, `/api/tunnel/poll?name=${encodeURIComponent(name)}&client=${encodeURIComponent(clientId)}`);
      const code = res.json && res.json.error && res.json.error.code;
      if (res.status === 410 || code === 'TUNNEL_REPLACED') {
        console.error('  this tunnel was taken over by another client. exiting.');
        process.exit(1);
      }
      if (res.status === 404 || code === 'TUNNEL_OFFLINE') {
        console.error('  the tunnel is gone (server restart?). re-registering...');
        return start(server, port, name);
      }
      if (res.status !== 200 || !res.json || res.json.success !== true) {
        throw new Error((res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`);
      }
      data = res.json.data;
      backoff = 500;
    } catch {
      await sleep(backoff);
      backoff = Math.min(backoff * 2, 5000);
      continue;
    }
    const req = data && data.request;
    if (!req) continue;
    handle(server, name, clientId, port, req).catch(() => {});
  }
}

async function handle(server, name, clientId, port, req) {
  const t0 = Date.now();
  const target = `http://127.0.0.1:${port}${req.path || '/'}`;
  let status = 502;
  let resHeaders = { 'content-type': 'text/plain; charset=utf-8' };
  let bodyB64 = '';
  try {
    const init = { method: req.method, headers: pickHeaders(req.headers), redirect: 'manual' };
    if (req.body && req.method !== 'GET' && req.method !== 'HEAD') {
      init.body = Buffer.from(req.body, 'base64');
    }
    const upstream = await fetch(target, init);
    status = upstream.status;
    const headers = {};
    for (const [k, v] of upstream.headers) {
      if (!STRIP.has(k)) headers[k] = v;
    }
    // undici keeps multiple Set-Cookie values out of headers iteration; recover them.
    if (typeof upstream.headers.getSetCookie === 'function') {
      const cookies = upstream.headers.getSetCookie();
      if (cookies.length) headers['set-cookie'] = cookies;
    }
    resHeaders = headers;
    bodyB64 = Buffer.from(await upstream.arrayBuffer()).toString('base64');
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'unknown error';
    bodyB64 = Buffer.from(`tunnel: the local app at http://localhost:${port} did not answer (${why}).`).toString('base64');
  }
  const bytes = Buffer.from(bodyB64, 'base64').length;
  console.log(`  ${req.method} ${req.path || '/'} → ${status}  ${Date.now() - t0} ms  ${bytes} B`);
  await api(server, '/api/tunnel/respond', { name, client: clientId, id: req.id, status, headers: resHeaders, body: bodyB64 });
}

async function list(server) {
  const res = await api(server, '/api/tunnel/list');
  if (res.status !== 200 || !res.json || res.json.success !== true) {
    console.error(`  could not reach ${server}`);
    process.exit(1);
  }
  const tunnels = res.json.data.tunnels || [];
  if (!tunnels.length) { console.log('  no tunnels are connected right now.'); return; }
  console.log('  name            pending  served  answered  age');
  for (const t of tunnels) {
    const age = `${Math.round(t.ageMs / 1000)}s`;
    console.log(`  ${t.name.padEnd(16)}${String(t.pending).padEnd(9)}${String(t.served).padEnd(8)}${String(t.answered).padEnd(10)}${age}`);
  }
}

async function close(server, name) {
  const res = await api(server, '/api/tunnel/close', { name });
  const ok = res.status === 200 && res.json && res.json.success && res.json.data.closed;
  console.log(ok ? `  tunnel "${name}" closed.` : `  no tunnel named "${name}" is connected.`);
}

async function main() {
  const { server, positional } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === 'start') {
    const a = positional[1] || '';
    const b = positional[2] || '';
    const portFirst = /^\d+$/.test(a);
    const rawPort = portFirst ? a : b;
    const name = String(portFirst ? b : a).trim().toLowerCase();
    if (!/^\d+$/.test(rawPort)) usage('start needs a port (1-65535): tun start 5000 test');
    const port = Number(rawPort);
    if (port < 1 || port > 65535) usage('port must be 1-65535.');
    if (!NAME_RE.test(name)) usage('app name must be 1-32 chars (a-z 0-9 - _), e.g. test');
    await start(server, port, name);
  } else if (cmd === 'list') {
    await list(server);
  } else if (cmd === 'close') {
    if (!positional[1]) usage('close needs the app name: tun close test');
    await close(server, positional[1].trim().toLowerCase());
  } else {
    usage(cmd ? `unknown command: ${cmd}` : 'missing a command.');
  }
}

main().catch((err) => {
  console.error(`  tun failed: ${(err && err.message) || err}`);
  process.exit(1);
});
