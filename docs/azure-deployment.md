# Azure Web App deployment

This repository deploys to an Azure App Service Web App (Linux, Node.js 22 LTS) with `.github/workflows/azure-webapp-deploy.yml`.

## What the workflow does

- Runs on every push to `main`, and on manual runs (**Actions > Build, test, and deploy to Azure Web App > Run workflow**).
- **Build job** (pushes to `main`, and manual runs from any branch): checks required files, runs `npm ci`, parses every source file, runs any `build` script if one exists, and runs `npm test`. It then assembles a package with only `package.json`, `package-lock.json`, and `src/`. Tests, `pages/`, docs, and any `.env` file are excluded.
- **Deploy job** (`main` only, after the build job passes): checks the configuration, deploys the package with `azure/webapps-deploy@v3`, calls `/api/health` until it returns 200, and writes a summary to the run page.
- If the build or tests fail, nothing is deployed.

## What you must supply

These values are not in the repository, and this document does not invent them.

| Item | Where | Example form | Notes |
| --- | --- | --- | --- |
| Web App name | Repository **variable** `AZURE_WEBAPP_NAME` | `my-app-name` | Letters, digits, hyphens. Not a secret. |
| Publish profile | Repository **secret** `AZURE_WEBAPP_PUBLISH_PROFILE` | full XML from Azure | Treat as a credential. Rotate it if exposed. |
| Approval gate (optional) | **Environment** `production` | required reviewers | Created by the workflow on first deploy. Add reviewers under Settings > Environments. |

Set them under **Settings > Secrets and variables > Actions**.

## Create the Azure resources

Use your own names. The commands below use placeholders.

```bash
az group create --name <resource-group> --location <location>
az appservice plan create --name <plan-name> --resource-group <resource-group> --is-linux --sku <sku>
az webapp create --name <app-name> --resource-group <resource-group> --plan <plan-name> --runtime "NODE|22-lts"
```

## App settings (set in Azure, never in the repository)

Set these under **Web App > Settings > Environment variables** (or with `az webapp config appsettings set`).

| Setting | Required | Value |
| --- | --- | --- |
| `GITHUB_TOKEN` | yes | Token with read/write access to the private data repository only |
| `PRIVATE_DATA_REPO` | yes | `owner/name` of the private data repository |
| `SESSION_SECRET` | yes | At least 32 random characters. Generate with `openssl rand -hex 32` |
| `SESSION_HOURS` | no | Session length in hours. Default 12 |
| `TRUST_PROXY` | recommended on Azure | `1`. See the note below |
| `WEBSITE_WEBDEPLOY_USE_SCM` | yes | `true`. Set this **before** downloading the publish profile |

Do not set `WEBSITE_RUN_FROM_PACKAGE`. Do not set `SCM_DO_BUILD_DURING_DEPLOYMENT`: the app has no runtime dependencies, so no build is needed on Azure.

**Proxy note:** App Service puts a proxy in front of the app. Without `TRUST_PROXY=1`, the app sees the proxy's address for every visitor, so the per-address signup and login limits apply to all users together. Set `TRUST_PROXY=1` after confirming in the log stream that `X-Forwarded-For` reaches the app. I have not verified this on Azure.

**Startup:** On a Node.js Linux app, App Service runs `npm start`, which is `node src/server.js`. No startup command should be needed. If the app does not start, set the startup command to `npm start` under **Configuration > General settings**.

**Port:** The app listens on `PORT` (default 3000). If the health check times out, check the log stream for the port the app bound to, and set `WEBSITES_PORT` to match. I have not verified the port App Service assigns.

## Create the publish profile secret

1. In the Azure portal, open the Web App, then **Overview > Get publish profile**. Download the XML file.
2. In GitHub, create the repository secret `AZURE_WEBAPP_PUBLISH_PROFILE` with the full XML contents.
3. Add the repository variable `AZURE_WEBAPP_NAME` with the Web App name.
4. Run the workflow manually, or push to `main`.

Do not paste the publish profile into issues, commits, chat, or logs. The workflow checks that the secret is present and looks like a publish profile, and prints only the app name.

## Verify a deployment

- The run's **summary** shows the app name, commit, deploy and health results, and the Web App URL.
- The health endpoint is `GET <app-url>/api/health`, which returns `{"status":"ok"}`.
- Signup and login work only when the three required app settings are set. Without them, `/api/signup` and `/api/login` return `503` and name the missing settings. The names are shown, never the values.

## Troubleshooting

| Symptom | Likely cause |
| --- | --- |
| Workflow fails "AZURE_WEBAPP_NAME is not set" | Add the repository variable |
| Workflow fails "publish profile ... does not look like" | The secret is not the full XML, or it was truncated |
| Health check times out | The app did not start: check the log stream, the startup command, and `PORT`/`WEBSITES_PORT` |
| Health check returns 503 from `/api/signup` | A required app setting is missing |
| Signup or login returns 503 `UPSTREAM_ERROR` | The token cannot reach the private data repository |
| Every user shares one rate-limit bucket | `TRUST_PROXY` is not set |

## Rotating secrets

Rotate the publish profile in the portal and update the GitHub secret. Rotate `GITHUB_TOKEN` and `SESSION_SECRET` in the Web App settings. Changing `SESSION_SECRET` signs out all users.
