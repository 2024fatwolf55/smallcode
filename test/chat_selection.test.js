'use strict';

// SmallCode — chat panel mouse selection tests
// Drag-to-highlight + copy in the fullscreen TUI chat panel. Tool panel and
// input area must not select; the 10-char role gutter ('  USER  │ ') never
// highlights or copies; clipboard receives ANSI-stripped text.

const test = require('node:test');
const assert = require('node:assert/strict');

const { FullScreenTUI } = require('../src/tui/fullscreen');

// SGR mouse encodings
const press = (x, y) => `\x1b[<0;${x};${y}M`;
const drag = (x, y) => `\x1b[<32;${x};${y}M`;
const release = (x, y) => `\x1b[<0;${x};${y}m`;

// Chat lines as addChat builds them: 8-char role label + '│ ' = 10-char
// gutter, then the message text. Text starts at 1-based column 11.
const USER = '  USER  │ ';
const CONT = '        │ ';

function makeTui(lines) {
  const tui = new FullScreenTUI();
  tui.chatLines = lines;
  tui.chatHeight = 10;
  tui.chatWidth = 40;
  tui.toolWidth = 30;
  tui.chatScroll = 0;
  tui.copied = null;
  tui._copyToClipboard = (text) => { tui.copied = text; };
  tui.addTool = () => {};
  return tui;
}

test('drag across two lines copies the span without gutter text', () => {
  const tui = makeTui([USER + 'hello world', CONT + 'second line']);
  tui._onMouseSelect(press(17, 1));   // "w" of world (col 16, 0-based)
  tui._onMouseSelect(drag(16, 2));    // "d" of second
  tui._onMouseSelect(release(16, 2));
  assert.equal(tui.copied, 'world\nsecond');
  assert.equal(tui.selection, null, 'selection cleared after copy');
});

test('single-line selection respects column bounds', () => {
  const tui = makeTui([USER + 'hello world']);
  tui._onMouseSelect(press(11, 1));
  tui._onMouseSelect(drag(15, 1));
  tui._onMouseSelect(release(15, 1));
  assert.equal(tui.copied, 'hello');
});

test('drag starting in the gutter selects from the text start', () => {
  const tui = makeTui([USER + 'hello world']);
  tui._onMouseSelect(press(2, 1));    // inside "  USER  " label
  tui._onMouseSelect(drag(15, 1));
  tui._onMouseSelect(release(15, 1));
  assert.equal(tui.copied, 'hello');
});

test('gutter is never included on continuation lines', () => {
  const tui = makeTui([USER + 'first', CONT + 'middle', CONT + 'last line']);
  tui._onMouseSelect(press(11, 1));
  tui._onMouseSelect(drag(14, 3));
  tui._onMouseSelect(release(14, 3));
  assert.equal(tui.copied, 'first\nmiddle\nlast');
});

test('reverse drag (bottom-up) normalizes to the same text', () => {
  const tui = makeTui([USER + 'hello world', CONT + 'second line']);
  tui._onMouseSelect(press(16, 2));
  tui._onMouseSelect(drag(17, 1));
  tui._onMouseSelect(release(17, 1));
  assert.equal(tui.copied, 'world\nsecond');
});

test('ANSI color codes are stripped from copied text', () => {
  const tui = makeTui(['\x1b[36m  USER  \x1b[0m│ \x1b[32mgreen text\x1b[0m here']);
  tui._onMouseSelect(press(11, 1));
  tui._onMouseSelect(drag(20, 1));
  tui._onMouseSelect(release(20, 1));
  assert.equal(tui.copied, 'green text');
});

test('clicks in the tool panel do not start a selection', () => {
  const tui = makeTui([USER + 'hello world']);
  tui._onMouseSelect(press(45, 1)); // beyond chatWidth=40
  assert.equal(tui.selection, null);
  assert.equal(tui._selecting, false);
});

test('clicks below the chat panel do not start a selection', () => {
  const tui = makeTui([USER + 'hello world']);
  tui._onMouseSelect(press(5, 12)); // beyond chatHeight=10
  assert.equal(tui.selection, null);
});

test('selection accounts for chat scroll offset', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(CONT + `line-${i}`);
  const tui = makeTui(lines);
  tui.chatScroll = -5; // scrolled up 5 lines: top visible row = line-15
  tui._onMouseSelect(press(11, 1));
  tui._onMouseSelect(drag(17, 1));
  tui._onMouseSelect(release(17, 1));
  assert.equal(tui.copied, 'line-15');
});

test('highlight covers the selected span but not the gutter', () => {
  const tui = makeTui([USER + 'hello world']);
  tui._onMouseSelect(press(2, 1));   // starts in the gutter
  tui._onMouseSelect(drag(15, 1));
  const out = tui._highlightSelection(0, USER + 'hello world');
  assert.equal(out, USER + '\x1b[7mhello\x1b[27m world');
});

test('selection entirely inside the gutter copies nothing', () => {
  const tui = makeTui([USER + 'hello world']);
  tui._onMouseSelect(press(2, 1));
  tui._onMouseSelect(drag(6, 1));
  tui._onMouseSelect(release(6, 1));
  assert.equal(tui.copied, null, 'no clipboard write for gutter-only selection');
});

test('dwelling at the bottom edge auto-scrolls down', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(CONT + `line-${i}`);
  const tui = makeTui(lines);
  tui.chatScroll = -5; // visible: line-15 .. line-24
  tui._onMouseSelect(press(11, 1));    // anchor line-15
  tui._onMouseSelect(drag(17, 10));    // reach bottom edge — no scroll yet
  assert.equal(tui.chatScroll, -5, 'first edge event selects, does not scroll');
  tui._onMouseSelect(drag(17, 10));    // dwell → -4
  assert.equal(tui.chatScroll, -4);
  tui._onMouseSelect(drag(17, 10));    // dwell → -3
  assert.equal(tui.chatScroll, -3);
  tui._onMouseSelect(release(17, 10)); // head followed the scroll to line-26
  assert.match(tui.copied, /^line-15\n/);
  assert.match(tui.copied, /line-26$/);
});

test('dwelling at the top edge auto-scrolls up', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(CONT + `line-${i}`);
  const tui = makeTui(lines);                  // visible: line-20 .. line-29
  tui._onMouseSelect(press(17, 5));            // anchor end of line-24
  tui._onMouseSelect(drag(11, 1));             // reach top edge — no scroll yet
  assert.equal(tui.chatScroll, 0, 'first edge event selects, does not scroll');
  tui._onMouseSelect(drag(11, 1));             // dwell → -1
  assert.equal(tui.chatScroll, -1);
  tui._onMouseSelect(release(11, 1));          // head = line-19 text start
  assert.match(tui.copied, /^line-19\n/);
  assert.match(tui.copied, /line-24$/);
});

test('dragging past the panel bottom scrolls immediately', () => {
  const lines = [];
  for (let i = 0; i < 30; i++) lines.push(CONT + `line-${i}`);
  const tui = makeTui(lines);
  tui.chatScroll = -5;
  tui._onMouseSelect(press(11, 1));
  tui._onMouseSelect(drag(17, 12));    // y beyond chatHeight → immediate scroll
  assert.equal(tui.chatScroll, -4);
});

test('auto-scroll clamps at the ends of history', () => {
  const tui = makeTui([USER + 'only line']);   // fewer lines than chatHeight
  tui._onMouseSelect(press(11, 1));
  tui._onMouseSelect(drag(15, 10));            // bottom edge at scroll 0
  assert.equal(tui.chatScroll, 0, 'cannot scroll past the newest line');
  tui._onMouseSelect(drag(15, 1));             // top edge with no history
  assert.equal(tui.chatScroll, 0, 'cannot scroll past the oldest line');
});

test('wheel events are not consumed by selection handler', () => {
  const tui = makeTui([USER + 'hello world']);
  const consumed = tui._onMouseSelect('\x1b[<64;5;5M');
  assert.equal(consumed, false);
});
