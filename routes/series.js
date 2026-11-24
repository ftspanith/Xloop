const router = require('express').Router();
const Movie = require('../models/Movie');
const axios = require('axios');
const { dedupeSeriesDocuments, mergeSeriesDocuments } = require('../utils/seriesGrouping');

const TMDB_KEY = process.env.TMDB_API_KEY;
const TV_TYPES = ['series', 'anime'];

function escapeRegex(value) {
  return String(value || '').replace(/[.*+?^$()|[\]\\{}]/g, '\\$&');
}

function safeLimit(raw, max = 100) {
  const n = parseInt(raw, 10) || 20;
  return Math.min(Math.max(1, n), max);
}

function sortSeries(a, b) {
  return (Number(b.rating) || 0) - (Number(a.rating) || 0) ||
    new Date(b.createdAt || 0) - new Date(a.createdAt || 0);
}

async function getGroupedRecord(id) {
  const record = await Movie.findById(id).lean();
  if (!record) return null;
  const filter = record.tmdbId
    ? { tmdbId: String(record.tmdbId), type: { $in: TV_TYPES } }
    : {
        title: new RegExp('^' + escapeRegex(record.title) + '$', 'i'),
        type: { $in: TV_TYPES },
      };
  const siblings = await Movie.find(filter).lean();
  return mergeSeriesDocuments(siblings.length ? siblings : [record]);
}

async function listGrouped(filter, options = {}) {
  const rows = await Movie.find({ ...filter, type: { $in: TV_TYPES } })
    .sort(options.sort || { rating: -1, createdAt: -1 })
    .limit(options.scanLimit || 3000)
    .select('-__v -downloads')
    .lean();
  return dedupeSeriesDocuments(rows);
}

// GET /api/series/featured
router.get('/featured', async (req, res) => {
  try {
    const base = { type: { $in: TV_TYPES }, poster: { $ne: '' } };
    let items = await listGrouped({ ...base, isFeatured: true }, { sort: { createdAt: -1 } , scanLimit: 300 });
    if (items.length < 6) {
      const fallback = await listGrouped({ ...base, rating: { $gte: 5 } }, { scanLimit: 500 });
      for (const item of fallback) {
        if (!items.some(existing => String(existing._id) === String(item._id))) items.push(item);
        if (items.length >= 6) break;
      }
    }
    if (items.length < 6) {
      const fallback = await listGrouped(base, { sort: { createdAt: -1 }, scanLimit: 1000 });
      for (const item of fallback) {
        if (!items.some(existing => String(existing._id) === String(item._id))) items.push(item);
        if (items.length >= 6) break;
      }
    }
    res.json(items.slice(0, 6));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/series/trending
router.get('/trending', async (req, res) => {
  try {
    const base = { type: { $in: TV_TYPES }, poster: { $ne: '' } };
    let items = await listGrouped({ ...base, isTrending: true }, { sort: { views: -1 }, scanLimit: 500 });
    if (items.length < 12) {
      const fallback = await listGrouped(base, { sort: { views: -1, createdAt: -1 }, scanLimit: 1500 });
      for (const item of fallback) {
        if (!items.some(existing => String(existing._id) === String(item._id))) items.push(item);
        if (items.length >= 12) break;
      }
    }
    res.json(items.slice(0, 12));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/series/latest
router.get('/latest', async (req, res) => {
  try {
    const { type, limit = 16 } = req.query;
    let items = await listGrouped({ poster: { $ne: '' } }, {
      sort: { createdAt: -1 },
      scanLimit: 2000,
    });
    if (type === 'anime') items = items.filter(item => item.type === 'anime');
    else if (type === 'series') items = items.filter(item => item.type === 'series');
    items.sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0));
    res.json(items.slice(0, safeLimit(limit, 100)));
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/series — grouped list, filters, pagination
router.get('/', async (req, res) => {
  try {
    const { genre, year, quality, type, language, page = 1, limit = 20 } = req.query;
    const filter = {};
    if (genre) filter.genre = { $in: [genre] };
    if (year) filter.year = parseInt(year, 10);
    if (quality) filter.quality = quality;
    if (language) filter.language = { $regex: escapeRegex(language.slice(0, 50)), $options: 'i' };

    let items = await listGrouped(filter);
    if (type === 'anime') items = items.filter(item => item.type === 'anime');
    else if (type === 'series') items = items.filter(item => item.type === 'series');
    items.sort(sortSeries);
    const lim = safeLimit(limit);
    const currentPage = Math.max(1, parseInt(page, 10) || 1);
    const total = items.length;
    const series = items.slice((currentPage - 1) * lim, currentPage * lim);
    res.json({ series, total, page: currentPage, pages: Math.ceil(total / lim) });
  } catch (err) {
    res.status(500).json({ message: 'Server error' });
  }
});

// GET /api/series/:id/tmdb-data
router.get('/:id/tmdb-data', async (req, res) => {
  try {
    const series = await getGroupedRecord(req.params.id);
    if (!series || !series.tmdbId || !TMDB_KEY) return res.json({ seasons: [] });
    const tmdbRes = await axios.get(
      'https://api.themoviedb.org/3/tv/' + series.tmdbId,
      { params: { api_key: TMDB_KEY }, timeout: 8000 }
    );
    const storedYears = series.seasonYears || {};
    const seasons = (tmdbRes.data.seasons || []).map(season => {
      const airDate = season.air_date || '';
      const airYear = airDate ? parseInt(airDate.slice(0, 4), 10) || null : null;
      return {
        seasonNumber: season.season_number,
        episodeCount: season.episode_count,
        name: season.name,
        airDate,
        year: airYear || storedYears['s' + season.season_number] || null,
        poster: season.poster_path ? 'https://image.tmdb.org/t/p/w300' + season.poster_path : '',
      };
    });
    res.json({ seasons });
  } catch (err) {
    if (process.env.NODE_ENV !== 'production') console.error('[TMDB fetch]', err.message);
    res.json({ seasons: [] });
  }
});

// GET /api/series/:id/episodes
router.get('/:id/episodes', async (req, res) => {
  try {
    const series = await getGroupedRecord(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });
    const epsMap = {};
    for (const download of series.downloads || []) {
      if (download.episode == null) continue; // Season packs remain in their season bucket.
      const season = download.season || 1;
      const episode = download.episode;
      const key = season + '_' + episode;
      if (!epsMap[key]) {
        epsMap[key] = {
          _id: key,
          seriesId: series._id,
          season,
          episode,
          title: 'Episode ' + episode,
          poster: series.backdrop || series.poster,
          duration: series.duration,
          downloads: [],
        };
      }
      epsMap[key].downloads.push(download);
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

// GET /api/series/:id
router.get('/:id', async (req, res) => {
  try {
    const series = await getGroupedRecord(req.params.id);
    if (!series) return res.status(404).json({ message: 'Not found' });
    Movie.findByIdAndUpdate(req.params.id, { $inc: { views: 1 } }).exec().catch(() => {});
    res.json(series);
  } catch (err) {
    if (err.name === 'CastError') return res.status(404).json({ message: 'Not found' });
    res.status(500).json({ message: 'Server error' });
  }
});

module.exports = router;
