"""Small Flask API. Routes are also exported as static JSON for GitHub Pages."""
from datetime import datetime, timezone

from flask import Flask, jsonify

app = Flask(__name__)


@app.get("/api/hello")
def hello():
    return jsonify(message="Hello from Python!", source="api-curl-test-repo")


@app.get("/api/time")
def now():
    return jsonify(utc=datetime.now(timezone.utc).isoformat())


if __name__ == "__main__":
    # Local dev: python app.py -> http://127.0.0.1:5000/api/hello
    app.run(host="0.0.0.0", port=5000, debug=True)
