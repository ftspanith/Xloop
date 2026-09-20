#!/usr/bin/env node
// test_import.js  ─ Import exactly N real movies for UI testing
// Usage: node test_import.js [limit]   (default 20)
'use strict';

require('dotenv').config();
const fs       = require('fs');
const mongoose = require('mongoose');
const axios    = require('axios');
const Movie    = require('./models/Movie');
const { cleanTitleForApi, detectHost, isJunkTitle } = require('./utils/parser');

const LIMIT = parseInt(process.argv[2] || '20', 10);
const INPUT = './bypassed_links.json';

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// Extra junk guard beyond parser
const EXTRA_JUNK = [
  /^\d+\s*[a-z0-9]+\s*(తెలుగు|தமிழ்|ಕನ್ನಡ|മലయാളം|हिन्दी)/i,
  /^(GDFlix|DTFlix|HubCloud|Mediainfo|TMBCloud|GDFLIX)$/i,
  /^(DC|GDN|KJQ|UK|AI|PK|ET|PH)$/i,
  /^Don'?t\s+download/i,
  /kbps/i,
  /^\d+\s+\d+/,
  /TEMPLATE/i,
  /^E\s*,/i,
];
function isExtraJunk(title) { return EXTRA_JUNK.some(re => re.test(title)); }

// TMDB
const TMDB_KEY = process.env.TMDB_API_KEY || '';
let _lastApi = 0;
async function throttle() {
  const wait = 280 - (Date.now() - _lastApi);
  if (wait > 0) await sleep(wait);
  _lastApi = Date.now();
}
async function searchTMDB(title, year) {
  if (!TMDB_KEY) return null;
  try {
    await throttle();
    const q  = encodeURIComponent(cleanTitleForApi(title));
    const yr = year ? `&year=${year}` : '';
    const r  = await axios.get(
      `https://api.themoviedb.org/3/search/movie?api_key=${TMDB_KEY}&query=${q}${yr}&language=en-US&page=1`,
      { timeout: 8000 }
    );
    return (r.data.results || [])[0] || null;
  } catch { return null; }
}
async function getTMDBDetails(id) {
  if (!TMDB_KEY || !id) return null;
  try {
    await throttle();
    const r = await axios.get(
      `https://api.themoviedb.org/3/movie/${id}?api_key=${TMDB_KEY}&language=en-US`,
      { timeout: 8000 }
    );
    return r.data;
  } catch { return null; }
}

async function main() {
  if (!fs.existsSync(INPUT)) { console.error('No bypassed_links.json'); process.exit(1); }
  const all = JSON.parse(fs.readFileSync(INPUT, 'utf8'));

  const valid = all.filter(b =>
    (b.bypassedUrl || b.url) &&
    b.host !== 'Shortlink' &&
    b.title && b.title.trim().length >= 3 &&
    !isJunkTitle(b.title) &&
    !isExtraJunk(b.title) &&
    !b.isSeries
  );

  const groups = {};
  for (const item of valid) {
    const key = (item.title||'').toLowerCase().trim() + '__' + (item.year||'');
    if (!groups[key]) groups[key] = [];
    groups[key].push(item);
  }

  const groupEntries = Object.entries(groups).slice(0, LIMIT);
  console.log(`\nImporting ${groupEntries.length} movies\n`);

  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop', {
    serverSelectionTimeoutMS: 30000, socketTimeoutMS: 60000, heartbeatFrequencyMS: 10000,
  });
  console.log('MongoDB connected\n');

  let added = 0, skipped = 0;

  for (const [, items] of groupEntries) {
    const rep   = items[0];
    const title = rep.title;
    const year  = rep.year;

    process.stdout.write(`  ${title} (${year || '?'}) ...`);

    const titleEsc = title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const existing = await Movie.findOne({ title: { $regex: `^${titleEsc}$`, $options: 'i' } }).lean();
    if (existing) { console.log(' already exists'); skipped++; continue; }

    const tmdbHit = await searchTMDB(title, year);
    const details  = tmdbHit ? await getTMDBDetails(tmdbHit.id) : null;

    const downloadMap = {};
    for (const item of items) {
      const sk = `${item.quality||'HD'}__${item.size||''}__${item.language||''}`;
      if (!downloadMap[sk]) {
        downloadMap[sk] = {
          quality: item.quality || 'HD', size: item.size || '',
          language: item.language || '', filename: item.filename || '',
          hdr: item.hdr || null, codec: item.codec || null,
          season: null, episode: null, links: [],
        };
      }
      const url = item.bypassedUrl || item.url;
      downloadMap[sk].links.push({ url, host: detectHost(url), isFast: item.isFast || false });
    }

    const doc = {
      title:       details?.title || title,
      year:        details?.release_date ? parseInt(details.release_date) : (year || null),
      type:        'movie',
      tmdbId:      details?.id || null,
      imdbId:      details?.imdb_id || rep.imdbId || null,
      poster:      details?.poster_path   ? `https://image.tmdb.org/t/p/w500${details.poster_path}`   : null,
      backdrop:    details?.backdrop_path ? `https://image.tmdb.org/t/p/w1280${details.backdrop_path}` : null,
      genre:       (details?.genres || []).map(g => g.name),
      rating:      details?.vote_average ? parseFloat(details.vote_average.toFixed(1)) : null,
      description: details?.overview || null,
      duration:    details?.runtime ? `${details.runtime} min` : null,
      language:    rep.language || null,
      quality:     rep.quality  || 'HD',
      downloads:   Object.values(downloadMap),
      addedAt:     new Date(),
    };

    try {
      await Movie.create(doc);
      console.log(` ADDED (tmdb:${doc.tmdbId || 'none'}, ${Object.values(downloadMap).length} slots)`);
      added++;
    } catch (e) {
      console.log(` ERROR: ${e.message.slice(0, 80)}`);
    }
  }

  console.log(`\nDone: ${added} added, ${skipped} skipped\n`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
