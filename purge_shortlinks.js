// purge_shortlinks.js — Remove ALL shortlink URLs from every movie's downloads
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

// Every known shortlink domain pattern
const SHORTLINK_RE = /oyy\.|ouo\.|gplinks\.|softurl\.|arolinks\.|vplink\.|anyshorturl\.|droplink\.|mdisk\.|terabox|1024tera\.|bit\.ly|tinyurl\.|rb\.gy|t\.ly\/|cutt\.ly|linkvertise\.|adf\.ly|short\.io|rebrand\.ly|shrinkme\.|earnload\.|iir\.ai|kglinks\.|linksace\.|dl\.fliprs\.|techyjagran\.|safelinking\.|iiv\.li|urlo\.cc|go2share\.|oke\.io|linksly\.|shrink\.|reviewsbuddy\.|nowshorturl\.|nanolinks\.|tnshort\.|minifyurls\.|urllinkshort\.|shorturl\.|shrt\.me/i;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop');
  console.log('Connected to MongoDB');

  // Also remove any link with host === 'Shortlink' regardless of URL
  const movies = await Movie.find({
    $or: [
      { 'downloads.links.host': 'Shortlink' },
      { 'downloads.links.url': { $regex: /oyy\.|ouo\.|gplinks\.|softurl\.|vplink\.|droplink\.|mdisk\.|terabox|bit\.ly|tinyurl\.|rb\.gy|t\.ly\/|cutt\.ly|linkvertise\.|adf\.ly|shrinkme\.|earnload\.|kglinks\.|safelinking\.|shorturl\.|shrt\.me/i } }
    ]
  });

  console.log(`Found ${movies.length} movies with shortlinks`);

  let totalRemoved = 0;
  let dlsRemoved = 0;
  let processed = 0;

  for (const movie of movies) {
    let changed = false;

    for (const dl of movie.downloads) {
      if (!dl.links) continue;
      const before = dl.links.length;
      dl.links = dl.links.filter(l =>
        l.host !== 'Shortlink' && !SHORTLINK_RE.test(l.url)
      );
      if (dl.links.length < before) {
        totalRemoved += before - dl.links.length;
        changed = true;
      }
    }

    // Remove download slots that now have zero links
    const beforeDls = movie.downloads.length;
    movie.downloads = movie.downloads.filter(dl => dl.links && dl.links.length > 0);
    dlsRemoved += beforeDls - movie.downloads.length;

    if (changed) {
      await Movie.findByIdAndUpdate(movie._id, { $set: { downloads: movie.downloads } });
      processed++;
    }

    if (processed % 100 === 0 && processed > 0) {
      process.stdout.write(`\r  Processed ${processed}/${movies.length} movies...`);
    }
  }

  console.log(`\n✅ Done!`);
  console.log(`   Shortlink URLs removed : ${totalRemoved}`);
  console.log(`   Empty slots removed    : ${dlsRemoved}`);
  console.log(`   Movies updated         : ${processed}`);
  console.log(`   Final DB count         : ${await Movie.countDocuments()}`);

  // Verify zero remain
  const remaining = await Movie.countDocuments({
    $or: [
      { 'downloads.links.host': 'Shortlink' },
      { 'downloads.links.url': { $regex: /gplinks\.|oyy\.|ouo\.|softurl\.|droplink\.|mdisk\.|terabox/i } }
    ]
  });
  console.log(`   Shortlinks remaining   : ${remaining} (should be 0)`);

  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
