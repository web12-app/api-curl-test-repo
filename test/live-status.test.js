const test = require('node:test');
const assert = require('node:assert/strict');
const helpers = require('./helpers.js');

async function status(env) {
  const app = await helpers.startServer({ env: { ...(helpers.TEST_ENV || {}), ...env } });
  try {
    const res = await fetch(`${app.base}/api/live-status`);
    return { code: res.status, body: await res.json(), base: app.base };
  } finally {
    await app.close();
  }
}

test('GET /api/live-status is public, reports live, and has no URL when run locally', async () => {
  const { code, body } = await status({ PUBLIC_URL: '', LIVE_RUN_ID: '' });
  assert.equal(code, 200);
  assert.equal(body.status, 'live');
  assert.equal(body.url, null);
  assert.equal(body.runId, null);
  assert.ok(Number.isInteger(body.uptimeSeconds) && body.uptimeSeconds >= 0);
  assert.ok(!Number.isNaN(Date.parse(body.startedAt)));
  assert.ok(!Number.isNaN(Date.parse(body.checkedAt)));
});

test('reports the run URL and run number set by the live-tunnel workflow', async () => {
  const { body } = await status({
    PUBLIC_URL: 'https://challenging-rod-hundred-closes.trycloudflare.com',
    LIVE_RUN_ID: '38903060939',
  });
  assert.equal(body.url, 'https://challenging-rod-hundred-closes.trycloudflare.com');
  assert.equal(body.runId, '38903060939');
});

test('refuses a PUBLIC_URL that is not a bare https origin', async () => {
  for (const bad of ['javascript:alert(1)', 'http://insecure.example', 'https://x.example/path', 'https://x.example/?q=1']) {
    const { body } = await status({ PUBLIC_URL: bad });
    assert.equal(body.url, null, bad);
  }
});

test('keeps only digits in the run number', async () => {
  const { body } = await status({ LIVE_RUN_ID: '12<script>3' });
  assert.equal(body.runId, '123');
});

test('the client bundle calls the live status endpoint and the shell ships its styles', async () => {
  const app = await helpers.startServer({ env: helpers.TEST_ENV || {} });
  try {
    const js = await (await fetch(`${app.base}/assets/app.js`)).text();
    assert.ok(js.includes('/api/live-status'), 'Home polls the live status endpoint');
    assert.ok(js.includes('live-card'), 'Home renders the live card');
  } finally {
    await app.close();
  }
});
