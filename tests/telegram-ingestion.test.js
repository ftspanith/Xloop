'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  dedupeTelegramMessages,
  normalizeTelegramUrl,
  isJunkTelegramUrl,
  telegramMessageText,
  extractTelegramLinks,
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
