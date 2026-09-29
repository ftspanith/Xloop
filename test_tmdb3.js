require('dotenv').config();
const axios = require('axios');
const TMDB_KEY = process.env.TMDB_KEY;
async function test() {
  const q = 'Jumanji The Next Level';
  const res = await axios.get('https://api.themoviedb.org/3/search/movie', {
    params: { api_key: TMDB_KEY, query: q, include_adult: false, page: 1 },
    timeout: 10000
  });
  console.log(res.data.results[0]);
}
test().catch(console.error);
