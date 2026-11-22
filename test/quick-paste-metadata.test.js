const test = require('node:test');
const assert = require('node:assert/strict');
const { parseMessageBlock, extractSize, parseManualInput } = require('../utils/parser');

const paste = `The Demon Hunter (2025)
The Demon Hunter (2025) 1080p JIOHS WEB-DL 8bit x264 [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [2.31 GB]
https://gdflix.dev/file/N7ty2aFXhlae2hJ
The Demon Hunter (2025) 1080p JIOHS WEB-DL HEVC [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [1.77 GB]
https://gdflix.dev/file/VNOtWIAGYQDC4jV
The Demon Hunter (2025) 720p JIOHS WEB-DL 8bit x264 [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [1.07 GB]
https://gdflix.dev/file/Fx3vP2ZROtt66JN
The Demon Hunter (2025) 720p JIOHS WEB-DL HEVC [Telugu + Tamil + Hindi (AAC 2.0)] ESub.mkv - [717 MB]
https://gdflix.dev/file/WQ3XVdPqgn7KFcX`;

test('size extractor handles decimals, commas, brackets and whitespace', () => {
  assert.equal(extractSize('[2.31 GB]'), '2.31GB');
  assert.equal(extractSize('— [717 MB]'), '717MB');
  assert.equal(extractSize('Size: 1,200 MB'), '1200MB');
  assert.equal(extractSize('(0.7 GB)'), '0.7GB');
});

test('manual and quick-paste paths use the same size parser', () => {
  assert.equal(parseManualInput('Movie 2025 1080p [1,200 MB] x265.mkv').size, '1200MB');
});

test('four encodes retain their own size and codec metadata', () => {
  const parsed = parseMessageBlock(paste);
  assert.ok(parsed, 'paste should parse');
  assert.equal(parsed.downloads.length, 4);
  const byUrl = new Map(parsed.downloads.flatMap(d => d.links.map(l => [l.url, d])));
  const expected = [
    ['https://gdflix.dev/file/N7ty2aFXhlae2hJ', '2.31GB', 'H.264', '1080p'],
    ['https://gdflix.dev/file/VNOtWIAGYQDC4jV', '1.77GB', 'HEVC', '1080p'],
    ['https://gdflix.dev/file/Fx3vP2ZROtt66JN', '1.07GB', 'H.264', '720p'],
    ['https://gdflix.dev/file/WQ3XVdPqgn7KFcX', '717MB', 'HEVC', '720p']
  ];
  for (const [url, size, codec, quality] of expected) {
    const file = byUrl.get(url);
    assert.ok(file, `missing parsed URL: ${url}`);
    assert.equal(file.size, size, `wrong size for ${url}`);
    assert.equal(file.codec, codec, `wrong codec for ${url}`);
    assert.equal(file.quality, quality, `wrong quality for ${url}`);
  }
});
