// SmallCode — Evolution Audit Log
// Thin JSONL appender/reader for evolver create events. One JSON object per
// line; append-only. Writes are atomic (tmp + rename) so a crash mid-write
// never corrupts existing history.

const fs = require('fs');
const path = require('path');

function appendEntry(filePath, entry) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const line = JSON.stringify(entry) + '\n';
  // Read-modify-write atomically: copy existing content + new line to a tmp
  // file, then rename over the original.
  let existing = '';
  try { existing = fs.readFileSync(filePath, 'utf-8'); } catch {}
  const tmpPath = filePath + `.tmp.${process.pid}.${Date.now()}`;
  fs.writeFileSync(tmpPath, existing + line, 'utf-8');
  fs.renameSync(tmpPath, filePath);
}

function readEntries(filePath, limit = 100) {
  let content = '';
  try { content = fs.readFileSync(filePath, 'utf-8'); } catch { return []; }
  const entries = [];
  for (const line of content.split('\n')) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries.slice(-limit);
}

module.exports = { appendEntry, readEntries };
