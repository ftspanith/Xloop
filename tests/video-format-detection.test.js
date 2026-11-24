'use strict';

const assert = require('node:assert/strict');
const {
  detectCodec,
  detectContainer,
  normalizeQuality,
  detectSource,
  extractAudio,
  detectAudioChannels,
  normalizeGdflixUrl,
  parseMessageBlock,
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


const sourceCases = [
  ['Film.1080p.Blu-Ray.mkv', 'BluRay'],
  ['Film.1080p.BDRip.mkv', 'BluRay'],
  ['Film.2160p.BluRay.REMUX.mkv', 'REMUX'],
  ['Film.DVD9.mkv', 'DVD9'],
  ['Film.DVD.9.mkv', 'DVD9'],
  ['Film.DVD5.mkv', 'DVD5'],
  ['Film.WEB.DL.mkv', 'WEB-DL'],
];
for (const [filename, expected] of sourceCases) {
  assert.equal(detectSource(filename), expected, filename);
}

const audioCases = [
  ['Film.DDP5.1.1080p.mkv', 'EAC3'],
  ['Film.Dolby.Digital.Plus.Atmos.5.1.mkv', 'EAC3 Atmos'],
  ['Film.TrueHD.Atmos.7.1.4.mkv', 'TrueHD Atmos'],
  ['Film.DTS-HD.MA.7.1.mkv', 'DTS-HD MA'],
  ['Film.AC3.5.1.mkv', 'DD'],
  ['Film.Opus.2.0.mkv', 'Opus'],
  ['Film.AAC.2.0.mkv', 'AAC'],
];
for (const [filename, expected] of audioCases) {
  assert.equal(extractAudio(filename), expected, filename);
}
assert.equal(detectAudioChannels('Film.TrueHD.Atmos.7.1.4.mkv'), '7.1.4');
assert.equal(detectAudioChannels('Film.EAC3.5.1.2.mkv'), '5.1.2');
assert.equal(extractAudio('Film.E-AC-3.5.1.mkv'), 'EAC3');
assert.equal(detectAudioChannels('Film.Stereo.AAC.mkv'), '2.0');

assert.equal(normalizeGdflixUrl('https://new5.gdflix.io/file/abc'), 'https://gdflix.io/file/abc');
assert.equal(normalizeGdflixUrl('https://www.hubcloud.foo/file/abc'), 'https://hubcloud.foo/file/abc');
assert.equal(normalizeGdflixUrl('https://www.tmbcloud.dev/file/abc'), 'https://tmbcloud.dev/file/abc');
