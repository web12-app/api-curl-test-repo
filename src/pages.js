'use strict';

// Server-rendered HTML. Every value from a request is escaped before it is written.

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

function layout(title, body, user) {
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
    <style>
      body { font-family: system-ui, sans-serif; max-width: 36rem; margin: 2rem auto; padding: 0 1rem; color: #1f2328; }
      nav { display: flex; gap: 1rem; align-items: center; border-bottom: 1px solid #d0d7de; padding-bottom: .75rem; }
      nav a { color: #0969da; }
      form.inline { display: inline; }
      label { display: block; margin: .75rem 0; }
      input { display: block; width: 100%; padding: .4rem; margin-top: .25rem; box-sizing: border-box; }
      button { padding: .5rem 1rem; cursor: pointer; }
      .error { color: #cf222e; }
    </style>
  </head>
  <body>
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

function dashboardPage(user) {
  return layout(
    'Dashboard',
    `<h1>Dashboard</h1>
     <p>Signed in as <strong>${escapeHtml(user.username)}</strong>.</p>`,
    user,
  );
}

function errorPage(status, message, user = null) {
  return layout(`Error ${status}`, `<h1>Error ${status}</h1><p class="error">${escapeHtml(message)}</p>`, user);
}

module.exports = { escapeHtml, errorText, homePage, authForm, dashboardPage, errorPage };
