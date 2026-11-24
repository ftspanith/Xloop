'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractTelegramLinks } = require('../utils/telegram-ingestion');
const {
  parseMessageBlock, extractSize, fallbackTitleFromText, normalizeProviderUrl,
} = require('../utils/parser');

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


test('recovers a title from the file name when the Telegram heading is not searchable', () => {
  const text = [
    'Movie 1080p',
    'The.Real.Film.2024.1080p.WEB-DL.HEVC.mkv',
    'Audio: Telugu',
    'Source: WEB-DL',
    'File Size: 4.25 GiB',
    'Quality: 1080p HDR',
    'GDFlix',
    'https://mirror.gdflix.xyz/file/title-size-test',
  ].join('\n');

  const parsed = parseMessageBlock(text, 303, '2024-06-01');
  assert.ok(parsed, 'the valid download should survive a poor heading');
  assert.equal(fallbackTitleFromText('The.Real.Film.2024.1080p.WEB-DL.HEVC.mkv', 2024), 'The Real Film');

  const extracted = extractTelegramLinks([{
    channel_id: '123', id: 303, date: '2024-06-01', text,
  }], '1');
  assert.equal(extracted.links.length, 1);
  assert.equal(extracted.links[0].title, 'The Real Film');
  assert.equal(extracted.links[0].size, '4.25GB');
  assert.equal(extracted.links[0].url, 'https://gdflix.xyz/file/title-size-test');
});

test('extracts sizes across labels, binary units and decimal-comma formatting', () => {
  assert.equal(extractSize('File Size: 1,250 MB'), '1250MB');
  assert.equal(extractSize('Size - 2,5 GiB'), '2.5GB');
  assert.equal(extractSize('[4.26 TiB]'), '4.26TB');
});

test('canonical importer normalization agrees with provider family recognition', () => {
  assert.equal(
    normalizeProviderUrl('http://mirror.gdflix.xyz/file/abc?token=1'),
    'https://gdflix.dev/file/abc?token=1'
  );
  assert.equal(
    normalizeProviderUrl('https://cdn.hubcloud.sbs/file/abc#frag'),
    'https://hubcloud.one/file/abc#frag'
  );
  assert.equal(
    normalizeProviderUrl('https://mirror.tmbcloud.site/file/abc'),
    'https://tmbcloud.dev/file/abc'
  );
});
