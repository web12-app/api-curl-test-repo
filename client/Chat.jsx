// Model chat screen. Talks to the local llama.cpp runtime through the site API:
// POST /api/chat creates a generation job, GET /api/chat/jobs/:id streams back
// progress (partial text while the model is still writing), DELETE cancels.
// Nothing here fakes a reply: whatever appears came from the model.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { api, messageOf } from './api.js';

const POLL_MS = 1200;
const HISTORY_MESSAGES = 10;
const MAX_MESSAGE_CHARS = 8000;

const STATE_LABEL = {
  disabled: 'Model chat is off on this server',
  validating: 'Checking files',
  'provisioning-runtime': 'Fetching the llama.cpp runtime',
  'provisioning-model': 'Downloading the model',
  'checking-memory': 'Checking memory',
  loading: 'Loading the model',
  ready: 'Model ready',
  error: 'Model error',
};

function stateDot(state, enabled) {
  if (!enabled || state === 'disabled') return '';
  if (state === 'ready') return ' ready';
  if (state === 'error') return ' error';
  return ' loading';
}

function fmtBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  return (bytes / (1024 * 1024 * 1024)).toFixed(2) + ' GB';
}

// One exchange = the user's message plus the assistant reply that follows it.
function Exchange({ user, assistant }) {
  return (
    <>
      <div className="chat-msg user">{user}</div>
      {assistant && (
        <div className={'chat-msg assistant' + (assistant.pending ? ' pending' : '')}>
          {assistant.reasoning && (
            <details className="chat-reason">
              <summary>Model reasoning</summary>
              <p>{assistant.reasoning}</p>
            </details>
          )}
          {assistant.text}
          {assistant.pending && <span className="chat-cursor" />}
          {assistant.meta && <div className="chat-meta">{assistant.meta}</div>}
        </div>
      )}
    </>
  );
}

export default function ChatPage({ boot }) {
  const initial = boot.chat || { enabled: false, state: 'disabled' };
  const [status, setStatus] = useState(initial);
  const [exchanges, setExchanges] = useState([]); // [{ user, assistant: {text, reasoning, meta, pending} | null }]
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false); // a job of ours is queued/running
  const [sendError, setSendError] = useState('');
  const [selectedModel, setSelectedModel] = useState(initial.loaded_model || initial.default_model || '');
  const jobRef = useRef(null);
  const logRef = useRef(null);
  const exchangesRef = useRef(exchanges);
  exchangesRef.current = exchanges;

  const active = status.enabled && (status.state === 'ready' || status.state === 'loading' || status.state === 'validating' || status.state === 'checking-memory');
  const models = Array.isArray(status.models) ? status.models : [];
  const loadedModel = status.loaded_model || null;

  // Once the server reports its model registry, make sure the selector holds
  // a real model id (the initial boot data may predate the registry).
  useEffect(() => {
    if (!models.length) return;
    if (selectedModel && models.some((m) => m.id === selectedModel)) return;
    setSelectedModel(loadedModel || status.default_model || models[0].id);
  }, [models.length, loadedModel, status.default_model, selectedModel]);

  // While the runtime is not ready yet, keep asking for status so the page
  // flips to "ready" on its own (the model may be minutes away when the
  // server is still downloading it).
  useEffect(() => {
    if (!status.enabled || status.state === 'ready' || status.state === 'error' || status.state === 'disabled') return undefined;
    const timer = setInterval(async () => {
      const res = await api('/api/chat/status');
      if (res.ok && res.body && res.body.data) setStatus(res.body.data);
    }, 3000);
    return () => clearInterval(timer);
  }, [status.enabled, status.state]);

  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [exchanges]);

  //history for the API: the previous exchanges, oldest first, capped.
  const history = useMemo(() => {
    const done = exchanges.filter((x) => x.assistant && !x.assistant.pending);
    const recent = done.slice(-HISTORY_MESSAGES);
    const out = [];
    for (const x of recent) {
      out.push({ role: 'user', content: x.user });
      out.push({ role: 'assistant', content: x.assistant.text });
    }
    return out;
  }, [exchanges]);

  function appendAssistant(jobView) {
    // Map a job view onto the last (pending) assistant message.
    setExchanges((prev) => {
      const next = prev.slice();
      const last = next[next.length - 1];
      if (!last || !last.assistant || !last.assistant.pending) return next;
      const a = { ...last.assistant };
      if (jobView.partial_reasoning) a.reasoning = jobView.partial_reasoning;
      a.text = jobView.partial || (jobView.result && jobView.result.text) || '';
      if (jobView.status === 'done' && jobView.result) {
        a.text = jobView.result.text;
        if (jobView.result.reasoning) a.reasoning = jobView.result.reasoning;
        const bits = [];
        if (jobView.result.model) bits.push(jobView.result.model);
        if (jobView.result.tokens && jobView.result.tokens.completion) bits.push(jobView.result.tokens.completion + ' tokens');
        if (jobView.result.elapsed_ms) bits.push((jobView.result.elapsed_ms / 1000).toFixed(1) + ' s');
        a.meta = bits.join(' \u00b7 ');
        a.pending = false;
      }
      if (jobView.status === 'error' || jobView.status === 'cancelled') {
        a.text = jobView.error ? jobView.error.message : 'The generation did not finish.';
        a.pending = false;
        a.failed = true;
      }
      next[next.length - 1] = { ...last, assistant: a };
      return next;
    });
  }

  async function poll(jobId) {
    for (;;) {
      const res = await api('/api/chat/jobs/' + jobId);
      if (!res.ok) {
        appendAssistant({ status: 'error', error: { message: messageOf(res) } });
        return;
      }
      const view = res.body.data;
      appendAssistant(view);
      if (view.status === 'done' || view.status === 'error' || view.status === 'cancelled') return;
      await new Promise((r) => setTimeout(r, POLL_MS));
    }
  }

  async function send() {
    const message = draft.trim();
    if (!message || busy) return;
    if (message.length > MAX_MESSAGE_CHARS) {
      setSendError('Message is longer than ' + MAX_MESSAGE_CHARS + ' characters.');
      return;
    }
    setSendError('');
    setDraft('');
    setBusy(true);
    setExchanges((prev) => [...prev, { user: message, assistant: { text: '', reasoning: '', pending: true } }]);
    try {
      const res = await api('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message, history, max_tokens: undefined, model: selectedModel || undefined }),
      });
      if (!res.ok || !res.body || !res.body.data) {
        setExchanges((prev) => {
          const next = prev.slice();
          const last = next[next.length - 1];
          if (last && last.assistant && last.assistant.pending) {
            next[next.length - 1] = { ...last, assistant: { text: messageOf(res), pending: false, failed: true } };
          }
          return next;
        });
        return;
      }
      jobRef.current = res.body.data.id;
      await poll(res.body.data.id);
    } finally {
      setBusy(false);
      jobRef.current = null;
    }
  }

  async function cancel() {
    if (!jobRef.current) return;
    await api('/api/chat/jobs/' + jobRef.current, { method: 'DELETE' });
  }

  function onKeyDown(e) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const modelLine = status.model
    ? [status.model.repo, status.model.quant, fmtBytes(status.model.bytes)].filter(Boolean).join(' \u00b7 ')
    : '';

  return (
    <main className="container wide">
      <div className="chat-root">
        <div className="chat-status">
          <span className={'chat-dot' + stateDot(status.state, status.enabled)} />
          <strong>{STATE_LABEL[status.state] || status.state}</strong>
          <span>{status.detail}</span>
          {status.runtime_version ? <span className="chat-model">runtime: {status.runtime_version}</span> : null}
          {modelLine ? <span className="chat-model">{modelLine}</span> : null}
        </div>

        {status.enabled === false && (
          <div className="chat-error">
            The model runtime is not configured on this server. Set LLAMA_SERVER_BIN and MODEL_GGUF_PATH
            (or CHAT_AUTOPROVISION=1) and restart - see docs/gguf-model-runner.md.
          </div>
        )}
        {status.state === 'error' && status.error && <div className="chat-error">{status.error.message}</div>}

        {status.enabled !== false && models.length > 0 && (
          <div className="chat-modelbar">
            <label className="chat-model-label" htmlFor="chat-model-select">Model</label>
            <select
              id="chat-model-select"
              className="chat-select"
              value={selectedModel || ''}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={busy || !active}
            >
              {models.map((m) => (
                <option key={m.id} value={m.id}>
                  {m.label + ' \u00b7 ' + (m.quant || 'GGUF') + (fmtBytes(m.bytes) ? ' \u00b7 ' + fmtBytes(m.bytes) : '') + (m.id === loadedModel ? ' \u2014 loaded' : '')}
                </option>
              ))}
            </select>
            {active && selectedModel && loadedModel && selectedModel !== loadedModel && (
              <span className="chat-switch-hint">the next message switches the runtime to this model</span>
            )}
          </div>
        )}

        <div className="chat-log" ref={logRef}>
          {exchanges.length === 0 && (
            <div className="chat-empty">
              Ask the local model anything. Every reply is generated on this server - no external AI service involved.
            </div>
          )}
          {exchanges.map((x, i) => (
            <Exchange key={i} user={x.user} assistant={x.assistant} />
          ))}
        </div>

        {sendError && <div className="chat-error">{sendError}</div>}

        <div className="chat-composer">
          <textarea
            value={draft}
            placeholder={active ? 'Message the model\u2026' : 'The model is not ready yet.'}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={onKeyDown}
            disabled={!active || busy}
            rows={1}
            maxLength={MAX_MESSAGE_CHARS}
            aria-label="Message"
          />
          {busy ? (
            <button type="button" className="chat-cancel" onClick={cancel}>
              Stop
            </button>
          ) : (
            <button type="button" className="chat-send" onClick={send} disabled={!active || !draft.trim()}>
              Send
            </button>
          )}
        </div>
        <div className="chat-note">
          Generation runs on this server's own CPU (up to {status.max_tokens || 256} tokens per reply). It can be
          slow on a big model - use Stop to cancel. {busy ? 'Waiting for the model\u2026' : ''}
        </div>
        {status.context ? (
          <div className="chat-footer">
            context {status.context} &middot; the last {HISTORY_MESSAGES} exchanges are sent as history &middot; replies are not stored on the server
          </div>
        ) : null}
      </div>
    </main>
  );
}
