// SmallCode — Team Loader
// Loads team definitions from .smallcode/teams/<name>.yaml
//
// YAML format (tiny parser — NO yaml dep):
//   name: my-team
//   description: short description
//   agents: [agent-a, agent-b]
//
// Only parses top-level scalar keys and inline array lists.
// Drafts quarantine: teams/drafts/ is never auto-loaded (Phase 3 parity).

'use strict';

const fs = require('fs');
const path = require('path');

// Reuse KV_RE style from skills.js / agent_loader.js
const KV_RE = /^(\w+)\s*:\s*(.+?)\s*$/;

class TeamLoader {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this._teams = new Map();
    this._load();
  }

  _teamDir() {
    return path.join(this.projectDir, '.smallcode', 'teams');
  }

  _bundledDir() {
    return path.join(__dirname, '..', '..', 'teams');
  }

  _parseLine(line) {
    const m = line.trim().match(KV_RE);
    if (!m) return null;
    let value = m[2].trim();
    if (value.startsWith('[') && value.endsWith(']')) {
      value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
    }
    return { key: m[1], value };
  }

  _parse(content, defaultName) {
    const result = { name: defaultName, description: '', agents: [] };
    for (const rawLine of content.split(/\r?\n/)) {
      const parsed = this._parseLine(rawLine);
      if (!parsed) continue;
      if (parsed.key === 'name') result.name = String(parsed.value);
      else if (parsed.key === 'description') result.description = String(parsed.value);
      else if (parsed.key === 'agents') result.agents = Array.isArray(parsed.value) ? parsed.value : [String(parsed.value)];
    }
    return result;
  }

  _loadDir(dir) {
    if (!fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Skip drafts/ directory — quarantine parity with skills/agents
      if (entry.isDirectory() && entry.name === 'drafts') continue;
      if (entry.isDirectory()) continue;
      if (!entry.name.endsWith('.yaml') && !entry.name.endsWith('.yml')) continue;
      const filePath = path.join(dir, entry.name);
      const defaultName = entry.name.replace(/\.(yaml|yml)$/i, '');
      let content;
      try {
        content = fs.readFileSync(filePath, 'utf-8');
      } catch {
        continue;
      }
      const team = this._parse(content, defaultName);
      team.path = filePath;
      this._teams.set(team.name, team);
    }
  }

  _load() {
    // Bundled defaults first; project-level overrides (Map.set overwrites same name)
    this._loadDir(this._bundledDir());
    this._loadDir(this._teamDir());
  }

  list() {
    return [...this._teams.values()].map(t => ({
      name: t.name,
      description: t.description,
      agents: t.agents,
    }));
  }

  get(name) {
    return this._teams.get(name) || null;
  }
}

module.exports = { TeamLoader };
