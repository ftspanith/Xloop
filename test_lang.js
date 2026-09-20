const axios = require('axios');
const tmdbKey = 'c3edc5936d55734cc39fc4fdf3a45c60'; // We'll just check if it's there
const omdbKey = '43930ec';

async function test(title, year) {
  console.log(`\nTesting ${title} (${year})...`);
  
  try {
    const tmdbRes = await axios.get(`https://api.themoviedb.org/3/search/movie?api_key=${tmdbKey}&query=${title}`);
    if (tmdbRes.data.results.length) {
      const top = tmdbRes.data.results[0];
      console.log(`TMDB: ID ${top.id}, Original Lang: ${top.original_language}`);
    } else {
      console.log('TMDB: No results');
    }
  } catch (e) { console.log('TMDB Err'); }

  try {
    const omdbRes = await axios.get(`https://www.omdbapi.com/?t=${title}&y=${year}&apikey=${omdbKey}`);
    console.log(`OMDB: Language = ${omdbRes.data.Language}`);
  } catch (e) { console.log('OMDB Err'); }
}

test('Gulabi', '1996');
