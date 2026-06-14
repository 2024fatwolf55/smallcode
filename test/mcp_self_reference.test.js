'use strict';

// SmallCode — MCP self-reference guard tests (issue #82)
// A self-referential mcp.json entry that relaunches `smallcode --mcp` made each
// MCP server spawn another server recursively — an unbounded fork bomb that
// exhausted RAM. MCPClient._isSelfReference flags such entries so loadConfig
// can skip them. (The primary fix is host-side: --mcp mode never runs the
// client at all; this is defense-in-depth for a stale/bad config.)

const test = require('node:test');
const assert = require('node:assert/strict');

const { MCPClient } = require('../src/tools/mcp_client');

test('flags direct smallcode --mcp entries', () => {
  const cases = [
    { command: 'smallcode', args: ['--mcp'] },
    { command: 'node', args: ['/home/u/.smallcode/bin/smallcode.js', '--mcp'] },
    { command: 'npx', args: ['smallcode', '--mcp'] },
    { command: 'smolv2', args: ['--mcp'] },
  ];
  for (const cfg of cases) {
    assert.equal(MCPClient._isSelfReference(cfg), true, JSON.stringify(cfg));
  }
});

test('does NOT flag legitimate third-party MCP servers', () => {
  const cases = [
    { command: 'node', args: ['./my-server.js'] },              // no --mcp
    { command: 'uvx', args: ['mcp-server-fetch'] },
    { command: 'docker', args: ['run', 'ghcr.io/foo/bar'] },
    { command: 'smallcode', args: [] },                          // smallcode, but not --mcp
    { command: 'node', args: ['smallcode-helper.js'] },          // name match but no --mcp
  ];
  for (const cfg of cases) {
    assert.equal(MCPClient._isSelfReference(cfg), false, JSON.stringify(cfg));
  }
});

test('handles malformed configs defensively', () => {
  assert.equal(MCPClient._isSelfReference(null), false);
  assert.equal(MCPClient._isSelfReference({}), false);
  assert.equal(MCPClient._isSelfReference({ command: 'smallcode' }), false); // args undefined
  assert.equal(MCPClient._isSelfReference({ args: '--mcp' }), false);        // args not an array
});

test('loadConfig skips a self-referential entry but keeps real ones', () => {
  // loadConfig reads from disk; here we exercise the filter directly by
  // simulating what loadConfig does with a parsed mcpServers object.
  const servers = {
    'fork-bomb': { command: 'node', args: ['smallcode.js', '--mcp'] },
    'fetch': { command: 'uvx', args: ['mcp-server-fetch'] },
  };
  const kept = Object.entries(servers).filter(([, cfg]) => !MCPClient._isSelfReference(cfg));
  assert.deepEqual(kept.map(([n]) => n), ['fetch']);
});
