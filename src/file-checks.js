'use strict';

// The checks every stored file goes through, whatever its source: a multipart upload, a chunked upload, or an
// import from a URL. Keeping them in one place means the three paths cannot drift apart.
const fs = require('node:fs');
const { AppError } = require('./errors');
const { typeFor, contentMatches, sanitizeFilename, extensionOf } = require('./file-types');

// Returns { name, ext, spec, size } for a file on disk, or throws AppError. Nothing is written.
async function checkStoredFile(rawName, tmpPath) {
  const name = sanitizeFilename(rawName);
  if (!name) throw new AppError(400, 'INVALID_FILENAME', 'Use a file name with letters or digits and an extension.');
  const ext = extensionOf(name);
  const spec = typeFor(ext);
  const { size } = await fs.promises.stat(tmpPath);
  if (size === 0) throw new AppError(400, 'EMPTY_FILE', 'The file is empty.');
  if (!(await contentMatches(spec, tmpPath))) {
    throw new AppError(415, 'FILE_CONTENT_MISMATCH', 'The file contents do not match its type.');
  }
  return { name, ext, spec, size };
}

module.exports = { checkStoredFile };
