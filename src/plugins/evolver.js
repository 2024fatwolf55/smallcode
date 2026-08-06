// SmallCode — Evolver (create-mode mechanics)
// Deterministic mechanics behind the /evolve command: proposal building,
// validation, name-collision checking, quarantined draft writing, audit
// logging, and structural enforcement of the 1-create-per-run cap.
//
// The fuzzy judgment (is this friction worth a skill?) happens in the
// command handler via an LLM call. Everything here is pure mechanics so it
// can be unit-tested without a model.
//
// Safety rules (mirrors the create-mode evolver pattern):
// - Drafts only: writes go to .smallcode/skills/drafts/, never live dirs
// - Never deletes, never commits
// - validateProposal must pass before any write
// - EvolverRun raises on the 2nd create in a single run

const fs = require('fs');
const path = require('path');
const { appendEntry } = require('./audit_log');

const MAX_CREATES_PER_RUN = 1;
const NAME_RE = /^[A-Za-z0-9_-]+$/;
const VALID_TRIGGERS = new Set(['manual', 'auto', 'match']);

class ProposalCapExceededError extends Error {}

// ── Builders ──────────────────────────────────────────────────────────────

function buildSkillProposal(name, description, body, options = {}) {
  return {
    kind: 'create',
    artefact: 'skill',
    name,
    description,
    body,
    trigger: options.trigger || 'manual',
    keywords: Array.isArray(options.keywords) ? options.keywords : [],
    rationale: options.rationale || '',
  };
}

// ── Validation ────────────────────────────────────────────────────────────

function validateProposal(proposal) {
  const errors = [];
  if (!proposal || typeof proposal !== 'object') return ['proposal must be an object'];

  if (proposal.artefact !== 'skill') {
    errors.push(`artefact must be "skill", got ${JSON.stringify(proposal.artefact)}`);
  }
  if (typeof proposal.name !== 'string' || !NAME_RE.test(proposal.name)) {
    errors.push('name must be a non-empty alphanumeric/-_ string');
  }
  if (typeof proposal.description !== 'string' || !proposal.description.trim()) {
    errors.push('description must be a non-empty string');
  } else if (/[\r\n]/.test(proposal.description)) {
    errors.push('description must not contain newlines (frontmatter-injection risk)');
  }
  if (typeof proposal.body !== 'string' || !proposal.body.trim()) {
    errors.push('body must be a non-empty string');
  }
  if (!VALID_TRIGGERS.has(proposal.trigger)) {
    errors.push(`trigger must be one of manual|auto|match, got ${JSON.stringify(proposal.trigger)}`);
  }
  if (proposal.trigger === 'match' && (!Array.isArray(proposal.keywords) || proposal.keywords.length === 0)) {
    errors.push('trigger "match" requires a non-empty keywords list');
  }
  return errors;
}

// ── Name-collision check ──────────────────────────────────────────────────

// Look for an existing skill with this name across the standard skill dirs
// (live and drafts). Returns the first matching path or null.
function checkNameCollision(name, projectDir) {
  const os = require('os');
  const roots = [
    path.join(projectDir, '.smallcode', 'skills'),
    path.join(os.homedir(), '.smallcode', 'skills'),
    path.join(os.homedir(), '.config', 'smallcode', 'skills'),
  ];
  for (const root of roots) {
    for (const candidate of [
      path.join(root, `${name}.md`),
      path.join(root, name, 'SKILL.md'),
      path.join(root, 'drafts', `${name}.md`),
    ]) {
      if (fs.existsSync(candidate)) return candidate;
    }
  }
  return null;
}

// ── Draft writer ──────────────────────────────────────────────────────────

function _skillMd(proposal) {
  const fm = [
    '---',
    `name: ${proposal.name}`,
    `description: ${proposal.description}`,
    `trigger: ${proposal.trigger}`,
    proposal.keywords.length ? `keywords: [${proposal.keywords.join(', ')}]` : null,
    '---',
  ].filter(Boolean).join('\n');
  let body = proposal.body.trim() + '\n';
  if (proposal.rationale) {
    body += `\n<!-- Auto-drafted by /evolve. Rationale: ${proposal.rationale.replace(/-->/g, '')} -->\n`;
  }
  return `${fm}\n${body}`;
}

function writeDraft(proposal, projectDir) {
  const errors = validateProposal(proposal);
  if (errors.length) throw new Error(`invalid proposal: ${errors.join('; ')}`);

  const draftsDir = path.resolve(projectDir, '.smallcode', 'skills', 'drafts');
  const target = path.resolve(draftsDir, `${proposal.name}.md`);
  // Path containment — name is already validated, but defend anyway
  if (!target.startsWith(draftsDir + path.sep)) {
    throw new Error(`draft path escapes drafts dir: ${target}`);
  }
  if (!fs.existsSync(draftsDir)) fs.mkdirSync(draftsDir, { recursive: true });
  const tmpPath = target + `.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, _skillMd(proposal), 'utf-8');
  fs.renameSync(tmpPath, target);
  return target;
}

// ── Audit log ─────────────────────────────────────────────────────────────

function logCreateEvent(auditPath, proposal, rationale, sourceTraceIds) {
  appendEntry(auditPath, {
    ts: new Date().toISOString(),
    kind: 'create',
    artefact: proposal.artefact,
    name: proposal.name,
    rationale: rationale || proposal.rationale || '',
    source_traces: Array.isArray(sourceTraceIds) ? sourceTraceIds : [],
  });
}

// ── Per-run cap (structural) ──────────────────────────────────────────────

// Stateful tracker enforcing the create cap by construction. Use this, not
// writeDraft directly, when running an evolution pass.
class EvolverRun {
  constructor(maxCreates = MAX_CREATES_PER_RUN) {
    this.maxCreates = maxCreates;
    this.createsSoFar = 0;
    this.written = [];
  }

  writeDraft(proposal, projectDir) {
    if (proposal && proposal.kind === 'create' && this.createsSoFar >= this.maxCreates) {
      throw new ProposalCapExceededError(
        `already wrote ${this.createsSoFar} create(s); cap is ${this.maxCreates}`
      );
    }
    const target = writeDraft(proposal, projectDir);
    if (proposal.kind === 'create') this.createsSoFar++;
    this.written.push(target);
    return target;
  }
}

module.exports = {
  buildSkillProposal,
  validateProposal,
  checkNameCollision,
  writeDraft,
  logCreateEvent,
  EvolverRun,
  ProposalCapExceededError,
  MAX_CREATES_PER_RUN,
};
