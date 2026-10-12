# File storage app

A Node.js web app with accounts, a personal file dashboard, previews, public share links, and anonymous upload links. Accounts and file metadata live in a private GitHub repository. File bytes live as release assets in a second private repository. Nothing is stored on the server's disk except short-lived temporary uploads.

**Full documentation is in [`docs/`](docs/README.md).**

## Quick start

Requires Node.js 20 or later.

```bash
npm ci
cp .env.example .env        # then fill in the values (names only in the example)
node --env-file=.env src/server.js
```

Open <http://localhost:3000>. The welcome page explains the app with a 3D intro; sign up and you land on your app home page with live stats. Files, uploads, and upload links live under **Explore**. Signed-in users never see the welcome page again until they log out.

The app pages (/home, /explore) are a React app. The compiled bundle ships in `public/assets/app.js`, so `npm start` needs no build step. To change the frontend, edit `client/` and rebuild:

```bash
npm run build:client        # esbuild bundles client/main.jsx into public/assets/app.js
npm run watch:client        # rebuild on every change while developing
```

Without configuration the home page and `/api/health` still work. Login and files report which settings are missing, by name.

## What it does

- Sign up and log in. Passwords are stored only as scrypt hashes.
- Upload any file type, up to 2 GB per file (GitHub's own asset limit). Files of 4 MB and more are sent in pieces automatically, so an interrupted upload resumes instead of restarting. Known types are checked against their content.
- Preview images, PDF, text, video, and audio in the app (image/video/audio render as native `<img>`/`<video>`/`<audio>` elements) or in a new browser tab. Other types download only.
- Share a file with a link that anyone can open. Links can be turned off at any time.
- Create an upload link that lets someone without an account send you a file. Links are limited per link and can be revoked.
- Import a file from any http, https, or data: link. The download runs in the background and survives a page reload.
- Publish videos to **Tube** - a YouTube-style feed, watch pages, and channels, all behind login.
- Chat with a real local GGUF model (Qwen Q2_K via llama.cpp) on the **Chat** page - no external AI API, streamed into the page, cancellable, memory-gated.

## Documentation

| Document | Contents |
| --- | --- |
| [Getting started](docs/getting-started.md) | Run it on your computer |
| [Configuration](docs/configuration.md) | Environment variables, limits, GitHub secrets and variables |
| [User guide](docs/user-guide.md) | Using the dashboard |
| [API reference](docs/api.md) | Every route, codes, headers, and limits |
| [Architecture and security](docs/architecture.md) | Data layout, upload and sharing flows, security controls |
| [Operations](docs/operations.md) | The live-tunnel workflow, run summaries, troubleshooting |
| [Testing](docs/testing.md) | `npm test`, what each test file covers |

## Layout

```
src/server.js           HTTP routes, sessions, CSRF and origin checks, rate limits
src/files.js            file records, uploads, sharing, upload links
src/upload.js           streaming multipart parsing (busboy) with size limits
src/file-types.js       allowed types, content checks, previewable types
src/accounts.js         signup, login, lockout rules
src/session.js          signed session cookies
src/passwords.js        scrypt hashing
src/config.js           environment settings (names are reported, never values)
src/paths.js            the only paths the app writes in the private data repo
src/redact.js           masked names and short references for logs
src/github-storage.js   Contents API client (private data repo)
src/github-releases.js  Releases API client (storage repo)
src/pages.js            HTML pages (welcome, auth, share, upload links) and the React app shells
client/                 React source for /home and /explore (bundled by esbuild)
public/assets/app.js    the compiled React bundle, committed so npm start needs no build
pages/                  static welcome pages (not served by the Node app)
.github/workflows/      live-tunnel.yml: run the app on a GitHub runner with an ngrok domain
test/                   node:test suites and a fake GitHub
docs/                   documentation
```

## Security in one paragraph

Secrets come only from environment variables and are never written to the repository, logs, pages, or browser code. The GitHub token stays on the server. Share and upload-link tokens are random 256-bit values that are looked up by hash. Previews run in a sandbox, and unknown or active types (HTML, SVG) are never shown inline. The repository is public, so logs are masked. See [Architecture and security](docs/architecture.md).

## GGUF Model Runner

Run the real Hugging Face GGUF model `DevQuasar/Qwen.Qwen3.8-27B-GGUF` (Q2_K,
architecture `qwen35`, Apache-2.0) locally on GitHub Actions runners or on
your own worker: validate → download → memory gate → llama.cpp inference with
streaming output and structured results. See `docs/gguf-model-runner.md` and
`docs/model-worker.md`. Workflows: `model-validate.yml`, `model-download.yml`,
`model-build.yml`, `model-inference.yml`, `model-test.yml`.
