require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

async function removeSpam() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected to DB...');

  const spamKeywords = [
    'telegram', 'channel', 'join', 'backup', 'admin', 'update', 'share link', 'files channel', 
    'official updates', 'youtube channel', 'subscribe', 'download link', 'dtins', 'mux channel',
    'village cooking'
  ];

  const regex = new RegExp(spamKeywords.join('|'), 'i');

  const movies = await Movie.find({});
  let deletedCount = 0;

  for (let m of movies) {
    if (regex.test(m.title) || m.title.length > 50) {
      console.log(`Deleting spam: "${m.title}"`);
      await Movie.deleteOne({ _id: m._id });
      deletedCount++;
    }
  }

  console.log(`\nFinished! Deleted ${deletedCount} spam entries.`);
  process.exit(0);
}

removeSpam().catch(console.error);
