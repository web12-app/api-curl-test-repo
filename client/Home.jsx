// The app home page: greeting, live stats, quick actions, and the facts list.
// No file list here - that lives on Explore.
import React, { useEffect, useState } from 'react';
import { api, fmtSize, fmtLimit } from './api.js';
import { FolderIcon, LinkIcon, UploadIcon } from './icons.jsx';

function fmtStatBytes(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  if (bytes < 1024 * 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

function HomePage({ user, filesEnabled, maxBytes }) {
  const [stats, setStats] = useState(null); // null = loading, 'error', or { files, bytes, shared, links }

  useEffect(() => {
    if (!filesEnabled) return undefined;
    let live = true;
    Promise.all([api('/api/files'), api('/api/upload-links')])
      .then(([filesRes, linksRes]) => {
        if (!live) return;
        if (!filesRes.ok || !linksRes.ok) {
          setStats('error');
          return;
        }
        const files = Array.isArray(filesRes.body.data) ? filesRes.body.data : [];
        const links = (linksRes.body.data && linksRes.body.data.links) || [];
        const ready = files.filter((f) => f.status === 'ready' || f.status === 'deleting');
        const bytes = ready.reduce((sum, f) => sum + (f.size || 0), 0);
        const shared = ready.filter((f) => f.visibility === 'public').length;
        const active = links.filter((l) => !l.revokedAt).length;
        setStats({ files: ready.length, bytes, shared, links });
      })
      .catch(() => {
        if (live) setStats('error');
      });
    return () => {
      live = false;
    };
  }, [filesEnabled]);

  const statValue = (key) => {
    if (stats === null) return '…';
    if (stats === 'error') return '-';
    if (key === 'bytes') return fmtStatBytes(stats.bytes);
    return String(stats[key]);
  };

  return (
    <main>
      <div className="profile">
        <div>
          <h1>Welcome back, {user.username}</h1>
          <p>
            Your space is ready. Files and uploads live under <a href="/explore">Explore</a> - this page stays an
            overview.
          </p>
        </div>
      </div>

      <h2>Overview</h2>
      {filesEnabled ? (
        <div className="stat-grid">
          <div className="stat-card">
            <div className="num">{statValue('files')}</div>
            <div className="lbl">Files</div>
          </div>
          <div className="stat-card">
            <div className="num">{statValue('bytes')}</div>
            <div className="lbl">Storage used</div>
          </div>
          <div className="stat-card">
            <div className="num">{statValue('shared')}</div>
            <div className="lbl">Shared files</div>
          </div>
          <div className="stat-card">
            <div className="num">{statValue('links')}</div>
            <div className="lbl">Active upload links</div>
          </div>
        </div>
      ) : (
        <p className="error">File storage is not set up on this server yet. Login works; uploads are unavailable.</p>
      )}

      <h2>Quick actions</h2>
      <div className="quick-grid">
        <a className="quick-card" href="/explore">
          <FolderIcon />
          <div>
            <h3>Explore files</h3>
            <p>Browse, search, preview, share, and download everything you have stored.</p>
          </div>
        </a>
        <a className="quick-card" href="/explore#upload">
          <UploadIcon />
          <div>
            <h3>Upload</h3>
            <p>Drag files in, pick them, or import from any http, https, or data: link.</p>
          </div>
        </a>
        <a className="quick-card" href="/explore#links">
          <LinkIcon />
          <div>
            <h3>Upload links</h3>
            <p>Let someone without an account send you a file through a revocable link.</p>
          </div>
        </a>
      </div>

      <h2>Good to know</h2>
      <ul className="facts">
        <li>Every file can be up to {fmtLimit(maxBytes)}; file types are verified by their content, not just the name.</li>
        <li>Your bytes live as release assets in a private GitHub repository - the server keeps no copies.</li>
        <li>Share and upload links can be revoked at any time; revoking stops old links immediately.</li>
      </ul>
    </main>
  );
}

export default HomePage;
