const mongoose = require('mongoose');
require('dotenv').config();
const Movie = require('./models/Movie');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop');
  const movie = await Movie.findOne({ "downloads.filename": { $regex: /Enola.Holmes.3/i } }).lean();
  console.log(movie ? movie.title : "Not found!");
  const badMovie = await Movie.findOne({ title: { $regex: /#NF/i } }).lean();
  console.log(badMovie ? "STILL FOUND BAD MOVIE" : "NO BAD MOVIE!");
  mongoose.disconnect();
}
run();
