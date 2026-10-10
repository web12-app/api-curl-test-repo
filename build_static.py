"""Build step for GitHub Pages: renders the Flask API routes to static JSON files.

GitHub Pages cannot run Python at request time, so the API is generated at
build time into _site/api/*.json (served at /api/<name>.json on Pages).
"""
import json
import os
import shutil
from pathlib import Path

from datetime import datetime, timezone

# The build does not import the app: CI has no runtime secrets, and Pages only needs these
# public, non-secret payloads. Keep these in sync with /api/hello and /api/time in app.py.
SITE = Path("_site")

STATIC_API = {
    "api/hello.json": {"message": "Hello from Python!", "source": "api-curl-test-repo"},
    "api/time.json": {"utc": None},  # filled in at build time
}


def main() -> None:
    if SITE.exists():
        shutil.rmtree(SITE)
    SITE.mkdir(parents=True)

    STATIC_API["api/time.json"]["utc"] = datetime.now(timezone.utc).isoformat()
    for target, payload in STATIC_API.items():
        out = SITE / target
        out.parent.mkdir(parents=True, exist_ok=True)
        out.write_text(json.dumps(payload) + "\n")
        print(f"wrote {out}")

    # Index of available endpoints, so /api/ isn't empty on Pages.
    index = SITE / "api" / "index.json"
    index.write_text(json.dumps({"endpoints": sorted(STATIC_API)}, indent=2) + "\n")
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
