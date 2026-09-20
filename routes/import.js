const router = require('express').Router();
const auth = require('../middleware/auth');
const axios = require('axios');
const Movie = require('../models/Movie');
const {
  stripEmojis,
  cleanTitleForApi,
  extractSeasonEpisode,
  parseMessageBlock
} = require('../utils/parser');

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

// Quality normalizer
function normalizeQuality(str) {
  if (/2160p|\b4K\b|\bUHD\b/i.test(str)) return '4K';
  if (/1080p/i.test(str)) return '1080p';
  if (/720p/i.test(str))  return '720p';
  if (/480p/i.test(str))  return '480p';
  if (/360p/i.test(str))  return '360p';
  return 'HD';
}

// Host detector
function detectHost(url) {
  if (/gdflix/i.test(url))         return 'GDFlix';
  if (/hubcloud/i.test(url))       return 'HubCloud';
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
  const cleanTmdb   = cleanTitleForApi(tmdbResult.title || '');
  const titleSim    = stringSimilarity(cleanParsed, cleanTmdb);
  score += titleSim * 50; // up to 50 points
  reasons.push(`Title match: ${Math.round(titleSim * 100)}%`);

  // 2. Year match
  if (parsed.year && tmdbResult.year) {
    const yearDiff = Math.abs(parsed.year - tmdbResult.year);
    if (yearDiff === 0)      { score += 30; reasons.push('Year exact match'); }
    else if (yearDiff === 1) { score += 15; reasons.push('Year off by 1'); }
    else if (yearDiff <= 2)  { score += 5;  reasons.push(`Year off by ${yearDiff}`); }
    else                     { score -= 10; reasons.push(`Year mismatch (${yearDiff} years off)`); }
  } else {
    score += 10; // no year to compare, neutral
    reasons.push('No year to compare');
  }

  // 3. Content type match
  const parsedType = parsed.isSeries ? 'tv' : 'movie';
  const tmdbType   = tmdbResult.type === 'series' ? 'tv' : 'movie';
  if (parsedType === tmdbType) { score += 20; reasons.push('Type match (movie/series)'); }
  else                         { score -= 20; reasons.push('Type mismatch!'); }

  return { score: Math.round(score), reasons };
}

// ═══════════════════════════════════════════════════════════════
//  TMDB API  (with multi-search + detail + confidence)
// ═══════════════════════════════════════════════════════════════

const TMDB_LANG_MAP = { te: 'Telugu', ta: 'Tamil', hi: 'Hindi', ml: 'Malayalam', kn: 'Kannada', en: 'English', mr: 'Marathi', bn: 'Bengali', pa: 'Punjabi' };

async function fetchTMDB(parsed, tmdbKey, retries = 2) {
  const cleanTitle = cleanTitleForApi(parsed.title);
  const isShortTitle = cleanTitle.trim().split(/\s+/).filter(Boolean).length <= 2;

  // ── FAST PATH: Direct lookup by IMDB or TMDB ID ────────────────────────────
  // If the message contains tt\d{7} (IMDB ID) or a TMDB numeric ID,
  // skip fuzzy search entirely — this gives a 100% guaranteed match.
  if (parsed.tmdbIdHint || parsed.imdbId) {
    try {
      let directData = null;
      let isTv = parsed.isSeries;

      if (parsed.tmdbIdHint) {
        // Try movie first, then tv
        for (const mtype of (parsed.isSeries ? ['tv', 'movie'] : ['movie', 'tv'])) {
          try {
            const r = await axios.get(`https://api.themoviedb.org/3/${mtype}/${parsed.tmdbIdHint}`, {
              params: { api_key: tmdbKey }, timeout: 30000
            });
            if (r.data && (r.data.title || r.data.name)) {
              directData = r.data;
              isTv = mtype === 'tv';
              break;
            }
          } catch (_) {}
        }
      }

      if (!directData && parsed.imdbId) {
        // Use /find endpoint to resolve IMDB ID → TMDB
        const findRes = await axios.get(`https://api.themoviedb.org/3/find/${parsed.imdbId}`, {
          params: { api_key: tmdbKey, external_source: 'imdb_id' }, timeout: 30000
        });
        const movies = findRes.data?.movie_results || [];
        const tvs    = findRes.data?.tv_results    || [];
        if (movies.length) {
          const r = await axios.get(`https://api.themoviedb.org/3/movie/${movies[0].id}`, {
            params: { api_key: tmdbKey }, timeout: 30000
          });
          directData = r.data; isTv = false;
        } else if (tvs.length) {
          const r = await axios.get(`https://api.themoviedb.org/3/tv/${tvs[0].id}`, {
            params: { api_key: tmdbKey }, timeout: 30000
          });
          directData = r.data; isTv = true;
        }
      }

      if (directData) {
        const d = directData;
        // Fetch season poster if TV + known season
        let seasonPoster = '', seasonOverview = '';
        if (isTv && parsed.season) {
          try {
            const sr = await axios.get(`https://api.themoviedb.org/3/tv/${d.id}/season/${parsed.season}`, {
              params: { api_key: tmdbKey }, timeout: 30000
            });
            if (sr.data.poster_path) seasonPoster = `https://image.tmdb.org/t/p/w500${sr.data.poster_path}`;
            if (sr.data.overview)    seasonOverview = sr.data.overview;
          } catch (_) {}
        }

        console.log(`[TMDB] ✅ Direct ID match: "${d.title || d.name}" via ${parsed.tmdbIdHint ? 'TMDB' : 'IMDB'} ID`);
        return {
          tmdbId:            String(d.id),
          type:              isTv ? 'series' : 'movie',
          totalSeasons:      d.number_of_seasons || 0,
          title:             d.title || d.name || parsed.title,
          description:       seasonOverview || d.overview || '',
          poster:            seasonPoster || (d.poster_path   ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : ''),
          backdrop:          d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
          rating:            Math.round((d.vote_average || 0) * 10) / 10,
          year:              d.release_date   ? parseInt(d.release_date.substring(0, 4))
                           : d.first_air_date ? parseInt(d.first_air_date.substring(0, 4)) : parsed.year,
          genre:             (d.genres || []).map(g => g.name),
          duration:          d.runtime
            ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
            : (d.episode_run_time?.[0] ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m` : ''),
          language:          TMDB_LANG_MAP[d.original_language] || '',
          confidence:        100, // direct ID = perfect match
          confidenceReasons: ['Direct IMDB/TMDB ID match'],
          isAnime:           (d.genres || []).some(g => g.name === 'Animation') && (isTv || d.original_language === 'ja'),
        };
      }
    } catch (e) {
      console.log(`[TMDB] Direct ID lookup failed: ${e.message}`);
    }
  }

  // ── FUZZY SEARCH FALLBACK ────────────────────────────────────────────────────
  const searchAttempts = [
    // 1. With year (most specific)
    ...(parsed.year ? [{ api_key: tmdbKey, query: cleanTitle, year: parsed.year }] : []),
    // 2. Without year
    { api_key: tmdbKey, query: cleanTitle },
    // 3. Short-title trick: append the year as part of the query string
    ...(isShortTitle && parsed.year ? [{ api_key: tmdbKey, query: `${cleanTitle} ${parsed.year}` }] : []),
    // 4. Main title only (split on colon/dash for subtitle-heavy titles)
    { api_key: tmdbKey, query: cleanTitle.split(/[:\-]/)[0].trim() },
    // 5. First 3 words
    { api_key: tmdbKey, query: cleanTitle.split(/\s+/).slice(0, 3).join(' ') },
  ].filter(p => p.query && p.query.length >= 2);

  for (const searchParams of searchAttempts) {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const searchRes = await axios.get('https://api.themoviedb.org/3/search/multi', { params: searchParams, timeout: 30000 });
        let results = (searchRes.data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
        if (results.length === 0) break; // try next search strategy

        // Score top results
        const scored = results.slice(0, 8).map(r => {
          const isTv  = r.media_type === 'tv';
          const rYear = r.release_date ? parseInt(r.release_date.substring(0, 4)) : (r.first_air_date ? parseInt(r.first_air_date.substring(0, 4)) : null);
          const preview = { title: r.title || r.name || '', year: rYear, type: isTv ? 'series' : 'movie' };
          const { score, reasons } = scoreMatch(parsed, preview);
          return { r, score, reasons, isTv };
        });
        scored.sort((a, b) => b.score - a.score);
        const best = scored[0];

        // Confidence thresholds — STRICTER for short titles
        const titleSim    = stringSimilarity(cleanTitleForApi(parsed.title), cleanTitleForApi(best.r.title || best.r.name || ''));
        const minScore    = isShortTitle ? 65 : 55;
        const minTitleSim = isShortTitle ? 0.70 : 0.50;

        if (best.score < minScore || titleSim < minTitleSim) {
          console.log(`[TMDB] Rejected "${parsed.title}" → "${best.r.title || best.r.name}" (score=${best.score}, sim=${Math.round(titleSim*100)}%, short=${isShortTitle})`);
          break; // try next search strategy
        }

        // Fetch full details
        const detailRes = await axios.get(`https://api.themoviedb.org/3/${best.isTv ? 'tv' : 'movie'}/${best.r.id}`, {
          params: { api_key: tmdbKey }, timeout: 30000
        });
        const d = detailRes.data;

        // Fetch season-specific poster if this is a TV series with a known season
        let seasonPoster   = '';
        let seasonOverview = '';
        if (best.isTv && parsed.season) {
          try {
            const seasonRes = await axios.get(
              `https://api.themoviedb.org/3/tv/${best.r.id}/season/${parsed.season}`,
              { params: { api_key: tmdbKey }, timeout: 30000 }
            );
            if (seasonRes.data.poster_path)
              seasonPoster = `https://image.tmdb.org/t/p/w500${seasonRes.data.poster_path}`;
            if (seasonRes.data.overview)
              seasonOverview = seasonRes.data.overview;
          } catch (_) { /* season poster is optional */ }
        }

        return {
          tmdbId:            String(d.id),
          type:              best.isTv ? 'series' : 'movie',
          totalSeasons:      d.number_of_seasons || 0,
          title:             d.title || d.name || parsed.title,
          description:       seasonOverview || d.overview || '',
          // Prefer season-specific poster, fall back to show poster
          poster:            seasonPoster || (d.poster_path   ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : ''),
          backdrop:          d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
          rating:            Math.round((d.vote_average || 0) * 10) / 10,
          year:              d.release_date   ? parseInt(d.release_date.substring(0, 4))
                           : d.first_air_date ? parseInt(d.first_air_date.substring(0, 4)) : parsed.year,
          genre:             (d.genres || []).map(g => g.name),
          duration:          d.runtime
            ? `${Math.floor(d.runtime / 60)}h ${d.runtime % 60}m`
            : (d.episode_run_time?.[0] ? `${Math.floor(d.episode_run_time[0] / 60)}h ${d.episode_run_time[0] % 60}m` : ''),
          language:          TMDB_LANG_MAP[d.original_language] || '',
          confidence:        best.score,
          confidenceReasons: best.reasons,
          isAnime:           (d.genres || []).some(g => g.name === 'Animation') &&
                             (best.isTv || d.original_language === 'ja'),
        };
      } catch (err) {
        if (attempt < retries) await sleep(1000 * (attempt + 1));
      }
    }
  }
  return null;
}


// ═══════════════════════════════════════════════════════════════
//  OMDB/IMDB API  (cross-validation & fallback)
// ═══════════════════════════════════════════════════════════════

async function fetchOMDB(parsed, omdbKey) {
  try {
    const cleanTitle = cleanTitleForApi(parsed.title);
    const type       = parsed.isSeries ? 'series' : 'movie';
    const params     = { t: cleanTitle, apikey: omdbKey, type, plot: 'short' };
    if (parsed.year) params.y = parsed.year;

    const res = await axios.get('http://www.omdbapi.com/', { params, timeout: 30000 });
    const d   = res.data;
    if (!d || d.Response === 'False') {
      // Try without type filter
      const res2 = await axios.get('http://www.omdbapi.com/', {
        params: { t: cleanTitle, apikey: omdbKey, plot: 'short', ...(parsed.year ? { y: parsed.year } : {}) },
        timeout: 30000
      });
      if (!res2.data || res2.data.Response === 'False') return null;
      Object.assign(d, res2.data);
    }

    const omdbYear = d.Year ? parseInt(d.Year) : parsed.year;

    // Cross-validate: year should be close
    if (parsed.year && omdbYear && Math.abs(parsed.year - omdbYear) > 2) return null;

    return {
      imdbId:      d.imdbID || '',
      title:       d.Title  || parsed.title,
      description: d.Plot && d.Plot !== 'N/A' ? d.Plot : '',
      poster:      d.Poster && d.Poster !== 'N/A' ? d.Poster : '',
      rating:      d.imdbRating && d.imdbRating !== 'N/A' ? parseFloat(d.imdbRating) : 0,
      year:        omdbYear,
      genre:       d.Genre && d.Genre !== 'N/A' ? d.Genre.split(', ') : [],
      duration:    d.Runtime && d.Runtime !== 'N/A'
        ? (() => { const m = parseInt(d.Runtime); return `${Math.floor(m/60)}h ${m%60}m`; })()
        : '',
      type:        d.Type === 'series' ? 'series' : 'movie',
    };
  } catch (_) { return null; }
}

// ═══════════════════════════════════════════════════════════════
//  MASTER META FETCHER — TMDB + OMDB cross-validation
// ═══════════════════════════════════════════════════════════════

async function fetchMeta(parsed, tmdbKey, omdbKey) {
  let tmdb = null, omdb = null;

  if (tmdbKey) tmdb = await fetchTMDB(parsed, tmdbKey);
  if (omdbKey)  omdb = await fetchOMDB(parsed, omdbKey);

  // Both found: cross-validate poster/year consistency
  if (tmdb && omdb) {
    // If years are wildly different, trust the higher-confidence one
    if (tmdb.year && omdb.year && Math.abs(tmdb.year - omdb.year) > 2) {
      console.log(`[CrossCheck] Year conflict: TMDB=${tmdb.year} vs OMDB=${omdb.year} for "${parsed.title}". Trusting TMDB.`);
    }
    // Merge: TMDB primary, OMDB fills gaps
    if (!tmdb.poster   && omdb.poster)      tmdb.poster      = omdb.poster;
    if (!tmdb.rating   && omdb.rating)      tmdb.rating      = omdb.rating;
    if (!tmdb.description && omdb.description) tmdb.description = omdb.description;
    if (!tmdb.duration && omdb.duration)    tmdb.duration    = omdb.duration;
    if (!tmdb.genre?.length && omdb.genre?.length) tmdb.genre = omdb.genre;
    if (omdb.imdbId)   tmdb.imdbId = omdb.imdbId;
    return tmdb;
  }

  if (tmdb) return tmdb;
  if (omdb) return { ...omdb, tmdbId: '' };
  return {};
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

  // ── Expand each message into individual per-movie blocks ──
  // Split on double newlines, but merge URL-only blocks back into the prev filename block
  // (handles case where user has blank line between filename and link)
  const isUrlOnlyBlock = b => b.split('\n').every(l => !l.trim() || /^https?:\/\//i.test(l.trim()));
  const expandedMessages = [];
  for (const msgObj of messages) {
    if (!msgObj?.text) continue;
    // Normalize CRLF to LF (browser textarea can produce \r\n)
    const normText = msgObj.text.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const rawBlocks = normText.split(/\n{2,}/).map(b => b.trim()).filter(Boolean);
    if (rawBlocks.length <= 1) {
      expandedMessages.push({ ...msgObj, text: normText });
    } else {
      // Merge orphan URL-only blocks back into the preceding filename block
      const merged = [];
      for (const block of rawBlocks) {
        if (merged.length > 0 && isUrlOnlyBlock(block)) {
          merged[merged.length - 1] += '\n' + block;
        } else {
          merged.push(block);
        }
      }
      for (const block of merged) {
        expandedMessages.push({ ...msgObj, text: block });
      }
    }
  }

  let successCount = 0, updatedCount = 0, skippedCount = 0, lowConfidence = 0, duplicateCount = 0;
  const errors = [];

  // fetchMeta with 12s timeout — if TMDB hangs, fall back to empty meta
  async function fetchMetaSafe(parsed) {
    const timeout = new Promise(resolve => setTimeout(() => resolve({}), 12000));
    try { return await Promise.race([fetchMeta(parsed, tmdbKey, omdbKey), timeout]); }
    catch (_) { return {}; }
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
    let existing = tmdbId ? await Movie.findOne({ tmdbId }) : null;
    if (!existing) {
      existing = await Movie.findOne({ title: { $regex: `^${finalTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    }
    if (!existing && finalTitle !== title) {
      existing = await Movie.findOne({ title: { $regex: `^${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });
    }

    if (existing) {
      if (msgObj.id && existing.telegramMessageIds?.includes(msgObj.id)) { duplicateCount++; skippedCount++; continue; }

      let updated = false;
      for (const newDl of downloads) {
        const existingDl = existing.downloads.find(d => d.filename && d.filename === newDl.filename && d.size === newDl.size);
        if (existingDl) {
          for (const link of newDl.links) {
            if (!existingDl.links.find(l => l.url === link.url)) { existingDl.links.push(link); updated = true; }
          }
        } else {
          existing.downloads.push(newDl); updated = true;
        }
      }
      if (msgObj.id) {
        if (!existing.telegramMessageIds) existing.telegramMessageIds = [];
        existing.telegramMessageIds.push(msgObj.id);
        updated = true;
      }
      if (updated) { await existing.save(); updatedCount++; }
      else { duplicateCount++; skippedCount++; }
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
      year:               meta.year    || year    || new Date().getFullYear(),
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

  // Build the best combined result
  if (!tmdb && !omdb) {
    return res.status(404).json({ message: `No results found for "${title}" on TMDB or OMDB` });
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
    // If TMDB has no poster, try OMDB poster as backup
    posterSources: {
      tmdb: tmdb?.poster   || '',
      omdb: omdb?.poster   || '',
    },
    backdropSources: {
      tmdb: tmdb?.backdrop || '',
    },
  };

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
  const { title, year, duration, genre, rating, poster, backdrop, streamEmbed, isFeatured, isTrending, links, overwrite } = req.body;
  const { tmdbKey, omdbKey } = resolveKeys(req);
  if (!title)           return res.status(400).json({ message: 'Title required' });
  if (!links?.length)   return res.status(400).json({ message: 'At least one link required' });

  const parsed   = { title, year: year ? parseInt(year) : null, isSeries: false, contentType: 'movie' };
  const meta     = await fetchMeta(parsed, tmdbKey, omdbKey);
  const finalTitle = meta.title || title;

  const downloads = links.map(link => ({
    quality:  'HD', // Simplified as per instruction
    size:     link.size || '',
    filename: link.filename || '',
    language: link.language || 'Telugu',
    links: [{ host: detectHost(link.url), url: link.url, isFast: /gdflix|hubcloud|gdlink/i.test(link.url) }],
  }));

  const tmdbId = meta.tmdbId || '';
  let existing = tmdbId ? await Movie.findOne({ tmdbId }) : null;
  if (!existing) existing = await Movie.findOne({ title: { $regex: `^${finalTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, $options: 'i' } });

  if (existing && !overwrite) {
    for (const dl of downloads) {
      const dup = existing.downloads.find(d => d.filename && d.filename === dl.filename);
      if (!dup) existing.downloads.push(dl);
      else for (const lnk of dl.links) { if (!dup.links.find(l => l.url === lnk.url)) dup.links.push(lnk); }
    }
    await existing.save();
    return res.json({ message: `Updated existing: ${existing.title}`, movie: existing });
  }

  if (existing && overwrite) {
    Object.assign(existing, {
      title: title || meta.title || existing.title,
      tmdbId: meta.tmdbId || existing.tmdbId,
      type: meta.type || existing.type,
      totalSeasons: meta.totalSeasons || existing.totalSeasons,
      description: meta.description || existing.description,
      poster: poster || meta.poster || existing.poster,
      backdrop: backdrop || meta.backdrop || existing.backdrop,
      rating: rating !== undefined ? rating : (meta.rating || existing.rating),
      year: year || meta.year || existing.year,
      genre: (genre?.length) ? genre : (meta.genre || existing.genre),
      duration: duration || meta.duration || existing.duration,
      streamEmbed: streamEmbed !== undefined ? streamEmbed : existing.streamEmbed,
      isFeatured: isFeatured !== undefined ? isFeatured : existing.isFeatured,
      isTrending: isTrending !== undefined ? isTrending : existing.isTrending,
    });
    existing.downloads.push(...downloads);
    await existing.save();
    return res.json({ message: `Overwritten: ${existing.title}`, movie: existing });
  }

  const movie = await Movie.create({
    title: title || finalTitle,
    tmdbId: meta.tmdbId || '',
    type: meta.type || 'movie',
    totalSeasons: meta.totalSeasons || 0,
    description: meta.description || '',
    poster: poster || meta.poster || '',
    backdrop: backdrop || meta.backdrop || '',
    rating: rating !== undefined ? rating : (meta.rating || 0),
    year: year || meta.year || new Date().getFullYear(),
    genre: (genre?.length) ? genre : (meta.genre || []),
    duration: duration || meta.duration || '',
    quality: downloads[0]?.quality || 'HD',
    language: meta.language || 'Telugu',
    streamEmbed: streamEmbed || '',
    isFeatured: !!isFeatured,
    isTrending: !!isTrending,
    downloads,
  });

  res.json({ message: `Created: ${movie.title}`, movie });
});

// ── PATCH /api/import/update-movie/:id ──────────────────────
router.patch('/update-movie/:id', auth, async (req, res) => {
  try {
    const movie = await Movie.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true });
    if (!movie) return res.status(404).json({ message: 'Movie not found' });
    res.json({ message: 'Updated', movie });
  } catch (e) { res.status(500).json({ message: e.message }); }
});

// ── DELETE /api/import/delete-movie/:id ─────────────────────
router.delete('/delete-movie/:id', auth, async (req, res) => {
  try {
    await Movie.findByIdAndDelete(req.params.id);
    res.json({ message: 'Deleted' });
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

module.exports = router;
