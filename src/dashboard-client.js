'use strict';

// Browser code for the dashboard. It is embedded in the page through Function.toString(), so it stays ordinary
// JavaScript. It talks only to this app's /api/files routes, using the session cookie. It never sees a GitHub
// token or a storage URL. Text from the server is written with textContent, never as HTML.
function dashboardClient() {
  var root = document.getElementById('dash-config');
  if (!root || root.getAttribute('data-enabled') !== '1') return;

  var MAX_BYTES = Number(root.getAttribute('data-max-bytes')) || 0;
  var table = document.getElementById('files');
  var tbody = table.querySelector('tbody');
  var statusEl = document.getElementById('files-status');
  var notices = document.getElementById('notices');
  var queue = document.getElementById('queue');
  var quotaEl = document.getElementById('quota');
  var linkForm = document.getElementById('link-form');
  var linkLabel = document.getElementById('link-label');
  var linkResult = document.getElementById('link-result');
  var linkStatus = document.getElementById('links-status');
  var linkRows = document.getElementById('links');
  var search = document.getElementById('search');
  var category = document.getElementById('category');
  var picker = document.getElementById('picker');
  var importList = document.getElementById('imports');
  var urlForm = document.getElementById('url-form');
  var urlInput = document.getElementById('url-input');
  var drop = document.getElementById('drop');
  var pickBtn = document.getElementById('pick');
  var searchTimer = null;
  var preview = document.getElementById('preview');

  function el(tag, props, children) {
    var node = document.createElement(tag);
    if (props) {
      Object.keys(props).forEach(function (key) {
        if (key === 'text') node.textContent = props[key];
        else if (key === 'className') node.className = props[key];
        else if (key === 'onclick') node.addEventListener('click', props[key]);
        else node.setAttribute(key, props[key]);
      });
    }
    (children || []).forEach(function (child) {
      node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
    });
    return node;
  }

  function fmtSize(bytes) {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  function fmtDate(iso) {
    var d = new Date(iso);
    return isNaN(d.getTime()) ? '' : d.toLocaleString();
  }

  function uuid() {
    if (window.crypto && crypto.randomUUID) return crypto.randomUUID();
    var b = new Uint8Array(16);
    crypto.getRandomValues(b);
    b[6] = (b[6] & 0x0f) | 0x40;
    b[8] = (b[8] & 0x3f) | 0x80;
    var h = Array.prototype.map.call(b, function (x) { return ('0' + x.toString(16)).slice(-2); }).join('');
    return h.slice(0, 8) + '-' + h.slice(8, 12) + '-' + h.slice(12, 16) + '-' + h.slice(16, 20) + '-' + h.slice(20);
  }

  function notify(kind, message, withLogin) {
    var children = [message];
    if (withLogin) children.push(' ', el('a', { href: '/login', text: 'Log in' }));
    var box = el('div', { className: 'notice ' + kind, role: kind === 'error' ? 'alert' : 'status' }, [
      el('span', null, children),
      el('button', { type: 'button', className: 'linklike', text: 'Dismiss', onclick: function () { box.remove(); } }),
    ]);
    notices.appendChild(box);
    // Keep the stack short, so old messages do not pile up over the list.
    while (notices.children.length > 4) notices.removeChild(notices.firstChild);
    // Messages go away on their own, so they do not stay over the list.
    setTimeout(function () { if (box.parentNode) box.remove(); }, kind === 'success' ? 6000 : 10000);
  }

  async function api(url, options) {
    var opts = Object.assign({ credentials: 'same-origin', headers: {} }, options || {});
    opts.headers = Object.assign({ 'X-Requested-With': 'fetch' }, opts.headers);
    try {
      var res = await fetch(url, opts);
      var body = {};
      try { body = await res.json(); } catch (e) { body = {}; }
      return { ok: res.ok, status: res.status, body: body };
    } catch (e) {
      return { ok: false, status: 0, body: { error: { message: 'Network error. Check your connection and try again.' } } };
    }
  }

  function messageOf(result) {
    if (result.status === 401) return 'Your session has ended.';
    var err = result.body && result.body.error;
    return (err && err.message) || ('Request failed (' + result.status + ').');
  }

  // Only the file count is shown. There is no storage total.
  function renderQuota(q) {
    quotaEl.textContent = q.count + ' of ' + q.maxFiles + ' files';
  }

  function deleteButton(file) {
    return el('button', {
      type: 'button',
      className: 'danger',
      text: file.status === 'deleting' ? 'Retry delete' : 'Delete',
      'aria-label': 'Delete ' + file.name,
      onclick: function () { removeFile(file); },
    });
  }

  function openPreview(file) {
    var frame = document.getElementById('preview-frame');
    document.getElementById('preview-title').textContent = file.name;
    frame.setAttribute('src', '/api/files/' + file.id + '/preview');
    frame.setAttribute('title', 'Preview of ' + file.name);
    if (typeof preview.showModal === 'function') preview.showModal();
    else preview.setAttribute('open', '');
  }

  function closePreview() {
    if (typeof preview.close === 'function') preview.close();
    else preview.removeAttribute('open');
    document.getElementById('preview-frame').setAttribute('src', 'about:blank');
  }

  function copyText(text, input) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(
        function () { notify('success', 'Link copied.'); },
        function () { input.select(); notify('error', 'Copy failed. The link is selected; copy it by hand.'); }
      );
      return;
    }
    input.select();
    notify('success', 'The link is selected. Press Ctrl+C to copy.');
  }

  // Share link box, shown only for public files. The full link is built from this page's origin; the server
  // gives only the path.
  function shareBox(file) {
    var url = window.location.origin + file.sharePath;
    var input = el('input', { type: 'text', readonly: 'readonly', value: url, 'aria-label': 'Share link for ' + file.name });
    input.value = url;
    return el('div', { className: 'share-box' }, [
      input,
      el('button', { type: 'button', text: 'Copy link', onclick: function () { copyText(url, input); } }),
      el('a', { className: 'button', href: file.sharePath, target: '_blank', rel: 'noopener', text: 'Open' }),
    ]);
  }

  async function setSharing(file, makePublic) {
    var result = await api('/api/files/' + file.id + '/sharing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: makePublic }),
    });
    if (result.ok) notify('success', makePublic ? file.name + ' is now shared. Anyone with the link can open it.' : file.name + ' is private again. The old link no longer works.');
    else notify('error', 'Could not change sharing for ' + file.name + ': ' + messageOf(result), result.status === 401);
    loadFiles();
  }

  function renderFiles(files) {
    tbody.textContent = '';
    files.forEach(function (file) {
      var nameCell = el('td', { 'data-label': 'Name' }, [file.name]);
      nameCell.appendChild(el('span', { className: 'badge' + (file.visibility === 'public' ? ' public' : ''), text: file.visibility === 'public' ? 'Public' : 'Private' }));
      if (file.viaLink) nameCell.appendChild(el('span', { className: 'badge', text: 'From upload link' }));
      if (file.status === 'deleting') nameCell.appendChild(el('span', { className: 'badge', text: 'Deleting…' }));
      var buttons = [];
      if (file.previewable) {
        buttons.push(el('button', { type: 'button', text: 'Preview', 'aria-label': 'Preview ' + file.name, onclick: function () { openPreview(file); } }));
      }
      buttons.push(el('a', { className: 'button', href: '/api/files/' + file.id + '/download', download: file.name, text: 'Download' }));
      if (file.status !== 'deleting') {
        buttons.push(el('button', {
          type: 'button',
          text: file.visibility === 'public' ? 'Stop sharing' : 'Share',
          'aria-label': (file.visibility === 'public' ? 'Stop sharing ' : 'Share ') + file.name,
          onclick: function () { setSharing(file, file.visibility !== 'public'); },
        }));
      }
      buttons.push(deleteButton(file));
      var actionsCell = el('td', { 'data-label': 'Actions', className: 'actions' }, [el('div', { className: 'stack' }, buttons)]);
      if (file.visibility === 'public' && file.sharePath) actionsCell.appendChild(shareBox(file));
      var row = el('tr', null, [
        nameCell,
        el('td', { 'data-label': 'Type', text: file.type.split(';')[0] }),
        el('td', { 'data-label': 'Size', text: fmtSize(file.size) }),
        el('td', { 'data-label': 'Uploaded', text: fmtDate(file.uploadedAt) }),
        actionsCell,
      ]);
      tbody.appendChild(row);
    });
  }

  async function loadFiles() {
    statusEl.textContent = 'Loading your files…';
    statusEl.className = '';
    var params = new URLSearchParams();
    if (search.value.trim()) params.set('q', search.value.trim());
    if (category.value) params.set('category', category.value);
    var result = await api('/api/files?' + params.toString());
    if (!result.ok) {
      tbody.textContent = '';
      statusEl.className = 'error';
      statusEl.textContent = 'Could not load your files. ' + messageOf(result) + ' ';
      statusEl.appendChild(el('button', { type: 'button', text: 'Try again', onclick: loadFiles }));
      if (result.status === 401) statusEl.appendChild(el('a', { href: '/login', text: ' Log in' }));
      return;
    }
    renderQuota(result.body.data.quota);
    renderFiles(result.body.data.files);
    if (result.body.data.files.length === 0) {
      statusEl.textContent = search.value || category.value ? 'No files match your search.' : 'No files yet. Upload one above.';
    } else {
      statusEl.textContent = result.body.data.files.length + ' file(s)';
    }
  }

  // ---- uploads

  // Files at or above this size are sent in pieces, so an interrupted upload can resume. Smaller files are sent whole.
  var CHUNK_THRESHOLD = 4 * 1024 * 1024;
  var PIECE_PARALLEL = 3;
  var PIECE_TRIES = 3;

  function clientCheck(file) {
    if (MAX_BYTES && file.size > MAX_BYTES) {
      return 'Too large. The limit is ' + fmtSize(MAX_BYTES) + '.';
    }
    if (file.size === 0) return 'The file is empty.';
    return null;
  }

  // Whole-file upload (small files). Abort is wired to the signal so Cancel works while bytes are going up.
  function sendUpload(file, uploadId, onProgress, signal) {
    return new Promise(function (resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/files/upload');
      xhr.setRequestHeader('X-Requested-With', 'fetch');
      xhr.upload.onprogress = function (e) {
        if (e.lengthComputable) onProgress(e.loaded / e.total);
      };
      xhr.onload = function () {
        var body = {};
        try { body = JSON.parse(xhr.responseText); } catch (e) { body = {}; }
        resolve({ ok: xhr.status === 200 || xhr.status === 201, status: xhr.status, body: body });
      };
      xhr.onerror = function () {
        resolve({ ok: false, status: 0, body: { error: { message: 'Network error. Check your connection and try again.' } } });
      };
      xhr.onabort = function () {
        resolve({ ok: false, status: 0, cancelled: true, body: { error: { message: 'Cancelled.' } } });
      };
      if (signal) signal.addEventListener('abort', function () { xhr.abort(); });
      var form = new FormData();
      form.append('uploadId', uploadId);
      form.append('file', file, file.name);
      xhr.send(form);
    });
  }

  // One row per item in the upload or import list. Name, size, progress, state, and optional Cancel and Retry.
  function queueRow(list, title, sizeText) {
    var bar = el('progress', { max: '1', value: '0', 'aria-label': 'Progress for ' + title });
    var label = el('span', { className: 'queue-state', text: 'Waiting…' });
    var actions = el('span', { className: 'queue-actions' });
    var name = el('span', { className: 'queue-name', text: title });
    if (sizeText) name.appendChild(el('span', { className: 'queue-size', text: ' · ' + sizeText }));
    var row = el('li', { className: 'queue-item' }, [name, bar, el('span', null, [label, ' ', actions])]);
    list.appendChild(row);
    function clearActions() { actions.textContent = ''; }
    return {
      progress: function (fraction) {
        bar.value = Math.max(0, Math.min(1, fraction));
        label.textContent = Math.round(bar.value * 100) + '%';
      },
      indeterminate: function () { bar.removeAttribute('value'); },
      state: function (text, kind) { label.textContent = text; label.className = 'queue-state ' + (kind || ''); },
      cancelable: function (onCancel) {
        clearActions();
        actions.appendChild(el('button', {
          type: 'button',
          className: 'linklike',
          text: 'Cancel',
          'aria-label': 'Cancel ' + title,
          onclick: function () { clearActions(); onCancel(); },
        }));
      },
      done: function (text) {
        clearActions();
        bar.value = 1;
        label.textContent = text || 'Done';
        label.className = 'queue-state done';
        row.classList.add('done');
        setTimeout(function () { row.remove(); }, 4000);
      },
      fail: function (message, retry) {
        clearActions();
        label.textContent = message;
        label.className = 'queue-state error';
        if (retry) actions.appendChild(el('button', { type: 'button', className: 'linklike', text: 'Retry', onclick: retry }));
      },
      noCancel: function () { clearActions(); },
      remove: function () { row.remove(); },
    };
  }

  async function uploadFiles(fileList) {
    var files = Array.prototype.slice.call(fileList || []);
    for (var i = 0; i < files.length; i++) {
      await uploadOne(files[i]);
    }
    loadFiles();
  }

  async function uploadOne(file) {
    var row = queueRow(queue, file.name, fmtSize(file.size));
    var problem = clientCheck(file);
    if (problem) {
      row.fail(problem, null);
      notify('error', file.name + ': ' + problem);
      return;
    }
    if (file.size >= CHUNK_THRESHOLD) {
      await uploadInPieces(file, row);
      return;
    }
    var uploadId = uuid();
    var controller = new AbortController();
    var attempt = async function () {
      controller = new AbortController();
      row.state('Uploading…', '');
      row.cancelable(function () { controller.abort(); row.fail('Cancelled.', null); });
      var result = await sendUpload(file, uploadId, row.progress, controller.signal);
      if (result.cancelled) return;
      if (result.ok) {
        row.done();
        notify('success', file.name + ' uploaded.');
        return;
      }
      var message = messageOf(result);
      row.fail(message, attempt);
      notify('error', file.name + ': ' + message, result.status === 401);
    };
    await attempt();
  }

  // ---- uploads in pieces. The upload id is kept in this browser, so choosing the same file again resumes it.

  function resumeKey(file) {
    return 'upload:' + file.size + ':' + file.lastModified + ':' + file.name;
  }

  function storedUploadId(key) {
    try { return window.localStorage.getItem(key); } catch (e) { return null; }
  }

  function rememberUploadId(key, id) {
    try {
      if (id) window.localStorage.setItem(key, id);
      else window.localStorage.removeItem(key);
    } catch (e) { /* storage may be off: the upload still works, it just cannot resume after a reload */ }
  }

  function readSlice(blob) {
    if (blob.arrayBuffer) return blob.arrayBuffer();
    return new Promise(function (resolve, reject) {
      var reader = new FileReader();
      reader.onload = function () { resolve(reader.result); };
      reader.onerror = function () { reject(reader.error); };
      reader.readAsArrayBuffer(blob);
    });
  }

  async function sha256Hex(buffer) {
    if (!window.crypto || !crypto.subtle) {
      throw new Error('Large uploads need a secure (https) page in this browser.');
    }
    var digest = await crypto.subtle.digest('SHA-256', buffer);
    return Array.prototype.map.call(new Uint8Array(digest), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
  }

  function pieceLength(session, index) {
    var last = session.chunkCount - 1;
    return index === last ? session.size - last * session.chunkBytes : session.chunkBytes;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  // Sends one piece. 429 and server errors are retried with a short wait; other refusals are final.
  async function sendPiece(session, file, index, signal) {
    var start = index * session.chunkBytes;
    var buffer = await readSlice(file.slice(start, start + pieceLength(session, index)));
    var sha = await sha256Hex(buffer);
    var last = null;
    for (var attempt = 1; attempt <= PIECE_TRIES; attempt++) {
      if (signal.aborted) return { cancelled: true };
      var res = null;
      try {
        res = await fetch('/api/uploads/' + session.id + '/chunks/' + index, {
          method: 'POST',
          credentials: 'same-origin',
          signal: signal,
          headers: { 'X-Requested-With': 'fetch', 'Content-Type': 'application/octet-stream', 'X-Chunk-Sha256': sha },
          body: buffer,
        });
      } catch (e) {
        if (signal.aborted) return { cancelled: true };
        last = { ok: false, status: 0, body: { error: { message: 'Network error. Check your connection and try again.' } } };
      }
      if (res) {
        var body = {};
        try { body = await res.json(); } catch (e) { body = {}; }
        last = { ok: res.ok, status: res.status, body: body };
        if (res.ok) return last;
        if (res.status !== 429 && res.status < 500) return last;
      }
      if (attempt < PIECE_TRIES) await sleep(500 * attempt);
    }
    return last;
  }

  // The whole piece-by-piece upload. Returns when the file is stored, the user cancels, or it fails for good.
  async function uploadInPieces(file, row) {
    var key = resumeKey(file);
    var uploadId = storedUploadId(key) || uuid();
    var controller = new AbortController();
    var cancelled = false;
    var sessionId = null;

    async function initSession() {
      return api('/api/uploads/init', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: file.name, size: file.size, uploadId: uploadId }),
      });
    }

    function cancelNow() {
      cancelled = true;
      controller.abort();
      row.state('Cancelling…', '');
      rememberUploadId(key, null);
      var id = sessionId;
      if (id) api('/api/uploads/' + id, { method: 'DELETE' });
      row.fail('Cancelled.', null);
    }

    async function run() {
      row.state('Starting…', '');
      row.cancelable(cancelNow);
      var init = await initSession();
      if (!init.ok && (init.body.error && (init.body.error.code === 'UPLOAD_ID_USED' || init.body.error.code === 'UPLOAD_MISMATCH'))) {
        // The stored id belongs to an upload that cannot resume. Start over with a new id.
        uploadId = uuid();
        init = await initSession();
      }
      if (!init.ok) return failed(messageOf(init), init.status === 401);
      var session = init.body.data.session;
      if (cancelled) {
        // Cancel was clicked while the session was being opened. Remove it, unless it already finished.
        if (session.status !== 'completed') api('/api/uploads/' + session.id, { method: 'DELETE' });
        return;
      }
      if (session.status === 'completed') return finished(session.file);
      sessionId = session.id;
      rememberUploadId(key, uploadId);

      var done = {};
      session.received.forEach(function (i) { done[i] = true; });
      var sentBytes = function () {
        var total = 0;
        Object.keys(done).forEach(function (i) { total += pieceLength(session, Number(i)); });
        return total;
      };
      row.progress(sentBytes() / file.size);
      row.state('Sending…', '');

      var queueList = session.missing.slice();
      var failure = null;
      async function worker() {
        while (queueList.length && !failure && !cancelled) {
          var index = queueList.shift();
          var result = await sendPiece(session, file, index, controller.signal);
          if (cancelled || (result && result.cancelled)) return;
          if (!result || !result.ok) {
            failure = result ? messageOf(result) : 'The piece could not be sent.';
            return;
          }
          done[index] = true;
          row.progress(sentBytes() / file.size);
        }
      }
      var workers = [];
      for (var w = 0; w < PIECE_PARALLEL; w++) workers.push(worker());
      await Promise.all(workers);
      if (cancelled) return;
      if (failure) return failed(failure, false);

      // From here the server may already be storing the file, so Cancel is no longer offered.
      row.noCancel();
      row.state('Saving…', '');
      var complete = await api('/api/uploads/' + session.id + '/complete', { method: 'POST' });
      if (cancelled) return;
      if (!complete.ok && complete.body.error && complete.body.error.code === 'CHUNKS_MISSING') {
        return failed('Some pieces were lost. Choose the file again to resume.', false);
      }
      if (!complete.ok) return failed(messageOf(complete), complete.status === 401);
      return finished(complete.body.data.file);
    }

    function finished(stored) {
      rememberUploadId(key, null);
      row.done('Uploaded');
      notify('success', file.name + ' uploaded.');
      return stored;
    }

    function failed(message, needsLogin) {
      row.fail(message, function () { uploadInPieces(file, row); });
      notify('error', file.name + ': ' + message, needsLogin);
    }

    try {
      await run();
    } catch (e) {
      if (!cancelled) failed('Upload failed. Choose the file again to resume.', false);
    }
  }

  // ---- upload from URL. The server downloads the file. The link is kept only until the import starts.

  function importRow(host) {
    return queueRow(importList, 'Import from ' + host, '');
  }

  // Polls one import until it finishes. Returns when it reaches a final state.
  function pollImport(uploadId, row, host, onCancelState) {
    var timer = null;
    var finishedState = false;
    function stop() {
      finishedState = true;
      if (timer) clearTimeout(timer);
    }
    async function tick() {
      if (finishedState) return;
      var res = await api('/api/files/upload-from-url/' + uploadId);
      if (finishedState) return;
      if (!res.ok && res.status === 0) {
        // Network blip: the import itself is unaffected, so try again shortly.
        timer = setTimeout(tick, 2000);
        return;
      }
      if (!res.ok) {
        stop();
        row.fail(messageOf(res), null);
        notify('error', 'Import from ' + host + ' failed: ' + messageOf(res), res.status === 401);
        return;
      }
      var job = res.body.data.import;
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
        row.fail(job.error ? job.error.message : 'The import failed.', onCancelState.retry);
        notify('error', 'Import from ' + host + ' failed: ' + (job.error ? job.error.message : 'unknown error'));
        return;
      }
      if (job.state === 'cancelled') {
        stop();
        row.fail('Cancelled.', onCancelState.retry);
        return;
      }
      timer = setTimeout(tick, 1000);
    }
    function cancelImport() {
      // Cancel is allowed only before the file is being saved. When the server refuses, the row keeps polling.
      api('/api/files/upload-from-url/' + uploadId, { method: 'DELETE' }).then(function (res) {
        if (finishedState) return;
        if (!res.ok) {
          notify('error', 'This import can no longer be cancelled: ' + messageOf(res));
          row.cancelable(cancelImport);
          return;
        }
        stop();
        row.fail('Cancelled.', onCancelState.retry);
      });
    }
    row.cancelable(cancelImport);
    tick();
  }

  // Starts an import. A retry sends the same upload id, so a file that was already stored is not stored twice.
  function startImport(url) {
    var host = '';
    try { host = new URL(url).hostname; } catch (e) { host = 'link'; }
    var uploadId = uuid();
    var row = importRow(host);
    var callbacks = { retry: null };
    callbacks.retry = function () { begin(); };

    async function begin() {
      row.state('Starting…', '');
      var res = await api('/api/files/upload-from-url', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: url, uploadId: uploadId }),
      });
      if (!res.ok) {
        row.fail(messageOf(res), callbacks.retry);
        notify('error', 'Import failed: ' + messageOf(res), res.status === 401);
        return;
      }
      pollImport(uploadId, row, host, callbacks);
    }
    begin();
  }

  // ---- files, links, and wiring

  async function removeFile(file) {
    if (!window.confirm('Delete "' + file.name + '"? This cannot be undone.')) return;
    var result = await api('/api/files/' + file.id, { method: 'DELETE' });
    if (result.ok) notify('success', file.name + ' deleted.');
    else notify('error', 'Could not delete ' + file.name + ': ' + messageOf(result), result.status === 401);
    loadFiles();
  }

  // ---- upload links. The server returns the path only; the full link is built from this page's origin.

  function linkBox(link) {
    var url = window.location.origin + link.uploadPath;
    var input = el('input', { type: 'text', readonly: 'readonly', 'aria-label': 'Upload link' + (link.label ? ' for ' + link.label : '') });
    input.value = url;
    return el('div', { className: 'share-box' }, [
      input,
      el('button', { type: 'button', text: 'Copy link', onclick: function () { copyText(url, input); } }),
    ]);
  }

  function renderLinks(links) {
    linkRows.querySelector('tbody').textContent = '';
    links.forEach(function (link) {
      var buttons = [];
      if (link.active) {
        buttons.push(el('button', {
          type: 'button',
          className: 'danger',
          text: 'Revoke',
          'aria-label': 'Revoke upload link' + (link.label ? ' ' + link.label : ''),
          onclick: function () { revokeLink(link); },
        }));
      }
      var actionsCell = el('td', { 'data-label': 'Actions', className: 'actions' }, [el('div', { className: 'stack' }, buttons)]);
      if (link.active) actionsCell.appendChild(linkBox(link));
      var row = el('tr', null, [
        el('td', { 'data-label': 'Label', text: link.label || '(no label)' }),
        el('td', { 'data-label': 'Status' }, [el('span', { className: 'badge' + (link.active ? ' public' : ''), text: link.active ? 'Open' : 'Revoked' })]),
        el('td', { 'data-label': 'Uploads', text: link.uploads + ' file(s) · ' + fmtSize(link.usedBytes) }),
        el('td', { 'data-label': 'Created', text: fmtDate(link.createdAt) }),
        actionsCell,
      ]);
      linkRows.querySelector('tbody').appendChild(row);
    });
  }

  async function loadLinks() {
    var result = await api('/api/upload-links');
    if (!result.ok) {
      linkStatus.className = 'error';
      linkStatus.textContent = 'Could not load upload links. ' + messageOf(result);
      return;
    }
    linkStatus.className = '';
    var links = result.body.data.links;
    linkStatus.textContent = links.length ? '' : 'No upload links yet.';
    renderLinks(links);
  }

  async function revokeLink(link) {
    if (!window.confirm('Revoke this upload link? Anyone with it will no longer be able to upload. Files already uploaded stay.')) return;
    var result = await api('/api/upload-links/' + link.id, { method: 'DELETE' });
    if (result.ok) notify('success', 'Upload link revoked.');
    else notify('error', 'Could not revoke the link: ' + messageOf(result), result.status === 401);
    linkResult.textContent = '';
    loadLinks();
  }

  linkForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var result = await api('/api/upload-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: linkLabel.value.trim() }),
    });
    if (!result.ok) {
      notify('error', 'Could not create the link: ' + messageOf(result), result.status === 401);
      return;
    }
    linkResult.textContent = '';
    linkResult.appendChild(el('p', { text: 'Link created. Anyone with this link can upload files to your account. Copy it now, and revoke it when you are done.' }));
    linkResult.appendChild(linkBox(result.body.data.link));
    linkLabel.value = '';
    loadLinks();
  });

  // ---- wiring

  pickBtn.addEventListener('click', function () { picker.click(); });
  urlForm.addEventListener('submit', function (e) {
    e.preventDefault();
    var url = urlInput.value.trim();
    if (!url) {
      notify('error', 'Enter a direct file URL first.');
      return;
    }
    // Cleared at once, so the link is not left on screen. It is kept in memory for this import only.
    urlInput.value = '';
    startImport(url);
  });
  picker.addEventListener('change', function () {
    uploadFiles(picker.files);
    picker.value = '';
  });
  ['dragenter', 'dragover'].forEach(function (type) {
    drop.addEventListener(type, function (e) { e.preventDefault(); drop.classList.add('over'); });
  });
  ['dragleave', 'dragend'].forEach(function (type) {
    drop.addEventListener(type, function () { drop.classList.remove('over'); });
  });
  drop.addEventListener('drop', function (e) {
    e.preventDefault();
    drop.classList.remove('over');
    if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files);
  });
  // A file dropped outside the drop zone would otherwise replace this page.
  window.addEventListener('dragover', function (e) { e.preventDefault(); });
  window.addEventListener('drop', function (e) { e.preventDefault(); });
  search.addEventListener('input', function () {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(loadFiles, 300);
  });
  category.addEventListener('change', loadFiles);
  document.getElementById('preview-close').addEventListener('click', closePreview);
  preview.addEventListener('close', function () { document.getElementById('preview-frame').setAttribute('src', 'about:blank'); });

  loadFiles();
  loadLinks();
}

module.exports = { dashboardClient };
