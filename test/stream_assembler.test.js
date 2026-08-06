'use strict';

// SmallCode — SSE stream assembler tests (issue #77, Phase B)
// Reassemble streamed OpenAI chunks into the non-streaming `data` shape and
// drive the live callbacks. Buffer parsing must tolerate split lines.

const test = require('node:test');
const assert = require('node:assert/strict');

const { StreamAssembler, parseSSEBuffer } = require('../bin/stream_assembler');

function chunk(delta, finish, usage) {
  const o = { choices: [{ delta: delta || {}, finish_reason: finish || null }] };
  if (usage) o.usage = usage;
  return o;
}

test('assembles streamed content into one message', () => {
  const a = new StreamAssembler();
  const seen = [];
  a.pushChunk(chunk({ content: 'Hel' }), { onContent: (t) => seen.push(t) });
  a.pushChunk(chunk({ content: 'lo' }), { onContent: (t) => seen.push(t) });
  a.pushChunk(chunk({}, 'stop'));
  const data = a.toData();
  assert.equal(data.choices[0].message.content, 'Hello');
  assert.equal(data.choices[0].finish_reason, 'stop');
  assert.deepEqual(seen, ['Hel', 'lo']);
  assert.equal(data.choices[0].message.tool_calls, undefined);
});

test('accumulates tool_call deltas across chunks', () => {
  const a = new StreamAssembler();
  a.pushChunk(chunk({ tool_calls: [{ index: 0, id: 'c1', function: { name: 'write_', arguments: '{"pa' } }] }));
  a.pushChunk(chunk({ tool_calls: [{ index: 0, function: { name: 'file', arguments: 'th":"x.py"}' } }] }));
  a.pushChunk(chunk({}, 'tool_calls'));
  const tc = a.toData().choices[0].message.tool_calls;
  assert.equal(tc.length, 1);
  assert.equal(tc[0].id, 'c1');
  assert.equal(tc[0].function.name, 'write_file');
  assert.deepEqual(JSON.parse(tc[0].function.arguments), { path: 'x.py' });
});

test('parallel tool_calls keyed by index', () => {
  const a = new StreamAssembler();
  a.pushChunk(chunk({ tool_calls: [{ index: 0, id: 'a', function: { name: 'read_file', arguments: '{}' } }] }));
  a.pushChunk(chunk({ tool_calls: [{ index: 1, id: 'b', function: { name: 'bash', arguments: '{}' } }] }));
  const tc = a.toData().choices[0].message.tool_calls;
  assert.equal(tc.length, 2);
  assert.deepEqual(tc.map(t => t.function.name), ['read_file', 'bash']);
});

test('routes reasoning_content to onReasoning and into the message', () => {
  const a = new StreamAssembler();
  const think = [];
  a.pushChunk(chunk({ reasoning_content: 'let me ' }), { onReasoning: (t) => think.push(t) });
  a.pushChunk(chunk({ reasoning_content: 'think' }), { onReasoning: (t) => think.push(t) });
  a.pushChunk(chunk({ content: 'answer' }, 'stop'));
  const data = a.toData();
  assert.deepEqual(think, ['let me ', 'think']);
  assert.equal(data.choices[0].message.reasoning_content, 'let me think');
  assert.equal(data.choices[0].message.content, 'answer');
});

test('captures usage from the final chunk', () => {
  const a = new StreamAssembler();
  a.pushChunk(chunk({ content: 'hi' }));
  a.pushChunk(chunk({}, 'stop', { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 }));
  assert.deepEqual(a.toData().usage, { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 });
});

test('parseSSEBuffer extracts complete events and keeps the partial tail', () => {
  const raw = 'data: {"choices":[{"delta":{"content":"A"}}]}\n'
            + 'data: [DONE]\n'
            + 'data: {"choices":[{"delta":{"con';  // split mid-line
  const { events, rest } = parseSSEBuffer(raw);
  assert.equal(events.length, 2);
  assert.equal(events[0].json.choices[0].delta.content, 'A');
  assert.equal(events[1].done, true);
  assert.equal(rest, 'data: {"choices":[{"delta":{"con');  // carried over
});

test('parseSSEBuffer ignores non-data and blank lines', () => {
  const { events } = parseSSEBuffer(': comment\n\nevent: foo\ndata: {"x":1}\n');
  assert.equal(events.length, 1);
  assert.deepEqual(events[0].json, { x: 1 });
});

test('end-to-end: split-buffer feed reconstructs the full message', () => {
  // Simulate two network reads that split a data line down the middle.
  const a = new StreamAssembler();
  let buf = '';
  const reads = [
    'data: {"choices":[{"delta":{"content":"Hel"}}]}\ndata: {"choices":[{"delta":{"cont',
    'ent":"lo"}}]}\ndata: {"choices":[{"delta":{},"finish_reason":"stop"}]}\ndata: [DONE]\n',
  ];
  for (const r of reads) {
    buf += r;
    const { events, rest } = parseSSEBuffer(buf);
    buf = rest;
    for (const ev of events) if (ev.json) a.pushChunk(ev.json);
  }
  assert.equal(a.toData().choices[0].message.content, 'Hello');
});
