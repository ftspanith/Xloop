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

test('a Telugu alternate title resolves to the canonical TMDB film only when the release year agrees', async () => {
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, config = {}) => {
    calls.push({ url, params: config.params || {} });
    if (url.endsWith('/search/movie')) {
      return { data: { results: [{
        id: 39410, title: 'Enthiran', original_title: 'Enthiran',
        release_date: '2010-10-01', popularity: 80,
      }] } };
    }
    if (url.endsWith('/movie/39410/alternative_titles')) {
      return { data: { id: 39410, titles: [
        { iso_3166_1: 'IN', title: 'Robo' },
        { iso_3166_1: 'IN', title: 'Robot' },
      ] } };
    }
    if (url.endsWith('/movie/39410')) {
      return { data: {
        id: 39410, title: 'Enthiran', original_title: 'Enthiran',
        release_date: '2010-10-01', original_language: 'ta',
        genres: [], poster_path: null, backdrop_path: null,
      } };
    }
    if (url.includes('/search/')) return { data: { results: [] } };
    throw new Error('Unexpected mocked TMDB URL: ' + url);
  };

  try {
    const result = await searchTMDB('Robo', 2010, false, null, null, null, null, {
      tmdbKey: 'test-key', messageYear: 2010, yearHints: [2010],
    });
    assert.ok(result);
    assert.equal(result.tmdbId, '39410');
    assert.equal(result.title, 'Robo', 'keep the supplied Telugu catalogue title');
    assert.equal(result.year, 2010);
    const search = calls.find(call => call.url.endsWith('/search/movie'));
    assert.equal(search.params.primary_release_year, 2010);
    assert.equal(search.params.region, 'IN');
    assert.ok(calls.some(call => call.url.endsWith('/movie/39410/alternative_titles')));
  } finally {
    axios.get = originalGet;
  }
});

test('a short exact-title collision from a different decade is rejected even during relaxed search', async () => {
  const originalGet = axios.get;
  const calls = [];
  axios.get = async (url, config = {}) => {
    calls.push({ url, params: config.params || {} });
    if (url.includes('/search/')) {
      return { data: { results: [{
        id: 2019, title: 'Robo', original_title: 'Robo',
        release_date: '2019-07-12', media_type: url.endsWith('/search/multi') ? 'movie' : undefined,
        popularity: 250,
      }] } };
    }
    if (url.endsWith('/movie/2019')) {
      return { data: { id: 2019, title: 'Robo', release_date: '2019-07-12' } };
    }
    if (url.endsWith('/movie/2019/alternative_titles')) {
      return { data: { id: 2019, titles: [] } };
    }
    throw new Error('Unexpected mocked TMDB URL: ' + url);
  };

  try {
    const result = await searchTMDB('Robo', 2010, false, null, null, null, null, {
      tmdbKey: 'test-key', messageYear: 2010, yearHints: [2010],
    });
    assert.equal(result, null, 'the 2019 same-name result must never be selected for a 2010 request');
    assert.equal(calls.some(call => /\/movie\/2019$/.test(call.url)), false,
      'a decade-mismatched candidate must be rejected before its details are fetched');
  } finally {
    axios.get = originalGet;
  }
});

test('long fuzzy titles still require a strong title match and a nearby release year', async () => {
  const originalGet = axios.get;
  axios.get = async url => {
    if (url.includes('/search/')) return { data: { results: [{
      id: 777, title: 'A Completely Different English Film',
      original_title: 'A Completely Different English Film',
      release_date: '2010-04-01', media_type: url.endsWith('/search/multi') ? 'movie' : undefined,
      popularity: 999,
    }] } };
    throw new Error('An unrelated title must not reach details: ' + url);
  };

  try {
    const result = await searchTMDB('Robo Science Fiction', 2010, false, null, null, null, null, {
      tmdbKey: 'test-key', messageYear: 2010, yearHints: [2010],
    });
    assert.equal(result, null);
  } finally {
    axios.get = originalGet;
  }
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
