'use strict';

// Static assets for the offline fallback. When the live tunnel is down, ngrok answers page navigations
// with its own error page (ERR_NGROK_3200). Instead, a service worker (sw.js) precaches /offline.html
// and serves it whenever a navigation fails or an ngrok error body comes back, so downtime shows our
// own animated "checking connection" page that reloads itself once the site is back.
//
// All three files are self-contained: no external fonts, images, or scripts, so they work from the
// service-worker cache even when the origin is unreachable.

// The offline shell. Inline script and style only (the route's CSP allows exactly those), a conic
// gradient ring that spins around a pulsing dot, and a small loop that checks /api/health every five
// seconds and reloads the app the moment it answers. Everything is wrapped so the page never throws.
const OFFLINE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>Offline — File Vault</title>
<style>
  * { box-sizing: border-box; }
  html, body { height: 100%; }
  body {
    margin: 0;
    background: #0d0d0f;
    color: #e6e8ee;
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: 24px;
    text-align: center;
    -webkit-font-smoothing: antialiased;
  }
  .brand {
    position: fixed;
    top: 22px;
    left: 0;
    right: 0;
    font-size: 0.92rem;
    letter-spacing: 0.14em;
    text-transform: uppercase;
    color: #7c8494;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }
  .brand::before {
    content: "";
    width: 9px;
    height: 9px;
    border-radius: 3px;
    background: linear-gradient(135deg, #6366f1, #22d3ee);
  }
  .wrap { display: flex; flex-direction: column; align-items: center; gap: 0; max-width: 30rem; }
  .orb { position: relative; width: 110px; height: 110px; margin-bottom: 30px; }
  .ring {
    position: absolute;
    inset: 0;
    border-radius: 50%;
    background: conic-gradient(from 0deg, #6366f1, #22d3ee, #a78bfa, #6366f1);
    -webkit-mask: radial-gradient(farthest-side, transparent calc(100% - 9px), #000 calc(100% - 8px));
    mask: radial-gradient(farthest-side, transparent calc(100% - 9px), #000 calc(100% - 8px));
    animation: spin 1.1s linear infinite;
  }
  .dot {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 18px;
    height: 18px;
    margin: -9px 0 0 -9px;
    border-radius: 50%;
    background: #22d3ee;
    box-shadow: 0 0 18px rgba(34, 211, 238, 0.75);
    animation: pulse 1.6s ease-in-out infinite;
  }
  .check {
    position: absolute;
    top: 50%;
    left: 50%;
    width: 54px;
    height: 54px;
    margin: -27px 0 0 -27px;
    stroke: #34d399;
    stroke-width: 5;
    fill: none;
    stroke-linecap: round;
    stroke-linejoin: round;
    stroke-dasharray: 48;
    stroke-dashoffset: 48;
    opacity: 0;
  }
  .orb.online .ring {
    background: conic-gradient(from 0deg, #34d399, #10b981, #34d399);
    animation-duration: 0.7s;
  }
  .orb.online .dot { display: none; }
  .orb.online .check { opacity: 1; animation: draw 0.45s ease-out 0.1s forwards; }
  .orb.offline .dot { background: #f59e0b; box-shadow: 0 0 18px rgba(245, 158, 11, 0.7); }
  @keyframes spin { to { transform: rotate(360deg); } }
  @keyframes pulse { 0%, 100% { transform: scale(0.75); opacity: 0.6; } 50% { transform: scale(1.15); opacity: 1; } }
  @keyframes draw { to { stroke-dashoffset: 0; } }
  h1 {
    margin: 0 0 10px;
    font-size: 1.45rem;
    font-weight: 600;
    letter-spacing: 0.01em;
  }
  .orb.online ~ .status h1 { color: #34d399; }
  .dots span { animation: blink 1.4s infinite; opacity: 0; }
  .dots span:nth-child(2) { animation-delay: 0.2s; }
  .dots span:nth-child(3) { animation-delay: 0.4s; }
  @keyframes blink { 0%, 100% { opacity: 0; } 40% { opacity: 1; } }
  .host { margin: 0 0 22px; color: #8b93a3; font-size: 0.95rem; }
  .host span { color: #c3c9d6; }
  .retry { margin: 0 0 20px; color: #7c8494; font-size: 0.9rem; font-variant-numeric: tabular-nums; }
  .retry span { color: #aab2c1; }
  .retry.hidden, .status.hidden { display: none; }
  button {
    appearance: none;
    border: 1px solid #2b2b34;
    background: #16161c;
    color: #e6e8ee;
    font: inherit;
    font-size: 0.95rem;
    padding: 11px 26px;
    border-radius: 12px;
    cursor: pointer;
    transition: background 0.15s ease, border-color 0.15s ease, transform 0.15s ease;
  }
  button:hover { background: #1e1e26; border-color: #3a3a45; }
  button:active { transform: scale(0.97); }
  button:focus-visible { outline: 2px solid #22d3ee; outline-offset: 2px; }
  .hint { margin: 26px 0 0; color: #5c6470; font-size: 0.8rem; }
  @media (prefers-reduced-motion: reduce) {
    .ring, .dot, .check, .dots span { animation: none !important; }
    .orb.online .check { stroke-dashoffset: 0; opacity: 1; }
    button { transition: none; }
  }
  @media (max-width: 480px) {
    h1 { font-size: 1.2rem; }
    .orb { width: 92px; height: 92px; }
  }
</style>
</head>
<body>
  <div class="brand">File Vault</div>
  <main class="wrap">
    <div class="orb" id="orb" aria-hidden="true">
      <div class="ring"></div>
      <div class="dot"></div>
      <svg class="check" viewBox="0 0 52 52" aria-hidden="true"><path d="M14 27l8 8 16-16"/></svg>
    </div>
    <div class="status" id="status-box">
      <h1 id="status">Checking connection<span class="dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span></h1>
    </div>
    <p class="host">Trying to reach <span id="host">this site</span></p>
    <p class="retry" id="retry-line">Retrying in <span id="retry-in">5</span>s</p>
    <button id="try" type="button">Try now</button>
    <p class="hint">This page updates itself — no need to refresh.</p>
  </main>
<script>
(function () {
  try {
    var CHECK_MS = 5000;
    var failures = 0;
    var checking = false;
    var online = false;
    var tick = 0;

    var orb = document.getElementById('orb');
    var statusBox = document.getElementById('status-box');
    var statusEl = document.getElementById('status');
    var retryLine = document.getElementById('retry-line');
    var retryIn = document.getElementById('retry-in');
    var button = document.getElementById('try');
    var hostEl = document.getElementById('host');

    var DOTS = '<span class="dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>';

    try {
      if (hostEl) hostEl.textContent = location.hostname || 'this site';
    } catch (e) {}

    function setStatus(text, withDots) {
      try {
        statusEl.textContent = text;
        if (withDots) statusEl.insertAdjacentHTML('beforeend', DOTS);
      } catch (e) {}
    }

    function setCountdown(seconds) {
      try {
        if (retryIn) retryIn.textContent = String(seconds);
        if (retryLine && failures > 1) {
          retryLine.textContent = 'Retrying in ' + seconds + 's · attempt ' + failures;
        }
      } catch (e) {}
    }

    function setState(mode) {
      try {
        orb.className = 'orb ' + mode;
        statusBox.className = 'status';
        retryLine.className = 'retry';
        if (mode === 'online') {
          setStatus('Back online — opening', false);
          retryLine.className = 'retry hidden';
        } else if (mode === 'offline') {
          setStatus('Site offline — retrying', true);
        } else {
          setStatus('Checking connection', true);
        }
      } catch (e) {}
    }

    async function checkConnection() {
      if (checking || online) return;
      checking = true;
      setState('checking');
      try {
        var r = await fetch('/api/health?ts=' + Date.now(), { cache: 'no-store' });
        if (r && r.ok) {
          online = true;
          setState('online');
          setTimeout(function () {
            try { location.replace('/'); } catch (e) {}
          }, 900);
        } else {
          failures += 1;
          setState('offline');
        }
      } catch (e) {
        failures += 1;
        setState('offline');
      } finally {
        checking = false;
        try {
          if (!online) setCountdown(CHECK_MS / 1000);
        } catch (e) {}
      }
    }

    // One-second ticker: keeps the countdown in sync and fires a check every five ticks.
    setInterval(function () {
      try {
        if (online) return;
        tick += 1;
        if (tick >= CHECK_MS / 1000) {
          tick = 0;
          checkConnection();
        } else {
          setCountdown((CHECK_MS / 1000) - tick);
        }
      } catch (e) {}
    }, 1000);

    function checkNow() {
      try {
        tick = 0;
        setCountdown(CHECK_MS / 1000);
        checkConnection();
      } catch (e) {}
    }

    try {
      button.addEventListener('click', checkNow);
      document.addEventListener('visibilitychange', function () {
        try {
          if (document.visibilityState === 'visible') checkNow();
        } catch (e) {}
      });
    } catch (e) {}

    checkConnection();
  } catch (e) {}
})();
</script>
</body>
</html>
`;

// The service worker. Navigations only: try the network first, fall back to the cached offline page
// when the network fails, the server answers 5xx, or the response body is an ngrok error page.
const SW_JS = `'use strict';
const CACHE = 'offline-shell-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE)
      .then((cache) => cache.addAll([OFFLINE_URL]))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key))))
      .then(() => self.clients.claim())
  );
});

async function offlineResponse() {
  const cached = await caches.match(OFFLINE_URL);
  if (cached) return cached;
  return new Response('Site offline', {
    status: 503,
    headers: { 'Content-Type': 'text/plain; charset=utf-8' },
  });
}

async function handleNavigate(request) {
  try {
    const resp = await fetch(request);
    if (resp && resp.status < 400) return resp;
    if (resp && resp.status >= 500) return offlineResponse();
    if (resp && resp.status >= 400) {
      let text = '';
      try {
        text = await resp.clone().text();
      } catch (err) {
        text = '';
      }
      if (text.includes('ERR_NGROK')) return offlineResponse();
      return resp;
    }
    return resp;
  } catch (err) {
    return offlineResponse();
  }
}

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return;
  event.respondWith(handleNavigate(event.request));
});
`;

// Registers the service worker on every page. Best effort only: a failure here must never matter.
const SW_REGISTER_JS = `'use strict';
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    navigator.serviceWorker.register('/sw.js').catch(function () {});
  });
}
`;

module.exports = { offlineHtml: () => OFFLINE_HTML, swJs: () => SW_JS, swRegisterJs: () => SW_REGISTER_JS };
