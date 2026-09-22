const router = require('express').Router();
const Movie  = require('../models/Movie');
const auth   = require('../middleware/auth');
const axios  = require('axios');

const TMDB_KEY = process.env.TMDB_API_KEY;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function safeLimit(raw, max = 100) {
  const n = parseInt(raw) || 20;
  return Math.min(Math.max(1, n), max);
}

// ── GET /api/series/featured ──────────────────────────────────────────────────
router.get('/featured', async (req, res) => {
  try {
    let series = await Movie.find({ type: { $in: ['series','anime'] }, isFeatured: true, poster: { $ne: '' } })
      .sort({ createdAt: -1 }).limit(6).select('-__v -downloads');
    if (series.length === 0) {
      series = await Movie.find({ type: { $in: ['series','anime'] }, poster: { $ne: '' }, rating: { $gte: 5 } })
        .sort({ rating: -1 }).limit(6).select('-__v -downloads');
    }
    if (series.length === 0) {
      series = await Movie.find({ type: { $in: ['series','anime'] }, poster: { $ne: '' } })
        .sort({ createdAt: -1 }).limit(6).select('-__v -downloads');
    }
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series/trending ──────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    let series = await Movie.find({ type: { $in: ['series','anime'] }, isTrending: true, poster: { $ne: '' } })
      .sort({ views: -1 }).limit(12).select('-__v -downloads');
    if (series.length === 0) {
      series = await Movie.find({ type: { $in: ['series','anime'] }, poster: { $ne: '' } })
        .sort({ views: -1, createdAt: -1 }).limit(12).select('-__v -downloads');
    }
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series/latest ────────────────────────────────────────────────────
router.get('/latest', async (req, res) => {
  try {
    const { type, limit = 16 } = req.query;
    const filter = type === 'anime'  ? { type: 'anime' }
                 : type === 'series' ? { type: 'series' }
                 : { type: { $in: ['series','anime'] } };
    filter.poster = { $ne: '' };
    const series = await Movie.find(filter)
      .sort({ createdAt: -1 }).limit(parseInt(limit)).select('-__v -downloads');
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series  (list + filters + pagination) ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { genre, year, quality, type, language, page = 1, limit = 20 } = req.query;
    const filter = type === 'anime'  ? { type: 'anime' }
                 : type === 'series' ? { type: 'series' }
                 : { type: { $in: ['series','anime'] } };
    if (genre)    filter.genre    = { $in: [genre] };
    if (year)     filter.year     = parseInt(year);
    if (quality)  filter.quality  = quality; // fix: apply quality filter
    if (language) filter.language = { $regex: escapeRegex(language.slice(0, 50)), $options: 'i' };

    const lim  = safeLimit(limit);
    const skip = (Math.max(1, parseInt(page)) - 1) * lim;
    const [series, total] = await Promise.all([
      Movie.find(filter).sort({ rating: -1, createdAt: -1 }).skip(skip).limit(lim).select('-__v -downloads'),
      Movie.countDocuments(filter),
    ]);
    res.json({ series, total, page: parseInt(page), pages: Math.ceil(total / lim) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series/:id/tmdb-data ─────────────────────────────────────────────
router.get('/:id/tmdb-data', async (req, res) => {
  try {
    const series = await Movie.findById(req.params.id).select('tmdbId');
    if (!series?.tmdbId) return res.json({ seasons: [] });
    if (!TMDB_KEY) {
      console.warn('[TMDB] TMDB_API_KEY is not set — cannot fetch season data');
      return res.json({ seasons: [] });
    }
    const tmdbRes = await axios.get(
      `https://api.themoviedb.org/3/tv/${series.tmdbId}`,
      { params: { api_key: TMDB_KEY }, timeout: 8000 }
    );
    const seasons = (tmdbRes.data.seasons || []).map(s => ({
      seasonNumber: s.season_number,
      episodeCount: s.episode_count,
      name:         s.name,
      poster:       s.poster_path ? `https://image.tmdb.org/t/p/w300${s.poster_path}` : '',
    }));
    res.json({ seasons });
  } catch (err) {
    console.error('TMDB fetch error:', err.message);
    res.json({ seasons: [] });
  }
});

// ── GET /api/series/:id/episodes ─────────────────────────────────────────────
router.get('/:id/episodes', async (req, res) => {
  try {
    const series = await Movie.findById(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });

    const epsMap = {};
    for (const d of series.downloads || []) {
      const s   = d.season  || 1;
      const e   = d.episode || 1;
      const key = `${s}_${e}`;
      if (!epsMap[key]) {
        epsMap[key] = {
          _id:      key,
          seriesId: series._id,
          season:   s,
          episode:  e,
          title:    `Episode ${e}`,
          poster:   series.backdrop || series.poster,
          duration: series.duration,
          downloads: [],
        };
      }
      epsMap[key].downloads.push(d);
    }

    const episodes = Object.values(epsMap).sort((a, b) =>
      a.season !== b.season ? a.season - b.season : a.episode - b.episode
    );
    res.json(episodes);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Not found' });
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series/:id ───────────────────────────────────────────────────────
router.get('/:id', async (req, res) => {
  try {
    const series = await Movie.findById(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });
    // Fire-and-forget views increment — catch to prevent unhandled rejections
    Movie.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } })
      .exec()
      .catch(err => console.error('[views] series increment error:', err.message));
    res.json(series);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Not found' });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
