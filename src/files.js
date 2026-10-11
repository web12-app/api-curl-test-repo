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
const { manifestPath, sharePath, uploadLinkPath } = require('./paths');
const { maskName, ref } = require('./redact');
const { isPreviewable } = require('./file-types');
const { GitHubError } = require('./github-releases');

const MB = 1024 * 1024;
const GB = 1024 * MB;
const DEFAULT_LIMITS = {
  // GitHub itself caps one release asset at 2 GiB, so that is the real ceiling. There is no smaller app cap:
  // large files are sent automatically in pieces, and the browser shows the size this service reports.
  maxFileBytes: 2 * GB, // per file
  // No file count limit. The manifest is the whole file list, so it grows with use; the room checks below
  // skip the count entirely when this limit is not finite. Tests pass small finite numbers.
  maxFiles: Infinity,
  maxConcurrentUploads: 4, // the server keeps uploads on disk while they are checked
  linkMaxFiles: 20, // per upload link: files it may bring in
  linkMaxBytes: 500 * MB, // per upload link: total bytes it may bring in
  maxLinks: 20, // active upload links per user
};
const PENDING_STALE_MS = 15 * 60 * 1000;
const UPLOAD_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FILE_ID_RE = /^[a-f0-9]{32}$/;
const COUNTED = new Set(['pending', 'ready', 'deleting']); // statuses counted in the file count and total size
const SHARE_TOKEN_BYTES = 32; // 256 bits; encodes to 43 URL-safe characters
const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

const iso = (ms) => new Date(ms).toISOString();

// What the client may see. No tags, release ids, or asset ids. The share path is shown only for public files, to the
// owner (listing and sharing responses). Public readers get it from the link itself.
function publicFile(entry) {
  const isPublic = entry.visibility === 'public' && typeof entry.shareToken === 'string';
  return {
    id: entry.id,
    name: entry.name,
    type: entry.type,
    category: entry.category,
    size: entry.size,
    uploadedAt: entry.createdAt,
    status: entry.status === 'deleting' ? 'deleting' : 'ready',
    visibility: isPublic ? 'public' : 'private',
    sharePath: isPublic ? `/s/${entry.shareToken}` : null,
    viaLink: Boolean(entry.linkId),
    previewable: isPreviewable(entry.name),
  };
}

const newShareToken = () => crypto.randomBytes(SHARE_TOKEN_BYTES).toString('base64url');
const shareHashOf = (token) => crypto.createHash('sha256').update(token).digest('hex');

// Owner's view of an upload link. The path appears only while the link is open.
function publicLink(link) {
  const open = !link.revokedAt;
  return {
    id: link.id,
    label: link.label,
    createdAt: link.createdAt,
    revokedAt: link.revokedAt || null,
    active: open,
    uploadPath: open ? `/u/${link.token}` : null,
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
      quota: { usedBytes: used.usedBytes, count: used.count, maxFiles: this.limits.maxFiles },
    };
  }

  // Looks up an earlier upload by its client id. Returns { status: 'ready', file } or { status: 'pending' } or null.
  async findUpload(uid, uploadId) {
    const stored = await this.storage.readJson(manifestPath(uid));
    const entry = stored ? stored.data.files.find((f) => f.uploadId === uploadId) : null;
    if (!entry) return null;
    if (entry.status === 'ready') return { status: 'ready', file: publicFile(entry) };
    if (entry.status === 'pending') return { status: 'pending' };
    return null;
  }

  // Fails before any upload work starts when the account is already at its file limit.
  async assertRoom(uid) {
    const stored = await this.storage.readJson(manifestPath(uid));
    const used = usage(stored ? stored.data.files : []);
    if (Number.isFinite(this.limits.maxFiles) && used.count >= this.limits.maxFiles) {
      throw new AppError(507, 'FILE_LIMIT_REACHED', `You can keep up to ${this.limits.maxFiles} files.`);
    }
  }

  // Stores one file. `input` holds the validated name and type and the path of the temp file on disk.
  // Returns { file, duplicate }. A repeat of an upload that already finished returns it with duplicate: true.
  async upload(uid, { uploadId, tmpPath, size, name, spec, ext, linkId = null }) {
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
        if (Number.isFinite(this.limits.maxFiles) && used.count >= this.limits.maxFiles) {
          throw new AppError(507, 'FILE_LIMIT_REACHED', `You can keep up to ${this.limits.maxFiles} files.`);
        }
        if (linkId) {
          // The link must still be open. Its own limits count only the files it brought in.
          const link = m.uploadLinks && m.uploadLinks.find((l) => l.id === linkId);
          if (!link || link.revokedAt) throw new AppError(404, 'UPLOAD_LINK_CLOSED', 'This upload link is no longer active.');
          const via = m.files.filter((f) => f.linkId === linkId && COUNTED.has(f.status));
          if (via.length >= this.limits.linkMaxFiles) {
            throw new AppError(507, 'LINK_FILE_LIMIT', 'This upload link has reached its file limit.');
          }
          if (via.reduce((sum, f) => sum + f.size, 0) + size > this.limits.linkMaxBytes) {
            throw new AppError(507, 'LINK_SIZE_LIMIT', 'This upload link has reached its size limit.');
          }
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
          linkId: linkId || null,
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
        // Logged in masked form only (see redact.js). The owner's id, the file id, and the link appear as references.
        console.log(`upload stored: file=${maskName(name)} id=${ref(entry.id)} owner=${ref(uid)}${linkId ? ` link=${ref(linkId)}` : ''}`);
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

  async createUploadLink(uid, label) {
    await this.assertReady();
    return this.withManifest(uid, async (m) => {
      m.uploadLinks = m.uploadLinks || [];
      if (m.uploadLinks.filter((l) => !l.revokedAt).length >= this.limits.maxLinks) {
        throw new AppError(409, 'TOO_MANY_LINKS', `You can have up to ${this.limits.maxLinks} active upload links. Revoke one first.`);
      }
      const token = newShareToken();
      const hash = shareHashOf(token);
      const id = crypto.randomBytes(16).toString('hex');
      // The index is written before the manifest names the link, as with share links.
      const made = await this.storage.createJson(uploadLinkPath(hash), { uid, linkId: id }, 'Create upload link index');
      if (made === 'exists') throw new ConflictError('The upload link collided. Try again.');
      const link = { id, label, createdAt: iso(this.now()), revokedAt: null, tokenHash: hash, token };
      m.uploadLinks.push(link);
      console.log(`upload link created: link=${ref(id)} owner=${ref(uid)}`);
      return { save: true, value: publicLink(link) };
    });
  }

  async listUploadLinks(uid) {
    const stored = await this.storage.readJson(manifestPath(uid));
    const m = stored ? stored.data : { files: [], uploadLinks: [] };
    return (m.uploadLinks || []).map((link) => {
      const via = (m.files || []).filter((f) => f.linkId === link.id && f.status === 'ready');
      return { ...publicLink(link), uploads: via.length, usedBytes: via.reduce((sum, f) => sum + f.size, 0) };
    });
  }

  async revokeUploadLink(uid, linkId) {
    if (!FILE_ID_RE.test(linkId)) throw new AppError(404, 'NOT_FOUND', 'Upload link not found.');
    let hash = null;
    const view = await this.withManifest(uid, async (m) => {
      const link = (m.uploadLinks || []).find((l) => l.id === linkId);
      if (!link) throw new AppError(404, 'NOT_FOUND', 'Upload link not found.');
      if (link.revokedAt) return { save: false, value: publicLink(link) };
      link.revokedAt = iso(this.now());
      hash = link.tokenHash;
      console.log(`upload link revoked: link=${ref(linkId)} owner=${ref(uid)}`);
      return { save: true, value: publicLink(link) };
    });
    if (hash) await this.deleteIndex(uploadLinkPath(hash));
    return view;
  }

  // Resolves an upload link token. Returns { uid, link } for an open link, or null.
  async resolveUploadLink(token) {
    if (!SHARE_TOKEN_RE.test(token)) return null;
    const hash = shareHashOf(token);
    const index = await this.storage.readJson(uploadLinkPath(hash));
    if (!index || !FILE_ID_RE.test(index.data.linkId) || !/^[a-f0-9]{32}$/.test(index.data.uid)) return null;
    const stored = await this.storage.readJson(manifestPath(index.data.uid));
    const link = stored && (stored.data.uploadLinks || []).find((l) => l.id === index.data.linkId);
    return link && !link.revokedAt && link.tokenHash === hash ? { uid: index.data.uid, link } : null;
  }

  // Streams a ready entry's bytes. Returns { file, res}. Callers must consume or cancel res.body.
  async openEntry(entry) {
    await this.assertReady();
    const res = await this.releases.openAsset(entry.assetId);
    if (!res) throw new AppError(404, 'FILE_MISSING', 'This file is no longer available.');
    return { file: publicFile(entry), res };
  }

  // Owner's download. Returns { file, res } where res is the streamed asset.
  async download(uid, fileId) {
    const entry = await this.readReady(uid, fileId);
    return this.openEntry(entry);
  }

  // Owner's preview. Same bytes as download; the route decides how they are shown.
  async preview(uid, fileId) {
    const entry = await this.readReady(uid, fileId);
    return this.openEntry(entry);
  }

  async readReady(uid, fileId) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    const stored = await this.storage.readJson(manifestPath(uid));
    const entry = stored && stored.data.files.find((f) => f.id === fileId && f.status === 'ready');
    if (!entry) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    return entry;
  }

  // Turns sharing on or off for one ready file. Turning it on creates a new random link and saves it on the
  // server (in the owner's manifest). Turning it off ends the link. Turning on again makes a new link.
  // Order matters: the index for a new link is written before the manifest names it, so a failure in between
  // leaves an index that no manifest entry matches, which does nothing.
  async setSharing(uid, fileId, makePublic) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    await this.assertReady();
    let oldHash = null;
    const file = await this.withManifest(uid, async (m) => {
      const e = m.files.find((f) => f.id === fileId);
      if (!e || e.status === 'failed') throw new AppError(404, 'NOT_FOUND', 'File not found.');
      if (e.status === 'pending') throw new AppError(409, 'UPLOAD_IN_PROGRESS', 'This upload is still running.');
      if (e.status === 'deleting') throw new AppError(409, 'FILE_BUSY', 'This file is being deleted.');
      if (makePublic) {
        if (e.visibility === 'public' && e.shareToken) return { save: false, value: publicFile(e) };
        const token = newShareToken();
        const hash = shareHashOf(token);
        await this.createShareIndex(hash, { uid, fileId, createdAt: iso(this.now()) });
        e.visibility = 'public';
        e.shareToken = token;
        e.shareHash = hash;
        e.sharedAt = iso(this.now());
        console.log(`share enabled: file=${maskName(e.name)} id=${ref(fileId)}`);
        return { save: true, value: publicFile(e) };
      }
      if (e.visibility !== 'public' && !e.shareToken) return { save: false, value: publicFile(e) };
      oldHash = e.shareHash || null;
      e.visibility = 'private';
      e.shareToken = null;
      e.shareHash = null;
      e.sharedAt = null;
      return { save: true, value: publicFile(e) };
    });
    if (oldHash) await this.deleteShareIndex(oldHash);
    return { file };
  }

  // Resolves a share token to its owner's ready entry. Returns null for anything that is not a live link.
  async resolveShare(token) {
    if (!SHARE_TOKEN_RE.test(token)) return null;
    const hash = shareHashOf(token);
    const index = await this.storage.readJson(sharePath(hash));
    if (!index || !FILE_ID_RE.test(index.data.fileId) || !/^[a-f0-9]{32}$/.test(index.data.uid)) return null;
    const stored = await this.storage.readJson(manifestPath(index.data.uid));
    const entry = stored && stored.data.files.find((f) => f.id === index.data.fileId);
    const live =
      entry && entry.status === 'ready' && entry.visibility === 'public' && entry.shareHash === hash;
    return live ? { entry } : null;
  }

  async downloadShared(token) {
    const found = await this.resolveShare(token);
    if (!found) throw new AppError(404, 'NOT_FOUND', 'This link is not available.');
    return this.openEntry(found.entry);
  }

  async createShareIndex(hash, value) {
    const made = await this.storage.createJson(sharePath(hash), value, 'Create share link index');
    if (made === 'exists') throw new ConflictError('The share link collided. Try again.');
  }

  // Best effort. A leftover index does nothing, because the manifest no longer names its hash.
  async deleteShareIndex(hash) {
    await this.deleteIndex(sharePath(hash));
  }

  async deleteIndex(indexPath) {
    try {
      const stored = await this.storage.readJson(indexPath);
      if (stored) await this.storage.deleteJson(indexPath, stored.sha, 'Remove index file');
    } catch (err) {
      console.error(`An index file could not be removed: ${err && err.name}`);
    }
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
      return { save, value: { assetId: e.assetId, tag: e.tag, shareHash: e.shareHash || null } };
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
    if (target.shareHash) await this.deleteShareIndex(target.shareHash);
    return { id: fileId, deleted: true };
  }
}

module.exports = { FileService, DEFAULT_LIMITS, publicFile, publicLink, UPLOAD_ID_RE, FILE_ID_RE, SHARE_TOKEN_RE };
