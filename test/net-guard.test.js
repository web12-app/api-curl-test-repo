'use strict';

// Unit tests for the rules that stop URL imports from reaching the server's own network.
// No DNS lookup and no connection leave this process: names are answered by a fake table.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const { validateImportUrl, resolvePublicAddresses, isBlockedAddress, pinnedLookup, ipv6ToBytes } = require('../src/net-guard');
const { httpsTransport, suggestedName } = require('../src/url-import');

const codeOf = (fn) => {
  try {
    fn();
    return null;
  } catch (err) {
    return err.code;
  }
};

test('addresses that are not public are blocked, and public ones are allowed', () => {
  const blocked = [
    '127.0.0.1', // loopback
    '127.255.0.9',
    '10.1.2.3', // private
    '172.16.5.5',
    '172.31.255.255',
    '192.168.1.1',
    '169.254.169.254', // link-local, cloud metadata
    '100.64.0.1', // carrier-grade NAT
    '0.0.0.0',
    '224.0.0.1', // multicast
    '255.255.255.255',
    '192.0.2.10', // documentation
    '198.18.0.5', // benchmarking
    '::1', // IPv6 loopback
    '::', // unspecified
    'fe80::1', // link-local
    'fc00::1', // unique local
    'fd00:ec2::254', // cloud metadata over IPv6
    '::ffff:127.0.0.1', // IPv4-mapped loopback
    '::ffff:7f00:1', // the same, in hex
    '::ffff:169.254.169.254',
    '64:ff9b::7f00:1', // NAT64 to loopback
    '2001:db8::1', // documentation
    '2002:c0a8:101::1', // 6to4 (may embed private addresses)
    '2001::1', // Teredo
    'ff02::1', // multicast
    'not an address',
  ];
  for (const ip of blocked) assert.equal(isBlockedAddress(ip), true, `${ip} should be blocked`);

  const allowed = [
    '8.8.8.8',
    '1.1.1.1',
    '93.184.216.34',
    '172.32.0.1', // just outside 172.16/12
    '100.128.0.1', // just outside 100.64/10
    '::ffff:8.8.8.8', // IPv4-mapped public
    '64:ff9b::808:808', // NAT64 to a public address
    '2606:4700:4700::1111',
    '2001:4860:4860::8888',
  ];
  for (const ip of allowed) assert.equal(isBlockedAddress(ip), false, `${ip} should be allowed`);
});

test('IPv6 addresses expand to 16 bytes, and malformed ones are refused', () => {
  assert.equal(ipv6ToBytes('::1')[15], 1);
  assert.equal(ipv6ToBytes('2001:db8::1')[1], 0x01);
  assert.equal(ipv6ToBytes('::ffff:1.2.3.4')[12], 1);
  assert.equal(ipv6ToBytes('1:2:3:4:5:6:7:8:9'), null);
  assert.equal(ipv6ToBytes('1::2::3'), null);
  assert.equal(ipv6ToBytes('xyz::1'), null);
  assert.equal(ipv6ToBytes('::1.2.3.999'), null);
});

test('only https:// on the standard port, to a public host name, is accepted', () => {
  assert.equal(validateImportUrl('https://files.example.test/a/report.pdf?x=1').hostname, 'files.example.test');
  assert.equal(validateImportUrl('https://EXAMPLE.test./f.pdf').hostname, 'example.test', 'a trailing dot is removed');
  assert.equal(validateImportUrl('https://files.example.test/a#frag').hash, '', 'fragments are dropped');

  const refused = {
    'http://files.example.test/x': 'IMPORT_INVALID_URL',
    'ftp://files.example.test/x': 'IMPORT_INVALID_URL',
    'file:///etc/passwd': 'IMPORT_INVALID_URL',
    'https://user:pass@files.example.test/x': 'IMPORT_INVALID_URL',
    'https://files.example.test:8443/x': 'IMPORT_INVALID_URL',
    'https://files.example.test:80/x': 'IMPORT_INVALID_URL',
    'https://localhost/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://app.localhost/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://printer.local/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://db.internal/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://metadata.google.internal/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://intranet/x': 'IMPORT_BLOCKED_DESTINATION', // single label
    'https://wiki.corp/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://127.0.0.1/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://169.254.169.254/latest/meta-data': 'IMPORT_BLOCKED_DESTINATION',
    'https://[::1]/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://[fd00:ec2::254]/x': 'IMPORT_BLOCKED_DESTINATION',
    'https://a b.example.test/x': 'IMPORT_INVALID_URL',
    'https://exa_mple.test/x': 'IMPORT_INVALID_URL',
    'not a url': 'IMPORT_INVALID_URL',
    '': 'IMPORT_INVALID_URL',
  };
  for (const [url, code] of Object.entries(refused)) {
    assert.equal(codeOf(() => validateImportUrl(url)), code, url);
  }
  assert.equal(codeOf(() => validateImportUrl(42)), 'IMPORT_INVALID_URL', 'non-text is refused');
  assert.equal(codeOf(() => validateImportUrl(`https://a.test/${'x'.repeat(2100)}`)), 'IMPORT_INVALID_URL', 'too long');
});

test('a name that resolves to any non-public address is refused as a whole', async () => {
  const onlyPublic = async () => [{ address: '93.184.216.34', family: 4 }, { address: '93.184.216.35', family: 4 }];
  assert.deepEqual(await resolvePublicAddresses('files.example.test', onlyPublic), ['93.184.216.34', '93.184.216.35']);

  const mixed = async () => [{ address: '93.184.216.34', family: 4 }, { address: '10.0.0.5', family: 4 }];
  await assert.rejects(resolvePublicAddresses('files.example.test', mixed), { code: 'IMPORT_BLOCKED_DESTINATION' });

  const loopback = async () => [{ address: '127.0.0.1', family: 4 }];
  await assert.rejects(resolvePublicAddresses('files.example.test', loopback), { code: 'IMPORT_BLOCKED_DESTINATION' });

  const none = async () => [];
  await assert.rejects(resolvePublicAddresses('files.example.test', none), { code: 'IMPORT_DNS_FAILED' });

  const broken = async () => {
    throw Object.assign(new Error('lookup failed'), { code: 'ENOTFOUND' });
  };
  await assert.rejects(resolvePublicAddresses('files.example.test', broken), { code: 'IMPORT_DNS_FAILED' });
});

test('a pinned lookup answers only with the addresses that were checked, whatever name is asked for', async () => {
  const lookup = pinnedLookup(['93.184.216.34']);
  const all = await new Promise((resolve) => lookup('anything.example.test', { all: true }, (err, list) => resolve(list)));
  assert.deepEqual(all, [{ address: '93.184.216.34', family: 4 }]);

  const one = await new Promise((resolve) =>
    lookup('anything.example.test', {}, (err, address, family) => resolve({ err, address, family })),
  );
  assert.deepEqual(one, { err: null, address: '93.184.216.34', family: 4 });
});

test('the production transport connects only to the pinned address, never resolving the name again', async () => {
  // Nothing listens on the pinned loopback address in the test, so the connection is refused. What matters is
  // that the name was never looked up: a lookup would fail with ENOTFOUND in this offline sandbox.
  const url = new URL('https://files.example.test/x.pdf');
  await assert.rejects(
    httpsTransport(url, { addresses: ['127.0.0.1'], connectTimeoutMs: 2000, signal: null }),
    (err) => err && err.code !== 'ENOTFOUND' && err.code !== 'EAI_AGAIN',
  );
  assert.ok(net.isIP('127.0.0.1'));
});

test('a stored name comes from the header, then the URL, and never carries a directory', () => {
  const url = new URL('https://files.example.test/some/where/Final%20Plan.pdf');
  assert.equal(suggestedName({ 'content-disposition': 'attachment; filename="../../etc/passwd.txt"' }, url), 'passwd.txt');
  assert.equal(suggestedName({ 'content-disposition': "attachment; filename*=UTF-8''%E2%82%AC%20rates.csv" }, url), '€ rates.csv');
  assert.equal(suggestedName({ 'content-disposition': 'inline; filename=plain.txt' }, url), 'plain.txt');
  assert.equal(suggestedName({}, url), 'Final Plan.pdf');
  assert.equal(suggestedName({ 'content-disposition': 'attachment; filename=".."' }, new URL('https://files.example.test/')), '');
});
