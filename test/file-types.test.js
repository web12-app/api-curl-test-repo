'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  TYPES,
  ALLOWED_EXTENSIONS,
  sanitizeFilename,
  extensionOf,
  asciiFallback,
  encodeFilenameStar,
  contentMatches,
} = require('../src/file-types');

function tempFile(bytes) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ftypes-'));
  const file = path.join(dir, 'x');
  fs.writeFileSync(file, bytes);
  return { file, cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

async function matchesBytes(ext, bytes) {
  const { file, cleanup } = tempFile(bytes);
  try {
    return await contentMatches(TYPES[ext], file);
  } finally {
    cleanup();
  }
}

test('the allowlist has no active content', () => {
  for (const bad of ['.html', '.htm', '.svg', '.js', '.mjs', '.xhtml', '.xml', '.exe', '.sh', '.php']) {
    assert.ok(!ALLOWED_EXTENSIONS.includes(bad), `${bad} must not be allowed`);
  }
  assert.ok(ALLOWED_EXTENSIONS.includes('.pdf'));
  assert.ok(ALLOWED_EXTENSIONS.includes('.png'));
});

test('each allowed type has a mime type and a category', () => {
  for (const ext of ALLOWED_EXTENSIONS) {
    assert.match(TYPES[ext].mime, /^[a-z]+\/[a-z0-9.+-]+/, ext);
    assert.ok(['image', 'document', 'archive', 'video', 'audio'].includes(TYPES[ext].category), ext);
  }
});

test('sanitizeFilename keeps only the last segment and rejects unusable names', () => {
  assert.equal(sanitizeFilename('../../etc/passwd.txt'), 'passwd.txt');
  assert.equal(sanitizeFilename('C:\\Users\\me\\notes.txt'), 'notes.txt');
  assert.equal(sanitizeFilename('bad\u0000\u0007name.txt'), 'badname.txt');
  assert.equal(sanitizeFilename('  spaced name.pdf  '), 'spaced name.pdf');
  assert.equal(sanitizeFilename('..'), null);
  assert.equal(sanitizeFilename('.'), null);
  assert.equal(sanitizeFilename('.hidden'), null);
  assert.equal(sanitizeFilename(''), null);
  assert.equal(sanitizeFilename('   '), null);
  assert.equal(sanitizeFilename(42), null);
  assert.equal(sanitizeFilename(undefined), null);
});

test('sanitizeFilename caps long names and keeps the extension', () => {
  const long = `${'a'.repeat(300)}.pdf`;
  const out = sanitizeFilename(long);
  assert.ok(out.length <= 120, `length ${out.length}`);
  assert.ok(out.endsWith('.pdf'));
});

test('extensionOf lowercases and returns empty when there is none', () => {
  assert.equal(extensionOf('Photo.JPG'), '.jpg');
  assert.equal(extensionOf('archive.tar.gz'), '.gz');
  assert.equal(extensionOf('README'), '');
});

test('asciiFallback removes characters that would break the header', () => {
  assert.equal(asciiFallback('a"b;c\\d.txt'), 'a_b_c_d.txt');
  assert.equal(asciiFallback('résumé.txt'), 'r_sum_.txt');
  assert.doesNotMatch(asciiFallback('line\r\nbreak.txt'), /[\r\n]/);
});

test('encodeFilenameStar uses RFC 5987 percent-encoding', () => {
  assert.equal(encodeFilenameStar("it's (1).txt"), "it%27s%20%281%29.txt");
  assert.equal(encodeFilenameStar('résumé.txt'), 'r%C3%A9sum%C3%A9.txt');
});

test('binary types must start with their signature', async () => {
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0];
  assert.equal(await matchesBytes('.png', Buffer.from(png)), true);
  assert.equal(await matchesBytes('.png', Buffer.from('<html>not a png</html>')), false);
  assert.equal(await matchesBytes('.pdf', Buffer.from('%PDF-1.7 ...')), true);
  assert.equal(await matchesBytes('.pdf', Buffer.from('MZ....')), false);
  assert.equal(await matchesBytes('.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0])), true);
  assert.equal(await matchesBytes('.gif', Buffer.from('GIF89a....')), true);
  assert.equal(await matchesBytes('.gif', Buffer.from('GIF87a....')), true);
  assert.equal(await matchesBytes('.gif', Buffer.from('GIF90a....')), false);
  assert.equal(await matchesBytes('.zip', Buffer.from([0x50, 0x4b, 0x03, 0x04, 1])), true);
});

test('a binary file shorter than its signature does not match', async () => {
  assert.equal(await matchesBytes('.png', Buffer.from([0x89, 0x50])), false);
  assert.equal(await matchesBytes('.png', Buffer.alloc(0)), false);
});

test('webp needs both RIFF and WEBP markers', async () => {
  const good = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WEBPVP8 ')]);
  assert.equal(await matchesBytes('.webp', good), true);
  assert.equal(await matchesBytes('.webp', Buffer.from('RIFF0000WAVEfmt ')), false);
});

test('text types must be valid UTF-8 with no NUL bytes', async () => {
  assert.equal(await matchesBytes('.txt', Buffer.from('hello wörld\n', 'utf8')), true);
  assert.equal(await matchesBytes('.txt', Buffer.from([0x68, 0x00, 0x69])), false, 'NUL byte');
  assert.equal(await matchesBytes('.txt', Buffer.from([0x68, 0xff, 0xfe])), false, 'invalid UTF-8');
  assert.equal(await matchesBytes('.csv', Buffer.alloc(0)), true, 'an empty text file is valid content');
});

test('UTF-8 split across stream chunks is accepted', async () => {
  // A 3-byte character repeated so that it straddles the internal 64 KiB read boundary.
  const unit = Buffer.from('€');
  const body = Buffer.alloc(3 * 68200); // a multiple of 3, so the buffer is exactly whole characters
  for (let i = 0; i + unit.length <= body.length; i += unit.length) unit.copy(body, i);
  assert.equal(await matchesBytes('.txt', body), true);
  body[body.length - 1] = 0xe2; // truncated sequence at the end
  assert.equal(await matchesBytes('.txt', body), false);
});

test('a binary blob renamed to .txt is refused', async () => {
  const blob = Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x81, 0x00, 0x00]);
  assert.equal(await matchesBytes('.txt', blob), false);
});
