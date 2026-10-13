'use strict';

// Social layer for the pips-flutter app: follow other accounts, direct
// messages with attachments and likes, notifications, and profile avatars.
// Everything is plain JSON documents in the private data repo: one doc per
// user for follows/inbox/notifications, one per pair for DM threads.

const crypto = require('node:crypto');
const { AppError, ConflictError } = require('./errors');
const { USERNAME_RE, usernamePath, userPath, followsPath, inboxPath, notificationsPath, messagesPath } = require('./paths');

const MAX_MESSAGES_PER_THREAD = 500;
const MAX_NOTIFICATIONS = 100;
const MAX_TEXT = 4000;
const UPDATE_ATTEMPTS = 4;
const MESSAGE_ID_RE = /^[a-f0-9]{12}$/;

const nowIso = (now) => new Date(now()).toISOString();

class Social {
  constructor({ storage, files, now = Date.now }) {
    this.storage = storage;
    this.files = files; // FileService, for attachment lookup + avatar sharing
    this.now = now;
  }

  // ---- shared doc plumbing -------------------------------------------------

  async readDoc(path, key) {
    const record = await this.storage.readJson(path);
    if (record && record.data && Array.isArray(record.data[key])) return { doc: record.data, sha: record.sha };
    return { doc: { [key]: [] }, sha: record ? record.sha : null };
  }

  async withDoc(path, key, emptyDoc, message, mutate) {
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
      const { doc, sha } = await this.readDoc(path, key);
      const result = mutate(doc);
      try {
        if (sha === null) {
          const created = await this.storage.createJson(path, doc, message);
          if (created !== true) throw new ConflictError(`${path} appeared while creating it.`);
        } else {
          await this.storage.updateJson(path, doc, sha, message);
        }
        return result;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === UPDATE_ATTEMPTS) throw err;
      }
    }
  }

  // ---- users ---------------------------------------------------------------

  // The uid behind a username, or null when the account does not exist.
  async uidFor(username) {
    if (!USERNAME_RE.test(String(username || ''))) return null;
    const claim = await this.storage.readJson(usernamePath(String(username).toLowerCase()));
    return claim && claim.data && claim.data.user_id ? claim.data.user_id : null;
  }

  async userDoc(userId) {
    const record = await this.storage.readJson(userPath(userId));
    return record && record.data ? record.data : null;
  }

  // Discovery list: tube channel owners plus everyone I follow or who follows
  // me, each stamped with whether I follow them back.
  async users(q, meUsername) {
    const me = String(meUsername || '').toLowerCase();
    const following = new Set();
    const names = new Set();

    const myUid = await this.uidFor(me);
    if (myUid) {
      const mine = await this.readDoc(followsPath(myUid), 'following').catch(() => null);
      for (const n of (mine && mine.doc.following) || []) {
        following.add(String(n).toLowerCase());
        names.add(n);
      }
      const followers = await this.readDoc(followsPath(myUid), 'followers').catch(() => null);
      for (const n of (followers && followers.doc.followers) || []) names.add(n);
    }

    const tube = await this.storage.readJson('system/tube.json').catch(() => null);
    if (tube && tube.data && tube.data.channels && typeof tube.data.channels === 'object') {
      for (const name of Object.keys(tube.data.channels)) names.add(name);
    }
    names.add(me);

    const needle = String(q || '').trim().toLowerCase();
    const out = [];
    for (const username of [...names].sort()) {
      if (!USERNAME_RE.test(username)) continue;
      if (needle && !username.includes(needle)) continue;
      let name = username;
      if (tube && tube.data && tube.data.channels && tube.data.channels[username]) {
        name = tube.data.channels[username].name || username;
      }
      out.push({ username, name, following: following.has(username.toLowerCase()) });
    }
    return out;
  }

  // ---- follows -------------------------------------------------------------

  async follow(meUid, meUsername, username) {
    return this.setFollow(meUid, meUsername, username, true);
  }

  async unfollow(meUid, meUsername, username) {
    return this.setFollow(meUid, meUsername, username, false);
  }

  async setFollow(meUid, meUsername, username, on) {
    const target = String(username || '').toLowerCase();
    if (target === String(meUsername || '').toLowerCase()) {
      throw new AppError(400, 'SELF_FOLLOW', 'You cannot follow yourself.');
    }
    const theirUid = await this.uidFor(target);
    if (!theirUid) throw new AppError(404, 'USER_NOT_FOUND', 'No such user.');

    await this.withDoc(followsPath(meUid), 'following', { following: [] }, `Following list for ${meUid}`, (doc) => {
      doc.following = (doc.following || []).filter((u) => u !== target);
      if (on) doc.following.push(target);
    });
    await this.withDoc(followsPath(theirUid), 'followers', { followers: [] }, `Follower list for ${theirUid}`, (doc) => {
      doc.followers = (doc.followers || []).filter((u) => u !== meUsername);
      if (on) doc.followers.push(String(meUsername).toLowerCase());
    });
    if (on) {
      await this.notify(theirUid, `${meUsername} started following you.`);
    }
    return { following: on };
  }

  // ---- notifications ---------------------------------------------------------

  async notify(userId, text) {
    await this.withDoc(notificationsPath(userId), 'items', { items: [] }, `Notifications for ${userId}`, (doc) => {
      doc.items.unshift({ id: crypto.randomBytes(6).toString('hex'), text: String(text).slice(0, 200), at: nowIso(this.now), read: false });
      while (doc.items.length > MAX_NOTIFICATIONS) doc.items.pop();
    });
  }

  async notifications(userId) {
    const { doc } = await this.readDoc(notificationsPath(userId), 'items');
    return doc.items || [];
  }

  async notificationsRead(userId, id) {
    let changed = 0;
    await this.withDoc(notificationsPath(userId), 'items', { items: [] }, `Notifications for ${userId}`, (doc) => {
      for (const n of doc.items) {
        if (!n.read && (id ? n.id === id : true)) {
          n.read = true;
          changed += 1;
        }
      }
    });
    return { changed };
  }

  // ---- direct messages -------------------------------------------------------

  threadPath(meUid, peerUid) {
    return messagesPath(meUid, peerUid);
  }

  async inbox(meUid, meUsername) {
    const { doc } = await this.readDoc(inboxPath(meUid), 'threads');
    return (doc.threads || [])
      .filter((t) => t && t.peer !== meUsername)
      .sort((a, b) => (a.at < b.at ? 1 : -1))
      .map((t) => ({ peer: t.peer, last: t.last, at: t.at, unread: t.unread || 0 }));
  }

  async touchInbox(uid, peerUsername, last, at, { incrementUnread }) {
    await this.withDoc(inboxPath(uid), 'threads', { threads: [] }, `Inbox for ${uid}`, (doc) => {
      doc.threads = (doc.threads || []).filter((t) => t.peer !== peerUsername);
      const prior = doc.threads.find((t) => t.peer === peerUsername);
      const unread = (prior && prior.unread) || 0;
      doc.threads.unshift({
        peer: peerUsername,
        last: String(last).slice(0, 120),
        at,
        unread: incrementUnread ? unread + 1 : unread,
      });
    });
  }

  async appendMessage(meUid, peerUid, message) {
    await this.withDoc(this.threadPath(meUid, peerUid), 'messages', { messages: [] }, `DM thread ${meUid}/${peerUid}`, (doc) => {
      doc.messages.push(message);
      while (doc.messages.length > MAX_MESSAGES_PER_THREAD) doc.messages.shift();
    });
  }

  async loadThread(meUid, peerUid) {
    const { doc } = await this.readDoc(this.threadPath(meUid, peerUid), 'messages');
    return doc;
  }

  // Attachment view for a message: the sender's file entry, lightened.
  async fileView(senderUid, fileId) {
    if (!fileId) return null;
    try {
      const entry = await this.files.readReady(senderUid, fileId);
      return { id: entry.id, name: entry.name, mime: entry.type || '', size: entry.size || 0 };
    } catch {
      return { id: fileId, name: 'attachment' };
    }
  }

  async send(meUid, meUsername, peerUsername, { text, fileId }) {
    const peerUid = await this.uidFor(peerUsername);
    if (!peerUid) throw new AppError(404, 'USER_NOT_FOUND', 'No such user.');
    if (peerUid === meUid) throw new AppError(400, 'SELF_MESSAGE', 'You cannot message yourself.');
    const body = String(text === undefined || text === null ? '' : text);
    if (body.length > MAX_TEXT) throw new AppError(400, 'TEXT_TOO_LARGE', `Messages must be ${MAX_TEXT} characters or fewer.`);
    if (!body.trim() && !fileId) throw new AppError(400, 'EMPTY_MESSAGE', 'Send a message or a file.');

    // The attachment is granted to the peer (no public share link is created).
    if (fileId) {
      await this.files.readReady(meUid, String(fileId)); // must be mine and ready
      await this.files.grantFile(meUid, String(fileId), [String(peerUsername).toLowerCase()]);
    }

    const at = nowIso(this.now);
    const message = {
      id: crypto.randomBytes(6).toString('hex'),
      from: String(meUsername).toLowerCase(),
      text: body,
      fileId: fileId ? String(fileId) : null,
      at,
      likes: [],
    };
    await this.appendMessage(meUid, peerUid, message);
    await this.touchInbox(meUid, String(peerUsername).toLowerCase(), body, at, { incrementUnread: false });
    await this.touchInbox(peerUid, String(meUsername).toLowerCase(), body, at, { incrementUnread: true });
    await this.notify(peerUid, `${meUsername} sent you a message.`);
    return {
      id: message.id,
      from: message.from,
      text: message.text,
      file: await this.fileView(meUid, message.fileId),
      at: message.at,
      likes: [],
    };
  }

  // My conversation with a peer, oldest first, with attachments resolved.
  async thread(meUid, meUsername, peerUsername) {
    const peerUid = await this.uidFor(peerUsername);
    if (!peerUid) throw new AppError(404, 'USER_NOT_FOUND', 'No such user.');
    const doc = await this.loadThread(meUid, peerUid);
    const messages = [];
    for (const m of doc.messages || []) {
      messages.push({
        id: m.id,
        from: m.from,
        text: m.text,
        file: await this.fileView(m.from === String(meUsername).toLowerCase() ? meUid : peerUid, m.fileId),
        at: m.at,
        likes: m.likes || [],
      });
    }
    // Opening the thread clears my unread badge for this peer.
    await this.withDoc(inboxPath(meUid), 'threads', { threads: [] }, `Inbox for ${meUid}`, (d) => {
      for (const t of d.threads || []) {
        if (t.peer === String(peerUsername).toLowerCase()) t.unread = 0;
      }
    });
    return messages;
  }

  async like(meUid, meUsername, peerUsername, messageId) {
    const peerUid = await this.uidFor(peerUsername);
    if (!peerUid) throw new AppError(404, 'USER_NOT_FOUND', 'No such user.');
    if (!MESSAGE_ID_RE.test(String(messageId || ''))) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message.');
    const me = String(meUsername).toLowerCase();
    let liked = false;
    await this.withDoc(this.threadPath(meUid, peerUid), 'messages', { messages: [] }, `DM thread ${meUid}/${peerUid}`, (doc) => {
      const m = (doc.messages || []).find((x) => x.id === messageId);
      if (!m) throw new AppError(404, 'MESSAGE_NOT_FOUND', 'No such message.');
      m.likes = m.likes || [];
      const idx = m.likes.indexOf(me);
      if (idx === -1) {
        m.likes.push(me);
        liked = true;
      } else {
        m.likes.splice(idx, 1);
      }
    });
    return { liked };
  }

  // ---- avatars ----------------------------------------------------------------

  async setAvatar(userId, fileId) {
    // Any signed-in user may render the avatar; no public share link is created.
    await this.files.grantFile(userId, String(fileId), ['*']);
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
      const record = await this.storage.readJson(userPath(userId));
      if (!record) throw new AppError(404, 'USER_NOT_FOUND', 'No such user.');
      try {
        const next = { ...record.data, avatar_file_id: String(fileId) };
        await this.storage.updateJson(userPath(userId), next, record.sha, `Avatar for ${userId}`);
        return { file_id: String(fileId) };
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === UPDATE_ATTEMPTS) throw err;
      }
    }
  }

  // Preview URL for a username's avatar, or null. Readers pass entryForReader
  // through the avatar's grant ('*'), so any signed-in user sees the picture.
  async avatarUrl(username) {
    const uid = await this.uidFor(username);
    if (!uid) return null;
    const user = await this.userDoc(uid);
    if (!user || !user.avatar_file_id) return null;
    try {
      const entry = await this.files.readReady(uid, user.avatar_file_id);
      return `/api/files/${entry.id}/preview`;
    } catch {
      return null;
    }
  }

  // User reports: logged, never rendered anywhere.
  async report(text) {
    console.log(`[report] ${String(text).slice(0, 300)}`);
    return { received: true };
  }
}

module.exports = { Social };
