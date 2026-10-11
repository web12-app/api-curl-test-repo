# Getting started

This guide runs the app on your own computer. It uses real settings, so you need a GitHub account and two private repositories. If you only want to look at the code or run the tests, skip to [Testing](testing.md), which needs no account and no network.

## What you need

- **Node.js 20 or later.** The workflow uses Node 22. Check with `node --version`.
- **Two private GitHub repositories** under one owner (a user or an organization):
  - a *private data repo* for accounts and manifests, for example `you/private-data`
  - a *storage repo* for file bytes, for example `you/files`, which must be private
- **A GitHub token** with read and write access to *only those two repositories* (contents and releases). A fine-grained token is best. The app refuses to store files if the storage repo is public.

## 1. Get the code and install

```bash
git clone <this repository> app
cd app
npm ci
```

The only runtime dependency is `busboy` (multipart uploads). `npm ci` installs it from the lock file.

## 2. Create a local configuration

Copy the example file. It holds names only, no values:

```bash
cp .env.example .env
```

Edit `.env` and fill in the values. The app reads these variables from the environment. It does **not** load `.env` on its own, so either export them or use a tool such as `node --env-file=.env src/server.js` (Node 20.6 or later). Never commit `.env`; `.gitignore` already excludes it.

Minimum for login and files:

```bash
GITHUB_TOKEN=github_pat_...            # token for the two repos above
PRIVATE_DATA_REPO=you/private-data
SESSION_SECRET=$(openssl rand -hex 32) # at least 32 characters
GITHUB_OWNER=you
GITHUB_STORAGE_REPO=files
COOKIE_SECURE=0                        # plain http on localhost only
```

See [Configuration](configuration.md) for every variable.

## 3. Start the app

```bash
node --env-file=.env src/server.js
# or, with variables already exported:
npm start
```

Open <http://localhost:3000>. If a setting is missing, the server prints its *name* (never its value) and the pages that need it report what is missing:

- `Login is disabled. Missing configuration: ...` means login and files are off. The home page still works.
- `File storage is disabled. Missing configuration: ...` means login works, but the file routes are off.

## 4. Create an account and upload a file

1. Go to **Sign up**, choose a username (3 to 32 letters, digits, or underscores) and a password (8 to 256 characters).
2. You land on the **dashboard**. Drag a file onto the dashboard, or click **Choose files**.
3. The file appears in the list once the upload completes.

Accounts and files you create on your computer live in your own repos. Delete the test account's records by hand if you want a clean start (see [Operations](operations.md#cleaning-up-test-data)).

## 5. Check that it is healthy

```bash
curl -s http://localhost:3000/api/health
# {"status":"ok"}
```

## Next steps

- [User guide](user-guide.md): what every dashboard control does.
- [Configuration](configuration.md): limits you can change and the variables for hosting.
- [Operations](operations.md): run the app publicly through the ngrok workflow.
