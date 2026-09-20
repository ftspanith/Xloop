require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

async function fixFilenames() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB...');

  const movies = await Movie.find({ 'downloads.filename': /Unknown Size/ });
  let fixedCount = 0;

  for (let m of movies) {
    let changed = false;
    for (let d of m.downloads) {
      if (d.filename && d.filename.includes('[Unknown Size]')) {
        // E.g. "Jabardasth - HD - [Unknown Size]" -> "Jabardasth (HD)"
        const original = d.filename;
        d.filename = m.title + (d.quality ? ` (${d.quality})` : '');
        console.log(`Changed: "${original}" -> "${d.filename}"`);
        changed = true;
      }
    }
    if (changed) {
      await m.save();
      fixedCount++;
    }
  }

  console.log(`\nFinished! Fixed filenames in ${fixedCount} movies.`);
  process.exit(0);
}

fixFilenames().catch(console.error);
