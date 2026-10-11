'use strict';

// Browser code for the dashboard. It is embedded in the page through Function.toString(), so it stays ordinary
// JavaScript. It talks only to this app's /api/files routes, using the session cookie. It never sees a GitHub
// token or a storage URL. Text from the server is written with textContent, never as HTML.
function dashboardClient() {
  var root = document.getElementById('dash-config');
  if (!root || root.getAttribute('data-enabled') !== '1') return;

  var MAX_BYTES = Number(root.getAttribute('data-max-bytes')) || 0;
  var ALLOWED = (root.getAttribute('data-allowed') || '').split(',').filter(Boolean);
  var table = document.getElementById('files');
  var tbody = table.querySelector('tbody');
  var statusEl = document.getElementById('files-status');
  var notices = document.getElementById('notices');
  var queue = document.getElementById('queue');
  var quotaEl = document.getElementById('quota');
  var search = document.getElementById('search');
  var category = document.getElementById('category');
  var picker = document.getElementById('picker');
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

  function renderQuota(q) {
    quotaEl.textContent = fmtSize(q.usedBytes) + ' used · ' + q.count + ' of ' + q.maxFiles + ' files';
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

  // Preview covers the same types the server allows inline. The server checks again; this only avoids a
  // pointless request.
  var PREVIEW_EXT = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.pdf', '.txt', '.csv', '.json'];
  function canPreview(name) {
    var dot = name.lastIndexOf('.');
    return dot >= 0 && PREVIEW_EXT.indexOf(name.slice(dot).toLowerCase()) !== -1;
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
      if (file.status === 'deleting') nameCell.appendChild(el('span', { className: 'badge', text: 'Deleting…' }));
      var buttons = [];
      if (canPreview(file.name)) {
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

  function clientCheck(file) {
    if (MAX_BYTES && file.size > MAX_BYTES) {
      return 'Too large. The limit is ' + fmtSize(MAX_BYTES) + '.';
    }
    if (file.size === 0) return 'The file is empty.';
    var dot = file.name.lastIndexOf('.');
    var ext = dot >= 0 ? file.name.slice(dot).toLowerCase() : '';
    if (ALLOWED.indexOf(ext) === -1) return 'This file type is not allowed.';
    return null;
  }

  function sendUpload(file, uploadId, onProgress) {
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
      var form = new FormData();
      form.append('uploadId', uploadId);
      form.append('file', file, file.name);
      xhr.send(form);
    });
  }

  // One row per file in the queue. A failed upload keeps its uploadId, so Retry is safe: the server stores the
  // file once even if an earlier attempt actually succeeded.
  function queueRow(file) {
    var bar = el('progress', { max: '1', value: '0', 'aria-label': 'Upload progress for ' + file.name });
    var label = el('span', { className: 'queue-state', text: 'Waiting…' });
    var row = el('li', { className: 'queue-item' }, [el('span', { className: 'queue-name', text: file.name }), bar, label]);
    queue.appendChild(row);
    return {
      progress: function (fraction) { bar.value = fraction; label.textContent = Math.round(fraction * 100) + '%'; },
      state: function (text, kind) { label.textContent = text; label.className = 'queue-state ' + (kind || ''); },
      done: function () { bar.value = 1; row.classList.add('done'); setTimeout(function () { row.remove(); }, 4000); },
      fail: function (message, retry) {
        label.textContent = message;
        label.className = 'queue-state error';
        if (retry) label.appendChild(el('button', { type: 'button', className: 'linklike', text: 'Retry', onclick: retry }));
      },
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
    var row = queueRow(file);
    var problem = clientCheck(file);
    if (problem) {
      row.fail(problem, null);
      notify('error', file.name + ': ' + problem);
      return;
    }
    var uploadId = uuid();
    var attempt = async function () {
      row.state('Uploading…', '');
      var result = await sendUpload(file, uploadId, row.progress);
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

  async function removeFile(file) {
    if (!window.confirm('Delete "' + file.name + '"? This cannot be undone.')) return;
    var result = await api('/api/files/' + file.id, { method: 'DELETE' });
    if (result.ok) notify('success', file.name + ' deleted.');
    else notify('error', 'Could not delete ' + file.name + ': ' + messageOf(result), result.status === 401);
    loadFiles();
  }

  // ---- wiring

  pickBtn.addEventListener('click', function () { picker.click(); });
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
}

module.exports = { dashboardClient };
