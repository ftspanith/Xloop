const router = require('express').Router();
const Movie  = require('../models/Movie');
const auth   = require('../middleware/auth');
const axios  = require('axios');
const { dedupeSeriesDocuments, mergeSeriesDocuments } = require('../utils/seriesGrouping');

const TMDB_KEY = process.env.TMDB_API_KEY;

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function fetchGroupedSeriesRecord(id) {
  const record = await Movie.findById(id).lean();
  if (!record) return null;
  const typeFilter = { $in: ['series', 'anime'] };
  const filter = record.tmdbId
    ? { tmdbId: String(record.tmdbId), type: typeFilter }
    : { title: new RegExp('^' + escapeRegex(record.title || '') + '
  const siblings = await Movie.find(filter).lean();
  return mergeSeriesDocuments(siblings.length ? siblings : [record]);
}

function sortSeriesByRatingAndDate(a, b) {
  return (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
}

function safeLimit(raw, max = 100) {
  const n = parseInt(raw) || 20;
  return Math.min(Math.max(1, n), max);
}

// ── GET /api/series/featured ──────────────────────────────────────────────────
router.get('/featured', async (req, res) => {
  try {
    const filter = { type: { $in: ['series', 'anime'] }, poster: { $ne: '' } };
    let series = dedupeSeriesDocuments(await Movie.find({ ...filter, isFeatured: true })
      .sort({ createdAt: -1 }).limit(80).select('-__v -downloads').lean()).slice(0, 6);
    if (series.length < 6) {
      const fallback = dedupeSeriesDocuments(await Movie.find({ ...filter, rating: { $gte: 5 } })
        .sort({ rating: -1, createdAt: -1 }).limit(120).select('-__v -downloads').lean());
      for (const item of fallback) {
        if (!series.some(existing => String(existing._id) === String(item._id))) series.push(item);
        if (series.length >= 6) break;
      }
    }
    if (series.length < 6) {
      const fallback = dedupeSeriesDocuments(await Movie.find(filter)
        .sort({ createdAt: -1 }).limit(160).select('-__v -downloads').lean());
      for (const item of fallback) {
        if (!series.some(existing => String(existing._id) === String(item._id))) series.push(item);
        if (series.length >= 6) break;
      }
    }
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series/trending ──────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const filter = { type: { $in: ['series', 'anime'] }, poster: { $ne: '' } };
    let series = dedupeSeriesDocuments(await Movie.find({ ...filter, isTrending: true })
      .sort({ views: -1 }).limit(100).select('-__v -downloads').lean()).slice(0, 12);
    if (series.length < 12) {
      const fallback = dedupeSeriesDocuments(await Movie.find(filter)
        .sort({ views: -1, createdAt: -1 }).limit(180).select('-__v -downloads').lean());
      for (const item of fallback) {
        if (!series.some(existing => String(existing._id) === String(item._id))) series.push(item);
        if (series.length >= 12) break;
      }
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
    const filter = { type: { $in: ['series', 'anime'] } };
    filter.poster = { $ne: '' };
    const rows = await Movie.find(filter).sort({ createdAt: -1 }).limit(1000).select('-__v -downloads').lean();
    const series = dedupeSeriesDocuments(rows)
      .filter(item => type === 'anime' ? item.type === 'anime' : type === 'series' ? item.type === 'series' : true)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, safeLimit(limit, 100));
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series  (list + filters + pagination) ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { genre, year, quality, type, language, page = 1, limit = 20 } = req.query;
    const filter = type === 'anime' ? { type: 'anime' }
      : type === 'series' ? { type: 'series' }
      : { type: { $in: ['series', 'anime'] } };
    if (genre) filter.genre = { $in: [genre] };
    if (year) filter.year = parseInt(year, 10);
    if (quality) filter.quality = quality;
    if (language) filter.language = { $regex: escapeRegex(language.slice(0, 50)), $options: 'i' };

    // De-duplicate legacy records by TMDB ID (or normalized title when no ID)
    // before pagination so duplicate uploads never consume separate card slots.
    const rows = await Movie.find(filter)
      .sort({ rating: -1, createdAt: -1 })
      .limit(2000)
      .select('-__v -downloads')
      .lean();
    const grouped = dedupeSeriesDocuments(rows)
      .filter(item => type === 'anime' ? item.type === 'anime' : type === 'series' ? item.type === 'series' : true)
      .sort(sortSeriesByRatingAndDate);
    const lim = safeLimit(limit);
    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const total = grouped.length;
    const series = grouped.slice((currentPage - 1) * lim, currentPage * lim);
    res.json({ series, total, page: currentPage, pages: Math.ceil(total / lim) });
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
      /* TMDB key missing — season data unavailable */
      return res.json({ seasons: [] });
    }
    const tmdbRes = await axios.get(
      `https://api.themoviedb.org/3/tv/${series.tmdbId}`,
      { params: { api_key: TMDB_KEY }, timeout: 8000 }
    );
    const seriesMeta = await Movie.findById(req.params.id).select('seasonYears').lean();
    const storedYears = seriesMeta?.seasonYears || {};
    const seasons = (tmdbRes.data.seasons || []).map(s => {
      const airDate = s.air_date || '';
      const airYear = airDate ? parseInt(airDate.slice(0, 4), 10) || null : null;
      return {
        seasonNumber: s.season_number,
        episodeCount: s.episode_count,
        name: s.name,
        airDate,
        year: airYear || storedYears[`s${s.season_number}`] || null,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w300${s.poster_path}` : '',
      };
    });
    res.json({ seasons });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') console.error('[TMDB fetch]', err.message);
    res.json({ seasons: [] });
  }
});

// ── GET /api/series/:id/episodes ─────────────────────────────────────────────
router.get('/:id/episodes', async (req, res) => {
  try {
    const series = await fetchGroupedSeriesRecord(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });

    const epsMap = {};
    for (const d of series.downloads || []) {
      const s   = d.season  || 1;
      if (d.episode == null) continue; // season packs are kept with the season, not Episode 1\n      const e   = d.episode;
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
    const series = await fetchGroupedSeriesRecord(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });
    // Increment only the canonical source record; sibling docs are merged read-only.
    Movie.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec().catch(() => {});
    res.json(series);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Not found' });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
, 'i'), type: typeFilter };
  const siblings = await Movie.find(filter).lean();
  return mergeSeriesDocuments(siblings.length ? siblings : [record]);
}

function sortSeriesByRatingAndDate(a, b) {
  return (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
}

function safeLimit(raw, max = 100) {
  const n = parseInt(raw) || 20;
  return Math.min(Math.max(1, n), max);
}

// ── GET /api/series/featured ──────────────────────────────────────────────────
router.get('/featured', async (req, res) => {
  try {
    const filter = { type: { $in: ['series', 'anime'] }, poster: { $ne: '' } };
    let series = dedupeSeriesDocuments(await Movie.find({ ...filter, isFeatured: true })
      .sort({ createdAt: -1 }).limit(80).select('-__v -downloads').lean()).slice(0, 6);
    if (series.length < 6) {
      const fallback = dedupeSeriesDocuments(await Movie.find({ ...filter, rating: { $gte: 5 } })
        .sort({ rating: -1, createdAt: -1 }).limit(120).select('-__v -downloads').lean());
      for (const item of fallback) {
        if (!series.some(existing => String(existing._id) === String(item._id))) series.push(item);
        if (series.length >= 6) break;
      }
    }
    if (series.length < 6) {
      const fallback = dedupeSeriesDocuments(await Movie.find(filter)
        .sort({ createdAt: -1 }).limit(160).select('-__v -downloads').lean());
      for (const item of fallback) {
        if (!series.some(existing => String(existing._id) === String(item._id))) series.push(item);
        if (series.length >= 6) break;
      }
    }
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series/trending ──────────────────────────────────────────────────
router.get('/trending', async (req, res) => {
  try {
    const filter = { type: { $in: ['series', 'anime'] }, poster: { $ne: '' } };
    let series = dedupeSeriesDocuments(await Movie.find({ ...filter, isTrending: true })
      .sort({ views: -1 }).limit(100).select('-__v -downloads').lean()).slice(0, 12);
    if (series.length < 12) {
      const fallback = dedupeSeriesDocuments(await Movie.find(filter)
        .sort({ views: -1, createdAt: -1 }).limit(180).select('-__v -downloads').lean());
      for (const item of fallback) {
        if (!series.some(existing => String(existing._id) === String(item._id))) series.push(item);
        if (series.length >= 12) break;
      }
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
    const filter = type === 'anime' ? { type: 'anime' }
      : type === 'series' ? { type: 'series' }
      : { type: { $in: ['series', 'anime'] } };
    filter.poster = { $ne: '' };
    const rows = await Movie.find(filter).sort({ createdAt: -1 }).limit(1000).select('-__v -downloads').lean();
    const series = dedupeSeriesDocuments(rows)
      .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
      .slice(0, safeLimit(limit, 100));
    res.json(series);
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// ── GET /api/series  (list + filters + pagination) ───────────────────────────
router.get('/', async (req, res) => {
  try {
    const { genre, year, quality, type, language, page = 1, limit = 20 } = req.query;
    const filter = type === 'anime' ? { type: 'anime' }
      : type === 'series' ? { type: 'series' }
      : { type: { $in: ['series', 'anime'] } };
    if (genre) filter.genre = { $in: [genre] };
    if (year) filter.year = parseInt(year, 10);
    if (quality) filter.quality = quality;
    if (language) filter.language = { $regex: escapeRegex(language.slice(0, 50)), $options: 'i' };

    // De-duplicate legacy records by TMDB ID (or normalized title when no ID)
    // before pagination so duplicate uploads never consume separate card slots.
    const rows = await Movie.find(filter)
      .sort({ rating: -1, createdAt: -1 })
      .limit(2000)
      .select('-__v -downloads')
      .lean();
    const grouped = dedupeSeriesDocuments(rows).sort(sortSeriesByRatingAndDate);
    const lim = safeLimit(limit);
    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const total = grouped.length;
    const series = grouped.slice((currentPage - 1) * lim, currentPage * lim);
    res.json({ series, total, page: currentPage, pages: Math.ceil(total / lim) });
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
      /* TMDB key missing — season data unavailable */
      return res.json({ seasons: [] });
    }
    const tmdbRes = await axios.get(
      `https://api.themoviedb.org/3/tv/${series.tmdbId}`,
      { params: { api_key: TMDB_KEY }, timeout: 8000 }
    );
    const seriesMeta = await Movie.findById(req.params.id).select('seasonYears').lean();
    const storedYears = seriesMeta?.seasonYears || {};
    const seasons = (tmdbRes.data.seasons || []).map(s => {
      const airDate = s.air_date || '';
      const airYear = airDate ? parseInt(airDate.slice(0, 4), 10) || null : null;
      return {
        seasonNumber: s.season_number,
        episodeCount: s.episode_count,
        name: s.name,
        airDate,
        year: airYear || storedYears[`s${s.season_number}`] || null,
        poster: s.poster_path ? `https://image.tmdb.org/t/p/w300${s.poster_path}` : '',
      };
    });
    res.json({ seasons });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') console.error('[TMDB fetch]', err.message);
    res.json({ seasons: [] });
  }
});

// ── GET /api/series/:id/episodes ─────────────────────────────────────────────
router.get('/:id/episodes', async (req, res) => {
  try {
    const series = await fetchGroupedSeriesRecord(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });

    const epsMap = {};
    for (const d of series.downloads || []) {
      const s   = d.season  || 1;
      if (d.episode == null) continue; // season packs are kept with the season, not Episode 1\n      const e   = d.episode;
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
    const series = await fetchGroupedSeriesRecord(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });
    // Increment only the canonical source record; sibling docs are merged read-only.
    Movie.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec().catch(() => {});
    res.json(series);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Not found' });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
