'use strict';

// SmallCode — input line editing tests (issues #93, #96)
// Line/word navigation and right-click paste in the fullscreen TUI input.
// Drives _onKeypress directly with raw key bytes and asserts on the resulting
// inputBuffer / inputCursor state. render() is stubbed so no terminal is needed.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FullScreenTUI } = require('../src/tui/fullscreen');

function makeTui(buffer = '', cursor = null) {
  const tui = new FullScreenTUI();
  tui.render = () => {};            // no terminal in tests
  tui.inputBuffer = buffer;
  tui.inputCursor = cursor == null ? buffer.length : cursor;
  return tui;
}

const send = (tui, key) => tui._onKeypress(Buffer.from(key, 'binary'));

// ─── Line navigation (issue #93) ───────────────────────────────────────────

test('Home (\\x1b[H) and Ctrl+A (\\x01) move to start of line', async () => {
  for (const key of ['\x1b[H', '\x1b[1~', '\x01']) {
    const tui = makeTui('hello world');
    await send(tui, key);
    assert.equal(tui.inputCursor, 0, `key ${JSON.stringify(key)}`);
  }
});

test('End (\\x1b[F) and Ctrl+E (\\x05) move to end of line', async () => {
  for (const key of ['\x1b[F', '\x1b[4~', '\x05']) {
    const tui = makeTui('hello world', 0);
    await send(tui, key);
    assert.equal(tui.inputCursor, 11, `key ${JSON.stringify(key)}`);
  }
});

// ─── Word navigation (issue #93) ───────────────────────────────────────────

test('Ctrl+Left (\\x1b[1;5D) jumps to the previous word boundary', async () => {
  const tui = makeTui('hello world foo');   // cursor at end (15)
  await send(tui, '\x1b[1;5D');
  assert.equal(tui.inputCursor, 12);        // start of "foo"
  await send(tui, '\x1b[1;5D');
  assert.equal(tui.inputCursor, 6);         // start of "world"
});

test('Ctrl+Right (\\x1b[1;5C) jumps to the next word boundary', async () => {
  const tui = makeTui('hello world foo', 0);
  await send(tui, '\x1b[1;5C');
  assert.equal(tui.inputCursor, 5);         // end of "hello"
  await send(tui, '\x1b[1;5C');
  assert.equal(tui.inputCursor, 11);        // end of "world"
});

// ─── Word / char deletion (issue #93) ──────────────────────────────────────

test('Ctrl+W (\\x17) deletes the word to the left of the cursor', async () => {
  const tui = makeTui('hello world foo');
  await send(tui, '\x17');
  assert.equal(tui.inputBuffer, 'hello world ');
  assert.equal(tui.inputCursor, 12);
});

test('Ctrl+Delete (\\x1b[3;5~) deletes the word to the right', async () => {
  const tui = makeTui('hello world foo', 6);  // cursor before "world"
  await send(tui, '\x1b[3;5~');
  assert.equal(tui.inputBuffer, 'hello  foo');
  assert.equal(tui.inputCursor, 6);
});

test('Delete (\\x1b[3~) removes the character under the cursor', async () => {
  const tui = makeTui('abc', 1);
  await send(tui, '\x1b[3~');
  assert.equal(tui.inputBuffer, 'ac');
  assert.equal(tui.inputCursor, 1);
});

test('word-delete keeps the command palette state in sync', async () => {
  const tui = makeTui('/model gpt', 10);
  await send(tui, '\x17');                    // delete the "gpt" argument
  assert.equal(tui.inputBuffer, '/model ');
  assert.equal(tui.commandPaletteOpen, true); // still a slash command
});

// ─── Right-click paste (issue #96) ─────────────────────────────────────────

test('right-click release pastes clipboard at the cursor', async () => {
  const tui = makeTui('ab', 1);
  tui._pasteFromClipboard = function () {     // stub the OS clipboard read
    const text = 'XY';
    this.inputBuffer = this.inputBuffer.slice(0, this.inputCursor) + text + this.inputBuffer.slice(this.inputCursor);
    this.inputCursor += text.length;
  };
  await send(tui, '\x1b[<2;10;5m');           // SGR button-2 (right) release
  assert.equal(tui.inputBuffer, 'aXYb');
  assert.equal(tui.inputCursor, 3);
});

test('right-click press and left-click do not trigger paste', async () => {
  let pasted = false;
  const tui = makeTui('ab', 1);
  tui._pasteFromClipboard = () => { pasted = true; };
  tui._onMouseSelect = () => true;            // swallow selection handling
  await send(tui, '\x1b[<2;10;5M');           // right-button PRESS (uppercase M)
  await send(tui, '\x1b[<0;10;5m');           // left-button release
  assert.equal(pasted, false);
});
