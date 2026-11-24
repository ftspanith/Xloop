'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { buildTitleCandidates, stringSimilarity } = require('../utils/tmdbSearch');

test('shared title engine includes sequel, Roman numeral and spelling variants', () => {
  const pushpa = buildTitleCandidates('Pushpa 2 The Rule', 'Pushpa 2 The Rule', 2024);
  assert.ok(pushpa.includes('Pushpa The Rule'));

  const baahubali = buildTitleCandidates('Baahubali II The Conclusion', 'Baahubali II The Conclusion', 2017);
  assert.ok(baahubali.includes('Baahubali 2 The Conclusion'));

  const hanuMan = buildTitleCandidates('Hanu-Man', 'Hanu-Man', 2024);
  assert.ok(hanuMan.includes('Hanu Man'));

  const dune = buildTitleCandidates('Dune: Part Two', 'Dune: Part Two', 2024);
  assert.ok(dune.includes('Dune: Part 2'));
});

test('shared title engine de-duplicates candidate strings and keeps direct title first', () => {
  const candidates = buildTitleCandidates('Hanu-Man', 'Hanu-Man', 2024);
  assert.equal(candidates[0], 'Hanu-Man');
  assert.equal(new Set(candidates.map(value => value.toLowerCase())).size, candidates.length);
});

test('shared metadata scorer exposes normalized string similarity', () => {
  assert.equal(stringSimilarity('Sample Movie', 'Sample Movie'), 1);
  assert.ok(stringSimilarity('Sample Movie', 'Sample Film') > 0);
  assert.ok(stringSimilarity('Sample Movie', 'Unrelated Title') < 0.5);
});
