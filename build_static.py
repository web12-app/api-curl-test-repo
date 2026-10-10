"""Build step for GitHub Pages: renders the Flask API routes to static JSON files.

GitHub Pages cannot run Python at request time, so the API is generated at
build time into _site/api/*.json (served at /api/<name>.json on Pages).
"""
import json
import os
import shutil
from pathlib import Path

from app import app

SITE = Path("_site")

# Flask route -> static file written under _site/
ROUTES = {
    "/api/hello": "api/hello.json",
    "/api/time": "api/time.json",
}


def main() -> None:
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    client = app.test_client()
    for route, target in ROUTES.items():
        resp = client.get(route)
        if resp.status_code != 200:
            raise SystemExit(f"{route} returned {resp.status_code}")
        out = SITE / target
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_bytes(resp.get_data())
        print(f"wrote {out} ({len(resp.get_data())} bytes)")

    # Index of available endpoints, so /api/ isn't empty on Pages.
    index = SITE / "api" / "index.json"
    index.write_text(json.dumps({"endpoints": sorted(ROUTES.values())}, indent=2) + "\n")
    print(f"wrote {index}")

    # Home page. APP_URL (e.g. the public URL of the Flask app) is injected at build time.
    app_url = os.environ.get("APP_URL", "").strip().rstrip("/")
    # Pages routes: pages/index.html -> /, pages/<name>/index.html -> /<name>/
    for src in sorted(Path("pages").rglob("index.html")):
        rel = src.parent.relative_to("pages")
        out = SITE / rel / "index.html"
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(src.read_text().replace("__APP_URL__", app_url))
        print(f"wrote {out} (APP_URL {'set' if app_url else 'not set'})")

    # Stop GitHub from running Jekyll over the output.
    (SITE / ".nojekyll").touch()


if __name__ == "__main__":
    main()
