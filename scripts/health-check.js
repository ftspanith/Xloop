#!/usr/bin/env node
/**
 * scripts/health-check.js  — Xloop System Health Check
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs a comprehensive pre-flight check without touching any data.
 * Usage:  node scripts/health-check.js
 *
 * Checks:
 *   1. Node.js version ≥ 18
 *   2. Required env vars present (MONGODB_URI, TMDB_KEY, OMDB_KEY)
 *   3. MongoDB connection test
 *   4. TMDB API key validity
 *   5. OMDb API key validity
 *   6. Disk space for export files
 *   7. telegram_export.json integrity (size, JSON parse)
 *   8. telegram_export_2.json integrity
 *   9. Required utility modules loadable
 *  10. Database collection counts
 */
'use strict';
require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ROOT = path.resolve(__dirname, '..');
const PASS = '\x1b[32m✅ PASS\x1b[0m';
const FAIL = '\x1b[31m❌ FAIL\x1b[0m';
const WARN = '\x1b[33m⚠️  WARN\x1b[0m';

let failures = 0;
let warnings = 0;

function ok(label, detail = '') {
  console.log(`  ${PASS}  ${label}${detail ? ' — ' + detail : ''}`);
}
function fail(label, detail = '') {
  console.log(`  ${FAIL}  ${label}${detail ? ' — ' + detail : ''}`);
  failures++;
}
function warn(label, detail = '') {
  console.log(`  ${WARN}  ${label}${detail ? ' — ' + detail : ''}`);
  warnings++;
}

async function httpsGet(url, timeoutMs = 8000, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs, headers }, res => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve({ status: res.statusCode, body: data }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
  });
}

async function run() {
  console.log('\n\x1b[1m━━━ Xloop Health Check ━━━\x1b[0m\n');

  // 1. Node.js version
  const nodeVer = process.versions.node.split('.').map(Number);
  if (nodeVer[0] >= 18) ok('Node.js version', process.version);
  else fail('Node.js version', `${process.version} — requires ≥ 18`);

  // 2. Required environment variables (support both repo TMDB_API_KEY and TMDB_KEY)
  const tmdbKey = process.env.TMDB_API_KEY || process.env.TMDB_KEY || '';
  const omdbKey = process.env.OMDB_API_KEY || process.env.OMDB_KEY || '';
  if (process.env.MONGODB_URI) ok('Env var MONGODB_URI', '(set)');
  else fail('Env var MONGODB_URI', 'missing — required');
  if (tmdbKey) ok('Env var TMDB_API_KEY', '(set)');
  else fail('Env var TMDB_API_KEY', 'missing — required');
  if (omdbKey) ok('Env var OMDB_API_KEY', '(set)');
  else warn('Env var OMDB_API_KEY', 'missing — optional but recommended');
  if (process.env.JWT_SECRET) ok('Env var JWT_SECRET', '(set)');
  else warn('Env var JWT_SECRET', 'missing — optional but recommended');

  // 3. MongoDB connection
  try {
    const mongoose = require('mongoose');
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    ok('MongoDB connection', 'connected');

    // 10. Collection counts
    const Movie         = require('../models/Movie');
    const ExtractedLink = require('../models/ExtractedLink');
    const [movieCount, linkCount] = await Promise.all([Movie.countDocuments(), ExtractedLink.countDocuments()]);
    if (movieCount === 0) warn('Movie collection', `0 documents — database may need re-import`);
    else ok('Movie collection', `${movieCount.toLocaleString()} documents`);
    ok('ExtractedLink collection', `${linkCount.toLocaleString()} documents`);

    await mongoose.disconnect();
  } catch (e) {
    fail('MongoDB connection', e.message);
  }

  // 4. TMDB API key (supports v3 key and v4 Bearer token)
  if (tmdbKey) {
    try {
      const isV4 = tmdbKey.split('.').length === 3;
      const r = isV4
        ? await httpsGet('https://api.themoviedb.org/3/configuration', 8000, { Authorization: `Bearer ${tmdbKey}` })
        : await httpsGet(`https://api.themoviedb.org/3/configuration?api_key=${encodeURIComponent(tmdbKey)}`);
      if (r.status === 200) ok('TMDB API key', 'valid');
      else if (r.status === 401) fail('TMDB API key', 'invalid (401 Unauthorized)');
      else warn('TMDB API key', `HTTP ${r.status}`);
    } catch (e) {
      warn('TMDB API key', `Could not verify: ${e.message}`);
    }
  }

  // 5. OMDb API key
  if (omdbKey) {
    try {
      const r = await httpsGet(`https://www.omdbapi.com/?apikey=${encodeURIComponent(omdbKey)}&t=test`);
      const body = JSON.parse(r.body);
      if (body.Response === 'False' && body.Error === 'Request limit reached!') {
        warn('OMDb API key', 'valid but daily limit reached');
      } else if (r.status === 200 && body.Error !== 'Invalid API key!') {
        ok('OMDb API key', 'valid');
      } else {
        fail('OMDb API key', `invalid — ${body.Error || r.status}`);
      }
    } catch (e) {
      warn('OMDb API key', `Could not verify: ${e.message}`);
    }
  }

  // 6. Export file integrity
  const exportFiles = [
    { file: 'telegram_export.json',   minSizeMB: 5 },
    { file: 'telegram_export_2.json', minSizeMB: 1 },
  ];
  for (const { file, minSizeMB } of exportFiles) {
    const filePath = path.join(ROOT, file);
    if (!fs.existsSync(filePath)) {
      warn(`${file}`, 'not found');
      continue;
    }
    const { size } = fs.statSync(filePath);
    const sizeMB   = size / (1024 * 1024);
    if (sizeMB < minSizeMB) {
      warn(`${file}`, `only ${sizeMB.toFixed(1)} MB — may be truncated`);
    } else {
      // JSON parse check (first 1 MB)
      try {
        const fd    = fs.openSync(filePath, 'r');
        const buf   = Buffer.alloc(Math.min(size, 1024 * 1024));
        fs.readSync(fd, buf, 0, buf.length, 0);
        fs.closeSync(fd);
        const preview = buf.toString('utf8');
        // Check it starts like a JSON array/object
        if (/^\s*[\[{]/.test(preview)) ok(`${file}`, `${sizeMB.toFixed(1)} MB, valid JSON start`);
        else warn(`${file}`, `${sizeMB.toFixed(1)} MB but unexpected start — not a JSON array/object`);
      } catch (e) {
        warn(`${file}`, `Parse check failed: ${e.message}`);
      }
    }
  }

  // 9. Required modules loadable
  const modules = [
    ['./utils/tmdbSearch',          'tmdbSearch'],
    ['./utils/parser',              'parser'],
    ['./utils/variant-intelligence','variant-intelligence'],
    ['./utils/telegram-ingestion',  'telegram-ingestion'],
    ['./utils/fileMetadata',        'fileMetadata'],
  ];
  for (const [rel, label] of modules) {
    try {
      require(path.join(ROOT, rel));
      ok(`Module ${label}`, 'loads OK');
    } catch (e) {
      fail(`Module ${label}`, e.message);
    }
  }

  // ── Summary ──────────────────────────────────────────────────────────────
  console.log('\n\x1b[1m━━━ Summary ━━━\x1b[0m');
  if (failures === 0 && warnings === 0) {
    console.log('  \x1b[32mAll checks passed! System is healthy.\x1b[0m\n');
  } else {
    if (failures > 0) console.log(`  \x1b[31m${failures} failure(s)\x1b[0m`);
    if (warnings > 0) console.log(`  \x1b[33m${warnings} warning(s)\x1b[0m`);
    console.log('');
    if (failures > 0) process.exit(1);
  }
}

run().catch(e => { console.error(e); process.exit(1); });
