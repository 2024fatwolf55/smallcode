'use strict';

// SmallCode — live activity settings + /live command tests (issue #77)

const test = require('node:test');
const assert = require('node:assert/strict');

const live = require('../bin/live_settings');

function withEnv(vars, fn) {
  const saved = {};
  for (const k of Object.keys(vars)) { saved[k] = process.env[k]; if (vars[k] == null) delete process.env[k]; else process.env[k] = vars[k]; }
  live._reset();
  try { return fn(); } finally {
    for (const k of Object.keys(vars)) { if (saved[k] == null) delete process.env[k]; else process.env[k] = saved[k]; }
    live._reset();
  }
}

test('defaults: tools/context on, stream/thinking off', () => {
  withEnv({ SMALLCODE_LIVE_TOOLS: null, SMALLCODE_LIVE_CONTEXT: null, SMALLCODE_LIVE_STREAM: null, SMALLCODE_LIVE_THINKING: null }, () => {
    assert.deepEqual(live.getLiveSettings(), { tools: true, context: true, stream: false, thinking: false });
  });
});

test('env overrides seed the settings', () => {
  withEnv({ SMALLCODE_LIVE_TOOLS: 'off', SMALLCODE_LIVE_STREAM: 'true' }, () => {
    const s = live.getLiveSettings();
    assert.equal(s.tools, false);
    assert.equal(s.stream, true);
  });
});

test('/live with no arg returns status without mutating', () => {
  withEnv({}, () => {
    const r = live.resolveLiveCommand('');
    assert.equal(r.action, 'status');
    assert.match(r.text, /tools/);
    assert.match(r.text, /thinking/);
  });
});

test('/live <feature> on|off sets explicitly', () => {
  withEnv({}, () => {
    assert.equal(live.resolveLiveCommand('stream on').value, true);
    assert.equal(live.getLiveSettings().stream, true);
    assert.equal(live.resolveLiveCommand('stream off').value, false);
    assert.equal(live.getLiveSettings().stream, false);
  });
});

test('/live <feature> with no value toggles', () => {
  withEnv({}, () => {
    const before = live.getLiveSettings().tools;       // default true
    const r = live.resolveLiveCommand('tools');
    assert.equal(r.value, !before);
    assert.equal(live.getLiveSettings().tools, !before);
  });
});

test('/live all on|off sets every feature', () => {
  withEnv({}, () => {
    live.resolveLiveCommand('all off');
    assert.deepEqual(live.getLiveSettings(), { tools: false, context: false, stream: false, thinking: false });
    live.resolveLiveCommand('all on');
    assert.deepEqual(live.getLiveSettings(), { tools: true, context: true, stream: true, thinking: true });
  });
});

test('unknown feature and bad value produce errors, no mutation', () => {
  withEnv({}, () => {
    const before = { ...live.getLiveSettings() };
    assert.equal(live.resolveLiveCommand('bogus on').action, 'error');
    assert.equal(live.resolveLiveCommand('stream maybe').action, 'error');
    assert.deepEqual(live.getLiveSettings(), before);
  });
});
