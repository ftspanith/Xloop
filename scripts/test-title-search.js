#!/usr/bin/env node
/**
 * scripts/test-title-search.js — TMDB Title Search Tester
 * ─────────────────────────────────────────────────────────────────────────────
 * Quickly test the upgraded 24-variant TMDB search engine against real titles.
 * Usage:
 *   node scripts/test-title-search.js "Pushpa 2"
 *   node scripts/test-title-search.js "Enthiran" 2010
 *   node scripts/test-title-search.js "2001: A Space Odyssey" 1968
 *   node scripts/test-title-search.js "RRR" --series
 *   node scripts/test-title-search.js --batch  (runs built-in test suite)
 */
'use strict';
require('dotenv').config();
const { searchTMDB, buildTitleCandidates } = require('../utils/tmdbSearch');
const { cleanTitleForApi }                 = require('../utils/parser');

const tmdbKey = process.env.TMDB_API_KEY || process.env.TMDB_KEY;
if (!tmdbKey) { console.error('❌ TMDB_API_KEY not set in .env'); process.exit(1); }

const args     = process.argv.slice(2);
const isBatch  = args.includes('--batch');
const isSeries = args.includes('--series');
const title    = args.filter(a => !a.startsWith('--'))[0] || '';
const year     = Number(args.filter(a => !a.startsWith('--'))[1]) || null;

// ─── Built-in test suite ──────────────────────────────────────────────────────
const TEST_CASES = [
  { title: 'Pushpa 2',              year: 2024, isSeries: false, expect: 'Pushpa 2: The Rule' },
  { title: 'Pushpa 2 The Rule',     year: 2024, isSeries: false, expect: 'Pushpa 2: The Rule' },
  { title: 'Enthiran',              year: 2010, isSeries: false, expect: 'Enthiran' },
  { title: 'Robo',                  year: 2010, isSeries: false, expect: 'Enthiran' },   // regional alias
  { title: 'RRR',                   year: 2022, isSeries: false, expect: 'RRR' },
  { title: 'KGF Chapter 2',         year: 2022, isSeries: false, expect: 'KGF: Chapter 2' },
  { title: '2001 A Space Odyssey',  year: 1968, isSeries: false, expect: '2001: A Space Odyssey' },
  { title: '1917',                  year: 2019, isSeries: false, expect: '1917' },
  { title: 'Hanu-Man',              year: 2024, isSeries: false, expect: 'HanuMan' },
  { title: 'Dune Part Two',         year: 2024, isSeries: false, expect: 'Dune: Part Two' },
  { title: 'Baahubali 2',           year: 2017, isSeries: false, expect: 'Baahubali: The Conclusion' },
  { title: 'The Batman',            year: 2022, isSeries: false, expect: 'The Batman' },
  { title: 'DJTillu',              year: 2022, isSeries: false, expect: 'DJ Tillu' },
  { title: 'Mirzapur',              year: 2018, isSeries: true,  expect: 'Mirzapur' },
];

async function runOne(t, y, series, expectTitle) {
  const cleaned    = cleanTitleForApi(t);
  const candidates = buildTitleCandidates(t, cleaned, y);
  console.log(`\n\x1b[1m🔍 "${t}"${y ? ' (' + y + ')' : ''}${series ? ' [series]' : ''}\x1b[0m`);
  console.log(`   Candidates (${candidates.length}): ${candidates.slice(0, 8).map(c => '"' + c + '"').join(', ')}${candidates.length > 8 ? '...' : ''}`);

  const start  = Date.now();
  const result = await searchTMDB(t, y, series, null, null, null, null, {
    tmdbKey,
    emitter: msg => { if (msg.includes('Algorithm') || msg.includes('Relaxed')) console.log('   ' + msg); },
  });
  const elapsed = Date.now() - start;

  if (!result) {
    console.log(`   \x1b[31m❌ No match found (${elapsed}ms)\x1b[0m`);
    return false;
  }
  const matched = !expectTitle || result.title.toLowerCase().includes(expectTitle.toLowerCase().split(':')[0].toLowerCase());
  const icon    = matched ? '\x1b[32m✅' : '\x1b[33m⚠️ ';
  console.log(`   ${icon} ${result.title} (${result.year}) — ${result.type} — TMDB:${result.tmdbId} — ${result.confidence}pts — algo:${result._algo} — ${elapsed}ms\x1b[0m`);
  if (expectTitle && !matched) console.log(`      Expected: "${expectTitle}"`);
  return matched;
}

async function main() {
  if (isBatch) {
    console.log('\n\x1b[1m━━━ TMDB Search Batch Test Suite ━━━\x1b[0m');
    let pass = 0, fail = 0;
    for (const tc of TEST_CASES) {
      const ok = await runOne(tc.title, tc.year, tc.isSeries, tc.expect);
      if (ok) pass++; else fail++;
    }
    console.log(`\n\x1b[1m━━━ Results: ${pass}/${TEST_CASES.length} passed${fail > 0 ? ', ' + fail + ' failed' : ''} ━━━\x1b[0m\n`);
    if (fail > 0) process.exit(1);
  } else if (title) {
    await runOne(title, year, isSeries, null);
    console.log('');
  } else {
    console.log('Usage: node scripts/test-title-search.js "Title" [year] [--series] [--batch]');
  }
}

main().catch(e => { console.error(e); process.exit(1); });
