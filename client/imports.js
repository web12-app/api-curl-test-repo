// Upload-from-URL client. Imports run in the background on the server; this code only
// starts them and polls. Active imports are remembered in localStorage, so a reload
// re-attaches to them instead of losing sight of a running download.
import { api, messageOf, uuid, fmtSize } from './api.js';

const IMPORTS_KEY = 'fv-active-imports';

function readStoredImports() {
  try {
    const raw = window.localStorage.getItem(IMPORTS_KEY);
    const list = raw ? JSON.parse(raw) : [];
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeStoredImports(list) {
  try {
    if (list.length) window.localStorage.setItem(IMPORTS_KEY, JSON.stringify(list));
    else window.localStorage.removeItem(IMPORTS_KEY);
  } catch {
    /* storage may be off: imports still work, they just do not survive a reload */
  }
}

function rememberImport(entry) {
  const list = readStoredImports().filter((item) => item.id !== entry.id);
  list.push(entry);
  writeStoredImports(list);
}

function forgetImport(id) {
  writeStoredImports(readStoredImports().filter((item) => item.id !== id));
}

// Polls one import until it finishes. Returns when it reaches a final state. With
// opts.reattached, a 404 (the job is gone, e.g. after a server restart) is reported
// as such instead of a plain failure.
function pollImport(uploadId, row, host, callbacks, opts, deps) {
  const { notify, loadFiles } = deps;
  let timer = null;
  let finishedState = false;
  const reattached = !!(opts && opts.reattached);

  function stop() {
    finishedState = true;
    if (timer) clearTimeout(timer);
    if (opts && opts.onDone) opts.onDone();
  }

  async function tick() {
    if (finishedState) return;
    const res = await api('/api/files/upload-from-url/' + uploadId);
    if (finishedState) return;
    if (!res.ok && res.status === 0) {
      // Network blip: the import itself is unaffected, so try again shortly.
      timer = setTimeout(tick, 2000);
      return;
    }
    if (!res.ok && reattached && res.status === 404) {
      stop();
      row.fail('This import is no longer running (the server was restarted). Retry to start it again.', callbacks.retry);
      return;
    }
    if (!res.ok) {
      stop();
      row.fail(messageOf(res), null);
      notify('error', 'Import from ' + host + ' failed: ' + messageOf(res), res.status === 401);
      return;
    }
    const job = res.body.data.import;
    if (job.state === 'queued') row.state('Waiting…', '');
    else if (job.state === 'downloading') {
      row.indeterminate();
      row.state(job.downloaded ? 'Downloading… ' + fmtSize(job.downloaded) : 'Downloading…', '');
    } else if (job.state === 'checking' || job.state === 'storing') {
      row.indeterminate();
      row.state('Saving…', '');
    }
    if (job.state === 'completed') {
      stop();
      row.done('Imported ' + (job.name || 'file'));
      notify('success', (job.name || 'File') + ' imported.');
      loadFiles();
      return;
    }
    if (job.state === 'failed') {
      stop();
      row.fail(job.error ? job.error.message : 'The import failed.', callbacks.retry);
      notify('error', 'Import from ' + host + ' failed: ' + (job.error ? job.error.message : 'unknown error'));
      return;
    }
    if (job.state === 'cancelled') {
      stop();
      row.fail('Cancelled.', callbacks.retry);
      return;
    }
    timer = setTimeout(tick, 1000);
  }

  function cancelImport() {
    // Cancel is allowed only before the file is being saved. When the server refuses, the row keeps polling.
    api('/api/files/upload-from-url/' + uploadId, { method: 'DELETE' }).then((res) => {
      if (finishedState) return;
      if (!res.ok) {
        notify('error', 'This import can no longer be cancelled: ' + messageOf(res));
        row.cancelable(cancelImport);
        return;
      }
      stop();
      row.fail('Cancelled.', callbacks.retry);
    });
  }
  row.cancelable(cancelImport);
  tick();
}

// Starts an import. A retry sends the same upload id, so a file that was already stored
// is not stored twice. The import runs in the background on the server; this page only watches it.
function startImport(url, deps) {
  const { add, notify, loadFiles } = deps;
  let host = '';
  try {
    host = new URL(url).hostname;
  } catch {
    host = 'link';
  }
  const uploadId = uuid();
  const row = add('Import from ' + host, '');
  const callbacks = { retry: null };
  callbacks.retry = () => begin();

  async function begin() {
    row.state('Starting…', '');
    const res = await api('/api/files/upload-from-url', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url, uploadId }),
    });
    if (!res.ok) {
      row.fail(messageOf(res), callbacks.retry);
      notify('error', 'Import failed: ' + messageOf(res), res.status === 401);
      return;
    }
    // Remembered only after the server accepted the job, so a reload re-attaches to real imports.
    rememberImport({ id: uploadId, host, url });
    pollImport(uploadId, row, host, callbacks, { onDone: () => forgetImport(uploadId) }, { notify, loadFiles });
  }
  begin();
}

// Re-attaches to imports that were started before the last reload. The server kept working
// on them; the rows here just resume watching. A job the server no longer knows is reported
// and offered for retry.
export function restoreImports(deps) {
  readStoredImports().forEach((entry) => {
    if (!entry || !entry.id) return;
    const { add, notify, loadFiles } = deps;
    const row = add('Import from ' + (entry.host || 'link'), '');
    row.indeterminate();
    row.state('Reconnecting…', '');
    const callbacks = { retry: () => startImport(entry.url, deps) };
    pollImport(
      entry.id,
      row,
      entry.host || 'link',
      callbacks,
      { reattached: true, onDone: () => forgetImport(entry.id) },
      { notify, loadFiles }
    );
  });
}

export function importFromUrl(url, deps) {
  startImport(url, deps);
}
