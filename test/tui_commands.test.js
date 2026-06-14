'use strict';

// SmallCode — TUI slash-command resolution tests (issue #80)
// resolveTuiCommand maps a raw slash command to { command, guidance }. The
// fullscreen TUI can't host /provider's interactive wizard, so a bare
// /provider is rerouted to `/provider status` plus guidance text; everything
// else (including the already-non-interactive status subcommands) passes
// through unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');

const { resolveTuiCommand, PROVIDER_GUIDANCE } = require('../bin/tui_commands');

test('bare /provider reroutes to status and attaches guidance', () => {
  const r = resolveTuiCommand('/provider');
  assert.equal(r.command, '/provider status');
  assert.equal(r.guidance, PROVIDER_GUIDANCE);
});

test('/provider status|--status|-s pass through with no guidance', () => {
  for (const sub of ['status', '--status', '-s']) {
    const r = resolveTuiCommand(`/provider ${sub}`);
    assert.equal(r.command, `/provider ${sub}`, sub);
    assert.equal(r.guidance, null, sub);
  }
});

test('an unknown /provider subcommand still reroutes to status + guidance', () => {
  const r = resolveTuiCommand('/provider reset');
  assert.equal(r.command, '/provider status');
  assert.equal(r.guidance, PROVIDER_GUIDANCE);
});

test('non-provider commands pass through untouched', () => {
  for (const cmd of ['/model', '/endpoint', '/help', '/quit']) {
    const r = resolveTuiCommand(cmd);
    assert.equal(r.command, cmd, cmd);
    assert.equal(r.guidance, null, cmd);
  }
});

test('a command that merely starts with "provider" is not matched', () => {
  // \b word boundary: /providerx is a different command, not /provider.
  const r = resolveTuiCommand('/providerx');
  assert.equal(r.command, '/providerx');
  assert.equal(r.guidance, null);
});

test('guidance points at the in-TUI alternatives and the shell wizard', () => {
  assert.match(PROVIDER_GUIDANCE, /\/endpoint/);
  assert.match(PROVIDER_GUIDANCE, /\/model/);
  assert.match(PROVIDER_GUIDANCE, /smallcode \/provider/);
});

test('non-string / empty input is handled defensively', () => {
  assert.deepEqual(resolveTuiCommand(''), { command: '', guidance: null });
  assert.deepEqual(resolveTuiCommand(undefined), { command: '', guidance: null });
});
