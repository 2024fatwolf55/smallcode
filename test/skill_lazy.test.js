'use strict';

// SmallCode — Lazy skill loading tests
// Verifies index-first SkillManager, lazy body loading, getIndex() fields,
// formatter output, and backward compatibility with existing callers.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { SkillManager } = require('../src/plugins/skills');
const { formatSkillIndex, formatSkillResult } = require('../src/plugins/skill_index_formatter');

function freshProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-lazy-'));
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// ── Index-only startup ────────────────────────────────────────────────────────

test('index is populated on construction without loading bodies', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'alpha.md'),
    '---\nname: alpha\ntrigger: manual\ndescription: does alpha things\n---\nbody text here');

  const sm = new SkillManager(dir);
  // _index must have the entry
  assert.ok(sm._index.has('alpha'), '_index should have alpha');
  // skills (body cache) should NOT have it yet
  assert.ok(!sm.skills.has('alpha'), 'body cache should be empty before get()');
});

test('getIndex() returns expected fields without loading bodies', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'beta.md'),
    '---\nname: beta\ntrigger: match\nkeywords: [foo, bar]\ndescription: beta desc\ntags: [t1]\nrelated: [alpha]\n---\nbeta body');

  const sm = new SkillManager(dir);
  const idx = sm.getIndex();
  const entry = idx.find(e => e.name === 'beta');
  assert.ok(entry, 'getIndex should return beta');
  assert.equal(entry.name, 'beta');
  assert.equal(entry.description, 'beta desc');
  assert.equal(entry.trigger, 'match');
  assert.deepEqual(entry.keywords, ['foo', 'bar']);
  assert.deepEqual(entry.tags, ['t1']);
  assert.deepEqual(entry.related, ['alpha']);
  assert.ok(entry.path);
  assert.equal(entry.origin, 'flat');
  // Body should still not be loaded
  assert.ok(!sm.skills.has('beta'));
});

// ── Lazy get() ────────────────────────────────────────────────────────────────

test('get() lazily loads body on first call', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'lazy.md'),
    '---\nname: lazy\ntrigger: manual\n---\nthe lazy body content');

  const sm = new SkillManager(dir);
  assert.ok(!sm.skills.has('lazy'), 'body not loaded yet');
  const skill = sm.get('lazy');
  assert.ok(skill, 'get() returns the skill');
  assert.match(skill.content, /the lazy body content/);
  assert.ok(sm.skills.has('lazy'), 'body is cached after get()');
});

test('get() caches: second call returns same object', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'cached.md'),
    '---\nname: cached\ntrigger: manual\n---\ncached body');

  const sm = new SkillManager(dir);
  const first = sm.get('cached');
  const second = sm.get('cached');
  assert.strictEqual(first, second, 'should return same cached object');
});

test('get() returns null for unknown skill', () => {
  const dir = freshProject();
  const sm = new SkillManager(dir);
  assert.equal(sm.get('nonexistent'), null);
});

// ── Backward compat: public API unchanged ─────────────────────────────────────

test('list() returns entries with name/trigger/keywords/origin', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'listme.md'),
    '---\nname: listme\ntrigger: auto\nkeywords: [x]\n---\nlist body');

  const sm = new SkillManager(dir);
  const items = sm.list();
  const item = items.find(i => i.name === 'listme');
  assert.ok(item);
  assert.equal(item.trigger, 'auto');
  assert.deepEqual(item.keywords, ['x']);
  assert.equal(item.origin, 'flat');
  // list() should NOT load bodies
  assert.ok(!sm.skills.has('listme'));
});

test('getAutoSkills() loads bodies only for matched skills', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'always.md'),
    '---\nname: always\ntrigger: auto\n---\nauto body');
  write(path.join(dir, '.smallcode', 'skills', 'keyword.md'),
    '---\nname: keyword\ntrigger: match\nkeywords: [deploy]\n---\ndeploy body');
  write(path.join(dir, '.smallcode', 'skills', 'nomatch.md'),
    '---\nname: nomatch\ntrigger: match\nkeywords: [unrelated]\n---\nnomatch body');

  const sm = new SkillManager(dir);
  const result = sm.getAutoSkills('please deploy the app');
  const names = result.map(s => s.name).sort();
  assert.deepEqual(names, ['always', 'keyword']);
  // nomatch should not be loaded
  assert.ok(!sm.skills.has('nomatch'));
});

// ── Formatter ────────────────────────────────────────────────────────────────

test('formatSkillIndex produces one line per skill', () => {
  const entries = [
    { name: 'foo', description: 'does foo', trigger: 'manual', keywords: [] },
    { name: 'bar', description: 'does bar', trigger: 'match', keywords: ['baz'] },
  ];
  const out = formatSkillIndex(entries);
  assert.ok(out.includes('foo'));
  assert.ok(out.includes('bar'));
  // Each skill on its own line
  const lines = out.split('\n').filter(l => l.includes('foo') || l.includes('bar'));
  assert.equal(lines.length, 2);
});

test('formatSkillIndex returns empty string for no entries', () => {
  assert.equal(formatSkillIndex([]), '');
  assert.equal(formatSkillIndex(null), '');
});

test('formatSkillResult includes body and related names', () => {
  const skill = { name: 'main', description: '', content: 'main body content', keywords: [], trigger: 'manual' };
  const related = [
    { name: 'other', description: 'the other skill' },
  ];
  const out = formatSkillResult(skill, related);
  assert.ok(out.includes('main body content'));
  assert.ok(out.includes('other'));
  assert.ok(out.includes('the other skill'));
});

test('formatSkillResult with no related entries', () => {
  const skill = { name: 's', content: 'solo body', keywords: [], trigger: 'manual', description: '' };
  const out = formatSkillResult(skill, []);
  assert.ok(out.includes('solo body'));
  assert.ok(!out.includes('Related skills'));
});

// ── New frontmatter fields backward compat ────────────────────────────────────

test('skills without description/tags/related still load correctly', () => {
  const dir = freshProject();
  write(path.join(dir, '.smallcode', 'skills', 'plain.md'),
    '---\nname: plain\ntrigger: manual\n---\njust a plain body');

  const sm = new SkillManager(dir);
  const skill = sm.get('plain');
  assert.ok(skill);
  assert.equal(skill.description, '');
  assert.deepEqual(skill.tags, []);
  assert.deepEqual(skill.related, []);
  assert.match(skill.content, /just a plain body/);
});

test('add() works and skill is in index immediately', () => {
  const dir = freshProject();
  const sm = new SkillManager(dir);
  sm.add('added', 'added content', { trigger: 'auto', description: 'an added skill' });

  assert.ok(sm._index.has('added'));
  const skill = sm.get('added');
  assert.ok(skill);
  assert.match(skill.content, /added content/);
});
