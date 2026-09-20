const mongoose = require('mongoose');
require('dotenv').config();
const Movie = require('./models/Movie');

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected');
  try {
    const res = await Movie.findOne({ title: { $regex: '^$', $options: 'i' } });
    console.log('Result:', res ? res.title : null);
  } catch(e) {
    console.error(e);
  }
  mongoose.disconnect();
}
run();
