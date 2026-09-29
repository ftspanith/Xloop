const { default: axios } = require('axios');
async function searchOMDB(title) {
  const params = { t: title, apikey: 'd3d1bfdb', type: 'movie', plot: 'short' };
  try {
    const res = await axios.get('https://www.omdbapi.com/', { params, timeout: 8000 });
    return res.data;
  } catch (e) { return e.message; }
}
searchOMDB('Jumanji The Next Level').then(r => console.log(r));
