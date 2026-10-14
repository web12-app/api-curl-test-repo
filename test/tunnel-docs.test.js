'use strict';

// Tunnel documentation: /docs/tunnel (HTML guide), /docs/tunnel.md, llms.txt,
// llms-full.txt, the accuracy of the guide content against the code, and the
// minimal markdown renderer in src/tunnel-docs.js.

const { test, describe } = require('node:test');
const assert = require('node:assert/strict');
const { startServer, TEST_ENV } = require('./helpers');
const tunnelDocs = require('../src/tunnel-docs');

describe('tunnel docs pages over HTTP', () => {
  test('GET /docs/tunnel renders the guide with TOC anchors and code blocks', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/docs/tunnel`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/html/);
      const html = await res.text();
      assert.ok(html.includes('Full guide'), 'the title shows');
      assert.ok(html.includes('<h2 id="'), 'headings carry ids');
      assert.ok(html.includes('href="#quick-start"'), 'TOC anchors exist');
      assert.ok(html.includes('href="#http-api-reference"'), 'API section is linked');
      assert.ok((html.match(/<pre><code/g) || []).length >= 3, 'rendered code blocks');
      assert.ok(html.includes('Download client') && html.includes('/api/tunnel/client.tar.gz'));
      assert.ok(html.includes('/tun/dashboard'), 'dashboard button links');
      assert.ok(html.includes('/llms.txt') && html.includes('/llms-full.txt'), 'footer links the text variants');
    } finally {
      await app.close();
    }
  });

  test('GET /docs/tunnel.md serves the guide as markdown', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/docs/tunnel.md`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/markdown/);
      const md = await res.text();
      assert.ok(md.includes('## Quick start'));
      assert.ok(md.includes('POST /api/tunnel/register'));
      assert.ok(md.includes('tun start'));
      assert.match(res.headers.get('cache-control'), /max-age=300/);
    } finally {
      await app.close();
    }
  });

  test('GET /llms.txt is an llms.txt index with Docs and API sections', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/llms.txt`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/plain/);
      const txt = await res.text();
      assert.ok(txt.startsWith('# Pips Tunnel'));
      assert.ok(txt.includes('## Docs') && txt.includes('## API'));
      const bullets = txt.split('\n').filter((l) => l.startsWith('- '));
      assert.ok(bullets.length >= 10, `expected >=10 bullets, got ${bullets.length}`);
      assert.ok(txt.includes('/docs/tunnel.md') && txt.includes('/api/tunnel/client.tar.gz'));
      assert.ok(txt.includes(`${app.base.replace('http://', 'http://')}`) || txt.includes('/tun/dashboard'));
    } finally {
      await app.close();
    }
  });

  test('GET /llms-full.txt embeds the entire guide as plain markdown', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/llms-full.txt`);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type'), /text\/plain/);
      const txt = await res.text();
      assert.ok(txt.startsWith('# Pips Tunnel'));
      assert.ok(txt.includes('# Pips Tunnel — Full guide'));
      assert.ok(txt.includes('## HTTP API reference'));
      assert.ok(txt.includes('/api/tunnel/claim'));
    } finally {
      await app.close();
    }
  });
});

describe('tunnel guide content accuracy (module-level)', () => {
  const md = () => tunnelDocs.guideMarkdown();

  test('every tunnel endpoint path appears in the guide', () => {
    const endpoints = [
      'POST /api/tunnel/register',
      'GET /api/tunnel/poll',
      'POST /api/tunnel/respond',
      'POST /api/tunnel/close',
      'GET /api/tunnel/list',
      'GET /api/tunnel/stats',
      'POST /api/tunnel/account',
      'GET /api/tunnel/whoami',
      'GET /api/tunnel/tokens',
      'POST /api/tunnel/tokens',
      'DELETE /api/tunnel/tokens/:id',
      'POST /api/tunnel/claim',
      'POST /api/tunnel/release',
      'GET /tun/dashboard',
      'GET /tun/<name>',
      'GET /api/tunnel/client.tar.gz',
      'GET /tunnel.sh',
    ];
    const guide = md();
    for (const ep of endpoints) assert.ok(guide.includes(ep), `missing endpoint: ${ep}`);
    assert.equal(tunnelDocs.GUIDE.length, 14);
  });

  test('error codes, CLI commands and env knobs appear in the guide', () => {
    const guide = md();
    for (const code of ['INVALID_NAME', 'NAME_TAKEN', 'NAME_RESERVED', 'TUNNEL_LIMIT', 'TUNNEL_REPLACED', 'TUNNEL_OFFLINE', 'TUNNEL_BUSY', 'TUNNEL_TIMEOUT', 'PAYLOAD_TOO_LARGE', 'BUNDLE_MISSING']) {
      assert.ok(guide.includes(code), `missing error code: ${code}`);
    }
    for (const knob of ['TUNNEL_MAX_TUNNELS', 'TUNNEL_TTL_MS', 'TUNNEL_WAIT_MS', 'TUNNEL_POLL_WAIT_MS', 'TUNNEL_MAX_QUEUE', 'TUNNEL_SAVE_MS']) {
      assert.ok(guide.includes(knob), `missing env knob: ${knob}`);
    }
    for (const cmd of ['tun start', 'tun login', 'tun list', 'tun close', '--server', '--help', '--version']) {
      assert.ok(guide.includes(cmd), `missing CLI command: ${cmd}`);
    }
  });
});

describe('tunnel docs markdown renderer (unit)', () => {
  test('headings get slug ids and duplicates are deduped', () => {
    const html = tunnelDocs.renderMarkdown('# Top\n\n## My Section!\n\n## My Section!\n\n## My Section!');
    assert.match(html, /<h1 id="top">Top<\/h1>/);
    assert.match(html, /<h2 id="my-section">/);
    assert.match(html, /<h2 id="my-section-2">/);
    assert.match(html, /<h2 id="my-section-3">/);
  });

  test('tables, lists, rules and paragraphs render', () => {
    const html = tunnelDocs.renderMarkdown(
      '| Code | HTTP |\n| --- | --- |\n| `TUNNEL_BUSY` | 503 |\n\n- one\n- two\n\n1. first\n2. second\n\n---\n\nplain **bold** and `code` and [link](/docs/tunnel)',
    );
    assert.match(html, /<table><thead><tr><th>Code<\/th><th>HTTP<\/th><\/tr><\/thead><tbody><tr><td><code>TUNNEL_BUSY<\/code><\/td><td>503<\/td><\/tr><\/tbody><\/table>/);
    assert.match(html, /<ul><li>one<\/li><li>two<\/li><\/ul>/);
    assert.match(html, /<ol><li>first<\/li><li>second<\/li><\/ol>/);
    assert.match(html, /<hr>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<a href="\/docs\/tunnel">link<\/a>/);
  });

  test('HTML in markdown text is escaped before inline transforms', () => {
    const html = tunnelDocs.renderMarkdown('hello <script>alert(1)</script> world');
    assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
    assert.ok(!html.includes('<script>'));
    const fenced = tunnelDocs.renderMarkdown('```html\n<b>&x</b>\n```');
    assert.ok(fenced.includes('&lt;b&gt;&amp;x&lt;/b&gt;'));
    assert.match(fenced, /<pre><code class="language-html">/);
  });
});

describe('tunnel docs cross-links', () => {
  test('the /tun landing links to the full guide and llms.txt', async () => {
    const app = await startServer({ env: TEST_ENV });
    try {
      const res = await fetch(`${app.base}/tun`);
      assert.equal(res.status, 200);
      const html = await res.text();
      assert.ok(html.includes('/docs/tunnel'));
      assert.ok(html.includes('/llms.txt'));
    } finally {
      await app.close();
    }
  });
});
