require('dotenv').config();
const mongoose = require('mongoose');
const axios = require('axios');
const Movie = require('./models/Movie');

async function extractSizeFromWeb(url) {
  try {
    const { execSync } = require('child_process');
    const html = execSync(`curl -sL "${url}"`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] });
    
    // Pattern 1: Size : 7.11GB
    let m = html.match(/Size\s*:\s*([\d\.]+\s*(?:GB|MB))/i);
    if (m) return m[1].trim();

    // Pattern 2: <strong>Size:</strong> 7.11 GB
    m = html.match(/Size.*?<\/.*?>\s*([\d\.]+\s*(?:GB|MB))/i);
    if (m) return m[1].trim();

    // Generic fallback: just find the first obvious file size in the HTML
    m = html.match(/>[^<]*?([\d\.]+\s*(?:GB|MB))[^>]*?</i);
    if (m) return m[1].trim();
    
    return null;
  } catch (err) {
    console.log(`  [HTTP Error] Failed to fetch ${url}: ${err.message}`);
    return null;
  }
}

async function fixMissingSizes() {
  await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/xloop');
  console.log('🗄️ Connected to DB. Looking for missing file sizes...\n');

  const movies = await Movie.find({});
  let fixedCount = 0;

  for (const movie of movies) {
    let modified = false;

    // Check movie downloads
    if (movie.downloads && movie.downloads.length > 0) {
      for (const dl of movie.downloads) {
        if (!dl.size || dl.size.trim() === '') {
          const link = dl.links && dl.links[0] ? (dl.links[0].bypassedUrl || dl.links[0].url) : null;
          if (link && link.startsWith('http')) {
            console.log(`🔍 Checking Movie: ${movie.title} - ${dl.quality}`);
            const fetchedSize = await extractSizeFromWeb(link);
            if (fetchedSize) {
              console.log(`   ✅ Found size: ${fetchedSize}`);
              dl.size = fetchedSize;
              modified = true;
              fixedCount++;
            } else {
              console.log(`   ❌ Could not find size on page.`);
            }
          }
        }
      }
    }

    // Check series seasons/episodes
    if (movie.seasons && movie.seasons.length > 0) {
      for (const season of movie.seasons) {
        for (const ep of season.episodes) {
          for (const dl of ep.downloads) {
            if (!dl.size || dl.size.trim() === '') {
              const link = dl.links && dl.links[0] ? (dl.links[0].bypassedUrl || dl.links[0].url) : null;
              if (link && link.startsWith('http')) {
                console.log(`🔍 Checking Series: ${movie.title} S${season.seasonNumber}E${ep.episodeNumber}`);
                const fetchedSize = await extractSizeFromWeb(link);
                if (fetchedSize) {
                  console.log(`   ✅ Found size: ${fetchedSize}`);
                  dl.size = fetchedSize;
                  modified = true;
                  fixedCount++;
                } else {
                  console.log(`   ❌ Could not find size on page.`);
                }
              }
            }
          }
        }
      }
    }

    if (modified) {
      // mongoose mixed array modification trigger
      movie.markModified('downloads');
      movie.markModified('seasons');
      await movie.save();
    }
  }

  console.log(`\n🎉 Finished! Fixed ${fixedCount} missing file sizes.`);
  process.exit(0);
}

fixMissingSizes();
