'use strict';

// Passwords are stored only as scrypt hashes. Each hash has its own random salt and records its parameters.
const crypto = require('node:crypto');

const PARAMS = { N: 16384, r: 8, p: 1 };
const KEY_LENGTH = 64;
const MAX_MEMORY = 64 * 1024 * 1024;

function scrypt(password, salt, { N, r, p }, keyLength) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password, salt, keyLength, { N, r, p, maxmem: MAX_MEMORY }, (err, key) => {
      if (err) reject(err);
      else resolve(key);
    });
  });
}

// Format: scrypt$N$r$p$<salt base64>$<key base64>
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS, KEY_LENGTH);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

async function verifyPassword(password, stored) {
  if (typeof stored !== 'string') return false;
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (![N, r, p].every(Number.isInteger) || N < 2 || N > 2 ** 17 || r < 1 || p < 1) return false;

  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (expected.length === 0) return false;

  const actual = await scrypt(password, salt, { N, r, p }, expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

module.exports = { hashPassword, verifyPassword };
