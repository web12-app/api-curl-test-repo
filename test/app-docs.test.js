'use strict';

// The whole-app API reference page: GET /docs renders every endpoint, both
// auth schemes, the error-code table and the limits — plus the site-chrome
// integration points (nav, /tun footer, /tunnel manager footer, llms.txt).

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, TEST_ENV } = require('./helpers');
const tunnelDocs = require('../src/tunnel-docs');
const pages = require('../src/pages');

describe('GET /docs — the app API reference', () => {
  test('renders 200 HTML with the title, TOC anchors and short caching', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/docs`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      assert.match(res.headers.get('cache-control'), /max-age=300/);
      assert.ok(res.headers.get('content-security-policy'), 'ships a CSP');
      const html = await res.text();
      assert.ok(html.includes('Pips API Docs'), 'the title shows');
      assert.ok(html.includes('id="error-codes"'), 'error-code section carries a slug id');
      assert.ok(html.includes('href="#error-codes"'), 'the TOC links the error-code section');
    } finally {
      await app.close();
    }
  });

  test('documents every endpoint group: at least 12 distinct real paths', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/docs`);
      const html = await res.text();
      const paths = [
        '/api/health', '/api/me', '/api/tokens', '/api/files', '/api/db',
        '/api/devices', '/api/social/chat', '/api/tube/feed', '/api/chat',
        '/v1/chat/completions', '/api/tunnel/tokens', '/api/tunnel/account',
        '/api/tunnel/stats', '/tunnel.sh', '/api/tunnel/client.tar.gz',
        '/llms.txt', '/tun/dashboard',
      ];
      const missing = paths.filter((p) => !html.includes(p));
      assert.deepEqual(missing, [], 'every documented path appears');
    } finally {
      await app.close();
    }
  });

  test('explains all three credentials: session cookie, sat_ and tunt_ tokens', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const html = await (await fetch(`${app.base}/docs`)).text();
      assert.ok(html.includes('sat_'), 'site API token prefix');
      assert.ok(html.includes('tunt_'), 'tunnel token prefix');
      assert.ok(html.includes('session='), 'session cookie credential');
      assert.ok(html.includes('Bearer'), 'bearer auth is described');
      assert.ok(html.includes('X-Requested-With'), 'CSRF header is described');
    } finally {
      await app.close();
    }
  });

  test('error-code table has 12+ rows covering site and tunnel codes', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const html = await (await fetch(`${app.base}/docs`)).text();
      const start = html.indexOf('id="error-codes"');
      const end = html.indexOf('id="limits-and-environment-knobs"');
      assert.ok(start > 0 && end > start, 'both sections render');
      const section = html.slice(start, end);
      assert.ok((section.match(/<tr>/g) || []).length >= 12, 'a real table with many rows');
      for (const code of ['NOT_AUTHENTICATED', 'INVALID_CREDENTIALS', 'CSRF_HEADER_REQUIRED',
        'FILE_MISSING', 'RATE_LIMITED', 'INVALID_NAME', 'INVALID_TOKEN', 'NAME_TAKEN',
        'TUNNEL_OFFLINE', 'TUNNEL_TIMEOUT', 'TUNNEL_LIMIT', 'PAYLOAD_TOO_LARGE']) {
        assert.ok(section.includes(code), `error code ${code} documented`);
      }
    } finally {
      await app.close();
    }
  });

  test('shows the response envelope for success and failure', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const html = await (await fetch(`${app.base}/docs`)).text();
      const esc = tunnelDocs.escapeHtml;
      assert.ok(html.includes(esc('"success": true')), 'success envelope example');
      assert.ok(html.includes(esc('"success": false')), 'error envelope example');
      assert.ok(html.includes(esc('"code"')) && html.includes(esc('"message"')), 'error shape documented');
    } finally {
      await app.close();
    }
  });

  test('cross-links the tunnel guide, markdown and llms variants', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const html = await (await fetch(`${app.base}/docs`)).text();
      for (const href of ['/docs/tunnel', '/docs/tunnel.md', '/llms.txt', '/llms-full.txt', '/tunnel.sh', '/tun']) {
        assert.ok(html.includes(`href="${href}"`), `links ${href}`);
      }
    } finally {
      await app.close();
    }
  });
});

describe('/docs integration in the site chrome', () => {
  test('the layout nav links /docs for anonymous and signed-in users', () => {
    assert.ok(pages.authForm({ mode: 'login', error: '' }).includes('href="/docs"'), 'anonymous nav (login page)');
    const manage = pages.tunnelManagePage({ user: { username: 'alice' }, tokens: [], names: [] });
    assert.ok(manage.includes('href="/docs"'), 'signed-in nav + manager footer');
  });

  test('/tun, /login and /docs/tunnel all link back to /docs', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      for (const path of ['/tun', '/login', '/docs/tunnel']) {
        const html = await (await fetch(`${app.base}${path}`)).text();
        assert.ok(html.includes('href="/docs"'), `${path} links the API docs`);
      }
    } finally {
      await app.close();
    }
  });

  test('llms.txt discovers the app API docs page', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/llms.txt`);
      assert.equal(res.status, 200);
      const text = await res.text();
      assert.ok(text.includes('## Docs'), 'still an llms index');
      assert.ok(text.includes('App API docs') && text.includes('/docs)'), 'lists /docs in the Docs section');
      assert.ok(text.includes('/docs/tunnel.md'), 'still lists the tunnel guide');
    } finally {
      await app.close();
    }
  });
});
