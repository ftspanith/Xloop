'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildMissingMetadataUpdate } = require('../utils/extractedLinkMerge');

test('fills missing extraction metadata without replacing complete values', () => {
  const existing = {
    title: 'Robo',
    year: 2010,
    size: '',
    quality: 'HD',
    codec: '',
    language: 'Telugu',
    releaseType: 'Original',
    isRepack: false,
    audioTracks: [],
  };
  const incoming = {
    title: 'Robot (2019)',
    year: 2019,
    size: '2.4GB',
    quality: '1080p',
    codec: 'HEVC',
    language: 'Hindi',
    releaseType: 'Repack',
    isRepack: true,
    audioTracks: [{ codec: 'AAC', channels: '2.0', language: 'Hindi' }, { codec: 'DDP', channels: '5.1', language: 'English' }],
  };
  const update = buildMissingMetadataUpdate(existing, incoming);
  assert.deepEqual(update, {
    size: '2.4GB',
    quality: '1080p',
    codec: 'HEVC',
    isRepack: true,
    releaseType: 'Repack',
    audioTracks: incoming.audioTracks,
  });
});

test('does not downgrade multi-audio, quality, language, or populated media fields', () => {
  const existing = {
    title: 'Example',
    rawTitle: 'Example 2022',
    year: 2022,
    size: '4.8GB',
    quality: '1080p',
    codec: 'HEVC',
    language: 'Telugu, English',
    languageType: 'Dual',
    languageCount: 2,
    isRepack: true,
    isIMAX: true,
    releaseType: 'Repack',
    audioTracks: [{ codec: 'AAC', channels: '2.0', language: 'Telugu' }, { codec: 'DDP', channels: '5.1', language: 'English' }],
  };
  const incoming = {
    title: 'Example',
    rawTitle: 'Example 2022',
    year: 2021,
    size: '3GB',
    quality: '720p',
    codec: 'H.264',
    language: 'Hindi',
    languageType: 'Single',
    languageCount: 1,
    isRepack: false,
    isIMAX: false,
    releaseType: 'Original',
    audioTracks: [{ codec: 'AAC', channels: '2.0', language: 'Hindi' }],
  };
  assert.deepEqual(buildMissingMetadataUpdate(existing, incoming), {});
});

test('promotes Single to Dual/Multi and fills the original date only when it is missing', () => {
  const update = buildMissingMetadataUpdate(
    { languageType: 'Single', languageCount: 1, date: '', isSeries: false },
    { languageType: 'Dual', languageCount: 2, date: '2026-11-24T08:00:00Z', isSeries: true }
  );
  assert.deepEqual(update, {
    date: '2026-11-24T08:00:00Z',
    isSeries: true,
    languageType: 'Dual',
    languageCount: 2,
  });
});
