'use strict';

// OpenAI-compatible /v1 endpoints over the site's real AI inference backend.
//
// Two modes, chosen by configuration:
//
//   local (default): the configured provider is the llama.cpp `llama-server`
//     supervised by src/model-chat.js on this machine. GET /v1/models lists
//     the verified model registry (the loaded model is marked `loaded`);
//     POST /v1/chat/completions runs the SAME real path as the site chat:
//     hot-swap to the requested registry model, generate on the local
//     runtime, honest errors when a model cannot be loaded. Nothing is faked.
//
//   proxy (AI_BASE_URL set): requests are forwarded to an external
//     OpenAI-compatible provider. Model lists are preserved verbatim from the
//     upstream (no invented ids); completions are forwarded with the optional
//     AI_API_KEY. Upstream failures surface as honest gateway errors.
//
// Configuration (environment):
//   AI_BASE_URL     external OpenAI-compatible base URL (switches to proxy mode)
//   AI_API_KEY      optional bearer token for the upstream provider
//   AI_MODELS_PATH  optional upstream models path (default /v1/models)
//   V1_API_KEY      optional inbound bearer key for /v1/* itself. When unset
//                   the endpoints are open (keyless, like the site health).
//   AI_MAX_CONCURRENT  local-mode generation slots (default 2, mirrors the site chat)
//
// No key is ever logged or echoed in a response.

const crypto = require('node:crypto');
const { AppError } = require('./errors');

const LIST_TIMEOUT_MS = 20000;
const PROXY_TIMEOUT_MS = 10 * 60 * 1000;
const MAX_MESSAGES = 33;          // system + 16 exchanges + the new user turn
const MAX_MESSAGE_CHARS = 8000;   // same cap as the site chat
const MAX_TOKENS_CAP = 4096;

function bearerToken(req) {
  const header = req.headers.authorization || '';
  const m = /^Bearer\s+(.+)$/i.exec(header);
  return m ? m[1].trim() : null;
}

// Best-effort read of an error body without throwing.
async function errorSnippet(res) {
  try {
    const text = await res.text();
    return text.replace(/\s+/g, ' ').slice(0, 300);
  } catch {
    return '';
  }
}

class OpenAiCompat {
  constructor({
    chat,
    upstreamBase = '',
    upstreamApiKey = '',
    upstreamModelsPath = '/v1/models',
    apiKey = '',
    maxConcurrent = 2,
    now = Date.now,
    fetchImpl = globalThis.fetch,
  } = {}) {
    this.chat = chat;
    this.upstreamBase = String(upstreamBase || '').replace(/\/+$/, '');
    this.upstreamApiKey = upstreamApiKey;
    this.upstreamModelsPath = upstreamModelsPath || '/v1/models';
    this.upstreamCompletionsPath = '/v1/chat/completions';
    this.apiKey = apiKey;
    this.maxConcurrent = Number.isInteger(maxConcurrent) && maxConcurrent > 0 ? maxConcurrent : 2;
    this.now = now;
    this.fetch = fetchImpl;
    this.active = 0;
  }

  get mode() {
    return this.upstreamBase ? 'proxy' : 'local';
  }

  // Inbound key check for /v1/*: only enforced when V1_API_KEY is configured.
  authorize(req) {
    if (!this.apiKey) return true;
    return bearerToken(req) === this.apiKey;
  }

  upstreamHeaders(extra = {}) {
    const headers = { 'Content-Type': 'application/json', ...extra };
    if (this.upstreamApiKey) headers.Authorization = `Bearer ${this.upstreamApiKey}`;
    return headers;
  }

  // OpenAI-style error payloads for this endpoint family.
  static errorBody(message, type, code) {
    return { error: { message, type, code: code || null } };
  }

  async listModels() {
    if (this.mode === 'proxy') {
      let res;
      try {
        res = await this.fetch(`${this.upstreamBase}${this.upstreamModelsPath}`, {
          headers: this.upstreamHeaders(),
          signal: AbortSignal.timeout(LIST_TIMEOUT_MS),
        });
      } catch (err) {
        if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
          throw new AppError(504, 'UPSTREAM_TIMEOUT', 'the model provider did not answer the models request in time.');
        }
        throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'the configured model provider could not be reached.');
      }
      if (!res.ok) {
        const snippet = await errorSnippet(res);
        const message = res.status === 401 || res.status === 403
          ? 'authentication with the model provider failed (check AI_API_KEY).'
          : `the model provider answered HTTP ${res.status} for the models list${snippet ? `: ${snippet}` : ''}.`;
        throw new AppError(502, res.status === 401 || res.status === 403 ? 'UPSTREAM_AUTH' : 'UPSTREAM_ERROR', message);
      }
      let parsed;
      try {
        parsed = JSON.parse(await res.text());
      } catch {
        throw new AppError(502, 'UPSTREAM_INVALID', 'the model provider sent a models list that is not valid JSON.');
      }
      const rows = parsed && Array.isArray(parsed.data) ? parsed.data : [];
      // Preserve the upstream entries verbatim (ids included); only wrap the list shape.
      return { object: 'list', data: rows.filter((r) => r && typeof r === 'object') };
    }

    // Local mode: the verified registry of the supervised llama-server.
    const st = this.chat.status();
    if (!st.enabled) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'no AI inference backend is configured on this server.');
    }
    const loaded = st.state === 'ready' ? st.loaded_model : null;
    const models = Array.isArray(st.models) ? st.models : [];
    return {
      object: 'list',
      data: models.map((m) => ({
        id: m.id,
        object: 'model',
        created: 0,
        owned_by: 'local',
        // Honest availability: the model actually in memory right now.
        ...(loaded === m.id ? { loaded: true } : {}),
      })),
    };
  }

  // Validates the OpenAI chat body. Returns { messages, maxTokens, model, stream, temperature }.
  validateCompletionsBody(body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      throw new AppError(400, 'INVALID_BODY', 'request body must be a JSON object.');
    }
    const messages = body.messages;
    if (!Array.isArray(messages) || messages.length === 0) {
      throw new AppError(400, 'BAD_MESSAGES', 'messages must be a non-empty array of {role, content}.');
    }
    if (messages.length > MAX_MESSAGES) {
      throw new AppError(400, 'BAD_MESSAGES', `messages must hold at most ${MAX_MESSAGES} entries.`);
    }
    const clean = messages.map((item) => {
      const role = item && (item.role === 'system' || item.role === 'user' || item.role === 'assistant') ? item.role : null;
      const content = item && typeof item.content === 'string' ? item.content : null;
      if (!role || content === null) {
        throw new AppError(400, 'BAD_MESSAGES', 'every message needs role (system|user|assistant) and string content.');
      }
      if (content.length > MAX_MESSAGE_CHARS) {
        throw new AppError(400, 'PROMPT_TOO_LONG', `a message exceeds ${MAX_MESSAGE_CHARS} characters.`);
      }
      return { role, content };
    });
    const last = clean[clean.length - 1];
    if (last.role !== 'user' || !last.content.trim()) {
      throw new AppError(400, 'EMPTY_PROMPT', 'the last message must be non-empty user text.');
    }
    let maxTokens;
    if (body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== '') {
      maxTokens = Number(body.max_tokens);
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > MAX_TOKENS_CAP) {
        throw new AppError(400, 'BAD_MAX_TOKENS', `max_tokens must be an integer between 1 and ${MAX_TOKENS_CAP}.`);
      }
    }
    if (body.model !== undefined && body.model !== null && body.model !== '' && typeof body.model !== 'string') {
      throw new AppError(400, 'BAD_MODEL', 'model must be a model id string from /v1/models.');
    }
    return {
      messages: clean,
      maxTokens,
      model: body.model || null,
      stream: body.stream === true,
      temperature: typeof body.temperature === 'number' && Number.isFinite(body.temperature) ? body.temperature : undefined,
    };
  }

  // The full /v1/chat/completions handling. Writes the response to `res`
  // (streaming SSE when asked). Throws AppError for pre-response failures -
  // the route layer turns those into OpenAI-style error JSON.
  async chatCompletions(req, res, body) {
    const parsed = this.validateCompletionsBody(body);
    if (this.mode === 'proxy') return this._proxyCompletions(res, body, parsed);
    return this._localCompletions(res, parsed);
  }

  async _proxyCompletions(res, body, parsed) {
    // Validate the requested model against the provider when its list is reachable;
    // when the list is not, forward anyway and let the provider answer honestly.
    if (parsed.model) {
      try {
        const list = await this.listModels();
        const ids = list.data.map((m) => m && m.id).filter(Boolean);
        if (ids.length && !ids.includes(parsed.model)) {
          throw new AppError(400, 'MODEL_NOT_AVAILABLE', `model "${parsed.model}" is not offered by the provider. Available: ${ids.join(', ')}.`);
        }
      } catch (err) {
        if (err instanceof AppError && err.code === 'MODEL_NOT_AVAILABLE') throw err;
        // list unavailable: forward and let the upstream decide.
      }
    }
    let upstream;
    try {
      upstream = await this.fetch(`${this.upstreamBase}${this.upstreamCompletionsPath}`, {
        method: 'POST',
        headers: this.upstreamHeaders(),
        body: JSON.stringify({ ...body, model: parsed.model || body.model, messages: parsed.messages, stream: parsed.stream }),
        signal: AbortSignal.timeout(PROXY_TIMEOUT_MS),
      });
    } catch (err) {
      if (err && (err.name === 'TimeoutError' || err.name === 'AbortError')) {
        throw new AppError(504, 'UPSTREAM_TIMEOUT', 'the model provider did not finish the completion in time.');
      }
      throw new AppError(502, 'UPSTREAM_UNAVAILABLE', 'the configured model provider could not be reached.');
    }

    if (!upstream.ok) {
      const snippet = await errorSnippet(upstream);
      const authFail = upstream.status === 401 || upstream.status === 403;
      throw new AppError(
        authFail ? 502 : upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502,
        authFail ? 'UPSTREAM_AUTH' : 'UPSTREAM_ERROR',
        authFail
          ? 'authentication with the model provider failed (check AI_API_KEY).'
          : `the model provider answered HTTP ${upstream.status}${snippet ? `: ${snippet}` : ''}.`,
      );
    }

    if (parsed.stream) {
      res.writeHead(upstream.status, {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-store',
        Connection: 'keep-alive',
      });
      const reader = upstream.body.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          res.write(Buffer.from(value));
        }
      } finally {
        reader.releaseLock?.();
        res.end();
      }
      return null;
    }

    let payload;
    try {
      payload = JSON.parse(await upstream.text());
    } catch {
      throw new AppError(502, 'UPSTREAM_INVALID', 'the model provider sent a completion that is not valid JSON.');
    }
    sendV1Json(res, upstream.status, payload);
    return null;
  }

  async _localCompletions(res, parsed) {
    if (!this.chat.enabled) {
      throw new AppError(503, 'AI_NOT_CONFIGURED', 'no AI inference backend is configured on this server.');
    }
    // Hot-swap to the requested model exactly like the site chat does. Unknown
    // ids are an immediate 400; a model that cannot actually load surfaces the
    // real provisioning error (never a fake success).
    const entry = await this.chat.select(parsed.model || undefined);

    if (this.active >= this.maxConcurrent) {
      throw new AppError(429, 'MODEL_BUSY', 'the model is already generating for other requests. Try again in a moment.');
    }
    const id = `chatcmpl-${crypto.randomUUID()}`;
    const created = Math.floor(this.now() / 1000);
    this.active += 1;
    try {
      if (parsed.stream) {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
        });
        const chunk = (delta, finish) => JSON.stringify({
          id,
          object: 'chat.completion.chunk',
          created,
          model: entry.id,
          choices: [{ index: 0, delta, finish_reason: finish }],
        });
        res.write(`data: ${chunk({ role: 'assistant' }, null)}\n\n`);
        const result = await this.chat.generate({
          messages: parsed.messages,
          maxTokens: parsed.maxTokens,
          temperature: parsed.temperature,
          onDelta: (d) => {
            const delta = {};
            if (d.content) delta.content = d.content;
            if (d.reasoning) delta.reasoning_content = d.reasoning;
            if (d.content || d.reasoning) res.write(`data: ${chunk(delta, null)}\n\n`);
          },
        });
        res.write(`data: ${chunk({}, 'stop')}\n\n`);
        res.write('data: [DONE]\n\n');
        res.end();
        return { id, model: entry.id, usage: result.tokens || null };
      }

      const result = await this.chat.generate({
        messages: parsed.messages,
        maxTokens: parsed.maxTokens,
        temperature: parsed.temperature,
      });
      const promptTokens = result.tokens && result.tokens.prompt ? result.tokens.prompt : 0;
      const completionTokens = result.tokens && result.tokens.completion ? result.tokens.completion : 0;
      const message = { role: 'assistant', content: result.text };
      if (result.reasoning) message.reasoning_content = result.reasoning;
      sendV1Json(res, 200, {
        id,
        object: 'chat.completion',
        created,
        model: entry.id,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: {
          prompt_tokens: promptTokens,
          completion_tokens: completionTokens,
          total_tokens: promptTokens + completionTokens,
        },
      });
      return { id, model: entry.id, usage: result.tokens || null };
    } finally {
      this.active -= 1;
    }
  }
}

function sendV1Json(res, status, body, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(JSON.stringify(body));
}

// AppError -> OpenAI-style error response.
function sendV1Error(res, err) {
  const status = err instanceof AppError ? err.status : 500;
  const code = err instanceof AppError ? err.code : 'INTERNAL_ERROR';
  const message = (err instanceof AppError ? err.message : 'something went wrong.').slice(0, 600);
  const type = status === 401 || status === 403
    ? 'auth_error'
    : status === 429
      ? 'rate_limit_error'
      : status >= 500
        ? 'api_error'
        : 'invalid_request_error';
  sendV1Json(res, status, OpenAiCompat.errorBody(message, type, code));
}

module.exports = { OpenAiCompat, sendV1Error, sendV1Json };
