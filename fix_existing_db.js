/**
 * fix_existing_db.js - Cleanup and normalization for existing Movie documents in MongoDB.
 * 
 * Fixes:
 *   1. Remove blocked/dead host links (vflix, vifix, gofile, dtflix, dotflix)
 *   2. Deduplicate URLs within each download group
 *   3. Dedup & merge download groups (same quality + season + episode + shared host)
 *      - Preserves metadata (filename, size, codec, hdr, audio, source) when merging
 *      - Prioritizes specific languages over 'Multi'
 *   4. Backfill missing codecs from filename
 *   5. Enforce 18-link total cap per movie
 *   6. Remove empty download groups
 *   7. Clear misleading identical sizes across different-quality groups (parser artifact)
 *   8. Recompute aggregates:
 *      - True best quality via QUALITY_ORDER ('4K' > '1080p' > '720p' > ...)
 *      - Sorted formats array
 *      - Normalized title-cased languages and codecs
 *      - Total seasons count for TV series
 * 
 * Usage:
 *   node fix_existing_db.js             # Apply fixes to MongoDB
 *   node fix_existing_db.js --dry-run   # Preview changes without modifying DB
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Movie    = require('./models/Movie');
const { detectHost, toMB, detectCodec } = require('./utils/parser');

const IS_DRY_RUN = process.argv.includes('--dry-run');

const BLOCKED_RE    = [/vflix\./i, /vifix\./i, /gofile\.io/i, /dtflix\./i, /dotflix\./i];
const MAX_LINKS     = 18;
const QUALITY_ORDER = ['4K', '1080p', '720p', '480p', '360p', 'HD'];

function recompute(downloads = [], currentMovie = {}) {
  // Sort downloads: highest quality first, then largest size first
  downloads.sort((a, b) => {
    const qa = QUALITY_ORDER.indexOf(a.quality);
    const qb = QUALITY_ORDER.indexOf(b.quality);
    const qi = (qa === -1 ? 99 : qa) - (qb === -1 ? 99 : qb);
    if (qi !== 0) return qi;
    return toMB(b.size) - toMB(a.size);
  });

  const formats = [...new Set(downloads.map(d => d.quality).filter(Boolean))].sort((a, b) => {
    const qa = QUALITY_ORDER.indexOf(a);
    const qb = QUALITY_ORDER.indexOf(b);
    return (qa === -1 ? 99 : qa) - (qb === -1 ? 99 : qb);
  });

  const bestQuality = QUALITY_ORDER.find(q => formats.includes(q)) || formats[0] || '1080p';

  // Capitalize & normalize languages
  const allLangs = [];
  downloads.forEach(d => {
    if (d.language) {
      d.language.split(',').forEach(l => {
        const c = l.trim();
        if (c && c.toLowerCase() !== 'unknown') {
          allLangs.push(c.charAt(0).toUpperCase() + c.slice(1).toLowerCase());
        }
      });
    }
  });
  const languages = [...new Set(allLangs)].filter(Boolean);

  // Extract all distinct codecs (fallback to filename detection)
  const codecs = [...new Set(downloads.map(d => d.codec || detectCodec(d.filename)).filter(c => c && c !== 'Other'))];

  const update = { formats, quality: bestQuality, languages, codecs };

  // If primary language is empty, fill from detected languages
  if ((!currentMovie.language || currentMovie.language === 'Unknown') && languages.length > 0) {
    update.language = languages[0];
  }

  // For series/anime, update totalSeasons if valid seasons exist
  if (currentMovie.type === 'series' || currentMovie.type === 'anime') {
    const validSeasons = new Set(downloads.map(d => d.season).filter(s => s != null && s > 0));
    if (validSeasons.size > 0) {
      update.totalSeasons = Math.max(currentMovie.totalSeasons || 0, validSeasons.size);
    }
  }

  return update;
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error('❌ MONGODB_URI is not defined in .env');
    process.exit(1);
  }

  console.log(`\n========================================`);
  console.log(` XLOOP — DB Cleanup & Optimization Script`);
  console.log(` Mode: ${IS_DRY_RUN ? '🔍 DRY RUN (No changes will be saved)' : '⚡ LIVE RUN (Writing fixes to DB)'}`);
  console.log(`========================================\n`);

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, family: 4 });
  console.log('✓ Connected to MongoDB.\n');

  const total = await Movie.countDocuments();
  console.log(`Processing ${total} documents...\n`);

  let fixed = 0;
  let skipped = 0;
  let errors = 0;
  const changesSummary = {
    blockedLinksRemoved: 0,
    groupsMerged: 0,
    emptyGroupsRemoved: 0,
    cappedLinks: 0,
    clearedMisleadingSizes: 0,
    codecsBackfilled: 0,
    qualityCorrected: 0
  };

  const cursor = Movie.find({}).lean().cursor();

  for await (const movie of cursor) {
    let changed = false;
    let downloads = (movie.downloads || []).map(d => ({
      ...d,
      links: (d.links || []).map(l => ({ ...l }))
    }));

    // 1. Remove blocked/dead hosts and normalize URLs
    downloads = downloads.map(dl => {
      const beforeCount = dl.links.length;
      dl.links = dl.links.filter(l => {
        if (!l.url) return false;
        if (BLOCKED_RE.some(r => r.test(l.url))) {
          changesSummary.blockedLinksRemoved++;
          return false;
        }
        return true;
      });

      // Deduplicate identical URLs within the same download group
      const seenUrls = new Set();
      const uniqueLinks = [];
      for (const l of dl.links) {
        const cleanUrl = (l.url || '').replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
        if (seenUrls.has(cleanUrl)) continue;
        seenUrls.add(cleanUrl);
        // Ensure host and isFast are accurate
        l.url = cleanUrl;
        l.host = detectHost(cleanUrl);
        l.isFast = /gdflix|hubcloud|gdlink/i.test(cleanUrl);
        uniqueLinks.push(l);
      }
      if (uniqueLinks.length !== dl.links.length) changed = true;
      dl.links = uniqueLinks;

      if (dl.links.length !== beforeCount) changed = true;
      return dl;
    });

    // 2. Remove empty download groups
    const preEmptyCount = downloads.length;
    downloads = downloads.filter(dl => dl.links && dl.links.length > 0);
    if (downloads.length !== preEmptyCount) {
      changesSummary.emptyGroupsRemoved += (preEmptyCount - downloads.length);
      changed = true;
    }

    // 3. Backfill codec from filename if missing
    for (const dl of downloads) {
      if (!dl.codec || dl.codec === 'Other') {
        const detected = detectCodec(dl.filename);
        if (detected && detected !== 'Other') {
          dl.codec = detected;
          changesSummary.codecsBackfilled++;
          changed = true;
        }
      }
    }

    // 4. Dedup & merge download groups: same quality + season + episode + shared host
    const merged = [];
    for (const dl of downloads) {
      const q  = dl.quality || '';
      const s  = dl.season  ?? null;
      const ep = dl.episode ?? null;
      const dlHosts = new Set(dl.links.map(l => l.host || detectHost(l.url)));

      let placed = false;
      for (const ex of merged) {
        const qOk  = ex.quality === q;
        const seOk = (ex.season ?? null) == s && (ex.episode ?? null) == ep;
        if (!qOk || !seOk) continue;

        const exHosts = new Set(ex.links.map(l => l.host || detectHost(l.url)));
        const shared  = [...dlHosts].some(h => exHosts.has(h));
        if (!shared) continue;

        // Merge links
        const exUrls = new Set(ex.links.map(l => l.url));
        for (const link of dl.links) {
          if (!exUrls.has(link.url)) {
            ex.links.push(link);
            exUrls.add(link.url);
            changed = true;
          }
        }

        // Fill missing metadata from dl if ex didn't have it
        if (!ex.filename && dl.filename) { ex.filename = dl.filename; changed = true; }
        if (!ex.size && dl.size)         { ex.size = dl.size; changed = true; }
        if ((!ex.codec || ex.codec === 'Other') && dl.codec && dl.codec !== 'Other') {
          ex.codec = dl.codec; changed = true;
        }
        if (!ex.hdr && dl.hdr)           { ex.hdr = dl.hdr; changed = true; }
        if (!ex.audio && dl.audio)       { ex.audio = dl.audio; changed = true; }
        if (!ex.source && dl.source)     { ex.source = dl.source; changed = true; }

        // Prefer specific language over 'Multi' or empty
        if (dl.language && dl.language !== 'Multi' && (!ex.language || ex.language === 'Multi')) {
          ex.language = dl.language;
          changed = true;
        }

        changesSummary.groupsMerged++;
        placed = true;
        break;
      }
      if (!placed) merged.push(dl);
    }
    if (merged.length !== downloads.length) changed = true;
    downloads = merged;

    // 5. Enforce 18-link total cap per movie
    const totalLinks = downloads.reduce((sum, d) => sum + d.links.length, 0);
    if (totalLinks > MAX_LINKS) {
      changed = true;
      changesSummary.cappedLinks += (totalLinks - MAX_LINKS);
      let remaining = MAX_LINKS;
      downloads = downloads.map(dl => {
        const keep = Math.min(dl.links.length, remaining);
        remaining  = Math.max(0, remaining - keep);
        return { ...dl, links: dl.links.slice(0, keep) };
      }).filter(dl => dl.links.length > 0);
    }

    // 6. Clear identical size strings copied across DIFFERENT quality groups (parser artifact)
    const groupsWithSize = downloads.filter(d => d.size && toMB(d.size) > 0);
    if (groupsWithSize.length >= 2) {
      const sizeMap = {};
      for (const d of groupsWithSize) {
        const key = (d.size || '').toLowerCase().replace(/\s+/g, '');
        if (!sizeMap[key]) sizeMap[key] = [];
        sizeMap[key].push(d);
      }
      for (const group of Object.values(sizeMap)) {
        if (group.length < 2) continue;
        const uniqueQualities = new Set(group.map(d => d.quality));
        if (uniqueQualities.size > 1) {
          for (const d of group) {
            d.size = '';
            changed = true;
            changesSummary.clearedMisleadingSizes++;
          }
        }
      }
    }

    // 7. Check if aggregates or quality changed
    const agg = recompute(downloads, movie);
    if (movie.quality !== agg.quality) {
      changesSummary.qualityCorrected++;
      changed = true;
    }
    if (JSON.stringify(movie.formats || []) !== JSON.stringify(agg.formats)) {
      changed = true;
    }
    if (JSON.stringify(movie.codecs || []) !== JSON.stringify(agg.codecs)) {
      changed = true;
    }

    if (!changed) {
      skipped++;
      continue;
    }

    // Save changes
    if (!IS_DRY_RUN) {
      try {
        await Movie.findByIdAndUpdate(movie._id, {
          $set: { downloads, ...agg }
        });
        fixed++;
      } catch (err) {
        errors++;
        console.error(`\n❌ Error updating "${movie.title}": ${err.message}`);
      }
    } else {
      fixed++;
    }

    process.stdout.write(`\r  [${IS_DRY_RUN ? 'Preview' : 'Saved'}] Fixed: ${fixed}  |  Unchanged: ${skipped}  |  Errors: ${errors}   `);
  }

  console.log(`\n\n========================================`);
  console.log(` Cleanup Summary (${IS_DRY_RUN ? 'DRY RUN' : 'LIVE'}):`);
  console.log(`========================================`);
  console.log(`  Total documents processed: ${total}`);
  console.log(`  Documents needing fixes  : ${fixed}`);
  console.log(`  Documents already clean  : ${skipped}`);
  console.log(`  Errors                   : ${errors}`);
  console.log(`\nDetailed Breakdown:`);
  console.log(`  • Blocked host links removed       : ${changesSummary.blockedLinksRemoved}`);
  console.log(`  • Empty download groups removed    : ${changesSummary.emptyGroupsRemoved}`);
  console.log(`  • Duplicate groups merged          : ${changesSummary.groupsMerged}`);
  console.log(`  • Excess links capped (>18 links)  : ${changesSummary.cappedLinks}`);
  console.log(`  • Misleading identical sizes cleared: ${changesSummary.clearedMisleadingSizes}`);
  console.log(`  • Missing codecs backfilled        : ${changesSummary.codecsBackfilled}`);
  console.log(`  • Movie quality tags corrected     : ${changesSummary.qualityCorrected}`);
  console.log(`========================================\n`);

  if (IS_DRY_RUN) {
    console.log(`💡 To apply these changes to MongoDB, run without --dry-run:`);
    console.log(`   node fix_existing_db.js\n`);
  } else {
    console.log(`✓ All fixes successfully committed to MongoDB!\n`);
  }

  await mongoose.disconnect();
}

run().catch(e => {
  console.error('\n❌ Fatal error:', e);
  process.exit(1);
});
