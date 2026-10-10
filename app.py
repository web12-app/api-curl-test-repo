"""Flask app: pages (home, signup, login, dashboard) + file API.

Data (files and user accounts) lives in a PRIVATE repo (see storage.py).

Config (env values, never committed):
  GITHUB_TOKEN, PRIVATE_DATA_REPO, PRIVATE_DATA_PREFIX  -> storage.py
  API_KEY        optional; lets scripts upload/delete with the X-API-Key header
  SECRET_KEY     signs login sessions. If unset, a random key is used (logins reset on restart).
"""
import hmac
import os
import secrets
from datetime import datetime, timezone

from flask import (Flask, jsonify, redirect, render_template, request, Response,
                   session, url_for)
from werkzeug.security import check_password_hash, generate_password_hash

import storage

app = Flask(__name__)
app.secret_key = os.environ.get("SECRET_KEY") or secrets.token_hex(32)


@app.errorhandler(storage.StorageError)
def _storage_error(e):
    if request.path.startswith("/api/"):
        return jsonify(error=str(e)), e.status
    return render_template("error.html", message=str(e), status=e.status), e.status


def _current_user():
    return session.get("user")


def _require_writer():
    """Allow a logged-in user (session) or a script with the X-API-Key header."""
    if _current_user():
        return
    expected = os.environ.get("API_KEY", "").strip()
    given = request.headers.get("X-API-Key", "")
    if expected and hmac.compare_digest(given, expected):
        return
    raise storage.StorageError("Log in first, or send a valid X-API-Key.", 401)


# ---------------------------------------------------------------- pages
@app.get("/")
def home():
    return render_template("home.html", user=_current_user())


@app.route("/signup", methods=["GET", "POST"])
def signup():
    if request.method == "GET":
        return render_template("auth.html", mode="signup", error=None, user=_current_user())
    username = request.form.get("username", "").strip().lower()
    password = request.form.get("password", "")
    if not storage.valid_username(username):
        return render_template("auth.html", mode="signup", user=None,
                               error="Username must be 3-32 lowercase letters, digits, or underscores."), 400
    if len(password) < 8:
        return render_template("auth.html", mode="signup", user=None,
                               error="Password must be at least 8 characters."), 400
    try:
        storage.create_user(username, generate_password_hash(password))
    except storage.StorageError as e:
        return render_template("auth.html", mode="signup", user=None, error=str(e)), e.status
    session.clear()
    session["user"] = username
    return redirect(url_for("dashboard"))


@app.route("/login", methods=["GET", "POST"])
def login():
    if request.method == "GET":
        return render_template("auth.html", mode="login", error=None, user=_current_user())
    username = request.form.get("username", "").strip().lower()
    password = request.form.get("password", "")
    rec = storage.get_user(username)
    if not rec or not check_password_hash(rec["password_hash"], password):
        return render_template("auth.html", mode="login", user=None,
                               error="Wrong username or password."), 401
    session.clear()
    session["user"] = username
    return redirect(url_for("dashboard"))


@app.get("/logout")
def logout():
    session.clear()
    return redirect(url_for("home"))


@app.get("/dashboard")
def dashboard():
    user = _current_user()
    if not user:
        return redirect(url_for("login"))
    return render_template("dashboard.html", user=user)


# ---------------------------------------------------------------- API
@app.get("/api/hello")
def hello():
    return jsonify(message="Hello from Python!", source="api-curl-test-repo")


@app.get("/api/time")
def now():
    return jsonify(utc=datetime.now(timezone.utc).isoformat())


@app.get("/api/me")
def me():
    return jsonify(user=_current_user())


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
    _require_writer()
    f = request.files.get("file")
    if f is None:
        raise storage.StorageError("Send the file in form field 'file'.", 400)
    return jsonify(storage.put_file(f.filename or "", f.read())), 201


@app.delete("/api/files/<name>")
def delete(name):
    _require_writer()
    return jsonify(storage.delete_file(name))


if __name__ == "__main__":
    app.run(host="0.0.0.0", port=int(os.environ.get("PORT", "5000")), debug=False)
