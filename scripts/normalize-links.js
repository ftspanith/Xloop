#!/usr/bin/env node
// scripts/normalize-links.js — One-time migration
// Rewrites all GDFlix mirrors → gdflix.dev and HubCloud/DriveHub → hubcloud.one
// Usage: node scripts/normalize-links.js
'use strict';
require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const mongoose = require('mongoose');
const Movie    = require('../models/Movie');

const GDFLIX_RE   = /^https?:\/\/gdflix\.(dev|to|one|link|net|dad|cfd|xyz)/i;
const GDLINK_RE   = /^https?:\/\/gdlink\.dev/i;
const HUBCLOUD_RE = /^https?:\/\/hubcloud\.(foo|one|art|cx|lol|bz|club|in|to|work|zone|dev|me|best)/i;
const DRIVEHUB_RE = /^https?:\/\/drivehub\.(dev|to|in|online)/i;

function normalizeUrl(url) {
  if (!url) return url;
  try {
    const parsed = new URL(url);
    if (GDFLIX_RE.test(url) || GDLINK_RE.test(url))
      return `https://gdflix.dev${parsed.pathname}${parsed.search}`;
    if (HUBCLOUD_RE.test(url) || DRIVEHUB_RE.test(url))
      return `https://hubcloud.one${parsed.pathname}${parsed.search}`;
  } catch (_) {}
  return url;
}

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('[OK] Connected to MongoDB');
  const movies = await Movie.find({}).lean();
  console.log(`[INFO] Scanning ${movies.length} movies...`);
  let updatedMovies = 0, updatedLinks = 0;
  for (const movie of movies) {
    let dirty = false;
    for (const dl of (movie.downloads || [])) {
      for (const link of (dl.links || [])) {
        const n = normalizeUrl(link.url);
        if (n !== link.url) { link.url = n; dirty = true; updatedLinks++; }
      }
    }
    if (dirty) {
      await Movie.updateOne({ _id: movie._id }, { $set: { downloads: movie.downloads } });
      updatedMovies++;
      process.stdout.write(`\r  ${updatedMovies} movies fixed (${updatedLinks} links)...`);
    }
  }
  console.log(`\n[DONE] Normalized ${updatedLinks} links in ${updatedMovies} movies.`);
  await mongoose.disconnect();
}
run().catch(e => { console.error('[ERR]', e.message); process.exit(1); });
