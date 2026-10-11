'use strict';

// In-process sliding-window counter. Counts reset on restart and are not shared between instances.
class RateLimiter {
  constructor(now = Date.now) {
    this.now = now;
    this.hits = new Map();
  }

  // Number of recorded events for `key` within the last `windowMs`.
  count(key, windowMs) {
    const cutoff = this.now() - windowMs;
    const recent = (this.hits.get(key) || []).filter((t) => t > cutoff);
    if (recent.length) this.hits.set(key, recent);
    else this.hits.delete(key);
    return recent.length;
  }

  record(key) {
    const list = this.hits.get(key) || [];
    list.push(this.now());
    this.hits.set(key, list);
  }

  clear(key) {
    this.hits.delete(key);
  }
}

module.exports = { RateLimiter };
