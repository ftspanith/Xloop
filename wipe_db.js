require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

async function wipe() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to MongoDB.');

  const mRes = await Movie.deleteMany({});

  console.log(`Successfully deleted ${mRes.deletedCount} movies. Database is now 100% fresh.`);
  process.exit(0);
}
wipe();
