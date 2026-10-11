'use strict';

// Tube: YouTube-like channels and published videos, layered on top of the file storage.
//
// Everything lives in ONE JSON document, system/tube.json, in the private data repository. It is read and
// written with the exact same helpers the accounts and upload manifests use (storage.readJson /
// createJson / updateJson, SHA-guarded), so the in-memory double used by the tests works unchanged.
//
// Document shape:
// {
//   "version":  1,
//   "channels": { "<username>": { name, description, logoFileId, createdAt } },
//   "videos":   { "<fileId>":   { owner, title, description, thumbnailFileId, publishedAt } }
// }
//
// Rules this module keeps:
// - Only ready files from the owner's own manifest can be published or used as a logo/thumbnail.
// - Deleting a channel also unpublishes that channel's videos, so the feed never shows a video
//   whose channel is gone.
// - A video whose backing file was deleted (or is not ready) is skipped in views; the record stays
//   and disappears from the feed until the owner unpublishes it.
const { AppError, ConflictError } = require('./errors');
const { tubePath, usernamePath, manifestPath, USERNAME_RE } = require('./paths');
const { FILE_ID_RE } = require('./files');

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const VIDEO_TITLE_MAX = 120;
const VIDEO_DESCRIPTION_MAX = 2000;
const USER_ID_RE = /^[a-f0-9]{32}$/;

const iso = (ms) => new Date(ms).toISOString();

// What the client sees for a channel. The logo points at the existing per-file preview endpoint -
// the Tube access rule lets any signed-in user load a logo that is in use.
function publicChannel(username, ch) {
  return {
    username,
    name: ch.name,
    description: ch.description || '',
    logoUrl: ch.logoFileId ? `/api/files/${ch.logoFileId}/preview` : null,
    createdAt: ch.createdAt,
  };
}

// One feed row: the video joined with its file entry (mime, size) and its channel (name, logo).
function videoItem(fileId, rec, entry, channel) {
  return {
    fileId,
    owner: rec.owner,
    channelName: channel ? channel.name : rec.owner,
    channelLogoUrl: channel && channel.logoFileId ? `/api/files/${channel.logoFileId}/preview` : null,
    title: rec.title,
    description: rec.description || '',
    thumbnailUrl: rec.thumbnailFileId ? `/api/files/${rec.thumbnailFileId}/preview` : null,
    mime: entry.type,
    size: entry.size,
    publishedAt: rec.publishedAt,
  };
}

function checkChannelName(name) {
  if (typeof name !== 'string' || !name.trim() || name.trim().length > NAME_MAX) {
    throw new AppError(400, 'INVALID_NAME', `The channel name must be 1-${NAME_MAX} characters.`);
  }
  return name.trim();
}

function checkOptionalText(value, max, code, message) {
  if (value === undefined || value === null || value === '') return '';
  if (typeof value !== 'string' || value.length > max) {
    throw new AppError(400, code, message);
  }
  return value.trim();
}

class TubeService {
  // storage: the private data repository client (GitHubStorage, or MemoryStorage in tests).
  // files:   the FileService, used to check that referenced files exist, are ready, and are owned.
  constructor({ storage, files, now = Date.now } = {}) {
    this.storage = storage;
    this.files = files;
    this.now = now;
    this.lockTail = null; // serializes writes to the single document within this process
  }

  emptyDoc() {
    return { version: 1, channels: {}, videos: {} };
  }

  // Read-modify-write with the storage SHA check, like withManifest. One change at a time in this
  // process (the document is global, so one lock serves every user); the SHA check covers others.
  async lock(fn) {
    const prev = this.lockTail || Promise.resolve();
    let done;
    const current = new Promise((resolve) => (done = resolve));
    this.lockTail = prev.then(() => current);
    await prev;
    try {
      return await fn();
    } finally {
      done();
      if (this.lockTail === current) this.lockTail = null;
    }
  }

  async update(mutate) {
    return this.lock(async () => {
      const stored = await this.storage.readJson(tubePath());
      const doc = stored ? this.sanitize(stored.data) : this.emptyDoc();
      const { save, value } = await mutate(doc);
      if (save) {
        if (stored) {
          await this.storage.updateJson(tubePath(), doc, stored.sha, 'Update Tube channels and videos');
        } else {
          const made = await this.storage.createJson(tubePath(), doc, 'Create Tube document');
          if (made === 'exists') throw new ConflictError('The Tube data changed.');
        }
      }
      return value;
    });
  }

  // Tolerates a hand-edited or partially written document: missing maps become empty, junk entries drop.
  sanitize(doc) {
    const out = this.emptyDoc();
    if (doc && typeof doc === 'object') {
      if (doc.channels && typeof doc.channels === 'object' && !Array.isArray(doc.channels)) out.channels = doc.channels;
      if (doc.videos && typeof doc.videos === 'object' && !Array.isArray(doc.videos)) out.videos = doc.videos;
    }
    return out;
  }

  async readDoc() {
    const stored = await this.storage.readJson(tubePath());
    return stored ? this.sanitize(stored.data) : this.emptyDoc();
  }

  // username -> user id, via the same username index the login flow reads. Null when unknown.
  async uidFor(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return null;
    const claim = await this.storage.readJson(usernamePath(username));
    const id = claim && claim.data.user_id;
    return typeof id === 'string' && USER_ID_RE.test(id) ? id : null;
  }

  // The owner's ready file entry, or null. Callers validate ids before they get here.
  async ownerEntry(uid, fileId) {
    const stored = await this.storage.readJson(manifestPath(uid));
    const files = stored ? stored.data.files : [];
    return files.find((f) => f.id === fileId && f.status === 'ready') || null;
  }

  // ---- channels

  async getChannel(user) {
    const username = typeof user === 'string' ? user : user.username;
    const doc = await this.readDoc();
    const ch = doc.channels[username];
    return ch ? publicChannel(username, ch) : null;
  }

  // Creates or updates the user's own channel. logoFileId, when given, must be an image file the user owns.
  async putChannel(user, data) {
    const name = checkChannelName(data ? data.name : undefined);
    const description = checkOptionalText(
      data ? data.description : undefined,
      DESCRIPTION_MAX,
      'INVALID_DESCRIPTION',
      `The channel description must be at most ${DESCRIPTION_MAX} characters.`,
    );
    let logoFileId = data && data.logoFileId != null ? String(data.logoFileId) : null;
    if (logoFileId) {
      if (!FILE_ID_RE.test(logoFileId)) {
        throw new AppError(400, 'INVALID_LOGO', 'The channel logo must be an image file you own.');
      }
      const entry = await this.ownerEntry(user.id, logoFileId);
      if (!entry || !String(entry.type).startsWith('image/')) {
        throw new AppError(400, 'INVALID_LOGO', 'The channel logo must be an image file you own.');
      }
    } else {
      logoFileId = null;
    }
    return this.update((doc) => {
      const existing = doc.channels[user.username];
      doc.channels[user.username] = {
        name,
        description,
        logoFileId,
        createdAt: existing ? existing.createdAt : iso(this.now()),
      };
      return { save: true, value: publicChannel(user.username, doc.channels[user.username]) };
    });
  }

  // Deletes the channel and unpublishes its videos, so the feed never shows an orphaned channel.
  async deleteChannel(user) {
    return this.update((doc) => {
      if (!doc.channels[user.username]) return { save: false, value: false };
      delete doc.channels[user.username];
      for (const [fileId, rec] of Object.entries(doc.videos)) {
        if (rec.owner === user.username) delete doc.videos[fileId];
      }
      return { save: true, value: true };
    });
  }

  async listChannels() {
    const doc = await this.readDoc();
    return Object.entries(doc.channels).map(([username, ch]) => publicChannel(username, ch));
  }

  // ---- videos

  async getVideo(fileId) {
    const doc = await this.readDoc();
    const rec = doc.videos[fileId];
    return rec ? { fileId, ...rec } : null;
  }

  // Publishes (or updates the metadata of) one of the owner's video files. The file must be ready in
  // the owner's manifest and its stored type must be video/*. The thumbnail, when given, must be an
  // image the owner uploaded.
  async publishVideo(fileId, owner, { title, description, thumbnailFileId } = {}) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    const checkedTitle = checkVideoTitle(title);
    const checkedDescription = checkOptionalText(
      description,
      VIDEO_DESCRIPTION_MAX,
      'INVALID_DESCRIPTION',
      `The video description must be at most ${VIDEO_DESCRIPTION_MAX} characters.`,
    );
    let thumbId = thumbnailFileId != null ? String(thumbnailFileId) : null;
    if (thumbId) {
      if (!FILE_ID_RE.test(thumbId)) {
        throw new AppError(400, 'INVALID_THUMBNAIL', 'The thumbnail must be an image file you own.');
      }
      const entry = await this.ownerEntry(owner.id, thumbId);
      if (!entry || !String(entry.type).startsWith('image/')) {
        throw new AppError(400, 'INVALID_THUMBNAIL', 'The thumbnail must be an image file you own.');
      }
    } else {
      thumbId = null;
    }
    const fileEntry = await this.ownerEntry(owner.id, fileId);
    if (!fileEntry) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    if (!String(fileEntry.type).startsWith('video/')) {
      throw new AppError(415, 'NOT_A_VIDEO', 'Only video files can be published.');
    }
    return this.update((doc) => {
      const existing = doc.videos[fileId];
      const created = !existing;
      doc.videos[fileId] = {
        owner: owner.username,
        title: checkedTitle,
        description: checkedDescription,
        thumbnailFileId: thumbId,
        // A re-publish updates the metadata but keeps the original publish date, like YouTube.
        publishedAt: existing ? existing.publishedAt : iso(this.now()),
      };
      return { save: true, value: { video: { fileId, ...doc.videos[fileId] }, created } };
    });
  }

  // Owner only. A non-owner gets the same 404 as a missing record, so published ids leak nothing.
  async unpublishVideo(fileId, owner) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    return this.update((doc) => {
      const rec = doc.videos[fileId];
      if (!rec || rec.owner !== owner.username) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
      delete doc.videos[fileId];
      return { save: true, value: true };
    });
  }

  async isPublished(fileId) {
    const doc = await this.readDoc();
    return Boolean(doc.videos[fileId]);
  }

  async isChannelLogo(fileId) {
    const doc = await this.readDoc();
    return Object.values(doc.channels).some((ch) => ch.logoFileId === fileId);
  }

  // ---- joined views. Each view re-reads the owners' manifests, so deleted files drop out and the
  // mime/size always match what is actually stored.

  // All published videos, newest first, joined with channel name/logo.
  async feed() {
    const doc = await this.readDoc();
    const byOwner = new Map();
    for (const [fileId, rec] of Object.entries(doc.videos)) {
      if (!byOwner.has(rec.owner)) byOwner.set(rec.owner, []);
      byOwner.get(rec.owner).push([fileId, rec]);
    }
    const items = [];
    for (const [owner, list] of byOwner) {
      const uid = await this.uidFor(owner);
      if (!uid) continue;
      const channel = doc.channels[owner] || null;
      for (const [fileId, rec] of list) {
        const entry = await this.ownerEntry(uid, fileId);
        if (!entry) continue;
        items.push(videoItem(fileId, rec, entry, channel));
      }
    }
    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return items;
  }

  // One channel's published videos, newest first (same rows as the feed).
  async channelVideos(user) {
    const username = typeof user === 'string' ? user : user.username;
    const all = await this.feed();
    return all.filter((item) => item.owner === username);
  }

  // A single published video for the watch screen, or null when it is not published (or the file
  // behind it is gone). The channel is joined in when the owner still has one.
  async videoView(fileId) {
    if (!FILE_ID_RE.test(fileId)) return null;
    const doc = await this.readDoc();
    const rec = doc.videos[fileId];
    if (!rec) return null;
    const uid = await this.uidFor(rec.owner);
    if (!uid) return null;
    const entry = await this.ownerEntry(uid, fileId);
    if (!entry) return null;
    const channel = doc.channels[rec.owner] || null;
    return { video: videoItem(fileId, rec, entry, channel), channel: channel ? publicChannel(rec.owner, channel) : null };
  }

  // The public channel page: the channel plus its videos, or null when there is no channel.
  async channelPage(user) {
    const username = typeof user === 'string' ? user : user.username;
    const doc = await this.readDoc();
    const ch = doc.channels[username];
    if (!ch) return null;
    return { channel: publicChannel(username, ch), videos: await this.channelVideos(username) };
  }

  // The Tube access rule: a file that is published as a video, shown as a video's thumbnail, or in
  // use as a channel logo may be streamed by ANY signed-in user (thumbnails and logos appear in the
  // shared feed, so viewers must be able to load them). Resolves such a file to its owner's ready
  // manifest entry, or null when the id is not covered by the rule (the caller then keeps the
  // owner-only behavior).
  async resolvePublic(fileId) {
    if (!FILE_ID_RE.test(fileId)) return null;
    const doc = await this.readDoc();
    const rec = doc.videos[fileId];
    let owner = rec ? rec.owner : null;
    if (!owner) {
      for (const [fileId2, rec2] of Object.entries(doc.videos)) {
        if (rec2.thumbnailFileId === fileId) {
          owner = rec2.owner;
          break;
        }
      }
    }
    if (!owner) {
      for (const [username, ch] of Object.entries(doc.channels)) {
        if (ch.logoFileId === fileId) {
          owner = username;
          break;
        }
      }
    }
    if (!owner) return null;
    const uid = await this.uidFor(owner);
    if (!uid) return null;
    try {
      const entry = await this.ownerEntry(uid, fileId);
      return entry ? { entry, owner } : null;
    } catch (err) {
      if (err instanceof ConflictError) throw err;
      return null;
    }
  }
}

function checkVideoTitle(title) {
  if (typeof title !== 'string' || !title.trim() || title.trim().length > VIDEO_TITLE_MAX) {
    throw new AppError(400, 'INVALID_TITLE', `The video title must be 1-${VIDEO_TITLE_MAX} characters.`);
  }
  return title.trim();
}

module.exports = {
  TubeService,
  publicChannel,
  videoItem,
  NAME_MAX,
  DESCRIPTION_MAX,
  VIDEO_TITLE_MAX,
  VIDEO_DESCRIPTION_MAX,
};
