#!/usr/bin/env node
'use strict';

// tun — the Pips tunnel client. Publishes a localhost app on the server's
// public URL:  tun start 5000 test  →  https://<server>/tun/test
// Anonymous runs get a random name; `tun login <token>` (from
// curl -X POST <server>/api/tunnel/account) reserves stable names.
//
// Zero dependencies. Needs Node 18+ (global fetch). The client registers an
// app name, long-polls the server for forwarded HTTP requests, calls
// http://localhost:<port>, and posts each response back. Traffic flows only
// while this process runs.
//
// Honesty rules: the CLI only prints states it actually observed — the
// server's own error text when register fails, the reconnect counter when a
// tunnel re-registers, and a Cloudflare URL only when cloudflared itself
// printed one. Nothing here is invented.

const os = require('node:os');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const DEFAULT_SERVER = process.env.TUN_SERVER || 'https://precision-pledge-fled.ngrok-free.dev';
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const TUNNEL_HOME = process.env.TUNNEL_HOME || path.join(os.homedir(), '.pips-tunnel');
const TOKEN_FILE = path.join(TUNNEL_HOME, 'token');
const CONFIG_FILE = path.join(TUNNEL_HOME, 'config.json');
const TRYCF_RE = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i;
const CF_INSTALL_HINT = 'https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/do-more-with-tunnels/trycloudflare/';

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

async function api(server, path, body, token) {
  const headers = { 'ngrok-skip-browser-warning': '1' };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(server.replace(/\/+$/, '') + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

// The tunnel token, if the user ran `tun login` (or set TUN_TOKEN).
function storedToken() {
  if (process.env.TUN_TOKEN) return String(process.env.TUN_TOKEN);
  try {
    return fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  } catch {
    return '';
  }
}

// Small on-disk config next to the token file. Currently one pointer: the
// last successfully started name, so `tun close` works without arguments.
function readConfig() {
  try { return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')) || {}; } catch { return {}; }
}

function rememberLastName(name) {
  try {
    fs.mkdirSync(TUNNEL_HOME, { recursive: true });
    const cfg = readConfig();
    cfg.lastName = name;
    fs.writeFileSync(CONFIG_FILE, `${JSON.stringify(cfg, null, 2)}\n`, { mode: 0o600 });
  } catch { /* best effort: a convenience pointer, never fatal */ }
}

function lastName() {
  return String(readConfig().lastName || '');
}

function serverHost(server) {
  try { return new URL(server).host || server; } catch { return server; }
}

function usage(message) {
  if (message) console.error(`\n  ${message}\n`);
  console.log(`tun — publish a localhost app on the Pips server

  tun start <port> <app-name>    publish http://localhost:<port> at /tun/<app-name>
                                 (name first also works: tun start test 5000;
                                 --name <n> wins over positionals; omit the name
                                 and the server assigns one)
  tun status [name]              connected tunnels with LIVE/OFFLINE, pending,
                                 served, age and port/proto (token mask only)
  tun logs <name>                recent requests for your tunnel (needs a token)
  tun doctor [--port N]          environment checklist: node, server, token,
                                 cloudflared, local port
  tun cloudflared [--url <t>]    temporary Cloudflare Quick Tunnel with ingress
                                 <t> (default: $TUN_CLOUDFLARED_TARGET, then
                                 this server)
  tun login <token>              remember a tunt_… token so named tunnels
                                 stay reserved for your account
  tun list                       show tunnels connected to the server
  tun close [app-name]           close a tunnel (no name: the last started one)
  tun --server <url> ...         use another server (default: $TUN_SERVER)
  tun --help | --version

example:
  tar -xzf tunnel.tar.gz && cd tunnel
  ./tun start 5000               # random name, the /tun/... URL is printed
  ./tun start 5000 test          # stable name (after tun login <token>)`);
  process.exit(message ? 1 : 0);
}

function parseArgs(argv) {
  let server = DEFAULT_SERVER;
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--server') server = argv[++i] || DEFAULT_SERVER;
    else if (a === '--name') flags.name = argv[++i] || '';
    else if (a === '--port') flags.port = argv[++i] || '';
    else if (a === '--url') flags.url = argv[++i] || '';
    else if (a === '--help' || a === '-h') usage(null);
    else if (a === '--version' || a === '-v') { console.log('tun 2.0.0'); process.exit(0); }
    else positional.push(a);
  }
  return { server, positional, flags };
}

// G13: poke the local app before registering. Nothing listening is only a
// warning — apps often start a beat after the tunnel does.
async function probeLocal(port) {
  try {
    await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
  } catch {
    console.log(`  warn: nothing is listening on http://127.0.0.1:${port} yet — continuing anyway`);
  }
}

async function start(server, port, name, reconnects = 0) {
  console.log('');
  console.log('  Pips Tunnel');
  console.log('  ────────────────────────────────────────');
  console.log(`  Application : ${name || '(assigned on register)'}`);
  console.log(`  Local URL   : http://127.0.0.1:${port}`);
  console.log(`  Provider    : ${serverHost(server)}`);
  console.log('  Status      : Connecting...');
  console.log('');
  await probeLocal(port);
  // G14: the register body carries the local target (port) and the protocol
  // generation (proto 2) so the server can show exactly what is behind the URL.
  const regBody = { port, proto: 2 };
  if (name) regBody.name = name;
  const reg = await api(server, '/api/tunnel/register', regBody, storedToken());
  if (reg.status !== 201 || !reg.json || reg.json.success !== true) {
    const err = (reg.json && reg.json.error) || {};
    console.error(`  could not register "${name || '(random name)'}" on ${server}`);
    console.error(`  ${err.message || `HTTP ${reg.status}`}`);
    if (reg.status === 401 || err.code === 'INVALID_TOKEN') {
      console.error('  hint: run `tun login <token>` with a valid tunt_ token, or unset TUN_TOKEN to go anonymous.');
    } else if (err.code === 'TUNNEL_LIMIT' || err.code === 'TUNNEL_BUSY') {
      console.error('  hint: the server is at capacity right now — retry in a moment.');
    }
    process.exit(1);
  }
  const clientId = reg.json.data.clientId;
  // The server may assign a random name (anonymous tunnels get one): always
  // trust the name from the register response for the URL, polling and close.
  if (reg.json.data.name && String(reg.json.data.name) !== name) {
    name = String(reg.json.data.name);
  }
  rememberLastName(name);
  const base = server.replace(/\/+$/, '');
  console.log('  Application registered.');
  console.log('  Transport connected.');
  console.log('  Public routing enabled.');
  console.log('');
  console.log('  Public URL:');
  console.log(`  ${base}/tun/${name}`);
  console.log('');
  console.log('  Local target:');
  console.log(`  http://127.0.0.1:${port}`);
  console.log('');
  console.log(`  Status: Connected${reconnects > 0 ? ` · reconnected ×${reconnects}` : ''}`);
  console.log('');
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
    // Ctrl+C is closing the tunnel: stop picking up new work and let the
    // close call finish instead of racing it to an exit code.
    if (closing) { await sleep(50); continue; }
    let data;
    try {
      const res = await api(server, `/api/tunnel/poll?name=${encodeURIComponent(name)}&client=${encodeURIComponent(clientId)}`);
      const code = res.json && res.json.error && res.json.error.code;
      if (res.status === 410 || code === 'TUNNEL_REPLACED') {
        if (closing) process.exit(0); // the 410 is our own close landing
        console.error('  this tunnel was taken over by another client. exiting.');
        process.exit(1);
      }
      if (res.status === 404 || code === 'TUNNEL_OFFLINE') {
        if (closing) process.exit(0);
        console.error('  the tunnel is gone (server restart?). re-registering...');
        return start(server, port, name, reconnects + 1);
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

// G15: `tun status [name]` — the same list the dashboard sees, plus the
// caller's own token identity as a mask (never the token itself).
async function status(server, name) {
  let res;
  try {
    res = await api(server, '/api/tunnel/list');
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'unknown error';
    console.error(`  cannot reach ${server} (${why})`);
    process.exit(1);
  }
  if (res.status !== 200 || !res.json || res.json.success !== true) {
    console.error(`  cannot reach ${server}: ${(res.json && res.json.error && res.json.error.message) || `HTTP ${res.status}`}`);
    process.exit(1);
  }
  const tunnels = res.json.data.tunnels || [];
  const rows = name ? tunnels.filter((t) => t.name === name) : tunnels;
  if (name && !rows.length) {
    console.log(`  ${name}  OFFLINE (not connected)`);
  } else if (!rows.length) {
    console.log('  no tunnels are connected right now.');
  } else {
    console.log('  name            status  pending  served  age        local target');
    for (const t of rows) {
      const age = `${Math.round(t.ageMs / 1000)}s`;
      const local = t.port ? `127.0.0.1:${t.port}${t.proto ? ` (proto ${t.proto})` : ''}` : '—';
      const nameCol = t.name.padEnd(Math.max(16, t.name.length + 2));
      console.log(`  ${nameCol}LIVE    ${String(t.pending).padEnd(9)}${String(t.served).padEnd(8)}${age.padEnd(11)}${local}`);
    }
  }
  const token = storedToken();
  if (token) {
    try {
      const me = await api(server, '/api/tunnel/whoami', undefined, token);
      if (me.status === 200 && me.json && me.json.success === true) {
        console.log(`\n  token: ${me.json.data.account.tokenMask}`);
      } else {
        console.log('\n  token: the stored token was not accepted — run `tun login <token>` to refresh.');
      }
    } catch { /* identity check is best effort */ }
  }
}

// G15: `tun logs <name>` — the server keeps a 50-row ring per owned name.
async function logs(server, name) {
  if (!name) usage('logs needs the app name: tun logs test');
  const token = storedToken();
  if (!token) {
    console.error('  no token stored: logs are owner-only. run `tun login <token>` (or set TUN_TOKEN).');
    process.exit(1);
  }
  let res;
  try {
    res = await api(server, `/api/tunnel/logs?name=${encodeURIComponent(name)}`, undefined, token);
  } catch (err) {
    const why = (err && err.cause && (err.cause.code || err.cause.message)) || (err && err.message) || 'unknown error';
    console.error(`  cannot reach ${server} (${why})`);
    process.exit(1);
  }
  const err = res.json && res.json.error;
  if (res.status === 401) {
    console.error(`  the stored token was not accepted (${(err && err.code) || 'INVALID_TOKEN'}). run \`tun login <token>\`.`);
    process.exit(1);
  }
  if (res.status === 403) {
    console.error(`  "${name}" belongs to a different tunnel token (NAME_NOT_YOURS).`);
    process.exit(1);
  }
  if (res.status === 404) {
    console.error(`  no reserved tunnel name "${name}" (NAME_NOT_FOUND).`);
    process.exit(1);
  }
  if (res.status !== 200 || !res.json || res.json.success !== true) {
    console.error(`  could not fetch logs (${(err && err.message) || `HTTP ${res.status}`})`);
    process.exit(1);
  }
  const rows = res.json.data.logs || [];
  if (!rows.length) {
    console.log(`  no requests logged for "${name}" yet.`);
    return;
  }
  console.log(`  ${name} — ${rows.length} recent request(s), newest first`);
  console.log('  time                 method  path                  status      ms       B');
  for (const r of rows) {
    const time = new Date(r.t).toISOString().replace('T', ' ').slice(0, 19);
    console.log(`  ${time}  ${String(r.method).padEnd(8)}${String(r.path || '/').padEnd(22)}${String(r.status).padEnd(12)}${String(r.ms).padEnd(9)}${r.bytes}`);
  }
}

// Run a short-lived version probe (`--version`) with a hard timeout.
function probeBinary(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    let out = '';
    let child;
    try {
      child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch {
      resolve({ ok: false, out: '' });
      return;
    }
    let settled = false;
    const done = (ok) => {
      if (settled) return;
      settled = true;
      resolve({ ok, out: out.trim().split('\n')[0] });
    };
    const timer = setTimeout(() => {
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
      done(true);
    }, timeoutMs);
    child.stdout.on('data', (c) => { out += c; });
    child.stderr.on('data', (c) => { out += c; });
    child.on('error', () => { clearTimeout(timer); done(false); });
    child.on('close', (code) => { clearTimeout(timer); done(code === 0); });
  });
}

// G15: `tun doctor [--port N]` — honest checklist. Exit 1 only when the
// server is unreachable (that alone makes tunneling impossible).
async function doctor(server, portFlag) {
  let port = null;
  if (portFlag !== undefined && portFlag !== '') {
    if (!/^\d+$/.test(String(portFlag)) || Number(portFlag) < 1 || Number(portFlag) > 65535) {
      usage('doctor --port needs a port number (1-65535).');
    }
    port = Number(portFlag);
  }
  const line = (ok, label, detail) => console.log(`  ${ok ? '✓' : '✗'} ${label}${detail ? ` — ${detail}` : ''}`);

  const nodeMajor = Number(process.versions.node.split('.')[0]);
  line(nodeMajor >= 18, `node ${process.versions.node}`, nodeMajor >= 18 ? 'meets the 18+ requirement' : 'Node 18+ is required');

  let stats = null;
  try {
    const res = await api(server, '/api/tunnel/stats');
    if (res.status === 200 && res.json && res.json.success === true) stats = res.json.data;
  } catch { /* reported below */ }
  line(Boolean(stats), `server ${server}`, stats ? `reachable — ${stats.tunnels} tunnel(s) connected` : 'unreachable');

  const token = storedToken();
  if (!token) {
    line(true, 'token', 'no token stored (anonymous tunnels only; `tun login <token>` reserves names)');
  } else {
    let mask = null;
    try {
      const me = await api(server, '/api/tunnel/whoami', undefined, token);
      if (me.status === 200 && me.json && me.json.success === true) mask = me.json.data.account.tokenMask;
    } catch { /* reported below */ }
    if (mask) line(true, 'token', `valid (${mask})`);
    else line(false, 'token', stats ? 'stored but rejected — run `tun login <token>` to refresh' : 'could not verify (server unreachable)');
  }

  const cf = await probeBinary(process.env.TUN_CLOUDFLARED_BIN || 'cloudflared', ['--version'], 3000);
  line(cf.ok, 'cloudflared', cf.ok ? (cf.out || 'found') : `not found — install: ${CF_INSTALL_HINT}`);

  if (port !== null) {
    let ok = false;
    let why = '';
    try {
      await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
      ok = true;
    } catch (err) {
      why = (err && err.cause && (err.cause.code || err.cause.message)) || 'nothing listening';
    }
    line(ok, `local port ${port}`, ok ? 'reachable' : why);
  }

  console.log(stats ? '\n  doctor: the server is reachable — tunneling is available.' : '\n  doctor: the server is unreachable — tunneling will not work until it is.');
  if (!stats) process.exit(1);
}

// G16: `tun cloudflared` — a temporary Cloudflare Quick Tunnel in front of
// the server that serves the /tun routes. The URL is only ever echoed from
// cloudflared's own output; nothing is fabricated.
async function cloudflared(server, flags) {
  const target = flags.url || process.env.TUN_CLOUDFLARED_TARGET || server;
  const bin = process.env.TUN_CLOUDFLARED_BIN || 'cloudflared';
  console.log('');
  console.log('  Pips Tunnel');
  console.log('  ────────────────────────────────────────');
  console.log(`  Target      : ${target}`);
  console.log('  Provider    : Cloudflare Quick Tunnel (temporary)');
  console.log('  Status      : Starting cloudflared...');
  console.log('');
  const version = await probeBinary(bin, ['--version'], 4000);
  if (!version.ok) {
    console.error(`  ${bin} is not usable (${version.out || 'not found or no --version output'}).`);
    console.error(`  install it from ${CF_INSTALL_HINT}`);
    process.exit(1);
  }
  const child = spawn(bin, ['tunnel', '--url', target, '--no-autoupdate'], { stdio: ['ignore', 'pipe', 'pipe'] });
  let url = '';
  let tail = '';
  const scan = (chunk) => {
    tail = (tail + String(chunk)).slice(-1200);
    if (url) return;
    const m = String(chunk).match(TRYCF_RE);
    if (!m) return;
    url = m[0];
    console.log('  Application registered.');
    console.log('  Transport connected.');
    console.log('  Public routing enabled.');
    console.log('');
    console.log('  Public URL:');
    console.log(`  ${url}`);
    console.log('');
    console.log(`  Local target:`);
    console.log(`  ${target}`);
    console.log('');
    console.log('  Status: Connected (Cloudflare Quick Tunnel) — press Ctrl+C to stop');
    console.log('');
  };
  child.stdout.on('data', scan);
  child.stderr.on('data', scan);
  let stopping = false;
  const stop = () => {
    stopping = true;
    try { child.kill(); } catch { /* already gone */ }
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  const watchdog = setTimeout(() => {
    if (url) return;
    console.error('  no trycloudflare URL appeared within 90s. cloudflared last said:');
    console.error(`  ${(tail.trim() || '(no output)').split('\n').join('\n  ')}`);
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
    process.exit(1);
  }, 90000);
  child.on('exit', (code, signal) => {
    clearTimeout(watchdog);
    if (stopping) return;
    console.error(`\n  cloudflared exited (code ${code === null ? `signal ${signal}` : code}).`);
    console.error('  Status: Disconnected');
    process.exit(url ? 0 : 1);
  });
}

// Validate a tunnel token against the server and store it for future runs.
async function login(server, token) {
  const res = await fetch(server.replace(/\/+$/, '') + '/api/tunnel/whoami', {
    headers: { 'ngrok-skip-browser-warning': '1', Authorization: `Bearer ${token}` },
    signal: AbortSignal.timeout(45000),
  });
  const json = await res.json().catch(() => ({}));
  if (res.status !== 200 || !json || json.success !== true) {
    const msg = (json && json.error && json.error.message) || `HTTP ${res.status}`;
    console.error(`  that token was not accepted by ${server}\n  ${msg}`);
    process.exit(1);
  }
  fs.mkdirSync(TUNNEL_HOME, { recursive: true });
  fs.writeFileSync(TOKEN_FILE, `${token}\n`, { mode: 0o600 });
  const who = json.data.account || {};
  console.log(`  logged in as ${who.label || 'tunnel account'} (${who.tokenMask || 'tunt_…'})`);
  console.log(`  token stored in ${TOKEN_FILE}`);
  console.log(`  dashboard: ${server.replace(/\/+$/, '')}/tun/dashboard`);
}

async function main() {
  const { server, positional, flags } = parseArgs(process.argv.slice(2));
  const cmd = positional[0];
  if (cmd === 'start') {
    const a = positional[1] || '';
    const b = positional[2] || '';
    const portFirst = /^\d+$/.test(a);
    let rawPort = portFirst ? a : b;
    if (flags.port) rawPort = String(flags.port);
    let name = String(portFirst ? b : a).trim().toLowerCase();
    if (flags.name) name = String(flags.name).trim().toLowerCase(); // --name wins over positionals
    if (!/^\d+$/.test(String(rawPort || ''))) usage('start needs a port (1-65535): tun start 5000 test');
    const port = Number(rawPort);
    if (port < 1 || port > 65535) usage('port must be 1-65535.');
    if (name && !NAME_RE.test(name)) usage('app name must be 1-32 chars (a-z 0-9 - _), e.g. test');
    await start(server, port, name);
  } else if (cmd === 'login') {
    if (!positional[1]) usage('login needs a token (create one: curl -X POST <server>/api/tunnel/account)');
    await login(server, positional[1].trim());
  } else if (cmd === 'list') {
    await list(server);
  } else if (cmd === 'status') {
    await status(server, (positional[1] || '').trim().toLowerCase());
  } else if (cmd === 'logs') {
    await logs(server, (positional[1] || '').trim().toLowerCase());
  } else if (cmd === 'doctor') {
    await doctor(server, flags.port);
  } else if (cmd === 'cloudflared') {
    await cloudflared(server, flags);
  } else if (cmd === 'close') {
    const name = (positional[1] || '').trim().toLowerCase();
    if (name) {
      await close(server, name);
      return;
    }
    const last = lastName();
    if (!last) usage('close needs the app name: tun close test — or run `tun start` first so the last name is remembered');
    await close(server, last);
  } else {
    usage(cmd ? `unknown command: ${cmd}` : 'missing a command.');
  }
}

main().catch((err) => {
  console.error(`  tun failed: ${(err && err.message) || err}`);
  process.exit(1);
});
