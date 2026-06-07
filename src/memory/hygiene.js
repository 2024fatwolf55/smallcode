'use strict';

// SmallCode — Memory Hygiene
// Promotes memory objects to hot/archive tiers and prunes stale entries.
// Runs silently at session-save points; never throws — all errors are swallowed.
//
// Tier model:
//   hot     — actively used; default for new entries
//   archive — dormant; de-ranked in retrieval (0.3x weight)
//
// Age rules (applied in order):
//   hot + last_used_at > HOT_CAP_AGE_DAYS  → archive
//   archive + age > DELETE_AGE_DAYS         → forget
//   hot count > HOT_CAP → oldest BATCH      → archive

const fs = require('fs');
const path = require('path');

const HOT_CAP = 20;        // max hot-tier entries
const BATCH = 5;           // how many to archive per cap sweep
const ARCHIVE_AGE = 60;    // days unused before hot → archive
const DELETE_AGE = 90;     // days in archive before deletion
const MS_PER_DAY = 86400000;

/**
 * Normalize a store to a common interface regardless of whether it's the
 * SQLite budget-aware-mcp store or the fallback MemoryStore from bin/memory.js.
 *
 * Returns { all, getMeta, setMeta, forget } where:
 *   all()           → MemoryObject[]
 *   getMeta(obj)    → { tier, last_used_at }
 *   setMeta(obj, m) → void  (mutates in-place for fallback; updates DB for SQLite)
 *   forget(id)      → void
 */
function makeAdapter(store) {
  const isSqlite = typeof store.update === 'function';

  function all() {
    return store.all();
  }

  function getMeta(obj) {
    return {
      tier: obj.tier || 'hot',
      last_used_at: obj.last_used_at || obj.createdAt || obj.created_at || new Date(0).toISOString(),
    };
  }

  function setMeta(obj, meta) {
    if (isSqlite) {
      // SQLite store has update() — use it to avoid the forget+remember dedup
      // trap (re-inserting identical content is blocked by content_hash check).
      // We encode tier/last_used_at into the tags array so no schema change is
      // needed on budget-aware-mcp.
      try {
        const existingTags = (obj.tags || []).filter(t => !t.startsWith('tier:') && !t.startsWith('last_used:'));
        const newTags = [
          ...existingTags,
          `tier:${meta.tier}`,
          `last_used:${meta.last_used_at}`,
        ];
        store.update(obj.id, { tags: newTags });
      } catch {}
    } else {
      // Fallback MemoryStore (bin/memory.js): mutate in-place and save.
      obj.tier = meta.tier;
      obj.last_used_at = meta.last_used_at;
      if (typeof store.save === 'function') {
        try { store.save(); } catch {}
      }
    }
  }

  function forget(id) {
    try { store.forget(id); } catch {}
  }

  return { all, getMeta, setMeta, forget };
}

/**
 * Extract tier/last_used_at from a memory object regardless of store type.
 * For SQLite stores we encode these values in tags as 'tier:X' and 'last_used:ISO'.
 */
function extractMeta(obj) {
  // Try direct properties first (fallback MemoryStore)
  if (obj.tier && obj.last_used_at) {
    return { tier: obj.tier, last_used_at: obj.last_used_at };
  }
  // Try tags encoding (SQLite store)
  const tags = obj.tags || [];
  let tier = 'hot';
  let last_used_at = obj.createdAt || obj.created_at || new Date(0).toISOString();
  for (const t of tags) {
    if (t.startsWith('tier:')) tier = t.slice(5);
    if (t.startsWith('last_used:')) last_used_at = t.slice(10);
  }
  return { tier, last_used_at };
}

/**
 * Run hygiene on the store. Silent: never throws.
 *
 * @param {object} store — MemoryStore or budget-aware-mcp store
 * @param {object} [opts]
 * @param {number} [opts.hotCap=20]
 * @param {number} [opts.batch=5]
 * @param {number} [opts.archiveAge=60]  days
 * @param {number} [opts.deleteAge=90]   days
 * @returns {{ archived: number, deleted: number, total: number }}
 */
function runHygiene(store, opts = {}) {
  const hotCap = opts.hotCap ?? HOT_CAP;
  const batch = opts.batch ?? BATCH;
  const archiveAge = opts.archiveAge ?? ARCHIVE_AGE;
  const deleteAge = opts.deleteAge ?? DELETE_AGE;

  let archived = 0;
  let deleted = 0;

  try {
    const adapter = makeAdapter(store);
    const now = Date.now();
    const objects = adapter.all();

    // Backfill: assign hot tier + last_used_at to any entry that lacks them.
    for (const obj of objects) {
      const m = extractMeta(obj);
      if (!obj.tier && !obj.tags?.some(t => t.startsWith('tier:'))) {
        adapter.setMeta(obj, {
          tier: 'hot',
          last_used_at: m.last_used_at,
        });
      }
    }

    // Re-read after backfill so we have fresh state.
    const fresh = adapter.all();

    // ── Age sweep ────────────────────────────────────────────────────────────
    for (const obj of fresh) {
      const { tier, last_used_at } = extractMeta(obj);
      const ageMs = now - new Date(last_used_at).getTime();
      const ageDays = ageMs / MS_PER_DAY;

      if (tier === 'hot' && ageDays > archiveAge) {
        adapter.setMeta(obj, { tier: 'archive', last_used_at });
        archived++;
      } else if (tier === 'archive' && ageDays > deleteAge) {
        adapter.forget(obj.id);
        deleted++;
      }
    }

    // ── Cap sweep ────────────────────────────────────────────────────────────
    // Re-read to get up-to-date list (age sweep may have archived some).
    const afterAge = adapter.all().filter(obj => {
      const { tier } = extractMeta(obj);
      return tier === 'hot';
    });

    if (afterAge.length > hotCap) {
      // Sort by last_used_at ascending (oldest first)
      afterAge.sort((a, b) => {
        const { last_used_at: la } = extractMeta(a);
        const { last_used_at: lb } = extractMeta(b);
        return new Date(la).getTime() - new Date(lb).getTime();
      });
      const toArchive = afterAge.slice(0, batch);
      for (const obj of toArchive) {
        const { last_used_at } = extractMeta(obj);
        adapter.setMeta(obj, { tier: 'archive', last_used_at });
        archived++;
      }
    }
  } catch {
    // Hygiene must never crash the session.
  }

  return { archived, deleted, total: archived + deleted };
}

/**
 * Render a human-readable memory index to a markdown string.
 * Hot entries come before archive. Grouped by type within each tier.
 * This file is GENERATED — never authoritative.
 *
 * @param {object} store
 * @returns {string}
 */
function renderMemoryIndex(store) {
  try {
    const objects = store.all();
    if (objects.length === 0) return '# Memory Index\n\n(empty)\n';

    const hot = [];
    const archive = [];
    for (const obj of objects) {
      const { tier } = extractMeta(obj);
      if (tier === 'archive') archive.push(obj);
      else hot.push(obj);
    }

    function groupByType(objs) {
      const groups = {};
      for (const o of objs) {
        if (!groups[o.type]) groups[o.type] = [];
        groups[o.type].push(o);
      }
      return groups;
    }

    function renderGroup(groups) {
      let out = '';
      for (const [type, objs] of Object.entries(groups)) {
        out += `\n### ${type} (${objs.length})\n`;
        for (const o of objs) {
          out += `- [${o.id}] **${o.title}**\n`;
        }
      }
      return out;
    }

    let md = `# Memory Index\n\nGenerated: ${new Date().toISOString()}\n`;
    md += `Total: ${objects.length} (hot: ${hot.length}, archive: ${archive.length})\n`;

    if (hot.length > 0) {
      md += '\n## Hot\n';
      md += renderGroup(groupByType(hot));
    }
    if (archive.length > 0) {
      md += '\n## Archive\n';
      md += renderGroup(groupByType(archive));
    }

    return md;
  } catch {
    return '# Memory Index\n\n(error rendering)\n';
  }
}

module.exports = { runHygiene, renderMemoryIndex, extractMeta };
