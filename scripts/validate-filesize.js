#!/usr/bin/env node
/**
 * scripts/validate-filesize.js — File Size & Metadata Validator
 * ─────────────────────────────────────────────────────────────────────────────
 * Scans all ExtractedLink documents and flags size/quality mismatches.
 * Usage:
 *   node scripts/validate-filesize.js
 *   node scripts/validate-filesize.js --fix   (auto-sets sizeValid flag)
 *   node scripts/validate-filesize.js --limit 100
 */
'use strict';
require('dotenv').config();
const mongoose = require('mongoose');
const { fileSizePlausibilityReport, formatBytes, parseFileSizeToBytes } = require('../utils/fileMetadata');

const args   = process.argv.slice(2);
const doFix  = args.includes('--fix');
const eqLimit = args.find(a => a.startsWith('--limit='));
const spIdx   = args.indexOf('--limit');
const limit   = Number(eqLimit ? eqLimit.split('=')[1] : (spIdx >= 0 ? args[spIdx + 1] : 0)) || 0;
const limitIndexVal = !eqLimit && spIdx >= 0 ? spIdx + 1 : -1;

async function main() {
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 8000, family: 4 });
  console.log('\n\x1b[1m━━━ File Size Validator ━━━\x1b[0m\n');

  const Link   = require('../models/ExtractedLink');
  let query    = Link.find({ size: { $exists: true, $ne: '' } });
  if (limit > 0) query = query.limit(limit);
  const docs   = await query.lean();

  let ok = 0, warn = 0, error = 0, fixed = 0;
  const errors  = [];
  const warnings = [];

  for (const doc of docs) {
    const report = fileSizePlausibilityReport(doc);
    if (report.status === 'ok') {
      ok++;
    } else if (report.status === 'warn') {
      warn++;
      warnings.push({ id: doc._id, title: doc.title, quality: doc.quality, size: doc.size, details: report.details });
      if (doFix) {
        await Link.collection.updateOne({ _id: doc._id }, { $set: { sizeValid: true, sizeWarning: report.details.join('; ') } });
        fixed++;
      }
    } else {
      error++;
      errors.push({ id: doc._id, title: doc.title, quality: doc.quality, size: doc.size, details: report.details });
      if (doFix) {
        await Link.collection.updateOne({ _id: doc._id }, { $set: { sizeValid: false, sizeError: report.details.join('; ') } });
        fixed++;
      }
    }
  }

  console.log(`Scanned ${docs.length} documents`);
  console.log(`  \x1b[32m✅ OK:      ${ok}\x1b[0m`);
  console.log(`  \x1b[33m⚠️  WARN:   ${warn}\x1b[0m`);
  console.log(`  \x1b[31m❌ ERROR:   ${error}\x1b[0m`);
  if (doFix) console.log(`  \x1b[36m🔧 Fixed:   ${fixed}\x1b[0m`);

  if (errors.length > 0) {
    console.log('\n\x1b[31mErrors (sample first 10):\x1b[0m');
    errors.slice(0, 10).forEach(e => {
      console.log(`  "${e.title}" [${e.quality}] ${e.size}`);
      e.details.forEach(d => console.log(`    ${d}`));
    });
  }
  if (warnings.length > 0) {
    console.log('\n\x1b[33mWarnings (sample first 5):\x1b[0m');
    warnings.slice(0, 5).forEach(w => {
      console.log(`  "${w.title}" [${w.quality}] ${w.size}`);
      w.details.forEach(d => console.log(`    ${d}`));
    });
  }

  console.log('');
  await mongoose.disconnect();
}

main().catch(e => { console.error(e); process.exit(1); });
