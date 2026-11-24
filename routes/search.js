const router = require('express').Router();
const Movie = require('../models/Movie');

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function normalize(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    // Keep Unicode letters, combining marks, and numbers (Telugu, Hindi, Korean, etc.).
    .replace(/[^\p{L}\p{M}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function levenshtein(a, b) {
  const left = Array.from(a);
  const right = Array.from(b);
  if (a === b) return 0;
  if (!left.length) return right.length;
  if (!right.length) return left.length;
  if (Math.abs(left.length - right.length) > 2) return Math.max(left.length, right.length);
  let previous = Array.from({ length: right.length + 1 }, (_, i) => i);
  for (let i = 1; i <= left.length; i++) {
    const current = [i];
    for (let j = 1; j <= right.length; j++) {
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + (left[i - 1] === right[j - 1] ? 0 : 1)
      );
    }
    previous = current;
  }
  return previous[right.length];
}

function relevanceScore(movie, query, tokens) {
  const title = normalize(movie.title);
  const words = title.split(' ').filter(Boolean);
  let score = 0;
  // Compact matching is for a single unspaced query only. A multi-word query
  // must retain word boundaries so "DJ Tillu" does not collapse to "DJTillu".
  if (!/\s/.test(query) && query.length >= 5) {
    const compactTitle = title.replace(/\s+/g, '');
    if (levenshtein(compactTitle.slice(0, query.length), query) <= Math.max(1, Math.floor(query.length * 0.2))) score += 35;
  }
  const description = normalize(movie.description);
  const genres = normalize((movie.genre || []).join(' '));
  const languages = normalize([movie.language, ...(movie.languages || [])].join(' '));

  if (title === query) score += 160;
  else if (title.startsWith(query)) score += 115;
  else if (title.includes(query)) score += 95;

  let matched = 0;
  for (const token of tokens) {
    if (!token) continue;
    if (words.some(word => word === token)) { score += 24; matched++; continue; }
    if (words.some(word => word.startsWith(token))) { score += 17; matched++; continue; }
    if (words.some(word => word.length >= 4 && token.length >= 4 && levenshtein(word, token) <= 1)) { score += 11; matched++; continue; }
    if (description.includes(token)) score += 4;
    if (genres.includes(token)) score += 9;
    if (languages.includes(token)) score += 8;
  }
  if (tokens.length > 1 && matched === tokens.length) score += 18;
  score += Math.min(Number(movie.rating) || 0, 10) * 0.6;
  score += Math.min(Number(movie.views) || 0, 10000) / 10000;
  return score;
}

// GET /api/search?q=&genre=&year=&quality=&type=&language=&page=&limit=
router.get('/', async (req, res) => {
  try {
    let { q = '', genre, year, quality, type, language, page = 1, limit = 24 } = req.query;
    q = String(q).slice(0, 200).replace(/\s+/g, ' ').trim();
    page = Math.max(1, parseInt(page, 10) || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit, 10) || 24));

    const filter = {};
    if (type === 'movie') filter.type = 'movie';
    else if (type === 'series') filter.type = 'series';
    else if (type === 'anime') filter.type = 'anime';
    if (genre) filter.genre = { $in: [String(genre).slice(0, 60)] };
    if (year && /^\d{4}$/.test(String(year))) filter.year = Number(year);
    if (quality) filter.quality = String(quality).slice(0, 30);
    if (language) filter.language = { $regex: escapeRegex(String(language).slice(0, 50)), $options: 'i' };

    let results = [];
    let total = 0;
    let matchedTotal = null;
    if (q) {
      const normalizedQuery = normalize(q);
      const tokens = normalizedQuery.split(' ').filter(token => token.length > 1).slice(0, 8);
      const escaped = escapeRegex(q);
      // Match all but the final character too, so a one-character typo can still retrieve candidates.
    const tokenPatterns = tokens.map(token => new RegExp(escapeRegex(Array.from(token).slice(0, 3).join('')), 'i'));
      const searchFilter = {
        ...filter,
        $or: [
          { title: { $regex: escaped, $options: 'i' } },
          { description: { $regex: escaped, $options: 'i' } },
          { language: { $regex: escaped, $options: 'i' } },
          { languages: { $regex: escaped, $options: 'i' } },
          { genre: { $regex: escaped, $options: 'i' } },
          ...tokenPatterns.flatMap(pattern => [
            { title: pattern }, { language: pattern }, { languages: pattern }, { genre: pattern }
          ])
        ]
      };
      const [candidates, count] = await Promise.all([
        Movie.find(searchFilter).sort({ createdAt: -1 }).limit(1000).select('-__v -downloads').lean(),
        Movie.countDocuments(searchFilter)
      ]);
      matchedTotal = count;
      total = candidates.length;
      results = candidates
        .map(movie => ({ movie, score: relevanceScore(movie, normalizedQuery, tokens) }))
        .sort((a, b) => b.score - a.score || (Number(b.movie.rating) || 0) - (Number(a.movie.rating) || 0) || new Date(b.movie.createdAt) - new Date(a.movie.createdAt))
        .slice((page - 1) * limit, page * limit)
        .map(entry => entry.movie);
    } else {
      const [docs, count] = await Promise.all([
        Movie.find(filter).sort({ createdAt: -1 }).skip((page - 1) * limit).limit(limit).select('-__v -downloads').lean(),
        Movie.countDocuments(filter)
      ]);
      results = docs;
      total = count;
    }

    res.json({
      results, total, matchedTotal, truncated: matchedTotal !== null && matchedTotal > total, page, pages: Math.ceil(total / limit),
      movies: results.filter(item => item.type === 'movie'),
      series: results.filter(item => item.type === 'series' || item.type === 'anime')
    });
  } catch (err) {
    console.error('[search] Search error:', err);
    res.status(500).json({ message: 'Search failed. Please try again.' });
  }
});

module.exports = router;
