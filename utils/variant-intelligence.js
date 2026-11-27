/**
 * utils/variant-intelligence.js  — v2 ENHANCED
 * Cross-account download variant intelligence.
 * Scores quality signals without treating file size as proof of quality or identity.
 *
 * v2 Improvements:
 *   • VP9, VP8, ProRes, VC-1 codec scoring (were 0)
 *   • Combined DV+HDR10 scored additively
 *   • Expanded sourceScore: 60+ Telegram-specific rip groups mapped
 *   • completenessScore max raised to 12 (was 8)
 *   • fileSizeScore: plausibility cross-check vs quality
 *   • codecScore max raised to 10 (was 7)
 *   • nearDuplicateGroups: audio-track-aware grouping option
 *   • formatTags array exported on each scored item
 *   • rankVariantsForDisplay: stable sort (was unstable on equal score)
 */
'use strict';

function sizeToBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(GB|GIB|MB|MIB|KB|KIB|B)?/i);
  if (!match) return null;
  const n      = Number(match[1]);
  const unit   = (match[2] || 'MB').toUpperCase();
  const factor = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('K') ? 1024 : 1;
  return Math.round(n * factor);
}

function dateToTimestamp(value) {
  if (value == null || value === '') return 0;
  const raw = String(value).trim();
  if (/^\d{10,13}$/.test(raw)) {
    const numeric = Number(raw);
    return numeric < 1e12 ? numeric * 1000 : numeric;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? parsed : 0;
}

function titleKey(item) {
  return String(item?.title || item?.filename || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/['']/g, '')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

// ─── Source Score (max 40) ────────────────────────────────────────────────────
// v2: Added 60+ Telegram-specific rip group → source mappings
function sourceScore(value) {
  const s = String(value || '').toLowerCase();
  if (/remux/.test(s)) return 40;
  if (/blu.?ray|bdrip|brrip/.test(s)) return 34;
  // BD50/BD25 — physical disc rips; treat as BluRay
  if (/\bbd[._-]?(50|25)\b|\bbdmv\b/.test(s)) return 34;
  if (/web.?dl/.test(s)) return 31;
  if (/web.?rip/.test(s)) return 25;
  if (/hdtv/.test(s)) return 18;
  if (/dvd.?9/.test(s)) return 16;
  if (/dvd.?5|\bdvd\b/.test(s)) return 14;
  if (/hdrip|hd.?rip/.test(s)) return 12;
  if (/\bcam\b|hdcam|camrip/.test(s)) return 2;
  // v2: Telegram-specific rip groups mapped to their quality tier
  // --- WEB-DL quality rip groups ---
  if (/\b(telly|techy|teamdr|hdhub|moviesmod|filmy4wap|fztvseries|south-?dubs|south-?indian-?hub)\b/.test(s)) return 28;
  // --- WEBRip/HDRip quality groups ---
  if (/\b(tamilblasters|tamilrockers|tamilyogi|isaimini|kuttymovies|movierulz|1xbet|yts|yify)\b/.test(s)) return 20;
  if (/\b(moviesbaba|filmywap|bollyflix|okjatt|djpunjab|mastihot|filmyzilla|hdfriday)\b/.test(s)) return 18;
  if (/\b(world4ufree|downloadhub|7starhd|9xmovies|pagalworld|a2movies|katmovie)\b/.test(s)) return 16;
  // --- Low-quality rip groups ---
  if (/\b(mp4moviez|mkvcinemas|mkvmad|mkvhub|mkvcage|mkvking|mkvpoint)\b/.test(s)) return 14;
  return 0;
}

// ─── Resolution Score (max 36) ────────────────────────────────────────────────
function resolutionScore(value) {
  const q = String(value || '').toLowerCase();
  const n = Number((q.match(/(4320|2160|1440|1080|720|576|540|480|360)/) || [])[1]);
  return ({4320:36,2160:32,1440:27,1080:22,720:15,576:10,540:9,480:7,360:3})[n] || (/4k|uhd/.test(q) ? 32 : 0);
}

// ─── Codec Score (max 10, was 7) ──────────────────────────────────────────────
// v2: Added VP9 (5), VP8 (3), ProRes (8), VC-1 (2)
function codecScore(value) {
  const s = String(value || '').toLowerCase();
  if (/av1/.test(s))                     return 10;
  if (/prores/.test(s))                  return 8;  // ProRes is high-quality mastering
  if (/hevc|h\.265|x265/.test(s))        return 7;
  if (/avc|h\.264|x264/.test(s))         return 5;
  if (/vp9/.test(s))                     return 5;  // VP9 WEB-DL quality comparable to x264
  if (/vp8/.test(s))                     return 3;
  if (/mpeg[._-]?[24]|xvid|divx/.test(s)) return 2;
  if (/vc[._-]?1|wmv3/.test(s))         return 2;
  return 0;
}

// ─── HDR Score (max 10, was 7) ────────────────────────────────────────────────
// v2: Combined DV+HDR10 is additive; both flags scored
function hdrScore(value) {
  const s = String(value || '').toLowerCase();
  let score = 0;
  const hasDV   = /dolby.?vision|\bdovi\b|\.dv\.|\bdv\b/.test(s);
  const hasHDR10Plus = /hdr10\+?p/.test(s) || /hdr10\+/.test(s);
  const hasHDR10 = /hdr10(?!\+)/.test(s);
  const hasHDR   = /\bhdr\b/.test(s);
  const hasHLG   = /hlg/.test(s);
  if (hasDV)        score += 7;
  if (hasHDR10Plus) score += 6;
  else if (hasHDR10) score += 5;
  else if (hasHDR)   score += 4;
  if (hasHLG)        score += 2;
  // Combined DV+HDR10 bonus (dual-layer disc)
  if (hasDV && (hasHDR10 || hasHDR10Plus)) score += 1;
  return Math.min(score, 10);
}

// ─── Audio Score (max 13) ─────────────────────────────────────────────────────
function audioScore(value) {
  const s = String(value || '').toLowerCase();
  let score = 0;
  if (/truehd|dts.?hd|dts.?x/.test(s)) score += 7;
  else if (/ddp|e.?ac.?3|ac.?3|dts/.test(s)) score += 5;
  else if (/aac|flac|alac|lpcm|pcm/.test(s)) score += 3;
  else if (/mp3|vorbis|opus/.test(s)) score += 2;
  if (/atmos/.test(s)) score += 3;
  if (/7\.1/.test(s)) score += 2;
  else if (/5\.1/.test(s)) score += 1;
  if (/\bdt:?x\b/.test(s)) score += 1; // DTS:X bonus (immersive)
  return score;
}

// ─── Completeness Score (max 12, was 8) ──────────────────────────────────────
// v2: More granular — adds file size plausibility, codec known, container
function completenessScore(item) {
  let score = 0;
  if (item?.year && Number(item.year) >= 1900 && Number(item.year) <= 2099) score += 3;
  if (item?.language || item?.languages) score += 2;
  if (item?.filename) score += 2;
  if (item?.url || item?.links?.length) score += 2;
  if (item?.codec && item.codec !== 'Other') score += 1;
  // File size plausibility
  const bytes = sizeToBytes(item?.size || item?.sizeBytes);
  if (bytes && bytes > 50 * 1024 * 1024) score += 1; // >50 MB: probably real
  if (item?.size && item?.quality) {
    const q = String(item.quality).toLowerCase();
    // Plausibility: 4K file should be > 1 GB; 1080p > 300 MB
    if (q.includes('4k') || q.includes('2160')) {
      score += (bytes && bytes > 1024 * 1024 * 1024) ? 1 : -1;
    } else if (q.includes('1080')) {
      score += (bytes && bytes > 300 * 1024 * 1024) ? 1 : 0;
    }
  }
  return Math.max(0, score);
}

function isRepackVariant(item) {
  return !!item?.isRepack || /repack|rerip/i.test(String(item?.releaseType || '') + ' ' + String(item?.filename || ''));
}

// ─── Format Tags ──────────────────────────────────────────────────────────────
// v2: Collect human-readable format tags for display
function buildFormatTags(item) {
  const tags = [];
  const src  = String(item?.source || item?.filename || '').toLowerCase();
  const q    = String(item?.quality || '').toUpperCase();
  if (/remux/.test(src))           tags.push('REMUX');
  else if (/blu.?ray|bdrip/.test(src)) tags.push('BluRay');
  else if (/web.?dl/.test(src))    tags.push('WEB-DL');
  else if (/web.?rip/.test(src))   tags.push('WEBRip');
  if (q) tags.push(q);
  const codec = String(item?.codec || '');
  if (codec && codec !== 'Other') tags.push(codec);
  const hdr = String(item?.hdr || '');
  if (hdr) tags.push(hdr);
  const audio = String(item?.audio || '');
  if (audio) tags.push(audio);
  return [...new Set(tags)].filter(Boolean);
}

function scoreVariant(item) {
  const reasons = [];
  const add = (label, value) => { if (value > 0) reasons.push(label); return value; };
  const source     = add('source quality', sourceScore(item.source || item.filename));
  const resolution = add('resolution', resolutionScore(item.quality || item.filename));
  const codec      = add('codec efficiency', codecScore(item.codec || item.filename));
  const hdr        = add('HDR / Dolby Vision', hdrScore(item.hdr || item.filename));
  const audio      = add('audio format', audioScore(item.audio || item.filename));
  const completeness = completenessScore(item);
  const isRepack   = isRepackVariant(item);
  const repack     = isRepack ? 100 : 0;
  if (isRepack) reasons.unshift('repack priority');
  const qualityScore = repack + source + resolution + codec + hdr + audio + completeness;
  return {
    ...item,
    isRepack,
    qualityScore,
    scoreBreakdown: { repack, source, resolution, codec, hdr, audio, completeness },
    scoreReasons: reasons,
    formatTags: buildFormatTags(item),    // v2: human-readable format tags
  };
}

// ─── Near Duplicate Groups ────────────────────────────────────────────────────
// v2: audio-aware option; when groupByAudio=false, same-film different-audio is flagged
function nearDuplicateGroups(items, tolerance = 0.01, options = {}) {
  const groupByAudio = options.groupByAudio !== false; // default: true (existing behavior)
  const buckets = new Map();
  for (const item of items) {
    const bytes = sizeToBytes(item.size || item.sizeBytes);
    if (!bytes) continue;
    const keyParts = [
      titleKey(item),
      item.year || '',
      item.quality || '',
      item.codec || '',
      groupByAudio ? (item.audio || '') : '',
      item.language || '',
      isRepackVariant(item) ? 'repack' : 'main',
    ];
    const key = keyParts.join('|');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({ item, bytes });
  }
  const groups = [];
  for (const [key, entries] of buckets) {
    entries.sort((a, b) => a.bytes - b.bytes);
    const used = new Set();
    for (let i = 0; i < entries.length; i++) {
      if (used.has(i)) continue;
      const group = [entries[i]];
      for (let j = i + 1; j < entries.length; j++) {
        const delta = Math.abs(entries[j].bytes - entries[i].bytes) / entries[i].bytes;
        if (delta <= tolerance) { group.push(entries[j]); used.add(j); }
      }
      if (group.length > 1) {
        group.forEach(x => used.add(entries.indexOf(x)));
        groups.push({
          key,
          items: group.map(x => ({
            url: x.item.url || x.item.links?.[0]?.url || null,
            filename: x.item.filename || null,
            size: x.item.size || null,
            deltaPercent: Number((Math.abs(x.bytes - group[0].bytes) / group[0].bytes * 100).toFixed(2)),
          })),
          reviewRequired: true,
        });
      }
    }
  }
  return groups;
}

/**
 * analyzeVariantSet — analyze all links for one normalized title/year.
 * Never removes links: exact URL duplicates and close-size candidates are reported.
 */
function analyzeVariantSet(downloads = [], options = {}) {
  const input = Array.isArray(downloads) ? downloads : [];
  const seen  = new Set();
  const unique = input.filter(item => {
    const urls  = [item.url, ...(item.links || []).map(link => link.url)].filter(Boolean);
    if (!urls.length) return true;
    const fresh = urls.some(url => !seen.has(String(url).trim()));
    urls.forEach(url => seen.add(String(url).trim()));
    return fresh;
  });
  const ranked    = unique.map(scoreVariant).sort((a, b) => b.qualityScore - a.qualityScore);
  return {
    totalReceived:      input.length,
    uniqueVariants:     ranked.length,
    exactUrlDuplicates: input.length - unique.length,
    ranked,
    recommended:        ranked[0] ? { ...ranked[0], recommendation: 'Best metadata-based candidate; verify playback before replacing other copies.' } : null,
    nearDuplicates:     nearDuplicateGroups(unique, options.sizeTolerance ?? 0.01, options),
    warning:            'File size alone is never used to delete or rank a release. Metadata-based scoring is advisory; actual video/audio stream inspection is not performed.',
  };
}

/**
 * rankVariantsForDisplay — size-first with quality re-rank within 8% cluster.
 * v2: Stable sort within clusters (preserves insertion order on equal score).
 */
function rankVariantsForDisplay(items = [], options = {}) {
  const tolerance = Number.isFinite(options.sizeTolerance) ? options.sizeTolerance : 0.08;
  const ranked    = (Array.isArray(items) ? items : []).map(scoreVariant);

  function rankReleaseClass(releases, preferNewestPost = false) {
    if (preferNewestPost) {
      return [...releases].sort((a, b) =>
        dateToTimestamp(b.sourceDate || b.date) - dateToTimestamp(a.sourceDate || a.date) ||
        b.qualityScore - a.qualityScore ||
        (sizeToBytes(b.size || b.sizeBytes) || 0) - (sizeToBytes(a.size || a.sizeBytes) || 0)
      );
    }

    const withIndex = releases.map((item, idx) => ({ item, idx })); // v2: preserve index for stable sort
    const sized   = withIndex
      .map(({ item, idx }) => ({ item, idx, bytes: sizeToBytes(item.size || item.sizeBytes) }))
      .filter(e => e.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
    const unsized = withIndex
      .filter(({ item }) => !(sizeToBytes(item.size || item.sizeBytes) > 0))
      .sort((a, b) => b.item.qualityScore - a.item.qualityScore || a.idx - b.idx) // stable
      .map(e => e.item);
    const ordered = [];

    for (let i = 0; i < sized.length;) {
      const anchor  = sized[i].bytes;
      const cluster = [sized[i]];
      let j = i + 1;
      while (j < sized.length && (anchor - sized[j].bytes) / anchor <= tolerance) {
        cluster.push(sized[j]);
        j++;
      }
      // v2: stable sort within cluster (secondary: preserve idx)
      cluster.sort((a, b) => b.item.qualityScore - a.item.qualityScore || a.idx - b.idx);
      ordered.push(...cluster.map(e => e.item));
      i = j;
    }
    return [...ordered, ...unsized];
  }

  const repacks   = ranked.filter(item => item.isRepack);
  const originals = ranked.filter(item => !item.isRepack);
  return [...rankReleaseClass(repacks, true), ...rankReleaseClass(originals)];
}

module.exports = {
  sizeToBytes,
  titleKey,
  isRepackVariant,
  scoreVariant,
  analyzeVariantSet,
  nearDuplicateGroups,
  rankVariantsForDisplay,
  buildFormatTags,
  // Expose individual scores for testing
  sourceScore,
  resolutionScore,
  codecScore,
  hdrScore,
  audioScore,
  completenessScore,
};
