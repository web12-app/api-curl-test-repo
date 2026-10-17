#!/usr/bin/env python3
"""Save a live run's public URL to the repo, through the GitHub API only.

- live-url.json on the `live-url` branch (overwritten each run; git keeps the history).
- A pre-release tagged live-<run id> at the run's commit, with live-url.json attached.

Environment (the live-tunnel workflow sets the GITHUB_* values):
  PUBLIC_URL          the run's https origin (required)
  GITHUB_REPOSITORY   owner/repo (required)
  GITHUB_RUN_ID       run id (required)
  GITHUB_SHA          40-character commit (required)
  GH_TOKEN            token with contents: write (required unless --dry-run)
  GITHUB_EVENT_NAME   optional, recorded in the file
  RUN_STATUS          optional, default in_progress (the backfill sets the run's real status)
  LIVE_URL_BRANCH     default live-url
  GITHUB_API_URL      default https://api.github.com
  GITHUB_UPLOADS_URL  default https://uploads.github.com
  GITHUB_SERVER_URL   default https://github.com

Flags: --dry-run prints the JSON and calls nothing.
Exit codes: 0 saved (or already saved), 1 API failure, 2 bad input. The token is never printed.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone

ORIGIN_RE = re.compile(r'https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]+)?')
REPO_RE = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')
BRANCH_RE = re.compile(r'[A-Za-z0-9._/-]+')
SHA_RE = re.compile(r'[0-9a-f]{40}')
FILE = 'live-url.json'


class ApiError(Exception):
    def __init__(self, status, what):
        super().__init__(f'{what} returned HTTP {status}')
        self.status = status


def build_payload(env, now=None):
    url = env.get('PUBLIC_URL', '').strip().rstrip('/')
    if not ORIGIN_RE.fullmatch(url):
        raise ValueError('PUBLIC_URL must be a bare https origin')
    repo = env.get('GITHUB_REPOSITORY', '')
    if not REPO_RE.fullmatch(repo):
        raise ValueError('GITHUB_REPOSITORY must look like owner/repo')
    run_id = env.get('GITHUB_RUN_ID', '')
    if not run_id.isdigit():
        raise ValueError('GITHUB_RUN_ID must be a number')
    sha = env.get('GITHUB_SHA', '')
    if not SHA_RE.fullmatch(sha):
        raise ValueError('GITHUB_SHA must be a 40-character commit')
    server = env.get('GITHUB_SERVER_URL', 'https://github.com').rstrip('/')
    ts = (now or datetime.now(timezone.utc)).strftime('%Y-%m-%dT%H:%M:%SZ')
    return {
        'url': url,
        'run_id': int(run_id),
        'run_url': f'{server}/{repo}/actions/runs/{run_id}',
        'commit': sha,
        'repository': repo,
        'event': env.get('GITHUB_EVENT_NAME', ''),
        'run_status': env.get('RUN_STATUS', 'in_progress'),
        'published_at': ts,
        'tag': f'live-{run_id}',
    }


def call(method, url, token, body=None, data=None, content_type=None):
    headers = {
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'User-Agent': 'live-url-record',
    }
    payload = None
    if data is not None:
        payload = data
        headers['Content-Type'] = content_type
    elif body is not None:
        payload = json.dumps(body).encode()
        headers['Content-Type'] = 'application/json'
    req = urllib.request.Request(url, data=payload, method=method, headers=headers)
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read()
            return r.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as e:
        return e.code, {}


def release_notes(p):
    return (
        f"Live site for run {p['run_id']}.\n\n"
        f"- URL: {p['url']}\n"
        f"- Run: {p['run_url']}\n"
        f"- Commit: {p['commit']}\n"
        f"- Run status when saved: {p['run_status']}\n\n"
        "The URL is a Cloudflare Quick Tunnel. It changes with every run."
    )


def save(p, token, api, uploads, branch):
    repo = p['repository']
    text = json.dumps(p, indent=2) + '\n'
    # 1. The branch, created from the run's commit if it does not exist yet.
    status, _ = call('GET', f'{api}/repos/{repo}/git/ref/heads/{branch}', token)
    if status == 404:
        status, _ = call('POST', f'{api}/repos/{repo}/git/refs', token,
                         body={'ref': f'refs/heads/{branch}', 'sha': p['commit']})
        if status not in (200, 201):
            raise ApiError(status, 'create the branch')
    elif status != 200:
        raise ApiError(status, 'read the branch')
    # 2. The JSON file on that branch.
    file_url = f'{api}/repos/{repo}/contents/{FILE}'
    status, current = call('GET', f'{file_url}?ref={branch}', token)
    if status not in (200, 404):
        raise ApiError(status, f'read {FILE}')
    body = {
        'message': f'live url: run {p["run_id"]} [skip ci]',
        'content': base64.b64encode(text.encode()).decode(),
        'branch': branch,
    }
    if status == 200 and current.get('sha'):
        body['sha'] = current['sha']
    status, _ = call('PUT', file_url, token, body=body)
    if status not in (200, 201):
        raise ApiError(status, f'write {FILE}')
    # 3. The tag and pre-release, at the run's commit.
    status, release = call('POST', f'{api}/repos/{repo}/releases', token, body={
        'tag_name': p['tag'],
        'target_commitish': p['commit'],
        'name': f"Live run {p['run_id']}",
        'body': release_notes(p),
        'prerelease': True,
        'draft': False,
    })
    if status == 422:
        status, release = call('GET', f'{api}/repos/{repo}/releases/tags/{p["tag"]}', token)
        if status != 200:
            raise ApiError(status, 'read the existing release')
        return 'already saved (release exists)'
    if status not in (200, 201):
        raise ApiError(status, 'create the release')
    # 4. The JSON as a release asset.
    status, _ = call('POST', f'{uploads}/repos/{repo}/releases/{release["id"]}/assets?name={FILE}', token,
                     data=text.encode(), content_type='application/json')
    if status not in (200, 201):
        raise ApiError(status, 'upload the release asset')
    return 'saved'


def main(argv):
    dry = '--dry-run' in argv
    try:
        payload = build_payload(os.environ)
    except ValueError as e:
        print(f'::error::{e}', file=sys.stderr)
        return 2
    if dry:
        print(json.dumps(payload, indent=2))
        return 0
    token = os.environ.get('GH_TOKEN', '')
    if not token:
        print('::error::GH_TOKEN is not set.', file=sys.stderr)
        return 2
    branch = os.environ.get('LIVE_URL_BRANCH', 'live-url')
    if not BRANCH_RE.fullmatch(branch):
        print('::error::LIVE_URL_BRANCH is not a valid branch name.', file=sys.stderr)
        return 2
    api = os.environ.get('GITHUB_API_URL', 'https://api.github.com').rstrip('/')
    uploads = os.environ.get('GITHUB_UPLOADS_URL', 'https://uploads.github.com').rstrip('/')
    try:
        result = save(payload, token, api, uploads, branch)
    except ApiError as e:
        print(f'::error::Could not save the live URL ({e}).', file=sys.stderr)
        return 1
    except (urllib.error.URLError, OSError):
        print('::error::Could not reach the GitHub API to save the live URL.', file=sys.stderr)
        return 1
    print(f"Live URL {result}: {payload['tag']} -> {payload['url']} (branch {branch}).")
    return 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
