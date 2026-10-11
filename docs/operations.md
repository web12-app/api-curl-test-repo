# Operations

This page covers running the app publicly with the `live-tunnel` workflow, reading its results, and fixing common problems.

## What the workflow does

`.github/workflows/live-tunnel.yml` runs the app on a GitHub-hosted runner and exposes it at a fixed ngrok domain for a set number of minutes.

Each run:

1. Checks the inputs and the three secrets. A missing value fails the run before anything starts.
2. Checks out the code, installs dependencies (`npm ci --ignore-scripts`), and runs `npm test`. **A failing test stops the run before the app starts.**
3. Installs the ngrok agent and checks its SHA-256 against a pinned value. A mismatch stops the run.
4. Starts `node src/server.js` on port 3000 with the secrets and repository variables, and waits for `/api/health` to return `200` locally.
5. Starts the ngrok tunnel, and waits for the public `/api/health` to return `200`. Only then is the service "live".
6. Keeps running for the requested minutes. It checks the app and the tunnel every 15 seconds, and checks the public health every minute. Three failed public checks in a row end the run.
7. Stops the tunnel first (so the domain is released), then the app.
8. Writes a run summary with the public URL and the outcome.

Only one run can use the `live-tunnel` concurrency group at a time, so a second run waits.

## Starting a run

1. Open the repository on GitHub, go to **Actions**, choose **Live app on ngrok**, and click **Run workflow**.
2. Pick the branch. A branch's own copy of the workflow is used for its runs.
3. Set the inputs:

| Input | Range | Meaning |
| --- | --- | --- |
| `minutes` | 1 to 300 (default 60) | How long the tunnel stays open. |
| `auto_restarts` | 0 to 100 (default 24) | How many follow-up runs to request when a run reaches its time limit. |

The public URL is `https://precision-pledge-fled.ngrok-free.dev`, set in the workflow's `NGROK_DOMAIN`.

### The automatic follow-up chain

When a run reaches its time limit and shuts down cleanly, it asks for one more run with the same `minutes` and one fewer `auto_restarts`. The chain stops when `auto_restarts` reaches 0, when a run fails, or when a request fails. The request is made only after the tunnel is released, and is skipped if another run is already queued or running.

> **Important:** the follow-up is always dispatched on **`main`**. A chain started on another branch continues on `main`, which must contain the same workflow. Runs you start by hand on a branch do not chain unless `main` holds the workflow.

The follow-up is confirmed in the run summary: *Requested*, or *Dispatch accepted, but not confirmed* if it could not see the new run within a minute. Check the Actions tab in the second case.

### Stopping early

Cancel the run in the Actions tab. The **Stop processes** step runs even on cancellation, so the tunnel and app are stopped and the domain is released. A cancelled run does not request a follow-up.

## Reading the run summary

Each run writes a summary:

| Item | Meaning |
| --- | --- |
| Public URL | Where the app is reachable while the run is live. |
| Minutes | The requested duration. |
| Automatic restarts left (requested) | The value passed to the next run. |
| Run ended | `true` when the time limit was reached cleanly. `not reached` when the run stopped earlier. |

The **Next run** section says whether a follow-up was requested, and why not if it was not.

## Secrets and variables

| Name | Type | Purpose |
| --- | --- | --- |
| `NGROK_AUTHTOKEN` | secret | ngrok login for the tunnel |
| `PRIVATE_DATA_TOKEN` | secret | GitHub token for the private data repo and storage repo |
| `SESSION_SECRET` | secret | At least 32 characters |
| `FILE_STORAGE_OWNER` | variable | Owner of the storage repo |
| `FILE_STORAGE_REPO` | variable | Name of the storage repo |

Only one ngrok agent can hold the domain at a time. Stop any other tunnel on `precision-pledge-fled.ngrok-free.dev` first, or this run fails with *The ngrok process exited*.

Logs are **public** because the repository is public. The workflow never prints secret values. Its diagnostics step replaces the three secrets with `[REDACTED]` in the app and ngrok logs. The app itself logs only error types and masked data.

## Checking a live deployment

```bash
curl -s https://precision-pledge-fled.ngrok-free.dev/api/health
# {"status":"ok"}
```

A `404` from `/u/<made-up token>` or `/s/<made-up token>` means the new routes are running. Do not use real tokens for these checks.

To check login on a live deployment, create a test account, and remove its records afterwards (see below). Do not leave test accounts behind.

## Updating the ngrok agent

The workflow pins the ngrok agent by SHA-256. A new ngrok release changes the file and fails the install step by design. To update: download the new archive, compute its SHA-256 (`sha256sum ngrok.tgz`), and update `NGROK_SHA256` in the workflow in a reviewed change.

## Cleaning up test data

Test accounts and test files are real data in your repos.

- **Account:** delete `users/<id>.json`, `system/usernames/<name>.json`, and `uploads/<id>/manifest.json` from the private data repo, and any `shares/` or `upload-links/` files that point to them. Use the GitHub UI or the Contents API.
- **Files:** delete the file in the app (**Delete**), or delete the `upload-<fileId>` release and its tag in the storage repo.
- Before deleting releases in the storage repo, check who uploaded them. The storage repo may hold real uploads that were not created by a test.

## Troubleshooting

| Symptom | Likely cause | Fix |
| --- | --- | --- |
| Page says *Login is disabled. Missing configuration: …* | A login variable is missing or too short. | Set the named variable. `SESSION_SECRET` needs 32 characters. |
| Page says *File storage is disabled. Missing configuration: …* | `GITHUB_OWNER` or `GITHUB_STORAGE_REPO` missing, or the storage repo equals the data repo. | Set the variables. The storage repo must differ from the data repo. |
| Run fails at *Check inputs and secrets* | A secret is missing or too short, or an input is out of range. | Set the secret. Keep `minutes` 1 to 300 and `auto_restarts` 0 to 100. |
| Run fails at *Run tests* | A test fails. | Run `npm test` locally and fix it. Nothing was deployed. |
| Run fails at *Start app* | The app did not start: usually missing configuration. | Read the diagnostics step (secrets redacted). |
| Run fails at *Start ngrok tunnel* with *Another agent may still hold …* | Another tunnel or run holds the domain. | Stop the other tunnel, then re-run. |
| Public health check fails three times | The app or tunnel stopped, or the domain is held elsewhere. | Check the run log; re-run when the cause is fixed. |
| Upload returns `503 UPSTREAM_ERROR`, *GitHub is rate limiting requests* | GitHub's API limit was reached. | Wait, then retry. |
| Upload returns `503` *storage repository must be private* | The storage repo is public, or the token cannot read it. | Make it private, and check the token has access. |
| `409 CONFLICT` | Two changes to the same account at the same moment. | Retry the action. |
| `429 TOO_MANY_UPLOADS` | Four uploads are already running. | Wait and retry. |
| `403 CSRF_HEADER_REQUIRED` from a script | Missing `X-Requested-With: fetch`. | Add the header (see [API reference](api.md)). |
| `403 CROSS_SITE_REFUSED` from a script | Request sent with an `Origin` that is not this site. | Send from the app's origin, or omit `Origin` from non-browser clients. |
| Follow-up run never starts | The workflow is not on `main`, or another run was active. | Check the summary and the Actions tab. |
| Preview of a video does not seek | Range requests are not implemented. | Known limit. Download the file to play it fully. |
