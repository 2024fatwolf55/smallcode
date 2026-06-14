'use strict';

// SmallCode — AgentLoader + TeamLoader tests
// Pins: frontmatter CRLF, tools array parsing, missing dir tolerance,
// drafts quarantine, team yaml parsing.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { AgentLoader } = require('../src/plugins/agent_loader');
const { TeamLoader } = require('../src/plugins/team_loader');

function freshProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-agents-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ── AgentLoader ───────────────────────────────────────────────────────────────

test('AgentLoader: missing agents dir returns empty list', () => {
  const dir = freshProject();
  const loader = new AgentLoader(dir);
  assert.deepEqual(loader.list(), []);
  assert.equal(loader.get('anything'), null);
});

test('AgentLoader: LF frontmatter parses name/description/tools/model', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'agents', 'reviewer.md'),
    '---\nname: reviewer\ndescription: reviews code\ntools: [read_file, search]\nmodel: fast\n---\nYou are a reviewer.\n',
  );
  const loader = new AgentLoader(dir);
  const agent = loader.get('reviewer');
  assert.ok(agent, 'agent should load');
  assert.equal(agent.name, 'reviewer');
  assert.equal(agent.description, 'reviews code');
  assert.deepEqual(agent.tools, ['read_file', 'search']);
  assert.equal(agent.model, 'fast');
  assert.match(agent.body, /You are a reviewer/);
});

test('AgentLoader: CRLF frontmatter parses correctly (issue #52 parity)', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'agents', 'crlf-agent.md'),
    '---\r\nname: crlf-agent\r\ndescription: crlf test\r\ntools: [read_file]\r\nmodel: default\r\n---\r\nCRLF body.\r\n',
  );
  const loader = new AgentLoader(dir);
  const agent = loader.get('crlf-agent');
  assert.ok(agent, 'should load despite CRLF');
  assert.equal(agent.model, 'default');
  assert.deepEqual(agent.tools, ['read_file']);
  assert.match(agent.body, /CRLF body/);
});

test('AgentLoader: falls back to filename stem when no name in frontmatter', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'agents', 'my-agent.md'),
    '---\ndescription: unnamed\ntools: []\n---\nbody\n',
  );
  const loader = new AgentLoader(dir);
  assert.ok(loader.get('my-agent'), 'should resolve by filename stem');
});

test('AgentLoader: no-frontmatter file loads body using filename stem', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'agents', 'plain.md'),
    'Just a plain body with no frontmatter.\n',
  );
  const loader = new AgentLoader(dir);
  const agent = loader.get('plain');
  assert.ok(agent);
  assert.match(agent.body, /plain body/);
  assert.deepEqual(agent.tools, []);
});

test('AgentLoader: tools array with inline array syntax', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'agents', 'multi.md'),
    '---\nname: multi\ntools: [read_file, write_file, bash]\n---\nbody\n',
  );
  const loader = new AgentLoader(dir);
  const agent = loader.get('multi');
  assert.deepEqual(agent.tools, ['read_file', 'write_file', 'bash']);
});

test('AgentLoader: drafts/ subdirectory is quarantined (never loaded)', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'agents', 'drafts', 'draft-agent.md'),
    '---\nname: draft-agent\n---\nbody\n',
  );
  const loader = new AgentLoader(dir);
  assert.equal(loader.get('draft-agent'), null, 'draft agent must not auto-load');
  assert.equal(loader.list().length, 0);
});

test('AgentLoader: multiple agents coexist', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'agents', 'a.md'), '---\nname: alpha\ntools: [read_file]\n---\nbody a\n');
  write(path.join(dir, '.smallcode', 'agents', 'b.md'), '---\nname: beta\ntools: [bash]\n---\nbody b\n');
  const loader = new AgentLoader(dir);
  assert.equal(loader.list().length, 2);
  assert.ok(loader.get('alpha'));
  assert.ok(loader.get('beta'));
});

// ── TeamLoader ────────────────────────────────────────────────────────────────

test('TeamLoader: missing teams dir returns empty list', () => {
  const dir = freshProject();
  const loader = new TeamLoader(dir);
  assert.deepEqual(loader.list(), []);
  assert.equal(loader.get('anything'), null);
});

test('TeamLoader: parses name/description/agents inline list', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'teams', 'review-pipeline.yaml'),
    'name: review-pipeline\ndescription: full review flow\nagents: [planner, reviewer, critic]\n',
  );
  const loader = new TeamLoader(dir);
  const team = loader.get('review-pipeline');
  assert.ok(team);
  assert.equal(team.name, 'review-pipeline');
  assert.equal(team.description, 'full review flow');
  assert.deepEqual(team.agents, ['planner', 'reviewer', 'critic']);
});

test('TeamLoader: CRLF yaml parses correctly', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'teams', 'crlf-team.yaml'),
    'name: crlf-team\r\ndescription: crlf test\r\nagents: [a, b]\r\n',
  );
  const loader = new TeamLoader(dir);
  const team = loader.get('crlf-team');
  assert.ok(team);
  assert.deepEqual(team.agents, ['a', 'b']);
});

test('TeamLoader: falls back to filename stem when no name field', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'teams', 'my-team.yaml'),
    'description: no name field\nagents: [x]\n',
  );
  const loader = new TeamLoader(dir);
  const team = loader.get('my-team');
  assert.ok(team, 'should resolve by filename stem');
  assert.deepEqual(team.agents, ['x']);
});

test('TeamLoader: drafts/ subdirectory is quarantined', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'teams', 'drafts', 'draft-team.yaml'),
    'name: draft-team\nagents: [a]\n',
  );
  const loader = new TeamLoader(dir);
  assert.equal(loader.get('draft-team'), null, 'draft team must not auto-load');
});

test('TeamLoader: accepts .yml extension as well as .yaml', () => {
  const dir = freshProject();
  write(
    path.join(dir, '.smallcode', 'teams', 'alt.yml'),
    'name: alt-team\nagents: [p, q]\n',
  );
  const loader = new TeamLoader(dir);
  const team = loader.get('alt-team');
  assert.ok(team);
  assert.deepEqual(team.agents, ['p', 'q']);
});
