/**
 * fix_existing_db.js - One-time cleanup for existing Movie documents.
 * Fixes:
 *   1. Remove blocked host links (vflix, vifix, gofile)
 *   2. Dedup download groups: same quality + same host → merge
 *   3. Enforce 18-link total cap per movie
 *   4. Remove empty download groups
 *   5. Recompute aggregates
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const Movie = require('./models/Movie');

const BLOCKED_RE = [/vflix\./i, /vifix\./i, /gofile\.io/i, /dtflix\./i, /dotflix\./i];
const MAX_LINKS  = 18;

function detectHost(url = '') {
  if (/gdflix\./i.test(url))    return 'GDFlix';
  if (/hubcloud\./i.test(url))  return 'HubCloud';
  if (/drivehub\./i.test(url))  return 'HubCloud';
  if (/dtflix\./i.test(url))    return 'DTFlix';
  if (/dotflix\./i.test(url))   return 'DTFlix';
  if (/tmbcloud\./i.test(url))  return 'TMBCloud';
  if (/filepress\./i.test(url)) return 'FilePress';
  if (/gdlink\./i.test(url))    return 'GDFlix';
  return 'Other';
}

function recompute(downloads = []) {
  const formats   = [...new Set(downloads.map(d => d.quality).filter(Boolean))];
  const quality   = formats[0] || '';
  const languages = [...new Set(downloads.flatMap(d =>
    (d.language||'').split(',').map(l => l.trim()).filter(Boolean)
  ))];
  const codecs = [...new Set(downloads.map(d => d.codec).filter(c => c && c !== 'Other'))];
  return { formats, quality, languages, codecs };
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS:10000, family:4 });
  console.log('Connected.');

  const total = await Movie.countDocuments();
  console.log(`Processing ${total} movies...\n`);

  let fixed = 0, skipped = 0, errors = 0;
  const cursor = Movie.find({}).lean().cursor();

  for await (const movie of cursor) {
    let changed = false;
    let downloads = (movie.downloads || []).map(d => ({ ...d, links: [...(d.links||[])] }));

    // 1. Remove blocked host links
    downloads = downloads.map(dl => {
      const before = dl.links.length;
      dl.links = dl.links.filter(l => !BLOCKED_RE.some(r => r.test(l.url || '')));
      if (dl.links.length !== before) changed = true;
      return dl;
    });

    // 2. Remove empty groups
    const preEmpty = downloads.length;
    downloads = downloads.filter(dl => dl.links.length > 0);
    if (downloads.length !== preEmpty) changed = true;

    // 3. Dedup: same quality + same host → merge into one group
    const merged = [];
    for (const dl of downloads) {
      const q  = dl.quality || '';
      const s  = dl.season  ?? null;
      const ep = dl.episode ?? null;
      const dlHosts = new Set(dl.links.map(l => detectHost(l.url)));

      let placed = false;
      for (const ex of merged) {
        const qOk  = ex.quality === q;
        const seOk = (ex.season ?? null) == s && (ex.episode ?? null) == ep;
        if (!qOk || !seOk) continue;

        const exHosts = new Set(ex.links.map(l => detectHost(l.url)));
        const shared  = [...dlHosts].some(h => exHosts.has(h));
        if (!shared) continue;

        // Merge unique URLs in
        const exUrls = new Set(ex.links.map(l => l.url));
        for (const link of dl.links) {
          if (!exUrls.has(link.url)) {
            ex.links.push(link);
            exUrls.add(link.url);
            changed = true;
          }
        }
        // Keep more specific language
        if (dl.language && dl.language !== 'Multi' && (!ex.language || ex.language === 'Multi')) {
          ex.language = dl.language; changed = true;
        }
        placed = true; break;
      }
      if (!placed) merged.push(dl);
    }
    if (merged.length !== downloads.length) changed = true;
    downloads = merged;

    // 4. Enforce 18-link total cap
    const totalLinks = downloads.reduce((s, d) => s + d.links.length, 0);
    if (totalLinks > MAX_LINKS) {
      changed = true;
      let remaining = MAX_LINKS;
      downloads = downloads.map(dl => {
        const keep   = Math.min(dl.links.length, remaining);
        remaining    = Math.max(0, remaining - keep);
        return { ...dl, links: dl.links.slice(0, keep) };
      }).filter(dl => dl.links.length > 0);
    }

    if (!changed) { skipped++; continue; }

    // 5. Save with recomputed aggregates
    const agg = recompute(downloads);
    try {
      await Movie.findByIdAndUpdate(movie._id, {
        $set: { downloads, ...agg }
      });
      fixed++;
      process.stdout.write(`\r  Fixed: ${fixed}  Skipped: ${skipped}  Errors: ${errors}   `);
    } catch(e) {
      errors++;
      console.error(`\n  ERR ${movie.title}: ${e.message}`);
    }
  }

  console.log(`\n\nComplete!`);
  console.log(`  Fixed  : ${fixed}`);
  console.log(`  Skipped: ${skipped}`);
  console.log(`  Errors : ${errors}`);
  await mongoose.disconnect();
}

run().catch(e => { console.error(e); process.exit(1); });
