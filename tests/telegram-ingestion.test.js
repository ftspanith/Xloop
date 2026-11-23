'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeTelegramMessages,
  normalizeTelegramUrl,
  isJunkTelegramUrl,
  telegramMessageText,
  extractTelegramLinks,
  isAllowedTelegramDownloadUrl,
} = require('../utils/telegram-ingestion');

test('dedupes overlapping Telegram exports by channel and message id', () => {
  const messages = [
    { channel_id: '100', id: 7, text: 'first' },
    { channel_id: '100', id: 7, text: 'duplicate' },
    { channel_id: '200', id: 7, text: 'other channel' },
  ];
  const result = dedupeTelegramMessages(messages);
  assert.equal(result.length, 2);
  assert.equal(result[0].text, 'first');
});

test('normalizes protocol and trailing slash without changing query', () => {
  assert.equal(
    normalizeTelegramUrl('http://example.com/file/abc/?download=1'),
    'https://example.com/file/abc?download=1'
  );
});

test('filters known image/video CDN URLs but keeps file links', () => {
  assert.equal(isJunkTelegramUrl('https://cdn.example.com/poster/image.jpg'), true);
  assert.equal(isJunkTelegramUrl('https://files.example.com/movie.mkv'), false);
});

test('extracts visible text, text-link entities and inline keyboard URLs', () => {
  const value = telegramMessageText({
    text: [{ type: 'text', text: 'Movie' }, { type: 'text_link', text: 'Mirror', href: 'https://example.com/file' }],
    reply_markup: { inline_keyboard: [[{ text: 'Backup', url: 'https://backup.example/file' }]] },
  });
  assert.match(value, /Movie/);
  assert.match(value, /https:\/\/example\.com\/file/);
  assert.match(value, /https:\/\/backup\.example\/file/);
});

test('returns a safe empty extraction for malformed message arrays', () => {
  const result = extractTelegramLinks([null, {}, { id: 1, text: '' }], '2');
  assert.equal(result.links.length, 0);
  assert.equal(result.stats.uniqueMessages, 1);
  assert.equal(result.stats.skippedMessages, 1);
});


test('allowlist keeps only GDFlix, HubCloud and TMBCloud provider domains', () => {
  const allowed = [
    'https://gdflix.dev/file/abc',
    'https://new5.gdflix.io/file/abc',
    'https://gdtot.one/file/abc',
    'https://extralink.cfd/file/abc',
    'https://hubcloud.foo/file/abc',
    'https://drivehub.online/file/abc',
    'https://tmbcloud.dev/file/abc',
  ];
  for (const url of allowed) assert.equal(isAllowedTelegramDownloadUrl(url), true, url);
});

test('allowlist rejects website links, other direct hosts and shorteners', () => {
  const rejected = [
    'https://example.com/watch/movie',
    'https://example.com/download/movie.mkv',
    'https://filepress.in/file/abc',
    'https://dtflix.ink/file/abc',
    'https://streamtape.com/v/abc',
    'https://gplinks.co/abc',
    'https://not-a-provider.example/path?next=https://gdflix.dev/file/abc',
  ];
  for (const url of rejected) assert.equal(isAllowedTelegramDownloadUrl(url), false, url);
});

test('shared Telegram extraction retains approved providers and rejects all other hosts', () => {
  const message = {
    channel_id: '123',
    id: 99,
    text: [
      'Example Movie (2024)',
      'Example.Movie.2024.1080p.WEB-DL.mkv',
      'GDFlix',
      'https://gdflix.dev/file/one',
      'HubCloud',
      'https://hubcloud.foo/file/two',
      'TMBCloud',
      'https://tmbcloud.dev/file/three',
      'FilePress',
      'https://filepress.in/file/four',
      'Website',
      'https://example.com/download/five.mkv',
    ].join('\\n'),
  };
  const result = extractTelegramLinks([message], '1');
  assert.deepEqual(new Set(result.links.map((link) => link.host)), new Set(['GDFlix', 'HubCloud', 'TMBCloud']));
  assert.equal(result.links.length, 3);
  assert.equal(result.stats.rejectedLinks, 2);
});
