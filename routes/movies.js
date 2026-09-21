const router = require('express').Router();
const Movie  = require('../models/Movie');
const auth   = require('../middleware/auth');

// ── GET /api/movies/featured ──────────────────────────────────────────────────
router.get('/featured', async (req, res) => {
  try {
    let movies = await Movie.find({ type: 'movie', isFeatured: true, poster: { $ne: '' } })
      .sort({ createdAt: -1 }).limit(6).select('-__v -downloads');
    if (movies.length === 0) {
      movies = await Movie.find({ type: 'movie', poster: { $ne: '' }, backdrop: { $ne: '' }, rating: { $gte: 5 } })
        .sort({ rating: -1 }).limit(6).select('-__v -downloads');
    }
    if (movies.length === 0) {
      movies = await Movie.find({ type: 'movie', poster: { $ne: '' } })
        .sort({ createdAt: -1 }).limit(6).select('-__v -downloads');
    }
    res.json(movies);
  } catch (err) {
    console.error('featured error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/trending ──────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    let movies = await Movie.find({ type: 'movie', isTrending: true, poster: { $ne: '' } })
      .sort({ views: -1 }).limit(15).select('-__v -downloads');
    if (movies.length === 0) {
      movies = await Movie.find({ type: 'movie', poster: { $ne: '' } })
        .sort({ views: -1, createdAt: -1 }).limit(15).select('-__v -downloads');
    }
    res.json(movies);
  } catch (err) {
    console.error('trending error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/latest ────────────────────────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    const movies = await Movie.find({ type: 'movie', poster: { $ne: '' } })
      .sort({ createdAt: -1 }).limit(15).select('-__v -downloads');
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/top-rated ─────────────────────────────────────────────────
router.get('/top-rated', async (req, res) => {
  try {
    let movies = await Movie.find({ type: 'movie', poster: { $ne: '' }, rating: { $gte: 6 } })
      .sort({ rating: -1 }).limit(15).select('-__v -downloads');
    if (movies.length === 0) {
      movies = await Movie.find({ type: 'movie', poster: { $ne: '' } })
        .sort({ rating: -1 }).limit(15).select('-__v -downloads');
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
    let movies = await Movie.find({ type: 'movie', year: currentYear, poster: { $ne: '' } })
      .sort({ createdAt: -1 }).limit(15).select('-__v -downloads');
    // fallback: last 2 years if this year has nothing
    if (movies.length === 0) {
      movies = await Movie.find({ type: 'movie', year: { $gte: currentYear - 1 }, poster: { $ne: '' } })
        .sort({ createdAt: -1 }).limit(15).select('-__v -downloads');
    }
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/by-genre/:genre ──────────────────────────────────────────
router.get('/by-genre/:genre', async (req, res) => {
  try {
    const movies = await Movie.find({ genre: { $in: [req.params.genre] }, poster: { $ne: '' } })
      .sort({ rating: -1, createdAt: -1 }).limit(15).select('-__v -downloads');
    res.json(movies);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/by-language/:lang ────────────────────────────────────────
router.get('/by-language/:lang', async (req, res) => {
  try {
    const langRegex = new RegExp(req.params.lang, 'i');
    const movies = await Movie.find({
      $or: [
        { originalLanguage: langRegex },
        { language: langRegex },
        { languages: langRegex },
        { 'downloads.language': langRegex },
      ],
      poster: { $ne: '' },
    }).sort({ createdAt: -1 }).limit(15).select('-__v -downloads');
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
    const filter = {};

    // type filter: 'all' returns everything, otherwise default to 'movie'
    if (type === 'all') { /* no type filter */ }
    else filter.type = type || 'movie';

    if (genre)   filter.genre   = { $in: [genre] };
    if (year)    filter.year    = parseInt(year);
    if (quality) filter.quality = quality;
    
    if (search) {
      const s = search.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // escape regex
      filter.$or = [
        { title: { $regex: s, $options: 'i' } },
        { originalTitle: { $regex: s, $options: 'i' } },
        { language: { $regex: s, $options: 'i' } },
        { languages: { $regex: s, $options: 'i' } },
        { genre: { $regex: s, $options: 'i' } }
      ];
    }

    const sortObj = sort === 'updatedAt'  ? { updatedAt: -1 }
                  : sort === 'rating'     ? { rating: -1 }
                  : sort === 'views'      ? { views: -1 }
                  : sort === 'title'      ? { title: 1 }
                  :                         { createdAt: -1 };

    const skip = (parseInt(page) - 1) * parseInt(limit);
    const [movies, total] = await Promise.all([
      Movie.find(filter).sort(sortObj).skip(skip).limit(parseInt(limit)).select('-__v'),
      Movie.countDocuments(filter),
    ]);

    res.json({ movies, total, page: parseInt(page), pages: Math.ceil(total / parseInt(limit)) });
  } catch (err) {
    console.error('GET /api/movies error:', err.message);
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/movies/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const movie = await Movie.findById(req.params.id);
    if (!movie) return res.status(404).json({ message: 'Not found' });
    Movie.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec(); // fire-and-forget
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

// ── PUT /api/movies/:id ───────────────────────────────────────────────────────
router.put('/:id', auth, async (req, res) => {
  try {
    const movie = await Movie.findByIdAndUpdate(req.params.id, req.body, { new: true, runValidators: true });
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
