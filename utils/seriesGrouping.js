'use strict';

const SERIES_TYPES = ['series', 'anime'];

function seriesTypeFamily(value) {
  return ['series', 'anime'].includes(String(value || '').toLowerCase()) ? 'tv' : String(value || '').toLowerCase();
}

function normalizeSeriesTitle(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function seriesGroupKey(doc) {
  const family = seriesTypeFamily(doc?.type);
  const tmdbId = String(doc?.tmdbId || '').trim();
  if (tmdbId) return family + ':tmdb:' + tmdbId;
  return family + ':title:' + normalizeSeriesTitle(doc?.title);
}

function plain(value) {
  if (!value) return {};
  if (typeof value.toObject === 'function') return value.toObject();
  return value;
}

function metadataCompleteness(doc) {
  let score = 0;
  if (doc.tmdbId) score += 16;
  if (doc.releaseDate) score += 5;
  if (doc.imdbId) score += 8;
  if (doc.poster) score += 8;
  if (doc.backdrop) score += 4;
  if (doc.description) score += 3;
  if (doc.year) score += 2;
  if (doc.genre?.length) score += 2;
  if (doc.rating) score += 1;
  if (doc.totalSeasons) score += 2;
  return score;
}

function downloadGroupKey(download) {
  const dl = plain(download);
  const season = dl.season ?? '';
  const episode = dl.episode ?? '';
  const repack = dl.isRepack ? 'repack' : 'main';
  const filename = String(dl.filename || '').trim().toLowerCase();
  if (filename) return [season, episode, repack, filename].join('|');
  return [
    season, episode, repack, dl.quality || '', dl.size || '',
    dl.codec || '', dl.hdr || '', dl.audio || '', dl.language || '',
  ].join('|').toLowerCase();
}

function mergeDownloads(documents) {
  const rows = new Map();
  for (const doc of documents) {
    for (const rawDownload of doc.downloads || []) {
      const download = { ...plain(rawDownload) };
      const key = downloadGroupKey(download);
      if (!rows.has(key)) {
        download.links = [];
        rows.set(key, download);
      }
      const target = rows.get(key);
      for (const link of download.links || []) {
        const url = String(link?.url || '').trim();
        if (url && !target.links.some(existing => existing.url === url)) {
          target.links.push({ ...link });
        }
      }
      if ((!target.audioTracks || !target.audioTracks.length) && download.audioTracks?.length) {
        target.audioTracks = download.audioTracks;
      }
      if (!target.fileYear && download.fileYear) target.fileYear = download.fileYear;
      if (!target.language && download.language) target.language = download.language;
      if (!target.season && download.season != null) target.season = download.season;
      if (!target.episode && download.episode != null) target.episode = download.episode;
    }
  }
  return [...rows.values()];
}

function mergeSeriesDocuments(input) {
  const documents = (input || []).map(plain).filter(doc => doc && doc.title);
  if (!documents.length) return null;

  const sorted = [...documents].sort((a, b) =>
    metadataCompleteness(b) - metadataCompleteness(a) ||
    new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)
  );
  const primary = { ...sorted[0] };
  const fillFields = [
    'tmdbId', 'imdbId', 'description', 'poster', 'posterFallback',
    'backdrop', 'releaseDate', 'year', 'rating', 'duration', 'runtimeMinutes',
    'certification', 'totalSeasons',
  ];
  for (const doc of sorted.slice(1)) {
    for (const field of fillFields) {
      const current = primary[field];
      const missing = current == null || current === '' || current === 0;
      if (missing && doc[field] != null && doc[field] !== '') primary[field] = doc[field];
    }
    if ((!primary.genre || !primary.genre.length) && doc.genre?.length) primary.genre = doc.genre;
    if ((!primary.languages || !primary.languages.length) && doc.languages?.length) primary.languages = doc.languages;
    if (!primary.language && doc.language) primary.language = doc.language;
    if (!primary.totalSeasons && doc.totalSeasons) primary.totalSeasons = doc.totalSeasons;
  }

  if (sorted.some(doc => doc.type === 'anime')) primary.type = 'anime';
  if (primary.releaseDate) {
    const canonicalYear = parseInt(String(primary.releaseDate).slice(0, 4), 10);
    if (canonicalYear >= 1900 && canonicalYear <= 2099) primary.year = canonicalYear;
  }
  primary.seasonPosters = Object.assign({}, ...sorted.slice().reverse().map(doc => doc.seasonPosters || {}));
  primary.seasonYears = Object.assign({}, ...sorted.slice().reverse().map(doc => doc.seasonYears || {}));
  primary.downloads = mergeDownloads(sorted);
  primary._groupedDocumentCount = documents.length;
  primary._groupedDocumentIds = documents.map(doc => String(doc._id || '')).filter(Boolean);
  return primary;
}

function dedupeSeriesDocuments(documents) {
  const groups = new Map();
  for (const raw of documents || []) {
    const doc = plain(raw);
    const key = seriesGroupKey(doc);
    if (!key.endsWith(':title:')) {
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(doc);
      continue;
    }
    // A missing title must not cause unrelated records to collapse together.
    const title = normalizeSeriesTitle(doc.title);
    const safeKey = title ? key : seriesTypeFamily(doc.type) + ':id:' + String(doc._id || groups.size);
    if (!groups.has(safeKey)) groups.set(safeKey, []);
    groups.get(safeKey).push(doc);
  }
  return [...groups.values()]
    .map(mergeSeriesDocuments)
    .filter(Boolean);
}

module.exports = {
  SERIES_TYPES,
  seriesTypeFamily,
  normalizeSeriesTitle,
  seriesGroupKey,
  mergeDownloads,
  mergeSeriesDocuments,
  dedupeSeriesDocuments,
};
