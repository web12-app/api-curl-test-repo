"""Backend configuration. Read from the hosting environment only.

Secret values are never printed. Errors name the missing variables, not their values.
"""
import os
import re
from dataclasses import dataclass, field

REPO_RE = re.compile(r"^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})/[A-Za-z0-9._-]{1,100}$")

REQUIRED = ("SECRET_KEY", "API_KEY_HASH_SECRET", "GITHUB_TOKEN", "PRIVATE_DATA_REPO")


class ConfigError(RuntimeError):
    """Raised at startup when configuration is missing or invalid."""


@dataclass(frozen=True)
class Config:
    secret_key: str
    api_key_hash_secret: str
    github_token: str = field(repr=False)
    private_data_repo: str
    cors_allowed_origins: tuple = ()
    session_hours: int = 12
    cookie_secure: bool = True
    cookie_samesite: str = "Lax"
    max_record_bytes: int = 64 * 1024
    max_file_bytes: int = 1_000_000  # GitHub Contents API returns no content for files over 1 MB
    max_request_bytes: int = 2 * 1024 * 1024
    testing: bool = False


def load_config(env=None, testing=False):
    env = os.environ if env is None else env
    missing = [k for k in REQUIRED if not (env.get(k) or "").strip()]
    if missing and not testing:
        raise ConfigError("Missing required configuration: " + ", ".join(missing))

    repo = (env.get("PRIVATE_DATA_REPO") or "").strip()
    if repo and not REPO_RE.match(repo):
        raise ConfigError("PRIVATE_DATA_REPO must look like owner/name.")

    origins = tuple(o.strip().rstrip("/") for o in (env.get("CORS_ALLOWED_ORIGINS") or "").split(",") if o.strip())
    for o in origins:
        if not (o.startswith("https://") or o.startswith("http://localhost") or o.startswith("http://127.0.0.1")):
            raise ConfigError("CORS_ALLOWED_ORIGINS entries must be https origins (or localhost for development).")
    if any(o == "*" for o in origins):
        raise ConfigError("Wildcard CORS origins are not allowed.")

    samesite = (env.get("COOKIE_SAMESITE") or "Lax").strip()
    if samesite not in ("Lax", "Strict", "None"):
        raise ConfigError("COOKIE_SAMESITE must be Lax, Strict, or None.")

    return Config(
        secret_key=env.get("SECRET_KEY", "") if not testing else (env.get("SECRET_KEY") or "test-secret-key-not-for-production"),
        api_key_hash_secret=env.get("API_KEY_HASH_SECRET", "") if not testing else (env.get("API_KEY_HASH_SECRET") or "test-hash-secret"),
        github_token=env.get("GITHUB_TOKEN", "") if not testing else (env.get("GITHUB_TOKEN") or "test-token"),
        private_data_repo=repo or "owner/test-repo",
        cors_allowed_origins=origins,
        session_hours=int(env.get("SESSION_HOURS", "12")),
        cookie_secure=(env.get("COOKIE_SECURE", "1") != "0") and not testing,
        cookie_samesite=samesite,
        max_record_bytes=int(env.get("MAX_RECORD_BYTES", str(64 * 1024))),
        max_file_bytes=min(int(env.get("MAX_FILE_BYTES", "1000000")), 1_000_000),
        testing=testing,
    )
