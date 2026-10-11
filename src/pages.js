'use strict';

// Server-rendered HTML. Every value from a request is escaped before it is written.
const { dashboardClient } = require('./dashboard-client');

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

function errorText(code) {
  return ERROR_TEXT[code] || ERROR_TEXT.INTERNAL_ERROR;
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
      body.wide { max-width: 64rem; }
      .profile { display: flex; flex-wrap: wrap; justify-content: space-between; gap: 1rem; align-items: flex-end; }
      .profile h1 { margin: .5rem 0 0; font-size: 1.6rem; }
      .quota { margin: 0; min-width: 14rem; font-size: .9rem; color: #57606a; }
      .quota progress { width: 100%; }
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
      .notices { position: fixed; right: 1rem; bottom: 1rem; display: flex; flex-direction: column; gap: .5rem; max-width: min(24rem, calc(100vw - 2rem)); z-index: 10; }
      .notice { padding: .6rem .8rem; border-radius: 6px; background: #fff; border: 1px solid #d0d7de; box-shadow: 0 2px 8px rgba(31,35,40,.15); display: flex; justify-content: space-between; gap: .75rem; }
      .notice.success { border-color: #1a7f37; }
      .notice.error { border-color: #cf222e; color: #82071e; }
      .queue { list-style: none; padding: 0; margin: .75rem 0 0; }
      .queue-item { display: grid; grid-template-columns: minmax(6rem, 2fr) minmax(5rem, 3fr) auto; gap: .5rem; align-items: center; padding: .35rem 0; }
      .queue-item progress { width: 100%; }
      .queue-item.done { color: #1a7f37; }
      .queue-state.error { color: #cf222e; }
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

function layout(title, body, user, { wide = false, extraCss = '' } = {}) {
  const nav = user
    ? `<a href="/dashboard">Dashboard</a>
       <form method="post" action="/logout" class="inline"><button type="submit">Log out</button></form>`
    : `<a href="/login">Log in</a> <a href="/signup">Sign up</a>`;
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>${escapeHtml(title)}</title>
    <style>${BASE_CSS}${extraCss}
    </style>
  </head>
  <body${wide ? ' class="wide"' : ''}>
    <nav>${nav}</nav>
    ${body}
  </body>
</html>
`;
}

function homePage(user) {
  return layout(
    'Node.js app',
    `<h1>Hello from Node.js</h1>
     <p>Health check: <a href="/api/health">/api/health</a></p>`,
    user,
  );
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

// The dashboard. The file list and uploads are filled in by the script below, from this app's own API.
// filesEnabled is false when the storage settings are missing: the page then shows a notice and no upload UI.
function dashboardPage(user, { filesEnabled = false, maxBytes = 0, allowed = [] } = {}) {
  const name = escapeHtml(user.username);
  if (!filesEnabled) {
    return layout(
      'Dashboard',
      `<div class="profile"><div><h1>Your files</h1><p>Signed in as <strong>${name}</strong>.</p></div></div>
       <p class="error">File storage is not set up on this server yet. Login works; uploads are unavailable.</p>`,
      user,
      { wide: true, extraCss: DASHBOARD_CSS },
    );
  }
  const config = `<div id="dash-config" data-enabled="1" data-max-bytes="${escapeHtml(maxBytes)}" data-allowed="${escapeHtml(allowed.join(','))}" hidden></div>`;
  return layout(
    'Dashboard',
    `<div class="profile">
       <div>
         <h1>Your files</h1>
         <p>Signed in as <strong>${name}</strong>.</p>
       </div>
       <p class="quota" id="quota" aria-live="polite"></p>
     </div>
     <div id="notices" class="notices" aria-live="polite"></div>

     <section aria-labelledby="upload-title">
       <h2 id="upload-title">Upload</h2>
       <div id="drop" class="drop" tabindex="0">
         <p>Drag files here, or</p>
         <button type="button" id="pick">Choose files</button>
         <input type="file" id="picker" multiple accept="${escapeHtml(allowed.join(','))}" hidden>
         <p class="hint">Up to ${escapeHtml(Math.floor(maxBytes / 1024 / 1024))} MB per file. Allowed: ${escapeHtml(allowed.join(', '))}.</p>
       </div>
       <ul id="queue" class="queue" aria-label="Uploads"></ul>
     </section>

     <section aria-labelledby="files-title">
       <h2 id="files-title">Files</h2>
       <div class="toolbar">
         <label>Search
           <input type="search" id="search" placeholder="File name" maxlength="100" autocomplete="off">
         </label>
         <label>Type
           <select id="category">
             <option value="">All types</option>
             <option value="image">Images</option>
             <option value="document">Documents</option>
             <option value="archive">Archives</option>
           </select>
         </label>
       </div>
       <p id="files-status" role="status">Loading your files…</p>
       <table id="files" class="files">
         <thead>
           <tr><th>Name</th><th>Type</th><th>Size</th><th>Uploaded</th><th><span class="sr">Actions</span></th></tr>
         </thead>
         <tbody></tbody>
       </table>
     </section>
     ${config}
     <script>(${dashboardClient.toString()})();</script>`,
    user,
    { wide: true, extraCss: DASHBOARD_CSS },
  );
}

function errorPage(status, message, user = null) {
  return layout(`Error ${status}`, `<h1>Error ${status}</h1><p class="error">${escapeHtml(message)}</p>`, user);
}

module.exports = { escapeHtml, errorText, homePage, authForm, dashboardPage, errorPage };
