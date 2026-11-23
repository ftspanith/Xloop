#!/usr/bin/env node
'use strict';

// Direct Termux -> MongoDB Telegram link replacement.
// Does NOT call Vercel APIs and does NOT start the pipeline.
// Requires ~/Xloop/.telegram-import-dry-run.js and sibling ~/Xloop-local-safe exports.

const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const dotenv = require('dotenv');

const ROOT = path.resolve(__dirname, '..');
const EXPORT_DIR = path.resolve(ROOT, '../Xloop-local-safe');
const ENV_FILE = path.join(EXPORT_DIR, '.env');
const HELPER = path.join(ROOT, '.telegram-import-dry-run.js');
const EXPECTED = { account1: 37455, account2: 32216, total: 69671 };
const BATCH_SIZE = 500;

function comparableUrl(value) {
  const raw = String(value || '').trim().replace(/^http:\/\//i, 'https://');
  try {
    const u = new URL(raw);
    u.protocol = u.protocol.toLowerCase();
    u.hostname = u.hostname.toLowerCase();
    return u.toString().replace(/\/$/, '');
  } catch (_) { return raw; }
}

function asString(value, max = 500) {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function makeDocument(item, account, batch, now) {
  return {
    url: String(item.url || '').trim(),
    host: asString(item.host, 80) || 'Other',
    title: asString(item.title, 500),
    year: item.year == null ? null : Number(item.year),
    quality: asString(item.quality, 40) || 'HD',
    size: asString(item.size, 40),
    language: asString(item.language, 80),
    season: item.season == null ? null : Number(item.season),
    episode: item.episode == null ? null : Number(item.episode),
    type: asString(item.type, 30) || 'movie',
    filename: asString(item.filename, 1000),
    codec: asString(item.codec, 80),
    hdr: asString(item.hdr, 80),
    audio: asString(item.audio, 120),
    bitDepth: asString(item.bitDepth, 40),
    audioChannels: asString(item.audioChannels, 40),
    bypassedUrl: asString(item.bypassedUrl, 2000),
    isSeries: !!item.isSeries,
    contentType: asString(item.contentType, 40),
    date: asString(item.date, 100),
    imdbId: asString(item.imdbId, 40),
    tmdbIdHint: item.tmdbIdHint == null ? null : Number(item.tmdbIdHint),
    sourceAccount: account,
    uploadBatch: batch,
    createdAt: now,
    updatedAt: now,
  };
}

async function main() {
  if (!fs.existsSync(ENV_FILE)) throw new Error('Missing local env file: ' + ENV_FILE);
  if (!fs.existsSync(HELPER)) throw new Error('Missing parser helper: ' + HELPER);
  dotenv.config({ path: ENV_FILE, override: false });
  if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI is not set in the local env file.');

  const { readExport, extractLinksFromMessages } = require(HELPER);
  if (typeof readExport !== 'function' || typeof extractLinksFromMessages !== 'function') {
    throw new Error('Local parser helper does not export the required functions.');
  }

  const file1 = path.join(EXPORT_DIR, 'telegram_export.json');
  const file2 = path.join(EXPORT_DIR, 'telegram_export_2.json');
  for (const file of [file1, file2]) {
    if (!fs.existsSync(file)) throw new Error('Missing export: ' + file);
  }

  console.log('[1/5] Parsing latest Telegram exports locally...');
  const exp1 = readExport(file1, '1');
  const exp2 = readExport(file2, '2');
  const a1 = extractLinksFromMessages(exp1.messages, '1').links
    .map(x => ({ ...x, sourceAccount: '1' }));
  const parsed2 = extractLinksFromMessages(exp2.messages, '2').links;
  const seen = new Set(a1.map(x => comparableUrl(x.url)));
  const a2 = [];
  for (const item of parsed2) {
    const key = comparableUrl(item.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    a2.push({ ...item, sourceAccount: '2' });
  }
  const total = a1.length + a2.length;
  console.log('Account 1:', a1.length, '| Account 2:', a2.length, '| Total:', total);
  if (a1.length !== EXPECTED.account1 || a2.length !== EXPECTED.account2 || total !== EXPECTED.total) {
    throw new Error('Count verification failed. Expected 37455 / 32216 / 69671. No database writes were made.');
  }

  console.log('[2/5] Connecting directly to MongoDB (URI hidden)...');
  await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 15000, family: 4 });
  const db = mongoose.connection.db;
  if (db.databaseName !== 'xloop') {
    throw new Error('Safety stop: connected database name is not xloop. No collection was changed.');
  }
  console.log('MongoDB connection OK. Database:', db.databaseName);

  const syncId = 'direct_' + Date.now();
  const stageName = 'extractedlinks_stage_' + syncId;
  const batch = 'telegram_' + syncId;
  const stage = await db.createCollection(stageName);
  await stage.createIndex({ url: 1 }, { unique: true });
  await stage.createIndex({ sourceAccount: 1 });
  await stage.createIndex({ uploadBatch: 1 });

  console.log('[3/5] Writing verified links into a separate staging collection...');
  const all = [
    ...a1.map(x => makeDocument(x, '1', batch, new Date())),
    ...a2.map(x => makeDocument(x, '2', batch, new Date())),
  ];
  for (let i = 0; i < all.length; i += BATCH_SIZE) {
    await stage.insertMany(all.slice(i, i + BATCH_SIZE), { ordered: true });
    const n = Math.min(i + BATCH_SIZE, all.length);
    if (n % 5000 === 0 || n === all.length) {
      process.stdout.write('\rStaged ' + n.toLocaleString() + ' / ' + all.length.toLocaleString());
    }
  }
  process.stdout.write('\n');

  console.log('[4/5] Verifying staging counts before touching live collection...');
  const [count, count1, count2] = await Promise.all([
    stage.countDocuments({}),
    stage.countDocuments({ sourceAccount: '1' }),
    stage.countDocuments({ sourceAccount: '2' }),
  ]);
  console.log('Staged A1:', count1, '| A2:', count2, '| Total:', count);
  if (count !== EXPECTED.total || count1 !== EXPECTED.account1 || count2 !== EXPECTED.account2) {
    throw new Error('Staging verification failed. Live extractedlinks collection was NOT changed. Stage kept: ' + stageName);
  }

  console.log('[5/5] Atomically replacing extractedlinks...');
  const dbName = db.databaseName;
  await db.admin().command({
    renameCollection: dbName + '.' + stageName,
    to: dbName + '.extractedlinks',
    dropTarget: true,
  });
  console.log('\n[REPLACEMENT COMPLETE] Live extractedlinks now contains the verified latest Telegram list.');

  // Metadata updates are best-effort; the live collection replacement has already succeeded.
  try {
    const PipelineCache = require(path.join(ROOT, 'models/PipelineCache'));
    const now = new Date();
    await PipelineCache.findOneAndUpdate(
      { key: 'extracted_links' },
      {
        $set: {
          key: 'extracted_links',
          data: { batchId: batch, count, mergeMode: false, source: 'termux-direct-mongodb' },
          count,
          savedAt: now,
        },
      },
      { upsert: true, new: true }
    );
    const historyDoc = await PipelineCache.findOne({ key: '_scrape_sync_status' }).lean();
    const history = historyDoc && historyDoc.data ? historyDoc.data : {};
    for (const [account, links] of [['1', count1], ['2', count2]]) {
      history['acc' + account] = {
        date: now.toISOString(),
        dateHuman: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
        source: 'termux-direct-mongodb',
        links,
      };
    }
    await PipelineCache.findOneAndUpdate(
      { key: '_scrape_sync_status' },
      { $set: { data: history, updatedAt: now } },
      { upsert: true }
    );
    console.log('Xloop sync metadata updated.');
  } catch (err) {
    console.error('WARNING: links were replaced, but sync metadata update failed:', err.message);
  }

  console.log('No other collections were intentionally modified. Pipeline was NOT started.');
}

main()
  .catch(err => {
    console.error('\n[DIRECT DB SYNC STOPPED]', err.message);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (mongoose.connection.readyState !== 0) await mongoose.disconnect().catch(() => {});
  });
