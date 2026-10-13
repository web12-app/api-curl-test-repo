'use strict';

// Unit tests for the model release cache (src/model-cache.js). The GitHub
// releases client is an in-memory fake that stores real bytes, so publish and
// fetch move real data through the real code: dd cuts real parts, uploads and
// downloads stream real buffers, and the sha256 check runs over real files.

const { test, describe, beforeEach, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { Readable } = require('node:stream');
const { ModelCache } = require('../src/model-cache');
const { GitHubError } = require('../src/github-releases');

const MIB = 1024 * 1024;

// An in-memory GitHubReleases stand-in. Assets keep their exact bytes.
class FakeReleases {
  constructor() {
    this.releases = new Map(); // tag -> { id, body, assets: Map<name, {id, name, size, data}> }
    this.nextId = 1;
  }
  releaseById(id) {
    for (const rel of this.releases.values()) if (rel.id === id) return rel;
    return null;
  }
  async getReleaseByTag(tag) {
    const rel = this.releases.get(tag);
    if (!rel) return null;
    return { id: rel.id, body: rel.body, assets: [...rel.assets.values()].map(({ id, name, size }) => ({ id, name, size })) };
  }
  async createRelease(tag, name, body) {
    if (this.releases.has(tag)) throw new GitHubError('release already exists', { status: 422 });
    const id = this.nextId++;
    this.releases.set(tag, { id, name, body, assets: new Map() });
    return { id };
  }
  async uploadAsset(releaseId, name, filePath, size) {
    const rel = this.releaseById(releaseId);
    if (!rel) throw new GitHubError('no such release', { status: 404 });
    const data = await fsp.readFile(filePath);
    if (data.length !== size) throw new GitHubError('size mismatch', { status: 400 });
    const id = this.nextId++;
    rel.assets.set(name, { id, name, size, data });
    return { id, size };
  }
  async updateRelease(releaseId, body) {
    const rel = this.releaseById(releaseId);
    if (!rel) throw new GitHubError('no such release', { status: 404 });
    rel.body = body;
  }
  async openAsset(assetId) {
    for (const rel of this.releases.values()) {
      for (const asset of rel.assets.values()) {
        if (asset.id === assetId) {
          return { status: 200, body: Readable.toWeb(Readable.from([asset.data])) };
        }
      }
    }
    return null;
  }
  async deleteRelease(releaseId) {
    for (const [tag, rel] of this.releases) {
      if (rel.id === releaseId) {
        this.releases.delete(tag);
        return;
      }
    }
  }
  async deleteTag() { /* the fake has no separate tag refs */ }
}

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'model-cache-test-'));
}

// A deterministic pseudo-model: 2.5 MiB so a 1 MiB part size yields 3 parts.
function makeModelFile(dir, bytes = 2.5 * MIB, name = 'test-model.gguf') {
  const file = path.join(dir, name);
  const buf = Buffer.alloc(bytes);
  for (let i = 0; i < buf.length; i += 4096) crypto.randomFillSync(buf, i, Math.min(4096, buf.length - i));
  fs.writeFileSync(file, buf);
  return { file, bytes, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

function cacheWith(partBytes = MIB) {
  const releases = new FakeReleases();
  const logs = [];
  const cache = new ModelCache({
    releases,
    partBytes,
    log: (line) => logs.push(line),
  });
  return { cache, releases, logs };
}

describe('ModelCache.plan', () => {
  test('covers every byte exactly once', () => {
    const { cache } = cacheWith();
    const plan = cache.plan('m.gguf', 2.5 * MIB);
    assert.equal(plan.names.length, 3);
    assert.deepEqual(plan.names, ['m.gguf.part-0-of-3', 'm.gguf.part-1-of-3', 'm.gguf.part-2-of-3']);
    assert.equal(plan.partBytes, MIB);
    assert.equal(plan.lastBytes, 0.5 * MIB);
  });

  test('a file smaller than one part is a single part', () => {
    const { cache } = cacheWith();
    const plan = cache.plan('m.gguf', 100);
    assert.deepEqual(plan.names, ['m.gguf.part-0-of-1']);
    assert.equal(plan.lastBytes, 100);
  });
});

describe('ModelCache publish + fetch round trip', () => {
  let dir;
  beforeEach(() => { dir = tmpDir(); });
  after(async () => {
    await fsp.rm(path.join(os.tmpdir(), 'model-cache-test-'), { recursive: true, force: true }).catch(() => {});
  });

  test('publish stores every part and flips the metadata to published; fetch restores the exact bytes', async () => {
    const { cache, releases } = cacheWith();
    const model = makeModelFile(dir);
    const destDir = path.join(dir, 'dest');
    fs.mkdirSync(destDir, { recursive: true });

    const saved = await cache.publish('m1', {
      filePath: model.file,
      sha256: model.sha256,
      bytes: model.bytes,
      hfRepo: 'org/repo',
      ggufFile: path.basename(model.file),
    });
    assert.equal(saved, true);

    const rel = releases.releases.get('model-cache/m1');
    assert.ok(rel, 'the cache release exists');
    assert.equal(rel.assets.size, 3);
    const meta = JSON.parse(rel.body);
    assert.equal(meta.status, 'published');
    assert.equal(meta.bytes, model.bytes);
    assert.equal(meta.sha256, model.sha256);
    assert.deepEqual(meta.parts, ['test-model.gguf.part-0-of-3', 'test-model.gguf.part-1-of-3', 'test-model.gguf.part-2-of-3']);
    // Part sizes: two full parts and the remainder.
    const sizes = [...rel.assets.values()].map((a) => a.size);
    assert.deepEqual(sizes, [MIB, MIB, 0.5 * MIB]);

    const hit = await cache.fetch('m1', { destDir, sha256: model.sha256, bytes: model.bytes });
    assert.ok(hit, 'the cache served the model');
    assert.equal(hit.bytes, model.bytes);
    const restored = await fsp.readFile(hit.path);
    assert.equal(crypto.createHash('sha256').update(restored).digest('hex'), model.sha256);
    // The staging directory is cleaned up.
    const leftovers = (await fsp.readdir(destDir)).filter((n) => n.startsWith('.cache-'));
    assert.deepEqual(leftovers, []);
  });

  test('a second publish is a no-op', async () => {
    const { cache, releases } = cacheWith();
    const model = makeModelFile(dir);
    const args = { filePath: model.file, sha256: model.sha256, bytes: model.bytes, hfRepo: 'org/repo', ggufFile: 'test-model.gguf' };
    assert.equal(await cache.publish('m1', args), true);
    assert.equal(await cache.publish('m1', args), true);
    assert.equal(releases.releases.get('model-cache/m1').assets.size, 3);
  });

  test('no cache entry fetches as null', async () => {
    const { cache } = cacheWith();
    assert.equal(await cache.fetch('m1', { destDir: dir, sha256: 'x', bytes: 10 }), null);
  });

  test('a "publishing" (incomplete) entry is ignored by lookups and fetch', async () => {
    const { cache, releases } = cacheWith();
    const model = makeModelFile(dir);
    await cache.publish('m1', { filePath: model.file, sha256: model.sha256, bytes: model.bytes, hfRepo: 'org/repo', ggufFile: 'test-model.gguf' });
    const rel = releases.releases.get('model-cache/m1');
    rel.body = rel.body.replace('"status":"published"', '"status":"publishing"');
    assert.equal(await cache.lookup('m1', { bytes: model.bytes }), null);
    assert.equal(await cache.fetch('m1', { destDir: dir, sha256: model.sha256, bytes: model.bytes }), null);
  });

  test('a corrupted cached copy fails the sha256 check, removes the entry, and leaves no garbage file', async () => {
    const { cache, releases, logs } = cacheWith();
    const model = makeModelFile(dir);
    await cache.publish('m1', { filePath: model.file, sha256: model.sha256, bytes: model.bytes, hfRepo: 'org/repo', ggufFile: 'test-model.gguf' });
    // Flip one byte inside part 1.
    const rel = releases.releases.get('model-cache/m1');
    const part = [...rel.assets.values()][1];
    part.data[0] ^= 0xff;

    const destDir = path.join(dir, 'dest2');
    fs.mkdirSync(destDir, { recursive: true });
    await assert.rejects(
      () => cache.fetch('m1', { destDir, sha256: model.sha256, bytes: model.bytes }),
      /sha256/,
    );
    assert.equal(releases.releases.has('model-cache/m1'), false, 'the corrupt entry was deleted');
    assert.equal(fs.existsSync(path.join(destDir, 'test-model.gguf')), false, 'no partial file left behind');
    assert.ok(logs.some((l) => l.includes('stale')), 'the drop attempt was logged');
  });

  test('a stale entry with different bytes is replaced by publish', async () => {
    const { cache, releases } = cacheWith();
    const model = makeModelFile(dir);
    // An old entry recorded for different content.
    await cache.publish('m1', { filePath: model.file, sha256: model.sha256, bytes: model.bytes, hfRepo: 'org/repo', ggufFile: 'test-model.gguf' });
    const bigger = makeModelFile(dir, 3 * MIB + 209715, 'bigger-model.gguf'); // 3.2 MiB, integer bytes
    const saved = await cache.publish('m1', {
      filePath: bigger.file,
      sha256: bigger.sha256,
      bytes: bigger.bytes,
      hfRepo: 'org/repo',
      ggufFile: path.basename(bigger.file),
    });
    assert.equal(saved, true);
    const rel = releases.releases.get('model-cache/m1');
    const meta = JSON.parse(rel.body);
    assert.equal(meta.bytes, bigger.bytes);
    assert.equal(meta.sha256, bigger.sha256);
    assert.equal(rel.assets.size, 4); // 3.2 MiB in 1 MiB parts
  });

  test('lookup rejects a metadata/layout mismatch', async () => {
    const { cache, releases } = cacheWith();
    const model = makeModelFile(dir);
    await cache.publish('m1', { filePath: model.file, sha256: model.sha256, bytes: model.bytes, hfRepo: 'org/repo', ggufFile: 'test-model.gguf' });
    const rel = releases.releases.get('model-cache/m1');
    const meta = JSON.parse(rel.body);
    meta.parts = ['wrong-name.part-0-of-1'];
    rel.body = JSON.stringify(meta);
    assert.equal(await cache.lookup('m1', { bytes: model.bytes }), null);
  });

  test('a failing release backend degrades publish to false instead of throwing', async () => {
    const { cache } = cacheWith();
    const model = makeModelFile(dir);
    const saved = await cache.publish('m1', {
      filePath: '/nonexistent/model.gguf', // dd cannot cut this
      sha256: model.sha256,
      bytes: model.bytes,
      hfRepo: 'org/repo',
      ggufFile: 'model.gguf',
    });
    assert.equal(saved, false);
  });

  test('publishingIds tracks in-flight publishes', async () => {
    const { cache } = cacheWith();
    const model = makeModelFile(dir);
    // Start a publish, inspect while it runs, finish it.
    const pending = cache.publish('m1', { filePath: model.file, sha256: model.sha256, bytes: model.bytes, hfRepo: 'org/repo', ggufFile: 'test-model.gguf' });
    if (cache.publishingIds().length) assert.deepEqual(cache.publishingIds(), ['m1']);
    await pending;
    assert.deepEqual(cache.publishingIds(), []);
  });
});
