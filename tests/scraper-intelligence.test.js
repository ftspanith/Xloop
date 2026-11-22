const assert = require('node:assert/strict');
const { detectBitDepth, detectAudioChannels, parseMessageBlock } = require('../utils/parser');

assert.equal(detectBitDepth('Movie.1080p.10bit.HEVC.mkv'), '10-bit');
assert.equal(detectBitDepth('Movie.1080p.8-bit.x264.mkv'), '8-bit');
assert.equal(detectBitDepth('Movie.1080p.HEVC.mkv'), null);
assert.equal(detectAudioChannels('Movie.DDP.5.1.mkv'), '5.1');
assert.equal(detectAudioChannels('Movie.AAC.2.0.mkv'), '2.0');

const message = [
  'Example Film (2021)',
  '1080p WEB-DL HEVC 10bit Telugu DDP 5.1 2.19 GB',
  'https://gdflix.dev/file/abc123'
].join('\n');
const parsed = parseMessageBlock(message, 1);
assert.ok(parsed, 'message should parse');
assert.equal(parsed.year, 2021);
assert.equal(parsed.downloads[0].quality, '1080p');
assert.equal(parsed.downloads[0].bitDepth, '10-bit');
assert.equal(parsed.downloads[0].audioChannels, '5.1');
console.log('Scraper metadata intelligence tests passed.');
