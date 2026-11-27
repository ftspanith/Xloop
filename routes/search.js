'use strict';

const router = require('express').Router();
const Movie  = require('../models/Movie');
const { dedupeSeriesDocuments } = require('../utils/seriesGrouping');

// ─── Text helpers ─────────────────────────────────────────────────────────────

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * normalize — strip accents, lowercase, collapse spaces.
 * Preserves Unicode letters (Telugu, Hindi, Korean …) so non-Latin scripts
 * still match without being stripped to empty strings.
 */
function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Bounded Levenshtein — returns early when distance exceeds the given limit.
 * Uses grapheme-safe Array.from so Telugu/Hindi characters count as 1.
 */
function levenshtein(a, b, maxDist = 3) {
  const L = Array.from(a);
  const R = Array.from(b);
  if (a === b) return 0;
  if (!L.length) return R.length;
  if (!R.length) return L.length;
  if (Math.abs(L.length - R.length) > maxDist) return maxDist + 1;
  let prev = Array.from({ length: R.length + 1 }, (_, i) => i);
  for (let i = 1; i <= L.length; i++) {
    const curr = [i];
    let rowMin = i;
    for (let j = 1; j <= R.length; j++) {
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + (L[i - 1] === R[j - 1] ? 0 : 1));
      if (curr[j] < rowMin) rowMin = curr[j];
    }
    if (rowMin > maxDist) return maxDist + 1;
    prev = curr;
  }
  return prev[R.length];
}

// ─── Synonym / alias map ──────────────────────────────────────────────────────
// Maps a canonical form → array of synonyms (all lowercase, normalized).
// Bidirectional: when a query matches any alias, the canonical is also tried.
const SYNONYMS = new Map([
  ['telugu',    ['tollywood', 'andhra', 'telangana']],
  ['hindi',     ['bollywood', 'hindi dubbed']],
  ['tamil',     ['kollywood', 'tamil dubbed']],
  ['kannada',   ['sandalwood']],
  ['malayalam', ['mollywood']],
  ['english',   ['hollywood', 'english dubbed']],
  ['action',    ['action thriller', 'fight']],
  ['comedy',    ['comic', 'humour', 'humor', 'funny']],
  ['thriller',  ['suspense', 'mystery thriller']],
  ['romance',   ['romantic', 'love story']],
  ['horror',    ['scary', 'terror']],
  ['sci-fi',    ['science fiction', 'scifi', 'sci fi']],
  ['animation', ['animated', 'cartoon', 'anime film']],
  ['drama',     ['melodrama']],
  ['4k',        ['2160p', 'uhd', 'ultra hd']],
  ['1080p',     ['full hd', 'fhd']],
  ['720p',      ['hd']],
]);

/** Returns all normalized query expansions (canonical + synonyms that match). */
function expandQuery(normalizedQuery) {
  const expansions = new Set([normalizedQuery]);
  for (const [canonical, aliases] of SYNONYMS) {
    const all = [canonical, ...aliases];
    if (all.some(term => normalizedQuery.includes(term))) {
      all.forEach(t => expansions.add(t));
    }
  }
  return [...expansions];
}

// ─── Relevance scoring ───────────────────────────────────────────────────────

const CURRENT_YEAR = new Date().getFullYear();

/**
 * relevanceScore — multi-signal ranking:
 *  • Exact / prefix / substring title match (highest weight)
 *  • Per-token word match (exact > prefix > fuzzy-1)
 *  • Full-token coverage bonus
 *  • Compact-title match for single-word queries (DJTillu ↔ "DJ Tillu")
 *  • Genre / language / description token coverage
 *  • Recency boost (newer releases rank slightly higher, capped)
 *  • Popularity (rating + views)
 *  • Year match bonus when query contains a 4-digit year
 *  • Original-language boost when query language matches
 */
function relevanceScore(movie, normalizedQuery, tokens, queryYear) {
  const title       = normalize(movie.title);
  const words       = title.split(' ').filter(Boolean);
  const description = normalize(movie.description || '');
  const genres      = normalize((movie.genre || []).join(' '));
  const langString  = normalize(
    [movie.language, movie.originalLanguage, ...(movie.languages || [])].filter(Boolean).join(' ')
  );

  let score = 0;

  // ── Exact / prefix / substring (title) ───────────────────────────────────
  if (title === normalizedQuery)             score += 200;
  else if (title.startsWith(normalizedQuery)) score += 140;
  else if (title.includes(normalizedQuery))   score += 110;

  // ── Compact single-word match (DJTillu ↔ "DJ Tillu") ────────────────────
  if (!/\s/.test(normalizedQuery) && normalizedQuery.length >= 4) {
    const compact = title.replace(/\s+/g, '');
    const qLen    = normalizedQuery.length;
    if (levenshtein(compact.slice(0, qLen), normalizedQuery, 1) <= 1) score += 40;
  }

  // ── Per-token word matching ───────────────────────────────────────────────
  let matched = 0;
  for (const token of tokens) {
    if (!token || token.length < 2) continue;

    // Exact word
    if (words.some(w => w === token))                               { score += 28; matched++; continue; }
    // Prefix match
    if (words.some(w => w.startsWith(token)))                       { score += 20; matched++; continue; }
    // Fuzzy (Levenshtein ≤ 1 for ≥4-char tokens)
    if (token.length >= 4 && words.some(w => w.length >= 3 && levenshtein(w, token, 1) <= 1)) {
                                                                      score += 13; matched++; continue; }
    // Description / genre / language secondary signals
    if (description.includes(token)) score += 5;
    if (genres.includes(token))      score += 11;
    if (langString.includes(token))  score += 10;
  }

  // ── All tokens matched in title → phrase bonus ───────────────────────────
  if (tokens.length > 1 && matched === tokens.length) score += 22;
  // ── Partial coverage ratio bonus ─────────────────────────────────────────
  if (tokens.length > 0) score += (matched / tokens.length) * 12;

  // ── Year match (query contains a 4-digit year) ───────────────────────────
  if (queryYear && Number(movie.year) === queryYear) score += 30;

  // ── Recency boost — newer movies rank slightly higher, capped at 15 ──────
  const age = CURRENT_YEAR - (Number(movie.year) || CURRENT_YEAR);
  score += Math.max(0, 15 - age * 0.6);

  // ── Popularity signals ────────────────────────────────────────────────────
  score += Math.min(Number(movie.rating) || 0, 10) * 0.8;
  score += Math.min(Number(movie.views)  || 0, 50000) / 50000 * 5;

  return score;
}

// ─── Main search endpoint ─────────────────────────────────────────────────────

// GET /api/search?q=&genre=&year=&quality=&type=&language=&page=&limit=
router.get('/', async (req, res) => {
  try {
    let { q = '', genre, year, quality, type, language, page = 1, limit = 24 } = req.query;
    q     = String(q).slice(0, 200).replace(/\s+/g, ' ').trim();
    page  = Math.max(1, parseInt(page, 10)  || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));

    // ── Filters ─────────────────────────────────────────────────────────────
    const filter = {};
    if (type === 'movie' || type === 'series' || type === 'anime') filter.type = type;
    if (genre)    filter.genre    = { $in: [String(genre).slice(0, 60)] };
    if (year && /^\d{4}$/.test(String(year))) filter.year = Number(year);
    if (quality)  filter.formats  = String(quality).slice(0, 30);
    if (language) filter.language = { $regex: escapeRegex(String(language).slice(0, 50)), $options: 'i' };

    let results = [], total = 0, matchedTotal = null, truncated = false;

    if (q) {
      const normalizedQuery = normalize(q);
      const expansions      = expandQuery(normalizedQuery);

      // Extract a 4-digit year from the query if present (e.g. "Robo 2010")
      const yearMatch = q.match(/\b(19\d{2}|20\d{2})\b/);
      const queryYear = yearMatch ? Number(yearMatch[1]) : null;

      // Tokens: use the first expansion (the query itself) for per-token scoring
      const tokens = normalizedQuery.split(' ').filter(t => t.length > 1).slice(0, 10);

      // Build $or patterns from all expansions for maximum recall
      const orPatterns = [];
      for (const expansion of expansions.slice(0, 4)) { // cap expansions
        const escaped = escapeRegex(expansion);
        orPatterns.push(
          { title: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } },
          { language: { $regex: escaped, $options: 'i' } },
          { originalLanguage: { $regex: escaped, $options: 'i' } },
          { languages: { $regex: escaped, $options: 'i' } },
          { genre: { $regex: escaped, $options: 'i' } }
        );
      }

      // Token prefix patterns for fuzzy recall (3-char prefix minimum)
      const tokenPatterns = tokens
        .filter(t => t.length >= 3)
        .slice(0, 6)
        .map(t => new RegExp(escapeRegex(Array.from(t).slice(0, 4).join('')), 'i'));

      for (const pat of tokenPatterns) {
        orPatterns.push({ title: pat }, { language: pat }, { genre: pat });
      }

      const searchFilter = { ...filter, $or: orPatterns };

      const [candidates, count] = await Promise.all([
        Movie.find(searchFilter)
          .sort({ createdAt: -1 })
          .limit(1500)                             // wider candidate pool
          .select('-__v -downloads')
          .lean(),
        Movie.countDocuments(searchFilter),
      ]);

      matchedTotal = count;
      truncated    = count > candidates.length;

      // Dedupe series before scoring
      const movieCandidates  = candidates.filter(m => m.type === 'movie');
      const seriesCandidates = dedupeSeriesDocuments(
        candidates.filter(m => m.type === 'series' || m.type === 'anime')
      );
      const uniqueCandidates = [...movieCandidates, ...seriesCandidates];
      total = uniqueCandidates.length;

      results = uniqueCandidates
        .map(m => ({ m, score: relevanceScore(m, normalizedQuery, tokens, queryYear) }))
        .filter(({ score }) => score > 0)          // drop zero-relevance noise
        .sort((a, b) =>
          b.score - a.score ||
          (Number(b.m.rating) || 0) - (Number(a.m.rating) || 0) ||
          new Date(b.m.createdAt) - new Date(a.m.createdAt)
        )
        .slice((page - 1) * limit, page * limit)
        .map(({ m }) => m);

    } else {
      // No query — browse mode: return newest content
      const [docs, count] = await Promise.all([
        Movie.find(filter)
          .sort({ createdAt: -1 })
          .skip((page - 1) * limit)
          .limit(limit)
          .select('-__v -downloads')
          .lean(),
        Movie.countDocuments(filter),
      ]);
      results = docs;
      total   = count;
    }

    res.json({
      results,
      total,
      matchedTotal,
      truncated,
      page,
      pages: Math.ceil(total / limit),
      movies: results.filter(r => r.type === 'movie'),
      series: results.filter(r => r.type === 'series' || r.type === 'anime'),
    });

  } catch (err) {
    console.error('[search] Error:', err.message);
    res.status(500).json({ message: 'Search failed. Please try again.' });
  }
});

module.exports = router;
