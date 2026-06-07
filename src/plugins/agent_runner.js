// SmallCode — AgentRunner
// Runs a sub-agent as a bounded sub-conversation.
//
// Isolation guarantees:
//   - Initial history = [{role:'user', content: task}] ONLY (never parent history)
//   - Narrowed tools = agentDef.tools ∩ canonical TOOLS; always includes read_file
//   - System prompt = agent body (capped 1600 chars) + tool list line (≤600 tokens total)
//   - Non-streaming, direct fetch to model endpoint
//   - Hard caps: MAX_STEPS=15, token budget min(8000, ctx*0.3)
//   - No MCP, no plugins, no nested repair calls
//   - run() NEVER throws — always returns AgentResult {output, steps, tokens, error?}

'use strict';

const { TOOLS } = require('../../bin/tools');
const { getModelTarget, getModelTargetForModel, withModelTarget, buildAuthHeaders } = require('../../bin/config');
const { executeTool } = require('../../bin/executor');

const MAX_STEPS = 15;
const BODY_CAP = 1600;
const BODY_CAP_MARKER = '[truncated]';
const CHARS_PER_TOKEN = 4;

// All tool names in the canonical TOOLS array
const CANONICAL_TOOL_NAMES = new Set(TOOLS.map(t => t.function.name));

/**
 * Build the narrowed tool list for a sub-agent.
 * Intersection of agentDef.tools with canonical TOOLS; read_file always present.
 * @param {string[]} agentTools - tools listed in agent frontmatter
 * @returns {object[]} tool definitions
 */
function buildNarrowedTools(agentTools) {
  const requested = new Set(agentTools || []);
  // Always include read_file
  requested.add('read_file');

  return TOOLS.filter(t => {
    const name = t.function.name;
    return CANONICAL_TOOL_NAMES.has(name) && requested.has(name);
  });
}

/**
 * Build the sub-agent system prompt.
 * Agent body capped at BODY_CAP chars; tool list appended on a final line.
 * Total target: ≤600 tokens.
 * @param {object} agentDef
 * @param {object[]} tools
 * @returns {string}
 */
function buildSubAgentPrompt(agentDef, tools) {
  let body = agentDef.body || '';
  if (body.length > BODY_CAP) {
    body = body.slice(0, BODY_CAP) + ' ' + BODY_CAP_MARKER;
  }
  const toolNames = tools.map(t => t.function.name).join(', ');
  return `${body}\n\nAvailable tools: ${toolNames}`;
}

/**
 * Resolve the model target for a sub-agent.
 * If agentDef.model names a tier (fast/default/medium/strong), use getModelTarget.
 * Otherwise treat as a literal model name via getModelTargetForModel.
 * Falls back to default tier if unset.
 * @param {object} config
 * @param {object} agentDef
 * @returns {object} model target
 */
function resolveAgentTarget(config, agentDef) {
  const TIERS = new Set(['fast', 'default', 'medium', 'strong']);
  const modelField = agentDef.model;
  if (!modelField) return getModelTarget(config, 'default');
  if (TIERS.has(modelField)) return getModelTarget(config, modelField);
  return getModelTargetForModel(config, modelField);
}

class AgentRunner {
  constructor(agentDef, ctx) {
    this.agentDef = agentDef;
    this.ctx = ctx; // { config, flags, tui, skillManager }
  }

  async run(task) {
    const { agentDef, ctx } = this;
    const { config } = ctx;

    const tools = buildNarrowedTools(agentDef.tools);
    const systemPrompt = buildSubAgentPrompt(agentDef, tools);
    const target = resolveAgentTarget(config, agentDef);
    const requestConfig = withModelTarget(config, target);
    const baseUrl = target.baseUrl;

    // Token budget
    const detectedWindow = config?.context?.detected_window || 32768;
    const tokenBudget = Math.min(8000, Math.floor(detectedWindow * 0.3));

    // Isolated history — only the user task, never parent history
    const history = [{ role: 'user', content: task }];

    let steps = 0;
    let totalTokens = 0;
    let output = '';

    try {
      while (steps < MAX_STEPS) {
        const estimatedTokens = history.reduce((sum, m) => {
          const c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
          return sum + Math.ceil(c.length / CHARS_PER_TOKEN);
        }, 0);

        if (estimatedTokens > tokenBudget) {
          output = history.filter(m => m.role === 'assistant').map(m => m.content || '').join('\n').trim();
          return { output: output || '(token budget exhausted)', steps, tokens: totalTokens };
        }

        const body = {
          model: target.model,
          messages: [{ role: 'system', content: systemPrompt }, ...history],
          temperature: 0.1,
          max_tokens: 1024,
        };
        if (tools.length > 0) {
          body.tools = tools;
        }

        const headers = buildAuthHeaders(requestConfig);

        let data;
        try {
          const response = await fetch(`${baseUrl}/chat/completions`, {
            method: 'POST',
            headers,
            body: JSON.stringify(body),
          });
          if (!response.ok) {
            const errText = await response.text().catch(() => '');
            return { output: '', steps, tokens: totalTokens, error: `HTTP ${response.status}: ${errText.slice(0, 200)}` };
          }
          data = await response.json();
        } catch (fetchErr) {
          return { output: '', steps, tokens: totalTokens, error: fetchErr.message };
        }

        if (data?.usage) {
          totalTokens += (data.usage.prompt_tokens || 0) + (data.usage.completion_tokens || 0);
        }

        const choice = data?.choices?.[0];
        if (!choice) {
          return { output: '', steps, tokens: totalTokens, error: 'Empty response from model' };
        }

        const message = choice.message || {};
        history.push({ role: 'assistant', content: message.content || null, tool_calls: message.tool_calls });
        steps++;

        // If no tool calls, we have a final text response
        if (!message.tool_calls || message.tool_calls.length === 0) {
          output = (message.content || '').trim();
          return { output, steps, tokens: totalTokens };
        }

        // Check finish reason — stop if done
        if (choice.finish_reason === 'stop' || choice.finish_reason === 'end_turn') {
          output = (message.content || '').trim();
          return { output, steps, tokens: totalTokens };
        }

        // Execute tool calls — stripped ctx: no MCP, no plugins
        const toolCtx = {
          config: ctx.config,
          flags: ctx.flags || {},
          tui: ctx.tui || { renderDiff: () => null },
          memoryStore: null,
          mcpCall: async () => null,
          pluginLoader: null,
          mcpClient: null,
          skillManager: ctx.skillManager || null,
          _fullscreenRef: null,
        };

        for (const toolCall of message.tool_calls) {
          const toolName = toolCall.function?.name;
          let toolArgs;
          // No repairToolCall — on JSON.parse failure use {} and let tool error
          try {
            toolArgs = JSON.parse(toolCall.function?.arguments || '{}');
          } catch {
            toolArgs = {};
          }

          let toolResult;
          try {
            toolResult = await executeTool(toolName, toolArgs, toolCtx);
          } catch (e) {
            toolResult = { error: e.message };
          }

          const resultContent = toolResult.error
            ? `Error: ${toolResult.error}`
            : (toolResult.result || JSON.stringify(toolResult));

          history.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: resultContent,
          });
        }
      }

      // Stepped out — return whatever we have
      const lastAssistant = [...history].reverse().find(m => m.role === 'assistant');
      output = (lastAssistant?.content || '').trim();
      return { output: output || '(max steps reached)', steps, tokens: totalTokens };

    } catch (err) {
      return { output: '', steps, tokens: totalTokens, error: err.message };
    }
  }
}

module.exports = { AgentRunner, buildNarrowedTools, buildSubAgentPrompt, resolveAgentTarget };
