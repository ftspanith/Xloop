const axios = require('axios');
const cheerio = require('cheerio');

async function test() {
  const r = await axios.get('https://www.google.com/search?tbm=isch&q=Enthiran+2010+movie+poster', {
    headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
  });
  const $ = cheerio.load(r.data);
  const images = [];
  $('img').each((i, el) => {
    const src = $(el).attr('src');
    if (src && src.startsWith('http') && !src.includes('branding')) images.push(src);
  });
  console.log(images.slice(0, 4));
}
test().catch(console.error);
