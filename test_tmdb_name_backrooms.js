require('dotenv').config();
const axios = require('axios');
async function test() {
  const q = 'Name : Backrooms';
  const res = await axios.get('https://api.themoviedb.org/3/search/movie', {
    params: { api_key: process.env.TMDB_API_KEY, query: q, include_adult: false, page: 1 },
    timeout: 10000
  });
  console.log(res.data.results[0]);
}
test().catch(console.error);
