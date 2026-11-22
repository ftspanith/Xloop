'use strict';

const assert = require('node:assert/strict');
const {
  detectCodec,
  detectContainer,
  normalizeQuality,
  parseManualInput,
} = require('../utils/parser');

const codecCases = [
  ['Movie.2160p.AV1.mkv', 'AV1'],
  ['Movie.1080p.VP9.WEB-DL.mkv', 'VP9'],
  ['Movie.1080p.VP8.mkv', 'VP8'],
  ['Movie.1080p.AVC.mkv', 'H.264'],
  ['Movie.1080p.H.264.x264.mkv', 'H.264'],
  ['Movie.2160p.HEVC.x265.mkv', 'HEVC'],
  ['Movie.MPEG-2.mkv', 'MPEG-2'],
  ['Movie.MPEG4.mp4', 'MPEG-4'],
  ['Movie.XviD.avi', 'Xvid'],
  ['Movie.DivX.avi', 'DivX'],
  ['Movie.ProRes422.mov', 'ProRes'],
  ['Movie.Theora.ogv', 'Theora'],
  ['Movie.VC-1.mkv', 'VC-1'],
  ['Movie.Unknown.mkv', 'Other'],
];

for (const [filename, expected] of codecCases) {
  assert.equal(detectCodec(filename), expected, filename);
}

const containerCases = [
  ['movie.mkv', 'MKV'], ['movie.mp4', 'MP4'], ['movie.m4v', 'MP4'],
  ['movie.webm', 'WEBM'], ['movie.avi', 'AVI'], ['movie.mov', 'MOV'],
  ['movie.ts', 'TS'], ['movie.m2ts', 'M2TS'], ['movie.wmv', 'WMV'],
  ['movie.flv', 'FLV'], ['movie.ogv', 'OGV'], ['movie.unknown', null],
];
for (const [filename, expected] of containerCases) {
  assert.equal(detectContainer(filename), expected, filename);
}

const qualityCases = [
  ['Film.8K.4320p.mkv', '8K'],
  ['Film.4K.2160p.mkv', '4K'],
  ['Film.1440p.QHD.mkv', '1440p'],
  ['Film.1080p.mkv', '1080p'],
  ['Film.720p.mkv', '720p'],
  ['Film.576p.mkv', '576p'],
  ['Film.540p.mkv', '540p'],
  ['Film.480p.mkv', '480p'],
  ['Film.360p.mkv', '360p'],
  ['Film.240p.mkv', '240p'],
  ['Film.SD.mkv', 'SD'],
];

for (const [filename, expected] of qualityCases) {
  assert.equal(normalizeQuality(filename), expected, filename);
}

const manual = parseManualInput('Sample.Movie.1080p.VP9.WEB-DL.Multi.Audio.1.4GB.mkv');
assert.equal(manual.codec, 'VP9');
assert.equal(manual.container, 'MKV');
assert.equal(manual.quality, '1080p');

console.log('Video format detection tests passed.');
