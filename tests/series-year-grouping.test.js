'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseMessageBlock, extractYear, extractYearCandidates } = require('../utils/parser');
const { dedupeSeriesDocuments, mergeSeriesDocuments } = require('../utils/seriesGrouping');

test('separates a series premiere year from later season filename years', () => {
  const message = [
    'The Long Show (2018)',
    'The.Long.Show.S01E01.2018.1080p.WEB-DL.HEVC.1GB.mkv',
    'https://gdflix.dev/file/long-show-s1e1',
    'The.Long.Show.S04E01.2022.1080p.WEB-DL.HEVC.1GB.mkv',
    'https://gdflix.dev/file/long-show-s4e1',
  ].join('\n');

  const parsed = parseMessageBlock(message, 100, '2022-01-01');
  assert.ok(parsed);
  assert.equal(parsed.isSeries, true);
  assert.equal(parsed.messageYear, 2018);
  assert.equal(parsed.year, 2018);
  assert.deepEqual(parsed.yearCandidates.sort((a, b) => a - b), [2018, 2022]);
  assert.deepEqual(
    parsed.downloads.map(file => file.fileYear).sort((a, b) => a - b),
    [2018, 2022]
  );
});

test('filename-only season years do not become a TV premiere year', () => {
  const filename = 'The.Long.Show.S04E01.2023.1080p.WEB-DL.HEVC.1GB.mkv';
  assert.equal(extractYear([filename]), 2023);
  assert.deepEqual(extractYearCandidates([
    filename,
    'The.Long.Show.S05E01.2024.1080p.WEB-DL.HEVC.1GB.mkv',
  ]).sort((a, b) => a - b), [2023, 2024]);

  const parsed = parseMessageBlock([
    filename,
    'https://gdflix.dev/file/long-show-s4-only',
  ].join('\n'), 101, '2023-01-01');
  assert.ok(parsed);
  assert.equal(parsed.messageYear, null);
  assert.equal(parsed.year, 2023);
  assert.equal(parsed.downloads[0].fileYear, 2023);
});

test('legacy year-split series documents merge seasons, packs, and their download links', () => {
  const merged = mergeSeriesDocuments([
    {
      _id: 'show-original',
      title: 'The Long Show',
      tmdbId: '5001',
      type: 'series',
      year: 2018,
      releaseDate: '2018-04-10',
      totalSeasons: 5,
      seasonYears: { s1: 2018 },
      downloads: [
        {
          season: 1,
          episode: null,
          filename: 'The.Long.Show.S01.PACK.2018.mkv',
          fileYear: 2018,
          quality: '1080p',
          size: '5GB',
          links: [{ host: 'GDFlix', url: 'https://gdflix.dev/file/s1-pack' }],
        },
      ],
    },
    {
      _id: 'show-season-four',
      title: 'The Long Show',
      tmdbId: '5001',
      type: 'series',
      year: 2022,
      totalSeasons: 5,
      seasonYears: { s4: 2022 },
      downloads: [
        {
          season: 4,
          episode: 1,
          filename: 'The.Long.Show.S04E01.2022.mkv',
          fileYear: 2022,
          quality: '1080p',
          size: '1GB',
          links: [{ host: 'HubCloud', url: 'https://hubcloud.one/file/s4-e1' }],
        },
      ],
    },
  ]);

  assert.equal(merged.year, 2018, 'parent card keeps the original series premiere year');
  assert.equal(merged.downloads.length, 2);
  assert.deepEqual(merged.seasonYears, { s1: 2018, s4: 2022 });
  assert.equal(merged._groupedDocumentCount, 2);
  assert.deepEqual(merged.downloads.map(file => file.season).sort((a, b) => a - b), [1, 4]);
  const seasonPack = merged.downloads.find(file => file.season === 1);
  const seasonFourEpisode = merged.downloads.find(file => file.season === 4);
  assert.deepEqual(seasonPack.links.map(link => link.url), ['https://gdflix.dev/file/s1-pack']);
  assert.deepEqual(seasonFourEpisode.links.map(link => link.url), ['https://hubcloud.one/file/s4-e1']);
});

test('series and anime classification variants with the same TMDB id still produce one parent card', () => {
  const grouped = dedupeSeriesDocuments([
    {
      _id: 'tv-series',
      title: 'Example Anime',
      tmdbId: '777',
      type: 'series',
      year: 2019,
      downloads: [{ season: 1, episode: 1, filename: 'Example.Anime.S01E01.mkv', links: [{ url: 'https://gdflix.dev/file/ep1' }] }],
    },
    {
      _id: 'tv-anime',
      title: 'Example Anime',
      tmdbId: '777',
      type: 'anime',
      year: 2019,
      downloads: [{ season: 2, episode: 1, filename: 'Example.Anime.S02E01.mkv', links: [{ url: 'https://gdflix.dev/file/ep2' }] }],
    },
  ]);

  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].type, 'anime');
  assert.equal(grouped[0].downloads.length, 2);
  const animeUrls = grouped[0].downloads.flatMap(file => file.links.map(link => link.url)).sort();
  assert.deepEqual(animeUrls, [
    'https://gdflix.dev/file/ep1',
    'https://gdflix.dev/file/ep2',
  ]);
});


test('search route groups season-specific Series and Anime candidates before ranking', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'routes', 'search.js'), 'utf8');
  assert.match(source, /require\(['"]\.\.\/utils\/seriesGrouping['"]\)/);
  assert.match(source, /dedupeSeriesDocuments\(/);
  assert.match(source, /const uniqueCandidates = \[\.\.\.movieCandidates, \.\.\.seriesCandidates\]/);
});
