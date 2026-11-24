'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTelegramLinks } = require('../utils/telegram-ingestion');

test('preserves complete filename metadata for the MongoDB importer', () => {
  const message = {
    channel_id: '123',
    id: 202,
    date: '2024-02-01',
    text: [
      'Sample Movie (2023)',
      'Sample.Movie.2023.1080p.WEB-DL.HEVC.10bit.DDP5.1.Hindi+English.IMAX.1.90:1.Runtime.153min.CBFC.UA.13+.REPACK.mkv',
      'https://gdflix.dev/file/metadata-test',
    ].join('\n'),
  };
  const result = extractTelegramLinks([message], '1');
  assert.equal(result.links.length, 1);
  const entry = result.links[0];
  assert.equal(entry.host, 'GDFlix');
  assert.equal(entry.source, 'WEB-DL');
  assert.equal(entry.container, 'MKV');
  assert.equal(entry.bitDepth, '10-bit');
  assert.equal(entry.audioChannels, '5.1');
  assert.equal(entry.codec, 'HEVC');
  assert.equal(entry.audio, 'EAC3');
  assert.equal(entry.languageType, 'Dual');
  assert.equal(entry.isRepack, true);
  assert.equal(entry.releaseType, 'repack');
  assert.equal(entry.isIMAX, true);
  assert.equal(entry.aspectRatio, '1.90:1');
  assert.equal(entry.runtimeMinutes, 153);
  assert.equal(entry.certification, 'UA 13+');
  assert.equal(entry.uploadDate, '2024-02-01');
  assert.equal(entry.year, 2023);
  assert.equal(entry.rawTitle, 'Sample Movie (2023)');
});
