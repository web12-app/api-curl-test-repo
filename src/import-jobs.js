'use strict';

// Imports a file from a public http:// or https:// link (or a data: link). A job runs in the background and the
// client polls its state.
//
// Rules this module keeps:
// - Jobs are keyed by (owner, client upload id). A repeat request while a job runs returns that job, so a double
//   click cannot start two downloads. A finished import with the same id returns its file.
// - Only the owner can see or cancel a job. Another user gets the same 404 as for a job that does not exist.
// - The URL is kept only in memory, for the download. It is never written to the manifest or to logs.
// - Every ending (success, failure, cancel, timeout) removes the temp file. Storage happens only through
//   FileService.upload, after the same checks as a multipart upload.
const crypto = require('node:crypto');
const { AppError, StorageError } = require('./errors');
const { validateImportUrl } = require('./net-guard');
const { downloadToFile } = require('./url-import');
const { checkStoredFile } = require('./file-checks');
const { removeFile } = require('./upload');
const { GitHubError } = require('./github-releases');
const { maskName, ref } = require('./redact');
const { UPLOAD_ID_RE } = require('./files');

const IMPORT_LIMITS = {
  maxConcurrentImports: 3, // running at once, on this server
  maxConcurrentPerUser: 2, // running at once, per account
  importsPerHour: 30, // starts per account per hour (retries count)
  jobTtlMs: 60 * 60 * 1000, // finished jobs are forgotten after this long
};

const ACTIVE = new Set(['queued', 'downloading', 'checking', 'storing']);
const CANCELLABLE = new Set(['queued', 'downloading']);
const TERMINAL = new Set(['completed', 'failed', 'cancelled']);

class Cancelled extends Error {}

const jobKey = (uid, uploadId) => `${uid}:${uploadId}`;
const urlFingerprint = (href) => crypto.createHash('sha256').update(href).digest('hex').slice(0, 12);

// What the owner may see. The URL is not included in full (its host only), and no temp path or storage ids.
function viewOf(job) {
  return {
    id: job.id,
    uploadId: job.uploadId,
    host: job.host,
    state: job.state,
    name: job.name,
    size: job.size,
    downloaded: job.downloaded,
    error: job.error,
    file: job.file,
    updatedAt: new Date(job.updatedAt).toISOString(),
  };
}

class ImportJobs {
  // service: the FileService. downloader, lookup, transport, timeouts, and allowPrivate are injectable for tests.
  constructor({ service, now, downloader = downloadToFile, lookup, transport, timeouts, limits, allowPrivate }) {
    this.service = service;
    this.now = now || service.now;
    this.downloader = downloader;
    this.lookup = lookup;
    this.transport = transport;
    this.timeouts = timeouts;
    this.limits = { ...IMPORT_LIMITS, ...(limits || {}) };
    // When true, imports may reach loopback, private ranges, and internal names (IMPORT_ALLOW_PRIVATE=1).
    this.allowPrivate = allowPrivate === true;
    this.jobs = new Map();
  }

  // Starts an import, or returns the job already running for this upload id. Returns { job, created }.
  // The check and the reservation of the job are not separated by an await, so two requests at the same moment
  // cannot both start a download.
  async start(uid, { url, uploadId }) {
    if (!UPLOAD_ID_RE.test(typeof uploadId === 'string' ? uploadId : '')) {
      throw new AppError(400, 'INVALID_UPLOAD_ID', 'The upload id must be a UUID.');
    }
    const parsed = validateImportUrl(url, { allowPrivate: this.allowPrivate });
    this.sweep();

    const key = jobKey(uid, uploadId);
    let existing = this.jobs.get(key);
    if (existing && existing.state === 'completed') {
      const again = await this.service.findUpload(uid, uploadId);
      if (again && again.status === 'ready') return { job: existing, created: false };
      existing = this.jobs.get(key); // may have changed while the lookup ran
    }
    if (existing && ACTIVE.has(existing.state)) return { job: existing, created: false };

    let mine = 0;
    let all = 0;
    for (const job of this.jobs.values()) {
      if (!ACTIVE.has(job.state)) continue;
      all += 1;
      if (job.uid === uid) mine += 1;
    }
    if (all >= this.limits.maxConcurrentImports || mine >= this.limits.maxConcurrentPerUser) {
      throw new AppError(429, 'IMPORT_BUSY', 'Too many imports are running. Wait for one to finish, then try again.');
    }

    const job = {
      id: crypto.randomBytes(16).toString('hex'),
      uid,
      uploadId,
      url: parsed.href, // in memory only, for the download (validated again at each hop)
      host: parsed.hostname || parsed.protocol.replace(':', ''),
      fingerprint: urlFingerprint(parsed.href),
      state: 'queued',
      name: null,
      size: null,
      downloaded: 0,
      error: null,
      file: null,
      tmp: null,
      cancelRequested: false,
      controller: new AbortController(),
      updatedAt: this.now(),
    };
    // Reserved now, so a second request sees it. Released again if the account or the storage check refuses.
    this.jobs.set(key, job);
    try {
      await this.service.assertReady();
      await this.service.assertRoom(uid);
    } catch (err) {
      if (this.jobs.get(key) === job) this.jobs.delete(key);
      throw err;
    }
    console.log(`import started: job=${ref(job.id)} source=${job.fingerprint} owner=${ref(uid)}`);
    // Not awaited: the client polls for progress. run() never rejects.
    this.run(job);
    return { job, created: true };
  }

  set(job, state) {
    if (job.cancelRequested && state !== 'cancelled') throw new Cancelled();
    job.state = state;
    job.updatedAt = this.now();
  }

  async run(job) {
    try {
      this.set(job, 'downloading');
      const download = await this.downloader(job.url, {
        tmpDir: this.service.tmpDir,
        maxBytes: this.service.limits.maxFileBytes,
        lookup: this.lookup,
        transport: this.transport,
        timeouts: this.timeouts,
        signal: job.controller.signal,
        allowPrivate: this.allowPrivate,
        onProgress: (n) => {
          job.downloaded = n;
        },
      });
      job.tmp = download.path;
      job.size = download.size;
      if (job.cancelRequested) throw new Cancelled();

      this.set(job, 'checking');
      const checked = await checkStoredFile(download.suggestedName, download.path);
      job.name = checked.name;
      this.set(job, 'storing');
      const result = await this.service.upload(job.uid, {
        uploadId: job.uploadId,
        tmpPath: download.path,
        size: checked.size,
        name: checked.name,
        spec: checked.spec,
        ext: checked.ext,
      });
      job.file = result.file;
      this.set(job, 'completed');
      console.log(`import finished: job=${ref(job.id)} file=${maskName(checked.name)} state=completed`);
    } catch (err) {
      if (job.cancelRequested || err instanceof Cancelled) {
        job.state = 'cancelled';
        job.updatedAt = this.now();
        console.log(`import finished: job=${ref(job.id)} state=cancelled`);
      } else {
        job.error = errorFor(err);
        job.state = 'failed';
        job.updatedAt = this.now();
        console.log(`import finished: job=${ref(job.id)} state=failed code=${job.error.code}`);
      }
    } finally {
      if (job.tmp) await removeFile(job.tmp);
      job.tmp = null;
      job.url = null; // no longer needed, and not kept any longer than the download
    }
  }

  view(uid, uploadId) {
    const job = this.jobs.get(jobKey(uid, uploadId));
    return job ? viewOf(job) : null;
  }

  get(uid, uploadId) {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    const job = this.view(uid, uploadId);
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    return job;
  }

  cancel(uid, uploadId) {
    if (!UPLOAD_ID_RE.test(uploadId)) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    const job = this.jobs.get(jobKey(uid, uploadId));
    if (!job) throw new AppError(404, 'NOT_FOUND', 'Import not found.');
    if (job.state === 'cancelled' || job.state === 'failed') return viewOf(job);
    if (job.state === 'completed') {
      throw new AppError(409, 'IMPORT_ALREADY_DONE', 'This import is finished. Delete the file from your list instead.');
    }
    if (!CANCELLABLE.has(job.state)) {
      throw new AppError(409, 'IMPORT_NOT_CANCELLABLE', 'This import is being saved and can no longer be cancelled.');
    }
    job.cancelRequested = true;
    job.state = 'cancelled';
    job.updatedAt = this.now();
    job.controller.abort('cancelled');
    return viewOf(job);
  }

  // Forgets finished jobs after their time. Their temp files were already removed.
  sweep() {
    const cutoff = this.now() - this.limits.jobTtlMs;
    for (const [key, job] of this.jobs) {
      if (TERMINAL.has(job.state) && job.updatedAt < cutoff) this.jobs.delete(key);
    }
  }
}

// Maps an error to the { code, message } the client sees: stable codes and this app's own messages, never raw
// library text. Unexpected errors are logged by type only.
function errorFor(err) {
  if (err instanceof AppError) return { code: err.code, message: err.message };
  if (err instanceof StorageError || err instanceof GitHubError) {
    if (err instanceof GitHubError && err.rateLimited) {
      return { code: 'RATE_LIMITED', message: 'GitHub is rate limiting requests. Try again later.' };
    }
    return { code: 'IMPORT_STORAGE_FAILED', message: 'The file could not be saved. Try again shortly.' };
  }
  console.error(`Import failed: ${err && err.name}`);
  return { code: 'IMPORT_FAILED', message: 'The import failed. Try again.' };
}

module.exports = { ImportJobs, IMPORT_LIMITS, jobKey };
