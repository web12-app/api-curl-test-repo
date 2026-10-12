# Persistent inference worker (your own Linux machine)

GitHub-hosted runners are ephemeral and start with 16 GiB RAM. They are fine
for occasional real inference, but they must not be used as a permanent model
server. If you want an always-on endpoint, run llama.cpp's HTTP server on a
machine you control and let `model-inference.yml` send prompts to it.

## Requirements

- Linux x86_64, 24 GiB RAM or more recommended for Qwen.Qwen3.8-27B Q2_K with
  a comfortable context (weights ~10 GiB + KV cache + runtime overhead).
- The model file downloaded once (use `model-download.yml` logic or
  `huggingface-cli download DevQuasar/Qwen.Qwen3.8-27B-GGUF
  --include "Q2_K/*"`).
- llama.cpp `llama-server` (build from source or use the official prebuilt
  tarball, same pinned tag as `model-build.yml`, e.g. `b11574`).

## 1. Start the server (localhost only, API key required)

```bash
sudo useradd -m -s /usr/sbin/nologin modelworker || true
sudo -u modelworker API_KEY="$(openssl rand -hex 32)" \
  LLAMA_BIN=/opt/llama.cpp/llama-server \
  bash scripts/model/worker-server.sh \
    --model /srv/models/Qwen.Qwen3.8-27B.f16.gguf.Q2_K.gguf \
    --host 127.0.0.1 --port 8081 --ctx 8192
```

`worker-server.sh` refuses to start without an API key (minimum 24 chars) and
refuses to bind anything except localhost. Save the generated key - the
workflows need it as the `WORKER_TOKEN` secret.

Run it under systemd for persistence:

```ini
# /etc/systemd/system/model-worker.service
[Unit]
Description=llama.cpp inference worker (localhost only)
After=network.target

[Service]
User=modelworker
Environment=LLAMA_BIN=/opt/llama.cpp/llama-server
EnvironmentFile=/etc/model-worker.env   # contains API_KEY=...
ExecStart=/usr/bin/bash /opt/runner/scripts/model/worker-server.sh \
  --model /srv/models/Qwen.Qwen3.8-27B.f16.gguf.Q2_K.gguf \
  --host 127.0.0.1 --port 8081 --ctx 8192
Restart=on-failure
# isolation + resource caps
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=true
MemoryMax=24G
TasksMax=256

[Install]
WantedBy=multi-user.target
```

## 2. TLS + rate limiting in front (nginx example)

```nginx
limit_req_zone $binary_remote_addr zone=infer:10m rate=10r/m;

server {
    listen 443 ssl http2;
    server_name infer.example.com;

    ssl_certificate     /etc/letsencrypt/live/infer.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/infer.example.com/privkey.pem;

    # body cap: prompts are small
    client_max_body_size 64k;

    location / {
        limit_req zone=infer burst=5 nodelay;
        proxy_pass http://127.0.0.1:8081;
        proxy_read_timeout 900s;
        proxy_set_header Host $host;
    }
}
```

(Caddy works too: `infer.example.com { reverse_proxy 127.0.0.1:8081 }` with
automatic HTTPS. Rate limiting then comes from llama-server itself or a
plugin.)

## 3. Point the workflow at it

1. Repo → Settings → Secrets and variables → Actions → new secret
   `WORKER_TOKEN` = the API key from step 1.
2. Run **model-inference** with `worker_url: https://infer.example.com`.

The workflow:

- refuses plain `http://` URLs (TLS enforced in code, not just documented);
- checks `$WORKER_URL/health` with the bearer token before anything;
- sends `POST /completion` with `{prompt, n_predict, temperature}`;
- never prints the token (GitHub masks secrets in logs);
- reports the worker response through the same `result.json` structure.

## 4. Isolation checklist

- [ ] Worker runs as a dedicated non-login user (`modelworker`).
- [ ] `llama-server` binds 127.0.0.1 only; the public port is your TLS proxy.
- [ ] API key required on every request (`--api-key`).
- [ ] Request limits: nginx `limit_req` (or equivalent) + body size cap.
- [ ] `systemd` `MemoryMax` / `TasksMax` cap runaway memory.
- [ ] Prompts are passed to the model, never to a shell - llama-server treats
      input as text; do not add script execution around it.
- [ ] Model directory read-only for the worker user.
- [ ] Logs go to journald; no secrets are logged (the key is passed via env).
