'use strict';

// SmallCode — OpenAI SSE stream assembler (issue #77, Phase B)
//
// Reassembles a streamed chat completion (stream:true) into the exact same
// non-streaming `data` object the rest of chatCompletion expects, so all the
// downstream logic (tool-call extraction, length recovery, usage) is untouched.
// Pure and side-effect-free except for the optional onContent/onReasoning
// callbacks, which exist purely to drive the live TUI.

class StreamAssembler {
  constructor() {
    this.content = '';
    this.reasoning = '';
    this.toolCalls = [];      // index → { id, type, function: { name, arguments } }
    this.finishReason = null;
    this.usage = null;
  }

  // Fold one parsed OpenAI streaming chunk into the running state.
  pushChunk(obj, { onContent, onReasoning } = {}) {
    if (!obj || typeof obj !== 'object') return;
    const choice = obj.choices && obj.choices[0];
    if (choice) {
      const delta = choice.delta || {};
      if (typeof delta.content === 'string' && delta.content) {
        this.content += delta.content;
        if (onContent) onContent(delta.content);
      }
      // Reasoning models (Qwen3, DeepSeek R1) stream a separate field.
      const reason = delta.reasoning_content;
      if (typeof reason === 'string' && reason) {
        this.reasoning += reason;
        if (onReasoning) onReasoning(reason);
      }
      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          const idx = Number.isInteger(tc.index) ? tc.index : 0;
          if (!this.toolCalls[idx]) {
            this.toolCalls[idx] = { id: tc.id || `call_${idx}`, type: 'function', function: { name: '', arguments: '' } };
          }
          const slot = this.toolCalls[idx];
          if (tc.id) slot.id = tc.id;
          if (tc.type) slot.type = tc.type;
          if (tc.function && tc.function.name) slot.function.name += tc.function.name;
          if (tc.function && typeof tc.function.arguments === 'string') slot.function.arguments += tc.function.arguments;
        }
      }
      if (choice.finish_reason) this.finishReason = choice.finish_reason;
    }
    // Final chunk (with stream_options.include_usage) carries usage.
    if (obj.usage) this.usage = obj.usage;
  }

  // Build the OpenAI-compatible non-streaming response object.
  toData() {
    const message = { role: 'assistant', content: this.content };
    const tcs = this.toolCalls.filter(Boolean);
    if (tcs.length) message.tool_calls = tcs;
    if (this.reasoning) message.reasoning_content = this.reasoning;
    return {
      choices: [{ message, finish_reason: this.finishReason || 'stop' }],
      usage: this.usage || undefined,
    };
  }
}

// Split an accumulating SSE text buffer into complete events. Returns
// { events, rest } where `rest` is the trailing partial line to carry over to
// the next read. Each event is { json } or { done: true }.
function parseSSEBuffer(buffer) {
  const events = [];
  let rest = String(buffer || '');
  let nl;
  while ((nl = rest.indexOf('\n')) !== -1) {
    const line = rest.slice(0, nl).trim();
    rest = rest.slice(nl + 1);
    if (!line || !line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (payload === '[DONE]') { events.push({ done: true }); continue; }
    try { events.push({ json: JSON.parse(payload) }); }
    catch { /* malformed/partial — drop this line */ }
  }
  return { events, rest };
}

module.exports = { StreamAssembler, parseSSEBuffer };
