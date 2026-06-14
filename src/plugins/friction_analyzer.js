// SmallCode — Friction Analyzer
// Deterministic friction-signal extraction from saved traces. No LLM calls —
// this produces the evidence the /evolve command hands to the model for
// judgment.
//
// Signals:
// - repeated_patterns: near-duplicate prompts appearing 3+ times with no
//   matching skill keyword (the user keeps asking for the same thing by hand)
// - tool_retry_loops: 3+ consecutive failed calls of the same tool against
//   the same file within a trace (the model keeps fighting the same wall)

const REPEAT_THRESHOLD = 3;
const RETRY_THRESHOLD = 3;
const SIMILARITY_THRESHOLD = 0.5;

// Filler words carry no task identity but dilute Jaccard similarity —
// "another seating chart please" must cluster with "a seating chart for..."
const STOPWORDS = new Set([
  'the', 'and', 'for', 'with', 'that', 'this', 'these', 'those', 'from',
  'into', 'onto', 'please', 'can', 'you', 'could', 'would', 'will',
  'another', 'again', 'new', 'now', 'just', 'some', 'all', 'any',
  'make', 'give', 'get', 'want', 'need', 'like',
]);

function _wordSet(text) {
  return new Set(
    String(text || '').toLowerCase().split(/[^a-z0-9]+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w))
  );
}

function _jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
}

function _isError(result) {
  const s = String(result || '');
  return s.startsWith('✗') || /"error"\s*:/.test(s) || /^Error[:\s]/.test(s);
}

// Group traces whose prompts are near-duplicates (Jaccard on word sets).
function _findRepeatedPatterns(traces, skillKeywords) {
  const groups = []; // { words, prompts, traceIds }
  for (const t of traces) {
    const words = _wordSet(t.prompt);
    if (words.size === 0) continue;
    let placed = false;
    for (const g of groups) {
      if (_jaccard(words, g.words) >= SIMILARITY_THRESHOLD) {
        g.prompts.push(t.prompt);
        g.traceIds.push(t.id);
        for (const w of words) g.words.add(w);
        placed = true;
        break;
      }
    }
    if (!placed) groups.push({ words, prompts: [t.prompt], traceIds: [t.id] });
  }

  return groups
    .filter(g => g.prompts.length >= REPEAT_THRESHOLD)
    // Skip patterns a skill already covers (any keyword hits the group words)
    .filter(g => !skillKeywords.some(kw => g.words.has(String(kw).toLowerCase())))
    .map(g => ({
      pattern: g.prompts[0].slice(0, 120),
      count: g.prompts.length,
      traceIds: g.traceIds,
    }));
}

// Detect consecutive failed calls of the same tool+file within each trace.
function _findToolRetryLoops(traces) {
  const loops = [];
  for (const t of traces) {
    let runTool = null, runFile = null, failCount = 0;
    const flush = () => {
      if (failCount >= RETRY_THRESHOLD) {
        loops.push({ tool: runTool, file: runFile, failCount, traceIds: [t.id] });
      }
      runTool = null; runFile = null; failCount = 0;
    };
    for (const step of t.steps || []) {
      if (step.type !== 'tool_call') continue;
      let file = '';
      try {
        const args = typeof step.args === 'string' ? JSON.parse(step.args) : (step.args || {});
        file = args.path || args.file || '';
      } catch {}
      const failed = _isError(step.result);
      if (failed && step.name === runTool && file === runFile) {
        failCount++;
      } else {
        flush();
        if (failed) { runTool = step.name; runFile = file; failCount = 1; }
      }
    }
    flush();
  }
  return loops;
}

/**
 * @param {object[]} traces - full trace objects (TraceRecorder.load shape)
 * @param {object} options - { skillKeywords: string[] } keywords of existing skills
 * @returns FrictionReport
 */
function extractFrictionSignals(traces, options = {}) {
  const skillKeywords = options.skillKeywords || [];
  const safe = (traces || []).filter(t => t && typeof t === 'object');
  return {
    repeated_patterns: _findRepeatedPatterns(safe, skillKeywords),
    tool_retry_loops: _findToolRetryLoops(safe),
    analyzed_traces: safe.length,
  };
}

// Compact text rendering of a friction report for the LLM prompt — counts
// and short descriptions only, never full trace content (budget guard).
function formatReportForPrompt(report) {
  const lines = [];
  for (const p of report.repeated_patterns) {
    lines.push(`- Repeated request (${p.count}x): "${p.pattern}"`);
  }
  for (const l of report.tool_retry_loops) {
    lines.push(`- Tool retry loop: ${l.tool} failed ${l.failCount}x in a row on ${l.file || '(no file)'}`);
  }
  return lines.join('\n').slice(0, 2000);
}

module.exports = { extractFrictionSignals, formatReportForPrompt };
