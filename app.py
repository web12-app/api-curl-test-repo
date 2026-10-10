"""Flask app: public UI + API. Data is stored in a PRIVATE repo (see storage.py).

Config (env values, never committed):
  GITHUB_TOKEN, PRIVATE_DATA_REPO, PRIVATE_DATA_PREFIX  -> see storage.py
  API_KEY   required for upload/delete. If unset, writes are disabled.
"""
import hmac
import os
from datetime import datetime, timezone

from flask import Flask, jsonify, request, send_from_directory, Response

import storage

app = Flask(__name__, static_folder="static", static_url_path="/static")


@app.errorhandler(storage.StorageError)
def _storage_error(e):
    return jsonify(error=str(e)), e.status


def _require_write_key():
    expected = os.environ.get("API_KEY", "").strip()
    if not expected:
        raise storage.StorageError("Writes are disabled: API_KEY is not set.", 403)
    given = request.headers.get("X-API-Key", "")
    if not hmac.compare_digest(given, expected):
        raise storage.StorageError("Invalid or missing X-API-Key.", 401)


@app.get("/")
def index():
    return send_from_directory("static", "index.html")


@app.get("/api/hello")
def hello():
    return jsonify(message="Hello from Python!", source="api-curl-test-repo")


@app.get("/api/time")
def now():
    return jsonify(utc=datetime.now(timezone.utc).isoformat())


@app.get("/api/files")
def list_files():
    return jsonify(files=storage.list_files())


@app.get("/api/files/<name>")
def download(name):
    name, data = storage.get_file(name)
    return Response(data, mimetype="application/octet-stream",
                    headers={"Content-Disposition": f'attachment; filename="{name}"'})


@app.post("/api/files")
def upload():
    _require_write_key()
    f = request.files.get("file")
    if f is None:
        raise storage.StorageError("Send the file in form field 'file'.", 400)
    result = storage.put_file(f.filename or "", f.read())
    return jsonify(result), 201


@app.delete("/api/files/<name>")
def delete(name):
    _require_write_key()
    return jsonify(storage.delete_file(name))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
