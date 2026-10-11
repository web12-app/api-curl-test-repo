'use strict';

// URL import, end to end through the API. The origin is a local HTTP server; names resolve through a fake table;
// the transport reaches the origin in place of the checked address. The validation, redirect, limit, timeout,
// and cleanup code under test is the real code.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { startFake, withApp, signup, authed, json, startOrigin, fakeDns, originTransport, waitForImport, startImport, tempFiles, storedAssets, listFiles, downloadFile, MB } = require('./files-fixture');

const PUBLIC_IP = '93.184.216.34';
const CDN_IP = '151.101.1.1';
const HOST = 'files.example.test';

let fake;
before(async () => {
  fake = await startFake();
});
beforeEach(() => fake.reset());
after(async () => {
  await fake.close();
});

const pdfBytes = (n = 2000) => Buffer.concat([Buffer.from('%PDF-1.4\n'), crypto.randomBytes(n)]);
const send = (res, status, headers, body) => {
  res.writeHead(status, headers);
  res.end(body);
};
const ok200 = (res, body, headers = {}) => send(res, 200, { 'Content-Type': 'application/octet-stream', ...headers }, body);

// Runs fn with an origin serving `routes` (path -> handler), a fake DNS table, and an app that uses both.
async function withImports({ routes = {}, dns, timeouts, importLimits, lookup } = {}, fn) {
  const origin = await startOrigin((req, res) => {
    const path = req.url.split('?')[0];
    const handler = routes[path];
    if (!handler) return send(res, 404, { 'Content-Type': 'text/plain' }, 'not here');
    return handler(req, res);
  });
  const table = { [HOST]: [PUBLIC_IP], 'cdn.example.test': [CDN_IP], 'intranet.example.test': ['10.0.0.5'], ...(dns || {}) };
  const dnsFake = lookup ? { lookup, lookups: [] } : fakeDns(table);
  const { transport, hops } = originTransport(origin.port);
  try {
    await withApp(fake, { urlImport: { lookup: dnsFake.lookup, transport, timeouts }, importLimits }, async (app) => {
      await fn({ app, origin, hops, dns: dnsFake });
    });
  } finally {
    await origin.close();
  }
}

// Waits until the origin has no open connections. Used to show that a cancelled download closed its connection.
async function waitForClosed(origin, timeoutMs = 3000) {
  const until = Date.now() + timeoutMs;
  while (origin.openSockets() > 0 && Date.now() < until) await new Promise((r) => setTimeout(r, 15));
  return origin.openSockets();
}

// ---- the happy path

test('an https link is imported in the background, stored once, and its bytes match', async () => {
  const pdf = pdfBytes();
  await withImports(
    {
      routes: {
        '/files/report.pdf': (req, res) =>
          ok200(res, pdf, { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length), 'Content-Disposition': 'attachment; filename="Q3 report.pdf"' }),
      },
    },
    async ({ app, origin, hops }) => {
      const user = await signup(app);
      const started = await startImport(app, user.cookie, `https://${HOST}/files/report.pdf`);
      assert.equal(started.status, 202, 'the job starts in the background');
      const done = await waitForImport(app, user.cookie, started.uploadId);
      assert.equal(done.state, 'completed');
      assert.equal(done.name, 'Q3 report.pdf');
      assert.equal(done.size, pdf.length);

      const files = await listFiles(app, user.cookie);
      assert.equal(files.files.length, 1);
      assert.equal(files.files[0].name, 'Q3 report.pdf');
      const { bytes } = await downloadFile(app, user.cookie, files.files[0].id);
      assert.ok(bytes.equals(pdf));
      assert.equal(storedAssets(fake).length, 1);

      // The connection used exactly the address the check accepted.
      assert.deepEqual(hops[0].addresses, [PUBLIC_IP]);
      // The origin receives only the fixed headers. No cookie, session, or client header is forwarded.
      const seen = origin.requests[0].headers;
      for (const h of ['cookie', 'authorization', 'x-requested-with', 'origin', 'referer']) {
        assert.equal(seen[h], undefined, `${h} is not forwarded`);
      }
      assert.equal(seen['accept-encoding'], 'identity');
      assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.endsWith('.part')), [], 'no temp file is left');
    },
  );
});

test('the name in Content-Disposition is cleaned, and a name from the URL path is used when there is none', async () => {
  const body = Buffer.from('plain text file\n');
  await withImports(
    {
      routes: {
        '/rates': (req, res) => ok200(res, body, { 'Content-Disposition': "attachment; filename*=UTF-8''%E2%82%AC%20rates.txt" }),
        '/dir/evil.txt': (req, res) => ok200(res, body, { 'Content-Disposition': 'attachment; filename="../../etc/passwd.txt"' }),
        '/data/Final%20Plan.txt': (req, res) => ok200(res, body),
      },
    },
    async ({ app }) => {
      const user = await signup(app);
      for (const url of [`https://${HOST}/rates`, `https://${HOST}/data/Final%20Plan.txt`, `https://${HOST}/dir/evil.txt`]) {
        const started = await startImport(app, user.cookie, url);
        assert.equal((await waitForImport(app, user.cookie, started.uploadId)).state, 'completed', url);
      }
      // A name with a path in it is cut to its last part, so the stored names are these three.
      const names = (await listFiles(app, user.cookie)).files.map((f) => f.name).sort();
      assert.deepEqual(names, ['Final Plan.txt', 'passwd.txt', '€ rates.txt']);
    },
  );
});

test('a file with no usable name is refused, and a file whose bytes do not match its type is refused', async () => {
  await withImports(
    {
      routes: {
        '/': (req, res) => ok200(res, Buffer.from('bare\n')),
        '/fake.pdf': (req, res) => ok200(res, Buffer.from('definitely not a pdf')),
        '/empty.txt': (req, res) => ok200(res, Buffer.alloc(0)),
      },
    },
    async ({ app }) => {
      const user = await signup(app);
      const noName = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/`)).uploadId);
      assert.equal(noName.state, 'failed');
      assert.equal(noName.error.code, 'INVALID_FILENAME');

      const wrongType = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/fake.pdf`)).uploadId);
      assert.equal(wrongType.error.code, 'FILE_CONTENT_MISMATCH');

      const empty = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/empty.txt`)).uploadId);
      assert.equal(empty.error.code, 'EMPTY_FILE');

      assert.equal((await listFiles(app, user.cookie)).files.length, 0);
      assert.equal(storedAssets(fake).length, 0);
    },
  );
});

test('a file type the app does not know is stored as an attachment only', async () => {
  const bytes = crypto.randomBytes(300);
  await withImports({ routes: { '/blob.zzq': (req, res) => ok200(res, bytes) } }, async ({ app }) => {
    const user = await signup(app);
    const started = await startImport(app, user.cookie, `https://${HOST}/blob.zzq`);
    assert.equal((await waitForImport(app, user.cookie, started.uploadId)).state, 'completed');
    const file = (await listFiles(app, user.cookie)).files[0];
    assert.equal(file.previewable, false);
    const res = await authed(app, user.cookie, `/api/files/${file.id}/download`);
    assert.match(res.headers.get('content-disposition'), /^attachment/);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
  });
});

// ---- the origin's answer

test('only a 200 answer is imported; other answers and errors are reported with their status', async () => {
  await withImports(
    {
      routes: {
        '/gone': (req, res) => send(res, 404, { 'Content-Type': 'text/plain' }, 'missing'),
        '/boom': (req, res) => send(res, 500, { 'Content-Type': 'text/plain' }, 'bad'),
        '/partial': (req, res) => send(res, 206, { 'Content-Type': 'application/pdf' }, pdfBytes(100)),
      },
    },
    async ({ app }) => {
      const user = await signup(app);
      const gone = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/gone`)).uploadId);
      assert.equal(gone.error.code, 'IMPORT_UPSTREAM_STATUS');
      assert.match(gone.error.message, /404/);
      const boom = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/boom`)).uploadId);
      assert.match(boom.error.message, /500/);
      const partial = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/partial`)).uploadId);
      assert.equal(partial.error.code, 'IMPORT_UPSTREAM_STATUS', '206 is not a whole file');
      assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    },
  );
});

test('a compressed response is refused, because the size limit counts the bytes as they are stored', async () => {
  await withImports(
    { routes: { '/z.txt': (req, res) => ok200(res, Buffer.from('zip'), { 'Content-Encoding': 'gzip' }) } },
    async ({ app }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/z.txt`)).uploadId);
      assert.equal(job.error.code, 'IMPORT_UNSUPPORTED_ENCODING');
    },
  );
});

test('a Content-Length above the limit is refused before the body is read', async () => {
  await withImports(
    {
      routes: {
        '/huge.pdf': (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': String(25 * MB + 1) });
          res.write('%PDF-');
          res.on('error', () => {});
          res.socket.on('error', () => {});
        },
      },
    },
    async ({ app, origin }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/huge.pdf`)).uploadId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'FILE_TOO_LARGE');
      assert.equal(await waitForClosed(origin), 0, 'the connection is closed');
      assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.endsWith('.part')), []);
    },
  );
});

test('the size limit holds while streaming, even when no length is declared', async () => {
  await withImports(
    {
      routes: {
        '/stream.pdf': (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/pdf' }); // no Content-Length: chunked
          res.on('error', () => {});
          res.socket.on('error', () => {});
          const block = Buffer.alloc(MB, 0x20);
          let sent = 0;
          const pump = () => {
            while (sent < 27) {
              sent += 1;
              if (!res.write(block)) return void res.once('drain', pump);
            }
            res.end();
          };
          res.write('%PDF-1.4\n');
          pump();
        },
      },
    },
    async ({ app }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/stream.pdf`)).uploadId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'FILE_TOO_LARGE');
      assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.endsWith('.part')), [], 'the partial file is removed');
      assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    },
  );
});

test('a file of exactly 25 MB is imported, and the limit is not raised', async () => {
  const big = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(25 * MB - 9, 0x41)]);
  assert.equal(big.length, 25 * MB);
  await withImports({ routes: { '/big.pdf': (req, res) => ok200(res, big, { 'Content-Type': 'application/pdf', 'Content-Length': String(big.length) }) } }, async ({ app }) => {
    const user = await signup(app);
    const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/big.pdf`)).uploadId, { timeoutMs: 20000 });
    assert.equal(job.state, 'completed');
    assert.equal(job.size, 25 * MB);
  });
});

test('a body shorter than its declared length is reported as interrupted, and nothing is stored', async () => {
  await withImports(
    {
      routes: {
        '/short.pdf': (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': '1000' });
          res.end(pdfBytes(100));
        },
      },
    },
    async ({ app }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/short.pdf`)).uploadId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'IMPORT_INTERRUPTED');
      assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    },
  );
});

test('a malformed Content-Length is refused by the HTTP parser, and nothing is stored', async () => {
  const pdf = pdfBytes(500);
  await withImports(
    {
      routes: {
        '/odd.pdf': (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': 'twelve' });
          res.end(pdf);
        },
      },
    },
    async ({ app }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/odd.pdf`)).uploadId);
      assert.equal(job.state, 'failed');
      assert.equal(job.error.code, 'IMPORT_UPSTREAM_ERROR');
      assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    },
  );
});

test('a chunked answer with no Content-Length is imported, and the streaming limit applies to it', async () => {
  const pdf = pdfBytes(500);
  await withImports(
    { routes: { '/chunked.pdf': (req, res) => { res.writeHead(200, { 'Content-Type': 'application/pdf' }); res.end(pdf); } } },
    async ({ app }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/chunked.pdf`)).uploadId);
      assert.equal(job.state, 'completed');
      assert.equal(job.size, pdf.length);
    },
  );
});

// ---- redirects

test('a redirect is followed, and the new host is checked and resolved before it is used', async () => {
  const pdf = pdfBytes();
  await withImports(
    {
      routes: {
        '/start': (req, res) => send(res, 302, { Location: 'https://cdn.example.test/files/final.pdf' }, ''),
        '/files/final.pdf': (req, res) => ok200(res, pdf, { 'Content-Type': 'application/pdf' }),
      },
    },
    async ({ app, hops, dns }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/start`)).uploadId);
      assert.equal(job.state, 'completed');
      assert.deepEqual(hops.map((h) => h.host), [HOST, 'cdn.example.test']);
      assert.deepEqual(hops[1].addresses, [CDN_IP]);
      assert.ok(dns.lookups.includes('cdn.example.test'));
    },
  );
});

test('up to three redirects are followed; a fourth is refused', async () => {
  const hop = (next) => (req, res) => send(res, 302, { Location: next }, '');
  await withImports(
    {
      routes: {
        '/r1': hop('/r2'),
        '/r2': hop('/r3'),
        '/r3': hop('/files/ok.txt'),
        '/files/ok.txt': (req, res) => ok200(res, Buffer.from('three hops\n')),
        '/loop/a': hop('/loop/b'),
        '/loop/b': hop('/loop/c'),
        '/loop/c': hop('/loop/d'),
        '/loop/d': hop('/loop/e'),
        '/loop/e': (req, res) => ok200(res, Buffer.from('never\n')),
      },
    },
    async ({ app, origin }) => {
      const user = await signup(app);
      assert.equal((await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/r1`)).uploadId)).state, 'completed');

      const before = origin.requests.length;
      const looped = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/loop/a`)).uploadId);
      assert.equal(looped.state, 'failed');
      assert.equal(looped.error.code, 'IMPORT_TOO_MANY_REDIRECTS');
      assert.equal(origin.requests.length - before, 4, 'three redirects followed, the fourth refused');
    },
  );
});

test('a redirect to plain http, to a private network, or to an address literal is refused without connecting', async () => {
  await withImports(
    {
      routes: {
        '/to-http': (req, res) => send(res, 302, { Location: `http://${HOST}/x.txt` }, ''),
        '/to-intranet': (req, res) => send(res, 302, { Location: 'https://intranet.example.test/x.txt' }, ''),
        '/to-metadata': (req, res) => send(res, 302, { Location: 'https://169.254.169.254/latest/meta-data' }, ''),
        '/to-localhost': (req, res) => send(res, 302, { Location: 'https://localhost/admin' }, ''),
        '/no-location': (req, res) => send(res, 302, {}, ''),
        '/to-port': (req, res) => send(res, 302, { Location: `https://${HOST}:8443/x` }, ''),
      },
    },
    async ({ app, origin, hops }) => {
      const user = await signup(app);
      const expect = {
        '/to-http': 'IMPORT_INVALID_URL',
        '/to-intranet': 'IMPORT_BLOCKED_DESTINATION',
        '/to-metadata': 'IMPORT_BLOCKED_DESTINATION',
        '/to-localhost': 'IMPORT_BLOCKED_DESTINATION',
        '/no-location': 'IMPORT_BAD_REDIRECT',
        '/to-port': 'IMPORT_INVALID_URL',
      };
      for (const [p, code] of Object.entries(expect)) {
        const before = origin.requests.length;
        const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}${p}`)).uploadId);
        assert.equal(job.state, 'failed', p);
        assert.equal(job.error.code, code, p);
        // Only the first hop, to the public origin, ever connected. The refused targets were never contacted.
        assert.equal(origin.requests.length - before, 1, `${p} made one connection`);
      }
      assert.ok(hops.every((h) => h.host === HOST), 'no connection went to another name');
    },
  );
});

// ---- DNS

test('a name with any private address in its answer is refused, and the origin is never contacted', async () => {
  await withImports(
    { dns: { 'mixed.example.test': [PUBLIC_IP, '10.1.1.1'], 'loop.example.test': ['127.0.0.1'] }, routes: { '/x.txt': (req, res) => ok200(res, Buffer.from('x\n')) } },
    async ({ app, origin }) => {
      const user = await signup(app);
      for (const host of ['mixed.example.test', 'loop.example.test']) {
        const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${host}/x.txt`)).uploadId);
        assert.equal(job.error.code, 'IMPORT_BLOCKED_DESTINATION', host);
      }
      assert.equal(origin.requests.length, 0);
    },
  );
});

test('a name that does not resolve is reported as a DNS failure', async () => {
  await withImports({ routes: {} }, async ({ app }) => {
    const user = await signup(app);
    const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, 'https://nowhere.example.test/x.pdf')).uploadId);
    assert.equal(job.error.code, 'IMPORT_DNS_FAILED');
  });
});

test('DNS rebinding: a name that would answer with a private address on a second lookup is still used only at its checked address', async () => {
  let calls = 0;
  const rebinding = async () => {
    calls += 1;
    return calls === 1 ? [{ address: PUBLIC_IP, family: 4 }] : [{ address: '127.0.0.1', family: 4 }];
  };
  await withImports(
    { lookup: rebinding, routes: { '/r.txt': (req, res) => ok200(res, Buffer.from('rebind-proof\n')) } },
    async ({ app, hops }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/r.txt`)).uploadId);
      assert.equal(job.state, 'completed');
      assert.equal(calls, 1, 'the name is resolved once for the hop');
      assert.deepEqual(hops[0].addresses, [PUBLIC_IP]);
    },
  );
});

// ---- timeouts, cancel, and cleanup

test('an origin that never answers is stopped by the total time limit', async () => {
  await withImports({ timeouts: { totalTimeoutMs: 300 }, routes: { '/slow.pdf': () => {} } }, async ({ app, origin }) => {
    const user = await signup(app);
    const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/slow.pdf`)).uploadId);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'IMPORT_TIMEOUT');
    assert.equal(await waitForClosed(origin), 0, 'the connection is closed');
  });
});

test('an origin that goes silent mid-body is stopped by the idle time limit', async () => {
  await withImports(
    {
      timeouts: { idleTimeoutMs: 200, totalTimeoutMs: 10000 },
      routes: {
        '/stalls.pdf': (req, res) => {
          res.writeHead(200, { 'Content-Type': 'application/pdf', 'Content-Length': '100000' });
          res.write(pdfBytes(100));
        },
      },
    },
    async ({ app, origin }) => {
      const user = await signup(app);
      const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/stalls.pdf`)).uploadId);
      assert.equal(job.error.code, 'IMPORT_TIMEOUT');
      assert.equal(await waitForClosed(origin), 0);
      assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.endsWith('.part')), []);
    },
  );
});

test('a running import can be cancelled: the connection closes, the temp file is removed, and the state says so', async () => {
  await withImports({ routes: { '/hang.pdf': () => {} } }, async ({ app, origin }) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    await startImport(app, user.cookie, `https://${HOST}/hang.pdf`, uploadId);

    const cancelled = await authed(app, user.cookie, `/api/files/upload-from-url/${uploadId}`, { method: 'DELETE' }).then(json);
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.data.import.state, 'cancelled');

    assert.equal(await waitForClosed(origin), 0, 'the origin connection is closed');
    const status = await authed(app, user.cookie, `/api/files/upload-from-url/${uploadId}`).then(json);
    assert.equal(status.body.data.import.state, 'cancelled');
    assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    assert.equal(storedAssets(fake).length, 0);
    assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.endsWith('.part')), []);

    // Cancelling again is harmless.
    const again = await authed(app, user.cookie, `/api/files/upload-from-url/${uploadId}`, { method: 'DELETE' }).then(json);
    assert.equal(again.status, 200);
  });
});

test('a finished import cannot be cancelled', async () => {
  await withImports({ routes: { '/ok.txt': (req, res) => ok200(res, Buffer.from('done\n')) } }, async ({ app }) => {
    const user = await signup(app);
    const started = await startImport(app, user.cookie, `https://${HOST}/ok.txt`);
    await waitForImport(app, user.cookie, started.uploadId);
    const res = await authed(app, user.cookie, `/api/files/upload-from-url/${started.uploadId}`, { method: 'DELETE' }).then(json);
    assert.equal(res.status, 409);
    assert.equal(res.body.error.code, 'IMPORT_ALREADY_DONE');
  });
});

// ---- starting, repeating, and limits

test('the same upload id while an import runs returns that job, and starts no second download', async () => {
  await withImports({ routes: { '/hang.pdf': () => {} } }, async ({ app, origin }) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    const first = await startImport(app, user.cookie, `https://${HOST}/hang.pdf`, uploadId);
    const second = await startImport(app, user.cookie, `https://${HOST}/hang.pdf`, uploadId);
    assert.equal(second.status, 202);
    assert.equal(second.body.data.import.id, first.body.data.import.id);
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(origin.requests.length, 1, 'one download');
    await authed(app, user.cookie, `/api/files/upload-from-url/${uploadId}`, { method: 'DELETE' });
  });
});

test('the same upload id after a finished import returns the file, and stores nothing new', async () => {
  await withImports({ routes: { '/once.txt': (req, res) => ok200(res, Buffer.from('once\n')) } }, async ({ app, origin }) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    const first = await startImport(app, user.cookie, `https://${HOST}/once.txt`, uploadId);
    const done = await waitForImport(app, user.cookie, uploadId);
    const again = await startImport(app, user.cookie, `https://${HOST}/once.txt`, uploadId);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.import.state, 'completed');
    assert.equal(again.body.data.import.file.id, done.file.id);
    assert.equal(origin.requests.length, 1, 'no second download');
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
    assert.ok(first.body.data.import);
  });
});

test('an account runs one import at a time, and the server runs three', async () => {
  await withImports({ importLimits: { maxConcurrentPerUser: 1 }, routes: { '/hang.pdf': () => {} } }, async ({ app }) => {
    const user = await signup(app);
    const a = crypto.randomUUID();
    assert.equal((await startImport(app, user.cookie, `https://${HOST}/hang.pdf`, a)).status, 202);
    const b = await startImport(app, user.cookie, `https://${HOST}/hang.pdf`);
    assert.equal(b.status, 429);
    assert.equal(b.body.error.code, 'IMPORT_BUSY');
    await authed(app, user.cookie, `/api/files/upload-from-url/${a}`, { method: 'DELETE' });
  });
  await withImports({ importLimits: { maxConcurrentImports: 1 }, routes: { '/hang.pdf': () => {} } }, async ({ app }) => {
    const one = await signup(app);
    const two = await signup(app);
    assert.equal((await startImport(app, one.cookie, `https://${HOST}/hang.pdf`)).status, 202);
    assert.equal((await startImport(app, two.cookie, `https://${HOST}/hang.pdf`)).status, 429);
  });
});

test('imports are limited per account per hour', async () => {
  await withImports({ importLimits: { importsPerHour: 2 }, routes: { '/ok.txt': (req, res) => ok200(res, Buffer.from('ok\n')) } }, async ({ app }) => {
    const user = await signup(app);
    for (let i = 0; i < 2; i += 1) {
      const started = await startImport(app, user.cookie, `https://${HOST}/ok.txt`);
      await waitForImport(app, user.cookie, started.uploadId);
    }
    const third = await startImport(app, user.cookie, `https://${HOST}/ok.txt`);
    assert.equal(third.status, 429);
    assert.equal(third.body.error.code, 'RATE_LIMITED');
  });
});

test('a failed storage call fails the import, leaves nothing behind, and says it is a storage problem', async () => {
  await withImports({ routes: { '/store.txt': (req, res) => ok200(res, Buffer.from('store me\n')) } }, async ({ app }) => {
    const user = await signup(app);
    fake.fault('POST', /^\/uploads\/repos\//, 500, { times: 1 });
    const job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, `https://${HOST}/store.txt`)).uploadId);
    assert.equal(job.state, 'failed');
    assert.equal(job.error.code, 'IMPORT_STORAGE_FAILED');
    assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    assert.equal(fake.releases.size, 0, 'the empty release was removed');
    assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.endsWith('.part')), []);
  });
});

// ---- validation and access

test('links that are not allowed are refused at once, with no connection and no lookup', async () => {
  await withImports({ routes: {} }, async ({ app, origin, dns }) => {
    const user = await signup(app);
    const refused = {
      'http://files.example.test/x.pdf': 'IMPORT_INVALID_URL',
      'https://user:pw@files.example.test/x.pdf': 'IMPORT_INVALID_URL',
      'https://files.example.test:8443/x.pdf': 'IMPORT_INVALID_URL',
      'https://localhost/x.pdf': 'IMPORT_BLOCKED_DESTINATION',
      'https://127.0.0.1/x.pdf': 'IMPORT_BLOCKED_DESTINATION',
      'https://[::1]/x.pdf': 'IMPORT_BLOCKED_DESTINATION',
      'https://192.168.1.1/x.pdf': 'IMPORT_BLOCKED_DESTINATION',
      'https://metadata.google.internal/x': 'IMPORT_BLOCKED_DESTINATION',
      'ftp://files.example.test/x.pdf': 'IMPORT_INVALID_URL',
    };
    for (const [url, code] of Object.entries(refused)) {
      const res = await startImport(app, user.cookie, url);
      assert.equal(res.status, 400, url);
      assert.equal(res.body.error.code, code, url);
    }
    assert.equal(origin.requests.length, 0);
    assert.equal(dns.lookups.length, 0, 'no name was looked up');
  });
});

test('a request with a bad body, a bad upload id, or an unknown id is refused in the usual way', async () => {
  await withImports({ routes: {} }, async ({ app }) => {
    const user = await signup(app);
    const noUrl = await authed(app, user.cookie, '/api/files/upload-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ uploadId: crypto.randomUUID() }),
    }).then(json);
    assert.equal(noUrl.status, 400);
    assert.equal(noUrl.body.error.code, 'IMPORT_INVALID_URL');

    const numeric = await startImport(app, user.cookie, 42);
    assert.equal(numeric.status, 400);

    const badId = await startImport(app, user.cookie, `https://${HOST}/x.pdf`, 'nope');
    assert.equal(badId.body.error.code, 'INVALID_UPLOAD_ID');

    const unknown = await authed(app, user.cookie, `/api/files/upload-from-url/${crypto.randomUUID()}`).then(json);
    assert.equal(unknown.status, 404);
    const malformed = await authed(app, user.cookie, '/api/files/upload-from-url/not-a-uuid').then(json);
    assert.equal(malformed.status, 404);
  });
});

test('authentication, the CSRF header, and the Origin check apply to the import routes', async () => {
  await withImports({ routes: { '/hang.pdf': () => {} } }, async ({ app }) => {
    const user = await signup(app);
    const body = JSON.stringify({ url: `https://${HOST}/hang.pdf`, uploadId: crypto.randomUUID() });
    const anon = await fetch(`${app.base}/api/files/upload-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Origin: app.base },
      body,
    });
    assert.equal(anon.status, 401);

    const noCsrf = await fetch(`${app.base}/api/files/upload-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user.cookie, Origin: app.base },
      body,
    });
    assert.equal(noCsrf.status, 403);

    const cross = await fetch(`${app.base}/api/files/upload-from-url`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Cookie: user.cookie, 'X-Requested-With': 'fetch', Origin: 'https://evil.example' },
      body,
    });
    assert.equal(cross.status, 403);
  });
});

test('another account cannot see or cancel an import', async () => {
  await withImports({ routes: { '/hang.pdf': () => {} } }, async ({ app }) => {
    const owner = await signup(app);
    const other = await signup(app);
    const uploadId = crypto.randomUUID();
    await startImport(app, owner.cookie, `https://${HOST}/hang.pdf`, uploadId);
    assert.equal((await authed(app, other.cookie, `/api/files/upload-from-url/${uploadId}`).then(json)).status, 404);
    assert.equal((await authed(app, other.cookie, `/api/files/upload-from-url/${uploadId}`, { method: 'DELETE' }).then(json)).status, 404);
    assert.equal((await authed(app, owner.cookie, `/api/files/upload-from-url/${uploadId}`, { method: 'DELETE' }).then(json)).status, 200);
  });
});

test('logs and stored records hold no link, host, or path, and the name is masked', async () => {
  const secretPath = '/private/Acme-board-minutes.pdf';
  const url = `https://${HOST}${secretPath}?token=SECRET-ABC123`;
  await withImports({ routes: { [secretPath]: (req, res) => ok200(res, pdfBytes(), { 'Content-Type': 'application/pdf' }) } }, async ({ app }) => {
    const user = await signup(app);
    const lines = [];
    const saved = { log: console.log, error: console.error };
    console.log = (...a) => lines.push(a.join(' '));
    console.error = (...a) => lines.push(a.join(' '));
    let job;
    try {
      job = await waitForImport(app, user.cookie, (await startImport(app, user.cookie, url)).uploadId);
    } finally {
      Object.assign(console, saved);
    }
    assert.equal(job.state, 'completed');
    const logs = lines.join('\n');
    assert.match(logs, /import started: job=[0-9a-f]{8} source=[0-9a-f]{12}/);
    assert.match(logs, /import finished: job=[0-9a-f]{8} file=A….pdf state=completed/);
    for (const secret of ['SECRET-ABC123', HOST, 'private', 'Acme', 'board', user.userId]) {
      assert.ok(!logs.includes(secret), `logs do not contain ${secret}`);
    }
    // The link is not kept in any stored record.
    assert.ok(!JSON.stringify([...fake.contents.values()]).includes('SECRET-ABC123'));
    assert.ok(!JSON.stringify(await listFiles(app, user.cookie)).includes(HOST));
  });
});

test('the existing whole-file upload still works next to imports', async () => {
  await withImports({ routes: {} }, async ({ app }) => {
    const user = await signup(app);
    const form = new FormData();
    form.append('uploadId', crypto.randomUUID());
    form.append('file', new Blob([Buffer.from('plain\n')], { type: 'text/plain' }), 'plain.txt');
    const res = await authed(app, user.cookie, '/api/files/upload', { method: 'POST', body: form });
    assert.equal(res.status, 201);
    assert.ok(fs.existsSync(app.tmpDir));
  });
});

test('two requests for the same import at the same moment start one download', async () => {
  await withImports({ routes: { '/race.txt': (req, res) => ok200(res, Buffer.from('race\n')) } }, async ({ app, origin }) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    const body = JSON.stringify({ url: `https://${HOST}/race.txt`, uploadId });
    const send = () =>
      authed(app, user.cookie, '/api/files/upload-from-url', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body }).then(json);
    const results = await Promise.all([send(), send(), send()]);
    assert.ok(results.every((r) => [200, 202].includes(r.status)), `statuses: ${results.map((r) => r.status)}`);
    assert.equal(new Set(results.map((r) => r.body.data.import.id)).size, 1, 'they share one job');
    assert.equal((await waitForImport(app, user.cookie, uploadId)).state, 'completed');
    assert.equal(origin.requests.length, 1, 'one download');
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
  });
});
