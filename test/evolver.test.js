'use strict';

// SmallCode — Evolver (create-mode) tests
// Pins the deterministic mechanics behind /evolve: proposal validation,
// quarantined draft writing, the structural 1-create-per-run cap, friction
// extraction from traces, and the SkillManager drafts quarantine.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const evolver = require('../src/plugins/evolver');
const { extractFrictionSignals, formatReportForPrompt } = require('../src/plugins/friction_analyzer');
const { appendEntry, readEntries } = require('../src/plugins/audit_log');
const { SkillManager } = require('../src/plugins/skills');

function freshProject() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sc-evolver-'));
}

function trace(id, prompt, steps = []) {
  return { id, prompt, steps, tokens: { prompt: 0, completion: 0 } };
}

function failedStep(tool, file) {
  return { type: 'tool_call', name: tool, args: JSON.stringify({ path: file }), result: '✗ failed' };
}

// ── Proposal building + validation ───────────────────────────────────────

test('buildSkillProposal returns a complete create proposal', () => {
  const p = evolver.buildSkillProposal('my-skill', 'does things', 'Body here.', {
    trigger: 'match', keywords: ['foo'], rationale: 'seen 3x',
  });
  assert.equal(p.kind, 'create');
  assert.equal(p.artefact, 'skill');
  assert.equal(p.trigger, 'match');
  assert.deepEqual(p.keywords, ['foo']);
});

test('validateProposal accepts a valid proposal', () => {
  const p = evolver.buildSkillProposal('ok-name', 'desc', 'body');
  assert.deepEqual(evolver.validateProposal(p), []);
});

test('validateProposal rejects bad names, empty fields, newline descriptions', () => {
  const bad = (over) => evolver.validateProposal({
    ...evolver.buildSkillProposal('ok', 'desc', 'body'), ...over,
  });
  assert.ok(bad({ name: 'has space' }).length > 0);
  assert.ok(bad({ name: '../traverse' }).length > 0);
  assert.ok(bad({ name: '' }).length > 0);
  assert.ok(bad({ description: '' }).length > 0);
  assert.ok(bad({ description: 'line1\nline2' }).length > 0, 'newline = frontmatter injection');
  assert.ok(bad({ body: '  ' }).length > 0);
  assert.ok(bad({ trigger: 'bogus' }).length > 0);
});

test('validateProposal requires keywords for match trigger', () => {
  const p = evolver.buildSkillProposal('m', 'd', 'b', { trigger: 'match', keywords: [] });
  assert.ok(evolver.validateProposal(p).length > 0);
});

// ── Collision check ───────────────────────────────────────────────────────

test('checkNameCollision finds existing flat and draft skills', () => {
  const dir = freshProject();
  const skillsDir = path.join(dir, '.smallcode', 'skills');
  fs.mkdirSync(path.join(skillsDir, 'drafts'), { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'live-skill.md'), '---\nname: live-skill\n---\nx');
  fs.writeFileSync(path.join(skillsDir, 'drafts', 'pending.md'), '---\nname: pending\n---\nx');

  assert.ok(evolver.checkNameCollision('live-skill', dir));
  assert.ok(evolver.checkNameCollision('pending', dir));
  assert.equal(evolver.checkNameCollision('brand-new', dir), null);
});

// ── Draft writing + cap ───────────────────────────────────────────────────

test('writeDraft writes to drafts/ quarantine with frontmatter', () => {
  const dir = freshProject();
  const p = evolver.buildSkillProposal('drafted', 'a draft', 'Draft body.', { rationale: 'why' });
  const target = evolver.writeDraft(p, dir);
  assert.match(target, /[\\/]drafts[\\/]drafted\.md$/);
  const content = fs.readFileSync(target, 'utf-8');
  assert.match(content, /^---\nname: drafted\n/);
  assert.match(content, /Draft body\./);
  assert.match(content, /Rationale: why/);
});

test('writeDraft refuses invalid proposals', () => {
  const dir = freshProject();
  assert.throws(() => evolver.writeDraft({ artefact: 'skill', name: 'x y', body: 'b' }, dir));
});

test('EvolverRun allows one create, raises on the second', () => {
  const dir = freshProject();
  const run = new evolver.EvolverRun();
  run.writeDraft(evolver.buildSkillProposal('first', 'd', 'b'), dir);
  assert.throws(
    () => run.writeDraft(evolver.buildSkillProposal('second', 'd', 'b'), dir),
    evolver.ProposalCapExceededError
  );
  assert.equal(run.createsSoFar, 1);
});

// ── Friction analysis ─────────────────────────────────────────────────────

test('extractFrictionSignals returns empty report for no traces', () => {
  const r = extractFrictionSignals([]);
  assert.deepEqual(r.repeated_patterns, []);
  assert.deepEqual(r.tool_retry_loops, []);
  assert.equal(r.analyzed_traces, 0);
});

test('three near-identical prompts flag a repeated pattern', () => {
  const traces = [
    trace('a1', 'convert this csv file to json format'),
    trace('a2', 'convert the csv file into json format please'),
    trace('a3', 'csv file convert to json format again'),
    trace('b1', 'write unit tests for the auth module'),
  ];
  const r = extractFrictionSignals(traces);
  assert.equal(r.repeated_patterns.length, 1);
  assert.equal(r.repeated_patterns[0].count, 3);
  assert.deepEqual(r.repeated_patterns[0].traceIds.sort(), ['a1', 'a2', 'a3']);
});

test('repeated pattern covered by an existing skill keyword is suppressed', () => {
  const traces = [
    trace('a1', 'convert this csv file to json format'),
    trace('a2', 'convert the csv file into json format please'),
    trace('a3', 'csv file convert to json format again'),
  ];
  const r = extractFrictionSignals(traces, { skillKeywords: ['csv'] });
  assert.equal(r.repeated_patterns.length, 0);
});

test('three consecutive same-tool failures flag a retry loop', () => {
  const t = trace('t1', 'fix the parser', [
    failedStep('patch', 'src/parser.js'),
    failedStep('patch', 'src/parser.js'),
    failedStep('patch', 'src/parser.js'),
  ]);
  const r = extractFrictionSignals([t]);
  assert.equal(r.tool_retry_loops.length, 1);
  assert.equal(r.tool_retry_loops[0].failCount, 3);
  assert.equal(r.tool_retry_loops[0].tool, 'patch');
});

test('interrupted failures do not flag a retry loop', () => {
  const t = trace('t1', 'fix it', [
    failedStep('patch', 'a.js'),
    failedStep('patch', 'a.js'),
    { type: 'tool_call', name: 'read_file', args: '{"path":"a.js"}', result: 'content' },
    failedStep('patch', 'a.js'),
  ]);
  const r = extractFrictionSignals([t]);
  assert.equal(r.tool_retry_loops.length, 0);
});

test('formatReportForPrompt stays compact', () => {
  const r = extractFrictionSignals([
    trace('a1', 'x'.repeat(500) + ' aaa bbb ccc'),
  ]);
  assert.ok(formatReportForPrompt(r).length <= 2000);
});

// ── Drafts quarantine in SkillManager ─────────────────────────────────────

test('SkillManager never auto-loads skills from drafts/', () => {
  const dir = freshProject();
  const draftsDir = path.join(dir, '.smallcode', 'skills', 'drafts');
  fs.mkdirSync(draftsDir, { recursive: true });
  fs.writeFileSync(path.join(draftsDir, 'lurker.md'), '---\nname: lurker\ntrigger: auto\n---\nshould not load');

  const sm = new SkillManager(dir);
  assert.equal(sm.get('lurker'), null, 'draft must stay quarantined');
});

test('promoteDraft moves draft live and a fresh SkillManager loads it', () => {
  const dir = freshProject();
  evolver.writeDraft(evolver.buildSkillProposal('riser', 'promoted skill', 'Now live.'), dir);

  const sm = new SkillManager(dir);
  assert.equal(sm.get('riser'), null);
  const target = sm.promoteDraft('riser');
  assert.ok(target);
  assert.ok(sm.get('riser'), 'promoted skill loads in the same manager');

  const sm2 = new SkillManager(dir);
  assert.ok(sm2.get('riser'), 'promoted skill loads in a fresh manager');
  assert.equal(sm2.listDrafts().length, 0);
});

test('promoteDraft never overwrites an existing live skill', () => {
  const dir = freshProject();
  const skillsDir = path.join(dir, '.smallcode', 'skills');
  fs.mkdirSync(skillsDir, { recursive: true });
  fs.writeFileSync(path.join(skillsDir, 'taken.md'), '---\nname: taken\n---\noriginal');
  evolver.writeDraft(evolver.buildSkillProposal('taken', 'd', 'impostor'), dir);

  const sm = new SkillManager(dir);
  assert.equal(sm.promoteDraft('taken'), null);
  assert.match(fs.readFileSync(path.join(skillsDir, 'taken.md'), 'utf-8'), /original/);
});

test('listDrafts reports quarantined names', () => {
  const dir = freshProject();
  evolver.writeDraft(evolver.buildSkillProposal('one', 'd', 'b'), dir);
  const sm = new SkillManager(dir);
  assert.deepEqual(sm.listDrafts(), ['one']);
});

// ── Audit log ─────────────────────────────────────────────────────────────

test('audit log appends and reads back entries', () => {
  const dir = freshProject();
  const file = path.join(dir, '.smallcode', 'evolver-audit.jsonl');
  appendEntry(file, { ts: 't1', kind: 'create', name: 'a' });
  appendEntry(file, { ts: 't2', kind: 'create', name: 'b' });
  const entries = readEntries(file);
  assert.equal(entries.length, 2);
  assert.equal(entries[1].name, 'b');
});

test('logCreateEvent writes a well-formed audit row', () => {
  const dir = freshProject();
  const file = path.join(dir, '.smallcode', 'evolver-audit.jsonl');
  const p = evolver.buildSkillProposal('logged', 'd', 'b', { rationale: 'because' });
  evolver.logCreateEvent(file, p, 'because', ['t1', 't2']);
  const [e] = readEntries(file);
  assert.equal(e.kind, 'create');
  assert.equal(e.artefact, 'skill');
  assert.equal(e.name, 'logged');
  assert.deepEqual(e.source_traces, ['t1', 't2']);
  assert.ok(e.ts);
});
