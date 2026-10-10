# api-curl-test-repo

Public file-storage API and UI. **Data is stored in a private repo**
(`PRIVATE_DATA_REPO`) through the GitHub Contents API. No secrets live in this repo.

## Run locally

```bash
pip install -r requirements.txt
export GITHUB_TOKEN=...            # fine-grained, Contents read/write on the private repo only
export PRIVATE_DATA_REPO=web12-app/api-curl-private-data
export API_KEY=...                 # required for upload/delete
python app.py                      # http://127.0.0.1:5000
```

## Endpoints

| Method | Path | Auth | Purpose |
| --- | --- | --- | --- |
| GET | `/` | none | UI |
| GET | `/api/files` | none | list files |
| GET | `/api/files/<name>` | none | download |
| POST | `/api/files` | `X-API-Key` | upload (form field `file`, max 1 MB) |
| DELETE | `/api/files/<name>` | `X-API-Key` | delete |

```bash
curl -H "X-API-Key: $API_KEY" -F "file=@notes.txt" http://127.0.0.1:5000/api/files
curl http://127.0.0.1:5000/api/files
curl -H "X-API-Key: $API_KEY" -X DELETE http://127.0.0.1:5000/api/files/notes.txt
```

## Environment values

See `.env.example`. Set them on the host that runs `app.py`, not in the repo.

## GitHub Pages

`build_static.py` still publishes `/api/hello.json` and `/api/time.json` to Pages. The upload
API needs a server, so it cannot run on Pages.
