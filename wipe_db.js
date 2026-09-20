require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');
const Series = require('./models/Series');
const Episode = require('./models/Episode');

async function wipe() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');
  
  const mRes = await Movie.deleteMany({});
  const sRes = await Series.deleteMany({});
  const eRes = await Episode.deleteMany({});
  
  console.log(`Successfully deleted ${mRes.deletedCount} movies, ${sRes.deletedCount} series, and ${eRes.deletedCount} episodes! Database is now 100% fresh.`);
  process.exit(0);
}
wipe();
