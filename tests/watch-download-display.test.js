'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const watchSource = fs.readFileSync(path.join(root, 'public/js/watch.js'), 'utf8');
const helperStart = watchSource.indexOf('function normalizeAudioDisplayLabel(');
const helperEnd = watchSource.indexOf('// ── Flat-list download section', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'download metadata helpers should exist');

const helpers = vm.runInNewContext(
  watchSource.slice(helperStart, helperEnd) +
  '\n({ normalizeAudioDisplayLabel, detectAudioChannelsForDisplay, buildAudioDisplayTag, buildTechnicalMetadataTags });'
);

test('EAC3 and Dolby Digital Plus display as DDP; AC3 and Dolby Digital display as DD', () => {
  assert.equal(helpers.normalizeAudioDisplayLabel('EAC3'), 'DDP');
  assert.equal(helpers.normalizeAudioDisplayLabel('EAC3 Atmos'), 'DDP Atmos');
  assert.equal(helpers.normalizeAudioDisplayLabel('DDP+'), 'DDP');
  assert.equal(helpers.normalizeAudioDisplayLabel('DD+'), 'DDP');
  assert.equal(helpers.normalizeAudioDisplayLabel('Dolby Digital Plus Atmos'), 'DDP Atmos');
  assert.equal(helpers.normalizeAudioDisplayLabel('AC-3'), 'DD');
  assert.equal(helpers.normalizeAudioDisplayLabel('Dolby Digital'), 'DD');
  assert.equal(helpers.normalizeAudioDisplayLabel('DTS-HD MA'), 'DTS-HD MA');
  assert.equal(helpers.normalizeAudioDisplayLabel('AAC'), 'AAC');
});

test('audio channel layout is joined to its codec instead of shown as a standalone tag', () => {
  assert.equal(helpers.buildAudioDisplayTag({ audioChannels: '5.1' }, 'DDP'), 'DDP + 5.1');
  assert.equal(helpers.buildAudioDisplayTag({ audioChannels: '2.0' }, 'DD'), 'DD + 2.0');
  assert.equal(helpers.buildAudioDisplayTag({ filename: 'Movie.DDP7.1.mkv' }, 'DDP'), 'DDP + 7.1');
  assert.equal(helpers.buildAudioDisplayTag({ filename: 'Movie.AAC.Stereo.mkv' }, 'AAC'), 'AAC + 2.0');
  assert.equal(helpers.buildAudioDisplayTag({ audioChannels: '5.1' }, ''), '');
});

test('two or more explicit audio tracks display their codec, channel layout and language', () => {
  assert.equal(
    helpers.buildAudioDisplayTag({
      audioTracks: [
        { codec: 'EAC3', channels: '5.1', language: 'Telugu' },
        { codec: 'AAC', channels: '2.0', language: 'Hindi' },
      ],
      audio: 'EAC3',
      audioChannels: '5.1',
    }, 'EAC3'),
    'DDP + 5.1 (Telugu) / AAC + 2.0 (Hindi)'
  );
});

test('one stored track does not imply multi-audio; the normal single audio label remains', () => {
  assert.equal(
    helpers.buildAudioDisplayTag({
      audioTracks: [{ codec: 'EAC3', channels: '5.1', language: 'Telugu' }],
      audio: 'EAC3',
      audioChannels: '5.1',
    }, 'EAC3'),
    'DDP + 5.1'
  );
});

test('video metadata remains visible without audio metadata', () => {
  assert.equal(
    helpers.buildTechnicalMetadataTags(
      { hdr: 'SDR', source: 'WEB-DL', codec: 'HEVC', platform: 'AHA' },
      {}
    ),
    'SDR · WEB-DL · HEVC · AHA'
  );
});

test('empty technical metadata hides the metadata row instead of showing empty audio or platform tags', () => {
  assert.equal(
    helpers.buildTechnicalMetadataTags({ platform: 'AHA' }, { audioChannels: '5.1' }),
    ''
  );
  assert.equal(
    helpers.buildTechnicalMetadataTags({}, {}),
    ''
  );
});

test('audio metadata is shown with channel count and video metadata when both exist', () => {
  assert.equal(
    helpers.buildTechnicalMetadataTags(
      { hdr: 'SDR', source: 'WEB-DL', codec: 'HEVC', audio: 'EAC3', platform: 'AHA' },
      { audioChannels: '5.1' }
    ),
    'SDR · WEB-DL · HEVC · DDP + 5.1 · AHA'
  );
});

test('Telegram posted date is not rendered as a download badge; source date remains available for sorting', () => {
  assert.equal(watchSource.includes('postedBadge'), false);
  assert.equal(watchSource.includes('postedDate'), false);
  assert.equal(watchSource.includes('Posted '), false);
  assert.ok(watchSource.includes('sourceDate:  dl.sourceDate || dl.date || \'\''), 'source date should remain for repack sorting');
  assert.ok(watchSource.includes('telegramDateToMs(b.sourceDate) - telegramDateToMs(a.sourceDate)'), 'newer repacks should continue to sort first');
});

test('language and file size remain part of the common download headline', () => {
  assert.ok(watchSource.includes('langBadge'));
  assert.ok(watchSource.includes('row.size ?'));
});
