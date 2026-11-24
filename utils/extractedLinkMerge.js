'use strict';

function isBlank(value) {
  return value == null ||
    (typeof value === 'string' && value.trim() === '') ||
    (Array.isArray(value) && value.length === 0);
}

function buildMissingMetadataUpdate(existing = {}, incoming = {}) {
  const set = {};
  const fillOnlyWhenBlank = [
    'title', 'rawTitle', 'messageId', 'messageYear', 'fileYear', 'year',
    'size', 'language', 'season', 'episode', 'filename', 'codec', 'hdr',
    'audio', 'source', 'container', 'bitDepth', 'audioChannels',
    'runtimeMinutes', 'duration', 'certification', 'aspectRatio',
    'bypassedUrl', 'contentType', 'imdbId', 'tmdbIdHint', 'date',
  ];

  for (const field of fillOnlyWhenBlank) {
    if (isBlank(existing[field]) && !isBlank(incoming[field])) {
      set[field] = incoming[field];
    }
  }

  // A generic HD value is a parser fallback; a concrete resolution is richer.
  if ((!existing.quality || existing.quality === 'HD') &&
      incoming.quality && incoming.quality !== 'HD') {
    set.quality = incoming.quality;
  }

  // Positive, explicit flags can enrich an earlier parse that lacked the marker.
  if (incoming.isRepack === true && existing.isRepack !== true) set.isRepack = true;
  if (incoming.isIMAX === true && existing.isIMAX !== true) set.isIMAX = true;
  if (incoming.isSeries === true && existing.isSeries !== true) set.isSeries = true;

  if (incoming.releaseType === 'Repack' && existing.releaseType !== 'Repack') {
    set.releaseType = 'Repack';
  } else if (isBlank(existing.releaseType) && !isBlank(incoming.releaseType)) {
    set.releaseType = incoming.releaseType;
  }

  const oldLanguageType = String(existing.languageType || '').toLowerCase();
  const newLanguageType = String(incoming.languageType || '').toLowerCase();
  if (!newLanguageType || oldLanguageType === newLanguageType) {
    // No change.
  } else if (!oldLanguageType || (oldLanguageType === 'single' && ['dual', 'multi'].includes(newLanguageType))) {
    set.languageType = incoming.languageType;
  }

  if (Number(incoming.languageCount) > Number(existing.languageCount || 0)) {
    set.languageCount = Number(incoming.languageCount);
  }

  if ((!Array.isArray(existing.audioTracks) || existing.audioTracks.length < 2) &&
      Array.isArray(incoming.audioTracks) && incoming.audioTracks.length >= 2) {
    set.audioTracks = incoming.audioTracks.slice(0, 8);
  }

  if ((!Array.isArray(existing.yearCandidates) || existing.yearCandidates.length === 0) &&
      Array.isArray(incoming.yearCandidates) && incoming.yearCandidates.length) {
    set.yearCandidates = incoming.yearCandidates;
  }

  return set;
}

module.exports = { isBlank, buildMissingMetadataUpdate };
