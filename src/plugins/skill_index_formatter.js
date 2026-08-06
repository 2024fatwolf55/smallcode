'use strict';

// SmallCode — Skill index formatter
// Produces a compact index string (one line per skill, ~8 tokens each) suitable
// for always-injecting into the system prompt, plus a full-body formatter for
// use_skill results that includes related skill names/descriptions (not bodies).

/**
 * Format a flat index of skills — one line per skill.
 * @param {Array<{name:string, description:string, trigger:string, keywords:string[]}>} entries
 * @returns {string}
 */
function formatSkillIndex(entries) {
  if (!entries || entries.length === 0) return '';
  const lines = entries.map(e => {
    const kw = e.keywords && e.keywords.length ? ` [${e.keywords.join(',')}]` : '';
    const desc = e.description ? ` — ${e.description}` : '';
    return `  ${e.name}${desc}${kw}`;
  });
  return '\n\nAvailable skills (call use_skill to load):\n' + lines.join('\n');
}

/**
 * Format a loaded skill body for the use_skill response.
 * Appends brief related-skill entries (name + description only, not body).
 * @param {object} skill — {name, description, content, keywords, trigger}
 * @param {Array<{name:string, description:string}>} relatedEntries — index entries for related skills
 * @returns {string}
 */
function formatSkillResult(skill, relatedEntries) {
  let out = `[skill:${skill.name}]\n${skill.content}`;
  if (relatedEntries && relatedEntries.length > 0) {
    const rel = relatedEntries.map(e => `  ${e.name}${e.description ? ' — ' + e.description : ''}`).join('\n');
    out += `\n\nRelated skills:\n${rel}`;
  }
  return out;
}

module.exports = { formatSkillIndex, formatSkillResult };
