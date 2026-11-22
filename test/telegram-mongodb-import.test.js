'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { readExport, extractLinksFromMessages, isJunkUrl } = require('../import-telegram-json-to-mongodb');

test('Telegram JSON validator accepts full account exports and checks message identity', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), 'xloop-test-export-' + process.pid + '.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      exported_at: '2026-11-22T00:00:00.000Z',
      scrape_mode: 'full',
      total_messages_collected: 1,
      messages: [{ id: 1, channel_id: 123, text: 'Example' }],
    }));
    const result = readExport(file, '1');
    assert.equal(result.messageCount, 1);
    assert.equal(result.uniqueMessageCount, 1);
    assert.equal(result.scrapeMode, 'full');
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('Telegram JSON validator rejects non-full and inconsistent exports', () => {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const file = path.join(os.tmpdir(), 'xloop-test-export-' + process.pid + '.json');
  try {
    fs.writeFileSync(file, JSON.stringify({
      scrape_mode: 'new',
      total_messages_collected: 1,
      messages: [{ id: 1, channel_id: 123 }],
    }));
    assert.throws(() => readExport(file, '1'), /not a full scrape/);
    fs.writeFileSync(file, JSON.stringify({
      scrape_mode: 'full',
      total_messages_collected: 2,
      messages: [{ id: 1, channel_id: 123 }],
    }));
    assert.throws(() => readExport(file, '1'), /count does not match/);
  } finally {
    try { fs.unlinkSync(file); } catch (_) {}
  }
});

test('Telegram message extractor tags account source and deduplicates repeated message ids', () => {
  const messages = [
    { id: 10, channel_id: 123, text: 'Test Film (2024) 1080p [1.5GB]\nhttps://gdflix.dev/test-file' },
    { id: 10, channel_id: 123, text: 'Test Film (2024) 1080p [1.5GB]\nhttps://gdflix.dev/test-file' },
  ];
  const result = extractLinksFromMessages(messages, '2');
  assert.equal(result.uniqueMessages, 1);
  assert.ok(Array.isArray(result.links));
  for (const link of result.links) assert.equal(link.sourceAccount, '2');
});

test('CDN and image URLs are rejected while file hosts are retained', () => {
  assert.equal(isJunkUrl('https://example.com/poster/image.jpg'), true);
  assert.equal(isJunkUrl('https://cdn.cloudfront.net/video.m3u8'), true);
  assert.equal(isJunkUrl('https://gdflix.dev/file/123'), false);
});
