// The explorer: uploads, URL imports, the file list with previews, and upload links.
// A React port of the old dashboard client with the same behavior and API calls.
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { api, messageOf, fmtSize, fmtDate, fmtLimit, copyText } from './api.js';
import { useNotify } from './notify.jsx';
import { useTasks, TaskList } from './tasks.jsx';
import { uploadFiles } from './chunked.js';
import { restoreImports, importFromUrl } from './imports.js';
import { PreviewModal } from './preview.jsx';

function QuotaText({ quota }) {
  // maxFiles is unlimited (Infinity) on the server, which JSON turns into null; show the count only then.
  const max = quota ? quota.maxFiles : null;
  if (!quota || max === null || max === undefined || !isFinite(max)) {
    return <>{(quota ? quota.count : 0) + ' files'}</>;
  }
  return <>{quota.count + ' of ' + max + ' files'}</>;
}

function ShareBox({ file, notify }) {
  const url = window.location.origin + file.sharePath;
  return (
    <div className="share-box">
      <input type="text" readOnly value={url} aria-label={'Share link for ' + file.name} onChange={() => {}} onFocus={(e) => e.target.select()} />
      <button type="button" onClick={() => copyText(url, notify)}>
        Copy link
      </button>
      <a className="button" href={file.sharePath} target="_blank" rel="noopener">
        Open
      </a>
    </div>
  );
}

function LinkBox({ link, notify }) {
  const url = window.location.origin + link.uploadPath;
  return (
    <div className="share-box">
      <input
        type="text"
        readOnly
        value={url}
        aria-label={'Upload link' + (link.label ? ' for ' + link.label : '')}
        onChange={() => {}}
        onFocus={(e) => e.target.select()}
      />
      <button type="button" onClick={() => copyText(url, notify)}>
        Copy link
      </button>
    </div>
  );
}

function NotConfigured({ user }) {
  return (
    <main>
      <div className="profile">
        <div>
          <h1>Explore files</h1>
          <p>
            Signed in as <strong>{user.username}</strong>.
          </p>
        </div>
      </div>
      <p className="error">File storage is not set up on this server yet. Login works; uploads are unavailable.</p>
    </main>
  );
}

export default function ExplorePage({ user, filesEnabled, maxBytes, linkMaxFiles, linkMaxBytes }) {
  const notify = useNotify();
  const { tasks, add } = useTasks();

  const [files, setFiles] = useState(null);
  const [quota, setQuota] = useState(null);
  const [statusText, setStatusText] = useState('Loading your files…');
  const [statusError, setStatusError] = useState(false);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [previewFile, setPreviewFile] = useState(null);

  const [links, setLinks] = useState(null);
  const [linkStatus, setLinkStatus] = useState('');
  const [linkError, setLinkError] = useState(false);
  const [linkResult, setLinkResult] = useState(null);
  const [linkLabel, setLinkLabel] = useState('');
  const [urlValue, setUrlValue] = useState('');

  const pickerRef = useRef(null);
  const stateRef = useRef(null);
  stateRef.current = { search, category };

  const loadFiles = useCallback(async () => {
    const { search: q, category: cat } = stateRef.current;
    setStatusText('Loading your files…');
    setStatusError(false);
    const params = new URLSearchParams();
    if (q.trim()) params.set('q', q.trim());
    if (cat) params.set('category', cat);
    const result = await api('/api/files?' + params.toString());
    if (!result.ok) {
      setFiles([]);
      setStatusError(true);
      setStatusText('Could not load your files. ' + messageOf(result) + ' ');
      return;
    }
    setQuota(result.body.data.quota);
    setFiles(result.body.data.files);
    if (result.body.data.files.length === 0) {
      setStatusText(q || cat ? 'No files match your search.' : 'No files yet. Upload one above.');
    } else {
      setStatusText(result.body.data.files.length + ' file(s)');
    }
  }, []);

  const loadLinks = useCallback(async () => {
    const result = await api('/api/upload-links');
    if (!result.ok) {
      setLinkError(true);
      setLinkStatus('Could not load upload links. ' + messageOf(result));
      return;
    }
    setLinkError(false);
    const list = result.body.data.links;
    setLinkStatus(list.length ? '' : 'No upload links yet.');
    setLinks(list);
  }, []);

  const importDeps = { add, notify, loadFiles };
  const uploadDeps = { maxBytes, add, onFinished: loadFiles, notify };

  // Search and category changes reload with a short debounce; the first run loads at once.
  const firstRender = useRef(true);
  useEffect(() => {
    if (firstRender.current) {
      firstRender.current = false;
      loadFiles();
      loadLinks();
      restoreImports(importDeps);
      return undefined;
    }
    const timer = setTimeout(loadFiles, 300);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, category]);

  // A file dropped outside the drop zone would otherwise replace this page.
  useEffect(() => {
    const prevent = (e) => e.preventDefault();
    window.addEventListener('dragover', prevent);
    window.addEventListener('drop', prevent);
    return () => {
      window.removeEventListener('dragover', prevent);
      window.removeEventListener('drop', prevent);
    };
  }, []);

  async function setSharing(file, makePublic) {
    const result = await api('/api/files/' + file.id + '/sharing', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ public: makePublic }),
    });
    if (result.ok) {
      notify('success', makePublic ? file.name + ' is now shared. Anyone with the link can open it.' : file.name + ' is private again. The old link no longer works.');
    } else {
      notify('error', 'Could not change sharing for ' + file.name + ': ' + messageOf(result), result.status === 401);
    }
    loadFiles();
  }

  async function removeFile(file) {
    if (!window.confirm('Delete "' + file.name + '"? This cannot be undone.')) return;
    const result = await api('/api/files/' + file.id, { method: 'DELETE' });
    if (result.ok) notify('success', file.name + ' deleted.');
    else notify('error', 'Could not delete ' + file.name + ': ' + messageOf(result), result.status === 401);
    loadFiles();
  }

  async function revokeLink(link) {
    if (!window.confirm('Revoke this upload link? Anyone with it will no longer be able to upload. Files already uploaded stay.')) return;
    const result = await api('/api/upload-links/' + link.id, { method: 'DELETE' });
    if (result.ok) notify('success', 'Upload link revoked.');
    else notify('error', 'Could not revoke the link: ' + messageOf(result), result.status === 401);
    setLinkResult(null);
    loadLinks();
  }

  async function createLink(e) {
    e.preventDefault();
    const result = await api('/api/upload-links', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ label: linkLabel.trim() }),
    });
    if (!result.ok) {
      notify('error', 'Could not create the link: ' + messageOf(result), result.status === 401);
      return;
    }
    setLinkResult({
      link: result.body.data.link,
      note: 'Link created. Anyone with this link can upload files to your account. Copy it now, and revoke it when you are done.',
    });
    setLinkLabel('');
    loadLinks();
  }

  function submitUrl(e) {
    e.preventDefault();
    const url = urlValue.trim();
    if (!url) {
      notify('error', 'Enter a direct file URL first.');
      return;
    }
    // Cleared at once, so the link is not left on screen. It is kept in memory for this import only.
    setUrlValue('');
    importFromUrl(url, importDeps);
  }

  if (!filesEnabled) return <NotConfigured user={user} />;

  const mb = fmtLimit(maxBytes);
  const linkMb = fmtLimit(linkMaxBytes);

  return (
    <main>
      <div className="profile">
        <div>
          <h1>Explore files</h1>
          <p>
            Signed in as <strong>{user.username}</strong>. Your files never appear on the home page - they live here.
          </p>
        </div>
        <p className="quota" aria-live="polite">
          <QuotaText quota={quota} />
        </p>
      </div>

      <section aria-labelledby="upload-title" id="upload">
        <h2 id="upload-title">Upload</h2>
        <div
          className={'drop' + (dragOver ? ' over' : '')}
          tabIndex={0}
          onDragEnter={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragOver={(e) => {
            e.preventDefault();
            setDragOver(true);
          }}
          onDragLeave={() => setDragOver(false)}
          onDragEnd={() => setDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setDragOver(false);
            if (e.dataTransfer && e.dataTransfer.files) uploadFiles(e.dataTransfer.files, uploadDeps);
          }}
        >
          <p>Drag files here, or</p>
          <button type="button" onClick={() => pickerRef.current && pickerRef.current.click()}>
            Choose files
          </button>
          <input
            type="file"
            multiple
            hidden
            ref={pickerRef}
            onChange={(e) => {
              uploadFiles(e.target.files, uploadDeps);
              e.target.value = '';
            }}
          />
          <p className="hint">
            Any file type, up to {mb} per file. Images, video, audio, PDF, and text can be previewed here or in a new
            tab. Other types download as files. Files of 4 MB and above are sent in pieces automatically: if the
            connection drops, choose the same file again to resume it.
          </p>
        </div>
        <form className="url-form" onSubmit={submitUrl}>
          <label htmlFor="url-input">Upload from URL</label>
          <div className="url-row">
            <input
              type="text"
              id="url-input"
              name="url"
              inputMode="url"
              placeholder="Paste any file link (http, https, data:)"
              aria-label="Paste any file link"
              autoComplete="off"
              maxLength={16384}
              required
              spellCheck={false}
              value={urlValue}
              onChange={(e) => setUrlValue(e.target.value)}
            />
            <button type="submit" id="url-submit">
              Import
            </button>
          </div>
          <p className="hint">
            Paste any direct link to a file: http:// or https:// (any port, IP address, or user:pass for private
            files), or a data: link, up to {mb}. The download runs in the background and keeps going even if you
            reload the page; the link is not kept after the import finishes.
          </p>
        </form>
        <TaskList tasks={tasks} label="Uploads and imports" />
      </section>

      <section aria-labelledby="files-title" id="files">
        <h2 id="files-title">Your files</h2>
        <div className="toolbar">
          <label>
            Search
            <input
              type="search"
              placeholder="File name"
              maxLength={100}
              autoComplete="off"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </label>
          <label>
            Type
            <select value={category} onChange={(e) => setCategory(e.target.value)}>
              <option value="">All types</option>
              <option value="image">Images</option>
              <option value="document">Documents</option>
              <option value="archive">Archives</option>
              <option value="video">Video</option>
              <option value="audio">Audio</option>
              <option value="other">Other</option>
            </select>
          </label>
        </div>
        <p role="status" className={statusError ? 'error' : ''}>
          {statusText}
          {statusError ? (
            <>
              {' '}
              <button type="button" className="linklike" onClick={loadFiles}>
                Try again
              </button>
              <a href="/login"> Log in</a>
            </>
          ) : null}
        </p>
        <table className="files">
          <thead>
            <tr>
              <th>Name</th>
              <th>Type</th>
              <th>Size</th>
              <th>Uploaded</th>
              <th>
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(files || []).map((file) => (
              <tr key={file.id}>
                <td data-label="Name">
                  {file.name}
                  <span className={'badge' + (file.visibility === 'public' ? ' public' : '')}>
                    {file.visibility === 'public' ? 'Public' : 'Private'}
                  </span>
                  {file.viaLink ? <span className="badge">From upload link</span> : null}
                  {file.status === 'deleting' ? <span className="badge">Deleting…</span> : null}
                </td>
                <td data-label="Type">{file.type.split(';')[0]}</td>
                <td data-label="Size">{fmtSize(file.size)}</td>
                <td data-label="Uploaded">{fmtDate(file.uploadedAt)}</td>
                <td data-label="Actions" className="actions">
                  <div className="stack">
                    {file.previewable ? (
                      <button type="button" aria-label={'Preview ' + file.name} onClick={() => setPreviewFile(file)}>
                        Preview
                      </button>
                    ) : null}
                    {file.previewable ? (
                      <a
                        className="button"
                        href={'/api/files/' + file.id + '/preview'}
                        target="_blank"
                        rel="noopener"
                        aria-label={'Open ' + file.name + ' in a new tab'}
                      >
                        Open tab
                      </a>
                    ) : null}
                    <a className="button" href={'/api/files/' + file.id + '/download'} download={file.name}>
                      Download
                    </a>
                    {file.status !== 'deleting' ? (
                      <button
                        type="button"
                        aria-label={(file.visibility === 'public' ? 'Stop sharing ' : 'Share ') + file.name}
                        onClick={() => setSharing(file, file.visibility !== 'public')}
                      >
                        {file.visibility === 'public' ? 'Stop sharing' : 'Share'}
                      </button>
                    ) : null}
                    <button
                      type="button"
                      className="danger"
                      aria-label={'Delete ' + file.name}
                      onClick={() => removeFile(file)}
                    >
                      {file.status === 'deleting' ? 'Retry delete' : 'Delete'}
                    </button>
                  </div>
                  {file.visibility === 'public' && file.sharePath ? <ShareBox file={file} notify={notify} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>

      <PreviewModal file={previewFile} onClose={() => setPreviewFile(null)} />

      <section aria-labelledby="links-title" id="links">
        <h2 id="links-title">Upload links</h2>
        <p className="hint">
          Anyone with a link can upload one file at a time to your account, with no login. Revoke a link when you no
          longer want it to work. Each link accepts up to {linkMaxFiles} files and {linkMb} in total. Files uploaded
          through a link count toward your file limit.
        </p>
        <form className="toolbar" onSubmit={createLink}>
          <label>
            Label (optional)
            <input
              type="text"
              maxLength={60}
              autoComplete="off"
              value={linkLabel}
              onChange={(e) => setLinkLabel(e.target.value)}
            />
          </label>
          <div>
            <button type="submit">Create upload link</button>
          </div>
        </form>
        <div role="status">
          {linkResult ? (
            <>
              <p>{linkResult.note}</p>
              <LinkBox link={linkResult.link} notify={notify} />
            </>
          ) : null}
        </div>
        <p role="status" className={linkError ? 'error' : ''}>
          {linkStatus}
        </p>
        <table className="files">
          <thead>
            <tr>
              <th>Label</th>
              <th>Status</th>
              <th>Uploads</th>
              <th>Created</th>
              <th>
                <span className="sr">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {(links || []).map((link) => (
              <tr key={link.id}>
                <td data-label="Label">{link.label || '(no label)'}</td>
                <td data-label="Status">
                  <span className={'badge' + (link.active ? ' public' : '')}>{link.active ? 'Open' : 'Revoked'}</span>
                </td>
                <td data-label="Uploads">
                  {link.uploads + ' file(s) · ' + fmtSize(link.usedBytes)}
                </td>
                <td data-label="Created">{fmtDate(link.createdAt)}</td>
                <td data-label="Actions" className="actions">
                  <div className="stack">
                    {link.active ? (
                      <button
                        type="button"
                        className="danger"
                        aria-label={'Revoke upload link' + (link.label ? ' ' + link.label : '')}
                        onClick={() => revokeLink(link)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </div>
                  {link.active ? <LinkBox link={link} notify={notify} /> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </section>
    </main>
  );
}
