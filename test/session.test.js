'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createSession, readSession, parseCookies, sessionCookie } = require('../src/session');
const { escapeHtml } = require('../src/pages');

const SECRET = 'a-session-secret-that-is-long-enough-for-tests';
const USER = 'f'.repeat(32);

test('a session round-trips the user id', () => {
  const token = createSession(SECRET, USER, 60_000, 1000);
  assert.deepEqual(readSession(SECRET, token, 1500).uid, USER);
});

test('a tampered payload is rejected', () => {
  const token = createSession(SECRET, USER, 60_000, 1000);
  const [payload, mac] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ uid: 'e'.repeat(32), exp: 999_999_999_999 })).toString('base64url');
  assert.equal(readSession(SECRET, `${forged}.${mac}`, 1500), null);
  assert.equal(readSession(SECRET, `${payload}x.${mac}`, 1500), null);
});

test('a session signed with another secret is rejected', () => {
  const token = createSession('some-other-secret-that-is-long-enough-xx', USER, 60_000, 1000);
  assert.equal(readSession(SECRET, token, 1500), null);
});

test('expired and garbage sessions are rejected', () => {
  const token = createSession(SECRET, USER, 1000, 1000);
  assert.equal(readSession(SECRET, token, 2000), null);
  for (const junk of [undefined, '', 'nodot', '.', 'a.b', 42]) {
    assert.equal(readSession(SECRET, junk, 1500), null, String(junk));
  }
});

test('parseCookies reads named values and ignores junk', () => {
  assert.deepEqual(parseCookies('a=1; session=abc.def; ; bad'), { a: '1', session: 'abc.def' });
  assert.deepEqual(parseCookies(undefined), {});
});

test('session cookies are HttpOnly and SameSite=Lax, and Secure when enabled', () => {
  const secure = sessionCookie('tok', { maxAgeSec: 60, secure: true });
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Lax/);
  assert.match(secure, /; Secure/);
  assert.doesNotMatch(sessionCookie('tok', { maxAgeSec: 60, secure: false }), /Secure/);
});

test('escapeHtml neutralises markup', () => {
  assert.equal(escapeHtml('<script>"x"&\'y\'</script>'), '&lt;script&gt;&quot;x&quot;&amp;&#39;y&#39;&lt;/script&gt;');
});
