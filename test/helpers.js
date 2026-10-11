'use strict';

const { createServer } = require('../src/server');
const { MemoryStorage } = require('../src/memory-storage');

// Fake configuration for tests. None of these values are real.
const TEST_ENV = {
  GITHUB_TOKEN: 'ghp_test_token_not_real',
  PRIVATE_DATA_REPO: 'owner/private-data',
  SESSION_SECRET: 'test-session-secret-that-is-long-enough-1234',
  COOKIE_SECURE: '0',
};

// Starts a server with in-memory storage and a fresh rate limiter.
async function startServer({ env = TEST_ENV, now } = {}) {
  const storage = new MemoryStorage();
  const server = createServer({ env, storage, now });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    storage,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

// Pulls "session=<value>" out of a Set-Cookie header.
function sessionFrom(res) {
  const header = res.headers.get('set-cookie') || '';
  const match = header.match(/session=([^;]+)/);
  return match && match[1] ? `session=${match[1]}` : null;
}

module.exports = { TEST_ENV, startServer, sessionFrom };
