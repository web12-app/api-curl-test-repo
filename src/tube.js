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
//   "videos":   { "<fileId>":   { owner, title, description, thumbnailFileId, publishedAt,
//                                 kind: "video" | "reel" | "post", durationMs } },
//   "votes":    { "<fileId>":   { "<username>": 1 | -1 } },
//   "comments": { "<fileId>":   [ { id, user, text, at, likes: [username], dislikes: [username] } ] },
//   "views":    { "<fileId>":   { "<username>": firstViewedAt } },
//   "subs":     { "<channelUsername>": [ "<subscriberUsername>" ] }
// }
//
// Content kinds: a "video" and a "reel" both back onto an uploaded video file (a reel is just a
// short-form presentation of the same data); a "post" is text with an OPTIONAL backing file of any
// kind. Text-only posts get a synthetic 32-hex file id so every route that takes a video id works
// on them unchanged; their feed row degrades gracefully when the backing file is deleted.
//
// Rules this module keeps:
// - Only ready files from the owner's own manifest can be published or used as a logo/thumbnail.
// - Deleting a channel also unpublishes that channel's videos, so the feed never shows a video
//   whose channel is gone.
// - A video whose backing file was deleted (or is not ready) is skipped in views; the record stays
//   and disappears from the feed until the owner unpublishes it. Text-only posts have no backing
//   file and are never skipped.
// - Votes, comments, views and subscriptions are per-user and idempotent: one live vote per user,
//   one view per user (unique viewers), one subscription per channel (toggle).
const crypto = require('node:crypto');
const { AppError, ConflictError } = require('./errors');
const { tubePath, usernamePath, manifestPath, USERNAME_RE } = require('./paths');
const { FILE_ID_RE } = require('./files');

const NAME_MAX = 80;
const DESCRIPTION_MAX = 500;
const VIDEO_TITLE_MAX = 120;
const VIDEO_DESCRIPTION_MAX = 2000;
const COMMENT_MAX = 500;
const USER_ID_RE = /^[a-f0-9]{32}$/;
const KINDS = ['video', 'reel', 'post'];

const iso = (ms) => new Date(ms).toISOString();
const newId = () => crypto.randomBytes(16).toString('hex');       // 32-hex, same shape as file ids
const newCommentId = () => crypto.randomBytes(6).toString('hex'); // 12-hex, same shape as db ids

// What the client sees for a channel. The logo points at the existing per-file preview endpoint -
// the Tube access rule lets any signed-in user load a logo that is in use. Subscriber counts ride
// along; `subscribed` is only set when the caller passes the viewer's username.
function publicChannel(username, ch, { subscribers = 0, subscribed } = {}) {
  const out = {
    username,
    name: ch.name,
    description: ch.description || '',
    logoUrl: ch.logoFileId ? `/api/files/${ch.logoFileId}/preview` : null,
    createdAt: ch.createdAt,
    subscribers,
  };
  if (subscribed !== undefined) out.subscribed = subscribed;
  return out;
}

// One feed row: the video joined with its file entry (mime, size) and its channel (name, logo),
// plus the social stats (kind, views, likes, dislikes, and the viewer's own vote when known).
function videoItem(fileId, rec, entry, channel, { views = 0, likes = 0, dislikes = 0, myVote = null } = {}) {
  return {
    fileId,
    owner: rec.owner,
    channelName: channel ? channel.name : rec.owner,
    channelLogoUrl: channel && channel.logoFileId ? `/api/files/${channel.logoFileId}/preview` : null,
    title: rec.title,
    description: rec.description || '',
    thumbnailUrl: rec.thumbnailFileId ? `/api/files/${rec.thumbnailFileId}/preview` : null,
    kind: rec.kind || 'video',
    durationMs: rec.durationMs || 0,
    mime: entry.type,
    size: entry.size,
    publishedAt: rec.publishedAt,
    views,
    likes,
    dislikes,
    myVote,
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
    return { version: 1, channels: {}, videos: {}, votes: {}, comments: {}, views: {}, subs: {} };
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
      if (doc.votes && typeof doc.votes === 'object' && !Array.isArray(doc.votes)) out.votes = doc.votes;
      if (doc.comments && typeof doc.comments === 'object' && !Array.isArray(doc.comments)) out.comments = doc.comments;
      if (doc.views && typeof doc.views === 'object' && !Array.isArray(doc.views)) out.views = doc.views;
      if (doc.subs && typeof doc.subs === 'object' && !Array.isArray(doc.subs)) out.subs = doc.subs;
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

  // ---- social stats helpers (all take a sanitized doc)

  likesOf(doc, fileId) {
    const bucket = doc.votes[fileId] || {};
    let likes = 0;
    let dislikes = 0;
    for (const v of Object.values(bucket)) {
      if (v === 1) likes += 1;
      else if (v === -1) dislikes += 1;
    }
    return { likes, dislikes };
  }

  voteOf(doc, fileId, viewer) {
    if (!viewer) return null;
    const v = (doc.votes[fileId] || {})[viewer];
    return v === 1 ? 'like' : v === -1 ? 'dislike' : null;
  }

  viewCountOf(doc, fileId) {
    return Object.keys(doc.views[fileId] || {}).length;
  }

  subscriberCountOf(doc, username) {
    return (doc.subs[username] || []).length;
  }

  // ---- channels

  // The channel with subscriber stats; `subscribed` is included when the viewer is known.
  async getChannel(user, viewer) {
    const username = typeof user === 'string' ? user : user.username;
    const doc = await this.readDoc();
    const ch = doc.channels[username];
    if (!ch) return null;
    return publicChannel(username, ch, {
      subscribers: this.subscriberCountOf(doc, username),
      ...(viewer !== undefined ? { subscribed: (doc.subs[username] || []).includes(viewer) } : {}),
    });
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
      return {
        save: true,
        value: publicChannel(user.username, doc.channels[user.username], {
          subscribers: this.subscriberCountOf(doc, user.username),
          subscribed: false,
        }),
      };
    });
  }

  // Deletes the channel and unpublishes its videos, so the feed never shows an orphaned channel.
  // The channel's subscribers and its videos' votes/comments/views are dropped with it.
  async deleteChannel(user) {
    return this.update((doc) => {
      if (!doc.channels[user.username]) return { save: false, value: false };
      delete doc.channels[user.username];
      for (const [fileId, rec] of Object.entries(doc.videos)) {
        if (rec.owner === user.username) {
          delete doc.videos[fileId];
          delete doc.votes[fileId];
          delete doc.comments[fileId];
          delete doc.views[fileId];
        }
      }
      delete doc.subs[user.username];
      return { save: true, value: true };
    });
  }

  async listChannels() {
    const doc = await this.readDoc();
    return Object.entries(doc.channels).map(([username, ch]) =>
      publicChannel(username, ch, { subscribers: this.subscriberCountOf(doc, username) }));
  }

  // Toggle a subscription to any channel (all channels on this server are signed-in-visible).
  // Returns the new state and the channel's subscriber count.
  async subscribeChannel(channelUsername, viewer) {
    return this.update((doc) => {
      if (!doc.channels[channelUsername]) {
        throw new AppError(404, 'NOT_FOUND', 'No such channel.');
      }
      if (channelUsername === viewer) {
        throw new AppError(400, 'INVALID_SUBSCRIBE', 'You cannot subscribe to your own channel.');
      }
      const list = doc.subs[channelUsername] || [];
      const at = list.indexOf(viewer);
      let subscribed;
      if (at >= 0) {
        list.splice(at, 1);
        subscribed = false;
      } else {
        list.push(viewer);
        subscribed = true;
      }
      doc.subs[channelUsername] = list;
      return { save: true, value: { subscribed, subscribers: list.length } };
    });
  }

  // ---- videos

  async getVideo(fileId) {
    const doc = await this.readDoc();
    const rec = doc.videos[fileId];
    return rec ? { fileId, ...rec } : null;
  }

  // Publishes (or updates the metadata of) one of the owner's files as channel content.
  // kind "video"/"reel" require a ready video/* file; kind "post" is text with an OPTIONAL backing
  // file of any type (text-only posts get a synthetic id). The thumbnail, when given, must be an
  // image the owner uploaded.
  async publishVideo(fileId, owner, { title, description, thumbnailFileId, kind, durationMs } = {}) {
    const kindName = normalizeKind(kind);
    const synthetic = !fileId;
    if (synthetic && kindName !== 'post') {
      throw new AppError(400, 'FILE_REQUIRED', 'A file is required for videos and reels.');
    }
    if (!synthetic && !FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'File not found.');
    const checkedTitle = checkVideoTitle(title);
    const checkedDescription = checkOptionalText(
      description,
      VIDEO_DESCRIPTION_MAX,
      'INVALID_DESCRIPTION',
      `The video description must be at most ${VIDEO_DESCRIPTION_MAX} characters.`,
    );
    let thumbId = thumbnailFileId != null && thumbnailFileId !== '' ? String(thumbnailFileId) : null;
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
    const checkedDuration = checkDurationMs(durationMs);
    let backingId = fileId;
    if (synthetic) {
      backingId = newId(); // text-only post: a synthetic id in the same shape as file ids
    } else {
      const fileEntry = await this.ownerEntry(owner.id, fileId);
      if (!fileEntry) throw new AppError(404, 'NOT_FOUND', 'File not found.');
      if (kindName !== 'post' && !String(fileEntry.type).startsWith('video/')) {
        throw new AppError(415, 'NOT_A_VIDEO', 'Only video files can be published as videos or reels.');
      }
    }
    return this.update((doc) => {
      const existing = doc.videos[backingId];
      const created = !existing;
      doc.videos[backingId] = {
        owner: owner.username,
        title: checkedTitle,
        description: checkedDescription,
        thumbnailFileId: thumbId,
        kind: kindName,
        durationMs: checkedDuration,
        // A re-publish updates the metadata but keeps the original publish date, like YouTube.
        publishedAt: existing ? existing.publishedAt : iso(this.now()),
      };
      return { save: true, value: { video: { fileId: backingId, ...doc.videos[backingId] }, created } };
    });
  }

  // Owner only. A non-owner gets the same 404 as a missing record, so published ids leak nothing.
  async unpublishVideo(fileId, owner) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    return this.update((doc) => {
      const rec = doc.videos[fileId];
      if (!rec || rec.owner !== owner.username) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
      delete doc.videos[fileId];
      delete doc.votes[fileId];
      delete doc.comments[fileId];
      delete doc.views[fileId];
      return { save: true, value: true };
    });
  }

  // Owner-only edit of an already published item: title, description, thumbnail, duration.
  async patchVideo(fileId, owner, changes = {}) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    let thumbId;
    if (changes.thumbnailFileId !== undefined) {
      thumbId = changes.thumbnailFileId != null && changes.thumbnailFileId !== '' ? String(changes.thumbnailFileId) : null;
      if (thumbId) {
        if (!FILE_ID_RE.test(thumbId)) {
          throw new AppError(400, 'INVALID_THUMBNAIL', 'The thumbnail must be an image file you own.');
        }
        const entry = await this.ownerEntry(owner.id, thumbId);
        if (!entry || !String(entry.type).startsWith('image/')) {
          throw new AppError(400, 'INVALID_THUMBNAIL', 'The thumbnail must be an image file you own.');
        }
      }
    }
    const checkedDuration = changes.durationMs !== undefined ? checkDurationMs(changes.durationMs) : undefined;
    return this.update((doc) => {
      const rec = doc.videos[fileId];
      if (!rec || rec.owner !== owner.username) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
      if (changes.title !== undefined) rec.title = checkVideoTitle(changes.title);
      if (changes.description !== undefined) {
        rec.description = checkOptionalText(
          changes.description,
          VIDEO_DESCRIPTION_MAX,
          'INVALID_DESCRIPTION',
          `The video description must be at most ${VIDEO_DESCRIPTION_MAX} characters.`,
        );
      }
      if (thumbId !== undefined) rec.thumbnailFileId = thumbId;
      if (checkedDuration !== undefined) rec.durationMs = checkedDuration;
      return { save: true, value: { video: { fileId, ...rec } } };
    });
  }

  // One view per user per item (unique viewers). Viewing something that is not published is a 404.
  async recordView(fileId, viewer) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    return this.update((doc) => {
      const rec = doc.videos[fileId];
      if (!rec) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
      const bucket = doc.views[fileId] || {};
      let created = false;
      if (!bucket[viewer]) {
        bucket[viewer] = iso(this.now());
        created = true;
        doc.views[fileId] = bucket;
      }
      return { save: created, value: { views: Object.keys(bucket).length } };
    });
  }

  // ---- votes (like / dislike, one live vote per user, YouTube-style)

  async voteVideo(fileId, vote, viewer) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    if (!['like', 'dislike', 'none'].includes(vote)) {
      throw new AppError(400, 'INVALID_VOTE', "vote must be like, dislike or none.");
    }
    return this.update((doc) => {
      if (!doc.videos[fileId]) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
      const bucket = doc.votes[fileId] || {};
      if (vote === 'none' || (bucket[viewer] && (bucket[viewer] === 1 ? 'like' : 'dislike') === vote)) {
        delete bucket[viewer]; // same vote again = toggle off
      } else {
        bucket[viewer] = vote === 'like' ? 1 : -1;
      }
      doc.votes[fileId] = bucket;
      const { likes, dislikes } = this.likesOf(doc, fileId);
      const myVote = bucket[viewer] === 1 ? 'like' : bucket[viewer] === -1 ? 'dislike' : null;
      return { save: true, value: { likes, dislikes, myVote } };
    });
  }

  // ---- comments (public, newest first)

  commentView(c, viewer) {
    return {
      id: c.id,
      user: c.user,
      text: c.text,
      at: c.at,
      likes: (c.likes || []).length,
      dislikes: (c.dislikes || []).length,
      myVote: viewer ? ((c.likes || []).includes(viewer) ? 'like' : (c.dislikes || []).includes(viewer) ? 'dislike' : null) : null,
    };
  }

  async listComments(fileId, viewer) {
    const doc = await this.readDoc();
    const list = doc.comments[fileId] || [];
    return [...list].reverse().map((c) => this.commentView(c, viewer));
  }

  async addComment(fileId, viewer, text) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    const checked = checkOptionalText(text, COMMENT_MAX, 'INVALID_COMMENT', `The comment must be 1-${COMMENT_MAX} characters.`);
    if (!checked) throw new AppError(400, 'INVALID_COMMENT', `The comment must be 1-${COMMENT_MAX} characters.`);
    return this.update((doc) => {
      if (!doc.videos[fileId]) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
      const list = doc.comments[fileId] || [];
      const comment = { id: newCommentId(), user: viewer, text: checked, at: iso(this.now()), likes: [], dislikes: [] };
      list.push(comment);
      doc.comments[fileId] = list;
      return { save: true, value: { comment: this.commentView(comment, viewer) } };
    });
  }

  async voteComment(fileId, commentId, vote, viewer) {
    if (!FILE_ID_RE.test(fileId)) throw new AppError(404, 'NOT_FOUND', 'Video not found.');
    if (!['like', 'dislike'].includes(vote)) {
      throw new AppError(400, 'INVALID_VOTE', "vote must be 'like' or 'dislike'.");
    }
    return this.update((doc) => {
      const list = doc.comments[fileId] || [];
      const c = list.find((x) => x.id === commentId);
      if (!c) throw new AppError(404, 'NOT_FOUND', 'Comment not found.');
      const likes = c.likes || [];
      const dislikes = c.dislikes || [];
      const other = vote === 'like' ? dislikes : likes;
      const mine = vote === 'like' ? likes : dislikes;
      const at = other.indexOf(viewer);
      if (at >= 0) other.splice(at, 1);
      const mineAt = mine.indexOf(viewer);
      if (mineAt >= 0) mine.splice(mineAt, 1); // toggle off
      else mine.push(viewer);
      c.likes = likes;
      c.dislikes = dislikes;
      return { save: true, value: { likes: likes.length, dislikes: dislikes.length } };
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

  // All published items, newest first, joined with channel name/logo and social stats. Text-only
  // posts (and posts whose image was deleted) still appear, degraded to text/plain rows.
  async feed(viewer) {
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
        let entry = await this.ownerEntry(uid, fileId);
        if (!entry) {
          if ((rec.kind || 'video') !== 'post') continue;
          entry = { type: 'text/plain', size: 0 };
        }
        const { likes, dislikes } = this.likesOf(doc, fileId);
        items.push(videoItem(fileId, rec, entry, channel, {
          views: this.viewCountOf(doc, fileId),
          likes,
          dislikes,
          myVote: this.voteOf(doc, fileId, viewer),
        }));
      }
    }
    items.sort((a, b) => b.publishedAt.localeCompare(a.publishedAt));
    return items;
  }

  // One channel's published items, newest first (same rows as the feed).
  async channelVideos(user, viewer) {
    const username = typeof user === 'string' ? user : user.username;
    const all = await this.feed(viewer);
    return all.filter((item) => item.owner === username);
  }

  // A single published item for the watch screen, or null when it is not published (or the file
  // behind it is gone, unless it is a post). The channel is joined in when the owner still has one.
  async videoView(fileId, viewer) {
    if (!FILE_ID_RE.test(fileId)) return null;
    const doc = await this.readDoc();
    const rec = doc.videos[fileId];
    if (!rec) return null;
    const uid = await this.uidFor(rec.owner);
    if (!uid) return null;
    let entry = await this.ownerEntry(uid, fileId);
    if (!entry) {
      if ((rec.kind || 'video') !== 'post') return null;
      entry = { type: 'text/plain', size: 0 };
    }
    const channel = doc.channels[rec.owner] || null;
    const { likes, dislikes } = this.likesOf(doc, fileId);
    const video = videoItem(fileId, rec, entry, channel, {
      views: this.viewCountOf(doc, fileId),
      likes,
      dislikes,
      myVote: this.voteOf(doc, fileId, viewer),
    });
    return {
      video,
      channel: channel
        ? publicChannel(rec.owner, channel, {
            subscribers: this.subscriberCountOf(doc, rec.owner),
            ...(viewer ? { subscribed: (doc.subs[rec.owner] || []).includes(viewer) } : {}),
          })
        : null,
    };
  }

  // The public channel page: the channel plus its items, or null when there is no channel.
  async channelPage(user, viewer) {
    const username = typeof user === 'string' ? user : user.username;
    const doc = await this.readDoc();
    const ch = doc.channels[username];
    if (!ch) return null;
    return {
      channel: publicChannel(username, ch, {
        subscribers: this.subscriberCountOf(doc, username),
        ...(viewer ? { subscribed: (doc.subs[username] || []).includes(viewer) } : {}),
      }),
      videos: await this.channelVideos(username, viewer),
    };
  }

  // The viewer's watch history: published items they have viewed, newest view first.
  async historyFor(viewer) {
    const doc = await this.readDoc();
    const entries = [];
    for (const [fileId, bucket] of Object.entries(doc.views)) {
      if (bucket[viewer]) entries.push([fileId, bucket[viewer]]);
    }
    entries.sort((a, b) => b[1].localeCompare(a[1]));
    const items = [];
    for (const [fileId] of entries) {
      const view = await this.videoView(fileId, viewer);
      if (view) items.push(view.video);
    }
    return items;
  }

  // The Tube access rule: a file that is published as a video/reel/post, shown as a thumbnail, or in
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

function normalizeKind(kind) {
  const name = typeof kind === 'string' ? kind.trim().toLowerCase() : '';
  if (!name) return 'video';
  if (!KINDS.includes(name)) {
    throw new AppError(400, 'INVALID_KIND', 'kind must be video, reel or post.');
  }
  return name;
}

function checkDurationMs(durationMs) {
  if (durationMs === undefined || durationMs === null || durationMs === '') return 0;
  const n = Number(durationMs);
  if (!Number.isInteger(n) || n < 0 || n > 24 * 60 * 60 * 1000) {
    throw new AppError(400, 'INVALID_DURATION', 'durationMs must be an integer between 0 and 86400000.');
  }
  return n;
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
  COMMENT_MAX,
};
