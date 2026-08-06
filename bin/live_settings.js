'use strict';

// SmallCode — live activity feed settings (issue #77)
//
// Four independently-toggleable live-output features, seeded from env and
// flipped at runtime by the `/live` command:
//   tools    — show a tool the moment it starts, update to ✓/✗ on completion
//   context  — live context-usage meter in the footer
//   stream   — stream the model reply token-by-token (changes request path)
//   thinking — live dimmed preview of reasoning (changes request path)
//
// stream/thinking default OFF because they switch chatCompletion to a
// streaming request; tools/context default ON (pure display, no risk).

const FEATURES = ['tools', 'context', 'stream', 'thinking'];

const ENV = {
  tools: 'SMALLCODE_LIVE_TOOLS',
  context: 'SMALLCODE_LIVE_CONTEXT',
  stream: 'SMALLCODE_LIVE_STREAM',
  thinking: 'SMALLCODE_LIVE_THINKING',
};

const DEFAULTS = { tools: true, context: true, stream: false, thinking: false };

function _envBool(name, dflt) {
  const v = process.env[name];
  if (v == null || v === '') return dflt;
  return /^(1|true|on|yes|enabled?)$/i.test(String(v).trim());
}

let _settings = null;

function getLiveSettings() {
  if (!_settings) {
    _settings = {};
    for (const f of FEATURES) _settings[f] = _envBool(ENV[f], DEFAULTS[f]);
  }
  return _settings;
}

function setLive(feature, value) {
  if (!FEATURES.includes(feature)) return false;
  getLiveSettings()[feature] = !!value;
  return true;
}

// Parse an on/off token. Returns true, false, 'toggle' (empty), or null (bad).
function _parseValue(tok) {
  if (tok == null || tok === '') return 'toggle';
  if (/^(1|true|on|yes|enabled?)$/i.test(tok)) return true;
  if (/^(0|false|off|no|disabled?)$/i.test(tok)) return false;
  return null;
}

// Resolve a `/live …` argument string into a structured action:
//   { action: 'status'|'set'|'error', feature?, value?, text }
// `text` is ready to print. Mutates settings on a successful 'set'.
function resolveLiveCommand(argStr) {
  const s = String(argStr || '').trim();
  if (!s) return { action: 'status', text: formatStatus() };

  const parts = s.split(/\s+/);
  const feature = parts[0].toLowerCase();
  const val = _parseValue(parts[1]);

  if (feature === 'all') {
    if (val === null) return { action: 'error', text: `  Invalid value "${parts[1]}". Use on|off.` };
    const v = val === 'toggle' ? true : val;
    for (const f of FEATURES) setLive(f, v);
    return { action: 'set', feature: 'all', value: v, text: formatStatus() };
  }

  if (!FEATURES.includes(feature)) {
    return { action: 'error', text: `  Unknown feature "${feature}". Use: ${FEATURES.join(', ')} (or "all").` };
  }
  if (val === null) return { action: 'error', text: `  Invalid value "${parts[1]}". Use on|off.` };

  const current = getLiveSettings()[feature];
  const newVal = val === 'toggle' ? !current : val;
  setLive(feature, newVal);
  return { action: 'set', feature, value: newVal, text: `  live ${feature}: ${newVal ? 'on' : 'off'}` };
}

function formatStatus() {
  const s = getLiveSettings();
  const lines = ['  Live activity (issue #77):'];
  for (const f of FEATURES) lines.push(`    ${f.padEnd(9)} ${s[f] ? 'on' : 'off'}`);
  lines.push('  Toggle: /live <tools|context|stream|thinking|all> [on|off]');
  return lines.join('\n');
}

// Test-only: drop the cached singleton so env changes re-seed.
function _reset() { _settings = null; }

module.exports = { FEATURES, getLiveSettings, setLive, resolveLiveCommand, formatStatus, _reset };
