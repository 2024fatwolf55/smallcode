'use strict';

// SmallCode — Tool alias layer
//
// Maps OpenAI/Claude-style tool names that small models (e.g. minimax) tend
// to hallucinate onto SmallCode's real built-in tools, re-keying argument
// names as needed. Unknown names pass through unchanged.
//
// Usage (see bin/smallcode.js wiring):
//   const { normalizeToolCall } = require('../src/tools/tool_aliases');
//   message.tool_calls = message.tool_calls.map(normalizeToolCall);

// Real tool names that must NEVER be shadowed by an alias.
// If the incoming name is already one of these, pass through unchanged.
const REAL_TOOLS = new Set([
  'read_file', 'write_file', 'patch', 'bash',
  'search', 'find_files', 'memory_remember', 'memory_recall',
  'select_category', 'done',
]);

/**
 * ALIASES maps lower-cased alias names to:
 *   { tool: <real tool name>, mapArgs: (parsedArgs) => remappedArgs }
 *
 * mapArgs receives a plain object (already JSON-parsed) and returns a new
 * plain object with keys renamed according to the alias spec.
 */
const ALIASES = {
  // ── read_file ─────────────────────────────────────────────────────────────
  read: {
    tool: 'read_file',
    mapArgs(a) {
      const out = { ...a };
      // file_path / filepath → path
      if ('file_path' in out && !('path' in out)) { out.path = out.file_path; delete out.file_path; }
      if ('filepath' in out && !('path' in out)) { out.path = out.filepath; delete out.filepath; }
      // line / offset → start_line (keep start_line/end_line as-is)
      if ('line' in out && !('start_line' in out)) { out.start_line = out.line; delete out.line; }
      if ('offset' in out && !('start_line' in out)) { out.start_line = out.offset; delete out.offset; }
      return out;
    },
  },
  view: {
    tool: 'read_file',
    mapArgs(a) { return ALIASES.read.mapArgs(a); },
  },

  // ── write_file ─────────────────────────────────────────────────────────────
  write: {
    tool: 'write_file',
    mapArgs(a) {
      const out = { ...a };
      if ('file_path' in out && !('path' in out)) { out.path = out.file_path; delete out.file_path; }
      return out;
    },
  },
  create_file: {
    tool: 'write_file',
    mapArgs(a) { return ALIASES.write.mapArgs(a); },
  },
  create: {
    tool: 'write_file',
    mapArgs(a) { return ALIASES.write.mapArgs(a); },
  },

  // ── patch ──────────────────────────────────────────────────────────────────
  edit: {
    tool: 'patch',
    mapArgs(a) {
      const out = { ...a };
      if ('file_path' in out && !('path' in out)) { out.path = out.file_path; delete out.file_path; }
      if ('old_string' in out && !('old_str' in out)) { out.old_str = out.old_string; delete out.old_string; }
      if ('new_string' in out && !('new_str' in out)) { out.new_str = out.new_string; delete out.new_string; }
      return out;
    },
  },
  str_replace: {
    tool: 'patch',
    mapArgs(a) { return ALIASES.edit.mapArgs(a); },
  },
  str_replace_editor: {
    tool: 'patch',
    mapArgs(a) { return ALIASES.edit.mapArgs(a); },
  },
  replace: {
    tool: 'patch',
    mapArgs(a) { return ALIASES.edit.mapArgs(a); },
  },

  // ── bash ───────────────────────────────────────────────────────────────────
  bash: {
    tool: 'bash',
    mapArgs(a) {
      const out = { ...a };
      if ('cmd' in out && !('command' in out)) { out.command = out.cmd; delete out.cmd; }
      return out;
    },
  },
  shell: {
    tool: 'bash',
    mapArgs(a) { return ALIASES.bash.mapArgs(a); },
  },
  run_command: {
    tool: 'bash',
    mapArgs(a) { return ALIASES.bash.mapArgs(a); },
  },

  // ── search ─────────────────────────────────────────────────────────────────
  grep: {
    tool: 'search',
    mapArgs(a) {
      const out = { ...a };
      if ('query' in out && !('pattern' in out)) { out.pattern = out.query; delete out.query; }
      return out;
    },
  },

  // ── find_files ─────────────────────────────────────────────────────────────
  glob: {
    tool: 'find_files',
    mapArgs(a) {
      const out = { ...a };
      if ('query' in out && !('pattern' in out)) { out.pattern = out.query; delete out.query; }
      return out;
    },
  },
  ls: {
    tool: 'find_files',
    mapArgs(a) {
      const dir = (a && a.path) ? String(a.path).replace(/[\\/]+$/, '') : '.';
      return { pattern: dir + '/*' };
    },
  },
  list_dir: {
    tool: 'find_files',
    mapArgs(a) { return ALIASES.ls.mapArgs(a); },
  },
  list_directory: {
    tool: 'find_files',
    mapArgs(a) { return ALIASES.ls.mapArgs(a); },
  },
};

// Also register upper-case variants used by Claude Code tooling (Read, Write,
// Edit, Bash, Grep, Glob, LS) — identical mapArgs, just different key casing.
// We do this by normalising to lower-case before lookup, so no extra entries
// are needed (see normalizeToolCall below).

/**
 * Normalize a single OpenAI-shape tool_call.
 *
 * @param {{ function: { name: string, arguments: string } }} toolCall
 * @returns {object}  A new tool_call with real name + remapped args, or the
 *                    original object if no alias matched.
 */
function normalizeToolCall(toolCall) {
  if (!toolCall || !toolCall.function) return toolCall;

  const rawName = toolCall.function.name;
  if (typeof rawName !== 'string') return toolCall;

  // If the name is already an exact match to a real tool, don't touch it.
  if (REAL_TOOLS.has(rawName)) return toolCall;

  const key = rawName.toLowerCase();

  const alias = ALIASES[key];
  if (!alias) return toolCall; // unknown name — pass through unchanged

  // Parse args (robust to malformed JSON).
  let parsedArgs;
  try {
    parsedArgs = JSON.parse(toolCall.function.arguments || '{}');
    if (typeof parsedArgs !== 'object' || parsedArgs === null) parsedArgs = {};
  } catch {
    // Malformed JSON — rename the tool but keep args string as-is
    return {
      ...toolCall,
      function: {
        ...toolCall.function,
        name: alias.tool,
      },
    };
  }

  const remappedArgs = alias.mapArgs(parsedArgs);

  return {
    ...toolCall,
    function: {
      ...toolCall.function,
      name: alias.tool,
      arguments: JSON.stringify(remappedArgs),
    },
  };
}

module.exports = { ALIASES, REAL_TOOLS, normalizeToolCall };
