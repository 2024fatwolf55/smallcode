'use strict';

// SmallCode — live TUI primitives (issue #77)
// toolStart/toolEnd rewrite a single tool line in place; setContextMeter
// formats the footer indicator; TokenMonitor.contextMeter reports usage.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FullScreenTUI } = require('../src/tui/fullscreen');
const { TokenMonitor } = require('../bin/token_monitor');

function makeTui() {
  const tui = new FullScreenTUI();
  tui.render = () => {};
  return tui;
}

const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

test('toolStart pushes one ⚙ line; toolEnd rewrites the SAME line in place', () => {
  const tui = makeTui();
  const before = tui.chatLines.length;
  const h = tui.toolStart('write_file', 'hello.py');
  assert.equal(tui.chatLines.length, before + 1, 'exactly one line added');
  assert.match(strip(tui.chatLines[h.chatIdx]), /⚙.*write_file.*hello\.py/);

  tui.toolEnd(h, 'ok', 'wrote 12 lines');
  assert.equal(tui.chatLines.length, before + 1, 'no extra line on completion');
  assert.match(strip(tui.chatLines[h.chatIdx]), /✓.*write_file.*wrote 12 lines/);
});

test('toolEnd marks errors with ✗', () => {
  const tui = makeTui();
  const h = tui.toolStart('bash', 'npm test');
  tui.toolEnd(h, 'err', 'Exit code 1');
  assert.match(strip(tui.chatLines[h.chatIdx]), /✗.*bash.*Exit code 1/);
});

test('toolEnd survives interleaved lines (index stays anchored)', () => {
  const tui = makeTui();
  const h = tui.toolStart('read_file', 'a.js');
  tui.addTool('router', 'ok', 'plan');     // unrelated line pushed in between
  tui.toolEnd(h, 'ok', 'read 40 lines');
  assert.match(strip(tui.chatLines[h.chatIdx]), /✓.*read_file.*read 40 lines/);
  assert.match(strip(tui.chatLines[h.chatIdx + 1]), /router/);  // the interleaved line is intact
});

test('toolEnd falls back to a fresh line when the handle is missing', () => {
  const tui = makeTui();
  const before = tui.chatLines.length;
  tui.toolEnd(null, 'ok', 'orphan');
  assert.equal(tui.chatLines.length, before + 1);
});

test('setContextMeter formats percent + token counts', () => {
  const tui = makeTui();
  tui.setContextMeter(42, 13000, 32000);
  assert.equal(tui.contextMeter, 'ctx 42% (13.0k/32.0k)');
  tui.setContextMeter(null);
  assert.equal(tui.contextMeter, '');
});

test('TokenMonitor.contextMeter reports last prompt vs window', () => {
  const tm = new TokenMonitor();
  tm.recordCall(8000, 200);
  tm.recordCall(16000, 300);                 // most recent prompt = 16000
  const m = tm.contextMeter(32000);
  assert.equal(m.used, 16000);
  assert.equal(m.window, 32000);
  assert.equal(Math.round(m.pct), 50);
});
