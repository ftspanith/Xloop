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
  assert.ok(result.links.length > 0, 'sample Telegram post should produce at least one download link');
  for (const link of result.links) assert.equal(link.sourceAccount, '2');
});

test('promotion-only messages are excluded while mixed download promotions retain links', () => {
  const promoOnly = {
    id: 20, channel_id: 999, text: 'Join our channel https://t.me/xloop',
    classification: { is_promotion: true, is_download: false },
  };
  const mixed = {
    id: 21, channel_id: 999,
    text: 'Example Film 2026 1080p [1.5GB]\nhttps://gdflix.dev/example-file\nhttps://bit.ly/join-channel\nhttps://unknown.example/extra\nhttps://bit.ly/possibly-download',
    links: [
      { url: 'https://gdflix.dev/example-file', purpose: 'download' },
      { url: 'https://bit.ly/join-channel', purpose: 'promotion' },
      { url: 'https://unknown.example/extra', purpose: 'review' },
      { url: 'https://bit.ly/possibly-download', purpose: 'unknown' },
    ],
    classification: { is_promotion: true, is_download: true, needs_review: true },
  };
  const reviewOnly = {
    id: 22, channel_id: 999,
    text: 'Maybe useful: https://unknown.example/article',
    links: [{ url: 'https://unknown.example/article', purpose: 'review' }],
    classification: { is_promotion: false, is_download: false, needs_review: true },
  };
  const result = extractLinksFromMessages([promoOnly, mixed, reviewOnly], '1');
  assert.ok(result.links.length > 0, 'mixed download/promotion should retain its valid download URL');
  assert.ok(result.links.every(link => link.url.includes('gdflix.dev')));
  assert.equal(result.uniqueMessages, 3);
  assert.equal(result.skipped, 2);
});

test('link-purpose matching does not collapse case-sensitive URL IDs', () => {
  const msg = {
    id: 23,
    channel_id: 999,
    text: 'Example Movie 2026 1080p WEB-DL\nhttps://bit.ly/ABC123\nhttps://bit.ly/abc123',
    links: [
      { url: 'https://bit.ly/ABC123', purpose: 'promotion' },
      { url: 'https://bit.ly/abc123', purpose: 'download' },
    ],
    classification: { is_promotion: true, is_download: true, needs_review: false },
  };
  const result = extractLinksFromMessages([msg], '1');
  assert.ok(result.links.some(link => link.url.endsWith('/abc123')));
  assert.ok(result.links.every(link => !link.url.endsWith('/ABC123')));
});

test('CDN and image URLs are rejected while file hosts are retained', () => {
  assert.equal(isJunkUrl('https://example.com/poster/image.jpg'), true);
  assert.equal(isJunkUrl('https://cdn.cloudfront.net/video.m3u8'), true);
  assert.equal(isJunkUrl('https://gdflix.dev/file/123'), false);
  assert.equal(isJunkUrl('https://filepress.in/uploads/abc123'), false);
});

test('scraper requires an explicit channel allowlist for each Telegram account', () => {
  const fs = require('fs');
  const path = require('path');
  const source = fs.readFileSync(path.join(__dirname, '..', 'scrape_api.js'), 'utf8');
  assert.match(source, /PROFILE === 2 \? 'TG_CHANNELS_2' : 'TG_CHANNELS_1'/);
  assert.match(source, /if \(!ACCOUNT_CHANNELS_ENV \|\| !ACCOUNT_CHANNELS_ENV\.trim\(\)\)/);
  assert.match(source, /refusing to scrape an implicit\/default list/);
  assert.doesNotMatch(source, /: ALL_CHANNEL_IDS/);
});
