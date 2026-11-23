'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const source = fs.readFileSync(path.join(__dirname, '../public/js/watch.js'), 'utf8');
const browser = {
  URL,
  document: {
    addEventListener() {},
    getElementById() { return null; },
  },
};
browser.window = browser;
vm.runInNewContext(source, browser, { filename: 'public/js/watch.js' });

function makeDownload(id, quality, size, language, host = 'HubCloud', episode = {}) {
  return {
    filename: 'Example Film ' + quality + ' ' + language,
    quality,
    size,
    season: episode.season,
    episode: episode.episode,
    links: [{ url: 'https://example.test/' + id, host }],
  };
}

function getRenderedLinks(downloads) {
  const html = browser.buildDownloadSection(downloads, 'Hindi', 'movie');
  return {
    html,
    hrefs: [...html.matchAll(/<a href="([^"]+)" target="_blank"/g)].map(match => match[1]),
  };
}

test('sorts variants by numeric size descending within resolution, before language priority', () => {
  const downloads = [
    makeDownload('multi-368-a', '1080p', '3.68 GB', 'MULTI', 'HubCloud'),
    makeDownload('telugu-799', '1080p', '7.99 GB', 'Telugu'),
    makeDownload('multi-957-b', '1080p', '9.57 GB', 'MULTI', 'HubCloud'),
    makeDownload('hindi-234', '1080p', '2.34 GB', 'Hindi'),
    makeDownload('multi-957-a', '1080p', '9.57 GB', 'MULTI', 'GDFlix'),
    makeDownload('multi-368-b', '1080p', '3.68 GB', 'MULTI', 'TMBCloud'),
    makeDownload('720-telugu', '720p', '989.18 MB', 'Telugu'),
    makeDownload('720-hindi', '720p', '879.41 MB', 'Hindi'),
    makeDownload('480-hindi', '480p', '578.89 MB', 'Hindi'),
  ];

  const { hrefs } = getRenderedLinks(downloads);
  assert.deepEqual(hrefs, [
    'https://example.test/multi-957-a',
    'https://example.test/multi-957-b',
    'https://example.test/telugu-799',
    'https://example.test/multi-368-a',
    'https://example.test/multi-368-b',
    'https://example.test/hindi-234',
    'https://example.test/720-telugu',
    'https://example.test/720-hindi',
    'https://example.test/480-hindi',
  ]);
});

test('compares TB, GB, MB, KB and bytes on the same numeric scale', () => {
  const downloads = [
    makeDownload('mb', '1080p', '900 MB', 'Hindi'),
    makeDownload('tb', '1080p', '1 TB', 'Hindi'),
    makeDownload('bytes', '1080p', '900 B', 'Hindi'),
    makeDownload('gb', '1080p', '1.5 GB', 'Hindi'),
    makeDownload('kb', '1080p', '900 KB', 'Hindi'),
    makeDownload('unknown', '1080p', '', 'Hindi'),
  ];

  const { hrefs } = getRenderedLinks(downloads);
  assert.deepEqual(hrefs, [
    'https://example.test/tb',
    'https://example.test/gb',
    'https://example.test/mb',
    'https://example.test/kb',
    'https://example.test/bytes',
    'https://example.test/unknown',
  ]);
});

test('keeps quality filter pills and their existing resolution order', () => {
  const { html, hrefs } = getRenderedLinks([
    makeDownload('720-small', '720p', '700 MB', 'Hindi'),
    makeDownload('1080-small', '1080p', '1 GB', 'Hindi'),
    makeDownload('720-large', '720p', '2 GB', 'Telugu'),
    makeDownload('480', '480p', '3 GB', 'Hindi'),
  ]);

  assert.deepEqual(hrefs, [
    'https://example.test/1080-small',
    'https://example.test/720-large',
    'https://example.test/720-small',
    'https://example.test/480',
  ]);
  assert.match(html, /data-filter="all"/);
  assert.match(html, /data-filter="1080p"/);
  assert.match(html, /data-filter="720p"/);
  assert.match(html, /data-filter="480p"/);
});

test('preserves season and episode ordering before comparing file sizes', () => {
  const { hrefs } = getRenderedLinks([
    makeDownload('s01e02', '1080p', '8 GB', 'Hindi', 'HubCloud', { season: 1, episode: 2 }),
    makeDownload('s01e01-small', '1080p', '2 GB', 'Hindi', 'HubCloud', { season: 1, episode: 1 }),
    makeDownload('s01e01-large', '1080p', '6 GB', 'Hindi', 'GDFlix', { season: 1, episode: 1 }),
  ]);

  assert.deepEqual(hrefs, [
    'https://example.test/s01e01-large',
    'https://example.test/s01e01-small',
    'https://example.test/s01e02',
  ]);
});
