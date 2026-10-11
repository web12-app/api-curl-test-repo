# Node.js app

A minimal Node.js web app with no third-party dependencies. It has a home page, signup, login, and a dashboard. Accounts are stored in a private GitHub repository, and passwords are stored only as scrypt hashes.

## Run

Requires Node.js 20 or later.

```bash
npm start            # listens on PORT (default 3000)
PORT=8080 npm start
```

Without login configuration, the public pages and `/api/health` still work. Login and signup routes return `503` and name the missing settings.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/` | GET | Home page (welcome, and login/signup or dashboard links) |
| `/signup`, `/login` | GET | Forms. POST posts a form and redirects to `/dashboard` |
| `/dashboard` | GET | Signed-in page. Redirects to `/login` without a session |
| `/logout` | POST | Clears the session |
| `/api/health` | GET | `{"status":"ok"}` |
| `/api/signup` | POST | JSON `{username, password}`. Returns `201` and sets the session cookie |
| `/api/login` | POST | JSON `{username, password}`. Returns `200` and sets the session cookie |
| `/api/logout` | POST | Clears the session |
| `/api/me` | GET | `{"success":true,"data":{"user":...}}`, with `user` null when signed out |

Usernames are 3–32 characters: letters (case-insensitive, stored in lowercase), digits, and underscores. Passwords are 8–256 characters.

## Configuration

Set these in the environment. Never put values in the repo. See `.env.example`.

| Variable | Required | Purpose |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Token with read/write access to the private data repo only |
| `PRIVATE_DATA_REPO` | yes | `owner/name` of the private data repo |
| `SESSION_SECRET` | yes | At least 32 random characters. Signs session cookies |
| `SESSION_HOURS` | no | Session length, default 12 |
| `COOKIE_SECURE` | no | Set `0` only for plain-http local runs |
| `TRUST_PROXY` | no | Set `1` only behind a proxy that overwrites `X-Forwarded-For` |
| `PORT` | no | Default 3000 |

Generate a session secret with `openssl rand -hex 32`.

### How data is stored

- `system/usernames/<name>.json`: claims a username. It maps to the user id.
- `users/<id>.json`: `{id, username, password_hash, created_at}`. The hash is `scrypt$N$r$p$salt$hash`.

Writes use the GitHub Contents API. Writes are never retried automatically. A conflict returns `409`.

Rate limits are in memory, per process: login 5 failures per account and 30 per address in 15 minutes, signup 10 per address per hour. Each process has its own counts.

## Test

```bash
npm test
```

Tests use Node's built-in test runner (`node --test`), so no install step is needed. They use an in-memory store and a fake GitHub client. No network access is needed.

## Layout

```
package.json              scripts: start, test
.env.example              configuration names (no values)
src/server.js             HTTP routes and entry point
src/config.js             reads and checks environment settings
src/accounts.js           signup, login, user lookup
src/passwords.js          scrypt hashing
src/session.js            signed session cookies
src/rate-limit.js         in-memory limits
src/github-storage.js     GitHub Contents API client (private data repo)
src/memory-storage.js     in-memory store for tests
src/pages.js              HTML templates
test/                     node:test suites
```
