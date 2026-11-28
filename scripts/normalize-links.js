#!/usr/bin/env node
// scripts/normalize-links.js — Database link normalization migration
// Canonicalizes GDFlix, HubCloud, TMBCloud mirrors and updates host + isFast tags.
// Usage: node scripts/normalize-links.js [--dry-run]
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Movie    = require('../models/Movie');
const { detectHost, normalizeGdflixUrl: parserNormalizeGdflixUrl } = require('../utils/parser');

const IS_DRY_RUN = process.argv.includes('--dry-run');

const GDFLIX_RE   = /^https?:\/\/(?:[^/]+\.)?(?:gdflix\.(?:dev|to|one|link|net|dad|cfd|io|xyz)|gdlink\.dev)/i;
const HUBCLOUD_RE = /^https?:\/\/(?:[^/]+\.)?(?:hubcloud\.(?:foo|one|art|cx|lol|bz|club|in|to|work|zone|dev|me|best)|drivehub\.(?:dev|to|in|online))/i;

function normalizeUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(String(url).trim());
    if (GDFLIX_RE.test(parsed.toString())) {
      parsed.protocol = 'https:';
      parsed.hostname = 'gdflix.dev';
      parsed.port = '';
      return parsed.toString();
    }
    if (HUBCLOUD_RE.test(parsed.toString())) {
      parsed.protocol = 'https:';
      parsed.hostname = 'hubcloud.one';
      parsed.port = '';
      return parsed.toString();
    }
    return parserNormalizeGdflixUrl(parsed.toString());
  } catch (_) {}
  return url;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log(`[OK] Connected to MongoDB (${IS_DRY_RUN ? 'DRY RUN' : 'LIVE'})`);
  const movies = await Movie.find({}).lean();
  console.log(`[INFO] Scanning ${movies.length} movies...`);
  let updatedMovies = 0, updatedLinks = 0;
  for (const movie of movies) {
    let dirty = false;
    for (const dl of (movie.downloads || [])) {
      for (const link of (dl.links || [])) {
        const oldUrl = String(link.url || '');
        const n = normalizeUrl(oldUrl);
        const newHost = detectHost(n);
        const isFast = /gdflix|hubcloud|gdlink|tmbcloud/i.test(n);
        if (n !== oldUrl || (link.host || 'Download') !== newHost || (isFast && !link.isFast)) {
          link.url = n;
          link.host = newHost;
          if (isFast) link.isFast = true;
          dirty = true;
          updatedLinks++;
        }
      }
    }
    if (dirty) {
      if (!IS_DRY_RUN) {
        await Movie.updateOne({ _id: movie._id }, { $set: { downloads: movie.downloads } });
      }
      updatedMovies++;
      process.stdout.write(`\r  ${updatedMovies} movies fixed (${updatedLinks} links)...`);
    }
  }
  console.log(`\n[DONE] ${IS_DRY_RUN ? 'Would normalize' : 'Normalized'} ${updatedLinks} links in ${updatedMovies} movies.`);
  await mongoose.disconnect();
}
run().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
