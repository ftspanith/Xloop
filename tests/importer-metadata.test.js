'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  parseMessageBlock,
  cleanTitleForApi,
  detectAudioChannels,
  detectAllLanguages,
  classifyLanguageType,
  detectReleaseMetadata,
} = require('../utils/parser');
const { buildTitleCandidates } = require('../utils/tmdbSearch');
const { recomputeAggregates } = require('../pipeline_full');

const pipelineSource = fs.readFileSync(path.join(__dirname, '..', 'pipeline_full.js'), 'utf8');
const sharedSearchSource = fs.readFileSync(path.join(__dirname, '..', 'utils', 'tmdbSearch.js'), 'utf8');
const { analyzeVariantSet, inferRepackStatus, rankVariantsForDisplay } = require('../utils/variant-intelligence');

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


test('language classification counts explicit tracks as Single, Dual, or Multi', () => {
  assert.equal(classifyLanguageType(detectAllLanguages('Telugu')), 'Single');
  assert.equal(classifyLanguageType(detectAllLanguages('Hindi + English')), 'Dual');
  assert.equal(classifyLanguageType(detectAllLanguages('Hindi + Telugu + Tamil + Kanada')), 'Multi');
  assert.equal(classifyLanguageType(detectAllLanguages('Dual Audio Hindi English'), 'Dual Audio Hindi English'), 'Dual');
});

test('release filename parser extracts IMAX, aspect ratio, runtime and CBFC certificate', () => {
  const info = detectReleaseMetadata('Film.2160p.IMAX.1.90:1.Runtime.2h33m.CBFC.UA.13+.mkv');
  assert.equal(info.isIMAX, true);
  assert.equal(info.aspectRatio, '1.90:1');
  assert.equal(info.runtimeMinutes, 153);
  assert.equal(info.certification, 'UA 13+');
  assert.equal(info.isRepack, false);
  assert.equal(detectReleaseMetadata('Film.1080p.1920x800.mkv').aspectRatio, '2.40:1');
});

test('explicit and inferred repacks remain separate and rank before main releases', () => {
  const main = {
    quality: '1080p', source: 'WEBRip', codec: 'H.264', audio: 'AAC',
    size: '1.8 GB', language: 'Hindi', season: null, episode: null,
    uploadDate: '2024-01-01T00:00:00.000Z', isRepack: false,
  };
  const later = {
    ...main, source: 'BluRay', codec: 'HEVC', hdr: 'HDR10', isIMAX: true,
    aspectRatio: '1.90:1', runtimeMinutes: 153, size: '2.2 GB',
    uploadDate: '2024-02-01T00:00:00.000Z',
  };
  const status = inferRepackStatus(later, [main]);
  assert.equal(status.isRepack, true);
  assert.equal(status.releaseType, 'repack');
  const variants = rankVariantsForDisplay([
    {...main, releaseType: 'main'},
    {...later, ...status},
  ]);
  assert.equal(variants.length, 2, 'main and repack are both retained');
  assert.equal(variants[0].releaseType, 'repack');
  assert.equal(variants[1].releaseType, 'main');
  const explicit = inferRepackStatus({isRepack:true,repackReason:'REPACK'}, []);
  assert.equal(explicit.releaseType, 'repack');
});

test('repack ranks ahead of main even when main has higher resolution', () => {
  const items = rankVariantsForDisplay([
    {quality:'4K',releaseType:'main',isRepack:false,source:'BluRay',codec:'HEVC',size:'8 GB'},
    {quality:'1080p',releaseType:'repack',isRepack:true,source:'WEB-DL',codec:'HEVC',size:'2 GB'},
  ]);
  assert.equal(items[0].releaseType, 'repack');
  assert.equal(items[1].releaseType, 'main');
  assert.deepEqual(items.map(item => item.quality), ['1080p', '4K']);
});

test('a later same-episode higher-resolution encode can be inferred as a repack', () => {
  const main = {
    quality:'1080p', source:'WEB-DL', codec:'H.264', audio:'AAC',
    size:'2 GB', season:null, episode:null, uploadDate:'2024-01-01',
  };
  const higherResolution = {
    ...main, quality:'4K', source:'BluRay', codec:'HEVC', hdr:'HDR10',
    audio:'DTS-HD', size:'8 GB', uploadDate:'2024-02-01',
  };
  assert.equal(inferRepackStatus(higherResolution,[main]).isRepack,true);
  assert.equal(inferRepackStatus({...higherResolution,quality:'720p'},[main]).isRepack,false);
});

test('a later upload date alone does not turn an otherwise equal encode into a repack', () => {
  const old = {quality:'1080p',source:'WEB-DL',codec:'HEVC',size:'2 GB',uploadDate:'2024-01-01'};
  const newer = {...old,uploadDate:'2024-02-01'};
  assert.equal(inferRepackStatus(newer,[old]).isRepack,false);
});

test('importer enriches existing exact URLs instead of skipping repack metadata', () => {
  assert.match(pipelineSource, /const duplicateIndex = \(dbRec\.downloads \|\| \[\]\)\.findIndex/);
  assert.match(pipelineSource, /if \(newDl\.isRepack\) \{/);
  assert.match(pipelineSource, /downloads\.\$\{duplicateIndex\}\.releaseType/);
  assert.match(pipelineSource, /recomputeAggregates\(enriched\)/);
});

test('importer preserves releases with different language-track sets', () => {
  assert.match(pipelineSource, /if \(!languagesCompatible\) continue/);
  assert.match(pipelineSource, /normalizeLanguages\(ex\.language\) === normalizeLanguages\(language\)/);
});

test('bit-depth and audio-channel upgrades contribute to repack inference', () => {
  const old = {
    quality:'1080p', source:'WEB-DL', codec:'HEVC', audio:'AAC',
    bitDepth:'8-bit', audioChannels:'2.0', size:'2 GB',
    uploadDate:'2024-01-01',
  };
  const newer = {
    ...old, bitDepth:'10-bit', audioChannels:'5.1',
    uploadDate:'2024-02-01',
  };
  assert.equal(inferRepackStatus(newer,[old]).isRepack,true);
});
