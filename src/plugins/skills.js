// SmallCode — Skill System
// Skills are reusable prompt templates that teach the model specific behaviors.
// They're simpler than plugins — just markdown files with optional YAML frontmatter.
//
// Compiled from: src/plugins/skills.ms (port-mirror)
//
// Skill discovery layers (later overrides earlier):
//   <package>/skills/                    — bundled defaults
//   ~/.smallcode/skills/                 — user-level
//   ~/.config/smallcode/skills/          — XDG-style user config
//   <project>/.smallcode/skills/         — project (highest precedence)
//   <project>/.agents/skills/<name>/SKILL.md  — itsy/jukefr layout (closes #53)
//   <project>/.claude/skills/<name>/SKILL.md  — Claude Code layout (closes #53)
//
// Skills with YAML frontmatter behave as before. Skills loaded from
// `.agents/skills` or `.claude/skills` typically have no frontmatter — they
// are treated as `manual`-trigger skills named after their parent directory.
//
// The standard skill dirs also accept the nested `<name>/SKILL.md` layout and
// flat `.md` files without frontmatter (named after the file) — both were
// previously skipped silently (closes #81). README-style files are ignored.
//
// Frontmatter accepts both LF and CRLF line endings (closes #52).
//
// Lazy loading: index entries (frontmatter only) are stored in _index Map.
// Bodies are loaded on demand via _loadBody(name) and cached into skills Map.
// getIndex() returns flat IndexEntry list for prompt injection.

const fs = require('fs');
const path = require('path');
const os = require('os');

const FM_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;
const KV_RE = /^(\w+)\s*:\s*(.+?)\s*$/;
// Docs that live alongside skills but aren't skills themselves
const NON_SKILL_MD = /^(readme|changelog|license|contributing)\.md$/i;

// Max bytes to scan for frontmatter before falling back to full read.
const FRONTMATTER_SCAN_BYTES = 2048;
// Max lines to scan for frontmatter end marker.
const FRONTMATTER_SCAN_LINES = 50;

class SkillManager {
  constructor(projectDir) {
    this.projectDir = projectDir || process.cwd();
    this.skills = new Map(); // name → fully-loaded skill object (cached)
    this._index = new Map(); // name → IndexEntry (frontmatter + path, no body)
    this._load();
  }

  _getSkillDirs() {
    // Order matters: later entries override earlier ones (highest precedence
    // last). Project-level skills always win over user-level / bundled.
    return [
      // bundled defaults shipped with smallcode itself
      path.join(__dirname, '..', '..', 'skills'),
      // user-level
      path.join(os.homedir(), '.smallcode', 'skills'),
      path.join(os.homedir(), '.config', 'smallcode', 'skills'),
      // project-level
      path.join(this.projectDir, '.smallcode', 'skills'),
    ];
  }

  // Nested skill directories that follow the `<dir>/<name>/SKILL.md` layout.
  // `.agents/skills/` is the itsy/jukefr convention; `.claude/skills/` is
  // Claude Code's. Both are auto-detected when present in the project root.
  _getNestedSkillRoots() {
    return [
      path.join(this.projectDir, '.agents', 'skills'),
      path.join(this.projectDir, '.claude', 'skills'),
    ];
  }

  _load() {
    // Flat layout: <dir>/<name>.md
    for (const dir of this._getSkillDirs()) {
      this._loadFlat(dir);
    }
    // Nested layout: <root>/<name>/SKILL.md (case-insensitive)
    for (const root of this._getNestedSkillRoots()) {
      this._loadNested(root);
    }
  }

  _loadFlat(dir) {
    if (!dir || !fs.existsSync(dir)) return;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        // drafts/ is quarantined — evolver proposals live there until a
        // human promotes them (/evolve promote <name>). Never auto-load.
        if (entry.name === 'drafts') continue;
        // <dir>/<name>/SKILL.md inside a standard skill dir — users following
        // the Claude Code layout expect this to work (closes #81)
        this._loadSkillFolder(path.join(dir, entry.name), entry.name);
        continue;
      }
      if (!entry.name.endsWith('.md') || NON_SKILL_MD.test(entry.name)) continue;
      const full = path.join(dir, entry.name);
      this._ingestFile(full, entry.name, dir, entry.name.replace(/\.md$/i, ''), 'flat');
    }
  }

  _loadNested(root) {
    if (!root || !fs.existsSync(root)) return;
    let dirs;
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      this._loadSkillFolder(path.join(root, d.name), d.name);
    }
  }

  _loadSkillFolder(skillDir, name) {
    // Look for SKILL.md, skill.md, or any .md file inside the folder.
    let skillFile = null;
    const candidates = ['SKILL.md', 'skill.md', 'Skill.md'];
    for (const c of candidates) {
      const p = path.join(skillDir, c);
      if (fs.existsSync(p)) { skillFile = p; break; }
    }
    if (!skillFile) {
      // Fall back to first .md in the folder
      try {
        const md = fs.readdirSync(skillDir).find(f => f.endsWith('.md'));
        if (md) skillFile = path.join(skillDir, md);
      } catch {}
    }
    if (!skillFile) return;
    this._ingestFile(skillFile, path.basename(skillFile), skillDir, name, 'nested');
  }

  // Read only enough of the file to extract frontmatter (index-only load).
  // Returns { frontmatter: string|null, bodyStart: number } — bodyStart is
  // the byte offset where the body begins (after the closing ---).
  // Falls back to a full read when the file is small enough or frontmatter
  // spans more than FRONTMATTER_SCAN_BYTES.
  _readFrontmatterOnly(filePath) {
    try {
      // Read a limited slice first.
      const fd = fs.openSync(filePath, 'r');
      const buf = Buffer.alloc(FRONTMATTER_SCAN_BYTES);
      const bytesRead = fs.readSync(fd, buf, 0, FRONTMATTER_SCAN_BYTES, 0);
      fs.closeSync(fd);
      const chunk = buf.slice(0, bytesRead).toString('utf-8');

      if (!chunk.startsWith('---')) {
        // No frontmatter — full content is body; return null so caller full-reads.
        return { frontmatter: null, hasMore: bytesRead === FRONTMATTER_SCAN_BYTES };
      }

      // Find closing --- within FRONTMATTER_SCAN_LINES lines
      const lines = chunk.split(/\r?\n/);
      let closeIdx = -1;
      for (let i = 1; i < Math.min(lines.length, FRONTMATTER_SCAN_LINES); i++) {
        if (lines[i].trimEnd() === '---') { closeIdx = i; break; }
      }
      if (closeIdx === -1) {
        // Frontmatter not closed within scan window — fall back to full read.
        return { frontmatter: null, hasMore: true };
      }

      const frontmatter = lines.slice(1, closeIdx).join('\n');
      return { frontmatter, hasMore: bytesRead === FRONTMATTER_SCAN_BYTES };
    } catch {
      return { frontmatter: null, hasMore: false };
    }
  }

  _ingestFile(filePath, filename, dir, defaultName, origin) {
    // Index-only path: read frontmatter cheaply, store as index entry.
    // Body is loaded lazily on first get().
    const { frontmatter, hasMore } = this._readFrontmatterOnly(filePath);

    let meta = {};
    if (frontmatter !== null) {
      meta = this._parseMeta(frontmatter);
    }

    const name = meta.name || defaultName || filename.replace(/\.md$/i, '');

    const entry = {
      name,
      trigger: meta.trigger || 'manual',
      keywords: Array.isArray(meta.keywords) ? meta.keywords : [],
      description: meta.description || '',
      tags: Array.isArray(meta.tags) ? meta.tags : [],
      related: Array.isArray(meta.related) ? meta.related : [],
      path: filePath,
      origin: origin || (defaultName ? 'nested' : 'flat'),
      // hasFrontmatter: whether the file had a --- block
      _hasFrontmatter: frontmatter !== null,
      // If the file fits in our scan and has frontmatter, we know
      // the body wasn't loaded yet. Track that.
      _bodyLoaded: false,
    };

    this._index.set(name, entry);
    // Remove any stale cached body for same name (precedence override)
    this.skills.delete(name);
  }

  _parseMeta(frontmatter) {
    const meta = {};
    for (const rawLine of frontmatter.split(/\r?\n/)) {
      const m = rawLine.match(KV_RE);
      if (!m) continue;
      let value = m[2].trim();
      if (value.startsWith('[') && value.endsWith(']')) {
        value = value.slice(1, -1).split(',').map(s => s.trim().replace(/['"]/g, '')).filter(Boolean);
      }
      meta[m[1]] = value;
    }
    return meta;
  }

  // Load the full body for a named skill, populate this.skills cache.
  _loadBody(name) {
    const entry = this._index.get(name);
    if (!entry) return null;
    if (entry._bodyLoaded && this.skills.has(name)) return this.skills.get(name);

    let content;
    try {
      content = fs.readFileSync(entry.path, 'utf-8');
    } catch {
      return null;
    }

    const fmMatch = content.match(FM_RE);
    let body = content;
    let meta = {};

    if (fmMatch) {
      meta = this._parseMeta(fmMatch[1]);
      body = fmMatch[2];
    } else if (!entry._hasFrontmatter) {
      // No frontmatter — full file is body (manual trigger, named by filename/dir)
      body = content;
    }

    const skill = {
      name: meta.name || entry.name,
      trigger: meta.trigger || entry.trigger,
      keywords: Array.isArray(meta.keywords) ? meta.keywords : entry.keywords,
      description: meta.description || entry.description || '',
      tags: Array.isArray(meta.tags) ? meta.tags : entry.tags,
      related: Array.isArray(meta.related) ? meta.related : entry.related,
      content: body.trim(),
      path: entry.path,
      origin: entry.origin,
    };

    entry._bodyLoaded = true;
    this.skills.set(name, skill);
    return skill;
  }

  // Get all skills — returns index entries with lazy-loaded bodies for callers
  // that need content. list() does NOT load bodies (index only).
  list() {
    return [...this._index.values()].map(e => ({
      name: e.name,
      trigger: e.trigger,
      keywords: e.keywords,
      preview: this._getPreview(e),
      origin: e.origin || 'flat',
    }));
  }

  _getPreview(entry) {
    // Return preview from cached body if available; otherwise a short placeholder.
    if (entry._bodyLoaded && this.skills.has(entry.name)) {
      const body = this.skills.get(entry.name).content;
      return body.slice(0, 80) + (body.length > 80 ? '...' : '');
    }
    // Avoid loading body just for list() — return description or empty
    return entry.description || '';
  }

  // Get a skill by name — lazily loads body on first call.
  get(name) {
    if (this.skills.has(name)) return this.skills.get(name);
    if (!this._index.has(name)) return null;
    return this._loadBody(name);
  }

  // Get skills that should auto-inject for a given message.
  // Only checks index entries (trigger/keywords) — avoids loading bodies
  // until caller needs content.
  getAutoSkills(message) {
    const msg = (message || '').toLowerCase();
    const results = [];
    for (const entry of this._index.values()) {
      if (entry.trigger === 'auto') {
        results.push(this._loadBody(entry.name));
      } else if (entry.trigger === 'match' && entry.keywords.length > 0) {
        const match = entry.keywords.some(kw => msg.includes(String(kw).toLowerCase()));
        if (match) results.push(this._loadBody(entry.name));
      }
    }
    return results.filter(Boolean);
  }

  // Return flat IndexEntry list for prompt injection (no bodies loaded).
  // { name, description, trigger, keywords, tags, related, path, origin }
  getIndex() {
    return [...this._index.values()].map(e => ({
      name: e.name,
      description: e.description,
      trigger: e.trigger,
      keywords: e.keywords,
      tags: e.tags,
      related: e.related,
      path: e.path,
      origin: e.origin,
    }));
  }

  // Create a new skill in the project's .smallcode/skills directory
  add(name, content, options = {}) {
    const dir = path.join(this.projectDir, '.smallcode', 'skills');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const trigger = options.trigger || 'manual';
    const keywords = options.keywords || [];

    const frontmatter = [
      '---',
      `name: ${name}`,
      `trigger: ${trigger}`,
      keywords.length ? `keywords: [${keywords.join(', ')}]` : null,
      '---',
    ].filter(Boolean).join('\n');

    const fullContent = `${frontmatter}\n${content}\n`;
    const filename = `${name.replace(/[^a-z0-9-_]/gi, '-')}.md`;
    const filePath = path.join(dir, filename);

    fs.writeFileSync(filePath, fullContent);

    const skill = {
      name,
      trigger,
      keywords,
      description: options.description || '',
      tags: options.tags || [],
      related: options.related || [],
      content,
      path: filePath,
      origin: 'flat',
      _hasFrontmatter: true,
      _bodyLoaded: true,
    };
    this._index.set(name, skill);
    this.skills.set(name, skill);
    return skill;
  }

  // Promote a quarantined draft (.smallcode/skills/drafts/<name>.md) into
  // the live project skill dir and load it. Returns the new path or null.
  promoteDraft(name) {
    const safe = String(name || '').replace(/[^a-z0-9-_]/gi, '');
    if (!safe) return null;
    const draftsDir = path.join(this.projectDir, '.smallcode', 'skills', 'drafts');
    const source = path.join(draftsDir, `${safe}.md`);
    if (!fs.existsSync(source)) return null;
    const target = path.join(this.projectDir, '.smallcode', 'skills', `${safe}.md`);
    if (fs.existsSync(target)) return null; // never overwrite a live skill
    fs.renameSync(source, target);
    this._ingestFile(target, `${safe}.md`, path.dirname(target), safe, 'flat');
    return target;
  }

  // List quarantined drafts (names only)
  listDrafts() {
    const draftsDir = path.join(this.projectDir, '.smallcode', 'skills', 'drafts');
    try {
      return fs.readdirSync(draftsDir)
        .filter(f => f.endsWith('.md'))
        .map(f => f.replace(/\.md$/i, ''));
    } catch {
      return [];
    }
  }

  // Remove a skill
  remove(name) {
    const entry = this._index.get(name) || this.skills.get(name);
    if (!entry) return false;
    if (fs.existsSync(entry.path)) {
      try { fs.unlinkSync(entry.path); } catch {}
    }
    this._index.delete(name);
    this.skills.delete(name);
    return true;
  }

  // Format skills for system prompt injection
  formatForPrompt(skills) {
    if (skills.length === 0) return '';
    return '\n\nActive skills:\n' + skills.map(s => `[${s.name}] ${s.content}`).join('\n\n');
  }
}

module.exports = { SkillManager };
