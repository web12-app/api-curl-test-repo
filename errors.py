"""Consistent API errors and response envelopes.

Responses never contain stack traces, environment values, tokens, or repository paths.
"""
import secrets

from flask import g, jsonify


class ApiError(Exception):
    def __init__(self, status, code, message):
        super().__init__(message)
        self.status = status
        self.code = code
        self.message = message


def request_id():
    rid = getattr(g, "request_id", None)
    if rid is None:
        rid = secrets.token_hex(8)
        g.request_id = rid
    return rid


def ok(data=None, status=200):
    body = {"success": True, "request_id": request_id()}
    if data is not None:
        body["data"] = data
    return jsonify(body), status


def fail(status, code, message):
    return jsonify({"success": False, "error": {"code": code, "message": message},
                    "request_id": request_id()}), status
