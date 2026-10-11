// Tube: a YouTube-like layer over the file storage. The server renders the same React shell as
// /home and /explore and hands the page data over in the JSON bootstrap block:
// - page "tube":        { channel, feed: { videos } }   - the video feed
// - page "tube-watch":  { video, channel }              - one published video (server 404s otherwise)
// - page "tube-channel":{ channel, videos }             - one public channel
// Navigation between views is plain links, exactly how /home and /explore switch today.
import React, { useEffect, useRef, useState } from 'react';
import { api, messageOf, fmtSize } from './api.js';
import { useNotify } from './notify.jsx';
import { uploadSmallFile } from './chunked.js';
import { PlayIcon } from './icons.jsx';

// "3 days ago" style dates, like the video sites use.
export function timeAgo(iso) {
  const then = new Date(iso).getTime();
  if (isNaN(then)) return '';
  const seconds = Math.max(0, Math.floor((Date.now() - then) / 1000));
  const steps = [
    [31536000, 'year'],
    [2592000, 'month'],
    [604800, 'week'],
    [86400, 'day'],
    [3600, 'hour'],
    [60, 'minute'],
  ];
  for (const [span, unit] of steps) {
    const n = Math.floor(seconds / span);
    if (n >= 1) return n + ' ' + unit + (n === 1 ? '' : 's') + ' ago';
  }
  return 'just now';
}

// Circular channel logo, or the first letter of the name when there is none.
export function Avatar({ name, logoUrl, size }) {
  const style = size ? { width: size, height: size, fontSize: size * 0.42 } : undefined;
  if (logoUrl) {
    return (
      <span className="tube-avatar" style={style}>
        <img src={logoUrl} alt="" />
      </span>
    );
  }
  return (
    <span className="tube-avatar" style={style} aria-hidden="true">
      {(name || '?').charAt(0).toUpperCase()}
    </span>
  );
}

// 16:9 thumbnail area: the stored thumbnail when there is one, else a dark gradient with a play icon.
function Thumb({ video }) {
  return (
    <div className="tube-thumb">
      {video.thumbnailUrl ? <img src={video.thumbnailUrl} alt="" loading="lazy" /> : <PlayIcon size={42} />}
    </div>
  );
}

// One video card in the feed or on a channel page. The whole card is a link to the watch screen.
export function VideoCard({ video }) {
  return (
    <a className="tube-card" href={'/tube/watch/' + video.fileId}>
      <Thumb video={video} />
      <div className="tube-vtitle">{video.title}</div>
      <div className="tube-vrow">
        <Avatar name={video.channelName} logoUrl={video.channelLogoUrl} size={26} />
        <span className="name">{video.channelName}</span>
        <span title={video.publishedAt}>{timeAgo(video.publishedAt)}</span>
      </div>
    </a>
  );
}

function VideoGrid({ videos }) {
  return (
    <div className="tube-grid">
      {videos.map((video) => (
        <VideoCard key={video.fileId} video={video} />
      ))}
    </div>
  );
}

// The brand row shared by all Tube pages: red play button + "Tube", plus the actions on the right.
function TubeHeader({ actions, search, onSearch }) {
  return (
    <div className="tube-head">
      <span className="tube-brand">
        <a href="/tube" aria-label="Tube home">
          <span className="tube-play">
            <PlayIcon size={17} />
          </span>
          <span>Tube</span>
        </a>
      </span>
      {onSearch ? (
        <label className="tube-search">
          <input
            type="search"
            placeholder="Search videos"
            maxLength={100}
            autoComplete="off"
            value={search}
            onChange={(e) => onSearch(e.target.value)}
            aria-label="Search videos by title"
          />
          <span aria-hidden="true">Search</span>
        </label>
      ) : null}
      <span className="tube-actions">{actions}</span>
    </div>
  );
}

// Not a link inside a link: on cards the channel row is plain text (the card navigates).
// Dialog for creating or updating the user's own channel. Uploading the logo uses the regular
// whole-file upload endpoint, then the channel is saved with the returned file id.
function ChannelModal({ channel, onClose, onSaved }) {
  const notify = useNotify();
  const [name, setName] = useState(channel ? channel.name : '');
  const [description, setDescription] = useState(channel ? channel.description : '');
  const [logoFile, setLogoFile] = useState(null);
  const [busy, setBusy] = useState(false);
  const dialogRef = useRef(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog && typeof dialog.showModal === 'function') dialog.showModal();
    return () => {
      if (dialog && dialog.open) dialog.close();
    };
  }, []);

  async function submit(e) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      let logoFileId;
      if (logoFile) {
        const uploaded = await uploadSmallFile(logoFile);
        if (!uploaded.ok) {
          notify('error', 'The logo could not be uploaded: ' + messageOf(uploaded));
          return;
        }
        logoFileId = uploaded.body.data.file.id;
      }
      const body = { name: name.trim(), description: description.trim() };
      if (logoFileId) body.logoFileId = logoFileId;
      const result = await api('/api/tube/my-channel', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!result.ok) {
        notify('error', 'Could not save the channel: ' + messageOf(result), result.status === 401);
        return;
      }
      notify('success', 'Channel saved.');
      onSaved(result.body.data.channel);
    } finally {
      setBusy(false);
    }
  }

  return (
    <dialog ref={dialogRef} className="tube-modal" aria-labelledby="tube-channel-title" onClose={onClose}>
      <h2 id="tube-channel-title">{channel ? 'Edit channel' : 'Create your channel'}</h2>
      <form onSubmit={submit}>
        <label>
          Name
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={80} required autoFocus />
        </label>
        <label>
          Description (optional)
          <textarea value={description} onChange={(e) => setDescription(e.target.value)} maxLength={500} />
        </label>
        <label>
          Logo image (optional)
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setLogoFile(e.target.files && e.target.files[0] ? e.target.files[0] : null)}
          />
        </label>
        <p className="tube-hint">The logo is stored like any other file you upload.</p>
        <div className="row">
          <button type="button" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button type="submit" className="tube-btn primary" disabled={busy}>
            {busy ? 'Saving…' : 'Save'}
          </button>
        </div>
      </form>
    </dialog>
  );
}

function NotConfigured() {
  return (
    <main className="tube-root">
      <TubeHeader />
      <p className="error">File storage is not set up on this server yet, so Tube is unavailable.</p>
    </main>
  );
}

// The feed: every published video, newest first, with a client-side title search.
export function TubeHome({ boot }) {
  const [channel, setChannel] = useState(boot.channel || null);
  const [search, setSearch] = useState('');
  const [modal, setModal] = useState(false);
  const videos = (boot.feed && boot.feed.videos) || [];

  if (!boot.filesEnabled) return <NotConfigured />;

  const needle = search.trim().toLowerCase();
  const shown = needle
    ? videos.filter((v) => v.title.toLowerCase().includes(needle) || (v.channelName || '').toLowerCase().includes(needle))
    : videos;

  return (
    <main className="tube-root">
      <TubeHeader
        search={search}
        onSearch={setSearch}
        actions={
          channel ? (
            <>
              <a className="tube-btn" href={'/tube/channel/' + channel.username}>
                {channel.name}
              </a>
              <button type="button" className="tube-btn" onClick={() => setModal(true)}>
                Edit channel
              </button>
            </>
          ) : (
            <button type="button" className="tube-btn primary" onClick={() => setModal(true)}>
              Create channel
            </button>
          )
        }
      />
      {shown.length ? (
        <VideoGrid videos={shown} />
      ) : (
        <div className="tube-empty">
          {videos.length === 0 ? (
            <>
              <p>No videos yet.</p>
              <p className="tube-hint">
                Upload a video on Explore, then choose “Publish” on it.{' '}
                {channel ? '' : 'Create a channel first so your videos have a home.'}
              </p>
            </>
          ) : (
            'No videos match your search.'
          )}
        </div>
      )}
      {modal ? (
        <ChannelModal
          channel={channel}
          onClose={() => setModal(false)}
          onSaved={(saved) => {
            setChannel(saved);
            setModal(false);
          }}
        />
      ) : null}
    </main>
  );
}

// The watch screen: a big native player and the video's details, dark like YouTube's watch page.
export function TubeWatch({ boot }) {
  const video = boot.video;
  const channel = boot.channel;
  if (!video) {
    return (
      <main className="tube-root">
        <TubeHeader />
        <div className="tube-empty">This video is not available.</div>
      </main>
    );
  }
  return (
    <main className="tube-root tube-watch">
      <TubeHeader
        actions={
          <a className="tube-back" href="/tube">
            ← Back to feed
          </a>
        }
      />
      <span className="tube-player">
        {/* The existing per-file preview endpoint streams the bytes inline to any signed-in user
            once the video is published (the Tube access rule). */}
        <video controls autoPlay playsInline preload="auto" src={'/api/files/' + video.fileId + '/preview'}>
          Your browser cannot play this video. Download it from Explore instead.
        </video>
      </span>
      <h1>{video.title}</h1>
      <div className="tube-vrow">
        <a href={'/tube/channel/' + video.owner} aria-label={'Channel ' + video.channelName}>
          <Avatar name={video.channelName} logoUrl={video.channelLogoUrl} size={40} />
        </a>
        <a href={'/tube/channel/' + video.owner} style={{ color: '#f1f1f1', fontWeight: 600, textDecoration: 'none' }}>
          {video.channelName}
        </a>
        <span title={video.publishedAt}>{timeAgo(video.publishedAt)}</span>
        <span style={{ color: '#6b7280' }}>{fmtSize(video.size)}</span>
      </div>
      {video.description ? <p className="tube-watch-desc">{video.description}</p> : null}
    </main>
  );
}

// A public channel page: big logo, name, description, and the channel's videos.
export function TubeChannel({ boot }) {
  const channel = boot.channel;
  const videos = boot.videos || [];
  if (!channel) {
    return (
      <main className="tube-root">
        <TubeHeader />
        <div className="tube-empty">No such channel.</div>
      </main>
    );
  }
  return (
    <main className="tube-root">
      <TubeHeader
        actions={
          <a className="tube-back" href="/tube">
            ← Back to feed
          </a>
        }
      />
      <div className="tube-channel-head">
        <Avatar name={channel.name} logoUrl={channel.logoUrl} size={84} />
        <div>
          <h1>{channel.name}</h1>
          <p>{channel.description || 'No description yet.'}</p>
        </div>
      </div>
      {videos.length ? (
        <VideoGrid videos={videos} />
      ) : (
        <div className="tube-empty">This channel has not published any videos yet.</div>
      )}
    </main>
  );
}

// Picks the Tube screen for the bootstrap page name (main.jsx routes here for anything tube-*).
export default function TubePage({ boot }) {
  if (boot.page === 'tube-watch') return <TubeWatch boot={boot} />;
  if (boot.page === 'tube-channel') return <TubeChannel boot={boot} />;
  return <TubeHome boot={boot} />;
}
