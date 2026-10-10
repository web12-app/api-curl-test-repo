# api-curl-test-repo

A small Python (Flask) API. GitHub Pages can't run Python, so a GitHub Actions
workflow renders the API to static JSON and publishes it to Pages.

## Endpoints

| Path (on Pages)        | Source route  |
|------------------------|---------------|
| `/api/hello.json`      | `/api/hello`  |
| `/api/time.json`       | `/api/time`   |
| `/api/index.json`      | list of files |

Live site: https://web12-app.github.io/api-curl-test-repo/api/hello.json

## Run locally

```bash
pip install -r requirements.txt
python app.py          # http://127.0.0.1:5000/api/hello
python build_static.py # writes _site/api/*.json
```
