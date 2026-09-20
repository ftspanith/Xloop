const mongoose = require('mongoose');
require('dotenv').config();
mongoose.connect(process.env.MONGODB_URI).then(async () => {
  const Movie = require('./models/Movie');
  const m = await Movie.findOne({ 'downloads.filename': /Gulabi\.1996/i });
  if (m) {
    console.log(JSON.stringify({
      title: m.title,
      language: m.language,
      year: m.year
    }, null, 2));
  } else {
    console.log("Not found in DB");
  }
  process.exit(0);
});
