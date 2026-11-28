'use strict';
/**
 * tests/pipeline-sync.test.js
 *
 * Regression tests verifying that the scraper JSON → uploader → importer pipeline
 * is fully synced:
 *  1. routes/scrape.js — SHORTENER_RE defined (no ReferenceError), save-extracted enrichment
 *  2. routes/import.js — /bulk isRepack guard separates repack vs non-repack groups
 *  3. routes/import.js — /normalize-links-batch uses detectHost + tmbcloud isFast
 *  4. fix_existing_db.js — tmbcloud isFast, normalizeGdflixUrl applied, isRepack merge guard
 *  5. public/admin/manager.html — #new-link-quality has 8K + 1440p options, isFast includes tmbcloud
 *  6. public/admin/localhost.html — _normalizeQuality has 8K/1440p, EventSource includes token param
 *  7. public/admin/dashboard.html — _normalizeQuality has 8K/1440p
 */

const assert = require('assert');
const { test } = require('node:test');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// ── Helpers ──────────────────────────────────────────────────────────────────
function readSrc(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

// ── 1. routes/scrape.js — SHORTENER_RE alias ─────────────────────────────────
test('routes/scrape.js defines SHORTENER_RE alias to avoid ReferenceError', () => {
  const src = readSrc('routes/scrape.js');
  assert.ok(
    /const SHORTENER_RE\s*=\s*SHORTENER_FILTER_RE/.test(src),
    'SHORTENER_RE alias must be defined in routes/scrape.js'
  );
});

test('routes/scrape.js /save-extracted enriches url with normalizeGdflixUrl or enrichSubmittedLink', () => {
  const src = readSrc('routes/scrape.js');
  assert.ok(
    /enrichSubmittedLink|normalizeGdflixUrl/.test(src),
    '/save-extracted must call enrichSubmittedLink or normalizeGdflixUrl'
  );
});

test('routes/scrape.js /upload-export passes ?indexOnly=true', () => {
  const src = readSrc('routes/scrape.js');
  assert.ok(
    /indexOnly/.test(src),
    'routes/scrape.js must reference indexOnly (to avoid double extraction wipe)'
  );
});

// ── 2. routes/import.js — /bulk isRepack guard ───────────────────────────────
test('routes/import.js /bulk existingDl find has isRepack guard', () => {
  const src = readSrc('routes/import.js');
  assert.ok(
    /isRepack/.test(src),
    '/bulk must check isRepack to prevent merging repack into non-repack groups'
  );
  // The guard should be a strict inequality check
  assert.ok(
    /!!d\.isRepack !== !!newDl\.isRepack/.test(src),
    'isRepack guard must use !!d.isRepack !== !!newDl.isRepack'
  );
});

test('routes/import.js /bulk link enrichment sets host and isFast via detectHost', () => {
  const src = readSrc('routes/import.js');
  assert.ok(
    /isFast.*gdflix.*hubcloud.*gdlink.*tmbcloud/i.test(src) ||
    /isFast.*tmbcloud/i.test(src),
    '/bulk newDl.links enrichment must include tmbcloud in isFast'
  );
});

test('routes/import.js /bulk calls recomputeAggregates before Movie.create', () => {
  const src = readSrc('routes/import.js');
  // recomputeAggregates must appear before Movie.create in /bulk section
  const bulkRecomputeIdx = src.indexOf("recomputeAggregates(movieData)");
  const movieCreateIdx = src.indexOf("await Movie.create(movieData)");
  assert.ok(bulkRecomputeIdx !== -1, 'recomputeAggregates(movieData) must be called in /bulk');
  assert.ok(bulkRecomputeIdx < movieCreateIdx, 'recomputeAggregates must run before Movie.create');
});

// ── 3. routes/import.js — /normalize-links-batch ─────────────────────────────
test('routes/import.js /normalize-links-batch uses detectHost for newHost', () => {
  const src = readSrc('routes/import.js');
  // After fix, newHost is set via detectHost(newUrl), not inline regex
  assert.ok(
    /const newHost = detectHost\(newUrl\)/.test(src),
    '/normalize-links-batch must use detectHost(newUrl) for newHost'
  );
});

test('routes/import.js /normalize-links-batch isFast includes tmbcloud', () => {
  const src = readSrc('routes/import.js');
  // The normalize-links-batch section must have tmbcloud in its isFast pattern
  assert.ok(
    /newIsFast.*tmbcloud/i.test(src) || /tmbcloud.*newIsFast/i.test(src),
    '/normalize-links-batch isFast must include tmbcloud'
  );
});

// ── 4. fix_existing_db.js — tmbcloud isFast + isRepack guard ─────────────────
test('fix_existing_db.js isFast regex includes tmbcloud', () => {
  const src = readSrc('fix_existing_db.js');
  assert.ok(
    /isFast.*tmbcloud/i.test(src),
    'fix_existing_db.js isFast must include tmbcloud'
  );
});

test('fix_existing_db.js merge loop has isRepack guard', () => {
  const src = readSrc('fix_existing_db.js');
  assert.ok(
    /isRepack/.test(src),
    'fix_existing_db.js merge loop must check isRepack'
  );
  assert.ok(
    /!!ex\.isRepack !== !!dl\.isRepack/.test(src),
    'fix_existing_db.js merge guard must use !!ex.isRepack !== !!dl.isRepack'
  );
});

test('fix_existing_db.js applies normalizeGdflixUrl to cleanUrl', () => {
  const src = readSrc('fix_existing_db.js');
  assert.ok(
    /normalizeGdflixUrl\(/.test(src),
    'fix_existing_db.js must call normalizeGdflixUrl on URLs'
  );
});

// ── 5. public/admin/manager.html — quality options + tmbcloud ────────────────
test('manager.html #new-link-quality has 8K option', () => {
  const src = readSrc('public/admin/manager.html');
  // After fix: new-link-quality should have 8K option
  const selectMatch = src.match(/id="new-link-quality"[^>]*>([\s\S]*?)<\/select>/);
  assert.ok(selectMatch, '#new-link-quality select must exist');
  assert.ok(selectMatch[1].includes('8K'), '#new-link-quality must have 8K option');
  assert.ok(selectMatch[1].includes('1440p'), '#new-link-quality must have 1440p option');
});

test('manager.html detectHostJS includes TMBCloud', () => {
  const src = readSrc('public/admin/manager.html');
  assert.ok(
    /tmbcloud.*TMBCloud/i.test(src),
    'detectHostJS in manager.html must detect tmbcloud as TMBCloud'
  );
});

test('manager.html saveEdit isFast regex is correct (no gdfilx typo, includes tmbcloud)', () => {
  const src = readSrc('public/admin/manager.html');
  // After fix: should NOT have gdfilx typo
  assert.ok(
    !/gdfilx/i.test(src),
    'manager.html must not have gdfilx typo (should be gdflix)'
  );
  // After fix: isFast in saveEdit includes tmbcloud
  assert.ok(
    src.includes('gdflix|hubcloud|gdlink|tmbcloud'),
    'saveEdit isFast regex must include tmbcloud pattern'
  );
});

// ── 6. public/admin/localhost.html — _normalizeQuality + EventSource token ───
test('localhost.html _normalizeQuality detects 8K quality', () => {
  const src = readSrc('public/admin/localhost.html');
  assert.ok(
    /8K/.test(src),
    'localhost.html _normalizeQuality must handle 8K'
  );
  assert.ok(
    /1440P/.test(src),
    'localhost.html _normalizeQuality must handle 1440p'
  );
});

test('localhost.html /api/orchestrator/stream EventSource includes token', () => {
  const src = readSrc('public/admin/localhost.html');
  assert.ok(
    /orchestrator\/stream\?token=/.test(src) ||
    /orchestrator\/stream.*token/.test(src),
    'localhost.html EventSource for /api/orchestrator/stream must include token param'
  );
});

test('localhost.html /api/orchestrator/start-local EventSource includes token', () => {
  const src = readSrc('public/admin/localhost.html');
  assert.ok(
    /start-local.*token/.test(src),
    'localhost.html EventSource for /api/orchestrator/start-local must include token param'
  );
});

// ── 7. public/admin/dashboard.html — _normalizeQuality ───────────────────────
test('dashboard.html _normalizeQuality detects 8K quality', () => {
  const src = readSrc('public/admin/dashboard.html');
  assert.ok(
    /8K/.test(src),
    'dashboard.html _normalizeQuality must handle 8K'
  );
  assert.ok(
    /1440P/.test(src),
    'dashboard.html _normalizeQuality must handle 1440p'
  );
});
