# Documentation

This folder documents the file storage app: accounts, a personal file dashboard, previews, share links, and anonymous upload links.

| Document | Read it when you want to |
| --- | --- |
| [Getting started](getting-started.md) | Run the app on your computer and create your first account |
| [Configuration](configuration.md) | Know every environment variable, secret, and repository variable |
| [User guide](user-guide.md) | Use the dashboard: upload, preview, share, upload links, delete |
| [API reference](api.md) | Call the HTTP routes from your own code, with exact codes and limits |
| [Architecture and security](architecture.md) | Understand how files and accounts are stored, and the security rules |
| [Operations](operations.md) | Deploy and run the live tunnel, read the run summary, and handle common problems |
| [Testing](testing.md) | Run the test suite and understand what each check covers |

## One-minute overview

- **Accounts** are stored in a private GitHub repository (the *private data repo*). Passwords are stored only as scrypt hashes.
- **Files** are stored as release assets in a second private GitHub repository (the *storage repo*), one release per upload. Metadata for each user lives in one JSON manifest in the private data repo.
- The Node.js server (no framework, one runtime dependency: `busboy`) serves the pages and the JSON API.
- The **workflow** `live-tunnel` runs the app on a GitHub runner and exposes it through a free Cloudflare Quick Tunnel (a random `trycloudflare.com` URL per run) for a set number of minutes.

## Words used in these docs

| Term | Meaning |
| --- | --- |
| Private data repo | The GitHub repo that holds accounts, manifests, and share indexes. Never public. |
| Storage repo | The GitHub repo that holds file bytes as release assets. Must be private. |
| Manifest | `uploads/<user id>/manifest.json` in the private data repo. The list of one user's files and upload links. |
| Share link | A public URL `/s/<token>` for one file. Anyone with it can read the file. Revocable. |
| Upload link | A public URL `/u/<token>` that lets anyone add one file to the owner's account. Revocable. |
| Previewable | A file type the browser can show inline (images, PDF, text, video, audio). |
