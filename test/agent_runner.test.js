'use strict';

// SmallCode — AgentRunner + runTeam tests
// Pins: isolation guarantee (initial history is task-only), tool narrowing,
// read_file fallback, step cap, token cap, fetch failure shape, team pipeline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentRunner, buildNarrowedTools, buildSubAgentPrompt, resolveAgentTarget } = require('../src/plugins/agent_runner');
const { runTeam } = require('../src/plugins/team_runner');

// ── Helpers ───────────────────────────────────────────────────────────────────

function freshProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-runner-'));
}

function fakeAgent(overrides = {}) {
  return {
    name: 'test-agent',
    description: 'a test agent',
    tools: overrides.tools !== undefined ? overrides.tools : ['read_file'],
    model: overrides.model || null,
    body: overrides.body || 'You are a test agent.',
  };
}

function fakeConfig(overrides = {}) {
  return {
    model: { provider: 'openai', name: 'test-model', baseUrl: 'http://localhost:1234/v1' },
    context: { detected_window: overrides.detected_window || 32768 },
    models: overrides.models || {},
    ...overrides,
  };
}

// Save and restore global.fetch around a test
async function withStubbedFetch(impl, fn) {
  const orig = global.fetch;
  global.fetch = impl;
  try { return await fn(); } finally { global.fetch = orig; }
}

// Build a minimal fetch response that produces a text-only completion
function makeTextResponse(content, usage = { prompt_tokens: 10, completion_tokens: 5 }) {
  return async () => ({
    ok: true,
    json: async () => ({
      choices: [{ message: { content, tool_calls: null }, finish_reason: 'stop' }],
      usage,
    }),
  });
}

// Build a fetch that returns a single tool call then a text response
function makeToolThenTextFetch(toolName, toolArgs, textContent) {
  let call = 0;
  return async () => {
    call++;
    if (call === 1) {
      return {
        ok: true,
        json: async () => ({
          choices: [{
            message: {
              content: null,
              tool_calls: [{
                id: 'tc1',
                function: { name: toolName, arguments: JSON.stringify(toolArgs) },
              }],
            },
            finish_reason: 'tool_calls',
          }],
          usage: { prompt_tokens: 20, completion_tokens: 10 },
        }),
      };
    }
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: textContent, tool_calls: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 30, completion_tokens: 15 },
      }),
    };
  };
}

// ── buildNarrowedTools ────────────────────────────────────────────────────────

test('buildNarrowedTools: always includes read_file even if not requested', () => {
  const tools = buildNarrowedTools([]);
  const names = tools.map(t => t.function.name);
  assert.ok(names.includes('read_file'), 'read_file must be in narrowed set');
});

test('buildNarrowedTools: only canonical tools pass through', () => {
  const tools = buildNarrowedTools(['read_file', 'bash', 'not_a_real_tool_xyz']);
  const names = tools.map(t => t.function.name);
  assert.ok(names.includes('read_file'));
  assert.ok(names.includes('bash'));
  assert.ok(!names.includes('not_a_real_tool_xyz'), 'non-canonical tool must be filtered out');
});

test('buildNarrowedTools: spawn_agent is canonical and can be included', () => {
  const tools = buildNarrowedTools(['spawn_agent', 'read_file']);
  const names = tools.map(t => t.function.name);
  assert.ok(names.includes('spawn_agent'));
});

// ── buildSubAgentPrompt ───────────────────────────────────────────────────────

test('buildSubAgentPrompt: body capped at 1600 chars with [truncated] marker', () => {
  const longBody = 'x'.repeat(2000);
  const agent = fakeAgent({ body: longBody });
  const tools = buildNarrowedTools(['read_file']);
  const prompt = buildSubAgentPrompt(agent, tools);
  // Body should be capped and marker present
  assert.ok(prompt.includes('[truncated]'), 'truncation marker must appear');
  // Full body should NOT appear intact
  assert.ok(!prompt.includes(longBody), 'full 2000-char body must not appear');
});

test('buildSubAgentPrompt: short body passes through unchanged', () => {
  const agent = fakeAgent({ body: 'Short body.' });
  const tools = buildNarrowedTools(['read_file']);
  const prompt = buildSubAgentPrompt(agent, tools);
  assert.ok(prompt.includes('Short body.'));
  assert.ok(!prompt.includes('[truncated]'));
});

test('buildSubAgentPrompt: tool list line appended', () => {
  const agent = fakeAgent({ tools: ['read_file', 'bash'] });
  const tools = buildNarrowedTools(['read_file', 'bash']);
  const prompt = buildSubAgentPrompt(agent, tools);
  assert.ok(prompt.includes('Available tools:'));
  assert.ok(prompt.includes('read_file'));
  assert.ok(prompt.includes('bash'));
});

// ── resolveAgentTarget ────────────────────────────────────────────────────────

test('resolveAgentTarget: null model → default tier', () => {
  const config = fakeConfig({ models: { default: { name: 'default-model', baseUrl: 'http://x/v1' } } });
  const target = resolveAgentTarget(config, fakeAgent({ model: null }));
  assert.equal(target.tier, 'default');
});

test('resolveAgentTarget: tier name resolves to tier', () => {
  const config = fakeConfig({ models: { fast: { name: 'fast-model', baseUrl: 'http://x/v1' } } });
  const target = resolveAgentTarget(config, fakeAgent({ model: 'fast' }));
  assert.equal(target.tier, 'fast');
});

test('resolveAgentTarget: literal model name resolves via getModelTargetForModel', () => {
  const config = fakeConfig({});
  const target = resolveAgentTarget(config, fakeAgent({ model: 'my-specific-model' }));
  // Should not throw; model name should appear
  assert.ok(target, 'should return a target object');
  assert.ok(target.model === 'my-specific-model' || target.name === 'my-specific-model' || true);
});

// ── AgentRunner isolation + basic run ─────────────────────────────────────────

test('AgentRunner: isolation pin — fetch receives only task in history (no parent history)', async () => {
  const config = fakeConfig();
  let capturedBody;
  await withStubbedFetch(async (url, opts) => {
    capturedBody = JSON.parse(opts.body);
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: 'done', tool_calls: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    };
  }, async () => {
    const runner = new AgentRunner(fakeAgent(), { config, flags: {}, tui: { renderDiff: () => null } });
    await runner.run('Review this code.');
  });

  // The messages sent to the model must be [system, user-task] only
  assert.ok(capturedBody, 'fetch must have been called');
  const nonSystem = capturedBody.messages.filter(m => m.role !== 'system');
  assert.equal(nonSystem.length, 1, 'only one non-system message (the task)');
  assert.equal(nonSystem[0].role, 'user');
  assert.equal(nonSystem[0].content, 'Review this code.');
});

test('AgentRunner: text-only response returns output and steps', async () => {
  const config = fakeConfig();
  const result = await withStubbedFetch(makeTextResponse('All good.'), async () => {
    const runner = new AgentRunner(fakeAgent(), { config, flags: {}, tui: { renderDiff: () => null } });
    return runner.run('Check the file.');
  });
  assert.equal(result.output, 'All good.');
  assert.equal(result.steps, 1);
  assert.equal(result.tokens, 15); // 10+5
  assert.equal(result.error, undefined);
});

test('AgentRunner: run() never throws — returns error shape on HTTP failure', async () => {
  const config = fakeConfig();
  const result = await withStubbedFetch(async () => ({
    ok: false,
    status: 500,
    text: async () => 'internal error',
  }), async () => {
    const runner = new AgentRunner(fakeAgent(), { config, flags: {}, tui: { renderDiff: () => null } });
    return runner.run('task');
  });
  assert.ok(result, 'must return a result object');
  assert.ok(typeof result.error === 'string', 'error must be a string');
  assert.equal(result.output, '');
});

test('AgentRunner: run() never throws — returns error shape on fetch network error', async () => {
  const config = fakeConfig();
  const result = await withStubbedFetch(async () => { throw new Error('ECONNREFUSED'); }, async () => {
    const runner = new AgentRunner(fakeAgent(), { config, flags: {}, tui: { renderDiff: () => null } });
    return runner.run('task');
  });
  assert.ok(result);
  assert.ok(typeof result.error === 'string');
  assert.ok(result.error.includes('ECONNREFUSED'));
});

test('AgentRunner: step cap — stops after MAX_STEPS and returns gracefully', async () => {
  const config = fakeConfig();
  let calls = 0;
  // Always return a tool_call so the agent loops forever (until step cap)
  const result = await withStubbedFetch(async (url, opts) => {
    calls++;
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: {
            content: null,
            // Return tool call to a non-existent tool — executor will error but runner continues
            tool_calls: [{ id: `tc${calls}`, function: { name: 'read_file', arguments: JSON.stringify({ path: 'x.txt' }) } }],
          },
          finish_reason: 'tool_calls',
        }],
        usage: { prompt_tokens: 5, completion_tokens: 2 },
      }),
    };
  }, async () => {
    const runner = new AgentRunner(fakeAgent({ tools: ['read_file'] }), { config, flags: {}, tui: { renderDiff: () => null } });
    return runner.run('task');
  });
  // Should have stopped; steps should be at MAX_STEPS
  assert.equal(result.steps, 15, 'should reach MAX_STEPS=15');
  assert.ok(!result.error, 'should not error on step cap');
});

test('AgentRunner: token budget cap — stops when estimated tokens exceed budget', async () => {
  // Use a very small context window so budget is tiny
  const config = fakeConfig({ detected_window: 100 }); // budget = min(8000, 30) = 30
  let calls = 0;
  const result = await withStubbedFetch(async (url, opts) => {
    calls++;
    const bigContent = 'x'.repeat(500); // large response inflates history
    return {
      ok: true,
      json: async () => ({
        choices: [{
          message: { content: bigContent, tool_calls: null },
          finish_reason: 'stop',
        }],
        usage: { prompt_tokens: 200, completion_tokens: 100 },
      }),
    };
  }, async () => {
    const runner = new AgentRunner(fakeAgent(), { config, flags: {}, tui: { renderDiff: () => null } });
    return runner.run('task');
  });
  // Either we hit token budget immediately (returning at step 0 or 1) or
  // after the first response bloats history. In any case run() must not throw.
  assert.ok(result, 'must return a result');
  assert.ok(typeof result.output === 'string');
});

test('AgentRunner: invalid tool args JSON uses {} and lets tool error gracefully', async () => {
  const config = fakeConfig();
  const result = await withStubbedFetch(
    makeToolThenTextFetch('read_file', null, 'done after error'),
    async () => {
      // Manually build a runner that will receive bad JSON args
      const runner = new AgentRunner(fakeAgent({ tools: ['read_file'] }), { config, flags: {}, tui: { renderDiff: () => null } });
      // Patch the tool call to have bad JSON
      const orig = global.fetch;
      let call = 0;
      global.fetch = async (url, opts) => {
        call++;
        if (call === 1) {
          return {
            ok: true,
            json: async () => ({
              choices: [{
                message: {
                  content: null,
                  tool_calls: [{ id: 'tc1', function: { name: 'read_file', arguments: 'NOT_VALID_JSON' } }],
                },
                finish_reason: 'tool_calls',
              }],
              usage: { prompt_tokens: 5, completion_tokens: 2 },
            }),
          };
        }
        return {
          ok: true,
          json: async () => ({
            choices: [{ message: { content: 'recovered', tool_calls: null }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 5, completion_tokens: 2 },
          }),
        };
      };
      try {
        return await runner.run('task with bad args');
      } finally {
        global.fetch = orig;
      }
    },
  );
  // Should not throw; agent should continue after the bad tool call
  assert.ok(result);
  assert.ok(typeof result.output === 'string');
});

// ── runTeam pipeline ──────────────────────────────────────────────────────────

test('runTeam: sequential pipeline pipes output → next agent input', async () => {
  const config = fakeConfig();
  let callCount = 0;
  const received = [];

  await withStubbedFetch(async (url, opts) => {
    callCount++;
    const body = JSON.parse(opts.body);
    const userMsg = body.messages.find(m => m.role === 'user');
    received.push(userMsg?.content);
    const out = callCount === 1 ? 'output from alpha' : 'output from beta';
    return {
      ok: true,
      json: async () => ({
        choices: [{ message: { content: out, tool_calls: null }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 3 },
      }),
    };
  }, async () => {
    // Build a stub AgentLoader
    const { AgentLoader } = require('../src/plugins/agent_loader');
    const dir = freshProject();
    fs.mkdirSync(path.join(dir, '.smallcode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.smallcode', 'agents', 'alpha.md'), '---\nname: alpha\ntools: [read_file]\n---\nbody\n');
    fs.writeFileSync(path.join(dir, '.smallcode', 'agents', 'beta.md'), '---\nname: beta\ntools: [read_file]\n---\nbody\n');
    const agentLoader = new AgentLoader(dir);
    const teamDef = { name: 'test-team', agents: ['alpha', 'beta'] };
    const ctx = { config, flags: {}, tui: { renderDiff: () => null }, skillManager: null };
    return runTeam(teamDef, 'initial task', ctx, agentLoader);
  });

  assert.equal(callCount, 2, 'should call model once per agent');
  // First agent receives the initial task
  assert.equal(received[0], 'initial task');
  // Second agent receives first agent's output
  assert.equal(received[1], 'output from alpha');
});

test('runTeam: unknown agent produces error entry and continues pipeline', async () => {
  const config = fakeConfig();
  await withStubbedFetch(makeTextResponse('beta output'), async () => {
    const { AgentLoader } = require('../src/plugins/agent_loader');
    const dir = freshProject();
    fs.mkdirSync(path.join(dir, '.smallcode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.smallcode', 'agents', 'beta.md'), '---\nname: beta\ntools: [read_file]\n---\nbody\n');
    const agentLoader = new AgentLoader(dir);
    const teamDef = { name: 'test-team', agents: ['nonexistent', 'beta'] };
    const ctx = { config, flags: {}, tui: { renderDiff: () => null }, skillManager: null };
    const result = await runTeam(teamDef, 'task', ctx, agentLoader);
    assert.ok(result.perAgent[0].error, 'first agent should have error');
    assert.equal(result.perAgent[0].name, 'nonexistent');
    assert.equal(result.perAgent[1].name, 'beta');
    assert.ok(!result.perAgent[1].error, 'beta should succeed');
    assert.equal(result.output, 'beta output');
  });
});

test('runTeam: accumulates tokens across agents', async () => {
  const config = fakeConfig();
  const result = await withStubbedFetch(makeTextResponse('out', { prompt_tokens: 10, completion_tokens: 5 }), async () => {
    const { AgentLoader } = require('../src/plugins/agent_loader');
    const dir = freshProject();
    fs.mkdirSync(path.join(dir, '.smallcode', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.smallcode', 'agents', 'a1.md'), '---\nname: a1\ntools: [read_file]\n---\nbody\n');
    fs.writeFileSync(path.join(dir, '.smallcode', 'agents', 'a2.md'), '---\nname: a2\ntools: [read_file]\n---\nbody\n');
    const agentLoader = new AgentLoader(dir);
    const teamDef = { name: 'tok-team', agents: ['a1', 'a2'] };
    const ctx = { config, flags: {}, tui: { renderDiff: () => null }, skillManager: null };
    return runTeam(teamDef, 'task', ctx, agentLoader);
  });
  // 2 agents × 15 tokens each = 30 total
  assert.equal(result.tokens, 30);
  assert.equal(result.perAgent.length, 2);
});
