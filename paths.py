"""Validated identifiers and repository path builders.

Clients never supply repository paths. Every path is built here from IDs that passed validation.
"""
import re
import secrets

from errors import ApiError

APP_ID_RE = re.compile(r"^[a-z][a-z0-9-]{2,39}$")
USER_ID_RE = re.compile(r"^[a-f0-9]{24}$")
ID_RE = re.compile(r"^[a-f0-9]{24}$")          # record / file / key ids (server generated)
COLLECTION_RE = re.compile(r"^[a-z][a-z0-9_-]{0,47}$")
USERNAME_RE = re.compile(r"^[a-z0-9_]{3,32}$")
FILENAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._ -]{0,119}$")


def new_id() -> str:
    return secrets.token_hex(12)


def check(value, pattern, code="INVALID_ID", message="Invalid identifier."):
    if not isinstance(value, str) or not pattern.match(value):
        raise ApiError(400, code, message)
    return value


def app_id(v):
    return check(v, APP_ID_RE, "INVALID_APP_ID", "Invalid app id.")


def user_id(v):
    return check(v, USER_ID_RE, "INVALID_USER_ID", "Invalid user id.")


def record_id(v):
    return check(v, ID_RE, "INVALID_RECORD_ID", "Invalid record id.")


def file_id(v):
    return check(v, ID_RE, "INVALID_FILE_ID", "Invalid file id.")


def collection(v):
    return check(v, COLLECTION_RE, "INVALID_COLLECTION", "Invalid collection name.")


def username(v):
    return check(v, USERNAME_RE, "INVALID_USERNAME", "Username must be 3-32 lowercase letters, digits, or underscores.")


def safe_filename(raw: str) -> str:
    """Reduce a client-supplied filename to a safe display name. The stored path never uses it."""
    base = (raw or "").replace("\\", "/").split("/")[-1].strip()
    if not base or not FILENAME_RE.match(base):
        base = "file"
    return base[:120]


# ---------------------------------------------------------------- repository paths
def user_path(uid):
    return f"users/{user_id(uid)}.json"


def username_index_path(name):
    return f"system/usernames/{username(name)}.json"


def owner_index_path(uid, aid):
    return f"system/owners/{user_id(uid)}/{app_id(aid)}.json"


def owner_index_dir(uid):
    return f"system/owners/{user_id(uid)}"


def app_meta_path(aid):
    return f"apps/{app_id(aid)}/metadata.json"


def key_path(aid, kid):
    return f"apps/{app_id(aid)}/api_keys/{record_id(kid)}.json"


def key_dir(aid):
    return f"apps/{app_id(aid)}/api_keys"


def record_dir(aid, coll):
    return f"apps/{app_id(aid)}/database/collections/{collection(coll)}"


def record_path(aid, coll, rid):
    return f"{record_dir(aid, coll)}/{record_id(rid)}.json"


def file_meta_path(aid, fid):
    return f"apps/{app_id(aid)}/files/meta/{file_id(fid)}.json"


def file_meta_dir(aid):
    return f"apps/{app_id(aid)}/files/meta"


def file_blob_path(aid, fid):
    return f"apps/{app_id(aid)}/files/blobs/{file_id(fid)}.bin"
