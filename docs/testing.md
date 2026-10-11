# Testing

## Run the tests

```bash
npm test
```

This runs every `test/*.test.js` file with Node's built-in test runner. It needs no account, no network, and no real GitHub token. At the time of writing it runs 131 tests in about 10 seconds.

Run one file:

```bash
node --test test/files.test.js
```

Run tests whose name matches:

```bash
node --test --test-name-pattern="share" test/files.test.js
```

## What is tested, and where

| File | Covers |
| --- | --- |
| `test/files.test.js` | End-to-end: signup and login, upload, storage, download, delete, isolation between users, limits, GitHub failures, sharing, previews, upload links, revoke, multiple uploaders, chunked-upload limits, masked logs, rate limits. |
| `test/file-types.test.js` | Extensions, signatures, text checks, previewable types, filename cleaning. |
| `test/file-config.test.js` | Storage configuration: missing values, bad names, storage equal to data repo. |
| `test/accounts.test.js` | Signup, login, username and password rules, rate limits. |
| `test/session.test.js` | Session signing, expiry, tampering, cookie flags. |
| `test/passwords.test.js` | scrypt hashing and verification. |
| `test/cors.test.js` | CORS allowlist, preflight, no wildcard with credentials. |
| `test/login-form-origin.test.js` | Form posts: same-origin accepted, cross-site refused. |
| `test/server.test.js` | Pages, health, routing, error responses. |
| `test/github-storage.test.js` | Contents API client: reads, conflicts, path allowlist. |
| `test/helpers.js` | Shared test helpers (sessions). |
| `test/fake-github.js` | An in-process fake of the GitHub Contents and Releases APIs. Tests use it instead of GitHub. |

### How the tests talk to GitHub

The fake GitHub (`test/fake-github.js`) is a real HTTP server. The app's real clients connect to it, so the request and response handling is exercised. It also records the assets it stores, so tests can check what reached "GitHub" and what did not. A test can read the fake's manifest to confirm, for example, that the uploader's address is never stored.

## Checks outside the repository

These are useful before a release. They are not in this repository yet, so they must be run from a separate copy.

- **Browser check.** Headless Chromium drives the dashboard against the app and the fake GitHub: signup, uploads of several types, refusals, drag and drop, filters, preview dialog, sharing and un-sharing, delete, the 375 px layout, upload-link creation, a guest upload with no login, revocation, and logout. It reported 34 of 34 passing, and it allows one expected 415 message in the console.
- **Live check.** Runs against real GitHub with a child-process server. It signs up a throwaway account, uploads two files and a link upload, downloads, restarts the server, deletes, revokes, and removes its own records and releases. It must never delete releases it did not create. It reported 24 of 24 passing.

## Writing a new test

- Put file behavior in `test/files.test.js` using `withApp` (a fresh server per test, with optional `limits`) and `signup`.
- Upload with the `upload` helper, or `uploadViaLink` for anonymous uploads.
- For limits, pass small values through `limits` (for example `{ maxFileBytes: 1000 }`) instead of creating large files.
- Never use a real token or repository in a test. Use the fake, and the names in the existing tests.
- To check logs, capture `console.log` and assert on the text (see the masked-log test). Assert that secrets do not appear.

## Before you push

1. `npm test` passes.
2. `git diff` contains no tokens, session secrets, `.env`, or real data.
3. Documentation matches any change to routes, limits, or variables (see `docs/`).
