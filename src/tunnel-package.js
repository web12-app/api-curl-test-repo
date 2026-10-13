'use strict';

// Builds tunnel.tar.gz — the downloadable tunnel client bundle — in memory
// from the files in tunnel-client/. Pure Node: a minimal ustar writer plus
// zlib for the gzip layer, so there is no build step and no committed binary.
// The bytes are deterministic (fixed mtime), which lets responses carry a
// stable ETag.

const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { createHash } = require('node:crypto');

const CLIENT_DIR = path.join(__dirname, '..', 'tunnel-client');
const MTIME = 1760000000; // fixed timestamp keeps the tarball byte-for-byte reproducible

const FILES = [
  { name: 'tunnel/tun.js', mode: 0o644 },
  { name: 'tunnel/tun', mode: 0o755 },
  { name: 'tunnel/README.md', mode: 0o644 },
];

function ustarHeader(name, size, mode) {
  const h = Buffer.alloc(512, 0);
  h.write(name, 0, Math.min(100, name.length), 'utf8');
  h.write(`${mode.toString(8).padStart(6, '0')}\0 `, 100, 8, 'ascii');
  h.write('0000000\0 ', 108, 8, 'ascii'); // uid
  h.write('0000000\0 ', 116, 8, 'ascii'); // gid
  h.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 12, 'ascii');
  h.write(`${MTIME.toString(8).padStart(11, '0')}\0`, 136, 12, 'ascii');
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
  h.write('0', 156, 1, 'ascii'); // typeflag: regular file
  h.write('ustar\0', 257, 6, 'binary');
  h.write('00', 263, 2, 'binary');
  let sum = 0;
  for (const b of h) sum += b;
  h.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 8, 'ascii');
  return h;
}

function tarGz(files) {
  const chunks = [];
  for (const f of files) {
    const data = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    chunks.push(ustarHeader(f.name, data.length, f.mode));
    chunks.push(data);
    const pad = (512 - (data.length % 512)) % 512;
    if (pad) chunks.push(Buffer.alloc(pad));
  }
  chunks.push(Buffer.alloc(1024)); // two zero blocks end the archive
  return zlib.gzipSync(Buffer.concat(chunks), { level: 9 });
}

// Reads tunnel-client/* fresh on every call: the download always matches the
// deployed source. Returns { body, etag, files } or null when a source file
// is missing (never expected; the files ship with the repo).
function clientBundle() {
  const files = [];
  for (const f of FILES) {
    const full = path.join(CLIENT_DIR, path.basename(f.name));
    if (!fs.existsSync(full)) return null;
    files.push({ name: f.name, mode: f.mode, data: fs.readFileSync(full) });
  }
  const body = tarGz(files);
  const etag = `"${createHash('sha256').update(body).digest('hex').slice(0, 24)}"`;
  return { body, etag, files: files.map((f) => f.name) };
}

module.exports = { clientBundle, tarGz };
