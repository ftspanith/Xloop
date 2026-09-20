// fast_dedup.js — Remove duplicate title+year records, keeping the one with the most/best data
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

async function main() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop');
  console.log('Connected');

  // Get all duplicate groups in one aggregation
  const dups = await Movie.aggregate([
    {
      $group: {
        _id: { title: { $toLower: '$title' }, year: '$year' },
        count: { $sum: 1 },
        ids: { $push: '$_id' },
        // Keep track of which has poster and most downloads
        hasPoster: { $max: { $cond: [{ $ne: ['$poster', ''] }, 1, 0] } },
      }
    },
    { $match: { count: { $gt: 1 } } },
    { $sort: { count: -1 } }
  ]);

  console.log(`Found ${dups.length} duplicate groups`);

  // Collect ALL ids-to-delete across all groups, then bulk delete once
  const allDeleteIds = [];

  for (const dup of dups) {
    // Fetch all versions, pick best one to keep (has poster + most downloads)
    const docs = await Movie.find({ _id: { $in: dup.ids } })
      .select('_id poster downloads rating');

    docs.sort((a, b) => {
      const aScore = (a.poster ? 100 : 0) + (a.downloads?.length || 0) + (a.rating || 0);
      const bScore = (b.poster ? 100 : 0) + (b.downloads?.length || 0) + (b.rating || 0);
      return bScore - aScore; // best first
    });

    const [_keep, ...toDelete] = docs;
    toDelete.forEach(d => allDeleteIds.push(d._id));
  }

  console.log(`Deleting ${allDeleteIds.length} duplicate records in bulk...`);

  // Bulk delete in batches of 500
  let deleted = 0;
  for (let i = 0; i < allDeleteIds.length; i += 500) {
    const batch = allDeleteIds.slice(i, i + 500);
    const res = await Movie.deleteMany({ _id: { $in: batch } });
    deleted += res.deletedCount;
    process.stdout.write(`\r  Deleted ${deleted}/${allDeleteIds.length}...`);
  }

  console.log(`\n✅ Done! Removed ${deleted} duplicates`);
  console.log(`📊 Final count: ${await Movie.countDocuments()} movies`);
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
