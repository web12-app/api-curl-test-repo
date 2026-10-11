// Upload engine, ported from the old dashboard client without behavior changes.
// Small files are sent whole; files at or above CHUNK_THRESHOLD are sent in verified
// pieces that can resume after a dropped connection or a page reload.
import { api, messageOf, uuid, fmtSize } from './api.js';
import { useNotify } from './notify.jsx';

// Files at or above this size are sent in pieces, so an interrupted upload can resume.
export const CHUNK_THRESHOLD = 4 * 1024 * 1024;
export const PIECE_PARALLEL = 3;
export const PIECE_TRIES = 3;

function clientCheck(file, maxBytes) {
  if (maxBytes && file.size > maxBytes) {
    return 'Too large. The limit is ' + fmtSize(maxBytes) + '.';
  }
  if (file.size === 0) return 'The file is empty.';
  return null;
}

// Whole-file upload (small files). Abort is wired to the signal so Cancel works while bytes are going up.
function sendUpload(file, uploadId, onProgress, signal) {
  return new Promise((resolve) => {
    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/files/upload');
    xhr.setRequestHeader('X-Requested-With', 'fetch');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onload = () => {
      let body = {};
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = {};
      }
      resolve({ ok: xhr.status === 200 || xhr.status === 201, status: xhr.status, body });
    };
    xhr.onerror = () =>
      resolve({ ok: false, status: 0, body: { error: { message: 'Network error. Check your connection and try again.' } } });
    xhr.onabort = () => resolve({ ok: false, status: 0, cancelled: true, body: { error: { message: 'Cancelled.' } } });
    if (signal) signal.addEventListener('abort', () => xhr.abort());
    const form = new FormData();
    form.append('uploadId', uploadId);
    form.append('file', file, file.name);
    xhr.send(form);
  });
}

// One-shot whole-file upload without a queue row: the Tube logo picker and the auto
// thumbnails use this. Returns { ok, status, body } like api().
export async function uploadSmallFile(file) {
  const result = await sendUpload(file, uuid(), () => {}, null);
  return { ok: result.ok, status: result.status, body: result.body };
}

// ---- uploads in pieces. The upload id is kept in this browser, so choosing the same file again resumes it.

function resumeKey(file) {
  return 'upload:' + file.size + ':' + file.lastModified + ':' + file.name;
}

function storedUploadId(key) {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
}

function rememberUploadId(key, id) {
  try {
    if (id) window.localStorage.setItem(key, id);
    else window.localStorage.removeItem(key);
  } catch {
    /* storage may be off: the upload still works, it just cannot resume after a reload */
  }
}

function readSlice(blob) {
  if (blob.arrayBuffer) return blob.arrayBuffer();
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsArrayBuffer(blob);
  });
}

async function sha256Hex(buffer) {
  if (!window.crypto || !crypto.subtle) {
    throw new Error('Large uploads need a secure (https) page in this browser.');
  }
  const digest = await crypto.subtle.digest('SHA-256', buffer);
  return Array.prototype.map.call(new Uint8Array(digest), (b) => ('0' + b.toString(16)).slice(-2)).join('');
}

function pieceLength(session, index) {
  const last = session.chunkCount - 1;
  return index === last ? session.size - last * session.chunkBytes : session.chunkBytes;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Sends one piece. 429 and server errors are retried with a short wait; other refusals are final.
async function sendPiece(session, file, index, signal) {
  const start = index * session.chunkBytes;
  const buffer = await readSlice(file.slice(start, start + pieceLength(session, index)));
  const sha = await sha256Hex(buffer);
  let last = null;
  for (let attempt = 1; attempt <= PIECE_TRIES; attempt++) {
    if (signal.aborted) return { cancelled: true };
    let res = null;
    try {
      res = await fetch('/api/uploads/' + session.id + '/chunks/' + index, {
        method: 'POST',
        credentials: 'same-origin',
        signal,
        headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha },
        body: buffer,
      });
    } catch {
      if (signal.aborted) return { cancelled: true };
      last = { ok: false, status: 0, body: { error: { message: 'Network error. Check your connection and try again.' } } };
    }
    if (res) {
      let body = {};
      try {
        body = await res.json();
      } catch {
        body = {};
      }
      last = { ok: res.ok, status: res.status, body };
      if (res.ok) return last;
      if (res.status !== 429 && res.status < 500) return last;
    }
    if (attempt < PIECE_TRIES) await sleep(500 * attempt);
  }
  return last;
}

// The whole piece-by-piece upload. Returns when the file is stored, the user cancels, or it fails for good.
async function uploadInPieces(file, row, { maxBytes, notify, onStored }) {
  const key = resumeKey(file);
  let uploadId = storedUploadId(key) || uuid();
  const controller = new AbortController();
  let cancelled = false;
  let sessionId = null;

  function initSession() {
    return api('/api/uploads/init', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: file.name, size: file.size, uploadId }),
    });
  }

  function cancelNow() {
    cancelled = true;
    controller.abort();
    row.state('Cancelling…', '');
    rememberUploadId(key, null);
    const id = sessionId;
    if (id) api('/api/uploads/' + id, { method: 'DELETE' });
    row.fail('Cancelled.', null);
  }

  function finished(stored) {
    rememberUploadId(key, null);
    row.done('Uploaded');
    notify('success', file.name + ' uploaded.');
    if (onStored) onStored();
    return stored;
  }

  function failed(message, needsLogin) {
    row.fail(message, () => uploadInPieces(file, row, { maxBytes, notify, onStored }));
    if (message !== 'Cancelled.') notify('error', file.name + ': ' + message, needsLogin);
  }

  try {
    row.state('Starting…', '');
    row.cancelable(cancelNow);
    let init = await initSession();
    if (!init.ok && init.body.error && (init.body.error.code === 'UPLOAD_ID_USED' || init.body.error.code === 'UPLOAD_MISMATCH')) {
      // The stored id belongs to an upload that cannot resume. Start over with a new id.
      uploadId = uuid();
      init = await initSession();
    }
    if (!init.ok) return failed(messageOf(init), init.status === 401);
    const session = init.body.data.session;
    if (cancelled) {
      // Cancel was clicked while the session was being opened. Remove it, unless it already finished.
      if (session.status !== 'completed') api('/api/uploads/' + session.id, { method: 'DELETE' });
      return;
    }
    if (session.status === 'completed') return finished(session.file);
    sessionId = session.id;
    rememberUploadId(key, uploadId);

    const donePieces = {};
    session.received.forEach((i) => {
      donePieces[i] = true;
    });
    const sentBytes = () => {
      let total = 0;
      Object.keys(donePieces).forEach((i) => {
        total += pieceLength(session, Number(i));
      });
      return total;
    };
    row.progress(sentBytes() / file.size);
    row.state('Sending…', '');

    const queueList = session.missing.slice();
    let failure = null;
    async function worker() {
      while (queueList.length && !failure && !cancelled) {
        const index = queueList.shift();
        const result = await sendPiece(session, file, index, controller.signal);
        if (cancelled || (result && result.cancelled)) return;
        if (!result || !result.ok) {
          failure = result ? messageOf(result) : 'The piece could not be sent.';
          return;
        }
        donePieces[index] = true;
        row.progress(sentBytes() / file.size);
      }
    }
    const workers = [];
    for (let w = 0; w < PIECE_PARALLEL; w++) workers.push(worker());
    await Promise.all(workers);
    if (cancelled) return;
    if (failure) return failed(failure, false);

    // From here the server may already be storing the file, so Cancel is no longer offered.
    row.noCancel();
    row.state('Saving…', '');
    const complete = await api('/api/uploads/' + session.id + '/complete', { method: 'POST' });
    if (cancelled) return;
    if (!complete.ok && complete.body.error && complete.body.error.code === 'CHUNKS_MISSING') {
      return failed('Some pieces were lost. Choose the file again to resume.', false);
    }
    if (!complete.ok) return failed(messageOf(complete), complete.status === 401);
    return finished(complete.body.data.file);
  } catch {
    if (!cancelled) failed('Upload failed. Choose the file again to resume.', false);
  }
}

// Uploads every chosen file, one after another. Large files switch to pieces automatically.
export async function uploadFiles(fileList, { maxBytes, add, onFinished, notify }) {
  const files = Array.prototype.slice.call(fileList || []);
  for (const file of files) {
    await uploadOne(file, { maxBytes, add, onFinished, notify });
  }
  onFinished();
}

// ---- auto thumbnails for video uploads (Tube). Best effort: any failure is silent, the capture is
// time-capped, and the main upload is never blocked by more than a couple of seconds.

// Grabs one frame from a video file and returns it as a JPEG File (named "<original>.thumb.jpg"),
// or null when the browser cannot decode the video. The frame comes from ~1s in (or 10% of the
// duration, whichever is shorter) at 640px wide, quality 0.7.
export async function captureVideoThumbnail(file, { width = 640, timeoutMs = 6000 } = {}) {
  try {
    if (!file || !file.type || file.type.indexOf('video/') !== 0) return null;
    if (typeof document === 'undefined' || !window.URL || !window.URL.createObjectURL) return null;
    const url = URL.createObjectURL(file);
    const video = document.createElement('video');
    video.muted = true;
    video.preload = 'metadata';
    video.src = url;
    try {
      const withTimeout = (promise) =>
        Promise.race([
          promise,
          new Promise((_, reject) => setTimeout(() => reject(new Error('thumbnail timeout')), timeoutMs)),
        ]);
      // Wait for the first frame, then seek to the target position and wait for that frame.
      await withTimeout(
        new Promise((resolve, reject) => {
          video.onloadeddata = () => resolve();
          video.onerror = () => reject(new Error('video decode failed'));
        }),
      );
      const duration = isFinite(video.duration) && video.duration > 0 ? video.duration : 0;
      const at = duration ? Math.min(1, duration / 10) : 1;
      if (at > 0 && Math.abs((video.currentTime || 0) - at) > 0.01) {
        await withTimeout(
          new Promise((resolve, reject) => {
            video.onseeked = () => resolve();
            video.onerror = () => reject(new Error('video seek failed'));
            video.currentTime = at;
          }),
        );
      }
      if (!video.videoWidth || !video.videoHeight) return null;
      const canvas = document.createElement('canvas');
      canvas.width = Math.min(width, video.videoWidth);
      canvas.height = Math.round((video.videoHeight / video.videoWidth) * canvas.width);
      const ctx = canvas.getContext('2d');
      if (!ctx) return null;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
      const blob = await withTimeout(
        new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.7)),
      );
      if (!blob) return null;
      return new File([blob], file.name + '.thumb.jpg', { type: 'image/jpeg' });
    } finally {
      URL.revokeObjectURL(url);
      video.removeAttribute('src');
      try {
        video.load();
      } catch {
        /* nothing to clean up */
      }
    }
  } catch {
    return null; // thumbnails are optional; never fail the upload because of one
  }
}

// For video files, stores a small "<name>.thumb.jpg" frame BEFORE the main upload, so the Tube
// publish dialog can suggest it as the thumbnail. Silent no-op on any failure.
async function storeAutoThumbnail(file) {
  if (!file.type || file.type.indexOf('video/') !== 0) return;
  try {
    const thumb = await captureVideoThumbnail(file);
    if (thumb) await uploadSmallFile(thumb);
  } catch {
    /* best effort */
  }
}

async function uploadOne(file, { maxBytes, add, onFinished, notify }) {
  const row = add(file.name, fmtSize(file.size));
  const problem = clientCheck(file, maxBytes);
  if (problem) {
    row.fail(problem, null);
    notify('error', file.name + ': ' + problem);
    return;
  }
  // Auto thumbnail first (bounded, best effort), then the real upload.
  await storeAutoThumbnail(file);
  // Auto-detection: at or above the threshold the upload switches to resumable pieces.
  if (file.size >= CHUNK_THRESHOLD) {
    await uploadInPieces(file, row, { maxBytes, notify });
    return;
  }
  const uploadId = uuid();
  const attempt = async () => {
    const controller = new AbortController();
    row.state('Uploading…', '');
    row.cancelable(() => {
      controller.abort();
      row.fail('Cancelled.', null);
    });
    const result = await sendUpload(file, uploadId, (f) => row.progress(f), controller.signal);
    if (result.cancelled) return;
    if (result.ok) {
      row.done();
      notify('success', file.name + ' uploaded.');
      return;
    }
    const message = messageOf(result);
    row.fail(message, attempt);
    notify('error', file.name + ': ' + message, result.status === 401);
  };
  await attempt();
}
