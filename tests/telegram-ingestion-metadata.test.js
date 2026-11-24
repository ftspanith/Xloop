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
      'Sample.Movie.2023.1080p.WEB-DL.HEVC.10bit.DDP5.1.mkv',
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
  assert.equal(entry.year, 2023);
  assert.equal(entry.rawTitle, 'Sample Movie (2023)');
});


test('Telegram ingestion accepts bare rotated provider URLs and normalizes them', () => {
  const message = {
    channel_id: '123',
    id: 203,
    date: '2024-02-02',
    text: [
      'Another Sample Film (2024)',
      'Another.Sample.Film.2024.1080p.WEB-DL.2.4GB.mkv',
      'edge.new5.gdflix.xyz/file/bare-gdflix',
      'Another.Sample.Film.2024.720p.WEB-DL.1.2GB.mkv',
      'mirror.hubcloud.app/file/bare-hubcloud',
    ].join('\n'),
  };
  const result = extractTelegramLinks([message], '1');
  assert.equal(result.links.length, 2);
  assert.deepEqual(
    result.links.map(entry => entry.url).sort(),
    [
      'https://gdflix.dev/file/bare-gdflix',
      'https://hubcloud.one/file/bare-hubcloud',
    ]
  );
  assert.deepEqual(
    result.links.map(entry => entry.size).sort(),
    ['1.2GB', '2.4GB']
  );
});
