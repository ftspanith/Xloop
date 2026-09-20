require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

async function fixTitles() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB...');

  const movies = await Movie.find({});
  let fixedCount = 0;

  for (let m of movies) {
    if (!m.title) continue;
    let newTitle = m.title;

    // Fix my previous mistake: if a title ends with `(01-10` or similar unclosed parenthesis from the right, 
    // it's likely missing a closing parenthesis because I stripped it.
    if (/E\(\d+-\d+$/.test(newTitle)) {
      newTitle = newTitle + ')';
    }

    // Fix the user's issue: Stray unclosed parenthesis at the end of the title (e.g. `KA (`)
    if (newTitle.endsWith('(') || newTitle.endsWith('[') || newTitle.endsWith('-')) {
      newTitle = newTitle.substring(0, newTitle.length - 1).trim();
    }

    if (m.title !== newTitle) {
      console.log(`Fixing: "${m.title}" -> "${newTitle}"`);
      m.title = newTitle;
      await m.save();
      fixedCount++;
    }
  }

  console.log(`\nFinished! Fixed ${fixedCount} movie titles.`);
  process.exit(0);
}

fixTitles().catch(console.error);
