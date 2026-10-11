'use strict';

// The Tube pages live in the committed React bundle (public/assets/app.js). This test keeps the
// bundle in sync with the server's Tube routes: if the client stops linking the pages or calling
// the API, the routes would be dead code.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('the committed React bundle carries the Tube pages and nav link', () => {
  const bundle = fs.readFileSync(path.join(__dirname, '..', 'public', 'assets', 'app.js'), 'utf8');
  assert.match(bundle, /\/tube\/watch\//, 'cards link to watch pages');
  assert.match(bundle, /\/tube\/channel\//, 'the watch screen links to channel pages');
  assert.match(bundle, /api\/tube\/feed/, 'the client talks to the tube API');
  assert.match(bundle, /\/api\/tube\/my-channel/, 'the client can create a channel');
  assert.match(bundle, /videos\/.*\/publish|publish/, 'the client can publish videos');
});
