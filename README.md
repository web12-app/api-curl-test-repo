# Node.js app

A minimal Node.js web app with no third-party dependencies.

## Run

Requires Node.js 20 or later.

```bash
npm start            # listens on PORT (default 3000)
PORT=8080 npm start
```

- `GET /` returns a home page.
- `GET /api/health` returns `{"status":"ok"}`.

## Test

```bash
npm test
```

Tests use Node's built-in test runner (`node --test`), so no install step is needed.

## Layout

```
package.json        scripts: start, test
src/server.js       HTTP server (createServer) and entry point
test/server.test.js tests for each route
```
