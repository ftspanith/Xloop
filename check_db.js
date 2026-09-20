const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  const gulabis = await Movie.find({ title: /Gulabi/i });
  for (const g of gulabis) {
    console.log(JSON.stringify({
      title: g.title,
      language: g.language,
      year: g.year,
      downloads: g.downloads.map(d => ({ filename: d.filename }))
    }, null, 2));
  }
  process.exit(0);
});
