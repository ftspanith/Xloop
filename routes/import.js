const router = require('express').Router();
const auth = require('../middleware/auth');
const axios = require('axios');
const Movie = require('../models/Movie');
const {
  stripEmojis,
  cleanTitleForApi,
  extractSeasonEpisode,
  parseMessageBlock,
  detectCodec,
  detectHDR,
  extractAudio,
  extractYear,
} = require('../utils/parser');
const { searchTMDB: _sharedSearchTMDB, searchOMDB: _sharedSearchOMDB } = require('../utils/tmdbSearch');


// ── Server-side API keys (fallback when client doesn't pass them) ──
const ENV_TMDB_KEY = process.env.TMDB_API_KEY || '';
const ENV_OMDB_KEY = process.env.OMDB_API_KEY || '';
function resolveKeys(req) {
  return {
    tmdbKey: req.body?.tmdbKey || ENV_TMDB_KEY,
    omdbKey: req.body?.omdbKey || ENV_OMDB_KEY,
  };
}

// ═══════════════════════════════════════════════════════════════
//  UTILITY HELPERS
// ═══════════════════════════════════════════════════════════════

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^$()|[\\]{}]/g, '\\function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }');
}

// Quality normalizer
function normalizeQuality(str) {
  if (/2160p|\b4K\b|\bUHD\b/i.test(str)) return '4K';
  if (/1080p/i.test(str)) return '1080p';
  if (/720p/i.test(str))  return '720p';
  if (/480p/i.test(str))  return '480p';
  if (/360p/i.test(str))  return '360p';
  return 'HD';
}

// Canonicalize GDFlix subdomains while preserving each link's path and query.
function normalizeGdflixUrl(value) {
  try {
    const parsed = new URL(value);
    const host = parsed.hostname.toLowerCase();
    if (host === 'gdflix.dev' || host.endsWith('.gdflix.dev')) {
      parsed.hostname = 'gdflix.dev';
      return parsed.toString();
    }
    if (host === 'hubcloud.one' || host.endsWith('.hubcloud.one')) {
      parsed.hostname = 'hubcloud.one';
      return parsed.toString();
    }
    return value;
  } catch (_) {
    return value;
  }
}

function hasDownloadUrl(downloads, url) {
  const target = normalizeGdflixUrl(String(url || ''));
  return (downloads || []).some(d => (d.links || []).some(l => normalizeGdflixUrl(String(l.url || '')) === target));
}

// Host detector
function detectHost(url) {
  if (/^(?:https?:\/\/)?(?:[^/]+\.)?gdflix\.dev(?:[/:?#]|$)/i.test(url)) return 'GDFlix';
  if (/^(?:https?:\/\/)?(?:[^/]+\.)?hubcloud\.one(?:[/:?#]|$)/i.test(url) || /hubcloud/i.test(url)) return 'HubCloud';
  if (/gdlink/i.test(url))         return 'GDLink';
  if (/terabox/i.test(url))        return 'TeraBox';
  if (/gofile/i.test(url))         return 'GoFile';
  if (/pixeldrain/i.test(url))     return 'PixelDrain';
  if (/drive\.google/i.test(url))  return 'Google Drive';
  if (/1fichier/i.test(url))       return '1Fichier';
  if (/filepress/i.test(url))      return 'FilePress';
  if (/streamtape/i.test(url))     return 'StreamTape';
  return 'Download';
}

// Levenshtein similarity (0–1)
function stringSimilarity(a, b) {
  a = a.toLowerCase().trim();
  b = b.toLowerCase().trim();
  if (a === b) return 1;
  const longer  = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (longer.length === 0) return 1;
  const editDist = levenshtein(longer, shorter);
  return (longer.length - editDist) / longer.length;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  return dp[m][n];
}

// ═══════════════════════════════════════════════════════════════
//  CONFIDENCE SCORING ENGINE
//  Ensures we matched the RIGHT movie (not same name, diff year)
// ═══════════════════════════════════════════════════════════════

function scoreMatch(parsed, tmdbResult) {
  let score = 0;
  const reasons = [];

  // 1. Title similarity
  const cleanParsed = cleanTitleForApi(parsed.title);
  const cleanTmdb   = cleanTitleForApi(tmdbResult.title || tmdbResult.name || '');
  const titleSim    = stringSimilarity(cleanParsed, cleanTmdb);
  score += titleSim * 50; // up to 50 points
  reasons.push(`Title match: ${Math.round(titleSim * 100)}%`);

  const isPerfect = titleSim >= 0.95;
  if (isPerfect) {
    score += 25;
    reasons.push('Perfect title match boost (+25)');
  } else if (titleSim >= 0.90) {
    score += 15;
    reasons.push('Near perfect title match boost (+15)');
  }

  // A show's year is its premiere year. Later season years are checked by
  // the shared TMDB matcher against the actual season air_date.
  const comparisonYear = parsed.isSeries
    ? (parsed.messageYear || null)
    : (parsed.messageYear || parsed.year || null);
  if (comparisonYear && tmdbResult.year) {
    const yearDiff = Math.abs(comparisonYear - tmdbResult.year);
    if (yearDiff === 0) { score += 30; reasons.push('Year exact match'); }
    else if (yearDiff === 1) { score += 15; reasons.push('Year off by 1'); }
    else if (yearDiff <= 2) { score += 5; reasons.push('Year off by ' + yearDiff); }
    else { score -= 10; reasons.push('Year mismatch (' + yearDiff + ' years off)'); }
  } else {
    score += 10;
    reasons.push('No parent year to compare');
  }

  // 3. Content type match
  const parsedType = parsed.isSeries ? 'tv' : 'movie';
  const tmdbType   = tmdbResult.type === 'series' || tmdbResult.media_type === 'tv' ? 'tv' : 'movie';
  if (parsedType === tmdbType) { 
    score += 20; 
    reasons.push('Type match (movie/series)'); 
  } else if (!isPerfect) { 
    score -= 20; 
    reasons.push('Type mismatch penalty'); 
  } else {
    reasons.push('Type mismatch forgiven due to perfect title');
  }

  return { score: Math.round(score), reasons };
}

// ═══════════════════════════════════════════════════════════════
//  TMDB API  (with multi-search + detail + confidence)
// ═══════════════════════════════════════════════════════════════

const TMDB_LANG_MAP = { te: 'Telugu', ta: 'Tamil', hi: 'Hindi', ml: 'Malayalam', kn: 'Kannada', en: 'English', mr: 'Marathi', bn: 'Bengali', pa: 'Punjabi' };

// ═══════════════════════════════════════════════════════════════
//  TMDB API  ── powered by shared 14-algorithm engine
//  (same logic as pipeline_full.js auto-import)
// ═══════════════════════════════════════════════════════════════

async function fetchTMDB(parsed, tmdbKey) {
  const isSeries = !!parsed.isSeries || parsed.contentType === 'series' || parsed.contentType === 'anime';
  const yearHints = [...new Set([
    parsed.messageYear, parsed.year, ...(parsed.yearCandidates || []),
    ...(parsed.downloads || []).map(file => file.fileYear || extractYear([file.filename])),
  ].map(Number).filter(value => Number.isInteger(value) && value >= 1900 && value <= 2099))];
  const seasonYearHints = (parsed.downloads || [])
    .filter(file => !parsed.season || Number(file.season) === Number(parsed.season))
    .map(file => file.fileYear || extractYear([file.filename]))
    .filter(Boolean);
  const titleYearHint = isSeries ? (parsed.messageYear || null) : (parsed.messageYear || parsed.year || null);
  const result = await _sharedSearchTMDB(
    parsed.rawTitle || parsed.title,
    titleYearHint,
    isSeries,
    parsed.season || null,
    null,
    parsed.imdbId || null,
    parsed.tmdbIdHint || null,
    { tmdbKey, yearHints, seasonYearHints, messageYear: titleYearHint }
  );
  if (!result) return null;
  return {
    ...result,
    language: result.originalLanguage || '',
    confidenceReasons: [`Matched via algorithm ${result._algo || 'A1'} (${result.confidence}pts)`],
    isAnime: false,
  };
}

// ═══════════════════════════════════════════════════════════════
//  OMDB/IMDB API  (cross-validation & fallback)
// ═══════════════════════════════════════════════════════════════

async function fetchOMDB(parsed, omdbKey) {
  const isSeries = !!parsed.isSeries || parsed.contentType === 'series' || parsed.contentType === 'anime';
  const titleYearHint = isSeries ? (parsed.messageYear || null) : (parsed.messageYear || parsed.year || null);
  const yearHints = [...new Set([
    parsed.messageYear, parsed.year, ...(parsed.yearCandidates || []),
    ...(parsed.downloads || []).map(file => file.fileYear || extractYear([file.filename])),
  ].filter(Boolean).map(Number))];
  const shared = await _sharedSearchOMDB(
    parsed.rawTitle || parsed.title, titleYearHint, isSeries, omdbKey, { yearHints }
  );
  if (shared) return shared;

  try {
    const cleanTitle = cleanTitleForApi(parsed.rawTitle || parsed.title);
    const params = { t: cleanTitle, apikey: omdbKey, type: isSeries ? 'series' : 'movie', plot: 'short' };
    if (titleYearHint) params.y = titleYearHint;
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 30000 });
    let d = res.data;
    if (!d || d.Response === 'False') {
      const fallbackParams = { t: cleanTitle, apikey: omdbKey, plot: 'short' };
      if (titleYearHint) fallbackParams.y = titleYearHint;
      const res2 = await axios.get('https://www.omdbapi.com/', { params: fallbackParams, timeout: 30000 });
      if (!res2.data || res2.data.Response === 'False') return null;
      d = res2.data;
    }
    const yearText = String(d.Year || '');
    const years = (yearText.match(/19\\d{2}|20\\d{2}/g) || []).map(Number);
    const omdbYear = years[0] || titleYearHint;
    const insideRun = isSeries && years.length > 1 &&
      yearHints.some(value => value >= years[0] - 2 && value <= years[years.length - 1] + 2);
    const yearDiff = omdbYear && yearHints.length
      ? Math.min(...yearHints.map(value => Math.abs(value - omdbYear))) : null;
    if (yearDiff != null && yearDiff > (isSeries ? 5 : 3) && !insideRun) return null;
    return {
      imdbId: d.imdbID || '',
      title: d.Title || parsed.title,
      description: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
      poster: d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
      rating: d.imdbRating && d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
      year: omdbYear,
      genre: d.Genre && d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
      duration: d.Runtime && d.Runtime !== 'N/A'
        ? (() => { const m = parseInt(d.Runtime, 10); return Math.floor(m / 60) + 'h ' + (m % 60) + 'm'; })()
        : '',
      type: d.Type === 'series' ? 'series' : 'movie',
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════
//  IMDB SUGGESTION API (Fallback when TMDB/OMDB fail to find a poster)
// ═══════════════════════════════════════════════════════════════
async function fetchIMDB(parsed) {
  try {
    const title = cleanTitleForApi(parsed.title);
    const query = title.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '+');
    const firstLet = query[0] || 'a';
    const url = `https://v2.sg.media-imdb.com/suggestion/${firstLet}/${encodeURIComponent(query)}.json`;

    const r = await axios.get(url, {
      timeout: 15000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const results = (r.data.d || [])
      .filter(item => item.qid === 'movie' || item.qid === 'tvSeries' || item.qid === 'tvMiniSeries')
      .map(item => ({
        imdbId:   item.id,
        title:    item.l,
        year:     item.y || null,
        poster:   item.i?.imageUrl ? item.i.imageUrl.replace(/\._V1_.*$/, '._V1_SX1000.jpg') : '',
        type:     item.qid === 'movie' ? 'movie' : 'series',
      }));

    if (results.length === 0) return null;

    let best = results[0];
    if (parsed.year) {
      const yearMatches = results.filter(r => r.year && Math.abs(r.year - parsed.year) <= 2);
      if (yearMatches.length > 0) best = yearMatches[0];
    }
    
    if (!best.poster) return null; // We only care if it has a poster

    return {
      imdbId: best.imdbId,
      title: best.title,
      year: best.year,
      poster: best.poster,
      type: best.type,
      confidence: 50,
      confidenceReasons: ['Fallback to IMDB Suggestion API'],
      description: '', rating: 0, genre: [], duration: ''
    };
  } catch (err) {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════
//  MASTER META FETCHER — TMDB + OMDB + IMDB cross-validation
// ═══════════════════════════════════════════════════════════════

async function fetchMeta(parsed, tmdbKey, omdbKey) {
  let tmdb = null, omdb = null;

  if (tmdbKey) tmdb = await fetchTMDB(parsed, tmdbKey);
  if (omdbKey)  omdb = await fetchOMDB(parsed, omdbKey);

  // Both found: cross-validate poster/year consistency
  if (tmdb && omdb) {
    // Keep TMDB's premiere year authoritative; OMDb may return a run range.
    if (!tmdb.poster   && omdb.poster)      tmdb.poster      = omdb.poster;
    if (!tmdb.rating   && omdb.rating)      tmdb.rating      = omdb.rating;
    if (!tmdb.description && omdb.description) tmdb.description = omdb.description;
    if (!tmdb.duration && omdb.duration)    tmdb.duration    = omdb.duration;
    if (!tmdb.genre?.length && omdb.genre?.length) tmdb.genre = omdb.genre;
    if (omdb.imdbId)   tmdb.imdbId = omdb.imdbId;
  }

  let finalMeta = tmdb || (omdb ? { ...omdb, tmdbId: '' } : null);

  // 3-Tier Fallback: If we still don't have a poster, hit IMDB Suggestion API!
  if (!finalMeta || !finalMeta.poster) {
    const imdbFallback = await fetchIMDB(parsed);
    if (imdbFallback) {
      if (!finalMeta) {
        finalMeta = { ...imdbFallback, tmdbId: '' };
      } else {
        finalMeta.poster = imdbFallback.poster;
        if (!finalMeta.imdbId) finalMeta.imdbId = imdbFallback.imdbId;
        finalMeta.confidenceReasons = [...(finalMeta.confidenceReasons || []), 'Poster scraped via IMDB Fallback'];
      }
          }
  }

  return finalMeta || {};
}

// ═══════════════════════════════════════════════════════════════
//  FINAL CONTENT TYPE RESOLVER
//  Uses TMDB anime flag + parsed detection
// ═══════════════════════════════════════════════════════════════

function resolveType(parsed, meta) {
  // Anime: TMDB says it's an animation TV show OR parsed detected it
  if (meta.isAnime || parsed.contentType === 'anime') return 'anime';
  // Series from TMDB
  if (meta.type === 'series') return 'series';
  // Series from parser
  if (parsed.isSeries) return 'series';
  return 'movie';
}

// ═══════════════════════════════════════════════════════════════
//  POST /api/import/bulk
// ═══════════════════════════════════════════════════════════════

router.post('/bulk', auth, async (req, res) => {
  const { messages } = req.body;
  const { tmdbKey, omdbKey } = resolveKeys(req);
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ message: 'Messages array required' });
  }

  // ── Smart block segmenter ──────────────────────────────────────────────────
  // Handles all common paste formats from users:
  //  A. Blank-line separated:     filename\nURL\n\nfilename\nURL
  //  B. Dense no-blank:           filename\nURL\nfilename\nURL
  //  C. Numbered list:            1. filename\nURL\n2. filename\nURL
  //  D. Orphan URL (blank+link):  filename\n\nURL\n\nfilename
  const isUrl = (l) => /^https?:\/\//i.test((l||'').trim());
  const isFilename = (l) => {
    const t = (l||'').trim();
    return t.length > 5 && (
      /\.(mkv|mp4|avi|zip|rar|m2ts|mov)\b/i.test(t) ||
      /\b(2160p|1080p|720p|480p|4K|UHD|WEB[-\s]?DL|WEBRip|BluRay|HEVC|x265|x264)\b/i.test(t) ||
      /\b\d+(?:\.\d+)?\s*(?:GB|MB)\b/i.test(t)
    ) && !isUrl(t);
  };
  const isUrlOnlyBlock = (b) => b.split('\n').every(l => !l.trim() || isUrl(l));
  const NUMBERED_SPLIT_RE = /(?=\n\d+\.\s+.{5,})/;
  const expandedMessages = [];

  for (const msgObj of messages) {
    if (!msgObj?.text) continue;
    const normText = msgObj.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();

    // Strategy C: numbered list
    const numberedMatches = normText.match(/^\d+\.\s+/mg) || [];
    if (numberedMatches.length >= 2) {
      const chunks = normText.split(NUMBERED_SPLIT_RE)
        .map(b => b.replace(/^\n/, '').replace(/^\d+\.\s+/, '').trim())
        .filter(Boolean);
      for (const c of chunks) expandedMessages.push({ ...msgObj, text: c });
      continue;
    }

    // Strategy A/D: double-newline split
    let rawBlocks = normText.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    if (rawBlocks.length > 1) {
      // Merge orphan URL-only blocks back into preceding block
      const merged = [];
      for (const block of rawBlocks) {
        if (merged.length > 0 && isUrlOnlyBlock(block)) {
          merged[merged.length - 1] += '\n' + block;
        } else {
          merged.push(block);
        }
      }
      // Sub-split each merged block in case it still has multiple filename+URL pairs
      for (const block of merged) {
        const bLines = block.split('\n').map(l => l.trim()).filter(Boolean);
        const urlCount = bLines.filter(isUrl).length;
        if (urlCount <= 1) {
          expandedMessages.push({ ...msgObj, text: block });
          continue;
        }
        // Multiple URLs in one block — split on URL→filename boundary
        const subBlocks = [];
        let cur = [];
        let seenUrl = false;
        for (const line of bLines) {
          if (isUrl(line)) {
            cur.push(line);
            seenUrl = true;
          } else if (seenUrl && isFilename(line)) {
            if (cur.length) subBlocks.push(cur.join('\n'));
            cur = [line];
            seenUrl = false;
          } else {
            cur.push(line);
          }
        }
        if (cur.length) subBlocks.push(cur.join('\n'));
        for (const sb of (subBlocks.length > 1 ? subBlocks : [block])) {
          if (sb.trim()) expandedMessages.push({ ...msgObj, text: sb.trim() });
        }
      }
      continue;
    }

    // Strategy B: dense single-newline, multiple URLs → split on URL→filename boundary
    const lines = normText.split('\n').map(l => l.trim()).filter(Boolean);
    const urlCount = lines.filter(isUrl).length;
    if (urlCount >= 2) {
      const subBlocks = [];
      let cur = [];
      let seenUrl = false;
      for (const line of lines) {
        if (isUrl(line)) {
          cur.push(line);
          seenUrl = true;
        } else if (seenUrl) {
          // Any non-URL line after URL = next movie
          if (cur.length) subBlocks.push(cur.join('\n'));
          cur = [line];
          seenUrl = false;
        } else {
          cur.push(line);
        }
      }
      if (cur.length) subBlocks.push(cur.join('\n'));
      if (subBlocks.length > 1) {
        for (const sb of subBlocks) {
          if (sb.trim()) expandedMessages.push({ ...msgObj, text: sb.trim() });
        }
        continue;
      }
    }

    // Single movie — push as-is
    expandedMessages.push({ ...msgObj, text: normText });
  }


  // ── Smart block segmenter ──────────────────────────────────────────────────
  let successCount = 0, updatedCount = 0, skippedCount = 0, lowConfidence = 0, duplicateCount = 0;
  const errors = [];

  // fetchMeta with 12s timeout — if TMDB hangs, fall back to empty meta
  async function fetchMetaSafe(parsed) {
    let timer;
    try {
      return await Promise.race([fetchMeta(parsed, tmdbKey, omdbKey), new Promise(resolve => { timer = setTimeout(() => resolve({}), 12000); })]);
    } catch (_) { return {}; }
    finally { clearTimeout(timer); }
  }

  // Phase 1: Parse + fetch meta in parallel
  const processedItems = await Promise.all(expandedMessages.map(async (msgObj) => {
    if (!msgObj?.text) return { skip: true, reason: 'empty' };
    const parsed = parseMessageBlock(msgObj.text);
    if (!parsed || !parsed.title?.trim()) return { skip: true, reason: 'no_title' };
    const meta = await fetchMetaSafe(parsed);
    return { msgObj, parsed, meta };
  }));

  // Phase 2: Sequential DB ops
  let lastAddedTitle = '';
  // Multiple parsed blocks can originate from one Telegram message ID.
  // Count a repeated source message once, not once per file variant.
  const countedDuplicateMessageIds = new Set();
  for (const item of processedItems) {
    if (item.skip) {
      skippedCount++;
      continue;
    }

    const { msgObj, parsed, meta } = item;
    const { title, year, language, quality, downloads, isSeries } = parsed;

    // Skip very low confidence results (wrong movie entirely)
    if (meta.confidence !== undefined && meta.confidence < 35) {
      lowConfidence++;
      skippedCount++;
      continue;
    }

    const tmdbId     = meta.tmdbId || null;
    const finalTitle = meta.title  || title;
    const finalType  = resolveType(parsed, meta);

    // ── Smart Deduplication ───────────────────────────────
    const expectedTypes = finalType === 'anime' || finalType === 'series'
      ? { $in: ['series', 'anime'] } : 'movie';
    let existing = tmdbId ? await Movie.findOne({ tmdbId, type: expectedTypes }) : null;
    if (!existing) {
      existing = await Movie.findOne({
        title: new RegExp('^' + escapeRegex(finalTitle) + '$', 'i'),
        type: expectedTypes,
      });
    }
    if (!existing && finalTitle !== title) {
      existing = await Movie.findOne({
        title: new RegExp('^' + escapeRegex(title) + '$', 'i'),
        type: expectedTypes,
      });
    }

    if (existing) {
      // A Telegram message may contain several file variants. Do not skip the
      // remaining variants just because this message ID was already processed.

      let updated = false;
      for (const newDl of downloads) {
        // 1. Check if the URL already exists anywhere in this movie
        newDl.links = (newDl.links || []).map(link => ({ ...link, url: normalizeGdflixUrl(link.url) }));
        const newUrl = newDl.links[0]?.url;
        const hasUrl = hasDownloadUrl(existing.downloads, newUrl);
        
        if (hasUrl) {
          // Link already exists, skip it entirely
          continue;
        }

        // 2. If it's a new URL, try to group it with an existing download by filename/size
        // Never merge distinct file variants merely because quality/language match.
        // Prefer exact filename identity; only use a strict metadata signature when
        // one or both legacy records have no filename.
        const existingDl = existing.downloads.find(d => {
          const oldName = String(d.filename || '').trim().toLowerCase();
          const newName = String(newDl.filename || '').trim().toLowerCase();
          if (oldName && newName) return oldName === newName;
          return (
            d.quality === newDl.quality &&
            String(d.size || '') === String(newDl.size || '') &&
            String(d.codec || '') === String(newDl.codec || '') &&
            String(d.hdr || '') === String(newDl.hdr || '') &&
            String(d.audio || '') === String(newDl.audio || '') &&
            String(d.language || '') === String(newDl.language || '') &&
            (d.season ?? null) === (newDl.season ?? null) &&
            (d.episode ?? null) === (newDl.episode ?? null)
          );
        });

        if (existingDl) {
          for (const link of newDl.links) {
            if (!hasDownloadUrl([{ links: existingDl.links }], link.url)) {
              existingDl.links.push(link);
              updated = true;
            }
          }
        } else {
          existing.downloads.push(newDl);
          updated = true;
        }
      }
      if (msgObj.id && !existing.telegramMessageIds?.includes(msgObj.id)) {
        if (!existing.telegramMessageIds) existing.telegramMessageIds = [];
        existing.telegramMessageIds.push(msgObj.id);
        updated = true;
      }
      if (updated) {
        // Keep per-season release years separate from the parent's premiere year.
        for (const file of downloads) {
          if (file.season && file.fileYear && !existing.seasonYears?.[`s${file.season}`]) {
            existing.set(`seasonYears.s${file.season}`, Number(file.fileYear));
          }
        }
        const importedSeason = parsed.season || downloads.find(file => file.season)?.season;
        if (importedSeason && meta.seasonYear) {
          existing.set(`seasonYears.s${importedSeason}`, Number(meta.seasonYear));
        }
        if (meta.tmdbId && meta.releaseDate && String(existing.tmdbId || '') === String(meta.tmdbId) && meta.year) {
          existing.year = meta.year;
          existing.releaseDate = meta.releaseDate;
        }
        // Keep movie-level aggregate fields in sync with newly added variants.
        const { recomputeAggregates } = require('../pipeline_full');
        recomputeAggregates(existing);
        await existing.save();
        updatedCount++;
      } else {
        const duplicateMessageId = msgObj.id != null ? String(msgObj.id) : null;
        if (!duplicateMessageId || !countedDuplicateMessageIds.has(duplicateMessageId)) {
          duplicateCount++;
        }
        if (duplicateMessageId) countedDuplicateMessageIds.add(duplicateMessageId);
        skippedCount++;
      }
      continue;
    }

    // ── Resolve final language ────────────────────────────
    let finalLanguage = language;
    if ((finalLanguage === 'Multi' || finalLanguage === 'Hindi' || !finalLanguage) && meta.language) {
      finalLanguage = meta.language;
    }

    const movieData = {
      title:              finalTitle,
      tmdbId:             meta.tmdbId   || '',
      imdbId:             meta.imdbId   || '',
      type:               finalType,
      totalSeasons:       meta.totalSeasons || 0,
      description:        meta.description  || '',
      poster:             meta.poster        || '',
      backdrop:           meta.backdrop      || '',
      rating:             meta.rating        || 0,
      year:               meta.year || parsed.messageYear || (isSeries ? null : (year || new Date().getFullYear())),
      releaseDate:        meta.releaseDate || '',
      seasonYears:        Object.fromEntries(downloads.filter(file => file.season && file.fileYear)
        .map(file => [`s${file.season}`, Number(file.fileYear)])),
      genre:              meta.genre   || [],
      duration:           meta.duration || '',
      quality:            quality || 'HD',
      language:           finalLanguage,
      downloads,
      telegramMessageIds: msgObj.id ? [msgObj.id] : [],
      _importMeta: {
        confidence:        meta.confidence || 100,
        confidenceReasons: meta.confidenceReasons || [],
        contentType:       parsed.contentType,
      }
    };

    try {
      await Movie.create(movieData);
      successCount++;
      lastAddedTitle = finalTitle;
    } catch (dbErr) {
      errors.push(`DB Error for "${title}": ${dbErr.message}`);
    }
  }

  res.json({
    message: `Added ${successCount} new | Updated ${updatedCount} existing | Skipped ${skippedCount} (${lowConfidence} low confidence)`,
    successCount, updatedCount, skippedCount, lowConfidence, duplicateCount,
    addedTitle: lastAddedTitle,
    detectedFiles: processedItems.filter(item => !item.skip && item.parsed).flatMap(item =>
      (item.parsed.downloads || []).map(file => ({
        title: item.meta?.title || item.parsed.title,
        filename: file.filename || '',
        quality: file.quality || 'HD',
        size: file.size || '',
        season: file.season ?? null,
        episode: file.episode ?? null,
        language: file.language || '',
        codec: file.codec || '',
        hdr: file.hdr || '',
        audio: file.audio || '',
        source: file.source || '',
        urls: (file.links || []).map(link => link.url)
      }))
    ),
    errors: errors.slice(0, 20),
  });
});

// ── POST /api/import/preview ──────────────────────────────
router.post('/preview', auth, async (req, res) => {
  try {
    const { message } = req.body;
    if (!message) return res.status(400).json({ error: 'Message required' });

    // Ensure TMDB key is available, else abort
    const tmdbKey = process.env.TMDB_API_KEY;
    if (!tmdbKey) return res.status(500).json({ error: 'TMDB_API_KEY missing in .env' });

    // Use central parser!
    const parsed = parseMessageBlock(message);
    if (!parsed) return res.status(400).json({ error: 'Could not parse message' }); 
    res.json(parsed);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── POST /api/import/fetch-meta ──────────────────────────────
// Used by both bulk import and the Fix Posters admin tool.
// Returns full metadata including poster AND backdrop from TMDB + OMDB.
router.post('/fetch-meta', auth, async (req, res) => {
  const { title, year, isSeries } = req.body;
  const { tmdbKey, omdbKey } = resolveKeys(req);
  if (!title) return res.status(400).json({ message: 'Title required' });

  const parsed = { title, year: year ? parseInt(year) : null, isSeries: !!isSeries, contentType: isSeries ? 'series' : 'movie' };

  let tmdb = null, omdb = null;

  // Run both in parallel for speed
  const [tmdbResult, omdbResult] = await Promise.all([
    tmdbKey ? fetchTMDB(parsed, tmdbKey) : Promise.resolve(null),
    omdbKey ? fetchOMDB(parsed, omdbKey) : Promise.resolve(null),
  ]);

  tmdb = tmdbResult;
  omdb = omdbResult;

  // If TMDB failed confidence check, try a relaxed TMDB search (no year constraint)
  if (!tmdb && tmdbKey) {
    tmdb = await fetchTMDB({ ...parsed, year: null }, tmdbKey);
  }

  // 3-Tier Fallback for manual poster fix
  let imdbFallback = null;
  if (!(tmdb && tmdb.poster) && !(omdb && omdb.poster)) {
    imdbFallback = await fetchIMDB(parsed);
  }

  // Build the best combined result
  if (!tmdb && !omdb && !imdbFallback) {
    return res.status(404).json({ message: `No results found for "${title}" on TMDB, OMDB, or IMDB` });
  }

  // Merge: TMDB is primary (has backdrop), OMDB fills gaps
  const result = {
    title:       (tmdb?.title || omdb?.title || title),
    year:        (tmdb?.year  || omdb?.year  || year || null),
    poster:      (tmdb?.poster    || omdb?.poster    || ''),
    backdrop:    (tmdb?.backdrop  || ''),                      // Only TMDB has backdrops
    rating:      (tmdb?.rating    || omdb?.rating    || 0),
    description: (tmdb?.description || omdb?.description || ''),
    genre:       (tmdb?.genre?.length ? tmdb.genre : (omdb?.genre || [])),
    duration:    (tmdb?.duration  || omdb?.duration  || ''),
    tmdbId:      (tmdb?.tmdbId    || ''),
    imdbId:      (omdb?.imdbId    || ''),
    type:        (tmdb?.type      || omdb?.type      || 'movie'),
    confidence:  (tmdb?.confidence || 0),
    // If TMDB has no poster, try OMDB poster as backup, then IMDB fallback
    posterSources: {
      tmdb: tmdb?.poster   || '',
      omdb: omdb?.poster   || '',
      imdb: imdbFallback?.poster || '',
    },
    backdropSources: {
      tmdb: tmdb?.backdrop || '',
    },
  };
  
  if (!result.poster) {
    result.poster = imdbFallback?.poster || '';
  }

  res.json(result);
});

// ── POST /api/import/search-imdb ──────────────────────────────
// Directly queries IMDB's suggestion API to get posters.
// Supports direct IMDB IDs, IMDB URLs, or text search.
router.post('/search-imdb', auth, async (req, res) => {
  const { title, year } = req.body;
  if (!title) return res.status(400).json({ message: 'Title required' });

  try {
    let url = '';
    // Detect if user pasted an IMDB URL or ID (e.g. tt1305797)
    const idMatch = title.match(/(tt\d{7,10})/);
    if (idMatch) {
      const imdbId = idMatch[1];
      url = `https://v2.sg.media-imdb.com/suggestion/t/${imdbId}.json`;
    } else {
      const query = title.toLowerCase().trim().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, '+');
      const firstLet = query[0] || 'a';
      url = `https://v2.sg.media-imdb.com/suggestion/${firstLet}/${encodeURIComponent(query)}.json`;
    }

    const r = await axios.get(url, {
      timeout: 30000,
      headers: { 'User-Agent': 'Mozilla/5.0' }
    });

    const results = (r.data.d || [])
      .filter(item => item.qid === 'movie' || item.qid === 'tvSeries' || item.qid === 'tvMiniSeries' || idMatch)
      .slice(0, 8)
      .map(item => ({
        imdbId:   item.id,
        title:    item.l,
        year:     item.y || null,
        cast:     item.s || '',
        poster:   item.i?.imageUrl
          ? item.i.imageUrl.replace(/\._V1_.*$/, '._V1_SX1000.jpg') // Get max quality 1000px version
          : '',
        fullPoster: item.i?.imageUrl || '',
      }));

    // Sort: exact year match first (if we didn't search by exact ID)
    if (year && !idMatch) {
      results.sort((a, b) => {
        const aDiff = a.year ? Math.abs(a.year - parseInt(year)) : 999;
        const bDiff = b.year ? Math.abs(b.year - parseInt(year)) : 999;
        return aDiff - bDiff;
      });
    }

    if (results.length === 0) {
      return res.status(404).json({ message: `No IMDB results found for "${title}"` });
    }

    res.json({ results });
  } catch (err) {
    res.status(500).json({ message: 'IMDB search failed: ' + err.message });
  }
});

// ── POST /api/import/manual-add ─────────────────────────────
router.post('/manual-add', auth, async (req, res) => {
  try {
    const {
      title, year, messageYear, type, isSeries, season, episode,
      duration, genre, rating, poster, backdrop, streamEmbed,
      isFeatured, isTrending, links, overwrite,
    } = req.body || {};
    const { tmdbKey, omdbKey } = resolveKeys(req);
    if (!title) return res.status(400).json({ message: 'Title required' });
    if (!Array.isArray(links) || !links.length) {
      return res.status(400).json({ message: 'At least one link required' });
    }

    const isTv = isSeries === true || type === 'series' || type === 'anime';
    const finalInputType = type === 'anime' ? 'anime' : (isTv ? 'series' : 'movie');
    const {
      extractYear: getYear, extractSeasonEpisode,
      detectCodec, detectHDR, extractAudio, extractSize, detectAllLanguages,
    } = require('../utils/parser');

    const parsedDownloads = links.map(link => {
      const filename = String(link.filename || '').trim();
      const se = filename ? extractSeasonEpisode(filename) : {};
      return {
        filename,
        fileYear: Number(link.fileYear || getYear([filename])) || null,
        season: link.season ?? se?.season ?? season ?? null,
        episode: link.episode ?? se?.episode ?? episode ?? null,
      };
    });
    const parsed = {
      title,
      rawTitle: title,
      year: year ? parseInt(year, 10) : null,
      messageYear: messageYear ? parseInt(messageYear, 10) : (isTv ? (year ? parseInt(year, 10) : null) : null),
      yearCandidates: [...new Set([year, messageYear, ...parsedDownloads.map(file => file.fileYear)]
        .map(Number).filter(value => Number.isInteger(value) && value >= 1900 && value <= 2099))],
      isSeries: isTv,
      contentType: finalInputType,
      season: season || parsedDownloads.find(file => file.season)?.season || null,
      downloads: parsedDownloads,
    };
    const meta = await fetchMeta(parsed, tmdbKey, omdbKey);
    const finalTitle = meta.title || title;
    const finalType = finalInputType === 'anime' || meta.isAnime
      ? 'anime' : (isTv || meta.type === 'series' ? 'series' : 'movie');
    const expectedTypes = finalType === 'movie' ? 'movie' : { $in: ['series', 'anime'] };

    const downloads = links.map((link, index) => {
      const fn = String(link.filename || '').trim();
      const file = parsedDownloads[index] || {};
      const parsedLanguages = fn ? detectAllLanguages(fn) : [];
      const language = link.language || parsedLanguages.filter(value => value !== 'Multi').join(', ') ||
        (parsedLanguages.includes('Multi') ? 'Multi' : '');
      const url = normalizeGdflixUrl(link.url || '');
      return {
        quality: link.quality || 'HD',
        size: link.size || (fn ? extractSize(fn) : '') || '',
        filename: fn,
        fileYear: file.fileYear || null,
        language,
        codec: link.codec || (fn ? detectCodec(fn) : '') || 'Other',
        hdr: link.hdr || (fn ? detectHDR(fn) : '') || null,
        audio: link.audio || (fn ? extractAudio(fn) : '') || null,
        audioTracks: Array.isArray(link.audioTracks) && link.audioTracks.length >= 2 ? link.audioTracks.slice(0, 8) : [],
        season: file.season,
        episode: file.episode,
        source: link.source || '',
        container: link.container || '',
        bitDepth: link.bitDepth || '',
        audioChannels: link.audioChannels || '',
        isRepack: !!link.isRepack,
        releaseType: link.releaseType || (link.isRepack ? 'Repack' : 'Original'),
        links: url ? [{ host: detectHost(url), url, isFast: /gdflix\.dev|hubcloud|gdlink/i.test(url) }] : [],
      };
    }).filter(download => download.links.length);

    if (!downloads.length) return res.status(400).json({ message: 'No valid download URLs found' });

    const tmdbId = meta.tmdbId || '';
    let existing = tmdbId
      ? await Movie.findOne({ tmdbId: String(tmdbId), type: expectedTypes })
      : null;
    const escapedTitle = [...finalTitle].map(char =>
      '$^.*+?()[]{}|'.includes(char) || char === String.fromCharCode(92)
        ? String.fromCharCode(92) + char : char
    ).join('');
    if (!existing) {
      existing = await Movie.findOne({
        title: new RegExp('^' + escapedTitle + '$', 'i'),
        type: expectedTypes,
      });
    }

    const seasonYearsFromDownloads = { ...(existing?.seasonYears || {}) };
    for (const download of downloads) {
      if (download.season && download.fileYear && !seasonYearsFromDownloads['s' + download.season]) {
        seasonYearsFromDownloads['s' + download.season] = Number(download.fileYear);
      }
    }
    const selectedSeason = season || parsed.season;
    if (selectedSeason && meta.seasonYear) {
      seasonYearsFromDownloads['s' + selectedSeason] = Number(meta.seasonYear);
    }

    if (existing && !overwrite) {
      const knownUrls = new Set((existing.downloads || []).flatMap(download =>
        (download.links || []).map(link => String(link.url || ''))
      ));
      let added = 0;
      for (const download of downloads) {
        const url = download.links[0]?.url;
        if (!url || knownUrls.has(url)) continue;
        existing.downloads.push(download);
        knownUrls.add(url);
        added++;
      }
      existing.seasonYears = seasonYearsFromDownloads;
      if (finalType === 'anime') existing.type = 'anime';
      if (!existing.tmdbId && meta.tmdbId) existing.tmdbId = String(meta.tmdbId);
      if (!existing.imdbId && meta.imdbId) existing.imdbId = meta.imdbId;
      if (meta.releaseDate && meta.year && meta.tmdbId &&
          String(existing.tmdbId || '') === String(meta.tmdbId)) {
        existing.releaseDate = meta.releaseDate;
        existing.year = meta.year;
      }
      for (const field of ['poster', 'posterFallback', 'backdrop', 'description', 'rating', 'duration', 'totalSeasons']) {
        if (!existing[field] && (meta[field] || (field === 'poster' && poster) || (field === 'backdrop' && backdrop))) {
          existing[field] = meta[field] || (field === 'poster' ? poster : backdrop);
        }
      }
      if ((!existing.genre || !existing.genre.length) && (genre?.length || meta.genre?.length)) {
        existing.genre = genre?.length ? genre : meta.genre;
      }
      if (!existing.releaseDate && meta.releaseDate) existing.releaseDate = meta.releaseDate;
      const { recomputeAggregates } = require('../pipeline_full');
      recomputeAggregates(existing);
      await existing.save();
      return res.json({ message: 'Updated existing: ' + existing.title, movie: existing, added });
    }

    if (existing && overwrite) {
      Object.assign(existing, {
        title: title || meta.title || existing.title,
        tmdbId: meta.tmdbId || existing.tmdbId,
        imdbId: meta.imdbId || existing.imdbId,
        type: finalType,
        totalSeasons: meta.totalSeasons || existing.totalSeasons,
        description: meta.description || existing.description,
        poster: poster || meta.poster || existing.poster,
        backdrop: backdrop || meta.backdrop || existing.backdrop,
        posterFallback: meta.posterFallback || existing.posterFallback,
        releaseDate: meta.releaseDate || existing.releaseDate,
        seasonYears: seasonYearsFromDownloads,
        rating: rating !== undefined ? rating : (meta.rating || existing.rating),
        year: meta.year || parsed.messageYear || (isTv ? existing.year : (year || existing.year)),
        genre: genre?.length ? genre : (meta.genre || existing.genre),
        duration: duration || meta.duration || existing.duration,
        streamEmbed: streamEmbed !== undefined ? streamEmbed : existing.streamEmbed,
        isFeatured: isFeatured !== undefined ? isFeatured : existing.isFeatured,
        isTrending: isTrending !== undefined ? isTrending : existing.isTrending,
      });
      existing.downloads.push(...downloads);
      const { recomputeAggregates } = require('../pipeline_full');
      recomputeAggregates(existing);
      await existing.save();
      return res.json({ message: 'Overwritten: ' + existing.title, movie: existing });
    }

    const seasonYears = Object.fromEntries(downloads
      .filter(download => download.season && download.fileYear)
      .map(download => ['s' + download.season, Number(download.fileYear)]));
    if (selectedSeason && meta.seasonYear) seasonYears['s' + selectedSeason] = Number(meta.seasonYear);
    const movie = await Movie.create({
      title: title || finalTitle,
      tmdbId: meta.tmdbId || '',
      imdbId: meta.imdbId || '',
      type: finalType,
      totalSeasons: meta.totalSeasons || 0,
      description: meta.description || '',
      poster: poster || meta.poster || '',
      posterFallback: meta.posterFallback || '',
      backdrop: backdrop || meta.backdrop || '',
      releaseDate: meta.releaseDate || '',
      seasonYears,
      rating: rating !== undefined ? rating : (meta.rating || 0),
      year: meta.year || parsed.messageYear || (isTv ? null : (year || new Date().getFullYear())),
      genre: genre?.length ? genre : (meta.genre || []),
      duration: duration || meta.duration || '',
      quality: downloads[0]?.quality || 'HD',
      language: meta.originalLanguage || 'Telugu',
      streamEmbed: streamEmbed || '',
      isFeatured: !!isFeatured,
      isTrending: !!isTrending,
      downloads,
    });
    const { recomputeAggregates } = require('../pipeline_full');
    recomputeAggregates(movie);
    await movie.save();
    res.json({ message: 'Created: ' + movie.title, movie });
  } catch (error) {
    res.status(500).json({ message: 'Manual add failed: ' + error.message });
  }
});

// ── PATCH /api/import/update-movie/:id ──────────────────────
router.patch('/update-movie/:id', auth, async (req, res) => {
  try {
    const movie = await Movie.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
    if (!movie) return res.status(404).json({ message: 'Movie not found' });
    res.json({ message: 'Updated', movie });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── DELETE /api/import/delete-movie/:id ─────────────────────
router.delete('/delete-movie/:id', auth, async (req, res) => {
  try {
    const deleted = await Movie.findByIdAndDelete(req.params.id);
    if (!deleted) return res.status(404).json({ message: 'Content not found' });
    res.json({ success: true, message: 'Deleted' });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── DELETE /api/import/wipe-all ─── Wipe entire DB (fresh import) ──
router.delete('/wipe-all', auth, async (req, res) => {
  try {
    const result = await Movie.deleteMany({});
    res.json({ message: `Wiped ${result.deletedCount} records from database.`, deletedCount: result.deletedCount });
  } catch (e) {
    res.status(500).json({ message: e.message });
  }
});

// ── POST /api/import/refetch-poster/:id ─────────────────────────────────────
// Re-runs TMDB/OMDB search for a movie and saves best valid poster.
router.post('/refetch-poster/:id', auth, async (req, res) => {
  try {
    const movie = await Movie.findById(req.params.id);
    if (!movie) return res.status(404).json({ message: 'Not found' });
    const { tmdbKey, omdbKey } = resolveKeys(req);
    const axios = require('axios');

    async function validatePoster(url) {
      if (!url) return null;
      try { const r = await axios.head(url, { timeout: 5000 }); return r.status < 400 ? url : null; }
      catch { return null; }
    }

    const { searchTMDB, searchOMDB, searchGoogleImage } = require('../pipeline_full');
    const isSer = movie.type === 'series' || movie.type === 'anime';
    const tmdb = await searchTMDB(movie.title, movie.year, isSer, null, null, movie.imdbId || null, movie.tmdbId || null);
    let poster = '', posterFallback = '', backdrop = '', tmdbId = movie.tmdbId, imdbId = movie.imdbId;

    if (tmdb) {
      tmdbId = tmdb.tmdbId || tmdbId;
      backdrop = tmdb.backdrop || '';
      const valid = await validatePoster(tmdb.poster);
      poster = valid || '';
    }

    const omdb = await searchOMDB(movie.title, movie.year, isSer);
    if (omdb) {
      imdbId = omdb.imdbId || imdbId;
      if (omdb.poster && omdb.poster !== poster) {
        if (!poster) {
          const valid = await validatePoster(omdb.poster);
          poster = valid || '';
        } else {
          posterFallback = omdb.poster;
        }
      }
    }

    // Last resort: Google image search for shows like Jabardasth with no TMDB/OMDB poster
    if (!poster) {
      const gImg = await searchGoogleImage(movie.title, movie.year, isSer);
      if (gImg) poster = gImg;
    }

    const updated = await Movie.findByIdAndUpdate(req.params.id, {
      $set: { poster, posterFallback, backdrop, tmdbId, imdbId }
    }, { new: true });
    res.json({ message: 'Poster refetched', poster, posterFallback, movie: updated });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── POST /api/import/manual-batch ───────────────────────────────────────────
// Accepts an array of pre-parsed manual entries and imports with full TMDB enrichment.
// Entry shape: { title, year, quality, size, codec, hdr, audio, language, season, episode, type, links: [{url}] }
router.post('/manual-batch', auth, async (req, res) => {
  try {
    const { entries = [] } = req.body || {};
    if (!Array.isArray(entries) || !entries.length) {
      return res.status(400).json({ message: 'No entries provided' });
    }

    const { searchTMDB, searchOMDB, recomputeAggregates } = require('../pipeline_full');
    const {
      detectCodec, detectHDR, extractAudio, extractSize, detectAllLanguages,
      extractYear, extractSeasonEpisode,
    } = require('../utils/parser');

    const groups = new Map();
    for (const entry of entries) {
      const title = String(entry.title || entry.rawTitle || '').trim();
      if (!title) continue;
      const isSeries = entry.type === 'series' || entry.type === 'anime' ||
        entry.isSeries === true || entry.contentType === 'series' || entry.contentType === 'anime';
      const parentYear = isSeries
        ? (entry.messageYear || entry.year || '')
        : (entry.messageYear || entry.year || '');
      const key = title.toLowerCase() + '__' + (isSeries ? parentYear : parentYear) +
        '__' + (isSeries ? 'tv' : 'movie');
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push({ ...entry, title, isSeries });
    }

    const results = [];
    for (const items of groups.values()) {
      const rep = items[0];
      const isSeries = items.some(item => item.isSeries);
      const isAnime = items.some(item => item.type === 'anime' || item.contentType === 'anime');
      const finalType = isAnime ? 'anime' : (isSeries ? 'series' : 'movie');
      const yearHints = [...new Set(items.flatMap(item => [
        item.messageYear, item.year, item.fileYear, extractYear([item.filename]),
      ]).filter(Boolean).map(Number).filter(year => Number.isInteger(year) && year >= 1900 && year <= 2099))];
      const seasonYearHints = items
        .filter(item => !rep.season || Number(item.season) === Number(rep.season))
        .map(item => item.fileYear || extractYear([item.filename]))
        .filter(Boolean);
      const titleYearHint = isSeries ? (rep.messageYear || rep.year || null) : (rep.messageYear || rep.year || null);

      let meta = {};
      const tmdb = await searchTMDB(
        rep.title, titleYearHint, isSeries, rep.season || null, null,
        rep.imdbId || null, rep.tmdbIdHint || null, yearHints, seasonYearHints
      );
      if (tmdb) Object.assign(meta, tmdb);

      const omdb = await searchOMDB(rep.title, titleYearHint, isSeries, yearHints);
      if (omdb) {
        if (!meta.title) meta.title = omdb.title;
        if (!meta.rating) meta.rating = omdb.rating;
        if (!meta.description) meta.description = omdb.description;
        if (!meta.duration) meta.duration = omdb.duration;
        if (!meta.genre?.length && omdb.genre?.length) meta.genre = omdb.genre;
        if (!meta.imdbId) meta.imdbId = omdb.imdbId;
        if (!meta.poster) meta.poster = omdb.poster;
        else if (omdb.poster && omdb.poster !== meta.poster) meta.posterFallback = omdb.poster;
        if (!meta.type) meta.type = omdb.type;
      }

      const finalTitle = meta.title || rep.title;
      const expectedTypes = isSeries ? { $in: ['series', 'anime'] } : 'movie';
      const escapedTitle = [...finalTitle].map(char =>
        '$^.*+?()[]{}|'.includes(char) || char === String.fromCharCode(92)
          ? String.fromCharCode(92) + char : char
      ).join('');
      const titleRegex = new RegExp('^' + escapedTitle + '$', 'i');
      let existing = meta.tmdbId
        ? await Movie.findOne({ tmdbId: String(meta.tmdbId), type: expectedTypes })
        : null;
      if (!existing) existing = await Movie.findOne({ title: titleRegex, type: expectedTypes });

      const downloads = [];
      for (const item of items) {
        const filename = String(item.filename || '').trim();
        const parsedEpisode = filename ? extractSeasonEpisode(filename) : {};
        const season = item.season ?? parsedEpisode?.season ?? null;
        const episode = item.episode ?? parsedEpisode?.episode ?? null;
        const fileYear = Number(item.fileYear || extractYear([filename])) || null;
        const parsedLanguages = filename ? detectAllLanguages(filename) : [];
        const language = item.language || parsedLanguages.filter(value => value !== 'Multi').join(', ') ||
          (parsedLanguages.includes('Multi') ? 'Multi' : '');
        const size = item.size || (filename ? extractSize(filename) : '') || '';
        const codec = item.codec || (filename ? detectCodec(filename) : '') || 'Other';
        const hdr = item.hdr || (filename ? detectHDR(filename) : '') || null;
        const audio = item.audio || (filename ? extractAudio(filename) : '') || null;
        const audioTracks = Array.isArray(item.audioTracks) && item.audioTracks.length >= 2
          ? item.audioTracks.slice(0, 8) : [];

        for (const link of (item.links || [])) {
          const url = normalizeGdflixUrl(link.url || '');
          if (!url) continue;
          downloads.push({
            quality: item.quality || 'HD',
            size,
            filename,
            fileYear,
            language,
            codec,
            hdr,
            audio,
            audioTracks,
            source: item.source || '',
            container: item.container || '',
            bitDepth: item.bitDepth || '',
            audioChannels: item.audioChannels || '',
            isRepack: !!item.isRepack,
            releaseType: item.releaseType || (item.isRepack ? 'Repack' : 'Original'),
            season,
            episode,
            links: [{ host: detectHost(url), url, isFast: /gdflix\.dev|hubcloud|gdlink/i.test(url) }],
          });
        }
      }

      if (!downloads.length) {
        results.push({ title: finalTitle, action: 'skipped', added: 0, reason: 'No valid links' });
        continue;
      }

      if (existing) {
        const knownUrls = new Set((existing.downloads || []).flatMap(download =>
          (download.links || []).map(link => String(link.url || ''))
        ));
        let added = 0;
        for (const download of downloads) {
          const url = download.links[0]?.url;
          if (!url || knownUrls.has(url)) continue;
          existing.downloads.push(download);
          knownUrls.add(url);
          added++;
        }

        const seasonYears = { ...(existing.seasonYears || {}) };
        for (const download of downloads) {
          if (download.season && download.fileYear && !seasonYears['s' + download.season]) {
            seasonYears['s' + download.season] = download.fileYear;
          }
        }
        if (rep.season && meta.seasonYear) seasonYears['s' + rep.season] = Number(meta.seasonYear);
        existing.seasonYears = seasonYears;
        if (meta.releaseDate && meta.year && meta.tmdbId &&
            String(existing.tmdbId || '') === String(meta.tmdbId)) {
          existing.releaseDate = meta.releaseDate;
          existing.year = meta.year;
        }
        if (finalType === 'anime') existing.type = 'anime';
        if (!existing.tmdbId && meta.tmdbId) existing.tmdbId = String(meta.tmdbId);
        if (!existing.imdbId && meta.imdbId) existing.imdbId = meta.imdbId;
        for (const field of ['poster', 'posterFallback', 'backdrop', 'description', 'rating', 'duration', 'totalSeasons']) {
          if (!existing[field] && meta[field]) existing[field] = meta[field];
        }
        if ((!existing.genre || !existing.genre.length) && meta.genre?.length) existing.genre = meta.genre;
        if (!existing.releaseDate && meta.releaseDate) existing.releaseDate = meta.releaseDate;
        if (!existing.year && meta.year && !isSeries) existing.year = meta.year;

        if (added) {
          recomputeAggregates(existing);
          await existing.save();
        } else {
          await existing.save();
        }
        results.push({ title: existing.title, action: added ? 'updated' : 'skipped', added });
      } else {
        const seasonYears = Object.fromEntries(downloads
          .filter(download => download.season && download.fileYear)
          .map(download => ['s' + download.season, download.fileYear]));
        if (rep.season && meta.seasonYear) seasonYears['s' + rep.season] = Number(meta.seasonYear);
        const document = await Movie.create({
          title: finalTitle,
          tmdbId: meta.tmdbId || '',
          imdbId: meta.imdbId || '',
          type: finalType,
          totalSeasons: meta.totalSeasons || 0,
          description: meta.description || '',
          poster: meta.poster || '',
          posterFallback: meta.posterFallback || '',
          backdrop: meta.backdrop || '',
          releaseDate: meta.releaseDate || '',
          seasonYears,
          rating: meta.rating || 0,
          year: meta.year || rep.messageYear || (isSeries ? null : rep.year || null),
          genre: meta.genre || [],
          duration: meta.duration || '',
          quality: downloads[0].quality,
          language: meta.originalLanguage || rep.language || '',
          formats: [...new Set(downloads.map(download => download.quality))].filter(Boolean),
          codecs: [...new Set(downloads.map(download => download.codec))].filter(codec => codec && codec !== 'Other'),
          languages: [...new Set(downloads.map(download => download.language))].filter(Boolean),
          downloads,
        });
        recomputeAggregates(document);
        await document.save();
        results.push({ title: document.title, action: 'created', id: document._id, added: downloads.length });
      }
    }

    res.json({ message: 'Processed ' + results.length + ' title groups', results });
  } catch (error) {
    res.status(500).json({ message: 'Manual batch import failed: ' + error.message });
  }
});

// ── POST /api/import/normalize-links-batch ──────────────────────────────────
// Safely migrate existing GDFlix/HubCloud links in small resumable batches.
router.post('/normalize-links-batch', auth, async (req, res) => {
  try {
    const batchSize = Math.min(50, Math.max(1, parseInt(req.body?.batchSize, 10) || 15));
    const lastId = req.body?.lastId || null;
    const filter = { downloads: { $exists: true, $ne: [] } };
    const total = await Movie.countDocuments(filter);
    const pageFilter = lastId
      ? { ...filter, _id: { $gt: lastId } }
      : filter;
    const movies = await Movie.find(pageFilter)
      .select('_id downloads')
      .sort({ _id: 1 })
      .limit(batchSize)
      .lean();

    let changedMovies = 0;
    let changedLinks = 0;
    for (const movie of movies) {
      let movieChanged = false;
      for (const download of (movie.downloads || [])) {
        for (const link of (download.links || [])) {
          const oldUrl = String(link.url || '');
          const newUrl = normalizeGdflixUrl(oldUrl);
          let newHost = link.host || 'Download';
          if (/^https?:\/\/(?:[^/]+\.)?gdflix\.dev(?:[/:?#]|$)/i.test(newUrl)) newHost = 'GDFlix';
          else if (/^https?:\/\/(?:[^/]+\.)?hubcloud\.one(?:[/:?#]|$)/i.test(newUrl)) newHost = 'HubCloud';
          if (newUrl !== oldUrl || newHost !== (link.host || 'Download')) {
            link.url = newUrl;
            link.host = newHost;
            if (newHost === 'GDFlix' || newHost === 'HubCloud') link.isFast = true;
            changedLinks++;
            movieChanged = true;
          }
        }
      }
      if (movieChanged) {
        await Movie.updateOne(
          { _id: movie._id },
          { $set: { downloads: movie.downloads } }
        );
        changedMovies++;
      }
      // Yield between records so this migration stays gentle on the database.
      await sleep(35);
    }

    const nextCursor = movies.length ? String(movies[movies.length - 1]._id) : lastId;
    res.json({
      success: true,
      total,
      scanned: movies.length,
      changedMovies,
      changedLinks,
      nextCursor,
      done: movies.length < batchSize
    });
  } catch (err) {
    res.status(500).json({ message: 'Link normalization failed: ' + err.message });
  }
});

module.exports = router;
