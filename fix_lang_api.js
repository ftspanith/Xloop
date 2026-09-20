const mongoose = require('mongoose');
const axios = require('axios');
require('dotenv').config();

const omdbKey = '43930ec';

async function fetchOMDBLang(title, year) {
  try {
    const params = { t: title, apikey: omdbKey, type: 'movie' };
    if (year) params.y = year;
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 5000 });
    const d = res.data;
    if (!d || d.Response === 'False') return null;
    if (d.Language && d.Language !== 'N/A') {
      return d.Language.split(',')[0].trim();
    }
    return null;
  } catch (err) {
    return null;
  }
}

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  const movies = await Movie.find({ language: 'Hindi' });
  console.log(`Found ${movies.length} movies currently labeled as Hindi. Re-checking with OMDB...`);

  let updated = 0;
  for (const movie of movies) {
    const realLang = await fetchOMDBLang(movie.title, movie.year);
    if (realLang && realLang !== 'Hindi') {
      movie.language = realLang;
      // Also fix downloads that got inherited as Hindi
      for (const dl of movie.downloads) {
        if (dl.language === 'Hindi') dl.language = realLang;
      }
      await movie.save();
      updated++;
      console.log(` Fixed ${movie.title} -> ${realLang}`);
    } else {
      process.stdout.write('.');
    }
  }

  console.log(`\nDone! Fixed ${updated} falsely labeled Hindi movies.`);
  process.exit(0);
});
