'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { hashPassword, verifyPassword } = require('../src/passwords');

test('hashPassword stores a scrypt hash, never the password', async () => {
  const hash = await hashPassword('correct horse battery');
  assert.match(hash, /^scrypt\$16384\$8\$1\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.ok(!hash.includes('correct horse battery'));
});

test('verifyPassword accepts the right password and rejects others', async () => {
  const hash = await hashPassword('right-password-1');
  assert.equal(await verifyPassword('right-password-1', hash), true);
  assert.equal(await verifyPassword('wrong-password-1', hash), false);
  assert.equal(await verifyPassword('', hash), false);
});

test('each hash uses a fresh salt', async () => {
  const a = await hashPassword('same-password');
  const b = await hashPassword('same-password');
  assert.notEqual(a, b);
  assert.equal(await verifyPassword('same-password', a), true);
  assert.equal(await verifyPassword('same-password', b), true);
});

test('malformed or foreign stored values never verify', async () => {
  for (const stored of [undefined, null, 42, '', 'plain-text', 'scrypt$x$8$1$AAAA$BBBB', 'pbkdf2$1$2$3$4$5']) {
    assert.equal(await verifyPassword('anything', stored), false, String(stored));
  }
});
