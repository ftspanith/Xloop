'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const axios = require('axios');
const { buildTitleCandidates, stringSimilarity, searchTMDB } = require('../utils/tmdbSearch');

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


test('title matching tolerates spacing, punctuation and small spelling differences', () => {
  assert.equal(stringSimilarity('Hanu-Man', 'Hanu Man'), 1);
  assert.ok(stringSimilarity('DJTillu', 'DJ Tillu') >= 0.95);
  assert.ok(stringSimilarity('Ayyappanum-Koshiyum', 'Ayyappan Koshiyum') >= 0.9);
  assert.ok(stringSimilarity('Sample Movie', 'Unrelated Title') < 0.5);
});

test('title candidates include a compact spelling for joined-word catalogue titles', () => {
  const candidates = buildTitleCandidates('DJ Tillu', 'DJ Tillu', 2022);
  assert.ok(candidates.includes('DJTillu'));
});

test('Telegram upload date is not sent to TMDB as a release-year filter', async () => {
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, config = {}) => {
    calls.push({ url, params: config.params || {} });
    if (url.includes('/search/')) {
      return {
        data: {
          results: [{
            id: 9876,
            title: 'Sample Movie',
            original_title: 'Sample Movie',
            release_date: '2010-01-01',
            popularity: 10,
          }],
        },
      };
    }
    if (url.endsWith('/movie/9876')) {
      return {
        data: {
          id: 9876,
          title: 'Sample Movie',
          release_date: '2010-01-01',
          genres: [],
          poster_path: null,
          backdrop_path: null,
        },
      };
    }
    throw new Error('Unexpected mocked TMDB URL: ' + url);
  };

  try {
    const result = await searchTMDB(
      'Sample Movie', null, false, null, '2026-11-24', null, null,
      { tmdbKey: 'test-key' }
    );
    assert.ok(result);
    assert.equal(result.tmdbId, '9876');
    const firstSearch = calls.find(call => call.url.includes('/search/movie'));
    assert.ok(firstSearch, 'movie search should be attempted');
    assert.equal(firstSearch.params.year, undefined, 'upload year must not filter a film released in another year');
  } finally {
    axios.get = originalGet;
  }
});
