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
const { classifyUrl: classifyUrlForTest } = require('../utils/parser');

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
    ].join('\n'),
  };
  const result = extractTelegramLinks([message], '1');
  assert.deepEqual(new Set(result.links.map((link) => link.host)), new Set(['GDFlix', 'HubCloud', 'TMBCloud']));
  assert.equal(result.links.length, 3);
  assert.equal(result.stats.rejectedLinks, 2);
});


test('allowlist and normalizer accept provider subdomains on rotated TLDs', () => {
  const examples = [
    ['https://edge.gdflix.xyz/file/abc', 'GDFlix', 'https://gdflix.dev/file/abc'],
    ['https://mirror.hubcloud.app/file/abc', 'HubCloud', 'https://hubcloud.one/file/abc'],
    ['https://cdn.tmbcloud.cloud/file/abc', 'TMBCloud', 'https://tmbcloud.dev/file/abc'],
  ];
  for (const [url, host, normalized] of examples) {
    assert.equal(isAllowedTelegramDownloadUrl(url), true, url);
    assert.equal(classifyUrlForTest(url), host, url);
    assert.equal(normalizeTelegramUrl(url), normalized, url);
  }
});

test('provider matching does not accept lookalike unrelated hostnames', () => {
  const rejected = [
    'https://notgdflix.example.com/file/abc',
    'https://gdflix.example.com/file/abc',
    'https://hubcloud.example.com/file/abc',
  ];
  for (const url of rejected) assert.equal(isAllowedTelegramDownloadUrl(url), false, url);
});


test('uses a descriptive filename instead of a generic cleaned heading', () => {
  const message = {
    channel_id: '456',
    id: 404,
    date: '2024-07-01',
    text: [
      'Movie 1080p',
      'The.Real.Film.2024.1080p.WEB-DL.HEVC.mkv',
      'https://mirror.gdflix.xyz/file/generic-title-test',
    ].join('\n'),
  };
  const result = extractTelegramLinks([message], '1');
  assert.equal(result.links.length, 1);
  assert.equal(result.links[0].title, 'The Real Film');
  assert.equal(result.links[0].rawTitle, 'The.Real.Film.2024.1080p.WEB-DL.HEVC.mkv');
  assert.equal(result.links[0].url, 'https://gdflix.dev/file/generic-title-test');
});


test('splits a single Telegram post containing multiple unrelated BluRay ISO movie entries', () => {
  const message = {
    channel_id: '789',
    id: 8801,
    date: '2026-11-27',
    text: [
      'Aadhavan (2009) AYNGARAN BluRay - BD50 - ORG [Tamil LPCM & DTS-HDMA5.1].iso [39.66 GB]',
      'https://gdflix.dev/file/aadhavan',
      '',
      'Angadi Theru (2010) AYNGARAN BluRay - BD50 - ORG [Tamil LPCM & DTS-HDMA5.1] ESub.iso [43.38 GB]',
      'https://gdflix.dev/file/angadi-theru',
      '',
      'Billa 2 (2012) API BD50 ORG UNTOUCHED TAMIL [LPCM & DTS-HDMA5.1] ESub.iso [39.77 GB]',
      'https://gdflix.dev/file/billa2-api',
      '',
      'Billa 2 (2012) SEYONS BluRay - BD50 -ORG [Tamil DTS-HDMA 5.1 & DD+5.1] ESub.iso [40.02 GB]',
      'https://gdflix.dev/file/billa2-seyons',
      '',
      'Thuppakki (2012) API BluRay - BD50 - ORG [Tamil DTS-HDMA5.1] ESub.iso [39.62 GB]',
      'https://gdflix.dev/file/thuppakki',
    ].join('\n'),
  };

  const result = extractTelegramLinks([message], '1');
  const byUrl = new Map(result.links.map(entry => [entry.url.split('/').pop(), entry]));

  assert.equal(result.links.length, 5);
  assert.equal(byUrl.get('aadhavan').title, 'Aadhavan');
  assert.equal(byUrl.get('aadhavan').year, 2009);
  assert.equal(byUrl.get('angadi-theru').title, 'Angadi Theru');
  assert.equal(byUrl.get('angadi-theru').year, 2010);
  assert.equal(byUrl.get('billa2-api').title, 'Billa 2');
  assert.equal(byUrl.get('billa2-seyons').title, 'Billa 2');
  assert.equal(byUrl.get('thuppakki').title, 'Thuppakki');
  assert.ok(result.links.every(entry => entry.messageId === 8801),
    'all split blocks keep the original Telegram message id');
});

test('does not split multiple editions or mirrors that belong to the same movie', () => {
  const message = {
    channel_id: '789',
    id: 8802,
    text: [
      'Billa 2 (2012) API BluRay BD50 [Tamil DTS-HD MA].iso [39.77 GB]',
      'https://gdflix.dev/file/billa2-edition-one',
      '',
      'Billa 2 (2012) SEYONS BluRay BD50 [Tamil DTS-HD MA].iso [40.02 GB]',
      'https://gdflix.dev/file/billa2-edition-two',
    ].join('\n'),
  };

  const result = extractTelegramLinks([message], '1');
  assert.equal(result.links.length, 2);
  assert.deepEqual(new Set(result.links.map(entry => entry.title)), new Set(['Billa 2']));
});
