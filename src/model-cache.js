'use strict';

// Release cache for chat model weights: "download once, load fast forever".
//
// Every fresh CI runner used to re-download the GGUF from the Hugging Face CDN
// (~10 GiB for the 27B model). This module saves each verified model file ONCE
// as release assets in the private data repository and restores it from there
// on every later start:
//
//   tag    model-cache/<model-id>
//   assets <gguf-file>.part-0-of-N ... .part-(N-1)-of-N   (each <= 1.9 GiB,
//          GitHub's asset ceiling is 2 GiB)
//   body   JSON metadata { v, model_id, hf_repo, gguf_file, bytes, sha256,
//          parts[], part_bytes, status: publishing|published, published_at }
//
// Integrity: the reassembled file must match the registry's sha256, so a cache
// can never serve different bytes than the HF source. A mismatched cache entry
// deletes itself and the caller falls back to the normal HF download.
//
// Publishing is strictly best-effort and runs in the background: it must never
// delay or fail the chat. A half-published entry (crash mid-upload) has
// status "publishing" and is ignored by lookups; the next publish replaces it.

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { GitHubError } = require('./github-releases');

// GitHub release assets are limited to 2 GiB each; 1900 MiB leaves headroom
// and is MiB-aligned so dd can cut exact parts.
const DEFAULT_PART_BYTES = 1900 * 1024 * 1024;
const DISK_SLACK_BYTES = 512 * 1024 * 1024;
// Uploading ~1.9 GiB can take a while behind a slow link; 30 min per part.
const PART_UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
const MIB = 1024 * 1024;

function sha256File(file) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(file);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

class ModelCache {
  // `releases` is a GitHubReleases client for the private data repository.
  constructor({ releases, partBytes = DEFAULT_PART_BYTES, log = () => {} }) {
    this.releases = releases;
    this.partBytes = partBytes;
    this.log = log;
    this._publishing = new Map(); // model id -> in-flight publish promise
  }

  tagFor(modelId) {
    return `model-cache/${modelId}`;
  }

  // Deterministic part layout: every part is partBytes except the last.
  plan(ggufFile, bytes) {
    const count = Math.max(1, Math.ceil(bytes / this.partBytes));
    const names = [];
    for (let i = 0; i < count; i++) names.push(`${ggufFile}.part-${i}-of-${count}`);
    return { names, partBytes: this.partBytes, lastBytes: bytes - (count - 1) * this.partBytes };
  }

  parseMeta(body) {
    try {
      const meta = JSON.parse(body);
      if (!meta || meta.v !== 1 || meta.status !== 'published') return null;
      if (typeof meta.gguf_file !== 'string' || !meta.gguf_file) return null;
      if (!Number.isFinite(meta.bytes) || meta.bytes <= 0) return null;
      if (typeof meta.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(meta.sha256)) return null;
      if (!Array.isArray(meta.parts) || !meta.parts.length) return null;
      return meta;
    } catch {
      return null;
    }
  }

  // Usable cache entry for a model, or null. Checks that the metadata matches
  // the deterministic part layout and that every part exists with its exact
  // expected size.
  async lookup(modelId, { bytes } = {}) {
    let release;
    try {
      release = await this.releases.getReleaseByTag(this.tagFor(modelId));
    } catch (err) {
      // An unreachable data repo means "no cache", never a chat failure.
      this.log(`lookup for ${modelId} failed: ${err && err.message ? err.message : err}`);
      return null;
    }
    if (!release) return null;
    const meta = this.parseMeta(release.body);
    if (!meta) return null;
    if (bytes !== undefined && meta.bytes !== bytes) return null;
    const layout = this.plan(meta.gguf_file, meta.bytes);
    if (meta.parts.join('\n') !== layout.names.join('\n')) return null;
    const byName = new Map((release.assets || []).map((a) => [a.name, a]));
    const parts = [];
    for (let i = 0; i < layout.names.length; i++) {
      const asset = byName.get(layout.names[i]);
      if (!asset) return null;
      const expected = i === layout.names.length - 1 ? layout.lastBytes : layout.partBytes;
      if (asset.size !== expected) return null;
      parts.push(asset);
    }
    return { releaseId: release.id, meta, parts };
  }

  // Restores the cached model into destDir. Returns { path, bytes } or null
  // when the cache holds no usable entry. Throws on transfer or integrity
  // errors so the caller can fall back to the source download; a sha256
  // mismatch deletes the cache entry itself. Disk-friendly: parts are appended
  // to the destination as they arrive, so at most one part is ever staged.
  async fetch(modelId, { destDir, sha256, bytes }) {
    const hit = await this.lookup(modelId, { bytes });
    if (!hit) return null;
    const dest = path.join(destDir, hit.meta.gguf_file);
    const staging = path.join(destDir, `.cache-${modelId}-${process.pid}`);
    await fsp.mkdir(staging, { recursive: true });
    const out = fs.createWriteStream(dest, { flags: 'w' });
    try {
      for (let i = 0; i < hit.parts.length; i++) {
        const asset = hit.parts[i];
        const partFile = path.join(staging, String(i));
        const res = await this.releases.openAsset(asset.id);
        if (!res) throw new Error(`the cached part ${asset.name} is gone`);
        await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(partFile));
        const size = (await fsp.stat(partFile)).size;
        const expected = i === hit.parts.length - 1 ? hit.meta.bytes - (hit.parts.length - 1) * this.partBytes : this.partBytes;
        if (size !== expected) {
          throw new Error(`the cached part ${asset.name} holds ${size} bytes, expected ${expected}`);
        }
        await pipeline(fs.createReadStream(partFile), out, { end: false });
        await fsp.unlink(partFile).catch(() => {});
      }
      await new Promise((resolve, reject) => {
        out.end(() => resolve());
        out.on('error', reject);
      });
      const digest = await sha256File(dest);
      if (digest !== String(sha256 || hit.meta.sha256).toLowerCase()) {
        await this.drop(hit.releaseId, this.tagFor(modelId));
        throw new Error('the cached copy failed its sha256 check; the cache entry was removed');
      }
      return { path: dest, bytes: hit.meta.bytes };
    } catch (err) {
      // Never leave a partial reassembly on disk.
      await fsp.unlink(dest).catch(() => {});
      throw err;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
      out.destroy();
    }
  }

  // Saves a verified model file into the cache. Serialized per model; a
  // concurrent call for the same model is skipped. Returns true when a usable
  // cache entry exists afterwards. Never throws: every failure is logged.
  async publish(modelId, { filePath, sha256, bytes, hfRepo, ggufFile }) {
    if (this._publishing.has(modelId)) {
      this.log(`a publish for ${modelId} is already running; skipped`);
      return false;
    }
    const task = this._publish(modelId, { filePath, sha256, bytes, hfRepo, ggufFile });
    this._publishing.set(modelId, task);
    try {
      return await task;
    } catch (err) {
      const message = err instanceof GitHubError ? err.message : (err && err.message) || String(err);
      this.log(`publishing ${modelId} failed (the chat is unaffected; the next download retries): ${message}`);
      return false;
    } finally {
      this._publishing.delete(modelId);
    }
  }

  publishingIds() {
    return Array.from(this._publishing.keys());
  }

  async _publish(modelId, { filePath, sha256, bytes, hfRepo, ggufFile }) {
    const tag = this.tagFor(modelId);
    const existing = await this.lookup(modelId, { bytes });
    if (existing) {
      this.log(`${modelId} is already cached (${existing.parts.length} parts); publish skipped`);
      return true;
    }
    // A stale or superseded entry (crashed publish, different size) must not block the new one.
    const stale = await this.releases.getReleaseByTag(tag);
    if (stale) {
      this.log(`replacing the stale cache release for ${modelId}`);
      await this.drop(stale.id, tag);
    }

    const layout = this.plan(ggufFile, bytes);
    if (!(await this.hasDiskFor(layout.partBytes, path.dirname(filePath)))) {
      this.log(`not enough disk space to stage parts of ${modelId}; publish skipped`);
      return false;
    }

    const bodyOf = (status) => JSON.stringify({
      v: 1,
      model_id: modelId,
      hf_repo: hfRepo,
      gguf_file: ggufFile,
      bytes,
      sha256,
      parts: layout.names,
      part_bytes: layout.partBytes,
      status,
      published_at: new Date().toISOString(),
    });
    const release = await this.releases.createRelease(tag, `Model cache: ${modelId}`, bodyOf('publishing'));
    const staging = path.join(path.dirname(filePath), `.publish-${modelId}-${process.pid}`);
    await fsp.mkdir(staging, { recursive: true });
    try {
      for (let i = 0; i < layout.names.length; i++) {
        const length = i === layout.names.length - 1 ? layout.lastBytes : layout.partBytes;
        const partFile = path.join(staging, String(i));
        await this.extractPart(filePath, i * layout.partBytes, length, partFile);
        const size = (await fsp.stat(partFile)).size;
        if (size !== length) throw new Error(`cutting part ${i} produced ${size} bytes, expected ${length}`);
        await this.releases.uploadAsset(release.id, layout.names[i], partFile, size, 'application/octet-stream', PART_UPLOAD_TIMEOUT_MS);
        await fsp.unlink(partFile).catch(() => {});
        this.log(`uploaded part ${i + 1}/${layout.names.length} of ${modelId}`);
      }
      await this.releases.updateRelease(release.id, bodyOf('published'));
      this.log(`${modelId} is cached for future starts (${bytes} bytes in ${layout.names.length} parts)`);
      return true;
    } catch (err) {
      // Never leave a half-published release behind: the next attempt starts clean.
      await this.drop(release.id, tag);
      throw err;
    } finally {
      await fsp.rm(staging, { recursive: true, force: true }).catch(() => {});
    }
  }

  // One part (<= partBytes) must fit next to the model file.
  async hasDiskFor(partBytes, dir) {
    try {
      const st = await fsp.statfs(dir);
      return st.bsize * st.bavail > partBytes + DISK_SLACK_BYTES;
    } catch {
      return true; // unknown: try anyway, the upload fails honestly if it must
    }
  }

  // Cuts [skipBytes, skipBytes + lengthBytes) out of the model file with dd.
  // partBytes is MiB-aligned, and the final part ends at EOF, so MiB blocks
  // cover every boundary exactly.
  extractPart(file, skipBytes, lengthBytes, dest) {
    return new Promise((resolve, reject) => {
      const skip = Math.floor(skipBytes / MIB);
      const count = Math.ceil(lengthBytes / MIB);
      const child = spawn('dd', [`if=${file}`, `of=${dest}`, 'bs=1M', `skip=${skip}`, `count=${count}`], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      let err = '';
      child.stderr.on('data', (chunk) => { err += chunk; });
      child.on('error', reject);
      child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`dd could not cut the part (exit ${code}): ${err.slice(-200)}`))));
    });
  }

  // Removes a cache release and its tag. Best-effort on purpose.
  async drop(releaseId, tag) {
    try {
      await this.releases.deleteRelease(releaseId);
      await this.releases.deleteTag(tag);
      this.log(`removed the stale cache entry on ${tag}`);
    } catch (err) {
      this.log(`could not remove the stale cache entry: ${err && err.message ? err.message : err}`);
    }
  }
}

module.exports = { ModelCache, DEFAULT_PART_BYTES };
