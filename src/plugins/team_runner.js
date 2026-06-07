// SmallCode — Team Runner
// Sequential pipeline: each agent's output becomes the next agent's task input.
// No parallelism — local inference performance trap.
//
// Returns: { output, steps, tokens, perAgent: [{name, steps, tokens, error?}] }

'use strict';

const { AgentLoader } = require('./agent_loader');
const { AgentRunner } = require('./agent_runner');

/**
 * Run a team pipeline.
 * @param {object} teamDef  - { name, agents: string[] }
 * @param {string} task     - Initial task for the first agent
 * @param {object} ctx      - { config, flags, tui, skillManager }
 * @param {AgentLoader} agentLoader - Loader to resolve agent definitions
 * @returns {Promise<{output: string, steps: number, tokens: number, perAgent: object[]}>}
 */
async function runTeam(teamDef, task, ctx, agentLoader) {
  const perAgent = [];
  let currentTask = task;
  let totalSteps = 0;
  let totalTokens = 0;

  for (const agentName of (teamDef.agents || [])) {
    const agentDef = agentLoader.get(agentName);
    if (!agentDef) {
      const result = { name: agentName, steps: 0, tokens: 0, error: `Agent "${agentName}" not found` };
      perAgent.push(result);
      // Propagate as task for next agent so the pipeline can continue
      currentTask = `[error from ${agentName}: ${result.error}] ${currentTask}`;
      continue;
    }

    const runner = new AgentRunner(agentDef, ctx);
    const result = await runner.run(currentTask);

    perAgent.push({ name: agentName, steps: result.steps, tokens: result.tokens, error: result.error });
    totalSteps += result.steps;
    totalTokens += result.tokens;

    // Next agent's input = this agent's output (pipeline semantics)
    currentTask = result.output || `(${agentName} produced no output)`;
  }

  return { output: currentTask, steps: totalSteps, tokens: totalTokens, perAgent };
}

module.exports = { runTeam };
