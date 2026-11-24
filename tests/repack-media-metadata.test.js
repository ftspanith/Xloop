'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  parseMessageBlock,
  classifyLanguages,
  detectReleaseMetadata,
  extractMediaMetadata,
} = require('../utils/parser');
const { extractTelegramLinks } = require('../utils/telegram-ingestion');
const { rankVariantsForDisplay } = require('../utils/variant-intelligence');
const fs = require('node:fs');
const path = require('node:path');

test('classifies one, two, and three-or-more named audio languages correctly', () => {
  assert.equal(classifyLanguages(['Telugu']).languageType, 'Single');
  assert.equal(classifyLanguages(['Hindi', 'English']).languageType, 'Dual');
  assert.equal(classifyLanguages(['Hindi', 'Telugu', 'Tamil', 'Kannada']).languageType, 'Multi');
  assert.equal(classifyLanguages('Hindi + English').languageCount, 2);
  assert.equal(classifyLanguages([], 'DUAL AUDIO').languageType, 'Dual');
  assert.equal(classifyLanguages([], 'MULTI AUDIO').languageType, 'Multi');
});

test('detects repacks and keeps proper releases distinct', () => {
  assert.deepEqual(detectReleaseMetadata('Example.Film.REPACK.1080p.mkv'), {
    isRepack: true,
    releaseType: 'Repack',
  });
  assert.equal(detectReleaseMetadata('Example.Film.PROPER.1080p.mkv').releaseType, 'Proper');
  assert.equal(detectReleaseMetadata('Example.Film.1080p.mkv').isRepack, false);
});

test('extracts IMAX, aspect ratio, runtime and CBFC certificate labels', () => {
  const metadata = extractMediaMetadata([
    'Format: IMAX',
    'Screen Ratio: 1.90:1',
    'Runtime: 2h 30m',
    'CBFC: U/A 16+',
  ].join('\n'));

  assert.equal(metadata.isIMAX, true);
  assert.equal(metadata.aspectRatio, '1.90:1');
  assert.equal(metadata.runtimeMinutes, 150);
  assert.equal(metadata.duration, '2h 30m');
  assert.equal(metadata.certification, 'U/A 16+');
});

test('Telegram extraction carries repack and media metadata through to importer records', () => {
  const message = {
    channel_id: '123',
    id: 303,
    date: '2024-03-01',
    text: [
      'Example Film (2024)',
      'Example.Film.2024.1080p.WEB-DL.HEVC.Telugu.Hindi.Tamil.Kannada.IMAX.REPACK.1.90:1.mkv',
      'Runtime: 2h 30m',
      'Aspect Ratio: 1.90:1',
      'CBFC: U/A 16+',
      'https://gdflix.dev/file/repack-metadata-test',
    ].join('\n'),
  };

  const result = extractTelegramLinks([message], '1');
  assert.equal(result.links.length, 1);
  const entry = result.links[0];

  assert.equal(entry.isRepack, true);
  assert.equal(entry.releaseType, 'Repack');
  assert.equal(entry.isIMAX, true);
  assert.equal(entry.aspectRatio, '1.90:1');
  assert.equal(entry.runtimeMinutes, 150);
  assert.equal(entry.duration, '2h 30m');
  assert.equal(entry.certification, 'U/A 16+');
  assert.equal(entry.languageType, 'Multi');
  assert.equal(entry.languageCount, 4);
});

test('parser exposes media metadata and release status on individual download variants', () => {
  const parsed = parseMessageBlock([
    'Example Film (2024)',
    'Example.Film.2024.1080p.REPACK.Telugu.Hindi.mkv',
    'https://gdflix.dev/file/parser-repack-test',
    'CBFC: UA 13+',
    'Runtime: 145 min',
  ].join('\n'), 404);

  assert.ok(parsed);
  assert.equal(parsed.downloads[0].isRepack, true);
  assert.equal(parsed.downloads[0].languageType, 'Dual');
  assert.equal(parsed.languageType, 'Dual');
  assert.equal(parsed.certification, 'U/A 13+');
  assert.equal(parsed.runtimeMinutes, 145);
});

test('repack-first ranking preserves every main and repack variant', () => {
  const ranked = rankVariantsForDisplay([
    { title: 'Example Film', quality: '1080p', size: '5.5 GB', source: 'BluRay', url: 'https://x/main' },
    { title: 'Example Film', quality: '1080p', size: '2.1 GB', source: 'WEB-DL', isRepack: true, releaseType: 'Repack', url: 'https://x/repack' },
  ]);

  assert.deepEqual(ranked.map(item => item.url), ['https://x/repack', 'https://x/main']);
  assert.equal(ranked.length, 2);
});

test('import matching keeps repack and main releases in separate download groups', () => {
  const root = path.join(__dirname, '..');
  const pipeline = fs.readFileSync(path.join(root, 'pipeline_full.js'), 'utf8');
  const movieSchema = fs.readFileSync(path.join(root, 'models', 'Movie.js'), 'utf8');
  const watch = fs.readFileSync(path.join(root, 'public', 'js', 'watch.js'), 'utf8');

  assert.match(pipeline, /if \(!!ex\.isRepack !== !!newDl\.isRepack\) continue/);
  assert.match(pipeline, /isRepack, releaseType, isIMAX, aspectRatio, languageType, languageCount/);
  assert.match(movieSchema, /isRepack: \{ type: Boolean/);
  assert.match(movieSchema, /certification: \{ type: String/);
  assert.match(watch, /title="Repack release">REPACK/);
});
