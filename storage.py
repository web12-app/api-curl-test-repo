"""Private file storage backed by a PRIVATE GitHub repo, via the GitHub Contents API.

The public app never stores data itself. All config comes from env values:
  GITHUB_TOKEN          token with contents write access to the private repo (server-only)
  PRIVATE_DATA_REPO     owner/name of the private repo, e.g. web12-app/api-curl-private-data
  PRIVATE_DATA_PREFIX   folder inside that repo for files (default "files/")
"""
import base64
import os
import re

import requests

API = "https://api.github.com"
NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,119}$")
MAX_BYTES = int(os.environ.get("MAX_UPLOAD_BYTES", "1000000"))  # Contents API GET limit is ~1 MB


class StorageError(Exception):
    def __init__(self, message, status=500):
        super().__init__(message)
        self.status = status


def _cfg():
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    repo = os.environ.get("PRIVATE_DATA_REPO", "").strip()
    prefix = os.environ.get("PRIVATE_DATA_PREFIX", "files/").strip().strip("/")
    if not token or not repo:
        raise StorageError("Storage is not configured (GITHUB_TOKEN / PRIVATE_DATA_REPO).", 503)
    return token, repo, prefix


def _headers(token):
    return {"Authorization": f"Bearer {token}", "Accept": "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28"}


def valid_name(name: str) -> bool:
    return bool(NAME_RE.match(name or ""))


def _path(prefix, name):
    if not valid_name(name):
        raise StorageError("Invalid file name.", 400)
    return f"{prefix}/{name}" if prefix else name


def _check(r, ok=(200,)):
    if r.status_code == 404:
        raise StorageError("File not found.", 404)
    if r.status_code not in ok:
        raise StorageError(f"GitHub returned {r.status_code}.", 502)
    return r.json() if r.content else {}


def list_files():
    token, repo, prefix = _cfg()
    r = requests.get(f"{API}/repos/{repo}/contents/{prefix}", headers=_headers(token), timeout=20)
    if r.status_code == 404:
        return []  # folder doesn't exist yet
    items = _check(r)
    return [{"name": i["name"], "size": i["size"], "sha": i["sha"]}
            for i in items if i.get("type") == "file"]


def get_file(name: str):
    token, repo, prefix = _cfg()
    r = requests.get(f"{API}/repos/{repo}/contents/{_path(prefix, name)}",
                     headers=_headers(token), timeout=20)
    d = _check(r)
    data = base64.b64decode(d.get("content", ""))
    return name, data


def put_file(name: str, data: bytes):
    if len(data) > MAX_BYTES:
        raise StorageError(f"File too large (max {MAX_BYTES} bytes).", 413)
    token, repo, prefix = _cfg()
    path = _path(prefix, name)
    body = {"message": f"upload {name}", "content": base64.b64encode(data).decode()}
    # If the file exists, the Contents API needs its sha to overwrite it.
    cur = requests.get(f"{API}/repos/{repo}/contents/{path}", headers=_headers(token), timeout=20)
    if cur.status_code == 200:
        body["sha"] = cur.json()["sha"]
    r = requests.put(f"{API}/repos/{repo}/contents/{path}", headers=_headers(token),
                     json=body, timeout=30)
    _check(r, ok=(200, 201))
    return {"name": name, "size": len(data), "replaced": cur.status_code == 200}


def delete_file(name: str):
    token, repo, prefix = _cfg()
    path = _path(prefix, name)
    cur = requests.get(f"{API}/repos/{repo}/contents/{path}", headers=_headers(token), timeout=20)
    d = _check(cur)
    r = requests.delete(f"{API}/repos/{repo}/contents/{path}", headers=_headers(token),
                        json={"message": f"delete {name}", "sha": d["sha"]}, timeout=20)
    _check(r, ok=(200,))
    return {"deleted": name}
