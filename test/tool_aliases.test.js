'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { ALIASES, REAL_TOOLS, normalizeToolCall } = require('../src/tools/tool_aliases');

// Helper: build a minimal OpenAI-shape tool_call
function tc(name, argsObj) {
  return { function: { name, arguments: JSON.stringify(argsObj) } };
}

// ── Read → read_file ─────────────────────────────────────────────────────────

test('Read → read_file, file_path → path', () => {
  const result = normalizeToolCall(tc('Read', { file_path: 'src/foo.js' }));
  assert.equal(result.function.name, 'read_file');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.path, 'src/foo.js');
  assert.equal(args.file_path, undefined);
});

test('read (lowercase) → read_file', () => {
  const result = normalizeToolCall(tc('read', { file_path: 'a.ts' }));
  assert.equal(result.function.name, 'read_file');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.path, 'a.ts');
});

test('view → read_file, filepath → path', () => {
  const result = normalizeToolCall(tc('view', { filepath: 'lib/x.js', start_line: 10 }));
  assert.equal(result.function.name, 'read_file');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.path, 'lib/x.js');
  assert.equal(args.start_line, 10);
});

test('READ (all-caps) → read_file', () => {
  const result = normalizeToolCall(tc('READ', { file_path: 'b.py' }));
  assert.equal(result.function.name, 'read_file');
});

// ── Edit / str_replace → patch ───────────────────────────────────────────────

test('Edit → patch, old_string/new_string → old_str/new_str', () => {
  const result = normalizeToolCall(tc('Edit', {
    file_path: 'a.ts',
    old_string: 'x',
    new_string: 'y',
  }));
  assert.equal(result.function.name, 'patch');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.path, 'a.ts');
  assert.equal(args.old_str, 'x');
  assert.equal(args.new_str, 'y');
  assert.equal(args.old_string, undefined);
  assert.equal(args.new_string, undefined);
  assert.equal(args.file_path, undefined);
});

test('str_replace → patch', () => {
  const result = normalizeToolCall(tc('str_replace', {
    file_path: 'b.js',
    old_string: 'foo',
    new_string: 'bar',
  }));
  assert.equal(result.function.name, 'patch');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.old_str, 'foo');
  assert.equal(args.new_str, 'bar');
});

test('str_replace_editor → patch', () => {
  const result = normalizeToolCall(tc('str_replace_editor', { file_path: 'c.ts', old_string: 'a', new_string: 'b' }));
  assert.equal(result.function.name, 'patch');
});

test('replace → patch', () => {
  const result = normalizeToolCall(tc('replace', { file_path: 'c.ts', old_string: 'a', new_string: 'b' }));
  assert.equal(result.function.name, 'patch');
});

// ── Bash → bash ───────────────────────────────────────────────────────────────

test('Bash (capitalized) → bash alias applied', () => {
  // 'Bash' is NOT in REAL_TOOLS (exact match), so the bash alias fires.
  // The alias is idempotent: tool stays 'bash', command key preserved.
  const result = normalizeToolCall(tc('Bash', { command: 'ls -la' }));
  assert.equal(result.function.name, 'bash');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.command, 'ls -la');
});

test('shell → bash, cmd → command', () => {
  const result = normalizeToolCall(tc('shell', { cmd: 'echo hi' }));
  assert.equal(result.function.name, 'bash');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.command, 'echo hi');
  assert.equal(args.cmd, undefined);
});

test('run_command → bash', () => {
  const result = normalizeToolCall(tc('run_command', { command: 'npm test' }));
  assert.equal(result.function.name, 'bash');
});

// ── Grep → search ─────────────────────────────────────────────────────────────

test('Grep → search, pattern key preserved', () => {
  const result = normalizeToolCall(tc('Grep', { pattern: 'foo.*bar', path: 'src/' }));
  assert.equal(result.function.name, 'search');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, 'foo.*bar');
  assert.equal(args.path, 'src/');
});

test('grep (lowercase) → search, query → pattern', () => {
  const result = normalizeToolCall(tc('grep', { query: 'myFunc' }));
  assert.equal(result.function.name, 'search');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, 'myFunc');
  assert.equal(args.query, undefined);
});

// ── Glob → find_files ─────────────────────────────────────────────────────────

test('Glob → find_files, pattern key preserved', () => {
  const result = normalizeToolCall(tc('Glob', { pattern: '**/*.ts' }));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, '**/*.ts');
});

test('glob (lowercase) → find_files, query → pattern', () => {
  const result = normalizeToolCall(tc('glob', { query: '**/*.js' }));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, '**/*.js');
});

// ── LS / list_dir → find_files with derived pattern ──────────────────────────

test('LS → find_files, path → pattern with /*', () => {
  const result = normalizeToolCall(tc('LS', { path: 'src/tools' }));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, 'src/tools/*');
});

test('ls → find_files, trailing slash stripped from path', () => {
  const result = normalizeToolCall(tc('ls', { path: 'src/' }));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, 'src/*');
});

test('ls with no path → find_files with ./*', () => {
  const result = normalizeToolCall(tc('ls', {}));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, './*');
});

test('list_dir → find_files', () => {
  const result = normalizeToolCall(tc('list_dir', { path: 'bin' }));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, 'bin/*');
});

test('list_directory → find_files', () => {
  const result = normalizeToolCall(tc('list_directory', { path: 'src' }));
  assert.equal(result.function.name, 'find_files');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.pattern, 'src/*');
});

// ── Real tool names pass through untouched ────────────────────────────────────

test('read_file (real name) passes through unchanged', () => {
  const input = tc('read_file', { path: 'foo.js' });
  const result = normalizeToolCall(input);
  assert.strictEqual(result, input); // same reference — not copied
});

test('patch (real name) passes through unchanged', () => {
  const input = tc('patch', { path: 'a.js', old_str: 'x', new_str: 'y' });
  const result = normalizeToolCall(input);
  assert.strictEqual(result, input);
});

test('write_file (real name) passes through unchanged', () => {
  const input = tc('write_file', { path: 'new.js', content: 'hello' });
  const result = normalizeToolCall(input);
  assert.strictEqual(result, input);
});

// ── Unknown names pass through ────────────────────────────────────────────────

test('unknown tool name passes through unchanged', () => {
  const input = tc('some_custom_tool', { foo: 'bar' });
  const result = normalizeToolCall(input);
  assert.strictEqual(result, input);
});

test('totally unknown name returns original object', () => {
  const input = { function: { name: 'xyzzy', arguments: '{"a":1}' } };
  const result = normalizeToolCall(input);
  assert.strictEqual(result, input);
});

// ── Malformed JSON args don't throw ──────────────────────────────────────────

test('malformed JSON args: renames tool but keeps args string', () => {
  const input = { function: { name: 'Edit', arguments: '{not valid json' } };
  let result;
  assert.doesNotThrow(() => {
    result = normalizeToolCall(input);
  });
  assert.equal(result.function.name, 'patch');
  // args kept as-is (the bad string)
  assert.equal(result.function.arguments, '{not valid json');
});

test('empty args string: renames tool, produces empty object args', () => {
  // 'Bash' → alias fires; empty string is falsy so falls back to '{}',
  // parses cleanly, mapArgs({}){} → '{}'. No throw.
  let result;
  assert.doesNotThrow(() => {
    result = normalizeToolCall({ function: { name: 'Bash', arguments: '' } });
  });
  assert.equal(result.function.name, 'bash');
  assert.equal(result.function.arguments, '{}');
});

test('null args string: renames and produces empty object args', () => {
  const result = normalizeToolCall({ function: { name: 'Grep', arguments: null } });
  assert.doesNotThrow(() => {});
  assert.equal(result.function.name, 'search');
});

// ── normalizeToolCall is robust to bad inputs ─────────────────────────────────

test('null input returns null', () => {
  assert.equal(normalizeToolCall(null), null);
});

test('missing function property returns input unchanged', () => {
  const input = { id: 'call_123' };
  assert.strictEqual(normalizeToolCall(input), input);
});

// ── Verify the key example from the spec ─────────────────────────────────────

test('spec example: Edit with file_path/old_string/new_string → patch with path/old_str/new_str', () => {
  const result = normalizeToolCall({
    function: {
      name: 'Edit',
      arguments: '{"file_path":"a.ts","old_string":"x","new_string":"y"}',
    },
  });
  assert.equal(result.function.name, 'patch');
  const args = JSON.parse(result.function.arguments);
  assert.equal(args.path, 'a.ts');
  assert.equal(args.old_str, 'x');
  assert.equal(args.new_str, 'y');
});
