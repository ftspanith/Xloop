const mongoose = require('mongoose');
require('dotenv').config();
const Movie = require('./models/Movie');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop');
  const movie = await Movie.findOne({ title: { $regex: /#BLURAY/i } }).lean();
  console.log(movie ? movie.title : "Not found!");
  mongoose.disconnect();
}
run();
