'use strict';

// Which files may be stored, and how their contents are checked. The client's claimed type is never trusted:
// the stored type comes from the extension, and the bytes must match it. Active content (HTML, SVG, scripts)
// is not on the list.
const fs = require('node:fs');
const path = require('node:path');

const at = (head, offset, bytes) => bytes.every((b, i) => head[offset + i] === b) && head.length >= offset + bytes.length;

const ascii = (text) => [...Buffer.from(text, 'ascii')];
// Each known type may have a content check on the first 16 bytes. Types without one (generic) are stored as
// application/octet-stream and are only ever downloaded as attachments.
const MATCH = {
  pdf: (h) => at(h, 0, ascii('%PDF-')),
  png: (h) => at(h, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  jpeg: (h) => at(h, 0, [0xff, 0xd8, 0xff]),
  gif: (h) => at(h, 0, ascii('GIF87a')) || at(h, 0, ascii('GIF89a')),
  webp: (h) => at(h, 0, ascii('RIFF')) && at(h, 8, ascii('WEBP')),
  zip: (h) => at(h, 0, [0x50, 0x4b, 0x03, 0x04]) || at(h, 0, [0x50, 0x4b, 0x05, 0x06]),
  // MP4, MOV, M4A: an 'ftyp' box at byte 4.
  ftyp: (h) => at(h, 4, ascii('ftyp')),
  // Matroska and WebM share the EBML header.
  ebml: (h) => at(h, 0, [0x1a, 0x45, 0xdf, 0xa3]),
  mp3: (h) => at(h, 0, ascii('ID3')) || at(h, 0, [0xff, 0xfb]) || at(h, 0, [0xff, 0xf3]) || at(h, 0, [0xff, 0xf2]),
  wav: (h) => at(h, 0, ascii('RIFF')) && at(h, 8, ascii('WAVE')),
  ogg: (h) => at(h, 0, ascii('OggS')),
};

const TYPES = {
  '.txt': { mime: 'text/plain; charset=utf-8', category: 'document', text: true },
  '.md': { mime: 'text/plain; charset=utf-8', category: 'document', text: true },
  '.log': { mime: 'text/plain; charset=utf-8', category: 'document', text: true },
  '.csv': { mime: 'text/csv; charset=utf-8', category: 'document', text: true },
  '.json': { mime: 'application/json; charset=utf-8', category: 'document', text: true },
  '.pdf': { mime: 'application/pdf', category: 'document', match: MATCH.pdf },
  '.png': { mime: 'image/png', category: 'image', match: MATCH.png },
  '.jpg': { mime: 'image/jpeg', category: 'image', match: MATCH.jpeg },
  '.jpeg': { mime: 'image/jpeg', category: 'image', match: MATCH.jpeg },
  '.gif': { mime: 'image/gif', category: 'image', match: MATCH.gif },
  '.webp': { mime: 'image/webp', category: 'image', match: MATCH.webp },
  '.zip': { mime: 'application/zip', category: 'archive', match: MATCH.zip },
  '.mp4': { mime: 'video/mp4', category: 'video', match: MATCH.ftyp },
  '.mov': { mime: 'video/quicktime', category: 'video', match: MATCH.ftyp },
  '.webm': { mime: 'video/webm', category: 'video', match: MATCH.ebml },
  '.mkv': { mime: 'video/x-matroska', category: 'video', match: MATCH.ebml },
  '.mp3': { mime: 'audio/mpeg', category: 'audio', match: MATCH.mp3 },
  '.wav': { mime: 'audio/wav', category: 'audio', match: MATCH.wav },
  '.ogg': { mime: 'audio/ogg', category: 'audio', match: MATCH.ogg },
  '.m4a': { mime: 'audio/mp4', category: 'audio', match: MATCH.ftyp },
};

// Any other type. Stored as-is, never shown inline.
const GENERIC = { mime: 'application/octet-stream', category: 'other' };

const typeFor = (ext) => TYPES[ext] || GENERIC;
const ALLOWED_EXTENSIONS = Object.keys(TYPES);
// Types the browser can show inline. HTML, SVG, and scripts are never here, and every inline response is sandboxed.
const PREVIEW_EXTENSIONS = [
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.md', '.log', '.csv', '.json',
  '.mp4', '.webm', '.mov', '.mp3', '.wav', '.ogg', '.m4a',
];
const isPreviewable = (name) => PREVIEW_EXTENSIONS.includes(extensionOf(name));
const CATEGORIES = ['image', 'document', 'archive', 'video', 'audio', 'other'];
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

// Checks the first bytes of a binary type. Generic types have no check.
function headMatches(spec, head) {
  if (!spec.match) return true;
  return Boolean(spec.match(head));
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
  GENERIC,
  typeFor,
  ALLOWED_EXTENSIONS,
  PREVIEW_EXTENSIONS,
  isPreviewable,
  CATEGORIES,
  sanitizeFilename,
  extensionOf,
  asciiFallback,
  encodeFilenameStar,
  contentMatches,
};
