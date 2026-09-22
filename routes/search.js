const router = require('express').Router();
const Movie  = require('../models/Movie');

// ── Utility: Levenshtein-based string similarity (0–1) ───────────────────────
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
function stringSim(a, b) {
  a = (a || '').toLowerCase().trim();
  b = (b || '').toLowerCase().trim();
  if (a === b) return 1;
  const longer = a.length > b.length ? a : b;
  return !longer.length ? 1 : (longer.length - levenshtein(longer, a.length > b.length ? b : a)) / longer.length;
}

// GET /api/search?q=&genre=&year=&quality=&type=&language=&page=&limit=
router.get('/', async (req, res) => {
  try {
    let {
      q = '',
      genre,
      year,
      quality,
      type,      // 'movie' | 'series' | 'anime' | '' (all)
      language,
      page  = 1,
      limit = 24,
    } = req.query;

    // ── Sanitise inputs ──────────────────────────────────────────────────
    q     = String(q).slice(0, 200).trim();          // guard: max 200 chars
    page  = Math.max(1, parseInt(page)  || 1);
    limit = Math.min(100, Math.max(1, parseInt(limit) || 24)); // cap: 1–100

    const skip = (page - 1) * limit;

    // ── Build filter ───────────────────────────────────────────────────────────
    const filter = {};

    // Type filter
    if (type === 'movie')  filter.type = 'movie';
    else if (type === 'series') filter.type = { $in: ['series', 'anime'] };
    else if (type === 'anime')  filter.type = 'anime';
    // No type filter = search all

    if (genre)    filter.genre    = { $in: [genre] };
    if (year)     filter.year     = parseInt(year);
    if (quality)  filter.quality  = quality;
    if (language) filter.language = { $regex: language, $options: 'i' };

    // ── Text / regex search ────────────────────────────────────────────────────
    let results = [];
    let total   = 0;

    if (q && q.trim().length > 0) {
      const clean = q.trim();

      // Try MongoDB text index first (fast & relevance-ranked)
      try {
        const textFilter = { ...filter, $text: { $search: clean } };
        const projection = { score: { $meta: 'textScore' } };
        const [docs, count] = await Promise.all([
          Movie.find(textFilter, projection)
            .sort({ score: { $meta: 'textScore' } })
            .skip(skip)
            .limit(limit)
            .select('-__v -downloads'),
          Movie.countDocuments(textFilter),
        ]);
        results = docs;
        total   = count;
      } catch (_) {
        // Text index not ready — fall back to regex (user input is already length-clamped above)
        const escaped = clean.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const regexFilter = {
          ...filter,
          $or: [
            { title:       { $regex: escaped, $options: 'i' } },
            { description: { $regex: escaped, $options: 'i' } },
          ],
        };
        const [docs, count] = await Promise.all([
          Movie.find(regexFilter)
            .sort({ rating: -1, createdAt: -1 })
            .skip(skip)
            .limit(limit)
            .select('-__v -downloads'),
          Movie.countDocuments(regexFilter),
        ]);
        results = docs;
        total   = count;
      }

      // Boost exact title matches to the top (client-side re-sort)
      results.sort((a, b) => {
        const simA = stringSim(a.title, clean);
        const simB = stringSim(b.title, clean);
        return simB - simA;
      });

    } else {
      // No query — just filter + paginate
      const [docs, count] = await Promise.all([
        Movie.find(filter)
          .sort({ createdAt: -1 })
          .skip(skip)
          .limit(limit)
          .select('-__v -downloads'),
        Movie.countDocuments(filter),
      ]);
      results = docs;
      total   = count;
    }

    res.json({
      results,
      total,
      page,
      pages: Math.ceil(total / limit),
      // Legacy fields — some pages still read these
      movies: results.filter(r => r.type === 'movie'),
      series: results.filter(r => r.type === 'series' || r.type === 'anime'),
    });
  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ message: 'Server error', error: err.message });
  }
});

module.exports = router;
