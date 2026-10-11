'use strict';

// File storage. Metadata lives in one manifest per user in the private data repository. File bytes live as
// release assets in the private storage repository, one release per upload (tag upload-<fileId>).
//
// Rules this module keeps:
// - Every manifest change goes through withManifest: read, change, write with the SHA, one change at a time per user.
// - A file is "ready" only after its asset is stored and the manifest records it.
// - Writes are never retried. A failed step leaves a "pending" or "failed" record, which is cleaned up later.
// - Every lookup runs inside the caller's own manifest, so one user cannot reach another user's files.
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { AppError, ConflictError } = require('./errors');
const { manifestPath } = require('./paths');
const { GitHubError } = require('./github-releases');

const MB = 1024 * 1024;
const DEFAULT_LIMITS = {
  maxFileBytes: 25 * MB, // per file
  userQuotaBytes: 200 * MB, // all of a user's files
  maxFiles: 200, // per user; keeps the manifest small enough to read in one request
  maxConcurrentUploads: 4, // the server keeps uploads on disk while they are checked
};
const PENDING_STALE_MS = 15 * 60 * 1000;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /^[a-f0-9]{32}$/;
const COUNTED = new Set(['pending', 'ready', 'deleting']); // statuses that use quota

const iso = (ms) => new Date(ms).toISOString();

// What the client may see. No tags, release ids, or asset ids.
function publicFile(entry) {
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    category: entry.category,
    size: entry.size,
    uploadedAt: entry.createdAt,
    status: entry.status === 'deleting' ? 'deleting' : 'ready',
  };
}

function usage(files) {
  const counted = files.filter((f) => COUNTED.has(f.status));
  return { usedBytes: counted.reduce((sum, f) => sum + f.size, 0), count: counted.length };
}

// Maps storage errors to client errors. Rate limits get their own code so the UI can say so.
function clientError(err) {
  if (err instanceof AppError) return err;
  if (err instanceof GitHubError && err.rateLimited) {
    return new AppError(503, 'RATE_LIMITED', 'GitHub is rate limiting requests. Try again later.');
  }
  return err;
}

class FileService {
  constructor({ storage, releases, now = Date.now, limits = {}, tmpDir } = {}) {
    this.storage = storage;
    this.releases = releases;
    this.now = now;
    this.limits = { ...DEFAULT_LIMITS, ...limits };
    this.locks = new Map();
    this.inFlight = 0; // uploads running now, for the global cap in server.js
    this.inflight = 0;
    this.tmpDir = tmpDir || fs.mkdtempSync(path.join(os.tmpdir(), 'filestore-'));
    fs.mkdirSync(this.tmpDir, { recursive: true, mode: 0o700 });
  }

  // One change at a time per user, in this process. Storage's SHA check covers other processes.
  async lock(uid, fn) {
    const prev = this.locks.get(uid) || Promise.resolve();
    let done;
    const current = new Promise((resolve) => (done = resolve));
    const tail = prev.then(() => current);
    this.locks.set(uid, tail);
    await prev;
    try {
      return await fn();
    } finally {
      done();
      if (this.locks.get(uid) === tail) this.locks.delete(uid);
    }
  }

  // mutate(manifest) returns { save, value }. Nothing is written when save is false or mutate throws.
  async withManifest(uid, mutate) {
    return this.lock(uid, async () => {
      const p = manifestPath(uid);
      const stored = await this.storage.readJson(p);
      const manifest = stored ? stored.data : { version: 1, files: [] };
      const { save, value } = await mutate(manifest);
      if (save) {
        if (stored) {
          await this.storage.updateJson(p, manifest, stored.sha, 'Update upload manifest');
        } else {
          const made = await this.storage.createJson(p, manifest, 'Create upload manifest');
          if (made === 'exists') throw new ConflictError('The upload manifest changed.');
        }
      }
      return value;
    });
  }

  // Deletes the release for an upload tag. With requireEmpty, leaves the release if it still holds assets.
  // A release holds one upload's asset, so deleting it never removes anyone else's file.
  async removeRelease(tag, { requireEmpty = false } = {}) {
    const release = await this.releases.findReleaseByTag(tag);
    if (release) {
      if (requireEmpty && release.assetCount > 0) return false;
      await this.releases.deleteRelease(release.id);
    }
    await this.releases.deleteTag(tag);
    return true;
  }

  // Cleans up failed and abandoned pending records. A record whose cleanup fails stays "failed" for the next try.
  async pruneOrphans(manifest) {
    const now = this.now();
    let changed = false;
    for (const entry of [...manifest.files]) {
      const abandoned = entry.status === 'pending' && now - entry.reservedAt > PENDING_STALE_MS;
      if (entry.status !== 'failed' && !abandoned) continue;
      try {
        await this.removeRelease(entry.tag);
        manifest.files = manifest.files.filter((f) => f !== entry);
      } catch (err) {
        entry.status = 'failed';
        console.error(`Cleanup of an upload record failed: ${err && err.name}`);
      }
      changed = true;
    }
    return changed;
  }

  // Storage must be private and writable before anything is reserved.
  async assertReady() {
    if (!this.releases) throw new AppError(503, 'FILES_NOT_CONFIGURED', 'File storage is not configured.');
    try {
      await this.releases.verifyStorage();
    } catch (err) {
      throw clientError(err);
    }
  }

  async list(uid, { q = '', category = '' } = {}) {
    const stored = await this.storage.readJson(manifestPath(uid));
    const files = stored ? stored.data.files : [];
    const needle = q.toLowerCase();
    const visible = files
      .filter((f) => f.status === 'ready' || f.status === 'deleting')
      .filter((f) => !category || f.category === category)
      .filter((f) => !needle || f.name.toLowerCase().includes(needle))
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const used = usage(files);
    return {
      files: visible.map(publicFile),
      quota: {
        usedBytes: used.usedBytes,
        limitBytes: this.limits.userQuotaBytes,
        count: used.count,
        maxFiles: this.limits.maxFiles,
      },
    };
  }

  // Stores one file. `input` holds the validated name and type and the path of the temp file on disk.
  // Returns { file, duplicate }. A repeat of an upload that already finished returns it with duplicate: true.
  async upload(uid, { uploadId, tmpPath, size, name, spec, ext }) {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new AppError(400, 'INVALID_UPLOAD_ID', 'The upload id must be a UUID.');
    if (this.inflight >= this.limits.maxConcurrentUploads) {
      throw new AppError(503, 'BUSY', 'Too many uploads are running. Try again in a moment.');
    }
    this.inflight += 1;
    try {
      await this.assertReady();

      const reserved = await this.withManifest(uid, async (m) => {
        const changed = await this.pruneOrphans(m);
        const existing = m.files.find((f) => f.uploadId === uploadId);
        if (existing && existing.status === 'ready') {
          return { save: changed, value: { entry: existing, duplicate: true } };
        }
        if (existing && existing.status === 'pending') {
          throw new AppError(409, 'UPLOAD_IN_PROGRESS', 'This upload is already in progress. Wait, then check your files.');
        }
        if (existing) {
          throw new AppError(409, 'UPLOAD_ID_USED', 'This file was already deleted. Start a new upload.');
        }
        const used = usage(m.files);
        if (used.usedBytes + size > this.limits.userQuotaBytes) {
          throw new AppError(507, 'QUOTA_EXCEEDED', 'Your storage is full. Delete some files to make room.');
        }
        if (used.count >= this.limits.maxFiles) {
          throw new AppError(507, 'FILE_LIMIT_REACHED', `You can keep up to ${this.limits.maxFiles} files.`);
        }
        const id = crypto.randomBytes(16).toString('hex');
        const entry = {
          id,
          uploadId,
          name,
          type: spec.mime,
          category: spec.category,
          ext,
          size,
          status: 'pending',
          createdAt: iso(this.now()),
          reservedAt: this.now(),
          tag: `upload-${id}`,
          assetId: null,
        };
        m.files.push(entry);
        return { save: true, value: { entry, duplicate: false } };
      });
      if (reserved.duplicate) return { file: publicFile(reserved.entry), duplicate: true };

      const { entry } = reserved;
      let assetId;
      try {
        const release = await this.releases.createRelease(
          entry.tag,
          `Upload ${entry.id}`,
          'Stored file for the file storage app. Managed by the app; do not edit.',
        );
        const asset = await this.releases.uploadAsset(release.id, `${entry.id}${ext}`, tmpPath, size, spec.mime);
        assetId = asset.id;
      } catch (err) {
        await this.failUpload(uid, entry.id);
        throw clientError(err);
      }

      try {
        const ready = await this.withManifest(uid, async (m) => {
          const e = m.files.find((f) => f.id === entry.id);
          if (!e) throw new ConflictError('The upload record is missing.');
          e.status = 'ready';
          e.assetId = assetId;
          e.readyAt = iso(this.now());
          return { save: true, value: e };
        });
        return { file: publicFile(ready), duplicate: false };
      } catch (err) {
        // The file is stored but the record is not. The record stays pending and is cleaned up after 15 minutes.
        console.error(`Upload ${entry.id} is stored but its record was not saved: ${err && err.name}`);
        throw clientError(err);
      }
    } finally {
      this.inflight -= 1;
    }
  }

  // Best effort: removes the release and marks the record failed. If cleanup fails, the record stays failed and
  // is retried by pruneOrphans later.
  async failUpload(uid, fileId) {
    try {
      await this.withManifest(uid, async (m) => {
        const e = m.files.find((f) => f.id === fileId);
        if (!e) return { save: false };
        try {
          await this.removeRelease(e.tag);
          m.files = m.files.filter((f) => f !== e);
        } catch (err) {
          e.status = 'failed';
          console.error(`Cleanup of failed upload ${fileId} did not finish: ${err && err.name}`);
        }
        return { save: true };
      });
    } catch (err) {
      console.error(`Failed upload ${fileId} could not be recorded: ${err && err.name}`);
    }
  }

  // Returns { file, res } where res is the streamed asset. Callers must consume or cancel res.body.
  async download(uid, fileId) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    await this.assertReady();
    const stored = await this.storage.readJson(manifestPath(uid));
    const entry = stored && stored.data.files.find((f) => f.id === fileId && f.status === 'ready');
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    const res = await this.releases.openAsset(entry.assetId);
    if (!res) throw new AppError(404, 'FILE_MISSING', 'This file is no longer available.');
    return { file: publicFile(entry), res };
  }

  // Deletes one file: its asset, then its release if empty, then its record. Each step can be retried. A file
  // that failed partway stays "deleting" and can be deleted again.
  async remove(uid, fileId) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    await this.assertReady();
    const target = await this.withManifest(uid, async (m) => {
      const e = m.files.find((f) => f.id === fileId);
      if (!e || e.status === 'failed') throw new AppError(404, 'NOT_FOUND', 'File not found.');
      if (e.status === 'pending') {
        throw new AppError(409, 'UPLOAD_IN_PROGRESS', 'This upload is still running and cannot be deleted yet.');
      }
      const save = e.status !== 'deleting';
      e.status = 'deleting';
      return { save, value: { assetId: e.assetId, tag: e.tag } };
    });

    try {
      if (target.assetId) await this.releases.deleteAsset(target.assetId);
      const removed = await this.removeRelease(target.tag, { requireEmpty: true });
      // Only happens if the release held something other than this file. That is left alone and logged.
      if (!removed) console.error(`Release for file ${fileId} still holds other assets; it was left in place.`);
    } catch (err) {
      throw clientError(err);
    }

    await this.withManifest(uid, async (m) => {
      m.files = m.files.filter((f) => f.id !== fileId);
      return { save: true };
    });
    return { id: fileId, deleted: true };
  }
}

module.exports = { FileService, DEFAULT_LIMITS, publicFile, UPLOAD_ID_RE, FILE_ID_RE };
