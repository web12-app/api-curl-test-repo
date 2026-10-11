'use strict';

const http = require('node:http');

const HOME_HTML = `<!doctype html>
<html lang="en">
  <head><meta charset="utf-8"><title>Node.js app</title></head>
  <body><h1>Hello from Node.js</h1><p>Health check: <a href="/api/health">/api/health</a></p></body>
</html>
`;

function send(res, status, contentType, body) {
  res.writeHead(status, {
    'Content-Type': contentType,
    'Content-Length': Buffer.byteLength(body),
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(body);
}

function createServer() {
  return http.createServer((req, res) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.setHeader('Allow', 'GET, HEAD');
      return send(res, 405, 'application/json', JSON.stringify({ error: 'Method not allowed' }));
    }
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/') {
      return send(res, 200, 'text/html; charset=utf-8', HOME_HTML);
    }
    if (pathname === '/api/health') {
      return send(res, 200, 'application/json', JSON.stringify({ status: 'ok' }));
    }
    return send(res, 404, 'application/json', JSON.stringify({ error: 'Not found' }));
  });
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  createServer().listen(port, '0.0.0.0', () => {
    console.log(`Listening on port ${port}`);
  });
}

module.exports = { createServer };
