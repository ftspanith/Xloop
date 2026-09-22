const router = require('express').Router();
const Movie  = require('../models/Movie');
const auth   = require('../middleware/auth');

const axios  = require('axios');

// TMDB Memory Cache
const tmdbCache = {
  featured: { data: null, expires: 0 },
  trending: { data: null, expires: 0 },
  topRated: { data: null, expires: 0 }
};

const TMDB_KEY = process.env.TMDB_API_KEY;
const IS_PROD = process.env.NODE_ENV === 'production';

// ── Safely escape a string for use in a RegExp ──────────────────────────────
function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// ── Clamp pagination params to safe bounds ───────────────────────────────────
function safeLimit(raw, isAdmin = false) {
  const n = parseInt(raw) || 20;
  return Math.min(Math.max(1, n), isAdmin ? 500 : 100);
}

async function getTmdbIds(endpoint, cacheKey) {
  if (tmdbCache[cacheKey].data && Date.now() < tmdbCache[cacheKey].expires) {
    return tmdbCache[cacheKey].data;
  }
  try {
    const res = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, {
      params: { api_key: TMDB_KEY, language: 'en-US', page: 1 }
    });
    const res2 = await axios.get(`https://api.themoviedb.org/3/${endpoint}`, {
      params: { api_key: TMDB_KEY, language: 'en-US', page: 2 }
    });
    const ids = [...res.data.results, ...res2.data.results].map(m => m.id.toString());
    tmdbCache[cacheKey] = { data: ids, expires: Date.now() + 1000 * 60 * 60 * 4 }; // cache for 4 hours
    return ids;
  } catch (err) {
    return [];
  }
}

// Helper to preserve TMDB array order when fetching from MongoDB
function sortMoviesByTmdbOrder(movies, tmdbIds) {
  const idMap = new Map();
  tmdbIds.forEach((id, index) => idMap.set(id, index));
  return movies.sort((a, b) => {
    const idxA = idMap.has(a.tmdbId) ? idMap.get(a.tmdbId) : 999;
    const idxB = idMap.has(b.tmdbId) ? idMap.get(b.tmdbId) : 999;
    return idxA - idxB;
  });
}

// Helper to prevent duplicates on the homepage (same tmdbId or title)
function isDuplicate(m, arr) {
  return arr.some(existing => 
    (existing.tmdbId && m.tmdbId && existing.tmdbId === m.tmdbId) || 
    (existing.title && m.title && existing.title.toLowerCase() === m.title.toLowerCase())
  );
}

// Helper to filter out duplicates from a raw mongoose array
function uniqueMovies(movies) {
  const uniq = [];
  for (const m of movies) {
    if (!isDuplicate(m, uniq)) uniq.push(m);
  }
  return uniq;
}

// ── GET /api/movies/featured ──────────────────────────────────────────────────
router.get('/featured', async (req, res) => {
  try {
    let rawMovies = await Movie.find({ type: 'movie', isFeatured: true, backdrop: { $ne: '' } })
      .sort({ createdAt: -1 }).limit(15).select('-__v -downloads');
    let movies = uniqueMovies(rawMovies).slice(0, 6);
    
    // Cross-reference with real-world TMDB Popular if manual featured is empty
    if (movies.length < 6) {
      const popularIds = await getTmdbIds('movie/popular', 'featured');
      if (popularIds.length > 0) {
        const tmdbMovies = await Movie.find({ tmdbId: { $in: popularIds }, backdrop: { $ne: '' } })
          .select('-__v -downloads');
        const sortedTmdb = uniqueMovies(sortMoviesByTmdbOrder(tmdbMovies, popularIds));
        
        for (const m of sortedTmdb) {
          if (!isDuplicate(m, movies)) movies.push(m);
          if (movies.length >= 6) break;
        }
      }
    }

    if (movies.length < 6) {
      const fallback = await Movie.find({ type: 'movie', backdrop: { $ne: '' }, rating: { $gte: 6.5 } })
        .sort({ views: -1, createdAt: -1 }).limit(20).select('-__v -downloads');
      for (const f of fallback) {
        if (!isDuplicate(f, movies)) movies.push(f);
        if (movies.length >= 6) break;
      }
    }
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/trending ──────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    let rawMovies = await Movie.find({ type: 'movie', isTrending: true, poster: { $ne: '' } })
      .sort({ views: -1 }).limit(30).select('-__v -downloads');
    let movies = uniqueMovies(rawMovies).slice(0, 15);
    
    if (movies.length < 15) {
      const trendingIds = await getTmdbIds('trending/movie/week', 'trending');
      if (trendingIds.length > 0) {
        const tmdbMovies = await Movie.find({ tmdbId: { $in: trendingIds }, poster: { $ne: '' } })
          .select('-__v -downloads');
        const sortedTmdb = uniqueMovies(sortMoviesByTmdbOrder(tmdbMovies, trendingIds));
        
        for (const m of sortedTmdb) {
          if (!isDuplicate(m, movies)) movies.push(m);
          if (movies.length >= 15) break;
        }
      }
    }

    if (movies.length < 15) {
      const fallback = await Movie.find({ type: 'movie', poster: { $ne: '' }, rating: { $gte: 6.5 } })
        .sort({ views: -1, rating: -1 }).limit(30).select('-__v -downloads');
      for (const f of fallback) {
        if (!isDuplicate(f, movies)) movies.push(f);
        if (movies.length >= 15) break;
      }
    }
    res.json(movies);
  } catch (err) {
    if (!IS_PROD) console.error('[movies/trending]', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/latest ────────────────────────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    let rawMovies = await Movie.find({ type: 'movie', poster: { $ne: '' }, rating: { $gte: 5 } })
      .sort({ createdAt: -1 }).limit(30).select('-__v -downloads');
    let movies = uniqueMovies(rawMovies).slice(0, 15);
    
    if (movies.length < 15) {
      let fallback = await Movie.find({ type: 'movie', poster: { $ne: '' } })
        .sort({ createdAt: -1 }).limit(30).select('-__v -downloads');
      for (const f of fallback) {
        if (!isDuplicate(f, movies)) movies.push(f);
        if (movies.length >= 15) break;
      }
    }
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/top-rated ─────────────────────────────────────────────────
router.get('/top-rated', async (req, res) => {
  try {
    let movies = [];
    const topRatedIds = await getTmdbIds('movie/top_rated', 'topRated');
    if (topRatedIds.length > 0) {
      const tmdbMovies = await Movie.find({ tmdbId: { $in: topRatedIds }, poster: { $ne: '' } })
        .select('-__v -downloads');
      movies = uniqueMovies(sortMoviesByTmdbOrder(tmdbMovies, topRatedIds)).slice(0, 15);
    }
    
    if (movies.length < 15) {
      const fallback = await Movie.find({ type: 'movie', poster: { $ne: '' }, rating: { $gte: 7 } })
        .sort({ views: -1, rating: -1 }).limit(30).select('-__v -downloads');
      for (const f of fallback) {
        if (!isDuplicate(f, movies)) movies.push(f);
        if (movies.length >= 15) break;
      }
    }
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/this-year ─────────────────────────────────────────────────
router.get('/this-year', async (req, res) => {
  try {
    const currentYear = new Date().getFullYear();
    let rawMovies = await Movie.find({ type: 'movie', year: currentYear, poster: { $ne: '' }, rating: { $gte: 5.5 } })
      .sort({ rating: -1, createdAt: -1 }).limit(30).select('-__v -downloads');
    let movies = uniqueMovies(rawMovies).slice(0, 15);
    
    if (movies.length < 15) {
      let fallback = await Movie.find({ type: 'movie', year: currentYear, poster: { $ne: '' } })
        .sort({ createdAt: -1 }).limit(30).select('-__v -downloads');
      for (const f of fallback) {
        if (!isDuplicate(f, movies)) movies.push(f);
        if (movies.length >= 15) break;
      }
    }
    
    if (movies.length < 15) {
      let fallback = await Movie.find({ type: 'movie', year: { $gte: currentYear - 1 }, poster: { $ne: '' }, rating: { $gte: 6 } })
        .sort({ rating: -1, createdAt: -1 }).limit(30).select('-__v -downloads');
      for (const f of fallback) {
        if (!isDuplicate(f, movies)) movies.push(f);
        if (movies.length >= 15) break;
      }
    }
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/by-genre/:genre ──────────────────────────────────────────
router.get('/by-genre/:genre', async (req, res) => {
  try {
    const rawMovies = await Movie.find({ genre: { $in: [req.params.genre] }, poster: { $ne: '' } })
      .sort({ rating: -1, createdAt: -1 }).limit(30).select('-__v -downloads');
    const movies = uniqueMovies(rawMovies).slice(0, 15);
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/by-language/:lang ────────────────────────────────────────
router.get('/by-language/:lang', async (req, res) => {
  try {
    // Escape user input before using in RegExp to prevent ReDoS
    const safe = escapeRegex(req.params.lang.slice(0, 50));
    const langRegex = new RegExp(safe, 'i');
    const rawMovies = await Movie.find({
      $or: [
        { originalLanguage: langRegex },
        { language: langRegex },
        { languages: langRegex },
        { 'downloads.language': langRegex },
      ],
      poster: { $ne: '' },
    }).sort({ createdAt: -1 }).limit(30).select('-__v -downloads');
    const movies = uniqueMovies(rawMovies).slice(0, 15);
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/scan-all  (MUST be before /:id) ──────────────────────────
router.get('/scan-all', auth, async (req, res) => {
  try {
    const movies = await Movie.find({}, '_id title year poster type').sort({ createdAt: -1 }).limit(5000);
    res.json({ movies, total: movies.length });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// ── GET /api/movies  (list + filters + pagination) ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { genre, year, quality, type, search, sort = 'createdAt', page = 1, limit = 20 } = req.query;
    const isAdmin = !!req.headers['authorization']; // rough check — not enforced, just for limit
    const filter = {};

    // type filter: 'all' returns everything, otherwise default to 'movie'
    if (type === 'all') { /* no type filter */ }
    else filter.type = type || 'movie';

    if (genre)   filter.genre   = { $in: [genre] };
    if (year)    filter.year    = parseInt(year);
    if (quality) filter.quality = quality;

    if (search) {
      const s = escapeRegex(search.slice(0, 200)); // clamp + escape for safety
      filter.$or = [
        { title:    { $regex: s, $options: 'i' } },
        { language: { $regex: s, $options: 'i' } },
        { genre:    { $regex: s, $options: 'i' } }
      ];
    }

    const sortObj = sort === 'updatedAt'  ? { updatedAt: -1 }
                  : sort === 'rating'     ? { rating: -1 }
                  : sort === 'views'      ? { views: -1 }
                  : sort === 'title'      ? { title: 1 }
                  :                         { createdAt: -1 };

    const lim  = safeLimit(limit, isAdmin);
    const skip = (Math.max(1, parseInt(page)) - 1) * lim;
    const [movies, total] = await Promise.all([
      Movie.find(filter).sort(sortObj).skip(skip).limit(lim).select('-__v'),
      Movie.countDocuments(filter),
    ]);

    res.json({ movies, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) {
    if (!IS_PROD) console.error('[movies/list]', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const movie = await Movie.findById(req.params.id);
    if (!movie) return res.status(404).json({ message: 'Not found' });
    // Fire-and-forget views increment — catch errors to prevent unhandled rejections
    Movie.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } })
      .exec()
      ;
    res.json(movie);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Not found' });
    res.status(500).json({ message: 'Server error' });
  }
});

// ── POST /api/movies ──────────────────────────────────────────────────────────
router.post('/', auth, async (req, res) => {
  try {
    const movie = await Movie.create(req.body);
    res.status(201).json(movie);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── PUT /api/movies/:id (full replace — protected) ───────────────────────
router.put('/:id', auth, async (req, res) => {
  try {
    // Use $set to avoid wiping fields not included in the request body
    const movie = await Movie.findByIdAndUpdate(
      req.params.id,
      { $set: req.body },
      { new: true, runValidators: true }
    );
    if (!movie) return res.status(404).json({ message: 'Not found' });
    res.json(movie);
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── PATCH /api/movies/:id ─────────────────────────────────────────────────────
router.patch('/:id', auth, async (req, res) => {
  try {
    const movie = await Movie.findByIdAndUpdate(req.params.id, { $set: req.body }, { new: true, runValidators: true });
    if (!movie) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Updated', movie });
  } catch (err) {
    res.status(400).json({ message: err.message });
  }
});

// ── DELETE /api/movies/:id ────────────────────────────────────────────────────
router.delete('/:id', auth, async (req, res) => {
  try {
    const movie = await Movie.findByIdAndDelete(req.params.id);
    if (!movie) return res.status(404).json({ message: 'Not found' });
    res.json({ message: 'Deleted' });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
