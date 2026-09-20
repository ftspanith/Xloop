const mongoose = require('mongoose');
require('dotenv').config();
const Movie = require('./models/Movie');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB');

  const movie = await Movie.findOne({ title: /DC/i, year: 2026 });
  if (!movie) {
    console.log('Movie not found');
    process.exit(0);
  }

  console.log(`Found movie: ${movie.title} (${movie.year}) - ID: ${movie._id}`);
  console.log(`Total downloads objects: ${movie.downloads.length}`);

  // Group by filename to see duplicates
  movie.downloads.forEach((dl, i) => {
    console.log(`[${i}] ${dl.quality} | ${dl.size} | ${dl.filename}`);
    dl.links.forEach(l => console.log(`  -> ${l.url}`));
  });

  process.exit(0);
}

run();
