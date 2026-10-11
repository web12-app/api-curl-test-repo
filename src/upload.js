'use strict';

// Streams a multipart upload to a temp file on disk. The whole file is never held in memory, and the size limit
// is enforced while the bytes arrive. The request is refused early when Content-Length is already too large.
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const Busboy = require('busboy');
const { AppError } = require('./errors');

const FIELD_NAMES = new Set(['uploadId']);

function removeFile(filePath) {
  return fs.promises.rm(filePath, { force: true }).catch(() => {});
}

// Resolves to { fields: { uploadId }, file: { path, filename } } or rejects with an AppError.
// The caller must delete file.path when done.
function receiveUpload(req, { maxFileBytes, tmpDir }) {
  return new Promise((resolve, reject) => {
    let parser;
    try {
      parser = Busboy({
        headers: req.headers,
        // Browsers send filenames as UTF-8. The default (latin1) would mangle non-ASCII names.
        defParamCharset: 'utf8',
        // busboy emits 'limit' when the byte count reaches fileSize, so +1 lets a file of exactly maxFileBytes through.
        limits: { files: 1, fields: 4, fieldSize: 200, fileSize: maxFileBytes + 1, parts: 6 },
      });
    } catch {
      reject(new AppError(400, 'INVALID_MULTIPART', 'Send the file as multipart/form-data.'));
      return;
    }

    const fields = {};
    const outs = [];
    const writes = [];
    const created = [];
    let file = null;
    let failure = null;
    let settled = false;

    const fail = (err) => {
      if (!failure) failure = err;
    };

    parser.on('field', (name, value) => {
      if (FIELD_NAMES.has(name)) fields[name] = value;
    });

    parser.on('file', (name, stream, info) => {
      if (name !== 'file' || file) {
        if (name === 'file') fail(new AppError(400, 'TOO_MANY_FILES', 'Send one file at a time.'));
        stream.resume();
        return;
      }
      const tmp = path.join(tmpDir, crypto.randomBytes(16).toString('hex'));
      created.push(tmp);
      file = { path: tmp, filename: info.filename || '' };
      const out = fs.createWriteStream(tmp, { flags: 'wx', mode: 0o600 });
      outs.push(out);

      stream.on('limit', () => {
        fail(new AppError(413, 'FILE_TOO_LARGE', `Files must be ${Math.floor(maxFileBytes / 1024 / 1024)} MB or smaller.`));
        stream.unpipe(out);
        out.destroy();
        stream.resume();
      });
      stream.on('error', () => fail(new AppError(400, 'UPLOAD_INTERRUPTED', 'The upload was interrupted.')));

      writes.push(
        new Promise((resolveWrite) => {
          out.on('error', (err) => {
            fail(new AppError(500, 'STORE_FAILED', 'The file could not be saved on the server.'));
            // Logged without the message: it can include the path.
            console.error(`Temp file write failed: ${err && err.code}`);
            resolveWrite();
          });
          out.on('close', resolveWrite);
        }),
      );
      stream.pipe(out);
    });

    parser.on('filesLimit', () => fail(new AppError(400, 'TOO_MANY_FILES', 'Send one file at a time.')));
    parser.on('partsLimit', () => fail(new AppError(400, 'TOO_MANY_PARTS', 'The upload has too many parts.')));
    parser.on('fieldsLimit', () => fail(new AppError(400, 'TOO_MANY_PARTS', 'The upload has too many parts.')));
    parser.on('error', () => fail(new AppError(400, 'INVALID_MULTIPART', 'The upload could not be read.')));
    // A client that disconnects mid-upload never ends the parser. Destroying it lets the 'close' handler below
    // remove the partial file and settle, which frees the upload slot.
    const abort = () => {
      if (settled || req.complete) return;
      fail(new AppError(400, 'UPLOAD_INTERRUPTED', 'The upload was interrupted.'));
      for (const o of outs) o.destroy();
      parser.destroy();
    };
    req.on('error', abort);
    req.on('close', abort);

    parser.on('close', async () => {
      if (settled) return;
      settled = true;
      await Promise.all(writes);
      if (failure) {
        await Promise.all(created.map(removeFile));
        reject(failure);
        return;
      }
      if (!file) {
        reject(new AppError(400, 'FILE_REQUIRED', 'Choose a file to upload.'));
        return;
      }
      resolve({ fields: { ...fields }, file });
    });

    req.pipe(parser);
  });
}

module.exports = { receiveUpload, removeFile };
