'use strict';

// Devices: which phones/computers reach an account (the pips-flutter profile
// screen). The app heartbeats its stable fingerprint after every login; the
// server upserts it and counts logins. `current` is stamped by the listing
// call when the fingerprint matches the one in the X-Device-Id header.

const { AppError, ConflictError } = require('./errors');
const { devicesPath } = require('./paths');

const MAX_DEVICES = 20;
const UPDATE_ATTEMPTS = 4;
const DEVICE_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

class Devices {
  constructor({ storage, now = Date.now }) {
    this.storage = storage;
    this.now = now;
  }

  async readDoc(userId) {
    const record = await this.storage.readJson(devicesPath(userId));
    if (record && record.data && Array.isArray(record.data.devices)) return { doc: record.data, sha: record.sha };
    return { doc: { devices: [] }, sha: record ? record.sha : null };
  }

  async withDoc(userId, mutate) {
    for (let attempt = 1; attempt <= UPDATE_ATTEMPTS; attempt++) {
      const { doc, sha } = await this.readDoc(userId);
      const result = mutate(doc);
      try {
        if (sha === null) {
          const created = await this.storage.createJson(devicesPath(userId), doc, `Devices for ${userId}`);
          if (created !== true) throw new ConflictError(`${devicesPath(userId)} appeared while creating it.`);
        } else {
          await this.storage.updateJson(devicesPath(userId), doc, sha, `Devices for ${userId}`);
        }
        return result;
      } catch (err) {
        if (!(err instanceof ConflictError) || attempt === UPDATE_ATTEMPTS) throw err;
      }
    }
  }

  // Login heartbeat: upsert the device and count the login.
  async heartbeat(userId, { id, name, platform }) {
    if (!DEVICE_ID_RE.test(String(id || ''))) throw new AppError(400, 'INVALID_DEVICE', 'Send a stable device id (8-64 characters).');
    const deviceName = String(name || 'Unknown device').slice(0, 80);
    const devicePlatform = String(platform || 'unknown').slice(0, 40);
    await this.withDoc(userId, (doc) => {
      const at = new Date(this.now()).toISOString();
      let d = doc.devices.find((x) => x.id === id);
      if (d) {
        d.logins += 1;
        d.last_login = at;
        d.name = deviceName;
        d.platform = devicePlatform;
      } else {
        d = { id, name: deviceName, platform: devicePlatform, logins: 1, created_at: at, last_login: at };
        doc.devices.push(d);
        // Retire the stalest device beyond the cap.
        while (doc.devices.length > MAX_DEVICES) {
          let oldest = 0;
          for (let i = 1; i < doc.devices.length; i++) {
            if (doc.devices[i].last_login < doc.devices[oldest].last_login) oldest = i;
          }
          doc.devices.splice(oldest, 1);
        }
      }
    });
    return { id, name: deviceName };
  }

  async list(userId, currentDeviceId) {
    const { doc } = await this.readDoc(userId);
    return [...doc.devices]
      .sort((a, b) => (a.last_login < b.last_login ? 1 : -1))
      .map((d) => ({
        id: d.id,
        name: d.name,
        platform: d.platform,
        logins: d.logins,
        created_at: d.created_at,
        last_login: d.last_login,
        current: String(currentDeviceId || '') === d.id,
      }));
  }

  async remove(userId, id) {
    let removed = false;
    await this.withDoc(userId, (doc) => {
      const idx = doc.devices.findIndex((x) => x.id === id);
      if (idx !== -1) {
        doc.devices.splice(idx, 1);
        removed = true;
      }
    });
    return removed;
  }
}

module.exports = { Devices };
