const mongoose = require('mongoose');
require('dotenv').config();

mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  
  const movies = await Movie.find({ title: /Laggam/i });
  for (const m of movies) {
    m.language = 'Telugu';
    for (const dl of m.downloads) {
      dl.language = 'Telugu';
    }
    await m.save();
    console.log("Fixed " + m.title);
  }
  process.exit(0);
});
