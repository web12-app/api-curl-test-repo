#!/usr/bin/env python3
"""Publish this run's public URL to the lives repo (live.json), through the GitHub API.

Usage: publish-live-url.py <https-url> [--dry-run]

Environment:
  LIVE_PUBLISH_TOKEN   token with Contents read/write on LIVE_PUBLISH_REPO only (required to publish)
  LIVE_PUBLISH_REPO    default web12-app/lives
  LIVE_PUBLISH_BRANCH  default main
  LIVE_PUBLISH_PATH    default live.json
  GITHUB_API_BASE      default https://api.github.com (tests point it at a mock)
  GITHUB_RUN_ID        recorded in live.json
  GITHUB_STEP_SUMMARY  optional, a run-summary file

Exit codes: 0 published (or no token: warning only), 1 API failure, 2 bad input.
The token is never printed.
"""
import base64
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
from datetime import datetime, timezone

URL_RE = re.compile(r'https://[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+(:[0-9]+)?')
REPO_RE = re.compile(r'[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+')


def summary(text):
    path = os.environ.get('GITHUB_STEP_SUMMARY')
    if path:
        with open(path, 'a') as f:
            f.write(text + '\n')


def api(method, url, token, body=None):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method, headers={
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
        'User-Agent': 'live-tunnel-publish',
    })
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            return resp.status, json.loads(resp.read() or b'{}')
    except urllib.error.HTTPError as e:
        return e.code, {}


def build_body(url, run_id):
    return {
        'url': url,
        'updated_at': datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%SZ'),
        'note': 'Current live URL, read through the GitHub API (scripts/get_live.py).',
        'run_id': run_id,
    }


def main(argv):
    dry = '--dry-run' in argv
    args = [a for a in argv[1:] if not a.startswith('--')]
    if len(args) != 1:
        print('usage: publish-live-url.py <https-url> [--dry-run]', file=sys.stderr)
        return 2
    url = args[0].rstrip('/')
    if not URL_RE.fullmatch(url):
        print('::error::Refusing to publish a value that is not a bare https origin.', file=sys.stderr)
        return 2
    body = build_body(url, os.environ.get('GITHUB_RUN_ID', 'local'))
    if dry:
        print(json.dumps(body, indent=2))
        return 0
    token = os.environ.get('LIVE_PUBLISH_TOKEN', '')
    if not token:
        print('::warning::LIVE_PUBLISH_TOKEN is not set, so the lives entry page was not updated.')
        summary('**Lives entry not updated.** The LIVE_PUBLISH_TOKEN secret is not set.')
        return 0
    repo = os.environ.get('LIVE_PUBLISH_REPO', 'web12-app/lives')
    branch = os.environ.get('LIVE_PUBLISH_BRANCH', 'main')
    path = os.environ.get('LIVE_PUBLISH_PATH', 'live.json')
    base = os.environ.get('GITHUB_API_BASE', 'https://api.github.com').rstrip('/')
    if not REPO_RE.fullmatch(repo):
        print('::error::LIVE_PUBLISH_REPO must look like owner/repo.', file=sys.stderr)
        return 2
    contents = f'{base}/repos/{repo}/contents/{urllib.parse.quote(path)}'
    content_b64 = base64.b64encode((json.dumps(body, indent=2) + '\n').encode()).decode()
    for attempt in (1, 2):
        status, current = api('GET', f'{contents}?ref={urllib.parse.quote(branch)}', token)
        if status not in (200, 404):
            print(f'::error::Could not read {repo}/{path} (HTTP {status}).', file=sys.stderr)
            summary(f'**Lives entry not updated.** Read failed (HTTP {status}).')
            return 1
        payload = {'message': f'live url: {url}', 'content': content_b64, 'branch': branch}
        if status == 200 and current.get('sha'):
            payload['sha'] = current['sha']
        status, result = api('PUT', contents, token, payload)
        if status in (200, 201):
            commit = (result.get('commit') or {}).get('sha', '')[:7]
            print(f'Published {url} to {repo}/{path} on {branch} (commit {commit}).')
            summary(f'**Lives entry updated** to {url} (commit {commit}).')
            return 0
        if status == 409 and attempt == 1:
            continue
        print(f'::error::Could not update {repo}/{path} (HTTP {status}).', file=sys.stderr)
        summary(f'**Lives entry not updated.** Write failed (HTTP {status}).')
        return 1
    return 1


if __name__ == '__main__':
    sys.exit(main(sys.argv))
