'use strict';

// Search across videos, channels and files, search suggestions, and an AI answer that cites the results.
//
// - Videos come from the Tube feed (public videos), channels from the public channel list, and files from the
//   signed-in user's own file list. Matching is case-insensitive on titles, names and descriptions.
// - The AI answer uses OpenRouter with a fixed list of free chat models. OpenRouter tries them in order.
//   The key is read from OPENROUTER_API_KEY in the environment only. It is never returned or logged.
// - The model is told to answer only from the numbered results. The reply is returned with those results as sources.

const { AppError } = require('./errors');

const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const AI_TIMEOUT_MS = 60 * 1000;
// Free chat models checked on this server. Order is the fallback order.
const FREE_MODELS = [
  'google/gemma-4-31b-it:free',
  'nvidia/nemotron-3-super-120b-a12b:free',
  'google/gemma-4-26b-a4b-it:free',
  'poolside/laguna-s-2.1:free',
];
const KINDS = ['all', 'videos', 'channels', 'files'];
const MAX_QUERY = 100;
const MAX_AI_QUERY = 300;

function norm(value) {
  return String(value || '').toLowerCase().trim();
}

function hit(needle, fields) {
  return fields.some((f) => norm(f).includes(needle));
}

function clean(q) {
  return String(q || '').trim().slice(0, MAX_QUERY);
}

// Runs the search. `tube` is the TubeService, `files` the FileService, `uid` and `username` the signed-in user.
async function run({ tube, files, uid, username, q, kind = 'all', limit = 20 }) {
  if (!KINDS.includes(kind)) {
    throw new AppError(400, 'INVALID_KIND', `kind must be one of: ${KINDS.join(', ')}.`);
  }
  const query = clean(q);
  const needle = norm(query);
  const out = { query, videos: [], channels: [], files: [] };
  if (!needle) return out;

  if (kind === 'all' || kind === 'videos') {
    const videos = await tube.feed(username);
    out.videos = videos
      .filter((v) => hit(needle, [v.title, v.description, v.channelName, v.owner]))
      .slice(0, limit)
      .map((v) => ({
        type: 'video', id: v.fileId, title: v.title, owner: v.owner, channelName: v.channelName,
        publishedAt: v.publishedAt, views: v.views, likes: v.likes,
      }));
  }
  if (kind === 'all' || kind === 'channels') {
    const channels = await tube.listChannels();
    out.channels = channels
      .filter((c) => hit(needle, [c.name, c.username, c.description]))
      .slice(0, limit)
      .map((c) => ({
        type: 'channel', id: c.username, title: c.name, owner: c.username,
        description: c.description, subscribers: c.subscribers,
      }));
  }
  if (kind === 'all' || kind === 'files') {
    const listed = await files.list(uid, { q: query });
    out.files = listed.files.slice(0, limit).map((f) => ({
      type: 'file', id: f.id, title: f.name, name: f.name, mime: f.mime, category: f.category, size: f.size,
        uploaded_at: f.uploaded_at ?? f.uploadedAt, folder: f.folder, visibility: f.visibility, version: f.version,
    }));
  }
  return out;
}

// Up to 8 suggestions: titles and names that start with the typed text first, then names that contain it.
async function suggest({ tube, files, uid, username, q }) {
  const query = clean(q);
  const needle = norm(query);
  if (!needle) return { suggestions: [] };
  const [videos, channels, listed] = await Promise.all([
    tube.feed(username),
    tube.listChannels(),
    files.list(uid, { q: '' }),
  ]);
  const candidates = [
    ...videos.map((v) => v.title),
    ...channels.map((c) => c.name),
    ...listed.files.map((f) => f.name),
  ].filter((s) => typeof s === 'string' && s.trim());
  const seen = new Set();
  const starts = [];
  const contains = [];
  for (const text of candidates) {
    const key = norm(text);
    if (seen.has(key) || !key.includes(needle)) continue;
    seen.add(key);
    (key.startsWith(needle) ? starts : contains).push(text);
  }
  return { suggestions: [...starts, ...contains].slice(0, 8) };
}

function sourceLine(i, r) {
  const parts = [r.type, r.title];
  if (r.owner && r.type !== 'channel') parts.push(`by ${r.owner}`);
  if (r.type === 'channel' && r.description) parts.push(r.description.slice(0, 160));
  if (r.type === 'file') parts.push(r.category || 'file');
  return `[${i + 1}] ${parts.filter(Boolean).join(' | ')}`;
}

// Asks the free-model list for an answer that cites the numbered results.
// `apiKey` and `fetchImpl` are injectable for tests. Returns { answer, model, sources }.
async function answer({ query, results, apiKey = process.env.OPENROUTER_API_KEY, fetchImpl = fetch }) {
  const q = clean(query).slice(0, MAX_AI_QUERY);
  if (!q) throw new AppError(400, 'EMPTY_QUERY', 'Type a question first.');
  if (!apiKey) throw new AppError(503, 'AI_UNAVAILABLE', 'AI mode is not set up on this server yet.');

  const sources = [
    ...results.videos, ...results.channels, ...results.files,
  ].slice(0, 12);
  const sourceText = sources.length
    ? sources.map((r, i) => sourceLine(i, r)).join('\n')
    : 'No matching results were found on this server.';

  const body = {
    models: FREE_MODELS,
    temperature: 0.2,
    max_tokens: 700,
    messages: [
      {
        role: 'system',
        content: 'You answer questions about the user\'s own videos, channels and files. Use only the numbered '
          + 'results. Cite results like [1]. If the results do not answer the question, say so in one sentence. '
          + 'Be brief.',
      },
      { role: 'user', content: `Question: ${q}\n\nResults:\n${sourceText}` },
    ],
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), AI_TIMEOUT_MS);
  let res;
  try {
    res = await fetchImpl(OPENROUTER_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Pips',
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (err) {
    throw new AppError(503, 'AI_UNREACHABLE', 'The AI service did not answer. Try again shortly.');
  } finally {
    clearTimeout(timer);
  }
  if (!res.ok) throw new AppError(503, 'AI_UNREACHABLE', 'The AI service did not answer. Try again shortly.');

  const data = await res.json();
  const text = data && data.choices && data.choices[0] && data.choices[0].message
    ? String(data.choices[0].message.content || '').trim()
    : '';
  if (!text) throw new AppError(503, 'AI_EMPTY', 'The AI service returned no answer. Try again.');
  return { answer: text, model: String(data.model || ''), sources };
}

module.exports = { run, suggest, answer, FREE_MODELS, KINDS };
