// SmallCode — Agent Loader
// Loads agent definitions from .smallcode/agents/<name>.md
//
// Frontmatter fields:
//   name:        agent name (defaults to filename stem)
//   description: short description shown in /agents list
//   tools:       [tool1, tool2] — subset of canonical TOOLS the agent may use
//   model:       tier name (fast/default/medium/strong) or exact model name
//
// Body = system prompt (capped at 1600 chars in AgentRunner).
//
// Drafts quarantine: agents/drafts/ is never auto-loaded (Phase 3 will
// write agent drafts there; promotion via a future /evolve promote-agent).

'use strict';

const fs = require('fs');
const path = require('path');

// Reuse the same regex pair as skills.js for consistency
const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const KV_RE = /^(\w+)\s*:\s*(.+?)\s*$/;

class AgentLoader {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this._agents = new Map(); // name → AgentDef
    this._load();
  }

  _agentDir() {
    return path.join(this.projectDir, '.smallcode', 'agents');
  }

  _load() {
    const dir = this._agentDir();
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip drafts/ directory — quarantined until Phase 3 promote
      if (entry.isDirectory() && entry.name === 'drafts') continue;
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.md')) continue;
      this._ingest(path.join(dir, entry.name), entry.name.replace(/\.md$/i, ''));
    }
  }

  _parseMeta(frontmatter) {
    const meta = {};
    for (const rawLine of frontmatter.split(/\r?\n/)) {
      const m = rawLine.match(KV_RE);
      if (!m) continue;
      let value = m[2].trim();
      // Inline array: tools: [read_file, bash]
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
      meta[m[1]] = value;
    }
    return meta;
  }

  _ingest(filePath, defaultName) {
    let content;
    try {
      content = fs.readFileSync(filePath, 'utf-8');
    } catch {
      return;
    }

    const fmMatch = content.match(FM_RE);
    let meta = {};
    let body = content;

    if (fmMatch) {
      meta = this._parseMeta(fmMatch[1]);
      body = fmMatch[2];
    }

    const name = meta.name || defaultName;
    const tools = Array.isArray(meta.tools) ? meta.tools : [];
    const description = meta.description || '';
    const model = meta.model || null;

    this._agents.set(name, {
      name,
      description,
      tools,
      model,
      body: body.trim(),
      path: filePath,
    });
  }

  // Returns all agent definitions
  list() {
    return [...this._agents.values()].map(a => ({
      name: a.name,
      description: a.description,
      tools: a.tools,
      model: a.model,
    }));
  }

  // Returns a single agent definition or null
  get(name) {
    return this._agents.get(name) || null;
  }
}

module.exports = { AgentLoader };
