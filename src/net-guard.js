'use strict';

// Rules for fetching a file from a URL on the server. Any http:// or https:// link of any shape is accepted: any
// port, IP addresses, host names, and user name and password for basic auth. data: links are accepted too; the
// bytes travel inside the link itself. What remains restricted is WHERE the server may connect:
//
// - Loopback, private ranges, link-local and cloud metadata addresses, and internal names are refused, so the
//   server cannot be used to reach its own network. IMPORT_ALLOW_PRIVATE=1 turns that guard off (for importing
//   from an internal server on purpose).
// - Every address a name resolves to must pass the same check. One blocked address refuses the whole name.
// - The connection uses the addresses that were checked (pinnedLookup). It never resolves the name a second time,
//   so a DNS answer cannot change between the check and the connection (DNS rebinding).
const dns = require('node:dns');
const net = require('node:net');
const { AppError } = require('./errors');

const MAX_URL_CHARS = 2048;
const BLOCKED_NAME_RE = /(^|\.)(localhost|localdomain|local|internal|intranet|lan|corp|home\.arpa|in-addr\.arpa|ip6\.arpa)$/;
const LABEL_RE = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

const blocked = (message) => new AppError(400, 'IMPORT_BLOCKED_DESTINATION', message);

// The one guard message that says how to open the network up on purpose.
const PRIVATE_HINT = 'Set IMPORT_ALLOW_PRIVATE=1 on the server to allow internal addresses.';

// IPv4 ranges that are not public. Anything not listed here is treated as public.
const V4_BLOCKED = new net.BlockList();
for (const [addr, bits] of [
  ['0.0.0.0', 8], // "this network"
  ['10.0.0.0', 8], // private
  ['100.64.0.0', 10], // carrier-grade NAT
  ['127.0.0.0', 8], // loopback
  ['169.254.0.0', 16], // link-local, includes cloud metadata 169.254.169.254
  ['172.16.0.0', 12], // private
  ['192.0.0.0', 24], // IETF protocol assignments
  ['192.0.2.0', 24], // documentation
  ['192.88.99.0', 24], // 6to4 relay anycast
  ['192.168.0.0', 16], // private
  ['198.18.0.0', 15], // benchmarking
  ['198.51.100.0', 24], // documentation
  ['203.0.113.0', 24], // documentation
  ['224.0.0.0', 4], // multicast
  ['240.0.0.0', 4], // reserved, includes 255.255.255.255
]) {
  V4_BLOCKED.addSubnet(addr, bits, 'ipv4');
}

// IPv6 is allowed only inside 2000::/3 (global unicast). Everything outside it is blocked, plus a few
// special-purpose blocks inside it.
const V6_BLOCKED = new net.BlockList();
for (const [addr, bits] of [
  ['::', 3],
  ['4000::', 2],
  ['8000::', 1],
  ['2001:db8::', 32], // documentation
  ['2001::', 32], // Teredo, embeds IPv4 addresses
  ['2001:10::', 28], // ORCHID
  ['2001:20::', 28], // ORCHIDv2
  ['2001:2::', 48], // benchmarking
  ['2002::', 16], // 6to4, embeds IPv4 addresses
  ['3fff::', 20], // documentation
]) {
  V6_BLOCKED.addSubnet(addr, bits, 'ipv6');
}

// Expands an IPv6 address to 16 bytes. Returns null when it is not a valid address.
function ipv6ToBytes(input) {
  let s = String(input).toLowerCase();
  const zone = s.indexOf('%');
  if (zone >= 0) s = s.slice(0, zone);
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const o = tail[1].split('.').map(Number);
    if (o.some((n) => n > 255)) return null;
    s = `${s.slice(0, s.length - tail[1].length)}${((o[0] << 8) | o[1]).toString(16)}:${((o[2] << 8) | o[3]).toString(16)}`;
  }
  const halves = s.split('::');
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(':') : [];
  const rest = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  let groups = head;
  if (halves.length === 2) {
    const fill = 8 - head.length - rest.length;
    if (fill < 0) return null;
    groups = [...head, ...Array(fill).fill('0'), ...rest];
  }
  if (groups.length !== 8) return null;
  const bytes = Buffer.alloc(16);
  for (let i = 0; i < 8; i += 1) {
    if (!/^[0-9a-f]{1,4}$/.test(groups[i])) return null;
    bytes.writeUInt16BE(parseInt(groups[i], 16), i * 2);
  }
  return bytes;
}

// True when the address is not one this server may connect to. Unknown input counts as blocked.
function isBlockedAddress(ip) {
  const family = net.isIP(ip);
  if (family === 4) return V4_BLOCKED.check(ip, 'ipv4');
  if (family !== 6) return true;
  const bytes = ipv6ToBytes(ip);
  if (!bytes) return true;
  const v4Tail = () => [bytes[12], bytes[13], bytes[14], bytes[15]].join('.');
  // IPv4-mapped (::ffff:a.b.c.d): judged by the IPv4 address it carries.
  if (bytes.subarray(0, 10).every((b) => b === 0) && bytes[10] === 0xff && bytes[11] === 0xff) {
    return isBlockedAddress(v4Tail());
  }
  // NAT64 well-known prefix (64:ff9b::/96): judged by the embedded IPv4 address.
  if (bytes.subarray(0, 4).equals(Buffer.from([0x00, 0x64, 0xff, 0x9b])) && bytes.subarray(4, 12).every((b) => b === 0)) {
    return isBlockedAddress(v4Tail());
  }
  return !!V6_BLOCKED.check(ip, 'ipv6') || !isGlobalV6(bytes);
}

function isGlobalV6(bytes) {
  return (bytes[0] & 0xe0) === 0x20; // 2000::/3
}

// Checks the URL the user gave. Returns the parsed URL. Throws AppError with a stable code.
// With { allowPrivate } the internal-network guard is off: loopback, private ranges, and internal names pass.
function validateImportUrl(raw, { allowPrivate = false } = {}) {
  if (typeof raw !== 'string' || raw.length === 0) {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'Enter a direct http:// or https:// link to a file.');
  }
  // Control characters are refused everywhere: they can never be part of a link. A space is refused for network
  // links (it would have to be encoded), but a data: link carries its payload, so spaces inside it are fine and
  // are percent-encoded by the URL parser.
  if (/[\u0000-\u001f\u007f]/.test(raw)) {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'The link contains control characters.');
  }
  // A data: link carries the file inside itself, so it can be longer than a network link. Its decoded size is
  // checked against the same file limit in the downloader.
  const isData = raw.startsWith('data:');
  if (!isData && raw.length > MAX_URL_CHARS) {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'Enter a direct http:// or https:// link to a file.');
  }
  if (!isData && /[\u0020]/.test(raw)) {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'The link contains spaces or control characters.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'Enter a direct http:// or https:// link to a file.');
  }
  if (url.protocol === 'data:') {
    // Needs the shape data:[mediatype][;base64],payload. The payload is decoded by the downloader.
    if (!/^data:[^,]*,/.test(raw)) {
      throw new AppError(400, 'IMPORT_INVALID_URL', 'Enter a direct http:// or https:// link to a file.');
    }
    url.hash = '';
    return url;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'Only http:// and https:// links can be imported.');
  }
  let host = url.hostname.toLowerCase();
  const isAddress = host.startsWith('[') && host.endsWith(']');
  if (isAddress) host = host.slice(1, -1);
  if (net.isIP(host)) {
    if (!allowPrivate && isBlockedAddress(host)) {
      throw blocked(`That address is not public. ${PRIVATE_HINT}`);
    }
    url.hostname = host; // the URL setter puts the brackets back on IPv6
    url.hash = '';
    return url;
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  if (host.length === 0 || host.length > 253) {
    throw blocked('That host name is not a public internet name.');
  }
  if (!allowPrivate && BLOCKED_NAME_RE.test(host)) {
    throw blocked(`That host name points inside a private network. ${PRIVATE_HINT}`);
  }
  if (!host.split('.').every((label) => LABEL_RE.test(label))) {
    throw new AppError(400, 'IMPORT_INVALID_URL', 'The host name is not valid.');
  }
  url.hostname = host;
  url.hash = '';
  return url;
}

// Resolves a host name and returns its addresses. By default any non-public address refuses the whole name.
// `lookup` is injectable for tests; production uses the system resolver.
async function resolvePublicAddresses(hostname, lookup = dns.promises.lookup, { allowPrivate = false } = {}) {
  let records;
  try {
    records = await lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new AppError(502, 'IMPORT_DNS_FAILED', 'The host name could not be resolved.');
  }
  if (!Array.isArray(records) || records.length === 0) {
    throw new AppError(502, 'IMPORT_DNS_FAILED', 'The host name could not be resolved.');
  }
  const addresses = [...new Set(records.map((r) => r.address))];
  if (!allowPrivate && addresses.some((a) => isBlockedAddress(a))) {
    throw blocked(`That host name points to a network this server may not use. ${PRIVATE_HINT}`);
  }
  return addresses;
}

// A DNS lookup function that returns only the given (already checked) addresses, whatever the host name is.
// Node calls it with the hostname and options; it answers in the shape the caller asked for.
function pinnedLookup(addresses) {
  return (hostname, options, callback) => {
    const cb = typeof options === 'function' ? options : callback;
    const opts = typeof options === 'function' ? {} : options || {};
    if (opts.all) {
      cb(null, addresses.map((address) => ({ address, family: net.isIP(address) })));
      return;
    }
    cb(null, addresses[0], net.isIP(addresses[0]));
  };
}

module.exports = { validateImportUrl, resolvePublicAddresses, isBlockedAddress, pinnedLookup, ipv6ToBytes };
