'use strict';

// Pips Tunnel: let a machine outside this server expose a localhost app under
// https://<host>/tun/<name>. A small client (tunnel-client/tun.js) registers an
// app name, then long-polls for HTTP requests. Every request that arrives at
// /tun/<name> is queued for that client; the client forwards it to
// http://localhost:<port> and posts the response back. This module is the
// in-memory registry + request queue + response waiters. Nothing here touches
// the network itself.

const { randomBytes } = require('node:crypto');
const { AppError } = require('./errors');

const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

const freshId = () => randomBytes(12).toString('hex');

// Anonymous tunnels get a friendly random name like "swift-otter-3f2a".
const ADJ = ['swift', 'calm', 'bold', 'lucky', 'quiet', 'brave', 'royal', 'smart', 'wild', 'fresh', 'noble', 'quick', 'sunny', 'sharp', 'clever', 'proud'];
const NOUN = ['otter', 'falcon', 'maple', 'harbor', 'ember', 'lynx', 'cedar', 'comet', 'willow', 'ridge', 'sparrow', 'badger', 'puffin', 'marble', 'beacon', 'finch'];
const randomName = () => `${ADJ[randomBytes(1)[0] % ADJ.length]}-${NOUN[randomBytes(1)[0] % NOUN.length]}-${randomBytes(2).toString('hex')}`;

class Tunnels {
  constructor({ now = Date.now, waitMs = 30000, pollWaitMs = 20000, ttlMs = 90000, maxTunnels = 200, maxQueue = 64 } = {}) {
    this.now = now;
    this.waitMs = waitMs; // how long /tun/<name> waits for the client's response
    this.pollWaitMs = pollWaitMs; // how long a client poll blocks before "nothing yet"
    this.ttlMs = ttlMs; // a tunnel dies after this long without any client activity
    this.maxTunnels = maxTunnels; // overload guard: connected tunnels at once
    this.maxQueue = maxQueue; // overload guard: queued requests per tunnel
    this.map = new Map();
    this.claims = new Map(); // name -> accountId: names reserved by tunnel accounts (filled by the server)
    this.store = null; // the TunnelStore, attached by the server after construction
  }

  normalizeName(name) {
    return String(name || '').trim().toLowerCase();
  }

  validateName(name) {
    if (!NAME_RE.test(this.normalizeName(name))) {
      throw new AppError(400, 'INVALID_NAME', 'App name must be 1-32 characters: a-z, 0-9, "-" or "_", starting with a letter or digit.');
    }
    return this.normalizeName(name);
  }

  // Drop tunnels the client abandoned (no poll/respond/register within ttlMs),
  // and queue entries whose proxy caller already timed out.
  sweep() {
    const now = this.now();
    for (const [name, t] of this.map) {
      if (now - t.lastSeen > this.ttlMs) {
        this.drop(name, new AppError(504, 'TUNNEL_TIMEOUT', 'The tunnel app went away.'));
      }
    }
    for (const t of this.map.values()) {
      // Queue entries nobody picked up within the proxy wait (+grace) are stale.
      while (t.queue.length && now - t.queue[0].ts > this.waitMs + 1000) t.queue.shift();
    }
  }

  register(rawName, { accountId } = {}) {
    const name = this.validateName(rawName);
    this.sweep();
    if (this.claims.size && this.claims.has(name) && this.claims.get(name) !== accountId) {
      throw new AppError(403, 'NAME_RESERVED', 'That tunnel name is reserved by an account. Log in with your token to use it.');
    }
    if (!this.map.has(name) && this.map.size >= this.maxTunnels) {
      throw new AppError(429, 'TUNNEL_LIMIT', `Too many tunnels are connected right now (limit ${this.maxTunnels}). Try again later.`);
    }
    const existing = this.map.get(name);
    if (existing) {
      // Takeover: a fresh client wins; the old one is told so on its next poll.
      this.drop(name, new AppError(410, 'TUNNEL_REPLACED', 'This tunnel was taken over by another client.'));
    }
    const t = {
      name,
      clientId: freshId(),
      registeredAt: this.now(),
      lastSeen: this.now(),
      queue: [],
      waiters: new Map(),
      pollWaiters: [],
      served: 0,
      answered: 0,
    };
    this.map.set(name, t);
    if (accountId) this.claims.set(name, accountId);
    return { name: t.name, clientId: t.clientId, reserved: Boolean(accountId) };
  }

  // Resolve everyone waiting on this tunnel and forget it.
  drop(name, err) {
    const t = this.map.get(name);
    if (!t) return;
    this.map.delete(name);
    for (const w of t.waiters.values()) {
      clearTimeout(w.timer);
      w.reject(err);
    }
    for (const w of t.pollWaiters) {
      clearTimeout(w.timer);
      w.resolve({ gone: 'offline' });
    }
  }

  get(name) {
    this.sweep();
    return this.map.get(this.normalizeName(name)) || null;
  }

  // Queue one proxied HTTP request and wait for the client to answer it.
  forward({ name, method, path, headers, body }) {
    this.sweep();
    const t = this.map.get(this.normalizeName(name));
    if (!t) throw new AppError(404, 'TUNNEL_OFFLINE', `No tunnel app named "${name}" is connected. Start it locally with: tun start <port> ${name}`);
    if (t.queue.length >= this.maxQueue) {
      throw new AppError(503, 'TUNNEL_BUSY', 'This tunnel has too many queued requests right now; retry shortly.');
    }
    const id = freshId();
    const entry = { id, method, path, headers, body, ts: this.now() };
    t.queue.push(entry);
    t.served += 1;
    const wake = t.pollWaiters.shift();
    if (wake) {
      clearTimeout(wake.timer);
      wake.wake();
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        t.waiters.delete(id);
        reject(new AppError(504, 'TUNNEL_TIMEOUT', `The tunnel app "${name}" did not answer in time.`));
      }, this.waitMs);
      t.waiters.set(id, { resolve, reject, timer });
    });
  }

  // Client long-poll: return a queued request now, or null after pollWaitMs.
  // forward() wakes the waiter through w.wake(), which shifts the queue.
  poll(name, clientId) {
    this.sweep();
    const t = this.map.get(this.normalizeName(name));
    if (!t) return Promise.resolve({ gone: 'offline' });
    if (t.clientId !== clientId) return Promise.resolve({ gone: 'replaced' });
    t.lastSeen = this.now();
    if (t.queue.length) return Promise.resolve({ request: t.queue.shift() });
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = t.pollWaiters.findIndex((w) => w.resolve === resolve);
        if (i !== -1) t.pollWaiters.splice(i, 1);
        resolve({ request: null });
      }, this.pollWaitMs);
      t.pollWaiters.push({ resolve, timer, wake: () => resolve({ request: t.queue.shift() }) });
    });
  }

  // Client posts the upstream answer for one forwarded request.
  respond(name, clientId, id, response) {
    this.sweep();
    const t = this.map.get(this.normalizeName(name));
    if (!t) return { delivered: false, reason: 'offline' };
    if (t.clientId !== clientId) return { delivered: false, reason: 'replaced' };
    t.lastSeen = this.now();
    const waiter = t.waiters.get(id);
    if (!waiter) return { delivered: false, reason: 'unknown' };
    t.waiters.delete(id);
    t.answered += 1;
    clearTimeout(waiter.timer);
    waiter.resolve(response);
    return { delivered: true };
  }

  close(name) {
    this.sweep();
    const t = this.map.get(this.normalizeName(name));
    if (!t) return false;
    this.drop(name, new AppError(410, 'TUNNEL_CLOSED', 'The tunnel was closed from the local machine.'));
    return true;
  }

  list() {
    this.sweep();
    return [...this.map.values()]
      .sort((a, b) => (a.name < b.name ? -1 : 1))
      .map((t) => ({
        name: t.name,
        pending: t.queue.length,
        served: t.served,
        answered: t.answered,
        ageMs: this.now() - t.registeredAt,
        reserved: this.claims.has(t.name),
      }));
  }

  // One number per counter, summed over every connected tunnel.
  stats() {
    this.sweep();
    const totals = { tunnels: this.map.size, pending: 0, served: 0, answered: 0 };
    for (const t of this.map.values()) {
      totals.pending += t.queue.length;
      totals.served += t.served;
      totals.answered += t.answered;
    }
    return totals;
  }
}

module.exports = { Tunnels, NAME_RE, freshId, randomName };
