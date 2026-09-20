const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const omdbKey = '43930ec';

async function fetchOMDB(title, year, apiKey) {
  try {
    const params = { t: title, apikey: apiKey, type: 'movie', plot: 'short' };
    if (year) params.y = year;
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 5000 });
    const d = res.data;
    if (!d || d.Response === 'False') return null;
    const poster = (d.Poster && d.Poster !== 'N/A') ? d.Poster : '';
    return poster;
  } catch (err) {
    return null;
  }
}

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  const movies = await Movie.find({ $or: [{ poster: '' }, { poster: null }] });
  console.log(`Found ${movies.length} movies missing posters. Fetching from OMDB...`);

  let updated = 0;
  for (const movie of movies) {
    const poster = await fetchOMDB(movie.title, movie.year, omdbKey);
    if (poster) {
      movie.poster = poster;
      await movie.save();
      updated++;
      console.log(` [${updated}] Found poster for: ${movie.title}`);
    } else {
      console.log(` No OMDB poster for: ${movie.title}`);
    }
  }

  console.log(`Done! Updated ${updated} out of ${movies.length} missing posters.`);
  process.exit(0);
});
