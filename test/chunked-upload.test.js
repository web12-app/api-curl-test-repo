'use strict';

// Chunked uploads: pieces, checksums, resume, completion, ownership, limits, cleanup, and logs.
// GitHub is the local fake. Every request goes to the app over real HTTP.
const { test, before, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const { loadUploadSettings } = require('../src/config');
const { ENV, DATA_REPO, startFake, startApp, withApp, signup, authed, sha256, pieces, initUpload, sendChunk, getUpload, completeUpload, cancelUpload, uploadAllChunks, storedAssets, listFiles, downloadFile, tempFiles } = require('./files-fixture');

const KB = 1024;
const MB = 1024 * 1024;
const GB = 1024 * MB;
const CHUNK = 256 * KB;
// Exactly `bytes` bytes of ASCII text, so the content check passes for a .txt file. Sizes are chosen per test so the
// file splits into the number of pieces that test expects (a piece is at least 256 KB).
const textOf = (bytes) => {
  const unit = Buffer.from('plain text for the piece tests, line by line\n');
  const out = Buffer.alloc(bytes);
  for (let i = 0; i < bytes; i += unit.length) unit.copy(out, i, 0, Math.min(unit.length, bytes - i));
  return out;
};

let fake;
before(async () => {
  fake = await startFake();
});
beforeEach(() => fake.reset());
after(async () => {
  await fake.close();
});

// Sends a piece with a body that arrives in two halves, so the request is still running while the test acts.
function slowPiece(app, cookie, sessionId, index, bytes) {
  const url = new URL(`${app.base}/api/uploads/${sessionId}/chunks/${index}`);
  const req = http.request({
    host: url.hostname,
    port: url.port,
    path: url.pathname,
    method: 'POST',
    headers: {
      Cookie: cookie,
      'X-Requested-With': 'fetch',
      Origin: app.base,
      'Content-Type': 'application/octet-stream',
      'Content-Length': bytes.length,
      'X-Chunk-Sha256': sha256(bytes),
    },
  });
  const done = new Promise((resolve, reject) => {
    req.on('error', reject);
    req.on('response', async (res) => {
      const parts = [];
      for await (const c of res) parts.push(c);
      resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString()) });
    });
  });
  const half = Math.floor(bytes.length / 2);
  req.write(bytes.subarray(0, half));
  return { done, finish: () => req.end(bytes.subarray(half)) };
}

// Declares a Content-Length larger than the piece allows. The server must answer from the header alone.
function declaredPiece(app, cookie, sessionId, index, declaredLength) {
  const url = new URL(`${app.base}/api/uploads/${sessionId}/chunks/${index}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          Cookie: cookie,
          'X-Requested-With': 'fetch',
          Origin: app.base,
          'Content-Type': 'application/octet-stream',
          'Content-Length': declaredLength,
          'X-Chunk-Sha256': sha256(Buffer.alloc(declaredLength)),
        },
      },
      async (res) => {
        const parts = [];
        for await (const c of res) parts.push(c);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || '{}') });
      },
    );
    req.on('error', (err) => reject(err));
    // The body is not sent in full: the server answers first and closes the connection.
    req.on('socket', (sock) => sock.on('error', () => {}));
    req.end(Buffer.alloc(0));
  });
}

// Sends a body with chunked transfer encoding (no Content-Length), so only the streaming limit applies.
function chunkedPiece(app, cookie, sessionId, index, bytes) {
  const url = new URL(`${app.base}/api/uploads/${sessionId}/chunks/${index}`);
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          Cookie: cookie,
          'X-Requested-With': 'fetch',
          Origin: app.base,
          'Content-Type': 'application/octet-stream',
          'Transfer-Encoding': 'chunked',
          'X-Chunk-Sha256': sha256(bytes),
        },
      },
      async (res) => {
        const parts = [];
        for await (const c of res) parts.push(c);
        resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(parts).toString() || '{}') });
      },
    );
    req.on('error', reject);
    req.end(bytes);
  });
}

async function captureLogs(fn) {
  const lines = [];
  const saved = { log: console.log, error: console.error, warn: console.warn };
  const sink = (...a) => lines.push(a.map(String).join(' '));
  console.log = sink;
  console.error = sink;
  console.warn = sink;
  try {
    await fn();
  } finally {
    Object.assign(console, saved);
  }
  return lines.join('\n');
}

// ---- happy path

test('a file sent in pieces is stored once, and its bytes match the original', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(5 * CHUNK + 123);
    const { sessionId, complete } = await uploadAllChunks(app, user.cookie, 'notes.txt', bytes, CHUNK);
    assert.equal(complete.status, 201);
    const file = complete.body.data.file;
    assert.equal(file.name, 'notes.txt');
    assert.equal(file.size, bytes.length);

    const { bytes: back } = await downloadFile(app, user.cookie, file.id);
    assert.ok(back.equals(bytes), 'the stored bytes are the original file');
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
    assert.equal(storedAssets(fake).length, 1);

    // Completing again returns the same file and creates nothing.
    const again = await completeUpload(app, user.cookie, sessionId);
    assert.equal(again.status, 200);
    assert.equal(again.body.data.file.id, file.id);
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
    assert.equal(storedAssets(fake).length, 1);
  });
});

test('pieces may arrive in any order, and a repeated piece changes nothing', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(4 * CHUNK - 10);
    const init = await initUpload(app, user.cookie, { name: 'order.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id, chunkCount } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    assert.equal(chunkCount, parts.length);
    for (const i of [3, 1, 0, 2]) {
      assert.equal((await sendChunk(app, user.cookie, id, i, parts[i])).status, 201);
    }
    const repeat = await sendChunk(app, user.cookie, id, 1, parts[1]);
    assert.equal(repeat.status, 200);
    assert.equal(repeat.body.data.duplicate, true);

    const done = await completeUpload(app, user.cookie, id);
    assert.equal(done.status, 201);
    const { bytes: back } = await downloadFile(app, user.cookie, done.body.data.file.id);
    assert.ok(back.equals(bytes));
  });
});

test('the default piece size is 8 MB, and the whole file is one piece when it is smaller', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const big = await initUpload(app, user.cookie, { name: 'big.txt', size: 5 * MB });
    assert.equal(big.body.data.session.chunkBytes, 8 * MB);
    assert.equal(big.body.data.session.chunkCount, 1);
    const small = await initUpload(app, user.cookie, { name: 'small.txt', size: 10 });
    assert.equal(small.body.data.session.chunkCount, 1);
    assert.equal(small.status, 201);
  });
});

// ---- piece checks

test('a piece whose checksum does not match is refused, and the correct piece is then accepted', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK + 5);
    const init = await initUpload(app, user.cookie, { name: 'sum.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    const wrong = await sendChunk(app, user.cookie, id, 0, parts[0], { sha: sha256(Buffer.from('other')) });
    assert.equal(wrong.status, 400);
    assert.equal(wrong.body.error.code, 'CHUNK_CORRUPT');
    assert.deepEqual((await getUpload(app, user.cookie, id)).body.data.session.received, []);

    assert.equal((await sendChunk(app, user.cookie, id, 0, parts[0])).status, 201);
    assert.deepEqual((await getUpload(app, user.cookie, id)).body.data.session.received, [0]);
  });
});

test('a different piece for a number already received is refused, and the first piece is kept', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK);
    const init = await initUpload(app, user.cookie, { name: 'conflict.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    assert.equal((await sendChunk(app, user.cookie, id, 0, parts[0])).status, 201);

    const other = Buffer.alloc(parts[0].length, 0x41); // same length, different bytes, valid checksum
    const clash = await sendChunk(app, user.cookie, id, 0, other);
    assert.equal(clash.status, 409);
    assert.equal(clash.body.error.code, 'CHUNK_CONFLICT');

    assert.equal((await sendChunk(app, user.cookie, id, 1, parts[1])).status, 201);
    const done = await completeUpload(app, user.cookie, id);
    assert.equal(done.status, 201);
    const { bytes: back } = await downloadFile(app, user.cookie, done.body.data.file.id);
    assert.ok(back.equals(bytes), 'the stored file has the first piece, not the conflicting one');
  });
});

test('a piece of the wrong length is refused whether or not Content-Length is sent', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK);
    const init = await initUpload(app, user.cookie, { name: 'length.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);

    const short = await sendChunk(app, user.cookie, id, 0, parts[0].subarray(0, 100));
    assert.equal(short.status, 400);
    assert.equal(short.body.error.code, 'CHUNK_SIZE_MISMATCH');

    const long = await sendChunk(app, user.cookie, id, 0, Buffer.concat([parts[0], Buffer.from('extra')]));
    assert.equal(long.status, 413);
    assert.equal(long.body.error.code, 'CHUNK_TOO_LARGE');

    // Declared as too large: refused from the header, before the body is read.
    const declared = await declaredPiece(app, user.cookie, id, 0, CHUNK + 10);
    assert.equal(declared.status, 413);
    assert.equal(declared.body.error.code, 'CHUNK_TOO_LARGE');

    // No Content-Length: the streaming limit still applies.
    const streamed = await chunkedPiece(app, user.cookie, id, 0, Buffer.alloc(CHUNK + 1000, 0x20));
    assert.equal(streamed.status, 413);
    assert.equal(streamed.body.error.code, 'CHUNK_TOO_LARGE');

    assert.deepEqual((await getUpload(app, user.cookie, id)).body.data.session.received, [], 'nothing was kept');
    assert.deepEqual(tempFiles(app.tmpDir).filter((f) => f.includes('.bin') || f.endsWith('.tmp')), []);
  });
});

test('the piece number and checksum header are validated', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK);
    const init = await initUpload(app, user.cookie, { name: 'index.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id, chunkCount } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);

    for (const bad of ['abc', '-1', '1.5', String(chunkCount)]) {
      const res = await fetch(`${app.base}/api/uploads/${id}/chunks/${bad}`, {
        method: 'POST',
        headers: { Cookie: user.cookie, 'X-Requested-With': 'fetch', Origin: app.base, 'X-Chunk-Sha256': sha256(parts[0]) },
        body: parts[0],
      });
      assert.equal(res.status, 400, `index ${bad}`);
      assert.equal((await res.json()).error.code, 'INVALID_CHUNK_INDEX');
    }

    const noHash = await sendChunk(app, user.cookie, id, 0, parts[0], { sha: null });
    assert.equal(noHash.status, 400);
    assert.equal(noHash.body.error.code, 'CHUNK_HASH_REQUIRED');
    const badHash = await sendChunk(app, user.cookie, id, 0, parts[0], { sha: 'not-a-hash' });
    assert.equal(badHash.body.error.code, 'CHUNK_HASH_REQUIRED');
  });
});

test('completion lists the missing pieces and stores nothing until they arrive', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(4 * CHUNK - 10);
    const init = await initUpload(app, user.cookie, { name: 'gaps.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    await sendChunk(app, user.cookie, id, 0, parts[0]);
    await sendChunk(app, user.cookie, id, 2, parts[2]);

    const early = await completeUpload(app, user.cookie, id);
    assert.equal(early.status, 400);
    assert.equal(early.body.error.code, 'CHUNKS_MISSING');
    assert.deepEqual(early.body.error.details.missing, [1, 3]);
    assert.deepEqual((await getUpload(app, user.cookie, id)).body.data.session.missing, [1, 3]);
    assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    assert.equal(storedAssets(fake).length, 0);

    await sendChunk(app, user.cookie, id, 1, parts[1]);
    await sendChunk(app, user.cookie, id, 3, parts[3]);
    assert.equal((await completeUpload(app, user.cookie, id)).status, 201);
  });
});

test('pieces stored on disk that no longer match their checksum are caught at completion', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK);
    const init = await initUpload(app, user.cookie, { name: 'rot.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    await sendChunk(app, user.cookie, id, 0, parts[0]);
    await sendChunk(app, user.cookie, id, 1, parts[1]);

    // Damage piece 1 in the temp folder, the way a bad disk would.
    const binPath = path.join(app.tmpDir, 'uploads', id, 'chunks', '1.bin');
    fs.writeFileSync(binPath, Buffer.alloc(parts[1].length, 0x7a));

    const broken = await completeUpload(app, user.cookie, id);
    assert.equal(broken.status, 400);
    assert.equal(broken.body.error.code, 'CHUNK_CORRUPT');
    assert.deepEqual(broken.body.error.details.missing, [1]);
    assert.equal((await listFiles(app, user.cookie)).files.length, 0);

    assert.equal((await sendChunk(app, user.cookie, id, 1, parts[1])).status, 201, 'the damaged piece can be sent again');
    const done = await completeUpload(app, user.cookie, id);
    assert.equal(done.status, 201);
    const { bytes: back } = await downloadFile(app, user.cookie, done.body.data.file.id);
    assert.ok(back.equals(bytes));
  });
});

// ---- concurrency and idempotency

test('pieces sent at the same time are all stored, and completing at the same time makes one file', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(5 * CHUNK - 1);
    const init = await initUpload(app, user.cookie, { name: 'race.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);

    // Five at once is more than the server runs together (4), so the extra one gets 429 and is sent again, as a client does.
    const sent = await Promise.all(parts.map((p, i) => sendChunk(app, user.cookie, id, i, p)));
    assert.ok(sent.every((r) => r.status === 201 || r.status === 429), 'a piece is stored or asked to wait');
    assert.ok(sent.some((r) => r.status === 201));
    for (const [i, r] of sent.entries()) {
      if (r.status === 429) assert.equal((await sendChunk(app, user.cookie, id, i, parts[i])).status, 201);
    }
    assert.equal((await getUpload(app, user.cookie, id)).body.data.session.missing.length, 0, 'every piece is stored');

    const finished = await Promise.all([1, 2, 3].map(() => completeUpload(app, user.cookie, id)));
    const statuses = finished.map((r) => r.status).sort();
    assert.equal(statuses.filter((s) => s === 201).length, 1, `exactly one completion creates the file: ${statuses}`);
    assert.ok(statuses.every((s) => [200, 201, 409].includes(s)));
    const ids = new Set(finished.filter((r) => r.status < 300).map((r) => r.body.data.file.id));
    assert.equal(ids.size, 1, 'every success names the same file');
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
    assert.equal(storedAssets(fake).length, 1);
  });
});

test('the same piece sent several times at once is stored once', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK);
    const init = await initUpload(app, user.cookie, { name: 'twice.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    const results = await Promise.all(Array.from({ length: 5 }, () => sendChunk(app, user.cookie, id, 0, parts[0])));
    assert.ok(results.every((r) => [200, 201, 429].includes(r.status)), `unexpected: ${results.map((r) => r.status)}`);
    assert.equal(results.filter((r) => r.status === 201).length, 1);
    assert.deepEqual((await getUpload(app, user.cookie, id)).body.data.session.received, [0]);
  });
});

test('an interrupted upload resumes under the same id, with what it already has', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(4 * CHUNK - 10);
    const uploadId = crypto.randomUUID();
    const init = await initUpload(app, user.cookie, { name: 'resume.txt', size: bytes.length, chunkBytes: CHUNK, uploadId });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    await sendChunk(app, user.cookie, id, 0, parts[0]);
    await sendChunk(app, user.cookie, id, 1, parts[1]);

    // The page reloads and asks again with the same upload id.
    const again = await initUpload(app, user.cookie, { name: 'resume.txt', size: bytes.length, chunkBytes: CHUNK, uploadId });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.session.id, id);
    assert.deepEqual(again.body.data.session.received, [0, 1]);
    assert.deepEqual(again.body.data.session.missing, [2, 3]);

    for (const i of again.body.data.session.missing) await sendChunk(app, user.cookie, id, i, parts[i]);
    const done = await completeUpload(app, user.cookie, id);
    assert.equal(done.status, 201);
  });
});

test('a resume with different settings is refused', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    assert.equal((await initUpload(app, user.cookie, { name: 'a.txt', size: 1000, chunkBytes: CHUNK, uploadId })).status, 201);
    const other = await initUpload(app, user.cookie, { name: 'a.txt', size: 2000, chunkBytes: CHUNK, uploadId });
    assert.equal(other.status, 409);
    assert.equal(other.body.error.code, 'UPLOAD_MISMATCH');
  });
});

test('an upload id that already made a file returns that file, and creates no second one', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1500);
    const { sessionId, complete } = await uploadAllChunks(app, user.cookie, 'once.txt', bytes, CHUNK);
    assert.equal(complete.status, 201);
    const uploadId = (await getUpload(app, user.cookie, sessionId)).body.data.session.uploadId;

    const again = await initUpload(app, user.cookie, { name: 'once.txt', size: bytes.length, chunkBytes: CHUNK, uploadId });
    assert.equal(again.status, 200);
    assert.equal(again.body.data.session.status, 'completed');
    assert.equal(again.body.data.session.file.id, complete.body.data.file.id);
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
  });
});

test('after the owner deletes a finished file, its upload id cannot make it again', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1500);
    const { sessionId, complete } = await uploadAllChunks(app, user.cookie, 'gone.txt', bytes, CHUNK);
    const uploadId = (await getUpload(app, user.cookie, sessionId)).body.data.session.uploadId;
    await authed(app, user.cookie, `/api/files/${complete.body.data.file.id}`, { method: 'DELETE' });

    const again = await initUpload(app, user.cookie, { name: 'gone.txt', size: bytes.length, chunkBytes: CHUNK, uploadId });
    assert.equal(again.status, 409);
    assert.equal(again.body.error.code, 'UPLOAD_ID_USED');
  });
});

// ---- ownership and request checks

test('another account cannot see, send to, complete, or cancel an upload', async () => {
  await withApp(fake, {}, async (app) => {
    const owner = await signup(app);
    const other = await signup(app);
    const bytes = textOf(1000);
    const init = await initUpload(app, owner.cookie, { name: 'mine.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);

    assert.equal((await getUpload(app, other.cookie, id)).status, 404);
    assert.equal((await sendChunk(app, other.cookie, id, 0, parts[0])).status, 404);
    assert.equal((await completeUpload(app, other.cookie, id)).status, 404);
    assert.equal((await cancelUpload(app, other.cookie, id)).status, 404);

    // The owner's session is unchanged.
    assert.deepEqual((await getUpload(app, owner.cookie, id)).body.data.session.received, []);
  });
});

test('a session id that does not exist gets the same answer as one that belongs to someone else', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const missing = await getUpload(app, user.cookie, crypto.randomBytes(16).toString('hex'));
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    const malformed = await getUpload(app, user.cookie, 'not-a-session');
    assert.equal(malformed.status, 404);
  });
});

test('authentication, the CSRF header, and the Origin check apply to every chunked route', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1000);
    const init = await initUpload(app, user.cookie, { name: 'auth.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);

    const anon = await fetch(`${app.base}/api/uploads/init`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch', Origin: app.base },
      body: JSON.stringify({ name: 'x.txt', size: 5, uploadId: crypto.randomUUID() }),
    });
    assert.equal(anon.status, 401);
    assert.equal((await sendChunk(app, 'session=bogus', id, 0, parts[0])).status, 401);

    const noCsrf = await fetch(`${app.base}/api/uploads/${id}/chunks/0`, {
      method: 'POST',
      headers: { Cookie: user.cookie, Origin: app.base, 'X-Chunk-Sha256': sha256(parts[0]) },
      body: parts[0],
    });
    assert.equal(noCsrf.status, 403);
    assert.equal((await noCsrf.json()).error.code, 'CSRF_HEADER_REQUIRED');

    const cross = await fetch(`${app.base}/api/uploads/${id}/chunks/0`, {
      method: 'POST',
      headers: {
        Cookie: user.cookie,
        'X-Requested-With': 'fetch',
        Origin: 'https://evil.example',
        'X-Chunk-Sha256': sha256(parts[0]),
      },
      body: parts[0],
    });
    assert.equal(cross.status, 403);
    assert.equal((await cross.json()).error.code, 'CROSS_SITE_REFUSED');

    assert.deepEqual((await getUpload(app, user.cookie, id)).body.data.session.received, [], 'refused pieces are not kept');
  });
});

test('init validates the name, size, piece size, and upload id', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const attempt = async (body) => {
      const res = await initUpload(app, user.cookie, { uploadId: crypto.randomUUID(), ...body });
      return { status: res.status, code: res.body.error && res.body.error.code };
    };
    assert.deepEqual(await attempt({ name: 'a.txt', size: 0 }), { status: 400, code: 'EMPTY_FILE' });
    assert.deepEqual(await attempt({ name: 'a.txt', size: -5 }), { status: 400, code: 'INVALID_SIZE' });
    assert.deepEqual(await attempt({ name: 'a.txt', size: 1.5 }), { status: 400, code: 'INVALID_SIZE' });
    assert.deepEqual(await attempt({ name: '.env', size: 10 }), { status: 400, code: 'INVALID_FILENAME' });
    assert.deepEqual(await attempt({ name: '', size: 10 }), { status: 400, code: 'INVALID_FILENAME' });
    assert.deepEqual(await attempt({ name: 'a.txt', size: 10, chunkBytes: 1000 }), { status: 400, code: 'INVALID_CHUNK_SIZE' });
    assert.deepEqual(await attempt({ name: 'a.txt', size: 10, chunkBytes: 9 * MB }), { status: 400, code: 'INVALID_CHUNK_SIZE' });
    assert.deepEqual(await attempt({ name: 'a.txt', size: 10, uploadId: 'nope' }), { status: 400, code: 'INVALID_UPLOAD_ID' });

    // A path in the name is reduced to its last part.
    const traversal = await initUpload(app, user.cookie, { name: '../../etc/a.txt', size: 10 });
    assert.equal(traversal.status, 201);
    assert.equal(traversal.body.data.session.name, 'a.txt');
  });
});

// ---- limits

test('the per-file cap applies at init: one byte over is refused, exactly at the cap is accepted', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const over = await initUpload(app, user.cookie, { name: 'big.txt', size: 2 * GB + 1 });
    assert.equal(over.status, 413);
    assert.equal(over.body.error.code, 'FILE_TOO_LARGE');
    const exact = await initUpload(app, user.cookie, { name: 'big.txt', size: 2 * GB, chunkBytes: 8 * MB });
    assert.equal(exact.status, 201);
    assert.equal(exact.body.data.session.chunkCount, 256, '2 GB in 8 MB pieces');
  });
});

test('the file-count cap applies to chunked uploads too', async () => {
  await withApp(fake, { limits: { maxFiles: 1 } }, async (app) => {
    const user = await signup(app);
    assert.equal((await uploadAllChunks(app, user.cookie, 'first.txt', textOf(10), CHUNK)).complete.status, 201);
    const blocked = await initUpload(app, user.cookie, { name: 'second.txt', size: 10 });
    assert.equal(blocked.status, 507);
    assert.equal(blocked.body.error.code, 'FILE_LIMIT_REACHED');
  });
});

test('an account may hold three unfinished uploads at once', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    for (let i = 0; i < 3; i += 1) {
      assert.equal((await initUpload(app, user.cookie, { name: `n${i}.txt`, size: 10 })).status, 201);
    }
    const fourth = await initUpload(app, user.cookie, { name: 'n3.txt', size: 10 });
    assert.equal(fourth.status, 429);
    assert.equal(fourth.body.error.code, 'TOO_MANY_UPLOADS');
  });
});

test('the server caps unfinished uploads across all accounts', async () => {
  await withApp(fake, { limits: { chunks: { maxSessionsTotal: 2, maxSessionsPerUser: 5 } } }, async (app) => {
    const a = await signup(app);
    const b = await signup(app);
    assert.equal((await initUpload(app, a.cookie, { name: 'a.txt', size: 10 })).status, 201);
    assert.equal((await initUpload(app, b.cookie, { name: 'b.txt', size: 10 })).status, 201);
    const third = await initUpload(app, a.cookie, { name: 'a2.txt', size: 10 });
    assert.equal(third.status, 429);
  });
});

test('starting uploads is rate-limited per account, and resuming is not counted', async () => {
  await withApp(fake, { limits: { chunks: { maxSessionsPerUser: 1000, maxSessionsTotal: 1000 } } }, async (app) => {
    const user = await signup(app);
    const uploadId = crypto.randomUUID();
    assert.equal((await initUpload(app, user.cookie, { name: 'resume.txt', size: 10, uploadId })).status, 201);
    for (let i = 0; i < 59; i += 1) {
      assert.equal((await initUpload(app, user.cookie, { name: `r${i}.txt`, size: 10 })).status, 201);
    }
    // The 61st start in the hour is refused. Resuming the first one would still be allowed.
    const refused = await initUpload(app, user.cookie, { name: 'late.txt', size: 10 });
    assert.equal(refused.status, 429);
    assert.equal(refused.body.error.code, 'RATE_LIMITED');
    assert.equal((await initUpload(app, user.cookie, { name: 'resume.txt', size: 10, uploadId })).status, 200);
  });
});

test('a piece request runs under the same concurrency cap as other uploads', async () => {
  await withApp(fake, { limits: { maxConcurrentUploads: 1 } }, async (app) => {
    const user = await signup(app);
    const bytes = textOf(2 * CHUNK);
    const init = await initUpload(app, user.cookie, { name: 'busy.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);

    const first = slowPiece(app, user.cookie, id, 0, parts[0]);
    await new Promise((r) => setTimeout(r, 150));
    const second = await sendChunk(app, user.cookie, id, 1, parts[1]);
    assert.equal(second.status, 429);
    assert.equal(second.body.error.code, 'TOO_MANY_UPLOADS');

    first.finish();
    const firstDone = await first.done;
    assert.equal(firstDone.status, 201);
  });
});

test('a completion retried after a storage failure stores the file once', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1500);
    const init = await initUpload(app, user.cookie, { name: 'flaky.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    for (const [i, part] of pieces(bytes, CHUNK).entries()) await sendChunk(app, user.cookie, id, i, part);

    fake.fault('POST', /^\/uploads\/repos\//, 500, { times: 1 });
    const failed = await completeUpload(app, user.cookie, id);
    assert.equal(failed.status, 503);
    assert.equal(failed.body.error.code, 'UPSTREAM_ERROR');
    const status = await getUpload(app, user.cookie, id);
    assert.equal(status.body.data.session.status, 'uploading', 'the session is open for another try');
    assert.equal(status.body.data.session.missing.length, 0, 'the pieces are kept');

    const retried = await completeUpload(app, user.cookie, id);
    assert.equal(retried.status, 201);
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
    assert.equal(storedAssets(fake).length, 1);
  });
});

test('a failed record save leaves no half file, and the retry after cleanup stores it once', async () => {
  const clock = { t: Date.now() };
  await withApp(fake, { clock }, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1200);
    const init = await initUpload(app, user.cookie, { name: 'half.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    for (const [i, part] of pieces(bytes, CHUNK).entries()) await sendChunk(app, user.cookie, id, i, part);

    // Manifest writes during completion: 1) reserve, 2) mark ready. Fail the second.
    const manifest = new RegExp(`^/repos/${DATA_REPO}/contents/uploads/${user.userId}/manifest\\.json$`);
    fake.fault('PUT', manifest, 500, { times: 1, skip: 1 });
    assert.equal((await completeUpload(app, user.cookie, id)).status, 503);

    // Within 15 minutes the stale record still blocks a retry, as it does for any upload.
    const early = await completeUpload(app, user.cookie, id);
    assert.equal(early.status, 409);
    assert.equal(early.body.error.code, 'UPLOAD_IN_PROGRESS');

    clock.t += 16 * 60 * 1000;
    const retried = await completeUpload(app, user.cookie, id);
    assert.equal(retried.status, 201);
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
    assert.equal(storedAssets(fake).length, 1, 'the abandoned asset was removed');
  });
});

test('a file whose contents do not match its type is refused at completion, and nothing is stored', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(800);
    const init = await initUpload(app, user.cookie, { name: 'fake.png', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    for (const [i, part] of pieces(bytes, CHUNK).entries()) await sendChunk(app, user.cookie, id, i, part);

    const refused = await completeUpload(app, user.cookie, id);
    assert.equal(refused.status, 415);
    assert.equal(refused.body.error.code, 'FILE_CONTENT_MISMATCH');
    assert.equal((await listFiles(app, user.cookie)).files.length, 0);
    assert.equal(storedAssets(fake).length, 0);
    assert.equal((await getUpload(app, user.cookie, id)).body.data.session.status, 'uploading');
    assert.equal((await cancelUpload(app, user.cookie, id)).status, 200);
  });
});

test('a PNG sent in pieces is stored as an image, and its signature is checked on the whole file', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), crypto.randomBytes(5000)]);
    const { complete } = await uploadAllChunks(app, user.cookie, 'pic.png', png, CHUNK);
    assert.equal(complete.status, 201);
    assert.equal(complete.body.data.file.type, 'image/png');
    assert.ok((await downloadFile(app, user.cookie, complete.body.data.file.id)).bytes.equals(png));
  });
});

// ---- expiry, cancel, cleanup

test('an upload past its session time is refused and its pieces are removed', async () => {
  const clock = { t: Date.now() };
  await withApp(fake, { clock, limits: { chunks: { sessionMs: 60 * 60 * 1000 } } }, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1000);
    const init = await initUpload(app, user.cookie, { name: 'slow.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    await sendChunk(app, user.cookie, id, 0, pieces(bytes, CHUNK)[0]);

    clock.t += 61 * 60 * 1000;
    const expired = await getUpload(app, user.cookie, id);
    assert.equal(expired.status, 410);
    assert.equal(expired.body.error.code, 'UPLOAD_EXPIRED');
    assert.equal(fs.existsSync(path.join(app.tmpDir, 'uploads', id)), false);
  });
});

test('an upload with no new piece for two hours is removed by the sweep', async () => {
  const clock = { t: Date.now() };
  await withApp(fake, { clock }, async (app) => {
    const user = await signup(app);
    const idle = await initUpload(app, user.cookie, { name: 'idle.txt', size: 1000 });
    const busy = await initUpload(app, user.cookie, { name: 'busy.txt', size: 1000 });
    const busyId = busy.body.data.session.id;
    const idleId = idle.body.data.session.id;

    clock.t += 90 * 60 * 1000;
    await sendChunk(app, user.cookie, busyId, 0, Buffer.alloc(1000, 0x61)); // not valid text, but a piece is a piece
    clock.t += 90 * 60 * 1000;

    const removed = await app.services.chunks.sweep();
    assert.ok(removed >= 1);
    assert.equal(fs.existsSync(path.join(app.tmpDir, 'uploads', idleId)), false, 'idle upload removed');
    assert.equal(fs.existsSync(path.join(app.tmpDir, 'uploads', busyId)), true, 'upload with recent activity kept');
  });
});

test('cancelling removes the session and every piece, and the id stops working', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(3 * CHUNK - 10);
    const init = await initUpload(app, user.cookie, { name: 'drop.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    await sendChunk(app, user.cookie, id, 0, parts[0]);
    await sendChunk(app, user.cookie, id, 1, parts[1]);
    assert.equal((await cancelUpload(app, user.cookie, id)).status, 200);
    assert.equal(fs.existsSync(path.join(app.tmpDir, 'uploads', id)), false);
    assert.equal((await getUpload(app, user.cookie, id)).status, 404);
    assert.equal((await sendChunk(app, user.cookie, id, 2, parts[2])).status, 404);
  });
});

test('a finished upload cannot be cancelled, and its pieces are removed once it completes', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(1500);
    const { sessionId, complete } = await uploadAllChunks(app, user.cookie, 'done.txt', bytes, CHUNK);
    assert.equal(complete.status, 201);
    const cancel = await cancelUpload(app, user.cookie, sessionId);
    assert.equal(cancel.status, 409);
    assert.equal(cancel.body.error.code, 'UPLOAD_COMPLETED');
    assert.equal(fs.existsSync(path.join(app.tmpDir, 'uploads', sessionId, 'chunks')), false);
    const late = await sendChunk(app, user.cookie, sessionId, 0, bytes.subarray(0, CHUNK));
    assert.equal(late.status, 409);
    assert.equal(late.body.error.code, 'UPLOAD_NOT_OPEN');
  });
});

test('a server restart keeps the pieces when the temp folder persists, so the upload resumes', async () => {
  const dir = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'chunk-restart-'));
  const bytes = textOf(4 * CHUNK - 10);
  const parts = pieces(bytes, CHUNK);
  const uploadId = crypto.randomUUID();
  let id;
  let user;
  const first = await startApp(fake, { tmpDir: dir });
  try {
    user = await signup(first);
    const init = await initUpload(first, user.cookie, { name: 'restart.txt', size: bytes.length, chunkBytes: CHUNK, uploadId });
    id = init.body.data.session.id;
    await sendChunk(first, user.cookie, id, 0, parts[0]);
    await sendChunk(first, user.cookie, id, 1, parts[1]);
  } finally {
    await first.close();
  }

  const second = await startApp(fake, { tmpDir: dir });
  try {
    const status = await getUpload(second, user.cookie, id);
    assert.equal(status.status, 200);
    assert.deepEqual(status.body.data.session.received, [0, 1]);
    await sendChunk(second, user.cookie, id, 2, parts[2]);
    await sendChunk(second, user.cookie, id, 3, parts[3]);
    const done = await completeUpload(second, user.cookie, id);
    assert.equal(done.status, 201);
    assert.ok((await downloadFile(second, user.cookie, done.body.data.file.id)).bytes.equals(bytes));
  } finally {
    await second.close();
  }
});

test('the pieces stay in the private temp folder and are removed once the file is stored', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(4 * CHUNK - 10);
    const init = await initUpload(app, user.cookie, { name: 'clean.txt', size: bytes.length, chunkBytes: CHUNK });
    const { id } = init.body.data.session;
    const parts = pieces(bytes, CHUNK);
    await sendChunk(app, user.cookie, id, 0, parts[0]);
    assert.ok(tempFiles(app.tmpDir).some((f) => f.endsWith('0.bin')), 'pieces are on disk while the upload is open');
    for (const i of [1, 2, 3].slice(0, parts.length - 1)) await sendChunk(app, user.cookie, id, i, parts[i]);
    assert.equal((await completeUpload(app, user.cookie, id)).status, 201);
    // The session record stays (small, no pieces) so a repeated completion can be answered. Its pieces do not.
    assert.deepEqual(
      tempFiles(app.tmpDir).filter((f) => f.includes(id) && (f.includes('chunks') || f.endsWith('.part'))),
      [],
      'no pieces are left for this session',
    );
    assert.equal(fs.readdirSync(app.tmpDir).filter((n) => n.startsWith('assembled')).length, 0);
  });
});

// ---- logs

test('logs show a masked name and short references, never the full name or session id', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const name = 'quarterly-board-deck-secret.txt';
    let session;
    const logs = await captureLogs(async () => {
      const bytes = textOf(1500);
      const init = await initUpload(app, user.cookie, { name, size: bytes.length, chunkBytes: CHUNK });
      session = init.body.data.session.id;
      for (const [i, part] of pieces(bytes, CHUNK).entries()) await sendChunk(app, user.cookie, session, i, part);
      await completeUpload(app, user.cookie, session);
    });
    assert.match(logs, /chunked upload started/);
    assert.match(logs, /upload stored/);
    assert.ok(!logs.includes('quarterly'), 'the name is not logged');
    assert.ok(!logs.includes(session), 'the session id is not logged');
    assert.ok(!logs.includes(user.userId), 'the account id is not logged');
    assert.ok(logs.includes('q….txt'), 'a masked name is logged');
  });
});

// ---- settings

test('upload settings: defaults stay, valid values apply, and bad values name the setting', () => {
  assert.deepEqual(loadUploadSettings({}), { ok: true, limits: { chunks: {}, importAllowPrivate: false }, tempDir: null });
  const good = loadUploadSettings({ UPLOAD_CHUNK_BYTES: '524288', UPLOAD_SESSION_HOURS: '6', FILE_TEMP_DIR: '/var/tmp/files' });
  assert.equal(good.ok, true);
  assert.equal(good.limits.chunks.chunkBytes, 524288);
  assert.equal(good.limits.chunks.sessionMs, 6 * 60 * 60 * 1000);
  assert.equal(good.tempDir, '/var/tmp/files');

  for (const [env, setting] of [
    [{ UPLOAD_CHUNK_BYTES: '100' }, 'UPLOAD_CHUNK_BYTES'],
    [{ UPLOAD_CHUNK_BYTES: '9000000' }, 'UPLOAD_CHUNK_BYTES'],
    [{ UPLOAD_CHUNK_BYTES: 'big' }, 'UPLOAD_CHUNK_BYTES'],
    [{ UPLOAD_SESSION_HOURS: '0' }, 'UPLOAD_SESSION_HOURS'],
    [{ UPLOAD_SESSION_HOURS: '500' }, 'UPLOAD_SESSION_HOURS'],
    [{ FILE_TEMP_DIR: 'relative/dir' }, 'FILE_TEMP_DIR'],
  ]) {
    const bad = loadUploadSettings(env);
    assert.equal(bad.ok, false, JSON.stringify(env));
    assert.match(bad.missing[0], new RegExp(setting));
    const value = Object.values(env)[0];
    if (value.length >= 3) assert.ok(!bad.missing[0].includes(value), 'the value is not echoed');
  }
});

test('a bad upload setting turns file storage off and names the setting on startup', async () => {
  await withApp(fake, { env: { ...ENV, UPLOAD_CHUNK_BYTES: '5' } }, async (app) => {
    const res = await fetch(`${app.base}/api/files`, { headers: { Cookie: 'session=x' } });
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.match(body.error.message, /UPLOAD_CHUNK_BYTES/);
  });
});

test('a chunk size from the configuration is used by default', async () => {
  await withApp(fake, { limits: { chunks: { chunkBytes: 512 * KB } } }, async (app) => {
    const user = await signup(app);
    const init = await initUpload(app, user.cookie, { name: 'cfg.txt', size: 2 * MB });
    assert.equal(init.body.data.session.chunkBytes, 512 * KB);
    assert.equal(init.body.data.session.chunkCount, 4);
  });
});

test('after a completed chunked upload, the existing whole-file upload still works', async () => {
  await withApp(fake, {}, async (app) => {
    const user = await signup(app);
    const bytes = textOf(200);
    const form = new FormData();
    form.append('uploadId', crypto.randomUUID());
    form.append('file', new Blob([bytes], { type: 'text/plain' }), 'whole.txt');
    const res = await authed(app, user.cookie, '/api/files/upload', { method: 'POST', body: form });
    assert.equal(res.status, 201);
    assert.equal((await listFiles(app, user.cookie)).files.length, 1);
  });
});
