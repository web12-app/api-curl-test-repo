// Shared helpers for the React app: the JSON API wrapper and the small formatters.
// The API uses the session cookie and requires the X-Requested-With header on mutating requests.

export async function api(url, options) {
  const opts = Object.assign({ credentials: 'same-origin', headers: {} }, options || {});
  opts.headers = Object.assign({ 'X-Requested-With': 'fetch' }, opts.headers);
  try {
    const res = await fetch(url, opts);
    let body = {};
    try {
      body = await res.json();
    } catch {
      body = {};
    }
    return { ok: res.ok, status: res.status, body };
  } catch {
    return { ok: false, status: 0, body: { error: { message: 'Network error. Check your connection and try again.' } } };
  }
}

export function messageOf(result) {
  if (result.status === 401) return 'Your session has ended.';
  const err = result.body && result.body.error;
  return (err && err.message) || 'Request failed (' + result.status + ').';
}

export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// A size limit for hints: whole gibibytes as GB, everything smaller as MB. Matches the server's fmtLimit.
export function fmtLimit(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return 'unlimited';
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return (Number.isInteger(gb) ? gb : gb.toFixed(1)) + ' GB';
  }
  return Math.floor(bytes / (1024 * 1024)) + ' MB';
}

export function fmtDate(iso) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function uuid() {
  if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
  const b = new Uint8Array(16);
  crypto.getRandomValues(b);
  b[6] = (b[6] & 0x0f) | 0x40;
  b[8] = (b[8] & 0x3f) | 0x80;
  const h = Array.prototype.map.call(b, (x) => ('0' + x.toString(16)).slice(-2)).join('');
  return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
}

export function copyText(text, notify) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      () => notify('success', 'Link copied.'),
      () => notify('error', 'Copy failed. Select the link and copy it by hand.')
    );
    return;
  }
  notify('success', 'The link is selected. Press Ctrl+C to copy.');
}
