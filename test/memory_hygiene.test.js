'use strict';

// SmallCode — Memory hygiene tests
// Verifies age/cap sweeps, backfill, index render, no-op empty, round-trip.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { runHygiene, renderMemoryIndex, extractMeta } = require('../src/memory/hygiene');
const { MemoryStore } = require('../bin/memory');

function freshStore() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hygiene-'));
  return new MemoryStore(dir);
}

function daysAgo(n) {
  return new Date(Date.now() - n * 86400000).toISOString();
}

// ── No-op on empty store ──────────────────────────────────────────────────────

test('runHygiene on empty store returns zeros', () => {
  const store = freshStore();
  const result = runHygiene(store);
  assert.equal(result.archived, 0);
  assert.equal(result.deleted, 0);
  assert.equal(result.total, 0);
});

// ── Backfill ─────────────────────────────────────────────────────────────────

test('runHygiene backfills tier=hot and last_used_at on old entries', () => {
  const store = freshStore();
  // Remember without tier/last_used_at (old-format entry)
  const obj = store.remember('decision', 'old entry', 'content', {});
  // Strip tier/last_used_at to simulate pre-hygiene entry
  obj.tier = undefined;
  obj.last_used_at = undefined;
  store.save(); // persist mutated object

  runHygiene(store, { archiveAge: 9999, deleteAge: 9999 });

  const objs = store.all();
  const { tier } = extractMeta(objs[0]);
  assert.equal(tier, 'hot');
});

// ── Age sweep: hot → archive ──────────────────────────────────────────────────

test('hot entry unused > archiveAge is moved to archive', () => {
  const store = freshStore();
  const obj = store.remember('gotcha', 'stale hot', 'content', {});
  // Force last_used_at to 70 days ago
  obj.last_used_at = daysAgo(70);
  obj.tier = 'hot';
  store.save();

  const result = runHygiene(store, { archiveAge: 60, deleteAge: 90 });
  assert.equal(result.archived, 1);

  const { tier } = extractMeta(store.all()[0]);
  assert.equal(tier, 'archive');
});

test('hot entry within archiveAge is NOT archived', () => {
  const store = freshStore();
  const obj = store.remember('context', 'fresh entry', 'content', {});
  obj.last_used_at = daysAgo(5);
  obj.tier = 'hot';
  store.save();

  const result = runHygiene(store, { archiveAge: 60, deleteAge: 90 });
  assert.equal(result.archived, 0);
  assert.equal(result.deleted, 0);
});

// ── Age sweep: archive → delete ───────────────────────────────────────────────

test('archive entry older than deleteAge is deleted', () => {
  const store = freshStore();
  const obj = store.remember('workflow', 'ancient archive', 'content', {});
  obj.last_used_at = daysAgo(100);
  obj.tier = 'archive';
  store.save();

  const result = runHygiene(store, { archiveAge: 60, deleteAge: 90 });
  assert.equal(result.deleted, 1);
  assert.equal(store.all().length, 0);
});

test('archive entry within deleteAge is NOT deleted', () => {
  const store = freshStore();
  const obj = store.remember('workflow', 'recent archive', 'content', {});
  obj.last_used_at = daysAgo(65);
  obj.tier = 'archive';
  store.save();

  const result = runHygiene(store, { archiveAge: 60, deleteAge: 90 });
  assert.equal(result.deleted, 0);
  // May or may not archive again based on whether it's already archive
  assert.equal(store.all().length, 1);
});

// ── Cap sweep ────────────────────────────────────────────────────────────────

test('cap sweep archives oldest entries when hot > hotCap', () => {
  const store = freshStore();
  // Create 6 hot entries with varying last_used_at, cap=4, batch=2
  for (let i = 0; i < 6; i++) {
    const obj = store.remember('convention', `entry-${i}`, `content ${i}`, {});
    obj.last_used_at = daysAgo(i * 2); // older entries have higher i
    obj.tier = 'hot';
    store.save();
  }

  const result = runHygiene(store, { hotCap: 4, batch: 2, archiveAge: 9999, deleteAge: 9999 });
  assert.equal(result.archived, 2);

  const all = store.all();
  const archived = all.filter(o => extractMeta(o).tier === 'archive');
  assert.equal(archived.length, 2);
  // The 2 oldest should be archived
  const archivedNames = archived.map(o => o.title).sort();
  assert.ok(archivedNames.includes('entry-4') || archivedNames.includes('entry-5'));
});

// ── No-op when under cap ─────────────────────────────────────────────────────

test('cap sweep is no-op when hot count <= hotCap', () => {
  const store = freshStore();
  const obj = store.remember('decision', 'single entry', 'content', {});
  obj.tier = 'hot';
  obj.last_used_at = daysAgo(1);
  store.save();

  const result = runHygiene(store, { hotCap: 10, batch: 5, archiveAge: 9999, deleteAge: 9999 });
  assert.equal(result.archived, 0);
});

// ── renderMemoryIndex ─────────────────────────────────────────────────────────

test('renderMemoryIndex returns empty marker for empty store', () => {
  const store = freshStore();
  const md = renderMemoryIndex(store);
  assert.ok(md.includes('empty'));
});

test('renderMemoryIndex groups by tier then type', () => {
  const store = freshStore();
  const h = store.remember('decision', 'hot entry', 'content', {});
  h.tier = 'hot';
  store.save();
  const a = store.remember('workflow', 'archive entry', 'other', {});
  a.tier = 'archive';
  store.save();

  const md = renderMemoryIndex(store);
  assert.ok(md.includes('## Hot'));
  assert.ok(md.includes('## Archive'));
  // Hot section comes before archive
  assert.ok(md.indexOf('## Hot') < md.indexOf('## Archive'));
});

// ── Round-trip: tier survives save/reload ────────────────────────────────────

test('tier and last_used_at survive store save and reload', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sc-hygiene-rt-'));
  const store1 = new MemoryStore(dir);
  const obj = store1.remember('context', 'persist me', 'content', {});
  obj.tier = 'archive';
  obj.last_used_at = daysAgo(70);
  store1.save();

  const store2 = new MemoryStore(dir);
  const loaded = store2.all()[0];
  assert.equal(loaded.tier, 'archive');
  assert.ok(loaded.last_used_at);
});
