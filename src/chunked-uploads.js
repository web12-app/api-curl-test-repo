'use strict';

// Chunked uploads: a large file is sent in numbered pieces, each with its own SHA-256. The pieces are kept on the
// server's temp disk, in a folder per session. Completion checks every piece, joins them in order, and hands the
// result to the same checks and storage path as a normal upload (FileService.upload).
//
// Layout (under the service's temp dir, never served):
//   uploads/<sessionId>/session.json       owner, name, size, chunk size, status
//   uploads/<sessionId>/chunks/<n>.bin     piece n
//   uploads/<sessionId>/chunks/<n>.sha256  written last: the piece is received only when this file exists
//
// Rules this module keeps:
// - Every session change happens under the session's lock, and a session never changes owner.
// - A piece is committed once. The same bytes again are a no-op. Different bytes for the same number are refused.
// - A file record is created only through FileService.upload, which is idempotent on the client's upload id.
//   Completing twice, or retrying after a failed storage call, therefore never makes a second file.
// - Any failure leaves the session open for a retry. Sessions that expire or sit idle are removed with their pieces.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { AppError } = require('./errors');
const { checkStoredFile } = require('./file-checks');
const { removeFile } = require('./upload');
const { sanitizeFilename } = require('./file-types');
const { maskName, ref } = require('./redact');

const MB = 1024 * 1024;
const SESSION_ID_RE = /^[0-9a-f]{32}$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const COMPLETING_STALE_MS = 10 * 60 * 1000; // a completion that never finished is retried after this
const SWEEP_EVERY_MS = 10 * 60 * 1000;

const CHUNK_LIMITS = {
  chunkBytes: 8 * MB, // default piece size (the largest allowed; big files finish faster)
  minChunkBytes: 256 * 1024,
  maxChunkBytes: 8 * MB,
  maxChunks: 512, // 512 pieces x 8 MiB is well above the 2 GiB asset ceiling
  sessionMs: 24 * 60 * 60 * 1000, // a session lives at most this long
  sessionIdleMs: 2 * 60 * 60 * 1000, // and is dropped after this long without a new piece
  maxSessionsPerUser: 3, // open at once
  maxSessionsTotal: 50, // open at once, on this server
};

const iso = (ms) => new Date(ms).toISOString();

const expectedChunkBytes = (session, index) => {
  const last = session.chunkCount - 1;
  return index === last ? session.size - last * session.chunkBytes : session.chunkBytes;
};

// What the client may see. The owner, the temp paths, and the file's storage ids are never included.
function publicSession(session, received) {
  const have = new Set(received);
  const missing = [];
  for (let i = 0; i < session.chunkCount; i += 1) if (!have.has(i)) missing.push(i);
  return {
    id: session.id,
    uploadId: session.clientUploadId,
    name: session.name,
    size: session.size,
    chunkBytes: session.chunkBytes,
    chunkCount: session.chunkCount,
    status: session.status,
    received,
    missing,
    expiresAt: iso(session.expiresAt),
    file: session.file || null,
  };
}

// The answer for an upload that already finished. Its session may be gone, so only the file is reported.
function finishedView(clientUploadId, file) {
  return {
    id: null,
    uploadId: clientUploadId,
    name: file.name,
    size: file.size,
    chunkBytes: null,
    chunkCount: 0,
    status: 'completed',
    received: [],
    missing: [],
    expiresAt: null,
    file,
  };
}

async function writeAtomic(filePath, text) {
  const tmp = `${filePath}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  await fs.promises.writeFile(tmp, text, { mode: 0o600 });
  await fs.promises.rename(tmp, filePath);
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

const isMissing = (err) => err && err.code === 'ENOENT';

class ChunkedUploads {
  // `service` is the FileService. Limits come from its config (see config.js) and default to CHUNK_LIMITS.
  constructor({ service, now }) {
    this.service = service;
    this.now = now || service.now;
    this.limits = { ...CHUNK_LIMITS, ...(service.limits.chunks || {}) };
    if (
      !Number.isInteger(this.limits.chunkBytes) ||
      this.limits.chunkBytes < this.limits.minChunkBytes ||
      this.limits.chunkBytes > this.limits.maxChunkBytes
    ) {
      throw new Error('Chunk size is outside the allowed range.');
    }
    this.root = path.join(service.tmpDir, 'uploads');
    fs.mkdirSync(this.root, { recursive: true, mode: 0o700 });
    this.locks = new Map();
    this.timer = setInterval(() => this.sweep().catch(() => {}), SWEEP_EVERY_MS);
    this.timer.unref();
  }

  async lock(key, fn) {
    const prev = this.locks.get(key) || Promise.resolve();
    let done;
    const current = new Promise((resolve) => (done = resolve));
    const tail = prev.then(() => current);
    this.locks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      done();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    }
  }

  dirOf(id) {
    return path.join(this.root, id);
  }

  async readSession(id) {
    try {
      return JSON.parse(await fs.promises.readFile(path.join(this.dirOf(id), 'session.json'), 'utf8'));
    } catch {
      return null;
    }
  }

  async saveSession(session) {
    await writeAtomic(path.join(this.dirOf(session.id), 'session.json'), JSON.stringify(session));
  }

  isExpired(session, now) {
    return now > session.expiresAt || (session.status !== 'completed' && now - session.updatedAt > this.limits.sessionIdleMs);
  }

  async removeSession(id) {
    await fs.promises.rm(this.dirOf(id), { recursive: true, force: true }).catch(() => {});
  }

  // Every session on disk. Unreadable folders are returned as null so the sweep can remove them.
  async allSessions() {
    let names = [];
    try {
      names = await fs.promises.readdir(this.root);
    } catch {
      return [];
    }
    const out = [];
    for (const name of names) {
      if (!SESSION_ID_RE.test(name)) continue;
      out.push({ id: name, session: await this.readSession(name) });
    }
    return out;
  }

  // Loads a session for its owner. Any other caller gets the same 404 as for a session that does not exist.
  async loadOwned(uid, id) {
    if (!SESSION_ID_RE.test(id || '')) throw new AppError(404, 'NOT_FOUND', 'Upload not found.');
    const session = await this.readSession(id);
    if (!session || session.uid !== uid) throw new AppError(404, 'NOT_FOUND', 'Upload not found.');
    if (this.isExpired(session, this.now())) {
      await this.removeSession(id);
      throw new AppError(410, 'UPLOAD_EXPIRED', 'This upload has expired. Start the upload again.');
    }
    return session;
  }

  async receivedOf(id) {
    let names = [];
    try {
      names = await fs.promises.readdir(path.join(this.dirOf(id), 'chunks'));
    } catch {
      return [];
    }
    return names
      .map((n) => /^(\d+)\.sha256$/.exec(n))
      .filter(Boolean)
      .map((m) => Number(m[1]))
      .filter((n) => Number.isSafeInteger(n))
      .sort((a, b) => a - b);
  }

  async viewOf(session) {
    return publicSession(session, await this.receivedOf(session.id));
  }

  // Opens a session. Returns { view, created }. An unfinished session with the same client upload id is reused,
  // which is how an interrupted upload resumes after a reload. hooks.checkLimit runs before a new session is made,
  // and hooks.countStart after it is saved, so the caller's upload budget counts new sessions only.
  async init(uid, body, hooks = {}) {
    const { limits } = this;
    const { service } = this;
    const clientUploadId = typeof body.uploadId === 'string' ? body.uploadId : '';
    if (!UPLOAD_ID_RE.test(clientUploadId)) throw new AppError(400, 'INVALID_UPLOAD_ID', 'The upload id must be a UUID.');
    const name = sanitizeFilename(typeof body.name === 'string' ? body.name : '');
    if (!name) throw new AppError(400, 'INVALID_FILENAME', 'Use a file name with letters or digits and an extension.');
    const size = body.size;
    if (!Number.isSafeInteger(size) || size < 0) throw new AppError(400, 'INVALID_SIZE', 'The file size must be a whole number of bytes.');
    if (size === 0) throw new AppError(400, 'EMPTY_FILE', 'The file is empty.');
    if (size > service.limits.maxFileBytes) {
      throw new AppError(413, 'FILE_TOO_LARGE', `Files must be ${Math.floor(service.limits.maxFileBytes / MB)} MB or smaller.`);
    }
    let chunkBytes = limits.chunkBytes;
    if (body.chunkBytes !== undefined) {
      const requested = body.chunkBytes;
      if (!Number.isSafeInteger(requested) || requested < limits.minChunkBytes || requested > limits.maxChunkBytes) {
        throw new AppError(400, 'INVALID_CHUNK_SIZE', 'The piece size is outside the allowed range.');
      }
      chunkBytes = requested;
    }
    const chunkCount = Math.ceil(size / chunkBytes);
    if (chunkCount > limits.maxChunks) {
      throw new AppError(400, 'TOO_MANY_CHUNKS', 'That file needs too many pieces. Use a larger piece size.');
    }

    await service.assertReady();

    return this.lock(`init:${uid}`, async () => {
      // A finished earlier upload with this id is answered as it was (see FileService.upload).
      const finished = await service.findUpload(uid, clientUploadId);
      if (finished && finished.status === 'pending') {
        throw new AppError(409, 'UPLOAD_IN_PROGRESS', 'This upload is already in progress. Wait, then check your files.');
      }
      if (finished && finished.status === 'ready') {
        return { view: finishedView(clientUploadId, finished.file), created: false };
      }

      const now = this.now();
      const every = await this.allSessions();
      const sessions = every.filter((s) => s.session && s.session.uid === uid);
      const same = sessions.find((s) => s.session.clientUploadId === clientUploadId);
      if (same && same.session.status === 'completed') {
        // Finished, and its file was deleted since. Only a new upload id starts a new file.
        throw new AppError(409, 'UPLOAD_ID_USED', 'This file was already deleted. Start a new upload.');
      }
      if (same && !this.isExpired(same.session, now)) {
        const s = same.session;
        if (s.name !== name || s.size !== size || s.chunkBytes !== chunkBytes) {
          throw new AppError(409, 'UPLOAD_MISMATCH', 'An unfinished upload with this id has different settings. Start a new upload id.');
        }
        return { view: publicSession(s, await this.receivedOf(s.id)), created: false };
      }

      const open = (list) => list.filter((s) => !this.isExpired(s.session, now) && s.session.status !== 'completed');
      if (open(sessions).length >= limits.maxSessionsPerUser) {
        throw new AppError(429, 'TOO_MANY_UPLOADS', 'Finish or cancel an unfinished upload before starting another.');
      }
      if (open(every.filter((s) => s.session)).length >= limits.maxSessionsTotal) {
        throw new AppError(429, 'TOO_MANY_UPLOADS', 'The server is busy with other uploads. Try again shortly.');
      }
      await service.assertRoom(uid);
      if (hooks.checkLimit) hooks.checkLimit();

      const id = crypto.randomBytes(16).toString('hex');
      const dir = this.dirOf(id);
      await fs.promises.mkdir(path.join(dir, 'chunks'), { recursive: true, mode: 0o700 });
      const session = {
        id,
        uid,
        clientUploadId,
        name,
        size,
        chunkBytes,
        chunkCount,
        status: 'uploading',
        file: null,
        createdAt: now,
        updatedAt: now,
        expiresAt: now + limits.sessionMs,
      };
      await this.saveSession(session);
      if (hooks.countStart) hooks.countStart();
      console.log(`chunked upload started: session=${ref(id)} file=${maskName(name)} owner=${ref(uid)} chunks=${chunkCount}`);
      return { view: publicSession(session, []), created: true };
    });
  }

  // Stores one piece. `source` is the request body stream; `sha256` is the client's checksum of the piece.
  // Returns { index, duplicate }.
  async putChunk(uid, id, rawIndex, { source, contentLength, sha256 }) {
    const session = await this.loadOwned(uid, id);
    if (session.status !== 'uploading') {
      throw new AppError(409, 'UPLOAD_NOT_OPEN', 'This upload is no longer accepting pieces.');
    }
    if (!/^(0|[1-9]\d{0,5})$/.test(rawIndex) || Number(rawIndex) >= session.chunkCount) {
      throw new AppError(400, 'INVALID_CHUNK_INDEX', `The piece number must be between 0 and ${session.chunkCount - 1}.`);
    }
    const index = Number(rawIndex);
    const expected = expectedChunkBytes(session, index);
    if (contentLength !== undefined && contentLength !== null) {
      if (contentLength > expected) throw new AppError(413, 'CHUNK_TOO_LARGE', 'This piece is larger than its share of the file.');
      if (contentLength < expected) throw new AppError(400, 'CHUNK_SIZE_MISMATCH', 'This piece is smaller than expected.');
    }
    if (typeof sha256 !== 'string' || !SHA256_RE.test(sha256)) {
      throw new AppError(400, 'CHUNK_HASH_REQUIRED', 'Send the SHA-256 of the piece in the X-Chunk-Sha256 header.');
    }
    const claimed = sha256.toLowerCase();

    // Stream the piece to a temp file, hashing as it goes. The size limit applies while the bytes arrive.
    const dir = path.join(this.dirOf(id), 'chunks');
    const tmp = path.join(dir, `.${crypto.randomBytes(12).toString('hex')}.tmp`);
    const hash = crypto.createHash('sha256');
    let total = 0;
    const handle = await fs.promises.open(tmp, 'wx', 0o600);
    try {
      for await (const part of source) {
        total += part.length;
        if (total > expected) {
          throw new AppError(413, 'CHUNK_TOO_LARGE', 'This piece is larger than its share of the file.');
        }
        hash.update(part);
        await writeAll(handle, part);
      }
    } catch (err) {
      await handle.close().catch(() => {});
      await removeFile(tmp);
      if (err instanceof AppError) throw err;
      throw new AppError(400, 'UPLOAD_INTERRUPTED', 'The piece was interrupted. Send it again.');
    }
    await handle.close();
    try {
      if (total !== expected) throw new AppError(400, 'CHUNK_SIZE_MISMATCH', 'This piece is smaller than expected.');
      if (hash.digest('hex') !== claimed) {
        throw new AppError(400, 'CHUNK_CORRUPT', 'The piece does not match its checksum. Send it again.');
      }
      return await this.lock(id, async () => {
        // Checked again under the lock: the session may have moved on while the piece was arriving.
        const current = await this.readSession(id);
        if (!current || current.uid !== uid) throw new AppError(404, 'NOT_FOUND', 'Upload not found.');
        if (current.status !== 'uploading') {
          throw new AppError(409, 'UPLOAD_NOT_OPEN', 'This upload is no longer accepting pieces.');
        }
        const shaPath = path.join(dir, `${index}.sha256`);
        let stored = null;
        try {
          stored = (await fs.promises.readFile(shaPath, 'utf8')).trim();
        } catch (err) {
          if (!isMissing(err)) throw err;
        }
        if (stored !== null) {
          if (stored === claimed) return { index, duplicate: true };
          throw new AppError(409, 'CHUNK_CONFLICT', 'This piece was already received with different contents.');
        }
        // The piece is committed when its checksum file exists. The checksum file is written last.
        await fs.promises.rename(tmp, path.join(dir, `${index}.bin`));
        await writeAtomic(shaPath, claimed);
        current.updatedAt = this.now();
        await this.saveSession(current);
        return { index, duplicate: false };
      });
    } finally {
      await removeFile(tmp);
    }
  }

  // Completes the session. Returns { file, duplicate }. Retrying after a failure is safe.
  async complete(uid, id) {
    await this.loadOwned(uid, id);
    const begin = await this.lock(id, async () => {
      const current = await this.readSession(id);
      if (!current || current.uid !== uid) throw new AppError(404, 'NOT_FOUND', 'Upload not found.');
      if (current.status === 'completed') return { finished: current.file };
      if (current.status === 'completing' && this.now() - current.updatedAt < COMPLETING_STALE_MS) {
        throw new AppError(409, 'UPLOAD_IN_PROGRESS', 'This upload is already being completed.');
      }
      const received = new Set(await this.receivedOf(id));
      const missing = [];
      for (let i = 0; i < current.chunkCount; i += 1) if (!received.has(i)) missing.push(i);
      if (missing.length) {
        throw new AppError(400, 'CHUNKS_MISSING', `${missing.length} piece(s) are still missing. Send them, then complete again.`, { missing });
      }
      current.status = 'completing';
      current.updatedAt = this.now();
      await this.saveSession(current);
      return { session: current };
    });
    if (begin.finished) return { file: begin.finished, duplicate: true };

    let result;
    try {
      result = await this.assemble(uid, begin.session);
    } catch (err) {
      // Back to open, so the owner can send the pieces again. Storage errors surface as they do for any upload.
      await this.lock(id, async () => {
        const current = await this.readSession(id);
        if (current && current.status === 'completing') {
          current.status = 'uploading';
          current.updatedAt = this.now();
          await this.saveSession(current);
        }
      });
      throw err;
    }

    await this.lock(id, async () => {
      const current = await this.readSession(id);
      if (!current) return;
      current.status = 'completed';
      current.file = result.file;
      current.updatedAt = this.now();
      await this.saveSession(current);
      await fs.promises.rm(path.join(this.dirOf(id), 'chunks'), { recursive: true, force: true }).catch(() => {});
    });
    return { file: result.file, duplicate: result.duplicate };
  }

  // Joins the pieces in order, verifying each one, then stores the file. Temp output is always removed.
  async assemble(uid, session) {
    const dir = path.join(this.dirOf(session.id), 'chunks');
    const out = path.join(this.dirOf(session.id), `assembled-${crypto.randomBytes(6).toString('hex')}.part`);
    const handle = await fs.promises.open(out, 'wx', 0o600);
    let total = 0;
    try {
      for (let i = 0; i < session.chunkCount; i += 1) {
        const claimed = await fs.promises.readFile(path.join(dir, `${i}.sha256`), 'utf8').then(
          (t) => t.trim(),
          (err) => {
            if (isMissing(err)) throw new AppError(400, 'CHUNKS_MISSING', 'Some pieces are missing. Send them, then complete again.', { missing: [i] });
            throw err;
          },
        );
        const binPath = path.join(dir, `${i}.bin`);
        const hash = crypto.createHash('sha256');
        try {
          for await (const part of fs.createReadStream(binPath)) {
            hash.update(part);
            await writeAll(handle, part);
            total += part.length;
          }
        } catch (err) {
          if (isMissing(err)) throw new AppError(400, 'CHUNKS_MISSING', 'Some pieces are missing. Send them, then complete again.', { missing: [i] });
          throw err;
        }
        if (hash.digest('hex') !== claimed) {
          // The piece on disk no longer matches what was received. Remove it so the owner sends it again.
          await removeFile(binPath);
          await removeFile(path.join(dir, `${i}.sha256`));
          throw new AppError(400, 'CHUNK_CORRUPT', 'A piece does not match its checksum. Send it again.', { missing: [i] });
        }
      }
      await handle.close();
      if (total !== session.size) {
        throw new AppError(400, 'CHUNK_SIZE_MISMATCH', 'The pieces do not add up to the file size.');
      }
      const checked = await checkStoredFile(session.name, out);
      const stored = await this.service.upload(uid, {
        uploadId: session.clientUploadId,
        tmpPath: out,
        size: checked.size,
        name: checked.name,
        spec: checked.spec,
        ext: checked.ext,
      });
      return stored;
    } finally {
      await handle.close().catch(() => {});
      await removeFile(out);
    }
  }

  async status(uid, id) {
    const session = await this.loadOwned(uid, id);
    return this.viewOf(session);
  }

  // Owner cancels an unfinished upload. Its pieces are removed at once.
  async cancel(uid, id) {
    await this.loadOwned(uid, id);
    return this.lock(id, async () => {
      const current = await this.readSession(id);
      if (!current || current.uid !== uid) throw new AppError(404, 'NOT_FOUND', 'Upload not found.');
      if (current.status === 'completed') {
        throw new AppError(409, 'UPLOAD_COMPLETED', 'This upload is finished. Delete the file from your list instead.');
      }
      if (current.status === 'completing' && this.now() - current.updatedAt < COMPLETING_STALE_MS) {
        throw new AppError(409, 'UPLOAD_IN_PROGRESS', 'This upload is being completed and cannot be cancelled now.');
      }
      await this.removeSession(id);
      return { cancelled: true };
    });
  }

  // Removes expired and idle sessions. A folder without a readable session.json is removed once it has been idle
  // for as long as a session may be, so a session that is being created is never removed under its owner.
  async sweep() {
    const now = this.now();
    let removed = 0;
    for (const { id, session } of await this.allSessions()) {
      let stale = false;
      if (session) {
        stale = this.isExpired(session, now);
      } else {
        const stat = await fs.promises.stat(this.dirOf(id)).catch(() => null);
        stale = !stat || now - stat.mtimeMs > this.limits.sessionIdleMs;
      }
      if (stale) {
        await this.removeSession(id);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { ChunkedUploads, CHUNK_LIMITS, SESSION_ID_RE, expectedChunkBytes };
