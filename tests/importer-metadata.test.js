'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseMessageBlock,
  cleanTitleForApi,
  detectAudioChannels,
  extractSize,
  normalizeGdflixUrl,
} = require('../utils/parser');
const { buildTitleCandidates } = require('../utils/tmdbSearch');
const { recomputeAggregates } = require('../pipeline_full');

const pipelineSource = fs.readFileSync(path.join(__dirname, '..', 'pipeline_full.js'), 'utf8');
const sharedSearchSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'tmdbSearch.js'), 'utf8');
const { analyzeVariantSet } = require('../utils/variant-intelligence');

test('shared TMDB candidate engine produces sequel, subtitle and Roman numeral variants', () => {
  const dune = buildTitleCandidates('Dune: Part Two', cleanTitleForApi('Dune: Part Two'), 2024);
  assert.ok(dune.includes('Dune Part 2'));

  const pushpa = buildTitleCandidates('Pushpa 2 The Rule', cleanTitleForApi('Pushpa 2 The Rule'), 2024);
  assert.ok(pushpa.includes('Pushpa The Rule'));

  const baahubali = buildTitleCandidates(
    'Baahubali II The Conclusion',
    cleanTitleForApi('Baahubali II The Conclusion'),
    2017
  );
  assert.ok(baahubali.includes('Baahubali 2 The Conclusion'));
});

test('Telegram parser preserves IDs and all rich filename metadata for DB importer', () => {
  const message = [
    'Pushpa 2 The Rule (2024)',
    'Pushpa.2.The.Rule.2024.1080p.WEB-DL.HEVC.10bit.DDP5.1.Telugu.2.19GB.mkv',
    'https://gdflix.dev/file/abc123',
    'tt12345678 tmdb:123456',
  ].join('\n');

  const parsed = parseMessageBlock(message, 11, '2024-12-01');
  assert.ok(parsed);
  assert.equal(parsed.year, 2024);
  assert.equal(parsed.imdbId, 'tt12345678');
  assert.equal(parsed.tmdbIdHint, '123456');

  const download = parsed.downloads[0];
  assert.equal(download.quality, '1080p');
  assert.equal(download.size, '2.19GB');
  assert.equal(download.language, 'Telugu');
  assert.equal(download.codec, 'HEVC');
  assert.equal(download.hdr, null);
  assert.equal(download.source, 'WEB-DL');
  assert.equal(download.container, 'MKV');
  assert.equal(download.bitDepth, '10-bit');
  assert.equal(download.audioChannels, '5.1');
  assert.equal(download.audio, 'EAC3');
  assert.equal(download.links[0].host, 'GDFlix');
});

test('MongoDB-only importer calls the shared TMDB/OMDb engine and poster fallback chain', () => {
  assert.match(pipelineSource, /sharedMetadataSearch\.searchTMDB\(/);
  assert.match(pipelineSource, /sharedMetadataSearch\.searchOMDB\(/);
  assert.match(pipelineSource, /searchGoogleImage\(rep\.title, rep\.year, isSer\)/);
  assert.match(pipelineSource, /validatePoster\(meta\.poster\)/);
  assert.match(pipelineSource, /rep\.imdbId \|\| null, rep\.tmdbIdHint \|\| null/);
  assert.match(pipelineSource, /const needsMetadata = !existing/);
  assert.match(pipelineSource, /analyzeVariantSet\(group\.items/);
  assert.match(pipelineSource, /DIRECT_HOST_RE = \/gdflix\|hubcloud\|tmbcloud\|/);
});

test('download importer infers missing technical metadata from filenames', () => {
  for (const field of [
    'normalizeQuality(filename)',
    'extractSize(filename)',
    'detectAllLanguages(filename)',
    'detectCodec(filename)',
    'detectHDR(filename)',
    'extractAudio(filename)',
    'detectSource(filename)',
    'detectContainer(filename)',
    'detectBitDepth(filename)',
    'detectAudioChannels(filename)',
    'extractSeasonEpisode(filename)',
  ]) {
    assert.ok(pipelineSource.includes(field), field);
  }
  assert.match(pipelineSource, /const correctEpisode = item\.episode \?\? fileTags\.episode \?\? null/);
});

test('compact audio channel labels are recognized', () => {
  assert.equal(detectAudioChannels('Movie.DDP5.1.1080p.mkv'), '5.1');
  assert.equal(detectAudioChannels('Movie.DTS-HD7.1.2160p.mkv'), '7.1');
  assert.equal(detectAudioChannels('Movie.2.0.AAC.mkv'), '2.0');
});

test('cross-account variant analysis flags suspicious near-duplicates without dropping links', () => {
  const result = analyzeVariantSet([
    { title: 'Film', year: 2024, quality: '1080p', codec: 'HEVC', audio: 'DDP 5.1', language: 'Telugu', size: '6 GB', url: 'https://a/1' },
    { title: 'Film', year: 2024, quality: '1080p', codec: 'HEVC', audio: 'DDP 5.1', language: 'Telugu', size: '6.02 GB', url: 'https://b/2' },
    { title: 'Film', year: 2024, quality: '720p', codec: 'H.264', audio: 'AAC', language: 'Hindi', size: '2 GB', url: 'https://c/3' },
  ], { sizeTolerance: 0.01 });

  assert.equal(result.totalReceived, 3);
  assert.equal(result.uniqueVariants, 3);
  assert.equal(result.nearDuplicates.length, 1);
});

test('TMDB main poster and season poster are returned and saved separately', () => {
  assert.match(sharedSearchSource, /poster:\s+d\.poster_path/);
  assert.match(sharedSearchSource, /seasonPoster:\s+extra\.seasonPoster/);
  assert.match(pipelineSource, /seasonPosters\.s\$\{rep\.season\}/);
  assert.match(pipelineSource, /seasonPosters: rep\.season && meta\.seasonPoster/);
});

test('catalogue importer applies cross-account ranking without breaking quality-first order', () => {
  const doc = {
    title: 'Example Film',
    year: 2020,
    downloads: [
      { quality: '1080p', source: 'WEB-DL', codec: 'H.264', audio: 'AAC 2.0', size: '6.7 GB', language: 'Telugu', links: [{ url: 'https://acc2/large' }] },
      { quality: '1080p', source: 'BluRay', codec: 'H.264', audio: 'AAC 2.0', size: '6.3 GB', language: 'Telugu', links: [{ url: 'https://acc1/better' }] },
      { quality: '720p', source: 'WEB-DL', codec: 'H.264', audio: 'AAC 2.0', size: '9 GB', language: 'Telugu', links: [{ url: 'https://acc1/720p' }] },
    ],
  };

  recomputeAggregates(doc);
  assert.deepEqual(doc.downloads.map(item => item.quality), ['1080p', '1080p', '720p']);
  assert.equal(doc.downloads[0].source, 'BluRay', 'stronger source wins inside the close-size 1080p cluster');
  assert.equal(doc.downloads[1].source, 'WEB-DL');
  assert.equal(doc.downloads[2].links[0].url, 'https://acc1/720p', 'quality-first order is retained');
  assert.equal(doc.downloads.length, 3, 'ranking keeps every variant');
});


test('extracts labelled, comma-formatted and binary file sizes', () => {
  assert.equal(extractSize('File Size: 1,200 MB'), '1200MB');
  assert.equal(extractSize('💾 Size - 2.45 GiB'), '2.45GB');
  assert.equal(extractSize('Movie.1080p.5.75GB.mkv'), '5.75GB');
  assert.equal(extractSize('[ 850 MiB ]'), '850MB');
});

test('recovers per-file sizes placed between filenames and download URLs', () => {
  const parsed = parseMessageBlock([
    'Example Film (2024)',
    'Example.Film.2024.1080p.WEB-DL.mkv',
    'File Size: 2.45 GB',
    'https://new5.gdflix.xyz/file/size-one',
    'Example.Film.2024.720p.WEB-DL.mkv',
    '💾 1.1 GB',
    'https://mirror.hubcloud.app/file/size-two',
  ].join('\n'), 77, '2024-08-01');

  assert.ok(parsed);
  assert.equal(parsed.downloads.length, 2);
  assert.equal(parsed.downloads[0].size, '2.45GB');
  assert.equal(parsed.downloads[1].size, '1.1GB');
  assert.equal(parsed.downloads[0].links[0].url, 'https://gdflix.dev/file/size-one');
  assert.equal(parsed.downloads[1].links[0].url, 'https://hubcloud.one/file/size-two');
});

test('provider normalization handles new subdomains and TLD rotations safely', () => {
  assert.equal(
    normalizeGdflixUrl('https://edge.new5.gdflix.xyz/file/abc?token=1'),
    'https://gdflix.dev/file/abc?token=1'
  );
  assert.equal(
    normalizeGdflixUrl('https://mirror.tmbcloud.cloud/dl/abc'),
    'https://tmbcloud.dev/dl/abc'
  );
  assert.equal(
    normalizeGdflixUrl('https://www.example.com/file/abc'),
    'https://www.example.com/file/abc'
  );
});

test('recovers a labelled size placed immediately before its filename', () => {
  const parsed = parseMessageBlock([
    'Another Film (2022)',
    'Size: 3.25 GB',
    'Another.Film.2022.1080p.BluRay.mkv',
    'https://node.gdflix.xyz/file/size-before',
  ].join('\n'), 78, '2022-10-01');

  assert.ok(parsed);
  assert.equal(parsed.downloads[0].size, '3.25GB');
  assert.equal(parsed.downloads[0].filename, 'Another.Film.2022.1080p.BluRay.mkv');
});
