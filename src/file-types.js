'use strict';

// Which files may be stored, and how their contents are checked. The client's claimed type is never trusted:
// the stored type comes from the extension, and the bytes must match it. Active content (HTML, SVG, scripts)
// is not on the list.
const fs = require('node:fs');
const path = require('node:path');

const SIG = {
  pdf: [0x25, 0x50, 0x44, 0x46, 0x2d], // %PDF-
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
  jpeg: [0xff, 0xd8, 0xff],
  gif87: [0x47, 0x49, 0x46, 0x38, 0x37, 0x61], // GIF87a
  gif89: [0x47, 0x49, 0x46, 0x38, 0x39, 0x61], // GIF89a
  zip: [0x50, 0x4b, 0x03, 0x04],
  zipEmpty: [0x50, 0x4b, 0x05, 0x06],
};

const TYPES = {
  '.txt': { mime: 'text/plain; charset=utf-8', category: 'document', text: true },
  '.csv': { mime: 'text/csv; charset=utf-8', category: 'document', text: true },
  '.json': { mime: 'application/json; charset=utf-8', category: 'document', text: true },
  '.pdf': { mime: 'application/pdf', category: 'document', signatures: [SIG.pdf] },
  '.png': { mime: 'image/png', category: 'image', signatures: [SIG.png] },
  '.jpg': { mime: 'image/jpeg', category: 'image', signatures: [SIG.jpeg] },
  '.jpeg': { mime: 'image/jpeg', category: 'image', signatures: [SIG.jpeg] },
  '.gif': { mime: 'image/gif', category: 'image', signatures: [SIG.gif87, SIG.gif89] },
  '.webp': { mime: 'image/webp', category: 'image', webp: true },
  '.zip': { mime: 'application/zip', category: 'archive', signatures: [SIG.zip, SIG.zipEmpty] },
};

const ALLOWED_EXTENSIONS = Object.keys(TYPES);
const CATEGORIES = ['image', 'document', 'archive'];
const MAX_NAME_CHARS = 120;

// Returns the cleaned display name, or null if the name cannot be used.
// Only the last path segment is kept, so "../../x.txt" becomes "x.txt". The name is never used as a storage path.
function sanitizeFilename(raw) {
  if (typeof raw !== 'string') return null;
  let name = raw.split(/[\\/]/).pop().replace(/[\u0000-\u001f\u007f]/g, '').trim();
  if (!name || name === '.' || name === '..' || name.startsWith('.')) return null;
  if (name.length > MAX_NAME_CHARS) {
    const ext = path.extname(name).slice(0, 12);
    name = name.slice(0, MAX_NAME_CHARS - ext.length) + ext;
  }
  return name;
}

// The extension used for the stored type. Lowercased, and empty when there is none.
function extensionOf(name) {
  return path.extname(name).toLowerCase();
}

// Header-safe version of a name for Content-Disposition's plain filename parameter.
function asciiFallback(name) {
  return name.replace(/[^\x20-\x7e]|["\\;]/g, '_');
}

// RFC 5987 encoding for the filename* parameter.
function encodeFilenameStar(name) {
  return encodeURIComponent(name).replace(/['()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function matchesAt(buf, offset, sig) {
  if (buf.length < offset + sig.length) return false;
  return sig.every((byte, i) => buf[offset + i] === byte);
}

// Checks the first bytes of a binary type against its signatures.
function headMatches(spec, head) {
  if (!spec) return false;
  if (spec.webp) {
    return matchesAt(head, 0, [0x52, 0x49, 0x46, 0x46]) && matchesAt(head, 8, [0x57, 0x45, 0x42, 0x50]);
  }
  return spec.signatures.some((sig) => matchesAt(head, 0, sig));
}

// Reads the first 16 bytes of a file.
function readHead(filePath) {
  return new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath, { start: 0, end: 15 });
    const chunks = [];
    stream.on('data', (c) => chunks.push(c));
    stream.on('error', reject);
    stream.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

// Text types: no NUL bytes and valid UTF-8 across the whole file. Streams the file, so size does not matter here.
// Resolves to false for invalid content. Filesystem errors are rethrown.
async function isTextFile(filePath) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  try {
    for await (const chunk of fs.createReadStream(filePath)) {
      if (chunk.includes(0)) return false;
      decoder.decode(chunk, { stream: true });
    }
    decoder.decode();
    return true;
  } catch (err) {
    if (err instanceof TypeError) return false; // TextDecoder throws TypeError on invalid UTF-8
    throw err;
  }
}

// Confirms the bytes match the type from the extension. Resolves to true or false.
async function contentMatches(spec, filePath) {
  if (spec.text) return isTextFile(filePath);
  return headMatches(spec, await readHead(filePath));
}

module.exports = {
  TYPES,
  ALLOWED_EXTENSIONS,
  CATEGORIES,
  sanitizeFilename,
  extensionOf,
  asciiFallback,
  encodeFilenameStar,
  contentMatches,
};
