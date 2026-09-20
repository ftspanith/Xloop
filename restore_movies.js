require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Movie = require('./models/Movie');

const TMDB_KEY = process.env.TMDB_API_KEY;

const toRestore = [
  { title: 'Gangster Squad', year: 2013 },
  { title: 'Gangs of New York', year: 2002 },
  { title: 'Kingsman: The Secret Service', year: 2014 },
  { title: 'World War Z', year: 2013 },
  { title: 'Pirates of the Caribbean: Dead Men Tell No Tales', year: 2017 },
  { title: 'Pirates of the Caribbean: On Stranger Tides', year: 2011 },
  { title: "Pirates of the Caribbean: At World's End", year: 2007 },
  { title: 'Gangotri', year: 2003 },
  { title: 'Anni Manchi Sakunamule', year: 2023 },
  { title: '180', year: 2011 },
];

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  for (const m of toRestore) {
    const exists = await Movie.findOne({ title: { $regex: m.title, $options: 'i' } });
    if (exists) { console.log('⏭️ Already exists:', m.title); continue; }

    try {
      const res = await axios.get('https://api.themoviedb.org/3/search/multi', {
        params: { api_key: TMDB_KEY, query: m.title, year: m.year }
      });
      const r = (res.data.results || [])[0];
      if (!r) { console.log('❓ Not found on TMDB:', m.title); continue; }

      const detail = await axios.get(`https://api.themoviedb.org/3/${r.media_type}/${r.id}`, {
        params: { api_key: TMDB_KEY }
      });
      const d = detail.data;

      await Movie.create({
        title: d.title || d.name || m.title,
        year: m.year,
        type: r.media_type === 'tv' ? 'series' : 'movie',
        poster: d.poster_path ? `https://image.tmdb.org/t/p/w500${d.poster_path}` : '',
        backdrop: d.backdrop_path ? `https://image.tmdb.org/t/p/w1280${d.backdrop_path}` : '',
        description: d.overview || '',
        genre: (d.genres || []).map(g => g.name),
        rating: d.vote_average || 0,
        language: 'Telugu',
        downloads: [],
      });
      console.log('✅ Restored:', d.title || d.name);
    } catch (e) {
      console.log('❌', m.title, '-', e.message);
    }
  }
  console.log('\nDone! Total:', await Movie.countDocuments());
  mongoose.disconnect();
});
