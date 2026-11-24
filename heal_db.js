// heal_db.js — v3 ULTRA HEALER
// Fixes: missing posters, descriptions, ratings, languages, dirty titles
// Uses multi-attempt TMDB search with progressive fuzzy fallbacks
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const axios    = require('axios');
const fs       = require('fs');
const path     = require('path');
const Movie    = require('./models/Movie');

// ── Reuse the SAME cleaner as the importer (no duplicates) ───────────────────
const { cleanTitleForApi, stripEmojis } = require('./utils/parser');
const sharedMetadataSearch = require('./utils/tmdbSearch');

const TMDB_KEY = process.env.TMDB_API_KEY || process.env.TMDB_KEY;
const OMDB_KEY = process.env.OMDB_API_KEY || process.env.OMDB_KEY;
const os = require('os');
const REPORT   = path.join(os.tmpdir(), 'healing_report.json');
const DELAY_MS = 260; // stay under TMDB rate limit

const sleep = ms => new Promise(r => setTimeout(r, ms));

// ── Extra junk strip for titles already saved in DB ──────────────────────────
// Handles patterns that sneak through the parser because they're already stored
function deepCleanStoredTitle(t) {
  if (!t) return '';
  return cleanTitleForApi(t)
    // Extra release group / watermark tags
    .replace(/\b(Benzmovies|mj\s*link\s*4u|Friday4KPopcorn|NaMovies|SPiDEY|LRTX|DS4K|iP00L|SPHD|LUMiX|OutKast|BlackSpider|PrimeFix|SKST|DarQ|ZoroSenpai)\b/gi, '')
    .replace(/\b(SS|BD50|LPCM5|LPCM|BDMV|AAC|DDP|H264|H265|x264|x265|10bit|10Bit|IMAX|HDR10\+?|DoVi|CBR|VBR|FLAC|Atmos|DD5|DD2)\b/gi, '')
    // Common regional phrasing adjustments
    .replace(/\bSon\s+Of\b/gi, 'S/o')
    .replace(/\bS\s+o\b/gi, 'S/o')
    // Attached digits to words: "Singam123" -> "Singam"
    .replace(/\b([a-zA-Z]+)\d{2,}\b/g, '$1')
    // Spaced audio: "AAC 2 0", "DDP 5 1", "DD 5 1"
    .replace(/\b(AAC|DDP|DD|AC3|DTS)\s+\d\s+\d\b/gi, '')
    // No-dot codecs: "H264", "H265", "H 264", "H 265"
    .replace(/\bH\s*26[45]\b/gi, '')
    // No-dot quality: "1080P", "720P"
    .replace(/\b\d{3,4}P\b/gi, '')
    // Streaming platforms missed in parser
    .replace(/\b(ManoramaMax|MXPlayer|SonyLIV|SunNXT|EtvWin|AhaVideo|DisneyPlus|JioCinema|Voot|Hoichoi|Aha|Klikk|Plex|Tubi|Peacock|Paramount|Discovery)\b/gi, '')
    // Release groups commonly missed
    .replace(/\b(NaMovies|MKVMovies|BollyFlix|TamilBlasters|TamilYogi|Isaimini|Kuttymovies|1TamilMV|HDHub4u|Filmyzilla|Movierulz|9xmovies|JalshaMoviez|HDMovies|DvdPlay|TamilRockers|Filmywap|Cinemavilla|Tamilgun)\b/gi, '')
    // Standalone episode without S prefix: "E08", "E01", etc
    .replace(/\bE\d{2,3}\b/gi, '')
    // Stray numbers after cleaning (e.g. "2 0", "5 1")
    .replace(/\b\d\s+\d\b/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[\-\s]+$/, '')
    .trim();
}

// ── String similarity (Levenshtein ratio) ────────────────────────────────────
function similarity(a, b) {
  a = a.toLowerCase(); b = b.toLowerCase();
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (!la || !lb) return 0;
  const dp = Array.from({length: la+1}, (_,i) => Array.from({length: lb+1}, (_,j) => i||j ? (i ? j : i) : 0));
  for (let i=1;i<=la;i++) for (let j=1;j<=lb;j++)
    dp[i][j] = a[i-1]===b[j-1] ? dp[i-1][j-1] : 1+Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return 1 - dp[la][lb] / Math.max(la, lb);
}

const TMDB_LANG = {
  te: 'Telugu', ta: 'Tamil', hi: 'Hindi', ml: 'Malayalam', kn: 'Kannada',
  bn: 'Bengali', en: 'English', ja: 'Japanese', ko: 'Korean', mr: 'Marathi', pa: 'Punjabi'
};

// ── TMDB multi-attempt search ────────────────────────────────────────────────
// rawTitle = stored movie.title, isSeries = bool, year = stored movie.year
// imdbId  = optional IMDB tt-id (e.g. tt1234567) already on the record
// knownTmdbId = numeric TMDB id already on the record (e.g. from a previous partial heal)
async function fetchTMDB(rawTitle, isSeries, year, imdbId = null, knownTmdbId = null) {
  if (!TMDB_KEY) return null;
  const base = 'https://api.themoviedb.org/3';

  // Shared latest title engine first: direct TMDB/IMDb IDs, all candidate
  // algorithms, confidence scoring and relaxed search. Preserve the healer's
  // richer season-list shape and keep the older fuzzy cascade as a fallback.
  try {
    const shared = await sharedMetadataSearch.searchTMDB(
      rawTitle, year, isSeries, null, null, imdbId, knownTmdbId,
      { tmdbKey: TMDB_KEY, emitter: (line) => console.log(`[HEAL] ${line}`) }
    );
    if (shared) {
      const genres = (shared.genre || []).map((g) => String(g || '').toLowerCase());
      const originalLanguage = String(shared.originalLanguage || '').toLowerCase();
      const isAnime = shared.type === 'series' &&
        (/(japanese|ja|korean|ko|chinese|zh)/.test(originalLanguage) &&
          genres.some((g) => /animation|anime/.test(g)));
      const meta = {
        ...shared,
        tmdbTitle: shared.title || rawTitle,
        actualType: isAnime ? 'anime' : shared.type === 'series' ? 'tv' : 'movie',
        seasons: [],
      };

      if (shared.type === 'series' && shared.tmdbId) {
        try {
          const details = await axios.get(`${base}/tv/${shared.tmdbId}`, {
            params: { api_key: TMDB_KEY }, timeout: 8000
          });
          meta.seasons = details.data?.seasons || [];
          meta.totalSeasons = details.data?.number_of_seasons || meta.totalSeasons || 0;
        } catch (_) {}
      }
      return meta;
    }
  } catch (error) {
    console.log(`[HEAL] [WARN] Shared metadata lookup failed; using legacy healer fallback: ${error.message}`);
  }
  let fastPathFallback = null;

  // ── FAST PATH 1: we already know the TMDB ID (re-heal run) ─────────────────
  if (knownTmdbId && String(knownTmdbId).trim() !== '' && String(knownTmdbId) !== '0' && String(knownTmdbId) !== 'null') {
    for (const mtype of (isSeries ? ['tv', 'movie'] : ['movie', 'tv'])) {
      try {
        const r = await axios.get(`${base}/${mtype}/${knownTmdbId}`, {
          params: { api_key: TMDB_KEY }, timeout: 8000
        });
        if (r.data && (r.data.title || r.data.name)) {
          const d = r.data;
          console.log(`[HEAL] [OK] Known TMDB ID ${knownTmdbId} → "${d.title || d.name}"`);
          const result = buildResult(d, mtype === 'tv');

          // If TMDB has no poster, try images endpoint as fallback
          if (!result.poster) {
            try {
              const imgRes = await axios.get(`${base}/${mtype}/${knownTmdbId}/images`, {
                params: { api_key: TMDB_KEY, include_image_language: 'en,null' }, timeout: 6000
              });
              const posters = imgRes.data?.posters || [];
              if (posters.length > 0) {
                result.poster = `https://image.tmdb.org/t/p/w500${posters[0].file_path}`;
                console.log(`[HEAL] [IMG] Found poster via images endpoint for "${d.title || d.name}"`);
              }
            } catch (_) {}
          }

          // If still no description/poster, try OMDB with TMDB canonical title
          if (!result.poster || !result.description) {
            const canonicalTitle = d.title || d.name || '';
            if (canonicalTitle) {
              try {
                const releaseYear = d.release_date?.substring(0,4) || d.first_air_date?.substring(0,4);
                let found = false;
                for (const type of ['movie','series']) {
                  for (const y of [releaseYear, null]) {
                    try {
                      const params = { apikey: OMDB_KEY, t: canonicalTitle, type };
                      if (y) params.y = y;
                      const omdbR = await axios.get('https://www.omdbapi.com/', { params, timeout: 6000 });
                      const od = omdbR.data;
                      if (od && od.Response !== 'False') {
                        if (!result.poster && od.Poster && od.Poster !== 'N/A') {
                          result.poster = od.Poster;
                          console.log(`[HEAL] [IMG] OMDB poster for "${canonicalTitle}"`);
                        }
                        if (!result.description && od.Plot && od.Plot !== 'N/A') {
                          result.description = od.Plot;
                        }
                        if (!result.rating && od.imdbRating && od.imdbRating !== 'N/A') {
                          result.rating = parseFloat(od.imdbRating);
                        }
                        if (!result.genre?.length && od.Genre) {
                          result.genre = od.Genre.split(', ');
                        }
                        found = true;
                        break;
                      }
                    } catch (_) {}
                  }
                  if (found) break;
                }
              } catch (_) {}
            }
          }
          if (result.poster && result.description && result.rating) {
            return result; // Perfect, use it immediately
          } else {
            console.log(`[HEAL] [WARN] Known ID ${knownTmdbId} has missing data, trying fuzzy year search fallback...`);
            fastPathFallback = result;
          }
        }
      } catch (e) {
        if (e.code === 'ECONNRESET' || e.code === 'ECONNREFUSED' || e.code === 'ETIMEDOUT') {
          console.log(`[HEAL] [WARN] TMDB network error for ID ${knownTmdbId}: ${e.code}`);
        }
      }
    }
  }

  // ── FAST PATH 2: resolve IMDB ID → TMDB via /find ─────────────────────────
  if (imdbId && /^tt\d{7,}$/.test(imdbId)) {
    try {
      const findRes = await axios.get(`${base}/find/${imdbId}`, {
        params: { api_key: TMDB_KEY, external_source: 'imdb_id' }, timeout: 8000
      });
      const movies = findRes.data?.movie_results || [];
      const tvs    = findRes.data?.tv_results    || [];
      const hit = movies[0] || tvs[0];
      const mtype = movies[0] ? 'movie' : 'tv';
      if (hit) {
        const r = await axios.get(`${base}/${mtype}/${hit.id}`, {
          params: { api_key: TMDB_KEY }, timeout: 8000
        });
        if (r.data && (r.data.title || r.data.name)) {
          console.log(`[HEAL] [OK] IMDB ID ${imdbId} → "${r.data.title || r.data.name}"`);
          return buildResult(r.data, mtype === 'tv');
        }
      }
    } catch (_) {}
    await sleep(DELAY_MS);
  }

  // ── Helper to build result from TMDB detail response ──────────────────────
  function buildResult(d, isTvResult) {
    // Determine if this is anime: TMDB TV + Japanese original language
    const isAnime = isTvResult && (d.original_language === 'ja' ||
      (d.genres || []).some(g => g.name === 'Animation' && d.origin_country?.includes?.('JP')));
    const resolvedType = isAnime ? 'anime' : (isTvResult ? 'tv' : 'movie');
    return {
      tmdbId:           String(d.id),
      description:      d.overview || '',
      poster:           d.poster_path   ? `https://image.tmdb.org/t/p/w500${d.poster_path}`   : '',
      backdrop:         d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
      rating:           Math.round((d.vote_average || 0) * 10) / 10,
      genre:            (d.genres || []).map(g => g.name),
      runtime:          d.runtime || d.episode_run_time?.[0] || 0,
      tmdbTitle:        d.title || d.name || '',
      originalLanguage: TMDB_LANG[d.original_language] || '',
      sim:              1.0,
      actualType:       resolvedType,
      totalSeasons:     d.number_of_seasons || 0,
      seasons:          d.seasons || [],   // raw TMDB season list (has poster_path per season)
    };
  }

  // ── FUZZY SEARCH FALLBACK ──────────────────────────────────────────────────
  // Extract 4-digit release year if present in raw string
  let searchYear = year;
  const ym = rawTitle.match(/\b(19\d{2}|20[0-2]\d)\b/);
  if (ym) searchYear = parseInt(ym[1], 10);

  // Build clean search queries (strip year, junk, keep just the real title)
  const clean1 = deepCleanStoredTitle(rawTitle).replace(/\b(19\d{2}|20[0-2]\d)\b/g, '').replace(/\s+/g, ' ').trim();
  const words  = clean1.split(' ').filter(w => w.length > 1);
  const mainPart = clean1.split(/[:\-–]/)[0].trim();         // Main title before colon/dash
  const clean4 = words.slice(0, 4).join(' ');
  const clean3 = words.slice(0, 3).join(' ');
  const clean2 = words.slice(0, 2).join(' ');

  // Deduplicate attempts
  const seen = new Set();

  // ── Short/acronym query guard ─────────────────────────────────────────────
  // Queries shorter than 4 visible chars (e.g. "GDN", "G D N") produce
  // catastrophic fuzzy matches (e.g. "G.D.N" → "Marvel's Hulk"). Skip them.
  const visibleLen = clean1.replace(/\s/g, '').length;
  if (visibleLen < 4) {
    console.log(`[HEAL] [WARN]  Query "${clean1}" is too short for reliable fuzzy match — skipping fuzzy search`);
    return fastPathFallback || null;
  }

  const attempts = [
    { q: clean1,    y: searchYear },   // Full clean + year
    { q: mainPart,  y: searchYear },   // Main part + year
    { q: clean1,    y: null },         // Full clean, no year
    { q: mainPart,  y: null },         // Main part, no year
    { q: clean4,    y: searchYear },   // 4 words + year
    { q: clean4,    y: null },         // 4 words, no year
    { q: clean3,    y: null },         // 3 words
    { q: clean2,    y: null },         // 2 words
    // NOTE: single-word fallback intentionally removed — too many false positives
  ].filter(a => {
    if (!a.q || a.q.length < 3) return false;
    const key = `${a.q}|${a.y}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  for (const attempt of attempts) {
    try {
      // Pass year directly to TMDB — dramatically improves accuracy
      const params = { api_key: TMDB_KEY, query: attempt.q };
      if (attempt.y) {
        params.year = attempt.y;                     // for movies
        params.first_air_date_year = attempt.y;     // for TV
      }
      console.log(`[HEAL] [SEARCH] TMDB search: "${attempt.q}"${attempt.y ? ' ('+attempt.y+')' : ''}`);
      const res = await axios.get(`${base}/search/multi`, { params, timeout: 10000 });
      let results = (res.data?.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      if (!results.length) { await sleep(DELAY_MS); continue; }

      // Score: similarity against BOTH clean title variants + year proximity + popularity
      const cleanLower   = clean1.toLowerCase();
      const mainLower    = mainPart.toLowerCase();
      const queryLower   = attempt.q.toLowerCase();

      const scored = results.map(d => {
        const titleKey = d.media_type === 'tv' ? 'name' : 'title';
        const dtitle   = (d[titleKey] || d.name || '').toLowerCase();
        // Best sim across all variants
        const sim = Math.max(
          similarity(dtitle, cleanLower),
          similarity(dtitle, mainLower),
          similarity(dtitle, queryLower)
        );
        const dYear  = parseInt((d.release_date || d.first_air_date || '0').slice(0, 4)) || 0;
        const yearDiff = (searchYear && dYear) ? Math.abs(dYear - searchYear) : 5;
        // Boost score: exact year match = +0.15, 1yr off = +0.08
        const yearBoost = yearDiff === 0 ? 0.15 : yearDiff === 1 ? 0.08 : yearDiff <= 2 ? 0.03 : 0;
        // Popularity tiebreaker (normalized, capped)
        const popBoost = Math.min((d.popularity || 0) / 200, 0.05);
        return { d, sim: sim + yearBoost + popBoost, rawSim: sim, yearDiff };
      });

      const best = scored.sort((a, b) => b.sim - a.sim)[0];
      if (best) {
        // Hard year-gap guards (tiered) — prevent totally wrong-era matches
        if (best.yearDiff > 10) {
          console.log(`[HEAL] [ERR] Year gap HUGE (${best.yearDiff}yr) — hard reject "${best.d.title||best.d.name}" ← "${attempt.q}"`);
        } else if (searchYear && best.yearDiff > 5 && best.rawSim < 0.85) {
          console.log(`[HEAL] [ERR] Year gap too large (${best.yearDiff}yr) + sim too low (${best.rawSim.toFixed(2)}) for "${best.d.title||best.d.name}" ← "${attempt.q}"`);
        } else if (best.rawSim >= 0.45) {
          console.log(`[HEAL] [OK] Best match: "${best.d.title||best.d.name}" sim=${best.rawSim.toFixed(2)} yearDiff=${best.yearDiff}`);
          const r2 = await axios.get(`${base}/${best.d.media_type}/${best.d.id}`, {
            params: { api_key: TMDB_KEY },
            timeout: 8000
          });
          return buildResult(r2.data, best.d.media_type === 'tv');
        } else {
          console.log(`[HEAL] [ERR] Low sim=${best.rawSim.toFixed(2)} (need ≥0.45) for "${best.d.title||best.d.name}" ← searched "${attempt.q}"`);
        }
      } else {
        console.log(`[HEAL] [EMPTY] No results scored for "${attempt.q}"`);
      }
    } catch (e) {
      if (e.code === 'ECONNRESET' || e.code === 'ETIMEDOUT') {
        console.log(`[HEAL] [WARN] Network error during search: ${e.code}`);
      } else if (e.response?.status === 429) {
        await sleep(3000);
      }
    }
    await sleep(DELAY_MS);
  }
  return fastPathFallback || null;
}


// ── OMDB fallback (http:// required for free tier) ───────────────────────────
async function fetchOMDB(rawTitle, year, isSeries = false) {
  // Prefer the shared OMDb/IMDb lookup used by imports; retain the legacy multi-type fallback below.
  try {
    const shared = await sharedMetadataSearch.searchOMDB(rawTitle, year, !!isSeries, OMDB_KEY);
    if (shared) return { ...shared, tmdbId: null, tmdbTitle: shared.title || '' };
  } catch (error) {
    console.log(`[HEAL] [WARN] Shared OMDb lookup failed; using legacy fallback: ${error.message}`);
  }
  if (!OMDB_KEY) return null;
  const clean = deepCleanStoredTitle(rawTitle);
  if (!clean || clean.length < 2) return null;

  const makeResult = d => ({
    tmdbId:      null,
    description: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
    poster:      d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
    backdrop:    '',
    rating:      d.imdbRating && d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
    genre:       d.Genre ? d.Genre.split(', ') : [],
    runtime:     d.Runtime ? parseInt(d.Runtime) : 0,
    tmdbTitle:   d.Title || '',
  });

  // Try movie + series, with year then without
  for (const type of ['movie', 'series']) {
    for (const y of [year, null]) {
      try {
        const params = { apikey: OMDB_KEY, t: clean, type };
        if (y) params.y = y;
        const res = await axios.get('http://www.omdbapi.com/', { params, timeout: 8000 });
        const d = res.data;
        if (d && d.Response !== 'False') return makeResult(d);
      } catch (_) {}
    }
  }
  return null;
}

// ── Language fallback from downloads ────────────────────────────────────────
function inferLanguageFromDownloads(movie) {
  const LANG_NORM = {
    tel:'Telugu', telugu:'Telugu', tam:'Tamil', tamil:'Tamil',
    hin:'Hindi', hindi:'Hindi', mal:'Malayalam', malayalam:'Malayalam',
    kan:'Kannada', kannada:'Kannada', ben:'Bengali', bengali:'Bengali',
    eng:'English', english:'English', mar:'Marathi', marathi:'Marathi',
    jpn:'Japanese', japanese:'Japanese', kor:'Korean', korean:'Korean',
  };
  for (const dl of (movie.downloads||[])) {
    if (dl.language && dl.language !== 'Unknown') {
      const key = dl.language.toLowerCase().trim();
      return LANG_NORM[key] || dl.language;
    }
  }
  return '';
}

// ── MongoDB reconnect helper ─────────────────────────────────────────────────
async function ensureConnected() {
  if (mongoose.connection.readyState === 1) return; // already connected
  console.log('[DB] Reconnecting to MongoDB Atlas...');
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop', {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS:          60000,
    heartbeatFrequencyMS:     10000,
    retryWrites:              true,
  });
  console.log('[DB] Reconnected [OK]');
}

// ── Main healer ──────────────────────────────────────────────────────────────
async function healDatabase() {
  await ensureConnected();
  console.log('[HEALTH] Healer connected\n');
  console.log('[SEARCH] Scanning for items needing repair...\n');

  // Skip movies that have been attempted and genuinely can't be healed
  const broken = await Movie.find({
    _healAttempted: { $ne: true },
    $or: [
      { poster:      { $in: ['', null] } },
      { description: { $in: ['', null] } },
      { tmdbId:      { $in: ['', null] } },
      { language:    { $in: ['', null, 'Unknown'] } },
      { rating:      { $in: [0, null] } },
    ]
  }).lean();

  if (!broken.length) {
    console.log('[OK] Database perfectly healthy!');
    return process.exit(0);
  }

  console.log(`[FIX] ${broken.length} items need healing\n`);

  let fixed = 0, failed = 0;
  const report = [];

  for (const raw of broken) {
    const movie = raw; // Use lean doc; we'll update via findByIdAndUpdate

    const isSeries = movie.type === 'series' || movie.type === 'anime';
    const changes  = [];

    // ── Step 0: Purge junk records ──────────────────────────────────────────
    const JUNK_TITLE_RE = /^(E\d+|H265|H264|HDR10|DoVi|High Bitrate|BLUMRAY|CBR|VBR|Version Rip|Audio|Video|DUB CATALOG|TELUGU PACK|5TB DUMP|LOWER BITRATES|# #)$/i;
    if (JUNK_TITLE_RE.test(movie.title) || /Upload cheyyandi bro/i.test(movie.title)) {
      console.log(`[DEL] Deleting junk record: "${movie.title}"`);
      await Movie.findByIdAndDelete(movie._id);
      continue;
    }

    // ── Step 1: Clean the stored title itself (skip if tmdbId already known — fast path gives canonical) ──
    const cleanedStoredTitle = deepCleanStoredTitle(movie.title || '');
    if (!movie.tmdbId && cleanedStoredTitle && cleanedStoredTitle !== movie.title && cleanedStoredTitle.length >= 2) {
      console.log(`[TITLE] Cleaning title: "${movie.title}" → "${cleanedStoredTitle}"`);
      movie.title = cleanedStoredTitle;
      changes.push('title_cleaned');
    }

    const searchTitle = movie.title || raw.title || '';

    // ── Step 2: TMDB search + OMDB supplement ───────────────────────────────
    let meta = null;
    const needsHeal = !movie.poster || !movie.description || !movie.tmdbId || !movie.rating || !movie.language || movie.language === 'Unknown';
    if (needsHeal) {
      meta = await fetchTMDB(
        searchTitle,
        isSeries,
        movie.year,
        movie.imdbId || null,
        movie.tmdbId || null
      );

      // Always try OMDB as supplement — fills gaps TMDB leaves empty (e.g. small regional films)
      const omdbMeta = await fetchOMDB(searchTitle, movie.year, isSeries);
      if (omdbMeta) {
        if (!meta) {
          meta = omdbMeta;
        } else {
          if (!meta.poster      && omdbMeta.poster)          meta.poster      = omdbMeta.poster;
          if (!meta.description && omdbMeta.description)     meta.description = omdbMeta.description;
          if (!meta.rating      && omdbMeta.rating)          meta.rating      = omdbMeta.rating;
          if (!meta.genre?.length && omdbMeta.genre?.length) meta.genre       = omdbMeta.genre;
        }
      }
    }


    if (meta) {
      if (!movie.poster      && meta.poster)      { movie.poster      = meta.poster;      changes.push('poster'); }
      if (!movie.backdrop    && meta.backdrop)     { movie.backdrop    = meta.backdrop;    changes.push('backdrop'); }
      if (!movie.description && meta.description)  { movie.description = meta.description; changes.push('description'); }
      if ((!movie.rating || movie.rating === 0) && meta.rating) { movie.rating = meta.rating; changes.push('rating'); }
      if (!movie.tmdbId      && meta.tmdbId)       { movie.tmdbId      = meta.tmdbId;      changes.push('tmdbId'); }
      if (!movie.genre?.length && meta.genre?.length) { movie.genre = meta.genre; changes.push('genre'); }
      if ((!movie.language || movie.language === 'Unknown') && meta.originalLanguage) {
        movie.language = meta.originalLanguage;
        changes.push('language');
      }

      // ── Fix type: trust TMDB's answer over the importer's guess ──────────
      if (meta.actualType) {
        // Map TMDB 'tv' → 'series' unless it's anime
        const correctType = meta.actualType === 'anime' ? 'anime'
                          : meta.actualType === 'tv'    ? 'series'
                          : 'movie';
        if (movie.type !== correctType) {
          console.log(`[TAG]  Type corrected: "${movie.title}" ${movie.type} → ${correctType}`);
          movie.type = correctType;
          changes.push('type');
        }
      }

      // ── Season count + sub-posters for series ─────────────────────────────
      const isNowSeries = movie.type === 'series' || movie.type === 'anime';
      if (isNowSeries && meta.tmdbId && meta.totalSeasons > 0) {
        if (!movie.totalSeasons || movie.totalSeasons !== meta.totalSeasons) {
          movie.totalSeasons = meta.totalSeasons;
          changes.push('totalSeasons');
        }
        // Build season poster map from TMDB season list (skip season 0 = specials)
        const seasonPosters = {};
        (meta.seasons || []).forEach(s => {
          if (s.season_number > 0 && s.poster_path) {
            seasonPosters[`s${s.season_number}`] = `https://image.tmdb.org/t/p/w500${s.poster_path}`;
          }
        });
        if (Object.keys(seasonPosters).length > 0) {
          movie.seasonPosters = seasonPosters;
          changes.push('seasonPosters');
          // Use Season 1 poster if the main poster is missing
          if (!movie.poster && seasonPosters['s1']) {
            movie.poster = seasonPosters['s1'];
            if (!changes.includes('poster')) changes.push('poster');
          }
        }
      }

      // ── Canonical title update — ONLY if TMDB title is actually similar to stored title ──
      // Bug fix: meta.sim is always 1.0 for fast-path (buildResult hardcodes it),
      // so we MUST independently verify the returned title matches what we have stored.
      if (meta.tmdbTitle && meta.tmdbTitle !== movie.title) {
        const storedClean = deepCleanStoredTitle(movie.title || '').toLowerCase();
        const tmdbClean   = meta.tmdbTitle.toLowerCase();
        const titleMatchSim = similarity(storedClean, tmdbClean);
        if (titleMatchSim >= 0.55) {
          // Similar enough — safe canonical rename (e.g. case fix, punctuation)
          console.log(`[TITLE] Updating title to TMDB canonical: "${movie.title}" → "${meta.tmdbTitle}" (sim=${titleMatchSim.toFixed(2)})`);
          movie.title = meta.tmdbTitle;
          changes.push('title_canonical');
        } else {
          // Very different title returned — stored tmdbId is probably corrupt/wrong
          // Clear it so the next heal run does a fresh search instead of trusting bad ID
          console.log(`[WARN]  TMDB returned different movie "${meta.tmdbTitle}" (sim=${titleMatchSim.toFixed(2)}) for stored "${movie.title}" — clearing bad tmdbId`);
          await Movie.findByIdAndUpdate(raw._id, { $unset: { tmdbId: '' } });
          // Don't apply any of the fetched meta — it's for the wrong movie
          continue;
        }
      }
    }

    // ── Step 3: Language fallback ───────────────────────────────────────────
    if (!movie.language || movie.language === 'Unknown') {
      const lang = inferLanguageFromDownloads(movie);
      if (lang) { movie.language = lang; changes.push('language'); }
    }

    // ── Save via findByIdAndUpdate — no version conflicts ──────────────────
    if (changes.length > 0) {
      const updateFields = {};
      if (changes.includes('title_cleaned') || changes.includes('title_canonical')) updateFields.title = movie.title;
      if (changes.includes('poster'))         updateFields.poster        = movie.poster;
      if (changes.includes('backdrop'))       updateFields.backdrop      = movie.backdrop;
      if (changes.includes('description'))    updateFields.description   = movie.description;
      if (changes.includes('rating'))         updateFields.rating        = movie.rating;
      if (changes.includes('genre'))          updateFields.genre         = movie.genre;
      if (changes.includes('language'))       updateFields.language      = movie.language;
      if (changes.includes('type'))           updateFields.type          = movie.type;
      if (changes.includes('totalSeasons'))   updateFields.totalSeasons  = movie.totalSeasons;
      if (changes.includes('seasonPosters'))  updateFields.seasonPosters = movie.seasonPosters;

      // ── Always sync tmdbId — replace corrupt stored ID with the one fuzzy actually found ─
      if (meta?.tmdbId && meta.tmdbId !== String(movie.tmdbId || '')) {
        console.log(`[LINK] Correcting tmdbId: ${movie.tmdbId || '(none)'} → ${meta.tmdbId} for "${movie.title}"`);
        updateFields.tmdbId = meta.tmdbId;
      } else if (changes.includes('tmdbId')) {
        updateFields.tmdbId = movie.tmdbId;
      }

      // Mark as healed so it won’t be re-processed on next run
      updateFields._healAttempted = true;

      await Movie.findByIdAndUpdate(raw._id, { $set: updateFields });
      fixed++;
      console.log(`[PATCH] Healed [${movie.title}]: ${changes.join(', ')}`);
      report.push({ title: movie.title, fixed: changes, tmdbMatch: meta?.tmdbTitle || null, sim: meta?.sim || null });
    } else if (meta) {
      // We found the TMDB record, but it has no NEW data to give us (e.g., rating is still 0 on TMDB)
      console.log(`[OK] [${movie.title}] is already fully healed (TMDB itself is missing the rating/poster). Skipping.`);
      report.push({ title: movie.title, fixed: ['None'], reason: 'No new data on TMDB' });
      await Movie.findByIdAndUpdate(raw._id, { $set: { _healAttempted: true } });
    } else {
      failed++;
      console.log(`[ERR] Could not heal [${movie.title}] - No match found anywhere.`);
      report.push({ title: movie.title, fixed: ['None'], reason: 'No TMDB/OMDB match' });
      await Movie.findByIdAndUpdate(raw._id, { $set: { _healAttempted: true } });
    }

    await sleep(DELAY_MS);

    // ── Mid-run reconnect: Atlas sometimes drops idle connections ─────────────
    if (mongoose.connection.readyState !== 1) {
      console.log('[DB] Connection lost mid-run — reconnecting...');
      try { await ensureConnected(); }
      catch (e) { console.error('[DB] Reconnect failed:', e.message); await sleep(5000); }
    }
  }

  fs.writeFileSync(REPORT, JSON.stringify(report, null, 2));
  console.log(`\n[DONE] Healing complete: ${fixed} fixed, ${failed} failed`);
  console.log(`[FILE] Report saved to healing_report.json`);
  process.exit(0);
}

healDatabase().catch(err => { console.error('Fatal:', err); process.exit(1); });
