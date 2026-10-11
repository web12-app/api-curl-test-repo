'use strict';

// Downloads one file from a public https:// address to a temp file. It is the only place that talks to remote
// hosts for imports. Each hop is validated before connecting: name, DNS answer, and the connection pinned to the
// checked address. The download is limited while it streams, whatever Content-Length says.
const crypto = require('node:crypto');
const fs = require('node:fs');
const https = require('node:https');
const path = require('node:path');
const { AppError } = require('./errors');
const { validateImportUrl, resolvePublicAddresses, pinnedLookup } = require('./net-guard');
const { sanitizeFilename } = require('./file-types');

const REDIRECT_CODES = new Set([301, 302, 303, 307, 308]);
const DEFAULT_TIMEOUTS = {
  maxRedirects: 3,
  connectTimeoutMs: 10 * 1000, // until the response headers arrive
  idleTimeoutMs: 30 * 1000, // longest silence while the body streams
  totalTimeoutMs: 120 * 1000, // whole import, all hops included
};
const HEADERS = {
  // Only these headers leave the server. Client headers and cookies are never forwarded.
  'User-Agent': 'file-storage-import/1.0',
  Accept: '*/*',
  'Accept-Encoding': 'identity',
  Connection: 'close',
};

const fail = (status, code, message) => new AppError(status, code, message);

// Production transport: HTTPS to the pinned address. The name stays the TLS server name, so the certificate is
// still checked against the host the user asked for.
function httpsTransport(url, { addresses, connectTimeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const onConnectTimeout = () => req.destroy(new Error('connect timeout'));
    const req = https.request(
      {
        method: 'GET',
        host: url.hostname,
        port: 443,
        servername: url.hostname,
        path: `${url.pathname}${url.search}`,
        headers: HEADERS,
        lookup: pinnedLookup(addresses),
        agent: false,
      },
      (res) => {
        // Headers arrived. The idle timeout for the body is set by the caller, so this one must not fire later.
        req.removeListener('timeout', onConnectTimeout);
        resolve(res);
      },
    );
    req.setTimeout(connectTimeoutMs, onConnectTimeout);
    req.on('error', reject);
    if (signal) {
      if (signal.aborted) req.destroy(new Error('aborted'));
      else signal.addEventListener('abort', () => req.destroy(new Error('aborted')), { once: true });
    }
    req.end();
  });
}

function declaredLength(headers) {
  const value = headers['content-length'];
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value.trim())) return null; // unusable: rely on the stream limit
  return Number(value.trim());
}

// Takes the file name from Content-Disposition (filename*, then filename), otherwise from the last path segment.
// Always cleaned by sanitizeFilename, so it can never carry a directory.
function suggestedName(headers, finalUrl) {
  const disposition = typeof headers['content-disposition'] === 'string' ? headers['content-disposition'] : '';
  let candidate = null;
  const star = /filename\*\s*=\s*[^']*'[^']*'([^;]+)/i.exec(disposition);
  if (star) {
    try {
      candidate = decodeURIComponent(star[1].trim());
    } catch {
      candidate = null;
    }
  }
  if (!candidate) {
    const plain = /filename\s*=\s*(?:"([^"]*)"|([^;]+))/i.exec(disposition);
    if (plain) candidate = (plain[1] ?? plain[2] ?? '').trim();
  }
  if (!sanitizeFilename(candidate || '')) {
    const last = finalUrl.pathname.split('/').pop() || '';
    try {
      candidate = decodeURIComponent(last);
    } catch {
      candidate = last;
    }
  }
  return sanitizeFilename(candidate || '') || '';
}

async function writeAll(handle, chunk) {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    offset += bytesWritten;
  }
}

// Options: { tmpDir, maxBytes, lookup, transport, timeouts, signal, onProgress }.
// Resolves to { path, size, suggestedName, finalUrl } or throws AppError. The caller deletes `path`.
async function downloadToFile(rawUrl, options) {
  const timeouts = { ...DEFAULT_TIMEOUTS, ...(options.timeouts || {}) };
  const transport = options.transport || httpsTransport;
  const { maxBytes, tmpDir, lookup, signal, onProgress } = options;

  // One controller for the whole import. Its reason says why it stopped: 'timeout' or 'cancelled'.
  const local = new AbortController();
  const stop = (reason) => {
    if (!local.signal.aborted) local.abort(reason);
  };
  const onOuterAbort = () => stop('cancelled');
  if (signal) {
    if (signal.aborted) stop('cancelled');
    else signal.addEventListener('abort', onOuterAbort, { once: true });
  }
  const totalTimer = setTimeout(() => stop('timeout'), timeouts.totalTimeoutMs);
  let response = null;
  let handle = null;
  let partPath = null;

  const throwIfStopped = () => {
    if (!local.signal.aborted) return;
    if (local.signal.reason === 'timeout') throw fail(504, 'IMPORT_TIMEOUT', 'The download took too long.');
    throw fail(409, 'IMPORT_CANCELLED', 'The import was cancelled.');
  };

  try {
    throwIfStopped();
    let url = validateImportUrl(rawUrl);
    let hop = 0;
    for (;;) {
      const addresses = await resolvePublicAddresses(url.hostname, lookup);
      throwIfStopped();
      let res;
      try {
        res = await transport(url, {
          addresses,
          connectTimeoutMs: timeouts.connectTimeoutMs,
          signal: local.signal,
        });
      } catch (err) {
        throwIfStopped();
        if (err && err.message === 'connect timeout') throw fail(504, 'IMPORT_TIMEOUT', 'The download took too long.');
        throw fail(502, 'IMPORT_UPSTREAM_ERROR', 'The file could not be downloaded.');
      }
      throwIfStopped();
      if (REDIRECT_CODES.has(res.statusCode)) {
        res.resume();
        if (hop >= timeouts.maxRedirects) {
          throw fail(502, 'IMPORT_TOO_MANY_REDIRECTS', 'The link redirects too many times.');
        }
        hop += 1;
        const location = res.headers.location;
        let next;
        try {
          next = typeof location === 'string' && location ? new URL(location, url) : null;
        } catch {
          next = null;
        }
        if (!next) throw fail(502, 'IMPORT_BAD_REDIRECT', 'The link redirects to an address that cannot be used.');
        // Every hop goes through the same checks as the first one: scheme, port, name, DNS, and addresses.
        url = validateImportUrl(next.href);
        continue;
      }
      if (res.statusCode !== 200) {
        res.resume();
        throw fail(502, 'IMPORT_UPSTREAM_STATUS', `The server answered with HTTP ${res.statusCode}. Only successful responses can be imported.`);
      }
      response = res;
      break;
    }

    const encoding = response.headers['content-encoding'];
    if (encoding && String(encoding).trim().toLowerCase() !== 'identity') {
      throw fail(502, 'IMPORT_UNSUPPORTED_ENCODING', 'The server sent a compressed response that cannot be imported.');
    }
    const declared = declaredLength(response.headers);
    if (declared !== null && declared > maxBytes) {
      throw fail(413, 'FILE_TOO_LARGE', `Files must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller.`);
    }

    // The response stops arriving on silence. Idle timeouts stop the import the same way as the total one.
    response.setTimeout(timeouts.idleTimeoutMs, () => stop('timeout'));

    const dir = path.join(tmpDir, 'imports');
    await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
    partPath = path.join(dir, `${crypto.randomBytes(16).toString('hex')}.part`);
    handle = await fs.promises.open(partPath, 'wx', 0o600);

    let total = 0;
    try {
      for await (const chunk of response) {
        throwIfStopped();
        total += chunk.length;
        if (total > maxBytes) {
          throw fail(413, 'FILE_TOO_LARGE', `Files must be ${Math.floor(maxBytes / 1024 / 1024)} MB or smaller.`);
        }
        await writeAll(handle, chunk);
        if (onProgress) onProgress(total);
      }
    } catch (err) {
      throwIfStopped();
      if (err instanceof AppError) throw err;
      throw fail(502, 'IMPORT_INTERRUPTED', 'The download was interrupted.');
    }
    throwIfStopped();
    if (!response.complete || (declared !== null && total !== declared)) {
      throw fail(502, 'IMPORT_INTERRUPTED', 'The download ended before the whole file arrived.');
    }
    await handle.close();
    handle = null;
    return {
      path: partPath,
      size: total,
      suggestedName: suggestedName(response.headers, url),
      finalUrl: url,
    };
  } catch (err) {
    if (handle) await handle.close().catch(() => {});
    if (partPath) await fs.promises.rm(partPath, { force: true }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(totalTimer);
    if (signal) signal.removeEventListener('abort', onOuterAbort);
    if (response && !response.complete) response.destroy();
    if (!local.signal.aborted) local.abort('done');
  }
}

module.exports = { downloadToFile, httpsTransport, DEFAULT_TIMEOUTS, suggestedName };
