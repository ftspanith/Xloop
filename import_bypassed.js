// ═══════════════════════════════════════════════════════════════════════════
// import_bypassed.js
// Reads bypassed_links.json and intelligently upserts each link into MongoDB.
//
// Features:
//  - Uses utils/parser.js for clean metadata
//  - Fetches TMDB with short-title fallback strategy
//  - Season-specific poster fetching for TV series
//  - Smart deduplication by tmdbId → title → fuzzy
//
// Run: node import_bypassed.js
// ═══════════════════════════════════════════════════════════════════════════

'use strict';

require('dotenv').config();
const mongoose = require('mongoose');
const fs       = require('fs');
const axios    = require('axios');
const Movie    = require('./models/Movie');
const { cleanTitleForApi, detectHost, isJunkTitle } = require('./utils/parser');

const BYPASSED_FILE = './bypassed_links.json';
const TMDB_KEY      = process.env.TMDB_API_KEY || '';
const OMDB_KEY      = process.env.OMDB_API_KEY  || '';

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── DB retry wrapper: retries on transient MongoDB network errors ──────────────
async function dbRetry(fn, retries = 3) {
  for (let i = 0; i <= retries; i++) {
    try { return await fn(); }
    catch (e) {
      const isNetwork = /MongoNetwork|MongoServerSelection|ECONNRESET|ETIMEDOUT|ECONNREFUSED|topology/i.test(e.message||'');
      if (isNetwork && i < retries) {
        console.warn(`  ⚠️  DB error (attempt ${i+1}/${retries}): ${e.message.slice(0,60)} — retrying...`);
        await sleep(3000 * (i + 1));
        continue;
      }
      throw e;
    }
  }
}

// ── Global API throttle: max 1 call per 260ms (TMDB limit = 40 req/10s) ────────
// All TMDB + OMDB calls go through this so concurrent groups can't burst.
let _lastApiCall = 0;
const API_GAP_MS = 260; // 260ms between any API call
async function apiThrottle() {
  const now  = Date.now();
  const wait = API_GAP_MS - (now - _lastApiCall);
  if (wait > 0) await sleep(wait);
  _lastApiCall = Date.now();
}

// ── Fetch with retry on 429 (rate-limit) and transient errors ──────────────────
async function fetchWithRetry(fn, retries = 3) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await apiThrottle();
      return await fn();
    } catch (err) {
      const status = err?.response?.status;
      if (status === 429) {
        // Rate limited — back off 10 seconds before retry
        const retryAfter = parseInt(err.response?.headers?.['retry-after'] || '10', 10);
        console.log(`⏳ API rate limited (429). Waiting ${retryAfter}s before retry ${attempt + 1}/${retries}...`);
        await sleep(retryAfter * 1000);
        continue;
      }
      if (attempt < retries && (!status || status >= 500)) {
        await sleep(1000 * (attempt + 1)); // exponential back-off for 5xx/network errors
        continue;
      }
      return null; // Give up, don't crash the pipeline
    }
  }
  return null;
}

// ── Per-document mutex to prevent concurrent VersionError on same _id ─────────
const docLocks = new Map();
async function withDocLock(id, fn) {
  const key = String(id);
  while (docLocks.has(key)) { await docLocks.get(key); }
  let resolve;
  const lock = new Promise(r => { resolve = r; });
  docLocks.set(key, lock);
  try { return await fn(); } finally { docLocks.delete(key); resolve(); }
}

// ── Save with optimistic retry on VersionError ────────────────────────────────

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0))
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

function stringSimilarity(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1;
  const longer  = a.length > b.length ? a : b;
  const shorter = a.length > b.length ? b : a;
  if (!longer.length) return 1;
  return (longer.length - levenshtein(longer, shorter)) / longer.length;
}

function detectCodec(filename) {
  const str = (filename || '').toLowerCase();
  if (/\bav1\b/i.test(str)) return 'AV1';
  if (/hevc|h\.265|x265/i.test(str)) return 'HEVC';
  return 'Other';
}

function toMB(s) {
  if (!s) return 0;
  const n = parseFloat(s);
  return /GB/i.test(s) ? n * 1024 : (n || 0);
}

// ─── TMDB SEARCH ─────────────────────────────────────────────────────────────
// Priority:
//   0. DIRECT: TMDB ID or IMDB ID in message → instant exact match (no fuzzy)
//   1. Type-specific endpoint + exact year
//   2. Type-specific endpoint + year±1
//   3. Multi-search fallback
//   4. Opposite type as last resort
async function searchTMDB(title, year, isSeries, season, msgDate, imdbId, tmdbIdHint) {
  if (!TMDB_KEY) return null;

  const cleanTitle = cleanTitleForApi(title);
  if (!cleanTitle || cleanTitle.length < 2) return null;

  const BASE = 'https://api.themoviedb.org/3';
  const langMap = {
    'en':'English','te':'Telugu','ta':'Tamil','hi':'Hindi','ml':'Malayalam',
    'kn':'Kannada','ja':'Japanese','ko':'Korean','fr':'French','es':'Spanish',
    'de':'German','it':'Italian','zh':'Chinese','ru':'Russian','pt':'Portuguese',
    'ar':'Arabic','tr':'Turkish','id':'Indonesian','th':'Thai','bn':'Bengali',
  };

  function buildResult(d, isTv, extraSeasonData) {
    const { seasonPoster = '', seasonOverview = '' } = extraSeasonData || {};
    return {
      tmdbId:          String(d.id),
      type:            isTv ? 'series' : 'movie',
      totalSeasons:    d.number_of_seasons || 0,
      title:           d.title || d.name || title,
      description:     seasonOverview || d.overview || '',
      poster:          seasonPoster || (d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : ''),
      backdrop:        d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
      rating:          Math.round((d.vote_average || 0) * 10) / 10,
      year:            d.release_date ? parseInt(d.release_date, 10)
                     : d.first_air_date ? parseInt(d.first_air_date, 10) : year,
      releaseDate:     d.release_date || d.first_air_date || '',
      genre:           (d.genres || []).map(g => g.name),
      duration:        d.runtime
        ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
        : (d.episode_run_time?.[0] ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m` : ''),
      originalLanguage: langMap[d.original_language] || d.original_language || '',
      confidence:      100,
    };
  }

  async function fetchSeasonData(tmdbId, seasonNum, isTv) {
    if (!isTv || !seasonNum) return {};
    const sr = await fetchWithRetry(() =>
      axios.get(`${BASE}/tv/${tmdbId}/season/${seasonNum}`, { params: { api_key: TMDB_KEY }, timeout: 8000 })
    );
    return {
      seasonPoster:   sr?.data?.poster_path ? `https://image.tmdb.org/t/p/w500${sr.data.poster_path}` : '',
      seasonOverview: sr?.data?.overview || '',
    };
  }

  // ── FAST PATH 0A: Direct TMDB ID ─────────────────────────────────────────
  if (tmdbIdHint) {
    for (const mtype of (isSeries ? ['tv','movie'] : ['movie','tv'])) {
      const r = await fetchWithRetry(() =>
        axios.get(`${BASE}/${mtype}/${tmdbIdHint}`, { params: { api_key: TMDB_KEY }, timeout: 8000 })
      );
      if (r?.data && (r.data.title || r.data.name)) {
        const isTv = mtype === 'tv';
        const sd = await fetchSeasonData(r.data.id, season, isTv);
        console.log(`[TMDB] ✅ Direct TMDB ID ${tmdbIdHint} → "${r.data.title || r.data.name}"`);
        return buildResult(r.data, isTv, sd);
      }
    }
  }

  // ── FAST PATH 0B: IMDB ID → /find → TMDB ───────────────────────────────
  if (imdbId && /^tt\d{7,}$/.test(imdbId)) {
    const findRes = await fetchWithRetry(() =>
      axios.get(`${BASE}/find/${imdbId}`, {
        params: { api_key: TMDB_KEY, external_source: 'imdb_id' }, timeout: 8000
      })
    );
    if (findRes) {
      const movies = findRes.data?.movie_results || [];
      const tvs    = findRes.data?.tv_results    || [];
      const hit    = movies[0] || tvs[0];
      const mtype  = movies[0] ? 'movie' : 'tv';
      if (hit) {
        const r = await fetchWithRetry(() =>
          axios.get(`${BASE}/${mtype}/${hit.id}`, { params: { api_key: TMDB_KEY }, timeout: 8000 })
        );
        if (r?.data && (r.data.title || r.data.name)) {
          const isTv = mtype === 'tv';
          const sd = await fetchSeasonData(r.data.id, season, isTv);
          console.log(`[TMDB] ✅ IMDB ${imdbId} → "${r.data.title || r.data.name}"`);
          return buildResult(r.data, isTv, sd);
        }
      }
    }
  }


  const postYear = msgDate ? new Date(msgDate).getFullYear() : null;
  const hintYear = year || postYear;
  const isShort = cleanTitle.trim().split(/\s+/).length <= 2;

  const titleVariants = cleanTitle.split(/\s+aka\s+|\s+a\.k\.a\.?\s+|\s*\(\s*(?:aka\s+)?/i).map(t => t.replace(/\)+$/, '').trim()).filter(Boolean);
  if (!titleVariants.length) titleVariants.push(cleanTitle);

  // Build ordered search strategies
  const strategies = [];
  const typeEndpoint = isSeries ? 'tv' : 'movie';
  const otherEndpoint = isSeries ? 'movie' : 'tv';

  for (const t of titleVariants) {
    if (hintYear) {
      strategies.push({ endpoint: typeEndpoint, params: { query: t, year: hintYear } });
      strategies.push({ endpoint: typeEndpoint, params: { query: t, year: hintYear - 1 } });
      strategies.push({ endpoint: typeEndpoint, params: { query: t, year: hintYear + 1 } });
    }
    strategies.push({ endpoint: typeEndpoint, params: { query: t } });
  }

  for (const t of titleVariants) {
    if (hintYear) strategies.push({ endpoint: 'multi', params: { query: t, year: hintYear } });
    strategies.push({ endpoint: 'multi', params: { query: t } });
  }

  for (const t of titleVariants) {
    if (hintYear) strategies.push({ endpoint: otherEndpoint, params: { query: t, year: hintYear } });
    strategies.push({ endpoint: otherEndpoint, params: { query: t } });
  }

  for (const { endpoint, params } of strategies) {
    const result = await fetchWithRetry(async () => {
      const url = endpoint === 'multi'
        ? 'https://api.themoviedb.org/3/search/multi'
        : `https://api.themoviedb.org/3/search/${endpoint}`;

      const res = await axios.get(url, {
        params: { api_key: TMDB_KEY, ...params },
        timeout: 10000,
      });

      let results = (res.data.results || []);
      // For multi, filter to only movie/tv
      if (endpoint === 'multi') {
        results = results.filter(r => r.media_type === 'movie' || r.media_type === 'tv');
      }
      if (results.length === 0) {
        console.log(`  ⬜ [TMDB] No results for "${params.query}" (${endpoint}${params.year ? ' y='+params.year : ''})`);
        return null;
      }

      // Score & rank all results
      const scored = results.slice(0, 10).map(r => {
        const rTitle = r.title || r.name || '';
        const rOrig  = r.original_title || r.original_name || '';
        const rYear  = r.release_date
          ? parseInt(r.release_date, 10)
          : r.first_air_date
          ? parseInt(r.first_air_date, 10)
          : null;
        const rType = endpoint === 'multi'
          ? (r.media_type === 'tv' ? 'series' : 'movie')
          : (endpoint === 'tv' ? 'series' : 'movie');

        // Title similarity — also check original title (handles romanized names)
        const simClean = stringSimilarity(cleanTitleForApi(rTitle), cleanTitle);
        const simOrig  = stringSimilarity(cleanTitleForApi(rOrig),  cleanTitle);
        let score = Math.max(simClean, simOrig) * 60; // up to 60 pts for title

        // Year scoring — use hintYear (includes post date fallback)
        if (hintYear && rYear) {
          const diff = Math.abs(hintYear - rYear);
          if (diff === 0)      score += 30;
          else if (diff === 1) score += 15;
          else if (diff <= 2)  score += 5;
          else                 score -= 20;
        } else if (!hintYear || !rYear) {
          score += 10; // one or both unknown — neutral positive baseline
        }
        
        // Exact match boost
        if (titleSim >= 0.90) {
          score += 15;
        }

        // Type scoring
        const parsedType = isSeries ? 'series' : 'movie';
        if (parsedType === rType) score += 15; else score -= 10;

        // Popularity boost (TMDB popularity — avoids obscure wrong matches)
        if (r.popularity > 50)  score += 5;
        if (r.popularity > 200) score += 5;

        return { r, score, rTitle, rOrig, rYear, rType };
      });

      scored.sort((a, b) => b.score - a.score);
      const best = scored[0];

      // ── Confidence thresholds (stricter than before to prevent wrong matches) ─
      const minScore    = isShort ? 65 : 58;          // raised: was 62/52
      let titleSim = 0;
      for (const t of titleVariants) {
        const sim = Math.max(
          stringSimilarity(cleanTitleForApi(best.rTitle), t),
          stringSimilarity(cleanTitleForApi(best.rOrig),  t)
        );
        if (sim > titleSim) titleSim = sim;
      }
      const minTitleSim = isShort ? 0.70 : 0.55;     // raised: was 0.65/0.40

      // Hard year-gap guard: large year mismatch needs very high title similarity
      const yearDiff = (hintYear && best.rYear) ? Math.abs(hintYear - best.rYear) : 0;
      if (yearDiff > 3 && titleSim < 0.80) {
        console.log(`  ❌ [TMDB] Year mismatch (${yearDiff}yr) + low sim (${titleSim.toFixed(2)}) for "${best.rTitle}" ← searched "${cleanTitle}" (${endpoint})`);
        return null;
      }

      if (best.score < minScore || titleSim < minTitleSim) {
        console.log(`  ❌ [TMDB] Rejected "${best.rTitle}" (${best.rYear||'?'}) score=${best.score.toFixed(0)} sim=${titleSim.toFixed(2)} ← "${cleanTitle}" (${endpoint}${params.year ? ' y='+params.year : ''})`);
        return null;
      }

      // Fetch full details
      const isTv = endpoint === 'tv' || best.r.media_type === 'tv';
      const detailRes = await fetchWithRetry(() =>
        axios.get(
          `https://api.themoviedb.org/3/${isTv ? 'tv' : 'movie'}/${best.r.id}`,
          { params: { api_key: TMDB_KEY }, timeout: 10000 }
        )
      );
      if (!detailRes) return null;
      const d = detailRes.data;

      // Season-specific poster for series
      let seasonPoster   = '';
      let seasonOverview = '';
      if (isTv && season) {
        const seasonRes = await fetchWithRetry(() =>
          axios.get(
            `https://api.themoviedb.org/3/tv/${best.r.id}/season/${season}`,
            { params: { api_key: TMDB_KEY }, timeout: 8000 }
          )
        );
        if (seasonRes?.data?.poster_path)
          seasonPoster = `https://image.tmdb.org/t/p/w500${seasonRes.data.poster_path}`;
        if (seasonRes?.data?.overview)
          seasonOverview = seasonRes.data.overview;
      }

      const langMap = {
        'en': 'English', 'te': 'Telugu', 'ta': 'Tamil', 'hi': 'Hindi',
        'ml': 'Malayalam', 'kn': 'Kannada', 'ja': 'Japanese', 'ko': 'Korean',
        'fr': 'French', 'es': 'Spanish', 'de': 'German', 'it': 'Italian',
        'zh': 'Chinese', 'ru': 'Russian', 'pt': 'Portuguese',
        'ar': 'Arabic', 'tr': 'Turkish', 'id': 'Indonesian', 'th': 'Thai',
      };

      return {
        tmdbId:          String(d.id),
        type:            isTv ? 'series' : 'movie',
        totalSeasons:    d.number_of_seasons || 0,
        title:           d.title || d.name || title,
        description:     seasonOverview || d.overview || '',
        poster:          seasonPoster || (d.poster_path   ? `https://image.tmdb.org/t/p/w500${d.poster_path}`   : ''),
        backdrop:        d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
        rating:          Math.round((d.vote_average || 0) * 10) / 10,
        year:            d.release_date
          ? parseInt(d.release_date, 10)
          : d.first_air_date
          ? parseInt(d.first_air_date, 10)
          : hintYear,
        releaseDate:     d.release_date || d.first_air_date || '',
        genre:           (d.genres || []).map(g => g.name),
        duration:        d.runtime
          ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
          : (d.episode_run_time?.[0]
            ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m`
            : ''),
        originalLanguage: langMap[d.original_language] || d.original_language || '',
        confidence:      Math.round(best.score),
      };
    });

    if (result) return result; // Got a confident match — stop trying
  }
  return null;
}


// ─── OMDB FALLBACK ────────────────────────────────────────────────────────────
async function searchOMDB(title, year, isSeries) {
  if (!OMDB_KEY) return null;
  return fetchWithRetry(async () => {
    const params = { t: cleanTitleForApi(title), apikey: OMDB_KEY, type: isSeries ? 'series' : 'movie', plot: 'short' };
    if (year) params.y = year;
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 8000 });
    const d   = res.data;
    if (!d || d.Response === 'False') return null;
    const m = d.Runtime ? parseInt(d.Runtime) : null;
    return {
      title:       d.Title  || title,
      description: d.Plot   !== 'N/A' ? d.Plot   : '',
      poster:      d.Poster !== 'N/A' ? d.Poster : '',
      rating:      d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
      year:        d.Year ? parseInt(d.Year, 10) : year,
      genre:       d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
      duration:    m ? `${Math.floor(m/60)}h ${m%60}m` : '',
      imdbId:      d.imdbID || '',
    };
  });
}

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function detectCodecLocal(filename) {
  const s = (filename || '').toUpperCase();
  if (/\bAV1\b/.test(s))               return 'AV1';
  if (/HEVC|H\.265|X265/.test(s))      return 'HEVC';
  // H.264 is the default codec — not worth showing as a badge
  return 'Other';
}

// Extract season from filename: Stranger.Things.S04.zip → 4
function seasonFromFilename(fn) {
  if (!fn) return null;
  const m = fn.match(/[._\s-]S(\d{1,2})[._\s\[\.-]/i) || fn.match(/\bS(\d{1,2})\b(?!\d)/i) || fn.match(/Season[\s._]?(\d+)/i);
  return m ? parseInt(m[1], 10) : null;
}

// ─── MAIN ─────────────────────────────────────────────────────────────────────
async function main() {
  const INPUT_FILE = process.env.IMPORT_SOURCE || BYPASSED_FILE;
  if (!fs.existsSync(INPUT_FILE)) {
    console.error(`❌  No ${INPUT_FILE} found!`);
    process.exit(1);
  }

  const all   = JSON.parse(fs.readFileSync(INPUT_FILE, 'utf8'));
  // Skip shortlinks (need bypassing) and entries with junk/empty titles
  const valid = all.filter(b =>
    (b.bypassedUrl || b.url) &&
    b.host !== 'Shortlink' &&
    b.title && b.title.trim().length >= 2 && !isJunkTitle(b.title)
  );
  const shortlinkCount = all.filter(b => b.host === 'Shortlink').length;
  const junkCount = all.length - valid.length - shortlinkCount;

  console.log(`\n📦 Total entries    : ${all.length}`);
  console.log(`✅ Direct links    : ${valid.length}`);
  if (shortlinkCount) console.log(`⏭️  Shortlinks skipped: ${shortlinkCount} (run bypasser separately)`);
  if (junkCount)      console.log(`🚫 Junk titles filtered: ${junkCount}`);
  console.log();

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop', {
    serverSelectionTimeoutMS: 30000,
    socketTimeoutMS:          60000,
    heartbeatFrequencyMS:     10000,
    retryWrites:              true,
  });
  console.log('🗄️  MongoDB connected\n');

  let added = 0, updated = 0, skipped = 0, noMeta = 0, upgraded = 0;

  // ── Group by (title + year + quality + codec) for TMDB API efficiency ────────
  // Same title from multiple channels → one TMDB call, all links merged.
  // Including quality+codec avoids mismerging same-title different-quality rips.
  const groups = {};
  for (const item of valid) {
    const key = [
      (item.title   || '').toLowerCase().trim(),
      item.year     || '',
    ].join('__');
    if (!groups[key]) groups[key] = { items: [], msgDate: item.date || null };
    // Use the earliest message date as the post date hint
    if (item.date && (!groups[key].msgDate || item.date < groups[key].msgDate)) {
      groups[key].msgDate = item.date;
    }
    groups[key].items.push(item);
  }

  console.log(`🔑 Unique title groups: ${Object.keys(groups).length}\n`);

  // ── Concurrency pool: process N groups at a time ─────────────────────────
  const CONCURRENCY = 2; // 2 parallel groups — safe for TMDB API rate limits
  const groupEntries = Object.entries(groups);

  async function processGroup([, group]) {
    const rep     = group.items[0];
    const isSer   = rep.isSeries || rep.contentType === 'series' || rep.contentType === 'anime';
    const msgDate = group.msgDate || rep.date || null; // Telegram post date for year hint

    // ── 1. DB lookup — avoid burning TMDB quota on existing titles ──────────
    const titleEsc = (rep.title || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let existing = null;
    if (rep.year) {
      existing = await dbRetry(() => Movie.findOne({ title: { $regex: `^${titleEsc}$`, $options: 'i' }, year: rep.year }));
    }
    if (!existing) {
      existing = await dbRetry(() => Movie.findOne({ title: { $regex: `^${titleEsc}$`, $options: 'i' } }));
    }

    // ── 2. TMDB / OMDB fetch (only for genuinely new titles) ────────────────
    let meta = {};
    if (existing) {
      meta = { tmdbId: existing.tmdbId, title: existing.title, type: existing.type };
    } else if (rep.title) {
      // Pass IMDB/TMDB IDs from the message for direct lookup
      const tmdb = await searchTMDB(
        rep.title, rep.year, isSer, rep.season, msgDate,
        rep.imdbId || null,
        rep.tmdbIdHint || null
      );
      if (tmdb) {
        Object.assign(meta, tmdb);
        // Only call OMDB if TMDB is missing critical fields
        if (!meta.poster || !meta.rating || !meta.imdbId) {
          const omdb = await searchOMDB(rep.title, rep.year, isSer);
          if (omdb) {
            if (!meta.poster      && omdb.poster)      meta.poster      = omdb.poster;
            if (!meta.rating      && omdb.rating)      meta.rating      = omdb.rating;
            if (!meta.description && omdb.description) meta.description = omdb.description;
            if (!meta.duration    && omdb.duration)    meta.duration    = omdb.duration;
            if (!meta.genre?.length && omdb.genre?.length) meta.genre   = omdb.genre;
            if (omdb.imdbId)                           meta.imdbId      = omdb.imdbId;
          }
        }
      } else {
        // TMDB missed — try OMDB as sole source
        const omdb = await searchOMDB(rep.title, rep.year, isSer);
        if (omdb) Object.assign(meta, omdb, { tmdbId: '' });
      }
    }

    // ── TMDB miss → fall back to raw parsed title so links are NOT lost ────
    if (!meta.title) {
      if (!rep.title) {
        console.log(`  🚫 [SKIP] No title found at all — dropping ${group.items.length} link(s) silently`);
        noMeta += group.items.length; return;
      } // truly no title at all
      // Use the raw title from the Telegram message as a best-effort entry
      meta = {
        title:       rep.title,
        year:        rep.year || null,
        type:        isSer ? 'series' : 'movie',
        tmdbId:      '',
        imdbId:      '',
        poster:      '',
        backdrop:    '',
        rating:      0,
        description: '',
        genre:       [],
        duration:    '',
      };
      console.log(`⚠️  No TMDB match — saving with raw title: "${meta.title}"`);
    }

    // ── 3. Determine final content type ──────────────────────────────────────
    // Priority: 1) TMDB Animation genre + Japanese/Korean/Chinese origin = anime
    //           2) Parser contentType = anime = anime
    //           3) TMDB says TV = series
    //           4) Parser says series = series
    //           5) Else = movie
    const tmdbGenres  = (meta.genre || []).map(g => (g || '').toLowerCase());
    const isAnimation = tmdbGenres.some(g => /animation|anime/i.test(g));
    const origLang    = (meta.originalLanguage || '').toLowerCase();
    // Strict language match — avoids false positives on partial strings
    const isEastAsian = /^(japanese|korean|chinese|mandarin|cantonese|ja|ko|zh)$/.test(origLang);
    const parserAnime = rep.contentType === 'anime';

    // Anime detection priority:
    //  1. TMDB Animation genre + East Asian origin  → definitely anime
    //  2. Parser flagged anime + (Animation OR East Asian)  → anime
    //  3. Parser flagged anime alone  → treat as anime (e.g. well-known name match)
    let finalType;
    if ((isAnimation && isEastAsian) || (parserAnime && (isAnimation || isEastAsian)) || parserAnime) {
      finalType = 'anime';
    } else if (meta.type === 'series' || isSer) {
      finalType = 'series';
    } else {
      finalType = 'movie';
    }

    // ── 4. Process every link in this title group ────────────────────────────
    for (const item of group.items) {
      let finalUrl = item.bypassedUrl || item.url;
      // Normalize trailing slash and http/https to prevent near-duplicate URLs
      finalUrl = finalUrl.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
      const host     = detectHost(finalUrl);
      const quality  = item.quality  || 'HD';
      const size     = item.size     || '';
      const language = item.language || '';
      const codec    = item.codec    || detectCodecLocal(item.filename);
      const hdr      = item.hdr      || null;

      // Correct season from filename if the parser mis-assigned it
      const correctSeason = seasonFromFilename(item.filename) ?? item.season ?? null;

      // ── Find or create the DB record ────────────────────────────────────
      let dbRec = existing;
      if (!dbRec && meta.tmdbId) {
        dbRec = await Movie.findOne({ tmdbId: meta.tmdbId });
      }

      const newDl = {
        quality,
        size,
        filename: item.filename || '',
        language,
        codec,
        hdr,
        season:   correctSeason,
        episode:  item.episode ?? null,
        links: [{ host, url: finalUrl, isFast: /gdflix|hubcloud|gdlink/i.test(finalUrl) }],
      };

      if (dbRec) {
        // ── Dedup: skip if exact URL already in cached record ──────────────
        const hasUrl = dbRec.downloads?.some(d => d.links?.some(l => l.url === finalUrl));
        if (hasUrl) { skipped++; continue; }

        // ── Cap: max 3 links per slot (1 per unique host type) ────────────
        // Find if there's already a matching slot with this same host
        const existingSlot = dbRec.downloads?.find(d => {
          const qualMatch   = d.quality === quality;
          const langMatch   = (d.language || '') === (language || '');
          const oldMB = toMB(d.size); const newMB2 = toMB(size);
          const sizeMatch = d.size === size || (newMB2 > 0 && oldMB > 0 && Math.abs(newMB2 - oldMB) < 2) || (!d.size && !size);
          return qualMatch && langMatch && sizeMatch;
        });
        if (existingSlot) {
          // Skip if this slot already has 3+ links OR already has a link from this host
          const slotHosts = (existingSlot.links || []).map(l => l.host);
          if (slotHosts.length >= 3 || slotHosts.includes(host)) { skipped++; continue; }
        }

        // ── Atomic update — NO .save(), NO VersionError ────────────────────
        // Check freshest DB state first to guard against concurrent inserts
        const newMB = toMB(size);

        // Find if a matching slot already exists in the current (cached) record.
        // We use the cached record for the decision, then execute atomically.
        let matchedSlotIdx = -1;
        for (let j = 0; j < dbRec.downloads.length; j++) {
          const exDl = dbRec.downloads[j];
          const qualMatch   = exDl.quality === quality;
          const langMatch   = (exDl.language || '') === (language || '');
          const seasonMatch = (finalType === 'series' || finalType === 'anime')
            ? (exDl.season == correctSeason && exDl.episode == (item.episode ?? null))
            : true;
          const oldMB = toMB(exDl.size);
          const sizeMatch = exDl.size === size
            || (newMB > 0 && oldMB > 0 && Math.abs(newMB - oldMB) < 2)
            || (!exDl.size && !size);
          if (qualMatch && langMatch && seasonMatch && sizeMatch) {
            matchedSlotIdx = j;
            break;
          }
        }

        // Build atomic $set for metadata fields
        const metaSet = {};
        if (!dbRec.backdrop    && meta.backdrop)    metaSet.backdrop    = meta.backdrop;
        if (!dbRec.poster      && meta.poster)      metaSet.poster      = meta.poster;
        if (!dbRec.tmdbId      && meta.tmdbId)      metaSet.tmdbId      = meta.tmdbId;
        if (!dbRec.imdbId      && meta.imdbId)      metaSet.imdbId      = meta.imdbId;
        if (!dbRec.rating      && meta.rating)      metaSet.rating      = meta.rating;
        if (!dbRec.description && meta.description) metaSet.description = meta.description;
        if (finalType === 'anime' && dbRec.type === 'series') metaSet.type = 'anime';

        if (matchedSlotIdx >= 0) {
          // Merge new link into the existing slot atomically — cap at 3 links
          const existingLinks = dbRec.downloads[matchedSlotIdx]?.links || [];
          const existingHosts = existingLinks.map(l => l.host);
          if (existingLinks.length >= 3 || existingHosts.includes(host)) {
            skipped++; continue;
          }

          const updateOp = {
            $addToSet: { [`downloads.${matchedSlotIdx}.links`]: newDl.links[0] },
          };
          if (Object.keys(metaSet).length) updateOp.$set = metaSet;

          // Also recompute aggregates — pull fresh after merge
          const result = await Movie.findOneAndUpdate(
            { _id: dbRec._id, [`downloads.${matchedSlotIdx}.links.url`]: { $ne: finalUrl } },
            updateOp,
            { new: true }
          );
          if (result) {
            _recomputeAggregates(result);
            await Movie.findByIdAndUpdate(dbRec._id, {
              $set: { formats: result.formats, quality: result.quality, languages: result.languages, codecs: result.codecs }
            });
            console.log(`🔗 Merged link: [${dbRec.title}] ${quality} → ${host}`);
            updated++;
          } else {
            skipped++; // URL already existed (race condition guard)
          }
        } else {
          // Brand-new variant slot — push atomically
          const updateOp = {
            $push: { downloads: newDl },
          };
          if (Object.keys(metaSet).length) updateOp.$set = metaSet;

          const result = await Movie.findByIdAndUpdate(dbRec._id, updateOp, { new: true });
          if (result) {
            _recomputeAggregates(result);
            await Movie.findByIdAndUpdate(dbRec._id, {
              $set: { formats: result.formats, quality: result.quality, languages: result.languages, codecs: result.codecs }
            });
            console.log(`🔄 Updated: [${dbRec.title}] ${quality} → ${host}`);
            updated++;
          }
        }
        continue;
      }

      // ── Brand-new title — create ─────────────────────────────────────────
      try {
        const originalLang = meta.originalLanguage || meta.language || '';
        const newDoc = await Movie.create({
          title:              meta.title,
          tmdbId:             meta.tmdbId   || '',
          imdbId:             meta.imdbId   || '',
          type:               finalType,
          totalSeasons:       meta.totalSeasons || 0,
          description:        meta.description  || '',
          poster:             meta.poster        || '',
          backdrop:           meta.backdrop      || '',
          rating:             meta.rating        || 0,
          year:               meta.year    || item.year || new Date().getFullYear(),
          genre:              meta.genre   || [],
          duration:           meta.duration || '',
          quality,
          language:           originalLang,
          formats:            [quality].filter(Boolean),
          codecs:             [codec].filter(c => c !== 'Other'),
          languages:          (language || originalLang).split(',').map(l => l.trim()).filter(Boolean),
          telegramMessageIds: item.messageId ? [item.messageId] : [],
          downloads: [newDl],
        });
        added++;
        existing = newDoc; // subsequent items in the group will reuse this
        console.log(`➕ Added: [${meta.title}] (${meta.year || '?'}) ${quality} → ${host}`);
      } catch (e) {
        console.error(`❌ DB error for "${meta.title}": ${e.message}`);
        skipped++;
      }
    }
  } // end processGroup

  // ── Run all groups through the concurrency pool ───────────────────────────
  let idx2 = 0;
  async function runPool() {
    const active = [];
    for (const entry of groupEntries) {
      if (active.length >= CONCURRENCY) {
        await Promise.race(active);
      }
      const p = processGroup(entry).finally(() => active.splice(active.indexOf(p), 1));
      active.push(p);
      idx2++;
      if (idx2 % 100 === 0) {
        process.stdout.write(`\r   Processing: ${idx2}/${groupEntries.length} title groups...`);
      }
      // Brief yield so the event loop can handle SSE writes and server requests
      await sleep(50);
    }
    await Promise.all(active);
    process.stdout.write(`\r   Processing: ${groupEntries.length}/${groupEntries.length} title groups... Done!\n`);
  }
  await runPool();

  console.log(`\n📊 Import Summary`);
  console.log(`  ➕ New records  : ${added}`);
  console.log(`  🔄 Updated     : ${updated}`);
  console.log(`  🔼 Upgraded    : ${upgraded}`);
  console.log(`  ⏭️  Skipped    : ${skipped}`);
  console.log(`  ❓ No metadata : ${noMeta}`);
  console.log(`\n🎉 Done!\n`);

  await mongoose.disconnect();
}

// ─── AGGREGATE RECOMPUTE ──────────────────────────────────────────────────────
function _recomputeAggregates(doc) {
  const dls = doc.downloads || [];
  // Unique quality formats
  doc.formats = [...new Set(dls.map(d => d.quality))].filter(Boolean);
  // Unique codecs (exclude generic "Other")
  doc.codecs  = [...new Set(dls.map(d => d.codec || detectCodecLocal(d.filename)))].filter(c => c && c !== 'Other');
  // All languages across all downloads
  const allLangs = [];
  dls.forEach(d => {
    if (d.language) {
      d.language.split(',').forEach(l => {
        let clean = l.trim();
        // Title case for consistency: "multi" -> "Multi", "tamil" -> "Tamil"
        clean = clean.charAt(0).toUpperCase() + clean.slice(1).toLowerCase();
        allLangs.push(clean);
      });
    }
  });
  doc.languages = [...new Set(allLangs)].filter(Boolean);
  // Best quality
  const QUALITY_ORDER = ['4K', '1080p', '720p', '480p', '360p', 'HD'];
  const best = QUALITY_ORDER.find(q => doc.formats.includes(q));
  if (best) doc.quality = best;
}

main().catch(err => { console.error('Fatal:', err); process.exit(1); });

