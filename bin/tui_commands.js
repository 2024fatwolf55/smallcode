'use strict';

// Slash-command resolution for the fullscreen TUI.
//
// The fullscreen TUI captures stdout and hands slash commands a mock readline,
// so any command whose handler needs a real interactive terminal can't run
// inside it. resolveTuiCommand() maps a raw command to:
//   { command, guidance }
//     command  — the command string to pass to the normal command handler
//     guidance — extra text to append after the captured output, or null
//
// Today this only special-cases /provider (issue #80): its interactive wizard
// is swapped for a non-interactive status dump plus a pointer to the paths that
// DO work inside the TUI (/endpoint, /model, or the shell wizard). Everything
// else passes through unchanged.

// Subcommands of /provider that are already non-interactive and safe to run
// inside the TUI as-is.
const PROVIDER_STATUS_SUBS = new Set(['status', '--status', '-s']);

const PROVIDER_GUIDANCE = [
  '',
  '  The interactive provider wizard needs a real terminal and',
  '  cannot run inside the full-screen TUI. To reconfigure:',
  '    • /endpoint  — switch the API base URL here',
  '    • /model     — switch the model here',
  '    • run `smallcode /provider` from your shell for the full wizard',
].join('\n');

function resolveTuiCommand(cmd) {
  const raw = String(cmd || '');
  if (!/^\/provider\b/.test(raw)) {
    return { command: raw, guidance: null };
  }
  const sub = raw.replace(/^\/provider\s*/, '').trim();
  if (PROVIDER_STATUS_SUBS.has(sub)) {
    return { command: raw, guidance: null };
  }
  // Bare /provider (or an unknown subcommand): show status + guidance instead
  // of silently launching a wizard the TUI can't drive.
  return { command: '/provider status', guidance: PROVIDER_GUIDANCE };
}

module.exports = { resolveTuiCommand, PROVIDER_GUIDANCE };
