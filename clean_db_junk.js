require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');
const { isJunkTitle } = require('./utils/parser');

async function clean() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log("Connected to MongoDB.");
  
  const movies = await Movie.find({}, 'title year');
  let deleted = 0;
  
  for (const m of movies) {
    if (!m.title || m.title.length < 2 || isJunkTitle(m.title) || m.title === '#') {
      console.log(`Deleting junk movie: "${m.title}" (${m.year})`);
      await Movie.deleteOne({ _id: m._id });
      deleted++;
    }
  }
  
  console.log(`Deleted ${deleted} junk movies.`);
  process.exit(0);
}
clean();
