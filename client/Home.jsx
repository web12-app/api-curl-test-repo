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

function fmtUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  if (d > 0) return d + 'd ' + h + 'h';
  if (h > 0) return h + 'h ' + m + 'm';
  return m + 'm';
}

function fmtWhen(iso) {
  const t = Date.parse(iso || '');
  return Number.isNaN(t) ? '-' : new Date(t).toLocaleString();
}

// Live status of this server: the public URL and run number (set by the live-tunnel workflow), when it
// started, and how long it has been up. Polls every 30 seconds.
function LiveStatus() {
  const [live, setLive] = useState(null); // null = loading, 'error', or the status object
  useEffect(() => {
    let alive = true;
    const load = () =>
      api('/api/live-status').then((res) => {
        if (alive) setLive(res.ok && res.body ? res.body : 'error');
      });
    load();
    const timer = setInterval(load, 30000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (live === null) {
    return (
      <div className="live-card">
        <span className="live-dot" />
        <span>Checking live status…</span>
      </div>
    );
  }
  if (live === 'error') {
    return (
      <div className="live-card live-off">
        <span className="live-dot" />
        <span>Live status is unavailable right now.</span>
      </div>
    );
  }
  return (
    <div className="live-card" role="status">
      <span className="live-dot" />
      <div className="live-main">
        <strong>Live</strong>
        {live.url ? <a href={live.url} rel="noreferrer"> {live.url}</a> : <span> · running locally</span>}
      </div>
      <dl className="live-meta">
        <div>
          <dt>Serving since</dt>
          <dd>{fmtWhen(live.startedAt)}</dd>
        </div>
        <div>
          <dt>Uptime</dt>
          <dd>{fmtUptime(live.uptimeSeconds)}</dd>
        </div>
        {live.runId ? (
          <div>
            <dt>Run</dt>
            <dd>#{live.runId}</dd>
          </div>
        ) : null}
      </dl>
    </div>
  );
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

      <LiveStatus />

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
