"""Storage engine. All private data goes through this module.

Two implementations share one interface:
  GitHubStorage  - GitHub Contents API against the PRIVATE data repo (production)
  MemoryStorage  - in-process dict with the same concurrency rules (tests, local dev)

Concurrency model (GitHub Contents API):
  * Every update must send the current blob SHA. A stale SHA is rejected by GitHub, which we
    surface as Conflict (409). This prevents silent lost updates for a single file.
  * There are NO multi-file transactions. Writes to several paths are separate commits.
  * Reads are retried a bounded number of times on transient errors. Writes are never retried
    automatically, because a retried write could overwrite a newer change.

Limits (documented in README): file content over ~1 MB is not returned by the Contents API, and
directory listings are capped at 1,000 entries.
"""
import base64
import hashlib
import json
import threading
import time

import requests

GITHUB_API = "https://api.github.com"


class StorageError(Exception):
    status = 500
    code = "INTERNAL_ERROR"

    def __init__(self, message=None, status=None, code=None):
        super().__init__(message or "Internal error.")
        if status:
            self.status = status
        if code:
            self.code = code


class NotFound(StorageError):
    status, code = 404, "NOT_FOUND"


class Conflict(StorageError):
    status, code = 409, "CONFLICT"


class TooLarge(StorageError):
    status, code = 413, "PAYLOAD_TOO_LARGE"


class Upstream(StorageError):
    status, code = 502, "UPSTREAM_ERROR"


class Busy(StorageError):
    status, code = 429, "STORAGE_RATE_LIMITED"


def _sha_of(data: bytes) -> str:
    return hashlib.sha1(b"blob %d\0" % len(data) + data).hexdigest()


class GitHubStorage:
    def __init__(self, token: str, repo: str, timeout: float = 15.0, read_retries: int = 2):
        self._token = token
        self._repo = repo
        self._timeout = timeout
        self._read_retries = read_retries

    # ------------------------------------------------------------ helpers
    def _headers(self):
        return {"Authorization": f"Bearer {self._token}",
                "Accept": "application/vnd.github+json",
                "X-GitHub-Api-Version": "2022-11-28"}

    def _url(self, path):
        return f"{GITHUB_API}/repos/{self._repo}/contents/{path}"

    def _request(self, method, url, *, retry=False, **kw):
        attempts = (self._read_retries + 1) if retry else 1
        last = None
        for i in range(attempts):
            try:
                r = requests.request(method, url, headers=self._headers(), timeout=self._timeout, **kw)
            except requests.RequestException:
                last = Upstream("Storage is unreachable.")
            else:
                if r.status_code in (403, 429) and r.headers.get("x-ratelimit-remaining") == "0":
                    raise Busy("Storage rate limit reached. Try again later.")
                if r.status_code == 429:
                    raise Busy("Storage rate limit reached. Try again later.")
                if r.status_code >= 500 and retry:
                    last = Upstream("Storage is temporarily unavailable.")
                else:
                    return r
            if i < attempts - 1:
                time.sleep(0.5 * (2 ** i))
        raise last or Upstream("Storage is temporarily unavailable.")

    # ------------------------------------------------------------ operations
    def check(self):
        """Verify the token can read the private repo. Returns True or raises."""
        r = self._request("GET", f"{GITHUB_API}/repos/{self._repo}", retry=True)
        if r.status_code != 200:
            raise Upstream("Private data repository is not accessible.")
        return True

    def read(self, path):
        """Return (bytes, sha) or None when the path does not exist."""
        r = self._request("GET", self._url(path), retry=True)
        if r.status_code == 404:
            return None
        if r.status_code != 200:
            raise Upstream("Storage read failed.")
        d = r.json()
        if d.get("type") != "file":
            raise NotFound()
        if d.get("encoding") not in ("base64", None) or (d.get("size", 0) > 0 and not d.get("content")):
            raise TooLarge("Stored content is too large to read through the storage API.")
        return base64.b64decode(d.get("content") or ""), d["sha"]

    def list(self, path):
        """Return [{'name','type','sha'}] for a directory; [] when it does not exist."""
        r = self._request("GET", self._url(path), retry=True)
        if r.status_code == 404:
            return []
        if r.status_code != 200:
            raise Upstream("Storage listing failed.")
        items = r.json()
        if not isinstance(items, list):
            return []
        return [{"name": i["name"], "type": i["type"], "sha": i["sha"]} for i in items]

    def write(self, path, data: bytes, message: str, sha: str = None):
        """Create (sha=None) or update (sha=current blob sha). Returns the new blob sha.

        Creating an existing path, or updating with a stale sha, both raise Conflict.
        Not retried automatically.
        """
        body = {"message": message, "content": base64.b64encode(data).decode()}
        if sha:
            body["sha"] = sha
        r = self._request("PUT", self._url(path), json=body)
        if r.status_code in (200, 201):
            return r.json()["content"]["sha"]
        if r.status_code in (409, 422):
            raise Conflict("The record was changed by another request. Reload and try again.")
        if r.status_code == 404:
            raise NotFound()
        raise Upstream("Storage write failed.")

    def delete(self, path, sha: str, message: str):
        r = self._request("DELETE", self._url(path), json={"message": message, "sha": sha})
        if r.status_code == 200:
            return True
        if r.status_code in (409, 422):
            raise Conflict("The record was changed by another request. Reload and try again.")
        if r.status_code == 404:
            raise NotFound()
        raise Upstream("Storage delete failed.")


class MemoryStorage:
    """Same semantics as GitHubStorage, kept in memory. Not for production."""

    def __init__(self):
        self._files = {}  # path -> (bytes, sha)
        self._lock = threading.Lock()
        self.fail_next_write = None  # set to a StorageError instance to simulate failures

    def check(self):
        return True

    def read(self, path):
        with self._lock:
            got = self._files.get(path)
            return None if got is None else (got[0], got[1])

    def list(self, path):
        prefix = path.rstrip("/") + "/"
        with self._lock:
            names = {}
            for p, (data, sha) in self._files.items():
                if p.startswith(prefix):
                    rest = p[len(prefix):]
                    if "/" in rest:
                        continue
                    names[rest] = {"name": rest, "type": "file", "sha": sha}
            return sorted(names.values(), key=lambda x: x["name"])

    def write(self, path, data: bytes, message: str, sha: str = None):
        with self._lock:
            if self.fail_next_write is not None:
                err, self.fail_next_write = self.fail_next_write, None
                raise err
            current = self._files.get(path)
            if sha is None and current is not None:
                raise Conflict("The record was changed by another request. Reload and try again.")
            if sha is not None and (current is None or current[1] != sha):
                raise Conflict("The record was changed by another request. Reload and try again.")
            new_sha = _sha_of(data)
            self._files[path] = (bytes(data), new_sha)
            return new_sha

    def delete(self, path, sha: str, message: str):
        with self._lock:
            current = self._files.get(path)
            if current is None:
                raise NotFound()
            if current[1] != sha:
                raise Conflict("The record was changed by another request. Reload and try again.")
            del self._files[path]
            return True


def json_bytes(obj) -> bytes:
    return json.dumps(obj, separators=(",", ":"), sort_keys=True).encode()
