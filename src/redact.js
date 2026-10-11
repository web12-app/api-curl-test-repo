'use strict';

// Forms that may appear in logs. The Actions logs of a public repository are public, so a name or a link is
// never logged in full. A masked name keeps the first character and the extension. A reference is the first
// eight hex characters of a SHA-256 hash, which does not reveal the value.
const crypto = require('node:crypto');
const path = require('node:path');

function maskName(name) {
  const text = typeof name === 'string' ? name : '';
  const ext = path.extname(text).toLowerCase().slice(0, 10);
  const first = text.charAt(0) || '?';
  return `${first}…${ext}`;
}

function ref(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, 8);
}

module.exports = { maskName, ref };
