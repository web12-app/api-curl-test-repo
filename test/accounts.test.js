'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { signup, login } = require('../src/accounts');
const { RateLimiter } = require('../src/rate-limit');
const { MemoryStorage } = require('../src/memory-storage');
const { verifyPassword } = require('../src/passwords');
const { StorageError } = require('../src/errors');
const { usernamePath } = require('../src/paths');

const ctxFor = (storage) => ({ storage, limiter: new RateLimiter(), now: () => 1_700_000_000_000 });
const IP = '203.0.113.7';

async function expectCode(promise, code) {
  await assert.rejects(promise, (err) => err.code === code, `expected ${code}`);
}

test('signup stores a hash, not the password, and returns the public user only', async () => {
  const storage = new MemoryStorage();
  const ctx = ctxFor(storage);
  const user = await signup(ctx, { username: 'Alice_01', password: 'a-long-password', ip: IP });

  assert.deepEqual(Object.keys(user).sort(), ['id', 'username']);
  assert.equal(user.username, 'alice_01');

  const stored = (await storage.readJson(`users/${user.id}.json`)).data;
  assert.ok(!JSON.stringify(stored).includes('a-long-password'));
  assert.match(stored.password_hash, /^scrypt\$/);
  assert.equal(await verifyPassword('a-long-password', stored.password_hash), true);
});

test('a taken username is refused', async () => {
  const storage = new MemoryStorage();
  const ctx = ctxFor(storage);
  await signup(ctx, { username: 'bob', password: 'password-one', ip: IP });
  await expectCode(signup(ctx, { username: 'BOB', password: 'password-two', ip: IP }), 'USERNAME_TAKEN');
});

test('invalid usernames and passwords are refused before anything is written', async () => {
  const storage = new MemoryStorage();
  const ctx = ctxFor(storage);
  await expectCode(signup(ctx, { username: 'ab', password: 'password-one', ip: IP }), 'INVALID_USERNAME');
  await expectCode(signup(ctx, { username: '../etc', password: 'password-one', ip: IP }), 'INVALID_USERNAME');
  await expectCode(signup(ctx, { username: 'carol', password: 'short', ip: IP }), 'INVALID_PASSWORD');
  await expectCode(signup(ctx, { username: 'carol', password: 'x'.repeat(300), ip: IP }), 'INVALID_PASSWORD');
  assert.equal(storage.files.size, 0);
});

test('a failed user write releases the username', async () => {
  const storage = new MemoryStorage();
  const failing = Object.assign(storage, {
    createJson: async (path, data, message) => {
      if (path.startsWith('users/')) throw new StorageError('simulated outage');
      return MemoryStorage.prototype.createJson.call(storage, path, data, message);
    },
  });
  await assert.rejects(signup(ctxFor(failing), { username: 'dave', password: 'password-one', ip: IP }), StorageError);
  assert.equal(await storage.readJson(usernamePath('dave')), null);
});

test('login succeeds with the right password and fails with the wrong one or an unknown user', async () => {
  const storage = new MemoryStorage();
  const ctx = ctxFor(storage);
  const made = await signup(ctx, { username: 'erin', password: 'password-one', ip: IP });

  assert.deepEqual(await login(ctx, { username: 'erin', password: 'password-one', ip: IP }), made);
  await expectCode(login(ctx, { username: 'erin', password: 'password-two', ip: IP }), 'INVALID_CREDENTIALS');
  await expectCode(login(ctx, { username: 'nobody', password: 'password-one', ip: IP }), 'INVALID_CREDENTIALS');
  await expectCode(login(ctx, { username: 'x', password: 42, ip: IP }), 'INVALID_CREDENTIALS');
});

test('five failures lock the account for 15 minutes, even with the right password', async () => {
  const storage = new MemoryStorage();
  const ctx = ctxFor(storage);
  await signup(ctx, { username: 'frank', password: 'password-one', ip: IP });
  for (let i = 0; i < 5; i++) {
    await expectCode(login(ctx, { username: 'frank', password: 'wrong-guess-1', ip: IP }), 'INVALID_CREDENTIALS');
  }
  await expectCode(login(ctx, { username: 'frank', password: 'password-one', ip: IP }), 'RATE_LIMITED');
});

test('signup is limited to 10 per address per hour', async () => {
  const storage = new MemoryStorage();
  const ctx = ctxFor(storage);
  for (let i = 0; i < 10; i++) {
    await signup(ctx, { username: `user${i}xx`, password: 'password-one', ip: IP });
  }
  await expectCode(signup(ctx, { username: 'user99x', password: 'password-one', ip: IP }), 'RATE_LIMITED');
});
