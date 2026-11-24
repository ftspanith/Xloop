'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { extractAudio, detectAudioChannels } = require('../utils/parser');

const codecCases = [
  ['Film.TrueHD.Atmos.mkv', 'TrueHD Atmos'],
  ['Film.DTS-X.mkv', 'DTS:X'],
  ['Film.DTS-HD.Master.Audio.7.1.mkv', 'DTS-HD MA'],
  ['Film.DTS-HD.High.Resolution.Audio.mkv', 'DTS-HD HRA'],
  ['Film.DTS-ES.Discrete.6.1.mkv', 'DTS-ES'],
  ['Film.DTS.96-24.mkv', 'DTS 96/24'],
  ['Film.DTS.Express.mkv', 'DTS Express'],
  ['Film.Dolby.Digital.EX.mkv', 'DD-EX'],
  ['Film.E-AC3.JOC.mkv', 'EAC3 JOC'],
  ['Film.DDP5.1.Atmos.mkv', 'EAC3 Atmos'],
  ['Film.AC-4.mkv', 'AC4'],
  ['Film.HE-AAC.v2.mkv', 'HE-AAC v2'],
  ['Film.HE-AAC.mkv', 'HE-AAC'],
  ['Film.AAC-LC.mkv', 'AAC-LC'],
  ['Film.MPEG-H.3D.Audio.mkv', 'MPEG-H'],
  ['Film.Auro-3D.mkv', 'Auro-3D'],
  ['Film.LPCM.mkv', 'LPCM'],
  ['Film.MLP.mkv', 'MLP'],
  ['Film.WMA.Pro.mkv', 'WMA Pro'],
  ['Film.WMA.Lossless.mkv', 'WMA Lossless'],
  ['Film.ATRAC3.mkv', 'ATRAC'],
  ['Film.DRA.mkv', 'DRA'],
  ['Film.RealAudio.mkv', 'RealAudio'],
  ['Film.Speex.mkv', 'Speex'],
  ['Film.AMR-WB.mkv', 'AMR-WB'],
];

test('detects common, surround, lossless, broadcast and legacy audio codec variants', () => {
  for (const [filename, expected] of codecCases) {
    assert.equal(extractAudio(filename), expected, filename);
  }
});

test('detects immersive and conventional audio channel layouts without truncating them', () => {
  const cases = [
    ['Film.DDP.11.1.8.mkv', '11.1.8'],
    ['Film.TrueHD.9.1.8.mkv', '9.1.8'],
    ['Film.Atmos.9.1.6.mkv', '9.1.6'],
    ['Film.Atmos.7.2.4.mkv', '7.2.4'],
    ['Film.Atmos.7.1.8.mkv', '7.1.8'],
    ['Film.Atmos.5.1.6.mkv', '5.1.6'],
    ['Film.Atmos.5.1.2.mkv', '5.1.2'],
    ['Film.DTS.7.1.mkv', '7.1'],
    ['Film.AAC.Stereo.mkv', '2.0'],
  ];
  for (const [filename, expected] of cases) {
    assert.equal(detectAudioChannels(filename), expected, filename);
  }
});

test('does not invent audio codecs or channel layouts when no explicit metadata exists', () => {
  assert.equal(extractAudio('Film.1080p.HEVC.WEB-DL.mkv'), null);
  assert.equal(extractAudio('Film.1080p.mkv'), null);
  assert.equal(detectAudioChannels('Film.1080p.HEVC.mkv'), null);
});
