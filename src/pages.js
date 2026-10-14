'use strict';

// Server-rendered HTML. Every value from a request is escaped before it is written.
// The logged-in app pages (/home, /explore) are React shells; the React bundle lives in public/assets/app.js.
const crypto = require('node:crypto');

const ERROR_TEXT = {
  INVALID_CREDENTIALS: 'Wrong username or password.',
  INVALID_USERNAME: 'Username must be 3-32 letters, digits, or underscores.',
  INVALID_PASSWORD: 'Password must be 8-256 characters.',
  USERNAME_TAKEN: 'That username is taken.',
  RATE_LIMITED: 'Too many attempts. Try again later.',
  NOT_CONFIGURED: 'Login is not configured on this server.',
  UPSTREAM_ERROR: 'The data store is unavailable. Try again shortly.',
  INTERNAL_ERROR: 'Something went wrong.',
};

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Registered on every page (best effort, catch-all errors): the service worker serves the animated
// /offline.html shell when a navigation fails, instead of a bare network error or ngrok's own page.
const SW_REGISTER_TAG = '<script src="/sw-register.js" defer></script>';

function errorText(code) {
  return ERROR_TEXT[code] || ERROR_TEXT.INTERNAL_ERROR;
}

// A size limit for hints: whole gibibytes as GB, everything smaller as MB.
function fmtLimit(bytes) {
  if (bytes >= 1024 * 1024 * 1024) {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${Number.isInteger(gb) ? gb : gb.toFixed(1)} GB`;
  }
  return `${Math.floor(bytes / (1024 * 1024))} MB`;
}

const BASE_CSS = `
      body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
      nav { display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid #d0d7de; padding-bottom: .75rem; }
      nav a { color: #0969da; }
      form.inline { display: inline; }
      label { display: block; margin: .75rem 0; }
      input { display: block; width: 100%; padding: .4rem; margin-top: .25rem; box-sizing: border-box; }
      button { padding: .5rem 1rem; cursor: pointer; }
      .error { color: #cf222e; }`;

// Dashboard styles: a wider page, a table that turns into cards on small screens, and the upload area.
const DASHBOARD_CSS = `
      [hidden] { display: none !important; }
      .badge { display: inline-block; margin-left: .4rem; padding: .05rem .45rem; border-radius: 999px; font-size: .75rem; background: #eef2f6; color: #24292f; vertical-align: middle; }
      .badge.public { background: #dafbe1; color: #116329; }
      .share-box { display: flex; flex-wrap: wrap; gap: .4rem; align-items: center; margin-top: .4rem; }
      .share-box input { flex: 1 1 16rem; min-width: 0; font-size: .85rem; }
      .actions .stack { display: flex; flex-wrap: wrap; gap: .35rem; }
      dialog.preview { width: min(960px, 96vw); height: 85vh; padding: 0; border: 1px solid #d0d7de; border-radius: 8px; }
      dialog.preview::backdrop { background: rgba(0, 0, 0, .5); }
      dialog.preview[open] { display: flex; flex-direction: column; }
      .preview-bar { display: flex; justify-content: space-between; align-items: center; gap: .5rem; padding: .5rem .75rem; border-bottom: 1px solid #d0d7de; }
      .preview-bar span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      .preview-bar .preview-bar-actions { display: flex; gap: .4rem; flex: none; overflow: visible; }
      .preview-bar .preview-bar-actions .button, .preview-bar .preview-bar-actions button { font-size: .85rem; padding: .3rem .6rem; }
      .preview-body { flex: 1; min-height: 0; overflow: auto; display: flex; align-items: center; justify-content: center; background: #f6f8fa; }
      .preview-media { max-width: 100%; max-height: 100%; display: block; margin: 0 auto; }
      .preview-audio { width: 100%; padding: 2rem; }
      .preview-audio audio { width: 100%; }
      .preview-text { white-space: pre-wrap; word-break: break-word; padding: 1rem; margin: 0; width: 100%; box-sizing: border-box; font-size: .85rem; }
      .preview-inner-frame { flex: 1; width: 100%; border: 0; background: #f6f8fa; }
      #preview-frame { flex: 1; width: 100%; border: 0; background: #f6f8fa; }
      .share-preview { width: 100%; height: 60vh; border: 1px solid #d0d7de; border-radius: 8px; background: #f6f8fa; }
      body.wide { max-width: 64rem; }
      .profile { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; align-items: flex-end; }
      .profile h1 { margin: .5rem 0 0; font-size: 1.6rem; }
      .quota { margin: 0; min-width: 14rem; font-size: .9rem; color: #57606a; }
      h2 { font-size: 1.15rem; margin: 1.5rem 0 .5rem; }
      .drop { border: 2px dashed #8c959f; border-radius: 8px; padding: 1.25rem; text-align: center; background: #f6f8fa; }
      .drop.over { border-color: #0969da; background: #ddf4ff; }
      .drop p { margin: .25rem 0; }
      .hint { color: #57606a; font-size: .85rem; }
      button.danger { color: #cf222e; }
      button.linklike { background: none; border: 0; color: #0969da; padding: 0; text-decoration: underline; }
      .button { display: inline-block; padding: .4rem .8rem; border: 1px solid #d0d7de; border-radius: 6px; color: #0969da; text-decoration: none; background: #fff; }
      .toolbar { display: flex; flex-wrap: wrap; gap: 1rem; align-items: flex-end; }
      .toolbar label { margin: .5rem 0; flex: 1 1 14rem; }
      .toolbar input, .toolbar select { display: block; width: 100%; padding: .4rem; margin-top: .25rem; box-sizing: border-box; }
      table.files { width: 100%; border-collapse: collapse; margin-top: .5rem; }
      table.files th, table.files td { text-align: left; padding: .5rem; border-bottom: 1px solid #d0d7de; vertical-align: middle; }
      table.files td.actions { white-space: nowrap; }
      .badge { display: inline-block; margin-left: .5rem; padding: 0 .4rem; border-radius: 999px; background: #fff8c5; font-size: .8rem; }
      .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); }
      .notices { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; max-width: min(24rem, calc(100vw - 2rem)); z-index: 10; pointer-events: none; }
      .notices > * { pointer-events: auto; }
      .notice { padding: .6rem .8rem; border-radius: 6px; background: #fff; border: 1px solid #d0d7de; box-shadow: 0 2px 8px rgba(31,35,40,.15); display: flex; justify-content: space-between; gap: .75rem; }
      .notice.success { border-color: #1a7f37; }
      .notice.error { border-color: #cf222e; color: #82071e; }
      .queue { list-style: none; padding: 0; margin: .75rem 0 0; }
      .queue-item { display: grid; grid-template-columns: minmax(6rem, 2fr) minmax(5rem, 3fr) auto; gap: .5rem; align-items: center; padding: .35rem 0; }
      .queue-item progress { width: 100%; }
      .queue-item.done { color: #1a7f37; }
      .queue-state.error { color: #cf222e; }
      .queue-size { color: #57606a; font-weight: normal; }
      .queue-actions button { margin-left: .4rem; }
      .url-form { margin-top: .9rem; }
      .url-form label { display: block; font-weight: 600; margin-bottom: .25rem; }
      .url-row { display: flex; flex-wrap: wrap; gap: .4rem; }
      .url-row input { flex: 1 1 16rem; min-width: 0; padding: .35rem .5rem; border: 1px solid #d0d7de; border-radius: 6px; font: inherit; }
      @media (max-width: 640px) {
        table.files thead { display: none; }
        table.files, table.files tbody, table.files tr, table.files td { display: block; width: 100%; box-sizing: border-box; }
        table.files tr { border: 1px solid #d0d7de; border-radius: 8px; margin: .6rem 0; padding: .25rem .5rem; }
        table.files td { display: flex; justify-content: space-between; gap: .75rem; border: 0; padding: .35rem 0; word-break: break-word; }
        table.files td::before { content: attr(data-label); color: #57606a; flex: 0 0 5.5rem; }
        table.files td.actions { justify-content: flex-start; }
        table.files td.actions::before { content: none; }
        .queue-item { grid-template-columns: 1fr; }
      }`;

// Inline SVG icons (feather-style, 24x24, stroke = currentColor). Used by the app top menu and the welcome page.
const svg = (paths, size = 18) => `<svg width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICON = {
  box: svg('<path d="M12 2 3 7v10l9 5 9-5V7l-9-5z"/><path d="M3 7l9 5 9-5"/><path d="M12 12v10"/>', 20),
  home: svg('<path d="M3 10.5 12 3l9 7.5"/><path d="M5 9.5V21h14V9.5"/><path d="M10 21v-6h4v6"/>'),
  compass: svg('<circle cx="12" cy="12" r="9"/><path d="m15.5 8.5-2 5-5 2 2-5 5-2z"/>'),
  logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><path d="m16 17 5-5-5-5"/><path d="M21 12H9"/>'),
  user: svg('<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 3.6-6 8-6s8 2 8 6"/>', 15),
  upload: svg('<path d="M12 16V4"/><path d="m6 10 6-6 6 6"/><path d="M4 20h16"/>'),
  folder: svg('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>'),
  link: svg('<path d="M10 14a5 5 0 0 0 7.1 0l2.4-2.4a5 5 0 0 0-7.1-7.1L11 5.9"/><path d="M14 10a5 5 0 0 0-7.1 0l-2.4 2.4a5 5 0 0 0 7.1 7.1L13 18"/>'),
  eye: svg('<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7z"/><circle cx="12" cy="12" r="3"/>'),
  shield: svg('<path d="M12 2 4 5v6c0 5 3.4 8.6 8 11 4.6-2.4 8-6 8-11V5l-8-3z"/>'),
  zap: svg('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>'),
  layers: svg('<path d="m12 2 9 5-9 5-9-5 9-5z"/><path d="m3 12 9 5 9-5"/><path d="m3 17 9 5 9-5"/>'),
  check: svg('<path d="m4 12 5 5 11-11"/>', 15),
  spark: svg('<path d="M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8L12 3z"/>', 15),
  // Radio waves: the Pips Tunnel nav glyph (a beacon between the two arcs).
  tunnel: svg('<path d="M4.9 19.1a10 10 0 0 1 0-14.2"/><path d="M8.5 15.5a5 5 0 0 1 0-7"/><path d="M19.1 4.9a10 10 0 0 1 0 14.2"/><path d="M15.5 8.5a5 5 0 0 1 0 7"/><circle cx="12" cy="12" r="1"/>'),
};

// Top menu styles for logged-in pages (Home, Explore) and any layout with a user.
const APP_NAV_CSS = `
      nav.top { flex-wrap: wrap; gap: .6rem; }
      .brand { display: inline-flex; align-items: center; gap: .45rem; font-weight: 700; color: #1f2328; text-decoration: none; }
      .brand svg { color: #0969da; }
      .nav-links { display: flex; gap: .25rem; }
      .nav-link { display: inline-flex; align-items: center; gap: .35rem; padding: .35rem .7rem; border-radius: 8px; color: #57606a; text-decoration: none; }
      .nav-link:hover { background: #f6f8fa; color: #1f2328; }
      .nav-link.active { background: #ddf4ff; color: #0969da; font-weight: 600; }
      .nav-right { margin-left: auto; display: flex; align-items: center; gap: .5rem; }
      .user-chip { display: inline-flex; align-items: center; gap: .35rem; padding: .25rem .65rem; border: 1px solid #d0d7de; border-radius: 999px; font-size: .85rem; color: #57606a; max-width: 14rem; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      button.nav-logout { display: inline-flex; align-items: center; gap: .35rem; background: #fff; border: 1px solid #d0d7de; border-radius: 8px; padding: .35rem .7rem; color: #1f2328; }
      button.nav-logout:hover { border-color: #cf222e; color: #cf222e; }
      .stat-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(10rem, 1fr)); gap: .75rem; margin: 1rem 0; }
      .stat-card { border: 1px solid #d0d7de; border-radius: 10px; padding: .9rem 1rem; background: #fff; }
      .stat-card .num { font-size: 1.5rem; font-weight: 700; }
      .stat-card .lbl { color: #57606a; font-size: .85rem; }
      .quick-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr)); gap: .75rem; margin: 1rem 0; }
      .quick-card { display: flex; gap: .75rem; align-items: flex-start; border: 1px solid #d0d7de; border-radius: 10px; padding: 1rem; text-decoration: none; color: inherit; background: #fff; transition: transform .12s ease, box-shadow .12s ease; }
      .quick-card:hover { transform: translateY(-2px); box-shadow: 0 4px 14px rgba(31,35,40,.12); }
      .quick-card svg { color: #0969da; flex: none; margin-top: .15rem; }
      .quick-card h3 { margin: 0 0 .25rem; font-size: 1rem; }
      .quick-card p { margin: 0; color: #57606a; font-size: .85rem; }
      ul.facts { padding-left: 1.2rem; color: #57606a; }
      ul.facts li { margin: .3rem 0; }
      /* Tunnel link on the React app-shell pages (/home, /explore, tube, chat):
         the bundle owns #root, so this floats outside it, out of the chat
         notices' corner. Server-rendered, no bundle change. */
      .shell-tunnel-link { position: fixed; left: 1rem; bottom: 1rem; z-index: 40; display: inline-flex; align-items: center; gap: .35rem; padding: .45rem .85rem; border-radius: 999px; background: #fff; border: 1px solid #d0d7de; color: #0969da; font-weight: 600; font-size: .9rem; text-decoration: none; box-shadow: 0 2px 8px rgba(31,35,40,.12); }
      .shell-tunnel-link:hover { border-color: #0969da; background: #f6f8fa; }
      .shell-tunnel-link svg { color: #0969da; flex: none; }`;

// Dark, YouTube-like styling for the Tube pages (feed, watch screen, channel). The React components
// use these classes plus small inline styles. Plain CSS only, so the app-shell CSP still holds.
const TUBE_CSS = `
      .tube-root { color: #f1f1f1; }
      .tube-head { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; justify-content: space-between; margin: 0 0 1.3rem; }
      .tube-brand { display: inline-flex; align-items: center; gap: .55rem; font-size: 1.4rem; font-weight: 700; letter-spacing: -.02em; color: #fff; }
      .tube-brand a { color: inherit; text-decoration: none; display: inline-flex; align-items: center; gap: .55rem; }
      .tube-play { display: inline-flex; align-items: center; justify-content: center; width: 38px; height: 27px; border-radius: 8px; background: #ff0033; color: #fff; flex: none; }
      .tube-actions { display: flex; gap: .6rem; align-items: center; flex-wrap: wrap; }
      .tube-btn { display: inline-flex; align-items: center; gap: .45rem; padding: .5rem 1rem; border-radius: 999px; border: 1px solid #3f4450; background: #222331; color: #f1f1f1; font-size: .9rem; font-weight: 600; cursor: pointer; text-decoration: none; }
      .tube-btn:hover { background: #2c2d40; }
      .tube-btn.primary { background: #ff0033; border-color: #ff0033; color: #fff; }
      .tube-btn.primary:hover { background: #e00030; }
      .tube-search { flex: 1 1 220px; max-width: 24rem; display: flex; }
      .tube-search input { flex: 1; min-width: 0; background: #121418; border: 1px solid #30343d; border-right: 0; color: #f1f1f1; border-radius: 999px 0 0 999px; padding: .5rem 1rem; outline: none; font-size: .92rem; }
      .tube-search input:focus { border-color: #4a4f5c; }
      .tube-search span { display: inline-flex; align-items: center; padding: 0 .9rem; background: #1d1f27; border: 1px solid #30343d; border-left: 0; border-radius: 0 999px 999px 0; color: #8a919e; }
      .tube-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(260px, 1fr)); gap: 1.6rem 1rem; }
      .tube-card { display: block; color: inherit; text-decoration: none; border-radius: 12px; min-width: 0; }
      .tube-thumb { position: relative; aspect-ratio: 16 / 9; border-radius: 12px; overflow: hidden; background: radial-gradient(120% 120% at 20% 0%, #26304d 0%, #12141c 55%, #221530 100%); display: flex; align-items: center; justify-content: center; color: #566070; }
      .tube-thumb img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: block; }
      .tube-thumb .tube-play { opacity: .92; }
      .tube-vtitle { margin: .65rem 0 .25rem; font-size: .98rem; font-weight: 600; line-height: 1.35; color: #f1f1f1; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
      .tube-vrow { display: flex; align-items: center; gap: .55rem; color: #aaa; font-size: .85rem; min-width: 0; }
      .tube-avatar { width: 28px; height: 28px; border-radius: 50%; background: linear-gradient(135deg, #333a4d, #20242f); color: #d7dde6; display: inline-flex; align-items: center; justify-content: center; font-size: .8rem; font-weight: 700; overflow: hidden; flex: none; text-decoration: none; }
      .tube-avatar img { width: 100%; height: 100%; object-fit: cover; display: block; }
      .tube-vrow .name { color: #d7dde6; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .tube-empty { color: #8a919e; background: #16181f; border: 1px solid #262a33; border-radius: 12px; padding: 2.2rem 1.4rem; text-align: center; }
      .tube-watch { max-width: 60rem; margin: 0 auto; }
      .tube-player { width: 100%; aspect-ratio: 16 / 9; background: #000; border-radius: 14px; overflow: hidden; display: block; }
      .tube-player video { width: 100%; height: 100%; display: block; background: #000; }
      .tube-watch h1 { color: #f1f1f1; font-size: 1.25rem; line-height: 1.4; margin: .9rem 0 .4rem; }
      .tube-watch-desc { color: #c9cdd4; background: #16181f; border: 1px solid #262a33; border-radius: 12px; padding: .9rem 1rem; margin: .8rem 0 0; white-space: pre-wrap; overflow-wrap: anywhere; font-size: .93rem; }
      .tube-back { color: #9aa3b2; font-size: .9rem; text-decoration: none; display: inline-flex; align-items: center; gap: .4rem; }
      .tube-back:hover { color: #f1f1f1; }
      .tube-channel-head { display: flex; gap: 1.1rem; align-items: center; margin: 0 0 1.6rem; }
      .tube-channel-head .tube-avatar { width: 84px; height: 84px; font-size: 2rem; }
      .tube-channel-head h1 { color: #fff; font-size: 1.5rem; margin: 0 0 .25rem; }
      .tube-channel-head p { color: #9aa3b2; margin: 0; max-width: 44rem; white-space: pre-wrap; overflow-wrap: anywhere; }
      .tube-modal { border: 1px solid #2c313c; border-radius: 14px; background: #171921; color: #f1f1f1; padding: 0; max-width: 26rem; width: calc(100% - 2rem); }
      .tube-modal::backdrop { background: rgba(0,0,0,.65); }
      .tube-modal h2 { font-size: 1.1rem; margin: 0; padding: 1rem 1.2rem .4rem; color: #fff; }
      .tube-modal form { display: grid; gap: .7rem; padding: .6rem 1.2rem 1.2rem; }
      .tube-modal label { display: grid; gap: .3rem; font-size: .85rem; color: #aab1bd; }
      .tube-modal input, .tube-modal textarea, .tube-modal select { background: #101219; border: 1px solid #2f343f; border-radius: 8px; color: #f1f1f1; padding: .5rem .7rem; font: inherit; }
      .tube-modal textarea { min-height: 4.5rem; resize: vertical; }
      .tube-modal .row { display: flex; gap: .6rem; justify-content: flex-end; align-items: center; }
      .tube-hint { color: #8a919e; font-size: .8rem; margin: 0; }
      @media (max-width: 640px) { .tube-channel-head { flex-direction: column; align-items: flex-start; } }`;

// Welcome page (standalone, full-bleed): animated gradient, a CSS 3D cube, floating chips, and an info grid.
const WELCOME_CSS = `
      * { box-sizing: border-box; }
      body.welcome { margin: 0; font-family: system-ui, sans-serif; color: #e6edf3; background: #0b1020; overflow-x: hidden; }
      a { color: #7ee2ff; }
      .glow { position: fixed; border-radius: 50%; filter: blur(90px); opacity: .55; z-index: 0; animation: drift 14s ease-in-out infinite alternate; }
      .g1 { width: 34rem; height: 34rem; left: -10rem; top: -12rem; background: radial-gradient(circle, #4f46e5, transparent 65%); }
      .g2 { width: 30rem; height: 30rem; right: -8rem; bottom: -10rem; background: radial-gradient(circle, #0891b2, transparent 65%); animation-delay: -7s; }
      @keyframes drift { from { transform: translate3d(0, 0, 0) scale(1); } to { transform: translate3d(3rem, 2rem, 0) scale(1.12); } }
      header.wtop, main, footer.wfoot { position: relative; z-index: 1; }
      header.wtop { display: flex; align-items: center; justify-content: space-between; gap: 1rem; padding: 1rem 1.4rem; }
      .brand { display: inline-flex; align-items: center; gap: .5rem; font-weight: 700; font-size: 1.05rem; color: #f0f6fc; text-decoration: none; }
      .brand svg { color: #7ee2ff; }
      .wauth { display: flex; align-items: center; gap: 1rem; }
      .wauth a:not(.btn) { color: #c9d1d9; text-decoration: none; }
      .wauth a:not(.btn):hover { color: #fff; }
      main { max-width: 72rem; margin: 0 auto; padding: 2.5rem 1.4rem 3rem; }
      .hero { display: grid; grid-template-columns: minmax(0, 1.15fr) minmax(0, .85fr); gap: 2rem; align-items: center; }
      @media (max-width: 820px) { .hero { grid-template-columns: 1fr; } .scene { min-height: 260px; } }
      .pill { display: inline-flex; align-items: center; gap: .4rem; padding: .3rem .8rem; border-radius: 999px; border: 1px solid rgba(126,226,255,.4); background: rgba(126,226,255,.08); color: #7ee2ff; font-size: .85rem; }
      h1 { font-size: clamp(1.9rem, 4.5vw, 3rem); line-height: 1.15; margin: .9rem 0 .8rem; letter-spacing: -.02em; background: linear-gradient(120deg, #f0f6fc, #9ecbff 55%, #7ee2ff); -webkit-background-clip: text; background-clip: text; color: transparent; }
      .hero-copy > p { color: #9aa7b5; font-size: 1.05rem; line-height: 1.6; margin: 0 0 1.4rem; max-width: 34rem; }
      .cta-row { display: flex; flex-wrap: wrap; gap: .8rem; align-items: center; }
      .btn { display: inline-flex; align-items: center; gap: .5rem; padding: .7rem 1.4rem; border-radius: 10px; text-decoration: none; font-weight: 600; transition: transform .12s ease, box-shadow .12s ease, background .12s ease; }
      .btn.primary { color: #08111f; background: linear-gradient(120deg, #67e8f9, #818cf8); box-shadow: 0 6px 24px rgba(99,102,241,.4); }
      .btn.primary:hover { transform: translateY(-2px); box-shadow: 0 10px 30px rgba(99,102,241,.55); }
      .btn.ghost { color: #e6edf3; border: 1px solid rgba(230,237,243,.3); }
      .btn.ghost:hover { background: rgba(255,255,255,.08); }
      .btn.small { padding: .4rem .9rem; font-size: .9rem; }
      ul.ticks { list-style: none; display: flex; flex-wrap: wrap; gap: 1.1rem; padding: 0; margin: 1.3rem 0 0; color: #9aa7b5; font-size: .9rem; }
      ul.ticks li { display: inline-flex; align-items: center; gap: .35rem; }
      ul.ticks svg { color: #34d399; }
      .scene { position: relative; min-height: 340px; display: flex; align-items: center; justify-content: center; perspective: 900px; }
      .cube { width: 140px; height: 140px; position: relative; transform-style: preserve-3d; animation: spin 16s linear infinite; }
      .face { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; color: #bfeaff; background: linear-gradient(135deg, rgba(99,102,241,.4), rgba(34,211,238,.16)); border: 1px solid rgba(190,227,255,.35); border-radius: 14px; box-shadow: inset 0 0 34px rgba(99,102,241,.35); }
      .f1 { transform: translateZ(70px); } .f2 { transform: rotateY(180deg) translateZ(70px); }
      .f3 { transform: rotateY(90deg) translateZ(70px); } .f4 { transform: rotateY(-90deg) translateZ(70px); }
      .f5 { transform: rotateX(90deg) translateZ(70px); } .f6 { transform: rotateX(-90deg) translateZ(70px); }
      @keyframes spin { from { transform: rotateX(-18deg) rotateY(0deg); } to { transform: rotateX(-18deg) rotateY(360deg); } }
      .chip { position: absolute; display: inline-flex; align-items: center; gap: .5rem; padding: .55rem .85rem; border-radius: 12px; background: rgba(255,255,255,.08); border: 1px solid rgba(255,255,255,.22); backdrop-filter: blur(6px); font-size: .85rem; animation: float 6s ease-in-out infinite; }
      .chip svg { color: #7ee2ff; }
      .c1 { top: 10%; left: 6%; } .c2 { bottom: 14%; right: 4%; animation-delay: 1.6s; } .c3 { top: 56%; left: 0; animation-delay: 3.2s; }
      @keyframes float { 0%, 100% { transform: translateY(0); } 50% { transform: translateY(-10px); } }
      .more { margin-top: 4rem; }
      .more h2 { font-size: 1.7rem; margin: 0 0 .3rem; }
      .more .sub { color: #9aa7b5; margin: 0 0 1.4rem; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); gap: 1rem; }
      .card { background: rgba(255,255,255,.05); border: 1px solid rgba(255,255,255,.13); border-radius: 14px; padding: 1.15rem; transition: transform .15s ease, background .15s ease; }
      .card:hover { transform: perspective(600px) rotateX(4deg) rotateY(-4deg) translateY(-2px); background: rgba(255,255,255,.09); }
      .card svg { color: #7ee2ff; }
      .card h3 { margin: .6rem 0 .35rem; font-size: 1.02rem; }
      .card p { margin: 0; color: #9aa7b5; font-size: .9rem; line-height: 1.55; }
      footer.wfoot { display: flex; flex-wrap: wrap; gap: 1rem; justify-content: space-between; max-width: 72rem; margin: 0 auto; padding: 1.2rem 1.4rem 2rem; color: #77808c; font-size: .85rem; border-top: 1px solid rgba(255,255,255,.1); }
      footer.wfoot a { color: #9aa7b5; }
      @media (prefers-reduced-motion: reduce) { .glow, .cube, .chip { animation: none; } .btn, .card { transition: none; } }`;

function layout(title, body, user, { wide = false, extraCss = '', active = '' } = {}) {
  const navLink = (href, key, icon, label) =>
    `<a class="nav-link${active === key ? ' active' : ''}" href="${href}">${icon}<span>${label}</span></a>`;
  const nav = user
    ? `<a class="brand" href="/home">${ICON.box}<span>File Vault</span></a>
       <div class="nav-links">${navLink('/home', 'home', ICON.home, 'Home')}${navLink('/explore', 'explore', ICON.compass, 'Explore')}${navLink('/tunnel', 'tunnel', ICON.tunnel, 'Tunnel')}</div>
       <div class="nav-right">
         <span class="user-chip" title="Signed in">${ICON.user}<span>${escapeHtml(user.username)}</span></span>
         <form method="post" action="/logout" class="inline"><button type="submit" class="nav-logout">${ICON.logout}<span>Log out</span></button></form>
       </div>`
    : `<a class="brand" href="/">${ICON.box}<span>File Vault</span></a>
       <div class="nav-links"></div>
       <div class="nav-right"><a href="/login">Log in</a> <a href="/signup">Sign up</a></div>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>${BASE_CSS}${APP_NAV_CSS}${extraCss}
    </style>
    ${SW_REGISTER_TAG}
  </head>
  <body${wide ? ' class="wide"' : ''}>
    <nav class="top">${nav}</nav>
    ${body}
  </body>
</html>
`;
}

// Public welcome page. Pure CSS 3D: a spinning cube, floating glass chips, an animated gradient, and a
// "More info" feature grid. Logged-in visitors never see this page - the server redirects them to /home.
function welcomePage() {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>File Vault - file storage on GitHub</title>
    <style>${WELCOME_CSS}
    </style>
    ${SW_REGISTER_TAG}
  </head>
  <body class="welcome">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <header class="wtop">
      <a class="brand" href="/">${ICON.box}<span>File Vault</span></a>
      <nav class="wauth">
        <a href="/login">Log in</a>
        <a class="btn small primary" href="/signup">Get started</a>
      </nav>
    </header>
    <main>
      <section class="hero">
        <div class="hero-copy">
          <span class="pill">${ICON.spark} Free &middot; Private &middot; Yours</span>
          <h1>Store files in your own GitHub repositories</h1>
          <p>Create an account, upload any kind of file up to 2&nbsp;GB, preview it right in the browser or in a new tab, and share it with one link. The server keeps no copies - your bytes live as release assets in a private GitHub repository only you can read.</p>
          <div class="cta-row">
            <a class="btn primary" href="/signup">${ICON.zap} Get started</a>
            <a class="btn ghost" href="/login">Log in</a>
          </div>
          <ul class="ticks">
            <li>${ICON.check} No install</li>
            <li>${ICON.check} Any file type</li>
            <li>${ICON.check} Works on mobile</li>
          </ul>
        </div>
        <div class="scene" aria-hidden="true">
          <div class="cube">
            <div class="face f1">${ICON.box}</div>
            <div class="face f2">${ICON.folder}</div>
            <div class="face f3">${ICON.eye}</div>
            <div class="face f4">${ICON.link}</div>
            <div class="face f5">${ICON.upload}</div>
            <div class="face f6">${ICON.shield}</div>
          </div>
          <div class="chip c1">${ICON.folder}<span>Any file type</span></div>
          <div class="chip c2">${ICON.link}<span>Share links</span></div>
          <div class="chip c3">${ICON.eye}<span>Live previews</span></div>
        </div>
      </section>

      <section class="more" id="more-info">
        <h2>More info</h2>
        <p class="sub">Everything you get with a free account.</p>
        <div class="grid">
          <article class="card">${ICON.shield}<h3>Secure accounts</h3><p>Passwords are stored only as scrypt hashes, sessions are signed cookies, and every form is checked against cross-site posts.</p></article>
          <article class="card">${ICON.folder}<h3>Any file, up to 2 GB</h3><p>Documents, video, audio, archives - file types are verified by their content signature, not just by the file name.</p></article>
          <article class="card">${ICON.eye}<h3>Instant previews</h3><p>Images, PDF, text, video, and audio open in a sandboxed viewer or a new browser tab. Unknown or active types download safely instead.</p></article>
          <article class="card">${ICON.link}<h3>Share links</h3><p>Publish a file with one link and turn it off whenever you want. Re-enabling makes a fresh link, so old ones stop working.</p></article>
          <article class="card">${ICON.upload}<h3>Upload links</h3><p>Let someone without an account send you a file through a revocable link with its own file and size limits.</p></article>
          <article class="card">${ICON.layers}<h3>Resume big uploads</h3><p>Large files are sent in verified pieces, so a dropped connection never restarts from zero. You can also import straight from any http, https, or data: link.</p></article>
        </div>
      </section>
    </main>
    <footer class="wfoot">
      <span><a href="/api/health">Service status</a></span>
      <span>Your data stays in your GitHub repositories - the server keeps nothing.</span>
    </footer>
  </body>
</html>
`;
}

// Model chat: dark, focused conversation screen. Shares the Tube palette so the two
// "immersive" screens feel like siblings; the accent is a calm blue, not Tube red.
const CHAT_CSS = `
      .chat-root { max-width: 54rem; margin: 0 auto; color: #f1f1f1; display: flex; flex-direction: column; gap: 1rem; min-height: 60vh; }
      .chat-status { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; background: #16181f; border: 1px solid #262a33; border-radius: 12px; padding: .7rem 1rem; font-size: .88rem; color: #b9c2cf; }
      .chat-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; background: #566070; }
      .chat-dot.ready { background: #2ecc71; box-shadow: 0 0 8px rgba(46, 204, 113, .55); }
      .chat-dot.loading { background: #f1c40f; animation: chat-pulse 1.2s ease-in-out infinite; }
      .chat-dot.error { background: #ff0033; }
      @keyframes chat-pulse { 0%, 100% { opacity: .35; } 50% { opacity: 1; } }
      @media (prefers-reduced-motion: reduce) { .chat-dot.loading { animation: none; } }
      .chat-model { color: #8a919e; font-size: .82rem; }
      .chat-log { display: flex; flex-direction: column; gap: .9rem; padding: .4rem 0 1rem; }
      .chat-msg { max-width: 88%; border-radius: 14px; padding: .7rem 1rem; line-height: 1.55; font-size: .95rem; white-space: pre-wrap; overflow-wrap: anywhere; }
      .chat-msg.user { align-self: flex-end; background: #2b3a5e; border: 1px solid #34466e; color: #eef2fb; border-bottom-right-radius: 4px; }
      .chat-msg.assistant { align-self: flex-start; background: #16181f; border: 1px solid #262a33; color: #e8ebf0; border-bottom-left-radius: 4px; }
      .chat-msg.assistant.pending { color: #aeb6c2; }
      .chat-msg .chat-reason { margin: 0 0 .6rem; }
      .chat-msg .chat-reason summary { cursor: pointer; color: #8a919e; font-size: .8rem; user-select: none; }
      .chat-msg .chat-reason p { margin: .5rem 0 0; color: #9aa3af; font-size: .85rem; border-left: 2px solid #2c313d; padding-left: .7rem; white-space: pre-wrap; }
      .chat-msg .chat-meta { margin-top: .55rem; font-size: .75rem; color: #6d7683; }
      .chat-cursor { display: inline-block; width: 8px; height: 1em; vertical-align: text-bottom; background: #4f8cff; animation: chat-pulse 1s ease-in-out infinite; }
      @media (prefers-reduced-motion: reduce) { .chat-cursor { animation: none; } }
      .chat-empty { color: #8a919e; background: #16181f; border: 1px solid #262a33; border-radius: 12px; padding: 2.2rem 1.4rem; text-align: center; }
      .chat-composer { display: flex; gap: .6rem; align-items: flex-end; background: #121418; border: 1px solid #30343d; border-radius: 14px; padding: .6rem; }
      .chat-composer textarea { flex: 1; min-height: 2.8rem; max-height: 10rem; resize: vertical; background: transparent; border: 0; outline: none; color: #f1f1f1; font: inherit; font-size: .95rem; padding: .45rem .5rem; }
      .chat-composer textarea::placeholder { color: #566070; }
      .chat-send { display: inline-flex; align-items: center; gap: .45rem; padding: .55rem 1.1rem; border-radius: 10px; border: 1px solid #4f8cff; background: #4f8cff; color: #fff; font-weight: 700; font-size: .9rem; cursor: pointer; flex: none; }
      .chat-send:hover { background: #3f7bef; }
      .chat-send:disabled { opacity: .45; cursor: not-allowed; }
      .chat-cancel { display: inline-flex; align-items: center; gap: .4rem; padding: .5rem 1rem; border-radius: 10px; border: 1px solid #3f4450; background: #222331; color: #f1f1f1; font-size: .88rem; font-weight: 600; cursor: pointer; flex: none; }
      .chat-cancel:hover { background: #2c2d40; }
      .chat-note { font-size: .8rem; color: #6d7683; padding: 0 .3rem; }
      .chat-modelbar { display: flex; flex-wrap: wrap; gap: .6rem; align-items: center; padding: 0 .3rem; }
      .chat-model-label { font-size: .8rem; font-weight: 700; color: #8a919e; text-transform: uppercase; letter-spacing: .04em; }
      .chat-select { flex: 1; min-width: 0; max-width: 30rem; background: #121418; border: 1px solid #30343d; color: #f1f1f1; border-radius: 10px; padding: .5rem .6rem; font: inherit; font-size: .86rem; cursor: pointer; }
      .chat-select:hover:not(:disabled) { border-color: #4f8cff; }
      .chat-select:disabled { opacity: .5; cursor: not-allowed; }
      .chat-switch-hint { font-size: .78rem; color: #f1c40f; }
      .chat-error { background: #2a1418; border: 1px solid #57242c; color: #f3b6bd; border-radius: 10px; padding: .6rem .9rem; font-size: .86rem; white-space: pre-wrap; }
      .chat-footer { color: #566070; font-size: .78rem; padding: 0 .3rem; }
`;

// The logged-in app pages are rendered by the React bundle at /assets/app.js. The server sends a small
// shell: styles, an empty mount point, and a JSON bootstrap block with the page data. The JSON block is
// not a script, so the shell can ship a strict CSP (script-src 'self' comes from the server header).
function appShell({ title, bootstrap, fallbackHtml = '', extraCss = '' }) {
  const json = JSON.stringify(bootstrap).replace(/</g, '\\u003c');
  const noscript = '<noscript><p class="hint">This app needs JavaScript.</p></noscript>';
  // Every shell page is behind login and its bootstrap carries the user, so the
  // floating Tunnel link renders only for signed-in visitors. (Anon visitors
  // never reach these pages; /tunnel itself would redirect them to /login.)
  const tunnelLink = bootstrap && bootstrap.user
    ? `<a class="shell-tunnel-link" href="/tunnel">${ICON.tunnel}<span>Tunnel</span></a>\n    `
    : '';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>${BASE_CSS}${APP_NAV_CSS}${DASHBOARD_CSS}${extraCss}
    </style>
    ${SW_REGISTER_TAG}
  </head>
  <body class="wide">
    ${tunnelLink}<div id="root">${fallbackHtml}${noscript}</div>
    <script type="application/json" id="app-bootstrap">${json}</script>
    <script src="/assets/app.js" defer></script>
  </body>
</html>
`;
}

const STORAGE_NOTICE = '<p class="error">File storage is not set up on this server yet. Login works; uploads are unavailable.</p>';

// The app home page: React renders the greeting, live stats, quick actions, and facts. The file list
// lives on /explore, never here. filesEnabled is false when the storage settings are missing.
function appHomePage(user, { filesEnabled = false, maxBytes = 0 } = {}) {
  return appShell({
    title: 'Home',
    bootstrap: { page: 'home', user: { username: user.username }, filesEnabled, maxBytes },
    fallbackHtml: filesEnabled ? '' : STORAGE_NOTICE,
  });
}

function authForm({ mode, error }) {
  const isSignup = mode === 'signup';
  const message = error ? `<p class="error" role="alert">${escapeHtml(errorText(error))}</p>` : '';
  return layout(
    isSignup ? 'Sign up' : 'Log in',
    `<h1>${isSignup ? 'Sign up' : 'Log in'}</h1>
     ${message}
     <form method="post" action="/${mode}">
       <label>Username
         <input name="username" autocomplete="username" required minlength="3" maxlength="32" pattern="[A-Za-z0-9_]+">
       </label>
       <label>Password
         <input type="password" name="password" autocomplete="${isSignup ? 'new-password' : 'current-password'}" required minlength="8" maxlength="256">
       </label>
       <button type="submit">${isSignup ? 'Create account' : 'Log in'}</button>
     </form>
     <p>${isSignup ? 'Already have an account? <a href="/login">Log in</a>' : 'No account? <a href="/signup">Sign up</a>'}</p>`,
    null,
  );
}

// The explorer: uploads, the file list, and upload links, all rendered by the React bundle.
// filesEnabled is false when the storage settings are missing: the page then says so.
function explorePage(user, { filesEnabled = false, maxBytes = 0, linkMaxFiles = 0, linkMaxBytes = 0 } = {}) {
  return appShell({
    title: 'Explore files',
    bootstrap: {
      page: 'explore',
      user: { username: user.username },
      filesEnabled,
      maxBytes,
      linkMaxFiles,
      linkMaxBytes,
    },
    fallbackHtml: filesEnabled ? '' : STORAGE_NOTICE,
  });
}

// The Tube pages: a dark, YouTube-like feed, watch screen, and channel page, all rendered by the
// React bundle. The bootstrap block carries the feed/video/channel data; TUBE_CSS sets the look.
// Every viewer is signed in - the routes redirect to /login first.
function tubeFeedPage(boot) {
  return appShell({ title: 'Tube', bootstrap: boot, extraCss: TUBE_CSS });
}

// The model chat page: a dark, focused conversation screen rendered by the
// React bundle. The bootstrap block carries the runtime status; CHAT_CSS sets
// the look. Behind login like every other app page.
function chatPage(boot) {
  return appShell({ title: 'Model chat', bootstrap: boot, extraCss: CHAT_CSS });
}

function tubeWatchPage(boot) {
  return appShell({ title: `${boot.video.title} - Tube`, bootstrap: boot, extraCss: TUBE_CSS });
}

function tubeChannelPage(boot) {
  return appShell({ title: `${boot.channel.name} - Tube`, bootstrap: boot, extraCss: TUBE_CSS });
}

// Public page for an upload link. A plain multipart form: no script, no cookie. The hidden uploadId is a fresh
// UUID per page load, so a repeated submit of this page is stored once.
function uploadPage({ label, token, maxBytes }) {
  const t = escapeHtml(token);
  const mb = escapeHtml(fmtLimit(maxBytes));
  return layout(
    'Upload a file',
    `<h1>Upload a file</h1>
     ${label ? `<p>Upload link: <strong>${escapeHtml(label)}</strong></p>` : ''}
     <p>Choose one file to send. Any file type is accepted, up to ${mb}. You do not need an account.</p>
     <form method="post" enctype="multipart/form-data" action="/u/${t}/upload">
       <label>File <input type="file" name="file" required></label>
       <input type="hidden" name="uploadId" value="${escapeHtml(crypto.randomUUID())}">
       <button type="submit">Upload</button>
     </form>`,
    null,
  );
}

function uploadDonePage({ name, token }) {
  return layout(
    'Uploaded',
    `<h1>Uploaded</h1>
     <p><strong>${escapeHtml(name)}</strong> was stored.</p>
     <p><a href="/u/${escapeHtml(token)}">Upload another file</a></p>`,
    null,
  );
}

// Public page for a share link. Only the file's name, size, and type, plus a preview and a download link. It
// never shows a GitHub name, tag, or asset. The token is URL-safe, and every value is escaped.
function sharePage({ name, size, type, previewable }, token) {
  const mb = size >= 1024 * 1024 ? `${(size / 1024 / 1024).toFixed(1)} MB` : size >= 1024 ? `${(size / 1024).toFixed(1)} KB` : `${size} B`;
  const t = escapeHtml(token);
  const preview = previewable
    ? `<iframe class="share-preview" src="/s/${t}/preview" title="Preview of ${escapeHtml(name)}"></iframe>`
    : '<p>This file type cannot be previewed.</p>';
  return layout(
    escapeHtml(name),
    `<h1>Shared file</h1>
     <p><strong>${escapeHtml(name)}</strong> · ${escapeHtml(mb)} · ${escapeHtml(type.split(';')[0])}</p>
     ${preview}
     <p>
       ${previewable ? `<a class="button" href="/s/${t}/preview" target="_blank" rel="noopener">Open in new tab</a> ` : ''}
       <a class="button" href="/s/${t}/download" download>Download</a>
     </p>`,
    null,
    { wide: true, extraCss: DASHBOARD_CSS },
  );
}

function errorPage(status, message, user = null) {
  return layout(`Error ${status}`, `<h1>Error ${status}</h1><p class="error">${escapeHtml(message)}</p>`, user);
}

// Pips Android install page (standalone, public): an app-store-style landing page. Phone users
// open it from a shared link, see the app header (icon, name, version/size chips), a big
// download button for the latest signed APK, what's new, install steps, and a feature grid.
const INSTALL_CSS = `
      * { box-sizing: border-box; }
      body.install { margin: 0; font-family: system-ui, sans-serif; color: #e6edf3; background: #0b1020; overflow-x: hidden; }
      body.install a { color: #7ee2ff; }
      .install .glow { position: fixed; width: 46rem; height: 46rem; border-radius: 50%; filter: blur(90px); opacity: .16; pointer-events: none; z-index: 0; }
      .install .g1 { background: #2ecc71; top: -18rem; right: -14rem; }
      .install .g2 { background: #4f8cff; bottom: -20rem; left: -16rem; }
      .store { position: relative; z-index: 1; max-width: 30rem; margin: 0 auto; padding: 1.6rem 1rem 2.4rem; display: flex; flex-direction: column; gap: 1rem; }
      .app-card { background: linear-gradient(160deg, #141a2e 0%, #101522 70%); border: 1px solid #262d42; border-radius: 20px; padding: 1.8rem 1.4rem 1.5rem; text-align: center; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
      .app-icon { width: 96px; height: 96px; border-radius: 22%; display: block; margin: 0 auto .9rem; box-shadow: 0 10px 28px rgba(0,0,0,.5), 0 0 0 1px #2b3550; background: #101522; }
      .app-card h1 { margin: 0; font-size: 1.75rem; letter-spacing: -.02em; color: #fff; }
      .app-card .tagline { margin: .35rem 0 0; color: #9aa8c0; font-size: .95rem; line-height: 1.5; }
      .dev-row { margin: .7rem 0 0; color: #6d7a94; font-size: .82rem; display: flex; gap: .5rem; justify-content: center; flex-wrap: wrap; }
      .dev-row b { color: #aeb9d0; font-weight: 600; }
      .install-btn { display: flex; align-items: center; justify-content: center; gap: .55rem; margin: 1.2rem auto .8rem; max-width: 22rem; padding: .95rem 1.4rem; border-radius: 14px; background: linear-gradient(135deg, #2ecc71, #27ae60); color: #fff; font-size: 1.05rem; font-weight: 800; text-decoration: none; letter-spacing: .01em; box-shadow: 0 10px 26px rgba(46,204,113,.35); transition: transform .12s ease, box-shadow .12s ease; }
      .install-btn:hover { transform: translateY(-2px); box-shadow: 0 14px 32px rgba(46,204,113,.45); }
      .install-btn:active { transform: translateY(0); }
      .install-sub { margin: 0; color: #8a97b1; font-size: .84rem; }
      .install-sub b { color: #c6d0e2; font-weight: 600; }
      .verify-row { margin: .9rem 0 0; display: flex; gap: .45rem; justify-content: center; flex-wrap: wrap; }
      .vchip { display: inline-flex; align-items: center; gap: .3rem; border: 1px solid #2b3550; background: #131a2b; color: #9fb4d8; border-radius: 999px; padding: .28rem .7rem; font-size: .76rem; }
      .vchip svg { color: #2ecc71; }
      .panel { background: #12182a; border: 1px solid #232c44; border-radius: 16px; padding: 1.1rem 1.25rem 1.25rem; }
      .panel h2 { margin: 0 0 .6rem; font-size: 1.02rem; color: #fff; display: flex; align-items: center; gap: .5rem; }
      .panel h2 svg { color: #4f8cff; flex: none; }
      .panel ul, .panel ol { margin: 0; padding-left: 1.3rem; color: #b9c4d8; font-size: .92rem; line-height: 1.65; }
      .panel li { margin: .3rem 0; }
      .panel li b { color: #e6edf3; font-weight: 600; }
      .panel .hint { margin: .8rem 0 0; color: #6d7a94; font-size: .8rem; line-height: 1.55; }
      .step-num { display: inline-flex; align-items: center; justify-content: center; width: 1.45rem; height: 1.45rem; margin-right: .1rem; border-radius: 50%; background: #1c2740; border: 1px solid #33406b; color: #8fb0ff; font-size: .78rem; font-weight: 700; vertical-align: middle; }
      ol.steps { list-style: none; padding-left: 0; display: flex; flex-direction: column; gap: .7rem; }
      ol.steps li { display: flex; gap: .7rem; align-items: flex-start; margin: 0; }
      ol.steps .step-num { flex: none; margin-top: .1rem; }
      .feat-grid { display: grid; grid-template-columns: 1fr 1fr; gap: .7rem; }
      .feat { background: #12182a; border: 1px solid #232c44; border-radius: 14px; padding: .9rem .95rem; }
      .feat svg { color: #2ecc71; }
      .feat:nth-child(2n) svg { color: #4f8cff; }
      .feat h3 { margin: .45rem 0 .2rem; font-size: .9rem; color: #eef2fa; }
      .feat p { margin: 0; color: #8a97b1; font-size: .8rem; line-height: 1.5; }
      .install-foot { text-align: center; color: #5c6a85; font-size: .82rem; padding: .4rem 0 0; display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }
      .install-foot a { color: #7ee2ff; text-decoration: none; }
      .install-foot a:hover { text-decoration: underline; }
      @media (max-width: 380px) { .feat-grid { grid-template-columns: 1fr; } }`;

function appInstallPage(info) {
  const mb = info.sizeBytes ? Math.max(1, Math.round(info.sizeBytes / (1024 * 1024))) : 0;
  const apk = escapeHtml(info.apkUrl);
  const version = escapeHtml(info.version);
  const updated = escapeHtml(info.updated || '');
  const releases = escapeHtml(info.releasesUrl);
  const dl = svg('<path d="M12 4v11"/><path d="m6 11 6 6 6-6"/><path d="M5 21h14"/>', 20);
  const shieldSm = svg('<path d="M12 2 4 5v6c0 5 3.4 8.6 8 11 4.6-2.4 8-6 8-11V5l-8-3z"/><path d="m9 12 2 2 4-4"/>', 13);
  const iconNew = svg('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>', 16);
  const iconSteps = svg('<path d="M8 6h13M8 12h13M8 18h13"/><path d="m3 6 1 1 2-2"/><path d="m3 12 1 1 2-2"/><path d="m3 18 1 1 2-2"/>', 16);
  const iFolder = svg('<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6z"/>', 20);
  const iPlay = svg('<path d="m6 4 14 8-14 8V4z"/>', 20);
  const iChat = svg('<path d="M21 12a8 8 0 0 1-8 8H4l2-3a8 8 0 1 1 15-5z"/><path d="M9 11h.01M12.5 11h.01M16 11h.01"/>', 20);
  const iDoc = svg('<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8l-6-6z"/><path d="M14 2v6h6"/><path d="M9 13h6M9 17h6"/>', 20);
  const iShield = svg('<path d="M12 2 4 5v6c0 5 3.4 8.6 8 11 4.6-2.4 8-6 8-11V5l-8-3z"/>', 20);
  const iBolt = svg('<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8z"/>', 20);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    <title>Pips - Android app install</title>
    <style>${INSTALL_CSS}
    </style>
  </head>
  <body class="install">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="store">
      <section class="app-card">
        <img class="app-icon" src="/assets/pips-logo.png" alt="Pips app icon" width="96" height="96">
        <h1>Pips</h1>
        <p class="tagline">Your cloud in one app — files, videos, chat &amp; docs</p>
        <p class="dev-row"><b>web12-app</b><span>&middot;</span><span>Free</span><span>&middot;</span><span>Android</span></p>
        <a class="install-btn" href="${apk}" rel="noopener">${dl} Download APK</a>
        <p class="install-sub"><b>v${version}</b>${mb ? ` &middot; ${mb} MB` : ''} &middot; Android 5.0+${updated ? ` &middot; Updated ${updated}` : ''}</p>
        <div class="verify-row">
          <span class="vchip">${shieldSm} Signed release build</span>
          <span class="vchip">${shieldSm} Official GitHub release</span>
        </div>
      </section>

      <section class="panel">
        <h2>${iconNew} What's new</h2>
        <ul>
          <li><b>Full cloud connection</b> — every feature now talks to your File Vault server: files, Tube, chat, docs, devices.</li>
          <li><b>Smoother sign-in</b> — one account works in the app and on the web, with per-device API keys.</li>
          <li><b>Stability fixes</b> — faster startup and more reliable uploads on flaky mobile networks.</li>
        </ul>
      </section>

      <section class="panel">
        <h2>${iconSteps} How to install</h2>
        <ol class="steps">
          <li><span class="step-num">1</span><span><b>Download the APK</b> with the green button above.</span></li>
          <li><span class="step-num">2</span><span><b>Allow installs</b> — when Android asks, permit installs from your browser ("Install unknown apps").</span></li>
          <li><span class="step-num">3</span><span><b>Open Pips</b>, sign in or create an account, and everything syncs with the web.</span></li>
        </ol>
        <p class="hint">The APK is built from the official repository and signed with the release key. If a previous version is installed, this update installs over it and keeps your sign-in.</p>
      </section>

      <section class="panel">
        <h2>${iBolt} Everything in your pocket</h2>
        <div class="feat-grid">
          <div class="feat">${iFolder}<h3>Your files, 2 GB each</h3><p>Upload, preview, share, and import from any link.</p></div>
          <div class="feat">${iPlay}<h3>Tube</h3><p>Publish videos, follow channels, watch anywhere.</p></div>
          <div class="feat">${iChat}<h3>Direct messages</h3><p>Chat with attachments, likes, and notifications.</p></div>
          <div class="feat">${iDoc}<h3>Pips Docs</h3><p>Per-account text documents with version restore.</p></div>
          <div class="feat">${iShield}<h3>Private by design</h3><p>Data lives in your own private repositories.</p></div>
          <div class="feat">${dl}<h3>Device manager</h3><p>See every signed-in phone and revoke access.</p></div>
        </div>
      </section>

      <footer class="install-foot">
        <a href="/" rel="noopener">Open web app</a>
        <a href="${releases}" rel="noopener">All releases</a>
        <a href="/api/health" rel="noopener">Service status</a>
      </footer>
    </main>
  </body>
</html>
`;
}

const TUNNEL_CSS = `
      * { box-sizing: border-box; }
      body.tun { margin: 0; font-family: system-ui, sans-serif; color: #e6edf3; background: #0b1020; overflow-x: hidden; }
      body.tun a { color: #7ee2ff; }
      .tun .glow { position: fixed; width: 46rem; height: 46rem; border-radius: 50%; filter: blur(90px); opacity: .16; pointer-events: none; z-index: 0; }
      .tun .g1 { background: #7a5cff; top: -18rem; left: -14rem; }
      .tun .g2 { background: #4f8cff; bottom: -20rem; right: -16rem; }
      .wrap { position: relative; z-index: 1; max-width: 34rem; margin: 0 auto; padding: 1.8rem 1rem 2.6rem; display: flex; flex-direction: column; gap: 1rem; }
      .hero { background: linear-gradient(160deg, #16132e 0%, #101522 70%); border: 1px solid #2a2d52; border-radius: 20px; padding: 1.7rem 1.4rem 1.5rem; text-align: center; box-shadow: 0 18px 50px rgba(0,0,0,.45); }
      .hero h1 { margin: 0; font-size: 1.7rem; letter-spacing: -.02em; color: #fff; }
      .hero .tagline { margin: .4rem 0 0; color: #9aa8c0; font-size: .95rem; line-height: 1.5; }
      .tun-btn { display: flex; align-items: center; justify-content: center; gap: .55rem; margin: 1.2rem auto .7rem; max-width: 22rem; padding: .95rem 1.4rem; border-radius: 14px; background: linear-gradient(135deg, #7a5cff, #4f8cff); color: #fff; font-size: 1.05rem; font-weight: 800; text-decoration: none; letter-spacing: .01em; box-shadow: 0 10px 26px rgba(79,90,255,.35); transition: transform .12s ease, box-shadow .12s ease; }
      .tun-btn:hover { transform: translateY(-2px); box-shadow: 0 14px 32px rgba(79,90,255,.45); }
      .tun-sub { margin: 0; color: #8a97b1; font-size: .84rem; }
      .tun-sub b { color: #c6d0e2; font-weight: 600; }
      .panel { background: #12182a; border: 1px solid #232c44; border-radius: 16px; padding: 1.1rem 1.25rem 1.25rem; }
      .panel h2 { margin: 0 0 .7rem; font-size: 1.02rem; color: #fff; }
      ol.steps { list-style: none; padding-left: 0; margin: 0; display: flex; flex-direction: column; gap: .7rem; color: #b9c4d8; font-size: .92rem; line-height: 1.6; }
      ol.steps li { display: flex; gap: .7rem; align-items: flex-start; }
      .step-num { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 1.45rem; height: 1.45rem; border-radius: 50%; background: #1c2740; border: 1px solid #33406b; color: #8fb0ff; font-size: .78rem; font-weight: 700; margin-top: .15rem; }
      pre.code { margin: .9rem 0 0; background: #0a0f1d; border: 1px solid #232c44; border-radius: 10px; padding: .8rem .9rem; overflow-x: auto; color: #9fe8c3; font: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .85rem; line-height: 1.6; }
      .hint { margin: .8rem 0 0; color: #6d7a94; font-size: .8rem; line-height: 1.55; }
      ul.live { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: .5rem; }
      ul.live li { display: flex; justify-content: space-between; gap: 1rem; align-items: center; background: #0a0f1d; border: 1px solid #232c44; border-radius: 10px; padding: .6rem .8rem; font-size: .9rem; }
      ul.live a { text-decoration: none; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      ul.live a:hover { text-decoration: underline; }
      ul.live .meta { color: #6d7a94; font-size: .78rem; white-space: nowrap; }
      .empty { margin: 0; color: #6d7a94; font-size: .88rem; }
      .tun-foot { text-align: center; color: #5c6a85; font-size: .82rem; display: flex; gap: 1rem; justify-content: center; flex-wrap: wrap; }
      .tun-foot a { color: #7ee2ff; text-decoration: none; }
      .tun-foot a:hover { text-decoration: underline; }`;

// The /tun landing page: installer one-liner, quickstart, and the list of
// currently connected tunnels. Standalone like the /app install page.
function tunnelPage({ tunnels, base = '' }) {
  const escBase = escapeHtml(base);
  const rows = tunnels
    .map(
      (t) =>
        `<li><a href="/tun/${escapeHtml(t.name)}">/tun/${escapeHtml(t.name)}</a><span class="meta">${t.pending} pending &middot; ${t.answered} answered</span></li>`,
    )
    .join('\n        ');
  const live = rows
    ? `<ul class="live">\n        ${rows}\n      </ul>`
    : '<p class="empty">No tunnels are connected right now. Run the client below and this list fills in.</p>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    <title>Pips Tunnel — publish your localhost</title>
    <style>${TUNNEL_CSS}
    </style>
  </head>
  <body class="tun">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="wrap">
      <section class="hero">
        <h1>Pips Tunnel</h1>
        <p class="tagline">Put any localhost app on this server's public URL. Run one command, share one link.</p>
        <a class="tun-btn" href="/api/tunnel/client.tar.gz" download>tunnel.tar.gz &nbsp;·&nbsp; download</a>
        <p class="tun-sub">Zero dependencies &middot; needs <b>Node 18+</b> &middot; macOS / Linux / Windows &middot; <a href="/docs/tunnel">Full guide</a></p>
      </section>

      <section class="panel">
        <h2>Three steps</h2>
        <ol class="steps">
          <li><span class="step-num">1</span><span>Install the client — one line on macOS and Linux:</span></li>
          <li><span class="step-num">2</span><span>Publish your app's local port under any app name.</span></li>
          <li><span class="step-num">3</span><span>Open <b>/tun/&lt;app-name&gt;</b> here — that URL now serves your localhost.</span></li>
        </ol>
        <pre class="code">curl -fsSL ${escBase}/tunnel.sh | sh
~/.pips-tunnel/tun start 5000
# → ${escBase}/tun/&lt;name&gt;  (a random name is assigned and printed)</pre>
        <p class="hint">Want a stable URL? Create a token: <b>curl -X POST ${escBase}/api/tunnel/account</b>, run <b>tun login &lt;token&gt;</b> once, then <b>tun start 5000 myname</b> keeps <b>/tun/myname</b> yours. Inspect traffic and logs at <b>${escBase}/tun/dashboard</b>. No curl? Download <b>tunnel.tar.gz</b> above and unpack it: <b>tar -xzf tunnel.tar.gz &amp;&amp; cd tunnel &amp;&amp; ./tun start 5000</b>. Windows: <b>node tun.js start 5000</b>. More: <b>tun list</b>, <b>tun close &lt;name&gt;</b>, and <b>--server &lt;url&gt;</b> to target any other host (ngrok, Cloudflare, anything in front of this app). The /tun/&lt;name&gt; prefix is stripped before your app sees the request.</p>
        <p class="hint">Site user? <a href="${escBase}/tunnel">Create tokens &amp; reserve names in the tunnel manager &rarr;</a></p>
      </section>

      <section class="panel">
        <h2>Live tunnels</h2>
        ${live}
      </section>

      <footer class="tun-foot">
        <a href="/">Open web app</a>
        <a href="/app">Get the Pips app</a>
        <a href="/api/health">Service status</a>
        <a href="/docs/tunnel">Full guide</a>
        <a href="/llms.txt">llms.txt</a>
      </footer>
    </main>
  </body>
</html>
`;
}

// ---- Tunnel v2: visitor error pages, dashboard login, dashboard ----

// What visitors see when a tunnel cannot serve their request. Status codes are
// set by the caller in server.js. The offline page reloads itself so a client
// that connects a moment later picks the visitor up without a manual refresh.
function tunnelErrorPage({ kind, name, base = '' }) {
  const escName = escapeHtml(name);
  const escBase = escapeHtml(base);
  const variants = {
    offline: {
      title: 'Tunnel offline',
      body: `No app is connected to <b>/tun/${escName}</b> right now.`,
      hint: 'Start the local client on the machine that runs the app, and this page will pick it up by itself.',
      refresh: true,
    },
    down: {
      title: 'Local app not answering',
      body: `The tunnel <b>/tun/${escName}</b> is connected, but <b>http://localhost</b> on the other side refused the connection or timed out.`,
      hint: 'Check that the local app is actually running on the port the client was pointed at.',
      refresh: false,
    },
    slow: {
      title: 'Tunnel did not answer in time',
      body: `The app behind <b>/tun/${escName}</b> accepted the request but did not answer in time.`,
      hint: 'The local app may be slow or stuck — try again in a moment.',
      refresh: false,
    },
    busy: {
      title: 'Tunnel is busy',
      body: `<b>/tun/${escName}</b> has too many queued requests right now.`,
      hint: 'Wait a moment and reload — the queue drains as the local app answers.',
      refresh: false,
    },
    websocket: {
      title: 'WebSocket not supported',
      body: 'WebSocket forwarding is not supported.',
      hint: `The tunnel <b>/tun/${escName}</b> forwards plain HTTP requests only.`,
      refresh: false,
    },
    protected: {
      title: 'Tunnel protected',
      body: 'This tunnel requires an access token.',
      hint: `The owner has gated <b>/tun/${escName}</b>. Append ?access=<token> to the URL, or send an x-tunnel-access header.`,
      refresh: false,
    },
  };
  const v = variants[kind] || variants.offline;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    ${v.refresh ? '<meta http-equiv="refresh" content="10">\n    ' : ''}<title>${v.title} — Pips Tunnel</title>
    <style>${TUNNEL_CSS}
      .tun-card { max-width: 30rem; margin: 14vh auto 0; position: relative; z-index: 1; text-align: center; background: #12182a; border: 1px solid #232c44; border-radius: 16px; padding: 2rem 1.5rem 1.7rem; }
      .tun-card h1 { margin: 0 0 .5rem; font-size: 1.4rem; color: #fff; }
      .tun-card .name { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #8fb0ff; }
      .tun-card p { color: #9aa8c0; font-size: .95rem; line-height: 1.6; margin: .4rem 0; }
      .tun-card .hint { color: #6d7a94; font-size: .82rem; }
      .tun-card a.back { display: inline-block; margin-top: 1.1rem; padding: .6rem 1.2rem; border-radius: 10px; background: linear-gradient(135deg, #7a5cff, #4f8cff); color: #fff; font-weight: 700; text-decoration: none; font-size: .92rem; }
    </style>
  </head>
  <body class="tun">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="tun-card">
      <h1>${v.title}</h1>
      <p>${v.body}</p>
      <p class="hint">${v.hint}${v.refresh ? ' This page retries every 10 seconds.' : ''}</p>
      <a class="back" href="${escBase}/tun">Back to Pips Tunnel</a>
    </main>
  </body>
</html>
`;
}

// Login card for the tunnel dashboard: paste a tunt_ token to inspect traffic.
function tunnelLoginPage({ error, base = '' }) {
  const escBase = escapeHtml(base);
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    <title>Tunnel dashboard — Pips Tunnel</title>
    <style>${TUNNEL_CSS}
      .tun-card { max-width: 26rem; margin: 14vh auto 0; position: relative; z-index: 1; text-align: center; background: #12182a; border: 1px solid #232c44; border-radius: 16px; padding: 2rem 1.5rem 1.7rem; }
      .tun-card h1 { margin: 0 0 .5rem; font-size: 1.4rem; color: #fff; }
      .tun-card p { color: #9aa8c0; font-size: .95rem; line-height: 1.6; margin: .4rem 0; }
      .tun-card form { display: flex; flex-direction: column; gap: .8rem; margin-top: 1.2rem; }
      .tun-card input { background: #0a0f1d; border: 1px solid #232c44; border-radius: 10px; color: #e6edf3; padding: .8rem .9rem; font: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: .9rem; }
      .tun-card input:focus { outline: none; border-color: #7a5cff; }
      .tun-card button { border: 0; border-radius: 10px; padding: .8rem 1rem; background: linear-gradient(135deg, #7a5cff, #4f8cff); color: #fff; font-weight: 800; font-size: 1rem; cursor: pointer; }
      .tun-error { background: #2a1420; border: 1px solid #7a2b47; color: #ff9db5; border-radius: 10px; padding: .6rem .8rem; font-size: .86rem; margin-top: 1rem; }
      .tun-card a.back { display: inline-block; margin-top: 1.1rem; color: #7ee2ff; font-size: .86rem; text-decoration: none; }
    </style>
  </head>
  <body class="tun">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="tun-card">
      <h1>Tunnel dashboard</h1>
      <p>Paste your tunnel token (<b>tunt_…</b>) to inspect traffic and logs.</p>
      ${error ? `<div class="tun-error">${escapeHtml(error)}</div>` : ''}
      <form method="post" action="/tun/dashboard">
        <input type="password" name="token" placeholder="tunt_…" autofocus autocomplete="off">
        <button type="submit">Open dashboard</button>
      </form>
      <a class="back" href="${escBase}/tun">Back to Pips Tunnel</a>
    </main>
  </body>
</html>
`;
}

// The traffic inspector for one tunnel account: owned names with live/offline
// badges, per-name counters and the most recent proxied requests per name.
function tunnelDashboardPage({ account, names, tunnels, base = '' }) {
  const escBase = escapeHtml(base);
  const liveNow = names.filter((n) => n.live).length;
  const totalServed = names.reduce((sum, n) => sum + (Number(n.served) || 0), 0);
  const stat = (label, value) =>
    `<div class="stat"><span class="stat-num">${escapeHtml(String(value))}</span><span class="stat-label">${escapeHtml(label)}</span></div>`;
  const cards =
    `<div class="stats">${stat('names owned', names.length)}${stat('live now', liveNow)}${stat('requests served', totalServed)}</div>`;
  const panels = names
    .map((n) => {
      const live = tunnels.some((t) => t.name === n.name);
      const badge = live ? '<span class="badge live-badge">live</span>' : '<span class="badge off-badge">offline</span>';
      const lastSeen = n.lastSeen ? new Date(n.lastSeen).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : 'never';
      const rows = (n.logs || [])
        .map(
          (l) =>
            `<tr><td>${new Date(l.t).toISOString()}</td><td>${escapeHtml(l.method)}</td><td class="mono">${escapeHtml(l.path)}</td><td>${escapeHtml(String(l.status))}</td><td>${escapeHtml(String(l.ms))}</td><td>${escapeHtml(String(l.bytes))}</td></tr>`,
        )
        .join('\n            ');
      const table = rows
        ? `<table class="logs"><thead><tr><th>time (UTC)</th><th>method</th><th>path</th><th>status</th><th>ms</th><th>bytes</th></tr></thead><tbody>
            ${rows}
          </tbody></table>`
        : '<p class="empty">No requests through this name yet.</p>';
      return `<section class="panel name-panel">
        <h2><span class="mono">/tun/${escapeHtml(n.name)}</span> ${badge}</h2>
        <p class="meta">${Number(n.served) || 0} served &middot; ${Number(n.bytes) || 0} bytes &middot; last seen ${escapeHtml(lastSeen)}</p>
        ${table}
      </section>`;
    })
    .join('\n      ');
  const body = names.length
    ? panels
    : '<p class="empty">No tunnel names belong to this account yet. Run <b>tun start &lt;port&gt; &lt;name&gt;</b> with your token logged in to claim one.</p>';
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="theme-color" content="#0b1020">
    <title>Tunnel dashboard — Pips Tunnel</title>
    <style>${TUNNEL_CSS}
      .wrap { max-width: 46rem; }
      .stats { display: flex; gap: .8rem; }
      .stat { flex: 1; background: #12182a; border: 1px solid #232c44; border-radius: 14px; padding: .9rem 1rem; display: flex; flex-direction: column; gap: .2rem; }
      .stat-num { color: #fff; font-size: 1.35rem; font-weight: 800; }
      .stat-label { color: #6d7a94; font-size: .78rem; }
      .mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
      .badge { display: inline-block; border-radius: 999px; padding: .12rem .6rem; font-size: .7rem; font-weight: 800; letter-spacing: .04em; vertical-align: middle; }
      .live-badge { background: #123529; border: 1px solid #1f7a4d; color: #5eeaa4; }
      .off-badge { background: #2a1420; border: 1px solid #7a2b47; color: #ff9db5; }
      .name-panel .meta { margin: 0 0 .8rem; color: #6d7a94; font-size: .8rem; }
      table.logs { width: 100%; border-collapse: collapse; font-size: .8rem; }
      table.logs th { text-align: left; color: #6d7a94; font-weight: 600; padding: .35rem .5rem; border-bottom: 1px solid #232c44; }
      table.logs td { padding: .35rem .5rem; border-bottom: 1px solid #1a2138; color: #b9c4d8; }
      table.logs td.mono { color: #9fe8c3; word-break: break-all; }
      .logout { color: #6d7a94; font-size: .82rem; text-align: center; }
    </style>
  </head>
  <body class="tun">
    <div class="glow g1" aria-hidden="true"></div>
    <div class="glow g2" aria-hidden="true"></div>
    <main class="wrap">
      <section class="hero">
        <h1>Tunnel dashboard</h1>
        <p class="tagline">${escapeHtml(account.label || 'Tunnel account')} &middot; token <b>${escapeHtml(account.tokenMask)}</b></p>
      </section>
      ${cards}
      ${body}
      <p class="logout">To sign out, just reopen <b>/tun/dashboard</b> without the token.</p>
      <footer class="tun-foot">
        <a href="${escBase}/tun">Pips Tunnel</a>
        <a href="/api/health">Service status</a>
      </footer>
    </main>
  </body>
</html>
`;
}

// ---- Tunnel manager (/tunnel): tokens + reserved names for signed-in site users ----

// Extra styles on top of the layout chrome. Reuses DASHBOARD_CSS classes
// (table.files, .badge, .hint, button.danger, .button); only the creation
// banner and the token <code> look are new.
const TUNNEL_MANAGE_CSS = `
      code { background: #f6f8fa; border-radius: 4px; padding: .1rem .35rem; font-size: .92em; overflow-wrap: anywhere; }
      select { display: block; width: 100%; padding: .4rem; margin-top: .25rem; box-sizing: border-box; }
      .panel { border: 1px solid #d0d7de; border-radius: 8px; padding: 1rem; margin: 1rem 0; background: #fff; }
      .panel h2 { margin-top: 0; }
      .badge.live-badge { background: #dafbe1; color: #116329; }
      .badge.off-badge { background: #ffebe9; color: #cf222e; }
      .created-banner { border: 1px solid #1a7f37; background: #dafbe1; border-radius: 8px; padding: .8rem 1rem; margin: .75rem 0; }
      .created-banner p { margin: .3rem 0; }
      .created-banner .token { font-size: 1.02rem; font-weight: 600; }
      .row-actions { display: flex; gap: .4rem; }
      .foot-links { margin-top: 1.5rem; border-top: 1px solid #d0d7de; padding-top: .75rem; }`;

// The one-time full-token banner. `created` comes either from the server
// render (rare) or, after the fetch create flow, from sessionStorage.
function tunnelCreatedBanner({ token, label }) {
  return `<div class="created-banner" role="status">
        <p><strong>New tunnel token${label ? ` “${escapeHtml(label)}”` : ''} created.</strong></p>
        <p>Copy it now — it is shown only once:</p>
        <p><code class="token">${escapeHtml(token)}</code></p>
        <p class="hint">Use it with the CLI: <code>tun login ${escapeHtml(token)}</code></p>
      </div>`;
}

function tunnelManagePage({ user, tokens, names, error = '', created = null }) {
  const esc = escapeHtml;
  const banner = created ? tunnelCreatedBanner(created) : '<div id="banner-slot"></div>';
  const tokenRows = tokens
    .map(
      (t) => `<tr>
            <td data-label="label">${t.label ? esc(t.label) : '<span class="hint">—</span>'}</td>
            <td data-label="token"><code>${esc(t.tokenMask)}</code></td>
            <td data-label="created">${new Date(t.createdAt).toISOString().slice(0, 10)}</td>
            <td data-label="names">${Number(t.names) || 0}</td>
            <td class="actions" data-label="actions"><button class="danger" data-revoke="${esc(t.id)}">Revoke</button></td>
          </tr>`,
    )
    .join('\n            ');
  const tokenTable = tokenRows
    ? `<table class="files"><thead><tr><th>label</th><th>token</th><th>created</th><th>names</th><th></th></tr></thead><tbody>
            ${tokenRows}
          </tbody></table>`
    : '<p class="hint">No tunnel tokens yet. A token lets the CLI client (<b>tun</b>) connect and hold stable names for you.</p>';
  const nameRows = names
    .map(
      (n) => `<tr>
            <td data-label="name"><a href="/tun/${esc(n.name)}">/tun/${esc(n.name)}</a></td>
            <td data-label="status">${n.live ? '<span class="badge live-badge">LIVE</span>' : '<span class="badge off-badge">OFFLINE</span>'}</td>
            <td data-label="served">${Number(n.served) || 0}</td>
            <td data-label="bytes">${Number(n.bytes) || 0}</td>
            <td data-label="token"><code>${esc(n.tokenMask)}</code></td>
            <td class="actions" data-label="actions"><button class="danger" data-release="${esc(n.name)}">Release</button></td>
          </tr>`,
    )
    .join('\n            ');
  const nameTable = nameRows
    ? `<table class="files"><thead><tr><th>name</th><th>status</th><th>served</th><th>bytes</th><th>token</th><th></th></tr></thead><tbody>
            ${nameRows}
          </tbody></table>`
    : '<p class="hint">No reserved names yet. Reserve one below and <b>/tun/&lt;name&gt;</b> stays yours even across restarts.</p>';
  const tokenOptions = tokens
    .map((t) => `<option value="${esc(t.id)}">${esc(t.tokenMask)}${t.label ? ' · ' + esc(t.label) : ''}</option>`)
    .join('\n              ');
  const reserveForm = tokens.length
    ? `<form id="claim-form">
          <label>Name
            <input name="name" required maxlength="32" pattern="[a-z0-9][a-z0-9_-]{0,31}" placeholder="mytun" autocomplete="off">
          </label>
          <label>Tunnel token
            <select name="accountId">${tokenOptions}</select>
          </label>
          <button type="submit">Reserve name</button>
        </form>`
    : '<p class="hint">Create a tunnel token first — then you can reserve stable names for it.</p>';
  const body = `<h1>Tunnels</h1>
    <p class="hint">Stable tunnel names and CLI tokens for <strong>${esc(user.username)}</strong>.</p>
    ${error ? `<p class="error" role="alert">${esc(error)}</p>` : ''}
    ${banner}
    <section class="panel">
      <h2>Tunnel tokens</h2>
      <p><button id="create-token">Create token</button> <label class="hint" style="display:inline">label <input id="token-label" maxlength="64" placeholder="laptop" autocomplete="off" style="display:inline;width:auto"></label></p>
      ${tokenTable}
    </section>
    <section class="panel">
      <h2>Your tunnel names</h2>
      ${nameTable}
    </section>
    <section class="panel">
      <h2>Reserve a tunnel name</h2>
      ${reserveForm}
    </section>
    <p class="hint foot-links">
      Public tunnels: <a href="/tun">/tun</a> &middot; Deep inspection: <a href="/tun/dashboard">/tun/dashboard</a> &middot; Full guide: <a href="/docs/tunnel">/docs/tunnel</a><br>
      Quickstart: <code>curl -fsSL /tunnel.sh | sh</code> then <code>tun login &lt;token&gt;</code> then <code>./tun start 5000 &lt;your-name&gt;</code>
    </p>
    <script>
    (() => {
      const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
      async function api(method, url, body) {
        const res = await fetch(url, { method, headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'fetch' }, body: body === undefined ? undefined : JSON.stringify(body) });
        let json = null;
        try { json = await res.json(); } catch (e) { /* non-JSON error */ }
        if (!res.ok || !json || json.success === false) {
          throw new Error((json && json.error && json.error.message) || ('Request failed (' + res.status + ')'));
        }
        return json.data;
      }
      function bannerHtml(t) {
        return '<div class="created-banner" role="status"><p><strong>New tunnel token' + (t.label ? ' \\u201c' + esc(t.label) + '\\u201d' : '') + ' created.</strong></p>'
          + '<p>Copy it now \\u2014 it is shown only once:</p>'
          + '<p><code class="token">' + esc(t.token) + '</code></p>'
          + '<p class="hint">Use it with the CLI: <code>tun login ' + esc(t.token) + '</code></p></div>';
      }
      const slot = document.getElementById('banner-slot');
      const saved = sessionStorage.getItem('tunnel-created');
      if (saved && slot) {
        sessionStorage.removeItem('tunnel-created');
        try { slot.innerHTML = bannerHtml(JSON.parse(saved)); } catch (e) { /* ignore */ }
      }
      document.addEventListener('click', async (e) => {
        const create = e.target.closest('#create-token');
        const revoke = e.target.closest('button[data-revoke]');
        const release = e.target.closest('button[data-release]');
        try {
          if (create) {
            const labelInput = document.getElementById('token-label');
            const data = await api('POST', '/api/tunnel/tokens', { label: labelInput ? labelInput.value : '' });
            sessionStorage.setItem('tunnel-created', JSON.stringify(data));
            location.reload();
          } else if (revoke) {
            await api('DELETE', '/api/tunnel/tokens/' + revoke.getAttribute('data-revoke'));
            location.reload();
          } else if (release) {
            await api('POST', '/api/tunnel/release', { name: release.getAttribute('data-release') });
            location.reload();
          }
        } catch (err) { alert(err.message); }
      });
      const claim = document.getElementById('claim-form');
      if (claim) claim.addEventListener('submit', async (e) => {
        e.preventDefault();
        try {
          await api('POST', '/api/tunnel/claim', {
            name: claim.elements.namedItem('name').value,
            accountId: claim.elements.namedItem('accountId').value,
          });
          location.reload();
        } catch (err) { alert(err.message); }
      });
    })();
    </script>`;
  return layout(`Tunnels - ${user.username}`, body, user, { wide: true, extraCss: DASHBOARD_CSS + TUNNEL_MANAGE_CSS, active: 'tunnel' });
}

module.exports = { escapeHtml, errorText, fmtLimit, welcomePage, appHomePage, explorePage, tubeFeedPage, tubeWatchPage, tubeChannelPage, chatPage, authForm, sharePage, uploadPage, uploadDonePage, errorPage, appInstallPage, tunnelPage, tunnelErrorPage, tunnelLoginPage, tunnelDashboardPage, tunnelManagePage };
