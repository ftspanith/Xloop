const axios = require('axios');
const cheerio = require('cheerio');
axios.get('https://m.imdb.com/find/?q=song+sung+blue', {
  headers: {
    'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_6 like Mac OS X) AppleWebKit/605.1.15'
  }
}).then(r => {
  const $ = cheerio.load(r.data);
  const nextData = $('#__NEXT_DATA__').html();
  const json = JSON.parse(nextData);
  const results = json.props.pageProps.titleResults.results;
  console.log(results.slice(0, 2).map(i => ({ title: i.titleNameText, year: i.titleReleaseText, poster: i.titlePosterImageModel?.url })));
}).catch(console.error);
