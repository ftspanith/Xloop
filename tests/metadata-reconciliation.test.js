'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  shouldSplitMetadataIdentity,
  buildTrustedMetadataUpdate,
  removeExactDownloadUrlFromRecord,
} = require('../pipeline_full');

test('verified TMDB identity keeps same-title remakes in separate catalogue records', () => {
  const existing = { title: 'Robo', year: 2019, tmdbId: '2019' };
  const incoming = { title: 'Robo', year: 2010, tmdbId: '2010', confidence: 100 };

  assert.equal(shouldSplitMetadataIdentity(existing, incoming, 2010), true);
});

test('same verified TMDB ID corrects a stale catalogue year instead of splitting', () => {
  const existing = { title: 'Enthiran', year: 2019, tmdbId: '39410' };
  const incoming = { title: 'Enthiran', year: 2010, tmdbId: '39410', confidence: 100 };

  assert.equal(shouldSplitMetadataIdentity(existing, incoming, 2010), false);
});

test('low-confidence or missing TMDB results never split catalogue identity', () => {
  const existing = { title: 'Robo', year: 2019, tmdbId: '2019' };

  assert.equal(shouldSplitMetadataIdentity(existing, { tmdbId: '2010', year: 2010, confidence: 40 }, 2010), false);
  assert.equal(shouldSplitMetadataIdentity(existing, { year: 2010, confidence: 100 }, 2010), false);
});

test('trusted same-ID metadata refreshes poster, year, backdrop and descriptive fields', () => {
  const existing = {
    title: 'Exact Poster Film',
    tmdbId: '9877',
    imdbId: '',
    poster: 'https://legacy.example/poster.jpg',
    posterFallback: '',
    backdrop: '',
    year: 2019,
    releaseDate: '2019-01-01',
    description: 'Short',
    rating: 0,
    genre: [],
    duration: '',
    totalSeasons: 0,
    originalLanguage: '',
    seasonPosters: {},
    seasonYears: {},
  };
  const incoming = {
    title: 'Exact Poster Film',
    tmdbId: '9877',
    imdbId: 'tt9877000',
    poster: 'https://image.tmdb.org/t/p/w500/poster.jpg',
    backdrop: 'https://image.tmdb.org/t/p/w1280/backdrop.jpg',
    year: 2020,
    releaseDate: '2020-05-01',
    description: 'A longer verified description for this exact film.',
    rating: 7.8,
    genre: ['Drama'],
    duration: '2h 5m',
    totalSeasons: 0,
    originalLanguage: 'Telugu',
    confidence: 100,
    seasonPoster: '',
    seasonYear: null,
  };

  const update = buildTrustedMetadataUpdate(existing, incoming);
  assert.equal(update.poster, incoming.poster);
  assert.equal(update.posterFallback, existing.poster);
  assert.equal(update.year, 2020);
  assert.equal(update.releaseDate, '2020-05-01');
  assert.equal(update.backdrop, incoming.backdrop);
  assert.equal(update.description, incoming.description);
  assert.equal(update.rating, 7.8);
  assert.deepEqual(update.genre, ['Drama']);
  assert.equal(update.duration, '2h 5m');
  assert.equal(update.imdbId, 'tt9877000');
  assert.equal(update.originalLanguage, 'Telugu');
});

test('trusted metadata cannot overwrite a record with a different TMDB ID', () => {
  const existing = { tmdbId: 'old-id', poster: 'https://old.example/poster.jpg', year: 2019 };
  const incoming = {
    tmdbId: 'new-id', confidence: 100, year: 2010, releaseDate: '2010-01-01',
    poster: 'https://image.tmdb.org/t/p/w500/new.jpg',
  };

  assert.deepEqual(buildTrustedMetadataUpdate(existing, incoming), {});
});

test('trusted season metadata is saved per-season without changing the parent show year', () => {
  const existing = {
    tmdbId: 'tv-1', year: 2018, seasonPosters: {}, seasonYears: {},
  };
  const incoming = {
    tmdbId: 'tv-1', confidence: 100,
    seasonPoster: 'https://image.tmdb.org/t/p/w500/s2.jpg',
    seasonYear: 2020,
  };

  const update = buildTrustedMetadataUpdate(existing, incoming, 2);
  assert.equal(update['seasonPosters.s2'], incoming.seasonPoster);
  assert.equal(update['seasonYears.s2'], 2020);
  assert.equal(update.year, undefined);
});


test('moves one misassigned URL without deleting other mirrors or file variants', () => {
  const record = {
    title: 'Aadhavan',
    tmdbId: 'wrong-owner',
    downloads: [
      {
        filename: 'Angadi.Theru.2010.BD50.iso',
        links: [
          { url: 'https://gdflix.dev/file/angadi-theru' },
          { url: 'https://hubcloud.one/file/angadi-theru-mirror' },
        ],
      },
      {
        filename: 'Aadhavan.2009.BD50.iso',
        links: [{ url: 'https://gdflix.dev/file/aadhavan' }],
      },
    ],
  };

  assert.equal(removeExactDownloadUrlFromRecord(record, 'https://gdflix.dev/file/angadi-theru'), true);
  assert.equal(record.downloads.length, 2);
  assert.deepEqual(
    record.downloads[0].links.map(link => link.url),
    ['https://hubcloud.one/file/angadi-theru-mirror']
  );
  assert.equal(record.downloads[1].links[0].url, 'https://gdflix.dev/file/aadhavan');
  assert.equal(removeExactDownloadUrlFromRecord(record, 'https://unknown/file/not-here'), false);
});
