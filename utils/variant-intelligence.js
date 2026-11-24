/**
 * Cross-account download variant intelligence.
 * Scores quality signals without treating file size as proof of quality or identity.
 */
'use strict';

function sizeToBytes(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const match = String(value || '').replace(/,/g, '').match(/(\d+(?:\.\d+)?)\s*(GB|GIB|MB|MIB|KB|KIB|B)?/i);
  if (!match) return null;
  const n = Number(match[1]);
  const unit = (match[2] || 'MB').toUpperCase();
  const factor = unit.startsWith('G') ? 1024 ** 3 : unit.startsWith('M') ? 1024 ** 2 : unit.startsWith('K') ? 1024 : 1;
  return Math.round(n * factor);
}

function titleKey(item) {
  return String(item?.title || item?.filename || '')
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[’']/g, '')
    .replace(/\b(19\d{2}|20\d{2})\b/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

function sourceScore(value) {
  const s = String(value || '').toLowerCase();
  if (/remux/.test(s)) return 40;
  if (/blu.?ray|bdrip/.test(s)) return 34;
  if (/web.?dl/.test(s)) return 31;
  if (/web.?rip/.test(s)) return 25;
  if (/hdtv/.test(s)) return 18;
  if (/hdrip/.test(s)) return 12;
  return 0;
}

function resolutionScore(value) {
  const q = String(value || '').toLowerCase();
  const n = Number((q.match(/(4320|2160|1440|1080|720|576|540|480|360)/) || [])[1]);
  return ({4320:36,2160:32,1440:27,1080:22,720:15,576:10,540:9,480:7,360:3})[n] || (/4k|uhd/.test(q) ? 32 : 0);
}

function codecScore(value) {
  const s = String(value || '').toLowerCase();
  if (/av1/.test(s)) return 7;
  if (/hevc|h\.265|x265/.test(s)) return 6;
  if (/avc|h\.264|x264/.test(s)) return 4;
  return 0;
}

function hdrScore(value) {
  const s = String(value || '').toLowerCase();
  if (/dolby.?vision|\bdv\b/.test(s)) return 7;
  if (/hdr10\+?/.test(s)) return 6;
  if (/\bhdr\b/.test(s)) return 5;
  if (/hlg/.test(s)) return 3;
  return 0;
}

function audioScore(value) {
  const s = String(value || '').toLowerCase();
  let score = 0;
  if (/truehd|dts.?hd|dts.?x/.test(s)) score += 7;
  else if (/ddp|e.?ac.?3|ac.?3|dts/.test(s)) score += 5;
  else if (/aac|flac/.test(s)) score += 3;
  if (/atmos/.test(s)) score += 3;
  if (/7\.1/.test(s)) score += 2;
  else if (/5\.1/.test(s)) score += 1;
  return score;
}

function completenessScore(item) {
  let score = 0;
  if (item?.year && Number(item.year) >= 1900 && Number(item.year) <= 2099) score += 3;
  if (item?.language || item?.languages) score += 2;
  if (item?.size || item?.sizeBytes) score += 1;
  if (item?.filename) score += 1;
  if (item?.url || item?.links?.length) score += 1;
  return score;
}

function scoreVariant(item) {
  const reasons = [];
  const add = (label, value) => { if (value > 0) reasons.push(label); return value; };
  const source = add('source quality', sourceScore(item.source || item.filename));
  const resolution = add('resolution', resolutionScore(item.quality || item.filename));
  const codec = add('codec efficiency', codecScore(item.codec || item.filename));
  const hdr = add('HDR / Dolby Vision', hdrScore(item.hdr || item.filename));
  const audio = add('audio format', audioScore(item.audio || item.filename));
  const completeness = completenessScore(item);
  const isRepack = !!item?.isRepack || /repack/i.test(String(item?.releaseType || ''));
  const repack = isRepack ? 100 : 0;
  if (isRepack) reasons.unshift('repack priority');
  return { ...item, isRepack, qualityScore: repack + source + resolution + codec + hdr + audio + completeness, scoreBreakdown: {repack,source,resolution,codec,hdr,audio,completeness}, scoreReasons: reasons };
}

function nearDuplicateGroups(items, tolerance = 0.01) {
  const buckets = new Map();
  for (const item of items) {
    const bytes = sizeToBytes(item.size || item.sizeBytes);
    if (!bytes) continue;
    const key = [titleKey(item), item.year || '', item.quality || '', item.codec || '', item.audio || '', item.language || '', item.isRepack || /repack/i.test(String(item.releaseType || '')) ? 'repack' : 'main'].join('|');
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push({item, bytes});
  }
  const groups = [];
  for (const [key, entries] of buckets) {
    entries.sort((a,b) => a.bytes-b.bytes);
    const used = new Set();
    for (let i=0;i<entries.length;i++) {
      if (used.has(i)) continue;
      const group=[entries[i]];
      for(let j=i+1;j<entries.length;j++) {
        const delta=Math.abs(entries[j].bytes-entries[i].bytes)/entries[i].bytes;
        if(delta<=tolerance) { group.push(entries[j]); used.add(j); }
      }
      if(group.length>1) {
        group.forEach(x=>used.add(entries.indexOf(x)));
        groups.push({key,items:group.map(x=>({url:x.item.url||x.item.links?.[0]?.url||null,filename:x.item.filename||null,size:x.item.size||null,deltaPercent:Number((Math.abs(x.bytes-group[0].bytes)/group[0].bytes*100).toFixed(2))})),reviewRequired:true});
      }
    }
  }
  return groups;
}

/**
 * Analyze all links for one normalized title/year across every selected account.
 * Never removes links: exact URL duplicates and close-size candidates are reported.
 */
function analyzeVariantSet(downloads = [], options = {}) {
  const input = Array.isArray(downloads) ? downloads : [];
  const seen = new Set();
  const unique = input.filter(item => {
    const urls = [item.url, ...(item.links || []).map(link => link.url)].filter(Boolean);
    if (!urls.length) return true;
    const fresh = urls.some(url => !seen.has(String(url).trim()));
    urls.forEach(url => seen.add(String(url).trim()));
    return fresh;
  });
  const ranked = unique.map(scoreVariant).sort((a,b) => b.qualityScore-a.qualityScore);
  const bestScore = ranked[0]?.qualityScore || 0;
  return {
    totalReceived: input.length,
    uniqueVariants: ranked.length,
    exactUrlDuplicates: input.length - unique.length,
    ranked,
    recommended: ranked[0] ? {...ranked[0], recommendation: 'Best metadata-based candidate; verify playback before replacing other copies.'} : null,
    nearDuplicates: nearDuplicateGroups(unique, options.sizeTolerance ?? 0.01),
    warning: 'File size alone is never used to delete or rank a release. Metadata-based scoring is advisory; actual video/audio stream inspection is not performed.'
  };
}


/**
 * Display ordering for combined results from every selected Telegram account.
 * Size establishes the global order; releases within an 8% size window are
 * re-ordered by the existing format/quality score. No link is removed.
 */
function rankVariantsForDisplay(items = [], options = {}) {
  const tolerance = Number.isFinite(options.sizeTolerance) ? options.sizeTolerance : 0.08;
  const ranked = (Array.isArray(items) ? items : []).map(scoreVariant);

  // Keep every original/main release, but put explicitly-labelled repacks first.
  // Within each release class, retain the established size-first ordering and
  // quality scoring for close-size encodes.
  function rankReleaseClass(releases) {
    const sized = releases
      .map(item => ({ item, bytes: sizeToBytes(item.size || item.sizeBytes) }))
      .filter(entry => entry.bytes > 0)
      .sort((a, b) => b.bytes - a.bytes);
    const unsized = releases
      .filter(item => !(sizeToBytes(item.size || item.sizeBytes) > 0))
      .sort((a, b) => b.qualityScore - a.qualityScore);
    const ordered = [];

    for (let i = 0; i < sized.length;) {
      const anchor = sized[i].bytes;
      const cluster = [sized[i]];
      let j = i + 1;
      while (j < sized.length && (anchor - sized[j].bytes) / anchor <= tolerance) {
        cluster.push(sized[j]);
        j++;
      }
      cluster.sort((a, b) => b.item.qualityScore - a.item.qualityScore || b.bytes - a.bytes);
      ordered.push(...cluster.map(entry => entry.item));
      i = j;
    }
    return [...ordered, ...unsized];
  }

  const repacks = ranked.filter(item => item.isRepack);
  const originals = ranked.filter(item => !item.isRepack);
  return [...rankReleaseClass(repacks), ...rankReleaseClass(originals)];
}

module.exports = { sizeToBytes, titleKey, scoreVariant, analyzeVariantSet, nearDuplicateGroups, rankVariantsForDisplay };
