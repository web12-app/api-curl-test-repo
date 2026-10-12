'use strict';

// In-memory generation jobs for the site chat. A POST /api/chat creates a job,
// the client polls GET /api/chat/jobs/:id for progress (partial text included),
// and DELETE cancels. Jobs live only in this process - nothing is persisted.

const crypto = require('node:crypto');
const { AppError } = require('./errors');

const JOB_TTL_MS = 30 * 60 * 1000; // finished jobs are readable for 30 minutes
const MAX_MESSAGE_CHARS = 8000;
const MAX_HISTORY_MESSAGES = 16;
const MAX_ACTIVE_PER_USER = 2; // 1 running + 1 queued
const MAX_ACTIVE_GLOBAL = 2;

const MESSAGE_RE = /^[\s\S]{1,8000}$/;

class ChatJobs {
  // chat: a ModelChat instance. now: injectable clock for tests.
  constructor(chat, { now, globalLimit, perUserLimit } = {}) {
    this.chat = chat;
    this.now = now || Date.now;
    this.globalLimit = globalLimit || MAX_ACTIVE_GLOBAL;
    this.perUserLimit = perUserLimit || MAX_ACTIVE_PER_USER;
    this.jobs = new Map();
    this.estPromise = null;
  }

  loadEstimate() {
    if (!this.estPromise) {
      const path = require('node:path');
      const { pathToFileURL } = require('node:url');
      this.estPromise = import(pathToFileURL(path.join(__dirname, '..', 'scripts', 'model', 'estimate.mjs')).href);
    }
    return this.estPromise;
  }

  activeCount(userKey) {
    let n = 0;
    for (const job of this.jobs.values()) {
      if (job.status === 'queued' || job.status === 'running') {
        if (userKey === undefined || job.userKey === userKey) n += 1;
      }
    }
    return n;
  }

  _validateBody(body) {
    if (!body || typeof body !== 'object') {
      throw new AppError(400, 'INVALID_BODY', 'Request body must be a JSON object.');
    }
    const message = typeof body.message === 'string' ? body.message : '';
    if (!message.trim()) {
      throw new AppError(400, 'EMPTY_PROMPT', 'message is required and must be non-empty text.');
    }
    if (message.length > MAX_MESSAGE_CHARS) {
      throw new AppError(400, 'PROMPT_TOO_LONG', `message exceeds ${MAX_MESSAGE_CHARS} characters.`);
    }
    let history = [];
    if (body.history !== undefined) {
      if (!Array.isArray(body.history)) {
        throw new AppError(400, 'BAD_HISTORY', 'history must be an array of {role, content} messages.');
      }
      const usable = body.history.slice(-MAX_HISTORY_MESSAGES);
      for (const item of usable) {
        const role = item && (item.role === 'assistant' || item.role === 'user') ? item.role : null;
        const content = item && typeof item.content === 'string' ? item.content : null;
        if (!role || content === null || content.length > MAX_MESSAGE_CHARS) {
          throw new AppError(400, 'BAD_HISTORY', 'history contains an invalid message.');
        }
        history.push({ role, content });
      }
    }
    let maxTokens;
    if (body.max_tokens !== undefined && body.max_tokens !== null && body.max_tokens !== '') {
      maxTokens = Number(body.max_tokens);
      if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) {
        throw new AppError(400, 'BAD_MAX_TOKENS', 'max_tokens must be an integer between 1 and 4096.');
      }
    }
    return { message, history, maxTokens };
  }

  // Creates and starts a job. Throws AppError-shaped errors for validation and
  // capacity problems (the route layer turns them into JSON).
  create(user, body) {
    if (this.chat.state === 'error') {
      throw new AppError(
        503,
        (this.chat.error && this.chat.error.code) || 'MODEL_NOT_READY',
        (this.chat.error && this.chat.error.message) || 'the model runtime failed',
      );
    }
    if (this.chat.state !== 'ready') {
      throw new AppError(503, 'MODEL_NOT_READY', 'the model is still starting. Check /api/chat/status and try again soon.');
    }
    if (this.activeCount() >= this.globalLimit) {
      throw new AppError(429, 'MODEL_BUSY', 'the model is already generating for other requests. Try again in a moment.');
    }
    if (this.activeCount(user.id) >= this.perUserLimit) {
      throw new AppError(429, 'MODEL_BUSY', 'you already have a generation running. Wait for it or cancel it first.');
    }
    const { message, history, maxTokens } = this._validateBody(body);
    const job = {
      id: crypto.randomUUID(),
      userKey: user.id,
      username: user.username,
      status: 'queued',
      createdAt: this.now(),
      updatedAt: this.now(),
      message,
      partial: '',
      partialReasoning: '',
      result: null,
      error: null,
      controller: new AbortController(),
    };
    this.jobs.set(job.id, job);
    this._run(job, history, maxTokens);
    return this.view(job);
  }

  async _run(job, history, maxTokens) {
    const messages = [...history, { role: 'user', content: job.message }];
    job.status = 'running';
    job.updatedAt = this.now();
    try {
      const est = await this.loadEstimate();
      if (est && est.LIMITS && job.message.length > est.LIMITS.maxPromptChars) {
        throw new AppError(400, 'PROMPT_TOO_LONG', `message exceeds ${est.LIMITS.maxPromptChars} characters.`);
      }
      const result = await this.chat.generate({
        messages,
        maxTokens,
        signal: job.controller.signal,
        onDelta: (d) => {
          if (d.content) job.partial += d.content;
          if (d.reasoning) job.partialReasoning += d.reasoning;
          job.updatedAt = this.now();
        },
      });
      job.result = {
        text: result.text,
        reasoning: result.reasoning || '',
        elapsed_ms: result.elapsed_ms,
        max_tokens: result.max_tokens,
        tokens: result.tokens || null,
      };
      job.status = 'done';
    } catch (err) {
      if (err.code === 'GENERATION_CANCELLED' || job.controller.signal.aborted) {
        job.status = 'cancelled';
        job.error = { code: 'GENERATION_CANCELLED', message: 'generation was cancelled.' };
      } else {
        job.status = 'error';
        job.error = {
          code: err.code || 'GENERATION_FAILED',
          message: (err.message || 'generation failed').slice(0, 600),
        };
      }
    }
    job.updatedAt = this.now();
    job.controller = null;
  }

  view(job) {
    const out = {
      id: job.id,
      status: job.status,
      created_at: new Date(job.createdAt).toISOString(),
      partial: job.partial,
      partial_reasoning: job.partialReasoning,
      result: job.result,
      error: job.error,
    };
    if (job.status === 'running') {
      out.elapsed_ms = this.now() - job.createdAt;
    }
    return out;
  }

  get(id, user) {
    const job = this.jobs.get(id);
    if (!job || job.userKey !== user.id) return null;
    return this.view(job);
  }

  cancel(id, user) {
    const job = this.jobs.get(id);
    if (!job || job.userKey !== user.id) return null;
    if (job.status === 'queued' || job.status === 'running') {
      if (job.controller) job.controller.abort();
      job.status = 'cancelled';
      job.error = { code: 'GENERATION_CANCELLED', message: 'generation was cancelled.' };
      job.updatedAt = this.now();
    }
    return this.view(job);
  }

  // Drops finished jobs past the TTL. Returns the number removed.
  cleanup(now) {
    const t = now || this.now();
    let removed = 0;
    for (const [id, job] of this.jobs) {
      const active = job.status === 'queued' || job.status === 'running';
      if (!active && t - job.updatedAt > JOB_TTL_MS) {
        this.jobs.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = { ChatJobs, MESSAGE_RE, JOB_TTL_MS };
