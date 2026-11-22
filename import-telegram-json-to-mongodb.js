#!/usr/bin/env node
'use strict';

// Import the two locally scraped Telegram JSON exports directly into MongoDB.
// Safe by default: without --apply this performs validation and a dry run only.
// Account 1 is refreshed; Account 2 is merged without overwriting Account 1 URLs.

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const mongoose = require('mongoose');
const { parseMessageBlock, isJunkTitle, classifyUrl } = require('./utils/parser');

const FILES = {
  '1': path.join(__dirname, 'telegram_export.json'),
  '2': path.join(__dirname, 'telegram_export_2.json'),
};
const CHUNK_SIZE = 400;
const HOST_PRIORITY = ['GDFlix', 'HubCloud', 'FilePress', 'DTFlix', 'TMBCloud', 'Direct', 'Download'];
const hostRank = host => {
  const index = HOST_PRIORITY.indexOf(host);
  return index === -1 ? 99 : index;
};
const CDN_RE = [
  /\.(m3u8|ts|m4s)(\?|$)/i,
  /\/(image|img|thumbnail|poster|banner|cover)\//i,
  /cdn\.(hotstar|zee5|sonyliv)/i,
  /vod\d*\./i, /img\d*\./i, /thumbs?\./i,
  /akamaized\.net/i, /cloudfront\.net/i,
];
function isJunkUrl(url) {
  if (!url) return true;
  if (/workers\.dev/i.test(url)) return !/\.(mkv|mp4|avi|zip|rar)([?#]|$)/i.test(url);
  return CDN_RE.some(re => re.test(url));
}

function readExport(file, account) {
  if (!fs.existsSync(file)) throw new Error('Missing export file: ' + path.basename(file));
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const messages = Array.isArray(raw) ? raw : raw && raw.messages;
  if (!Array.isArray(messages)) throw new Error(path.basename(file) + ' must contain a messages array.');
  if (!messages.length) throw new Error(path.basename(file) + ' has zero messages; refusing an empty import.');
  if (!Array.isArray(raw) && raw.scrape_mode !== 'full') {
    throw new Error(path.basename(file) + ' is not a full scrape export (scrape_mode=' + raw.scrape_mode + '). Run mode 1 for both accounts.');
  }
  if (!Array.isArray(raw) && Number.isFinite(raw.total_messages_collected) &&
      raw.total_messages_collected !== messages.length) {
    throw new Error(path.basename(file) + ' message count does not match its export metadata.');
  }
  const ids = new Set();
  for (const msg of messages) {
    if (!msg || msg.id == null || msg.channel_id == null) {
      throw new Error(path.basename(file) + ' contains a message without id/channel_id.');
    }
    ids.add(String(msg.channel_id) + ':' + String(msg.id));
  }
  return { account, file, exportedAt: Array.isArray(raw) ? null : raw.exported_at || null,
    scrapeMode: Array.isArray(raw) ? 'array' : raw.scrape_mode,
    messageCount: messages.length, uniqueMessageCount: ids.size, messages };
}

function extractLinksFromMessages(messages, account) {
  const messageMap = new Map();
  for (const msg of messages) {
    const key = String(msg.channel_id || '0') + ':' + String(msg.id);
    if (!messageMap.has(key)) messageMap.set(key, msg);
  }
  const uniqueMessages = [...messageMap.values()];
  const extracted = [];
  const seenUrls = new Set();
  let skipped = 0;

  for (const msg of uniqueMessages) {
    let rawText = '';
    if (typeof msg.text === 'string') rawText = msg.text;
    else if (Array.isArray(msg.text)) {
      rawText = msg.text.map(part => {
        if (typeof part === 'string') return part;
        if (part && part.type === 'text_link' && part.href) return String(part.text || '') + '\n' + part.href + '\n';
        return part && part.text ? part.text : '';
      }).join('');
    }
    if (msg.reply_markup && msg.reply_markup.inline_keyboard) {
      for (const row of msg.reply_markup.inline_keyboard) {
        for (const button of (row || [])) if (button && button.url) rawText += '\n' + button.url;
      }
    }
    if (!rawText.trim()) { skipped++; continue; }

    let parsed;
    try { parsed = parseMessageBlock(rawText, msg.id); } catch (_) { skipped++; continue; }
    if (!parsed || !parsed.downloads || !parsed.downloads.length ||
        !parsed.title || isJunkTitle(parsed.title)) { skipped++; continue; }

    const messageSlots = new Map();
    for (const download of parsed.downloads) {
      const language = download.language || parsed.language || '';
      for (const link of (download.links || [])) {
        if (!link || !link.url) continue;
        const url = String(link.url).replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
        if (isJunkUrl(url) || seenUrls.has(url)) continue;
        const host = typeof classifyUrl === 'function'
          ? classifyUrl(url)
          : (/gdflix|hubcloud|gdlink|fpgo/i.test(url) ? 'GDFlix' : 'Direct');
        if (host === 'Ignore' || host === 'Paste') continue;

        const entry = {
          url,
          host,
          title: parsed.title,
          year: parsed.year || null,
          quality: download.quality || parsed.quality || 'HD',
          size: download.size || '',
          language,
          season: download.season != null ? download.season : parsed.season,
          episode: download.episode != null ? download.episode : parsed.episode,
          type: parsed.isSeries ? 'series' : 'movie',
          filename: download.filename || '',
          codec: download.codec || '',
          hdr: download.hdr || '',
          audio: download.audio || '',
          bitDepth: download.bitDepth || '',
          audioChannels: download.audioChannels || '',
          bypassedUrl: '',
          isSeries: !!parsed.isSeries,
          contentType: parsed.contentType || '',
          date: msg.date || parsed.date || '',
          imdbId: parsed.imdbId || '',
          tmdbIdHint: parsed.tmdbIdHint ? Number(parsed.tmdbIdHint) : null,
          sourceAccount: String(account),
        };
        const slotKey = [
          download.quality || '',
          String(download.size || '').replace(/\s/g, ''),
          String(download.filename || '').slice(0, 80),
          language,
        ].join('|');
        if (!messageSlots.has(slotKey)) messageSlots.set(slotKey, []);
        messageSlots.get(slotKey).push(entry);
      }
    }

    for (const slot of messageSlots.values()) {
      slot.sort((a, b) => hostRank(a.host) - hostRank(b.host));
      for (const entry of slot) {
        if (seenUrls.has(entry.url)) continue;
        seenUrls.add(entry.url);
        extracted.push(entry);
      }
    }
  }
  return { links: extracted, uniqueMessages: uniqueMessages.length, skipped };
}

function chunk(items, size) {
  const result = [];
  for (let i = 0; i < items.length; i += size) result.push(items.slice(i, i + size));
  return result;
}

async function backupCollection(ExtractedLink) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(__dirname, 'xloop_extractedlinks_backup_' + stamp + '.json');
  const docs = await ExtractedLink.find({}).lean();
  fs.writeFileSync(file, JSON.stringify(docs, null, 2));
  console.log('[BACKUP] ' + docs.length + ' existing records saved to ' + path.basename(file));
  return docs.length;
}

async function applyImports(account1Links, account2Links, ExtractedLink, PipelineCache) {
  if (!account1Links.length) throw new Error('Account 1 produced zero extracted links; refusing to refresh Account 1 records.');
  if (!account2Links.length) throw new Error('Account 2 produced zero extracted links; refusing to merge an empty Account 2 export.');

  const batch1 = 'termux_acc1_' + Date.now();
  let acc1Upserts = 0;
  for (const group of chunk(account1Links, CHUNK_SIZE)) {
    const ops = group.map(link => ({
      updateOne: {
        filter: { url: link.url },
        update: { $set: { ...link, uploadBatch: batch1 } },
        upsert: true,
      },
    }));
    const result = await ExtractedLink.bulkWrite(ops, { ordered: false });
    acc1Upserts += (result.upsertedCount || 0) + (result.modifiedCount || 0);
  }

  // Only stale Account 1-tagged records are removed, after all new Account 1
  // records have been written successfully. Legacy/untagged and Account 2 rows stay.
  const removedAcc1 = await ExtractedLink.deleteMany({
    sourceAccount: '1',
    uploadBatch: { $ne: batch1 },
  });

  const batch2 = 'termux_acc2_' + Date.now();
  let acc2Inserted = 0;
  let acc2Duplicates = 0;
  for (const group of chunk(account2Links, CHUNK_SIZE)) {
    const urls = group.map(link => link.url);
    const existing = await ExtractedLink.find({ url: { $in: urls } }).select('url').lean();
    const existingUrls = new Set(existing.map(doc => doc.url));
    const seen = new Set();
    const fresh = group.filter(link => {
      if (existingUrls.has(link.url) || seen.has(link.url)) return false;
      seen.add(link.url);
      return true;
    });
    acc2Duplicates += group.length - fresh.length;
    if (fresh.length) {
      const tagged = fresh.map(link => ({ ...link, uploadBatch: batch2 }));
      const result = await ExtractedLink.insertMany(tagged, { ordered: false });
      acc2Inserted += result.length;
    }
  }

  const totalCount = await ExtractedLink.countDocuments({});
  await PipelineCache.findOneAndUpdate(
    { key: 'extracted_links' },
    {
      $set: {
        key: 'extracted_links',
        data: { batchId: batch2, count: totalCount, mergeMode: true, source: 'termux-json-import' },
        count: totalCount,
        savedAt: new Date(),
      },
    },
    { upsert: true, new: true }
  );

  return {
    account1Upserts: acc1Upserts,
    account1StaleRemoved: removedAcc1.deletedCount || 0,
    account2Inserted: acc2Inserted,
    account2DuplicatesSkipped: acc2Duplicates,
    databaseTotal: totalCount,
  };
}

async function main() {
  const apply = process.argv.includes('--apply');
  const uri = process.env.MONGODB_URI;
  if (apply && !uri) throw new Error('MONGODB_URI is missing from the local .env file.');

  const exports = {
    '1': readExport(FILES['1'], '1'),
    '2': readExport(FILES['2'], '2'),
  };
  const parsed = {
    '1': extractLinksFromMessages(exports['1'].messages, '1'),
    '2': extractLinksFromMessages(exports['2'].messages, '2'),
  };

  for (const account of ['1', '2']) {
    const item = exports[account], result = parsed[account];
    console.log('\nAccount ' + account + ' — ' + path.basename(item.file));
    console.log('  Scrape mode: ' + item.scrapeMode + ' | Exported: ' + (item.exportedAt || 'unknown'));
    console.log('  Messages: ' + item.messageCount + ' | Unique: ' + item.uniqueMessageCount);
    console.log('  Extracted links: ' + result.links.length + ' | Skipped messages: ' + result.skipped);
  }

  if (!parsed['1'].links.length || !parsed['2'].links.length) {
    throw new Error('At least one account has zero extracted links. No database changes made.');
  }
  if (!apply) {
    console.log('\n[DRY RUN] No MongoDB connection or writes were made.');
    console.log('Review the counts above, then run: npm run import:telegram-json:apply');
    return;
  }

  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000, family: 4 });
  const ExtractedLink = require('./models/ExtractedLink');
  const PipelineCache = require('./models/PipelineCache');
  try {
    const backupCount = await backupCollection(ExtractedLink);
    const result = await applyImports(parsed['1'].links, parsed['2'].links, ExtractedLink, PipelineCache);
    console.log('\n[IMPORT COMPLETE]');
    console.log('  Backup records: ' + backupCount);
    console.log('  Account 1 refreshed/upserted: ' + result.account1Upserts);
    console.log('  Account 1 stale tagged records removed: ' + result.account1StaleRemoved);
    console.log('  Account 2 new links inserted: ' + result.account2Inserted);
    console.log('  Account 2 duplicates skipped: ' + result.account2DuplicatesSkipped);
    console.log('  MongoDB ExtractedLink total: ' + result.databaseTotal);
  } finally {
    await mongoose.disconnect();
  }
}

if (require.main === module) {
  main().catch(async error => {
    console.error('\n[IMPORT FAILED] ' + (error.stack || error.message || error));
    try { await mongoose.disconnect(); } catch (_) {}
    process.exitCode = 1;
  });
}

module.exports = { readExport, extractLinksFromMessages, isJunkUrl, applyImports };
