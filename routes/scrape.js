/**
 * /api/scrape — Telegram Scraper API
 * Runs scrape.js as a child process and streams stdout via SSE
 * Also handles channel list for the picker UI
 */

const express  = require('express');
const router   = express.Router();
const { spawn } = require('child_process');
const path     = require('path');
const fs       = require('fs');
const auth     = require('../middleware/auth');
const { analyzeVariantSet, rankVariantsForDisplay } = require('../utils/variant-intelligence');
const { isAllowedTelegramDownloadUrl } = require('../utils/telegram-ingestion');

const ROOT          = path.join(__dirname, '..');
const SCRAPE_SCRIPT = path.join(ROOT, 'scrape_api.js');
const os = require('os');
const EXPORT_FILE   = process.env.VERCEL ? path.join(os.tmpdir(), 'telegram_export.json') : path.join(ROOT, 'telegram_export.json');

// ── Upload abort flag — set by Stop/Wipe to cancel in-progress chunked uploads ──
let _uploadAborted = false;
module.exports.setUploadAborted = (v) => { _uploadAborted = v; };

// ── Sync status helpers — stored in MongoDB so they persist on Vercel ────────
const SYNC_CACHE_KEY = '_scrape_sync_status';

async function getSyncStatus() {
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1)
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    const doc = await PipelineCache.findOne({ key: SYNC_CACHE_KEY }).lean();
    return doc && doc.data ? doc.data : {};
  } catch { return {}; }
}

async function saveSyncStatus(history) {
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1)
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    await PipelineCache.findOneAndUpdate(
      { key: SYNC_CACHE_KEY },
      { $set: { data: history, updatedAt: new Date() } },
      { upsert: true }
    );
  } catch { /* non-critical */ }
}

// ── GET /api/scrape/sync-status — return last sync timestamps (public, read-only) ────────────────
router.get('/sync-status', async (req, res) => {
  try {
    const history = await getSyncStatus();
    const ExtractedLink = require('../models/ExtractedLink');
    const grouped = await ExtractedLink.aggregate([
      {
        $group: {
          _id: { $ifNull: ['$sourceAccount', ''] },
          count: { $sum: 1 },
          latestUpdatedAt: { $max: { $ifNull: ['$updatedAt', '$createdAt'] } }
        }
      }
    ]);

    const byAccount = new Map(grouped.map(item => [String(item._id || ''), item]));
    const acc1Stats = byAccount.get('1') || { count: 0, latestUpdatedAt: null };
    const acc2Stats = byAccount.get('2') || { count: 0, latestUpdatedAt: null };
    const unassignedStats = byAccount.get('') || { count: 0, latestUpdatedAt: null };
    const totalLinks = grouped.reduce((sum, item) => sum + Number(item.count || 0), 0);
    const latestUpdatedAt = grouped.reduce((latest, item) => {
      const date = item.latestUpdatedAt ? new Date(item.latestUpdatedAt) : null;
      return date && (!latest || date > latest) ? date : latest;
    }, null);

    const makeAccountStatus = (stats, previous) => {
      // Legacy imports may not have sourceAccount tags. If the account-specific
      // aggregate is empty but the collection has records, show the real latest
      // database activity instead of leaving an obsolete cached date (e.g. Oct 9).
      const updatedAt = stats.latestUpdatedAt
        ? new Date(stats.latestUpdatedAt)
        : (totalLinks > 0 && latestUpdatedAt ? new Date(latestUpdatedAt) : null);
      if (!stats.count && !updatedAt) return previous || null;
      return {
        ...(previous || {}),
        source: 'database',
        links: Number(stats.count || 0),
        date: updatedAt ? updatedAt.toISOString() : previous?.date || null,
        dateHuman: updatedAt
          ? updatedAt.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' })
          : previous?.dateHuman || 'Imported into MongoDB'
      };
    };

    res.setHeader('Cache-Control', 'no-store');
    res.json({
      acc1: makeAccountStatus(acc1Stats, history.acc1),
      acc2: makeAccountStatus(acc2Stats, history.acc2),
      database: {
        totalLinks,
        account1Links: Number(acc1Stats.count || 0),
        account2Links: Number(acc2Stats.count || 0),
        unassignedLinks: Number(unassignedStats.count || 0),
        latestUpdatedAt: latestUpdatedAt ? latestUpdatedAt.toISOString() : null
      }
    });
  } catch (e) {
    res.status(500).json({ error: 'Could not read live sync data' });
  }
});


// ── POST /api/scrape/mark-sync — record a sync event ─────────────────────────
router.post('/mark-sync', auth, async (req, res) => {
  try {
    const { account = '1', source = 'manual', links = 0 } = req.body || {};
    const history = await getSyncStatus();
    const now = new Date();
    history[`acc${account}`] = {
      date: now.toISOString(),
      dateHuman: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
      source, // 'auto' | 'manual'
      links: Number(links),
    };
    await saveSyncStatus(history);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ── GET /api/scrape/channels — return channel list (auth required) ────────
router.get('/channels', auth, (req, res) => {
  res.json({
    // Account 1 channels
    channels: [
      2121685058, 1460307412, 3854487392, 3649684713,
      2676653332, 4234578006, 3619204173, 2785355990,
      3374719986, 2271910467, 3927502894, 3354192797,
      3579217190, 3952255152, 2640824484, 4355201143,
      2252012526, 4372491493, 3881216988, 4430701213,
    ],
    // Account 2 channels — rare/high-quality content (25 channels)
    channels2: [
      3891693982, 3967038425, 4338151063, 3756853704,
      2527964888, 3726186044, 3343698175, 3969393145,
      3082945471, 3059521452, 3055056854, 2271910467,
      2450674815, 3525397380, 1938120386, 2315546515,
      2534024342, 2178445230, 3902323266, 3221104139,
      3834971910, 3426472755, 1688511757, 3943432706,
      3167107720,
    ],
  });
});

// ── POST /api/scrape/start — start scraping (SSE stream, auth required) ────
// Body: { mode: 1|2|3|4, channels?: number[], startDate?: string, endDate?: string }
router.post('/start', auth, (req, res) => {
  const { mode, channels, startDate, endDate } = req.body;

  // SSE headers
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.flushHeaders();

  const send = (data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

  send({ type: 'start', message: `Starting Mode ${mode} scrape...` });

  // Build args to pass to the non-interactive scrape_api.js
  const args = [
    `--mode=${mode}`,
    channels && channels.length ? `--channels=${channels.join(',')}` : '--channels=all',
  ];
  
  if (startDate) args.push(`--start-date=${startDate}`);
  if (endDate)   args.push(`--end-date=${endDate}`);

  const child = spawn('node', [SCRAPE_SCRIPT, ...args], {
    cwd: ROOT,
    env: { ...process.env },
  });

  child.stdout.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => send({ type: 'log', message: line }));
  });

  child.stderr.on('data', (data) => {
    const lines = data.toString().split('\n').filter(l => l.trim());
    lines.forEach(line => send({ type: 'error', message: line }));
  });

  child.on('close', (code) => {
    let fileSize = '';
    try {
      if (fs.existsSync(EXPORT_FILE)) {
        const mb = (fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(2);
        fileSize = `${mb} MB`;
      }
    } catch(_) {}

    send({
      type:     code === 0 ? 'done' : 'fail',
      message:  code === 0 ? ' Scrape complete! telegram_export.json is ready.' : ` Scraper exited with code ${code}`,
      fileSize,
    });
    res.end();
  });

  req.on('close', () => child.kill());
});

// ── POST /api/scrape/upload-export — upload telegram_export.json from local PC ──
// On Vercel, scrape_api.js cannot run. Instead, user uploads the JSON file
// generated by the local Telegram scraper.
// Uses multer multipart upload — works reliably with large files on all browsers.
const multer = require('multer');
const upload  = multer({ storage: multer.memoryStorage(), limits: { fileSize: 300 * 1024 * 1024 } }); // 300MB

router.post('/upload-export', auth, upload.array('files', 10), async (req, res) => {
  try {
    const PipelineCache = require('../models/PipelineCache');
    const { extractTelegramLinks } = require('../utils/telegram-ingestion');

    // Accept both browser multipart uploads and the CLI JSON payload.
    let allMessages = [];
    if (req.files && req.files.length) {
      const allExports = [];
      for (const file of req.files) {
        let parsed;
        try {
          parsed = JSON.parse(file.buffer.toString('utf8'));
        } catch (e) {
          return res.status(400).json({ message: `File "${file.originalname}" is invalid JSON: ${e.message}` });
        }
        const fileAccount = /(?:account|acc)[_-]?2|telegram_export_2/i.test(file.originalname)
          ? '2'
          : String(req.body?.account || '1');
        if (Array.isArray(parsed)) {
          parsed = parsed.map(item => {
            if (item && Array.isArray(item.messages)) {
              return { ...item, messages: item.messages.map(message => ({ ...message, sourceAccount: message.sourceAccount || fileAccount })) };
            }
            return item && typeof item === 'object'
              ? { ...item, sourceAccount: item.sourceAccount || fileAccount }
              : item;
          });
        } else if (parsed && Array.isArray(parsed.messages)) {
          parsed.messages = parsed.messages.map(message => ({ ...message, sourceAccount: message.sourceAccount || fileAccount }));
        }
        allExports.push(parsed);
      }
      const data = allExports.length === 1 ? allExports[0] : allExports;
      if (Array.isArray(data)) {
        if (data.length > 0 && data[0] && typeof data[0] === 'object' && Array.isArray(data[0].messages)) {
          allMessages = data.flatMap(item => item.messages || []);
        } else {
          allMessages = data;
        }
      } else if (data && Array.isArray(data.messages)) {
        allMessages = data.messages;
      } else {
        return res.status(400).json({ message: 'Invalid format. Expected { messages:[...] }, an array of messages, or an array of exports.' });
      }
    } else if (req.body && Array.isArray(req.body.messages)) {
      allMessages = req.body.messages;
    } else if (Array.isArray(req.body)) {
      allMessages = req.body;
    } else {
      return res.status(400).json({ message: 'No Telegram messages received. Send multipart files or JSON { messages: [...] }.' });
    }

    // Global dedup by channel_id:message_id (handles overlapping files)
    const msgMap = new Map();
    for (const m of allMessages) {
      if (!m || typeof m !== 'object' || m.id == null) continue;
      const key = `${m.channel_id || '0'}:${m.id}`;
      if (!msgMap.has(key)) msgMap.set(key, m);
    }
    const messages = [...msgMap.values()];
    const rawCount = allMessages.length;
    const dedupCount = rawCount - messages.length;

    // ── Shared extraction engine: identical to scrape-and-upload.js ──
    const account = String(req.body?.account || req.query.account || '1');
    const extraction = extractTelegramLinks(messages, account);
    const allLinks = extraction.links;
    const shortlinks = allLinks.filter(link => link.host === 'Shortlink');
    const skipped = extraction.stats.skippedMessages;

    // ── Save to ExtractedLink collection (one doc per link — no 16MB limit) ──
    // Each upload gets a batch ID so we can atomically replace the previous batch.
    const ExtractedLink = require('../models/ExtractedLink');
    const mergeMode = req.query.merge === 'true'; // ?merge=true = add to existing (multi-account)
    const batchId = `batch_${Date.now()}`;

    // In merge mode: filter out URLs already stored in any existing batch
    // This prevents exact-duplicate URLs from being saved twice across accounts.
    // Different URL for same file (mirror on different host) IS kept — pipeline handles slot merge.
    let linksToSave = allLinks;
    if (mergeMode) {
      // Get all URLs already stored so we can skip exact duplicates
      const existingUrls = new Set(
        (await ExtractedLink.find({}, 'url').lean()).map(d => d.url)
      );
      const before = linksToSave.length;
      linksToSave = linksToSave.filter(e => !existingUrls.has(e.url));
      const skippedDupes = before - linksToSave.length;
      if (skippedDupes > 0) console.log(`[merge] Skipped ${skippedDupes} exact-duplicate URLs from previous account`);
    }

    // Tag all entries with this batch ID
    linksToSave.forEach(e => { e.uploadBatch = batchId; });

    // Insert new batch in chunks of 500
    const CHUNK = 500;
    for (let i = 0; i < linksToSave.length; i += CHUNK) {
      await ExtractedLink.insertMany(linksToSave.slice(i, i + CHUNK), { ordered: false });
    }

    // In REPLACE mode (default): delete all previous batches — fresh start
    // In MERGE mode: keep all existing batches — accumulate across accounts
    if (!mergeMode) {
      await ExtractedLink.deleteMany({ uploadBatch: { $ne: batchId } });
    }

    // Update PipelineCache with total link count (across ALL batches in merge mode)
    const totalCount = mergeMode
      ? await ExtractedLink.countDocuments()
      : linksToSave.length;
    await PipelineCache.findOneAndUpdate(
      { key: 'extracted_links' },
      { key: 'extracted_links', data: { batchId, count: totalCount, mergeMode }, count: totalCount, savedAt: new Date() },
      { upsert: true, new: true }
    );

    // Write links_for_bypasser.json to /tmp for immediate same-Lambda pipeline use
    try {
      fs.writeFileSync(path.join(os.tmpdir(), 'links_for_bypasser.json'), JSON.stringify(linksToSave));
      fs.writeFileSync(path.join(os.tmpdir(), 'shortlinks_report.json'), JSON.stringify(shortlinks));
    } catch(_) {}

    // ── Write telegram_export.json to disk for json-search-links endpoint ──────
    // In REPLACE mode: overwrite with new messages only
    // In MERGE mode: load existing messages, merge new ones in (dedup by channel:msgId)
    try {
      let finalMessages = messages;
      if (mergeMode && fs.existsSync(EXPORT_FILE)) {
        try {
          const existing = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
          const existingMsgs = existing.messages || [];
          // Build dedup map from existing messages
          const existingKeys = new Map();
          for (const m of existingMsgs) {
            existingKeys.set(`${m.channel_id||'0'}:${m.id}`, m);
          }
          // Add new messages not already present
          let addedCount = 0;
          for (const m of messages) {
            const k = `${m.channel_id||'0'}:${m.id}`;
            if (!existingKeys.has(k)) { existingKeys.set(k, m); addedCount++; }
          }
          finalMessages = [...existingKeys.values()];
          console.log(`[merge] telegram_export.json: ${existingMsgs.length} existing + ${addedCount} new = ${finalMessages.length} total messages`);
        } catch(readErr) {
          console.warn('[merge] Could not read existing telegram_export.json, overwriting:', readErr.message);
        }
      }
      fs.writeFileSync(EXPORT_FILE, JSON.stringify({ messages: finalMessages }));
      _jsonCache = null; // invalidate cache so next json-search-links reads fresh file
    } catch(writeErr) {
      console.warn('[upload-export] Could not write telegram_export.json:', writeErr.message);
    }

    const dedupNote = dedupCount > 0 ? ` (${dedupCount} duplicate messages removed across files)` : '';
    const modeNote  = mergeMode ? ` [MERGE MODE — total across all accounts: ${totalCount} links]` : '';
    res.json({
      message: `[DONE] Extracted ${linksToSave.length} new links from ${messages.length} messages (${skipped} skipped)${dedupNote}${modeNote}. Saved to MongoDB. Run Full Pipeline now.`,
      count: linksToSave.length, totalCount, messages: messages.length, rawMessages: rawCount, duplicatesRemoved: dedupCount, skipped, mergeMode,
    });
  } catch (err) {
    res.status(500).json({ message: `Upload failed: ${err.message}` });
  }
});

// ── GET /api/scrape/export-status — check if extracted links are available ────
router.get('/export-status', auth, async (req, res) => {
  try {
    const PipelineCache  = require('../models/PipelineCache');
    const ExtractedLink  = require('../models/ExtractedLink');

    // Always count the real collection — PipelineCache can be stale after a wipe
    const realCount = await ExtractedLink.countDocuments({});
    const cache     = await PipelineCache.findOne({ key: 'extracted_links' }, 'count savedAt').lean();

    // Auto-heal stale metadata: if PipelineCache says links exist but collection is empty, reset it
    if (cache && cache.count > 0 && realCount === 0) {
      await PipelineCache.updateOne({ key: 'extracted_links' }, { $set: { count: 0, 'data.count': 0 } });
    }

    const tmpExists = fs.existsSync(path.join(os.tmpdir(), 'links_for_bypasser.json'));
    const latestLink = realCount > 0
      ? await ExtractedLink.findOne({}).sort({ updatedAt: -1, createdAt: -1 }).select('updatedAt createdAt').lean()
      : null;
    const savedAt = latestLink?.updatedAt || latestLink?.createdAt || cache?.savedAt || null;
    const available = realCount > 0 || tmpExists;
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      available,
      source: realCount > 0 ? 'mongodb' : tmpExists ? 'tmp' : 'none',
      count: realCount > 0 ? realCount : (cache?.count || 0),
      savedAt,
    });
  } catch (err) {
    res.json({ available: false, source: 'error', error: err.message });
  }
});

// ── Termux Telegram sync: stage, verify, then atomically swap collections ──
const TELEGRAM_SYNC_CURRENT_KEY = '_telegram_sync_current';

async function saveTelegramSyncState(PipelineCache, state) {
  await PipelineCache.findOneAndUpdate(
    { key: TELEGRAM_SYNC_CURRENT_KEY },
    { $set: { data: state, updatedAt: new Date() } },
    { upsert: true, new: true }
  );
}

router.get('/telegram-sync/status', async (_req, res) => {
  try {
    const PipelineCache = require('../models/PipelineCache');
    const current = await PipelineCache.findOne({ key: TELEGRAM_SYNC_CURRENT_KEY }).lean();
    res.json(current && current.data ? current.data : { status: 'idle' });
  } catch (err) {
    res.status(500).json({ status: 'error', message: err.message });
  }
});

router.post('/telegram-sync/start', auth, async (req, res) => {
  const mongoose = require('mongoose');
  const PipelineCache = require('../models/PipelineCache');
  try {
    const { syncId, expectedTotal, account1Count, account2Count } = req.body || {};
    if (typeof syncId !== 'string' || !/^[a-zA-Z0-9_-]{8,64}$/.test(syncId)) {
      return res.status(400).json({ message: 'Invalid syncId.' });
    }
    const a1 = Number(account1Count), a2 = Number(account2Count), total = Number(expectedTotal);
    if (!Number.isInteger(a1) || !Number.isInteger(a2) || !Number.isInteger(total) ||
        a1 < 1 || a2 < 1 || total !== a1 + a2 || total > 150000) {
      return res.status(400).json({ message: 'Invalid expected account counts.' });
    }

    const currentDoc = await PipelineCache.findOne({ key: TELEGRAM_SYNC_CURRENT_KEY }).lean();
    const current = currentDoc && currentDoc.data;
    if (current && current.status === 'uploading') {
      return res.status(409).json({ message: 'Another Telegram sync is already uploading.', current });
    }

    const suffix = syncId.replace(/[^a-zA-Z0-9]/g, '').slice(0, 32);
    const stageCollection = 'extractedlinks_stage_' + suffix;
    const db = mongoose.connection.db;
    const exists = await db.listCollections({ name: stageCollection }, { nameOnly: true }).hasNext();
    if (exists) return res.status(409).json({ message: 'This syncId already exists. Generate a new syncId.' });

    await db.createCollection(stageCollection);
    const stage = db.collection(stageCollection);
    await stage.createIndex({ url: 1 }, { unique: true });
    await stage.createIndex({ sourceAccount: 1 });
    await stage.createIndex({ uploadBatch: 1 });

    const state = {
      syncId, status: 'uploading', source: 'termux',
      expected: { account1: a1, account2: a2, total },
      received: { account1: 0, account2: 0, total: 0 },
      startedAt: new Date().toISOString(),
      stageCollection,
    };
    await PipelineCache.findOneAndUpdate(
      { key: '_telegram_sync_' + syncId },
      { $set: { data: state, updatedAt: new Date() } },
      { upsert: true, new: true }
    );
    await saveTelegramSyncState(PipelineCache, state);
    res.json({ ok: true, syncId, chunkSize: 300, expected: state.expected });
  } catch (err) {
    res.status(500).json({ message: 'Telegram sync start failed: ' + err.message });
  }
});

router.post('/telegram-sync/chunk', auth, express.json({ limit: '3mb' }), async (req, res) => {
  try {
    const { syncId, links } = req.body || {};
    if (typeof syncId !== 'string' || !Array.isArray(links) || !links.length || links.length > 300) {
      return res.status(400).json({ message: 'Provide syncId and 1–300 links per chunk.' });
    }
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    const sessionDoc = await PipelineCache.findOne({ key: '_telegram_sync_' + syncId }).lean();
    const state = sessionDoc && sessionDoc.data;
    if (!state || state.status !== 'uploading') return res.status(409).json({ message: 'Sync session is not accepting chunks.' });

    const stage = mongoose.connection.db.collection(state.stageCollection);
    const batch = 'telegram_' + syncId;
    const now = new Date();
    const allowedString = (v, max = 500) => typeof v === 'string' ? v.slice(0, max) : '';
    const ops = [];
    for (const item of links) {
      if (!item || typeof item.url !== 'string' || !/^https?:\/\//i.test(item.url) ||
          !['1', '2'].includes(String(item.sourceAccount))) {
        return res.status(400).json({ message: 'Every link needs a valid http(s) URL and sourceAccount 1 or 2.' });
      }
      const incomingAudioTracks = Array.isArray(item.audioTracks)
        ? item.audioTracks.slice(0, 8).map(track => ({
            codec: allowedString(track && track.codec, 80),
            channels: allowedString(track && track.channels, 40),
            language: allowedString(track && track.language, 80),
          })).filter(track => track.codec)
        : [];
      const doc = {
        url: item.url.trim(),
        host: allowedString(item.host, 80) || 'Other',
        title: allowedString(item.title, 500),
        year: item.year == null ? null : Number(item.year),
        messageYear: item.messageYear == null ? null : Number(item.messageYear),
        yearCandidates: Array.isArray(item.yearCandidates) ? item.yearCandidates.map(Number).filter(y => Number.isInteger(y) && y >= 1900 && y <= 2099).slice(0, 12) : [],
        quality: allowedString(item.quality, 40) || 'HD',
        size: allowedString(item.size, 40),
        language: allowedString(item.language, 80),
        season: item.season == null ? null : Number(item.season),
        episode: item.episode == null ? null : Number(item.episode),
        fileYear: item.fileYear == null ? null : Number(item.fileYear),
        type: allowedString(item.type, 30) || 'movie',
        filename: allowedString(item.filename, 1000),
        codec: allowedString(item.codec, 80),
        hdr: allowedString(item.hdr, 80),
        audio: allowedString(item.audio, 120),
        bitDepth: allowedString(item.bitDepth, 40),
        audioChannels: allowedString(item.audioChannels, 40),
        audioTracks: incomingAudioTracks.length >= 2 ? incomingAudioTracks : [],
        bypassedUrl: allowedString(item.bypassedUrl, 2000),
        isSeries: !!item.isSeries,
        contentType: allowedString(item.contentType, 40),
        date: allowedString(item.date, 100),
        imdbId: allowedString(item.imdbId, 40),
        tmdbIdHint: item.tmdbIdHint == null ? null : Number(item.tmdbIdHint),
        sourceAccount: String(item.sourceAccount),
        uploadBatch: batch,
        createdAt: now,
        updatedAt: now,
      };
      ops.push({ updateOne: { filter: { url: doc.url }, update: { $setOnInsert: doc }, upsert: true } });
    }
    await stage.bulkWrite(ops, { ordered: false });

    const grouped = await stage.aggregate([
      { $group: { _id: '$sourceAccount', count: { $sum: 1 } } }
    ]).toArray();
    const counts = { account1: 0, account2: 0 };
    for (const row of grouped) {
      if (row._id === '1') counts.account1 = row.count;
      if (row._id === '2') counts.account2 = row.count;
    }
    counts.total = counts.account1 + counts.account2;
    state.received = counts;
    state.updatedAt = new Date().toISOString();
    await PipelineCache.findOneAndUpdate(
      { key: '_telegram_sync_' + syncId },
      { $set: { data: state, updatedAt: new Date() } }
    );
    await saveTelegramSyncState(PipelineCache, state);
    res.json({ ok: true, received: counts, expected: state.expected });
  } catch (err) {
    res.status(500).json({ message: 'Telegram sync chunk failed: ' + err.message });
  }
});

router.post('/telegram-sync/finalize', auth, async (req, res) => {
  const mongoose = require('mongoose');
  const PipelineCache = require('../models/PipelineCache');
  let state = null;
  let swapped = false;
  let syncId = '';
  try {
    syncId = (req.body || {}).syncId || '';
    const sessionDoc = await PipelineCache.findOne({ key: '_telegram_sync_' + syncId }).lean();
    state = sessionDoc && sessionDoc.data;
    if (!state || !['uploading', 'replace_failed'].includes(state.status)) {
      return res.status(409).json({ message: 'Sync session is not ready to finalize.' });
    }

    const db = mongoose.connection.db;
    const stage = db.collection(state.stageCollection);
    const [total, a1, a2] = await Promise.all([
      stage.countDocuments({}),
      stage.countDocuments({ sourceAccount: '1' }),
      stage.countDocuments({ sourceAccount: '2' }),
    ]);
    const expected = state.expected;
    if (total !== expected.total || a1 !== expected.account1 || a2 !== expected.account2) {
      state.status = 'uploading';
      state.received = { account1: a1, account2: a2, total };
      state.verificationError = 'Uploaded counts do not match expected counts. Live data was not changed. Upload remaining chunks and retry finalize.';
      await PipelineCache.findOneAndUpdate(
        { key: '_telegram_sync_' + syncId },
        { $set: { data: state, updatedAt: new Date() } }
      );
      await saveTelegramSyncState(PipelineCache, state);
      return res.status(409).json({ message: state.verificationError, expected, received: state.received });
    }

    state.status = 'finalizing';
    state.received = { account1: a1, account2: a2, total };
    await saveTelegramSyncState(PipelineCache, state);

    const dbName = db.databaseName;
    await db.admin().command({
      renameCollection: dbName + '.' + state.stageCollection,
      to: dbName + '.extractedlinks',
      dropTarget: true,
    });
    swapped = true;

    const now = new Date();
    const uploadBatch = 'telegram_' + syncId;
    await PipelineCache.findOneAndUpdate(
      { key: 'extracted_links' },
      {
        $set: {
          key: 'extracted_links',
          data: { batchId: uploadBatch, count: total, mergeMode: false, source: 'termux-telegram-sync' },
          count: total,
          savedAt: now,
        },
      },
      { upsert: true, new: true }
    ).catch(err => console.error('[telegram-sync] PipelineCache update failed after atomic swap:', err.message));

    const history = await getSyncStatus();
    for (const [account, count] of [['1', a1], ['2', a2]]) {
      history['acc' + account] = {
        date: now.toISOString(),
        dateHuman: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
        source: 'termux',
        links: count,
      };
    }
    await saveSyncStatus(history);

    state.status = 'completed';
    state.completedAt = now.toISOString();
    state.received = { account1: a1, account2: a2, total };
    await PipelineCache.findOneAndUpdate(
      { key: '_telegram_sync_' + syncId },
      { $set: { data: state, updatedAt: now } }
    );
    await saveTelegramSyncState(PipelineCache, state);
    res.json({ ok: true, status: 'completed', counts: state.received });
  } catch (err) {
    console.error('[telegram-sync] finalize failed:', err);
    if (state && syncId) {
      state.status = swapped ? 'completed' : 'replace_failed';
      if (swapped) state.completedAt = state.completedAt || new Date().toISOString();
      else state.verificationError = 'Atomic collection replacement failed; existing live links remain active.';
      try {
        await PipelineCache.findOneAndUpdate(
          { key: '_telegram_sync_' + syncId },
          { $set: { data: state, updatedAt: new Date() } }
        );
        await saveTelegramSyncState(PipelineCache, state);
      } catch (_) {}
    }
    if (swapped) {
      return res.json({ ok: true, status: 'completed', counts: state && state.received, warning: 'Collection replacement succeeded; a follow-up status write failed.' });
    }
    res.status(500).json({
      message: 'Telegram sync finalize failed; existing live links were not replaced: ' + err.message
    });
  }
});

// ── POST /api/scrape/save-extracted — save pre-extracted links from client-side parsing ──
// Supports chunked uploads: client sends 400 links at a time with the same batchId.
// On isFinal=true, cleans up old batches and updates PipelineCache.
router.post('/save-extracted', auth, express.json({ limit: '4mb' }), async (req, res) => {
  // Check abort flag — set by Stop/Wipe buttons to cancel in-progress uploads
  if (_uploadAborted) {
    return res.status(409).json({ aborted: true, message: 'Upload was cancelled. Please re-upload your file.' });
  }
  try {
    const { links: submittedLinks, batchId: incomingBatchId, isFinal, messageCount, skipped, sourceAccount: incomingSourceAccount } = req.body;
    if (!Array.isArray(submittedLinks)) {
      return res.status(400).json({ message: 'No links array provided.' });
    }
    const links = submittedLinks.filter((entry) => isAllowedTelegramDownloadUrl(entry && entry.url));
    const rejectedLinks = submittedLinks.length - links.length;
    if (rejectedLinks > 0) {
      console.log(`[provider-filter] Rejected ${rejectedLinks} unsupported website/provider links.`);
    }
    // Reset abort flag at the start of a NEW upload (first chunk, no batchId yet)
    if (!incomingBatchId) _uploadAborted = false;

    const ExtractedLink = require('../models/ExtractedLink');
    const PipelineCache = require('../models/PipelineCache');

    // Use provided batchId (subsequent chunks) or create new one (first chunk)
    const batchId = incomingBatchId || `batch_${Date.now()}`;
    const mergeMode = req.query.merge === 'true';

    // Tag and insert this chunk. The admin uploader supplies the account explicitly;
    // scraper clients that already tag individual links remain compatible.
    const sourceAccount = ['1', '2'].includes(String(incomingSourceAccount))
      ? String(incomingSourceAccount)
      : '';
    links.forEach(e => {
      e.uploadBatch = batchId;
      const audioTracks = Array.isArray(e.audioTracks)
        ? e.audioTracks.slice(0, 8).filter(track => track && typeof track.codec === 'string' && track.codec.trim())
          .map(track => ({
            codec: track.codec.trim().slice(0, 80),
            channels: typeof track.channels === 'string' ? track.channels.slice(0, 40) : '',
            language: typeof track.language === 'string' ? track.language.slice(0, 80) : '',
          }))
        : [];
      e.audioTracks = audioTracks.length >= 2 ? audioTracks : [];
      if (sourceAccount) e.sourceAccount = sourceAccount;
    });
    if (links.length > 0) {
      const CHUNK = 500;
      for (let i = 0; i < links.length; i += CHUNK) {
        const slice = links.slice(i, i + CHUNK);
        if (mergeMode) {
          // Merge mode: skip URLs that already exist in the database
          const incomingUrls = slice.map(l => l.url);
          const existing = await ExtractedLink.find({ url: { $in: incomingUrls } }).select('url').lean();
          const existingUrls = new Set(existing.map(e => e.url));
          const uniqueLinks = slice.filter(l => !existingUrls.has(l.url));
          if (uniqueLinks.length > 0) {
            await ExtractedLink.insertMany(uniqueLinks, { ordered: false });
          }
          // A merge upload may enrich old URLs with newly parsed explicit audio
          // tracks. Never replace an already complete two-or-more-track record.
          const trackUpdates = slice
            .filter(l => Array.isArray(l.audioTracks) && l.audioTracks.length >= 2)
            .map(l => ({
              updateOne: {
                filter: { url: l.url, 'audioTracks.1': { $exists: false } },
                update: { $set: { audioTracks: l.audioTracks.slice(0, 8) } },
              },
            }));
          if (trackUpdates.length) await ExtractedLink.bulkWrite(trackUpdates, { ordered: false });
        } else {
          // Replace mode: insert everything
          await ExtractedLink.insertMany(slice, { ordered: false });
        }
      }
    }

    // Only finalize on the last chunk
    if (isFinal) {
      if (!mergeMode) {
        // Never wipe the previous extracted-link set when the submitted batch
        // contains no approved provider URLs after filtering.
        const approvedBatchCount = await ExtractedLink.countDocuments({ uploadBatch: batchId });
        if (approvedBatchCount === 0) {
          return res.status(422).json({
            message: 'No approved GDFlix, HubCloud or TMBCloud links found; existing extracted links were preserved.',
            rejectedLinks,
          });
        }
        // Replace mode: delete all other batches (fresh start)
        await ExtractedLink.deleteMany({ uploadBatch: { $ne: batchId } });
      }
      // In merge mode: keep all existing batches — just count total across all
      const totalCount = mergeMode
        ? await ExtractedLink.countDocuments()
        : await ExtractedLink.countDocuments({ uploadBatch: batchId });
      await PipelineCache.findOneAndUpdate(
        { key: 'extracted_links' },
        { key: 'extracted_links', data: { batchId, count: totalCount, mergeMode }, count: totalCount, savedAt: new Date() },
        { upsert: true, new: true }
      );
      try { fs.unlinkSync(path.join(os.tmpdir(), 'links_for_bypasser.json')); } catch(_) {}
      try { fs.unlinkSync(path.join(os.tmpdir(), 'shortlinks_report.json')); } catch(_) {}
      const modeNote = mergeMode ? ` [MERGE — total across all accounts: ${totalCount}]` : '';
      const filterNote = rejectedLinks ? ` Rejected ${rejectedLinks} unsupported website/provider links in this chunk.` : '';
      return res.json({
        message: `[DONE] Extracted ${totalCount} links from ${messageCount || '?'} messages (${skipped || 0} skipped)${modeNote}.${filterNote} Saved to MongoDB. Run Full Pipeline now.`,
        count: totalCount, batchId, mergeMode, rejectedLinks,
      });
    }

    // Intermediate chunk — return batchId so client reuses it
    return res.json({ batchId, inserted: links.length });
  } catch (err) {
    res.status(500).json({ message: `Save failed: ${err.message}` });
  }
});

// ── Shared: build a flexible title regex that matches both space- and dot-separated formats ──
// "Hi Nanna" → /^Hi[\s.]+Nanna(?=[\s.\(\[\-_0-9]|$)/i
// "Iron Man" → /^Iron[\s.]+Man(?=[\s.\(\[\-_0-9]|$)/i
// "RRR"      → /^RRR(?=[\s.\(\[\-_0-9]|$)/i
// This handles both "Hi Nanna (2023) 4K..." and "Hi.Nanna.2023.2160p..." (torrent filenames).
function buildTitleRegex(q, { strict = true } = {}) {
  const parts = q.trim().split(/\s+/).map(p => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const body  = parts.join('[\\s._\\-]+');   // space, dot, underscore, or hyphen between words
  const tail  = strict ? '(?=[\\s._\\-(\\[0-9]|$)' : '';  // word-boundary: "Hi" ≠ "Hichki"
  return new RegExp('^' + body + tail, 'i');
}

// ── JSON Cache — parse telegram_export.json once, reuse for all collection requests ──
// Prevents reading & parsing 50MB+ file on every collection title lookup.
// Cache is invalidated automatically when the file changes (mtime check).
let _jsonCache = null;  // { messages: [], mtime: Number }

async function getJsonMessages() {
  try {
    const stat  = await fs.promises.stat(EXPORT_FILE);
    const mtime = stat.mtimeMs;
    if (_jsonCache && _jsonCache.mtime === mtime) return _jsonCache.messages; // cache hit
    const raw   = await fs.promises.readFile(EXPORT_FILE, 'utf8');
    const data  = JSON.parse(raw);
    let msgs = [];
    if (Array.isArray(data)) {
      msgs = Array.isArray(data[0]?.messages) ? data.flatMap(d => d.messages || []) : data;
    } else if (data.messages) {
      msgs = data.messages;
    }
    // Dedup by channel_id:message_id
    const seen = new Set(); const deduped = [];
    for (const m of msgs) {
      const k = `${m.channel_id||'0'}:${m.id}`;
      if (!seen.has(k)) { seen.add(k); deduped.push(m); }
    }
    _jsonCache = { messages: deduped, mtime };
    return deduped;
  } catch(_) { return null; }
}

// ── Shared shortener filter — used by both json-search-links and collection-links-fuzzy ──
const SHORTENER_FILTER_RE = /fpgo\.xyz|filepress\.|bit\.ly|tinyurl\.com|gplinks\.co|vplink\.in|dtflix\.ink|dd-stream\.vercel\.app|driveleech\.|linkshost\.|shareus\.|ouo\.io|adf\.ly|youtu\.be|youtube\.com|t\.me|instafily\.|link\.sharechat/i;

// ── GET /api/scrape/collection-search — search ExtractedLink by title (from uploaded JSON) ──
// Returns distinct title groups matching the query, ordered by title.
router.get('/collection-search', auth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'DB not connected', results: [] });
    const ExtractedLink = require('../models/ExtractedLink');
    const q    = (req.query.q    || '').trim();
    const year = (req.query.year || '').trim();
    if (!q) return res.json({ results: [] });

    // Use flexible regex: handles space- AND dot-separated title formats
    const regex    = buildTitleRegex(q, { strict: true });
    const yearNum  = year && /^\d{4}$/.test(year) ? parseInt(year, 10) : null;
    const matchStg = yearNum ? { title: regex, year: yearNum } : { title: regex };

    // Fallback: if strict matches nothing, try non-strict (substring)
    let groups = await ExtractedLink.aggregate([
      { $match: matchStg },
      { $group: {
        _id: '$title',
        title:       { $first: '$title' },
        year:        { $first: '$year' },
        contentType: { $first: '$contentType' },
        isSeries:    { $first: '$isSeries' },
        linkCount:   { $sum: 1 },
        qualities:   { $addToSet: '$quality' },
        languages:   { $addToSet: '$language' },
      }},
      { $sort: { title: 1 } },
      { $limit: 200 },  // increased from 50 — wide queries return more title groups
    ]).option({ maxTimeMS: 12000 });
    if (!groups.length) {
      // Strict DB search found nothing — fall back to loose substring search
      const looseRegex = buildTitleRegex(q, { strict: false });
      const looseMatch  = yearNum ? { title: looseRegex, year: yearNum } : { title: looseRegex };
      groups = await ExtractedLink.aggregate([
        { $match: looseMatch },
        { $group: {
          _id: '$title', title: { $first: '$title' }, year: { $first: '$year' },
          contentType: { $first: '$contentType' }, isSeries: { $first: '$isSeries' },
          linkCount: { $sum: 1 }, qualities: { $addToSet: '$quality' }, languages: { $addToSet: '$language' },
        }},
        { $sort: { title: 1 } },
        { $limit: 200 },
      ]).option({ maxTimeMS: 12000 });
    }

    // If DB has nothing — also scan JSON directly so batch import doesn't say "not found"
    // when the title exists in the JSON but not yet in the DB (e.g. DB was never re-uploaded).
    if (!groups.length) {
      try {
        const msgs = await getJsonMessages();
        if (msgs) {
          const { parseMessageBlock, isJunkTitle } = require('../utils/parser');
          const strictRe = buildTitleRegex(q, { strict: true });
          const looseRe2 = buildTitleRegex(q, { strict: false });
          const jsonGroups = new Map();
          for (const msg of msgs) {
            let rawText = '';
            if (typeof msg.text === 'string') rawText = msg.text;
            else if (Array.isArray(msg.text)) rawText = msg.text.map(p =>
              typeof p === 'string' ? p : (p.type === 'text_link' && p.href ? `${p.text}\n${p.href}\n` : p.text||'')).join('');
            if (!rawText.trim()) continue;
            let parsed; try { parsed = parseMessageBlock(rawText, msg.id); } catch(_) { continue; }
            if (!parsed || !parsed.title || isJunkTitle(parsed.title) || !parsed.downloads?.length) continue;
            if (!strictRe.test(parsed.title) && !looseRe2.test(parsed.title)) continue;
            // Year filter — only apply if both query year and parsed year are known
            if (yearNum && parsed.year && parsed.year !== yearNum) continue;
            if (!jsonGroups.has(parsed.title)) {
              jsonGroups.set(parsed.title, { _id: parsed.title, title: parsed.title, year: parsed.year,
                contentType: parsed.contentType || 'movie', isSeries: parsed.isSeries || false, linkCount: 0,
                qualities: [], languages: [], _fromJson: true });
            }
            const g = jsonGroups.get(parsed.title);
            g.linkCount += parsed.downloads.reduce((a,d) => a + (d.links||[]).length, 0);
          }
          groups = [...jsonGroups.values()].sort((a,b) => a.title.localeCompare(b.title)).slice(0, 200);
        }
      } catch(_) { /* JSON scan failed silently */ }
    }

    res.json({ results: groups });
  } catch (err) {
    res.status(500).json({ error: err.message, results: [] });
  }
});

// ── GET /api/scrape/collection-links — fetch all download links for a title from ExtractedLink ──
router.get('/collection-links', auth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'DB not connected', links: [] });
    const ExtractedLink = require('../models/ExtractedLink');
    const title = (req.query.title || '').trim();
    if (!title) return res.json({ links: [] });

    const regex = new RegExp('^' + title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$', 'i');
    const links = await ExtractedLink.find({ title: regex })
      .select('title year quality size filename fileYear language host url bypassedUrl isSeries season episode contentType codec hdr audio bitDepth audioChannels audioTracks sourceAccount')
      .sort({ quality: -1, size: -1 })
      .maxTimeMS(8000)
      .lean();

    const enrichedLinks = links.map(link => ({ ...link, source: require('../utils/parser').detectSource(link.filename || '') }));
    const variantAnalysis = analyzeVariantSet(enrichedLinks);
    const rankedLinks = rankVariantsForDisplay(enrichedLinks, { sizeTolerance: 0.08 });
    res.json({ title, count: rankedLinks.length, links: rankedLinks, variantAnalysis });
  } catch (err) {
    res.status(500).json({ error: err.message, links: [] });
  }
});

// ── GET /api/scrape/collection-links-fuzzy — ALL links for a keyword across all quality variants ──
// Searches ExtractedLink titles by PREFIX regex (index-efficient) — since Telegram titles
// always start with the movie name (e.g. "Iron Man (2008) 2160p BLURAY..." starts with "Iron Man").
// Returns ALL matching links across every quality/format variant for the given title.
router.get('/collection-links-fuzzy', auth, async (req, res) => {
  try {
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) return res.status(503).json({ error: 'DB not connected', links: [] });
    const ExtractedLink = require('../models/ExtractedLink');
    const q    = (req.query.q || '').trim();
    const year = (req.query.year || '').trim();
    if (!q) return res.json({ links: [] });

    // Build flexible regex: "Hi Nanna" matches both "Hi Nanna (2023) 4K..." AND "Hi.Nanna.2023.2160p..."
    // Strategy 1: strict (word-boundary after title) — prevents "Hi" matching "Hichki"
    const strictRegex = buildTitleRegex(q, { strict: true });
    // Search BOTH title and filename fields.
    // title = clean movie name ("Hi Nanna"). filename = full torrent string ("Hi.Nanna.2023.2160p...").
    // A single message can have the movie name in title but its individual files listed under filename.
    let titleFilter = { title: strictRegex };
    let fileFilter  = { filename: strictRegex };
    if (year && /^\d{4}$/.test(year)) {
      const yr = parseInt(year, 10);
      titleFilter.year = yr;
      fileFilter.year  = yr;
    }

    const [titleLinks, fileLinks] = await Promise.all([
      ExtractedLink.find(titleFilter)
        .select('title year messageYear yearCandidates quality size filename fileYear language host url bypassedUrl isSeries season episode contentType codec hdr audio bitDepth audioChannels audioTracks sourceAccount')
        .lean(),
      ExtractedLink.find(fileFilter)
        .select('title year quality size filename language host url bypassedUrl isSeries season episode contentType codec hdr audio bitDepth audioChannels audioTracks sourceAccount')
        .lean(),
    ]);
    const seenInit = new Set(titleLinks.map(l => l.url));
    let links = [...titleLinks, ...fileLinks.filter(l => !seenInit.has(l.url))];

    // Strategy 2: if combined result <3, retry with loose regex (no word-boundary)
    if (links.length < 3) {
      const looseRegex = buildTitleRegex(q, { strict: false });
      const looseFilter = { $or: [{ title: looseRegex }, { filename: looseRegex }] };
      if (year && /^\d{4}$/.test(year)) looseFilter.year = parseInt(year, 10);
      const looseLinks = await ExtractedLink.find(looseFilter)
        .select('title year quality size filename language host url bypassedUrl isSeries season episode contentType codec hdr audio bitDepth audioChannels audioTracks sourceAccount')
        .lean();
      const seen2 = new Set(links.map(l => l.url));
      links = [...links, ...looseLinks.filter(l => !seen2.has(l.url))];
    }

    // ── Filter out shortener/redirector links — keep only real cloud storage ──
    // Filter shorteners using shared SHORTENER_RE constant
    links = links.filter(l => {
      const u = (l.bypassedUrl || l.url || '');
      return u && !SHORTENER_RE.test(u);
    });

    // Deduplicate by URL
    const seenUrls = new Set();
    links = links.filter(l => {
      const u = l.bypassedUrl || l.url || '';
      if (!u || seenUrls.has(u)) return false;
      seenUrls.add(u);
      return true;
    });

    // Build a clean display title: pick the shortest title (most likely the clean base title)
    const titles = [...new Set(links.map(l => l.title).filter(Boolean))];
    const displayTitle = titles.sort((a, b) => a.length - b.length)[0] || q;

    const enrichedLinks = links.map(link => ({ ...link, source: require('../utils/parser').detectSource(link.filename || '') }));
    const variantAnalysis = analyzeVariantSet(enrichedLinks);
    const rankedLinks = rankVariantsForDisplay(enrichedLinks, { sizeTolerance: 0.08 });
    res.json({ query: q, year, displayTitle, count: rankedLinks.length, links: rankedLinks, variantAnalysis });
  } catch (err) {
    res.status(500).json({ error: err.message, links: [] });
  }
});


// ── GET /api/scrape/json-search-links — search telegram_export.json DIRECTLY ──
// Bypasses DB — reads raw JSON, parses with real parser, returns ALL matching links.
// Uses module-level cache (getJsonMessages) — JSON only read/parsed when file changes.
router.get('/json-search-links', auth, async (req, res) => {
  try {
    const q    = (req.query.q    || '').trim();
    const year = (req.query.year || '').trim();
    if (!q) return res.json({ links: [], source: 'json' });

    // Check file exists without blocking
    try { await fs.promises.access(EXPORT_FILE); }
    catch(_) { return res.json({ links: [], source: 'none', error: 'telegram_export.json not found. Upload via Scraper.' }); }

    // Get cached messages (async, non-blocking)
    const allMessages = await getJsonMessages();
    if (!allMessages) return res.status(500).json({ links: [], source: 'json', error: 'Failed to read JSON file.' });

    const { parseMessageBlock, isJunkTitle } = require('../utils/parser');

    // Use shared buildTitleRegex for consistent matching logic
    const strictRe = buildTitleRegex(q, { strict: true });
    const looseRe  = buildTitleRegex(q, { strict: false });
    const yearNum  = year && /^\d{4}$/.test(year) ? parseInt(year, 10) : null;

    const links    = [];
    const seenUrls = new Set();

    for (const msg of allMessages) {
      // Extract raw text from message (same logic as upload-export route)
      let rawText = '';
      if (typeof msg.text === 'string') rawText = msg.text;
      else if (Array.isArray(msg.text)) rawText = msg.text.map(p => {
        if (typeof p === 'string') return p;
        if (p.type === 'text_link' && p.href) return `${p.text}\n${p.href}\n`;
        return p.text || '';
      }).join('');
      if (msg.reply_markup?.inline_keyboard) {
        for (const row of msg.reply_markup.inline_keyboard)
          for (const btn of (row||[])) if (btn.url) rawText += `\n${btn.url}`;
      }
      if (!rawText.trim()) continue;

      let parsed;
      try { parsed = parseMessageBlock(rawText, msg.id); } catch(_) { continue; }
      if (!parsed || !parsed.title || isJunkTitle(parsed.title) || !parsed.downloads?.length) continue;

      // Title must match query (strict first, loose fallback)
      if (!strictRe.test(parsed.title) && !looseRe.test(parsed.title)) continue;
      // Year filter: only filter if BOTH query year AND parsed year are known
      if (yearNum && parsed.year && parsed.year !== yearNum) continue;

      // Collect ALL links from all download slots — no host cap
      for (const dl of (parsed.downloads || [])) {
        for (const lk of (dl.links || [])) {
          const url = (lk.url || '').trim();
          if (!url || seenUrls.has(url) || SHORTENER_RE.test(url)) continue;
          seenUrls.add(url);
          links.push({
            title:       parsed.title,
            year:        parsed.year   || null,
            quality:     dl.quality   || '',
            size:        dl.size      || '',
            filename:    dl.filename  || parsed.title || '',
            language:    dl.language  || parsed.language || '',
            host:        lk.host     || '',
            url,
            bypassedUrl: null,   // raw JSON has no bypassed URLs — they come from pipeline bypass step
            isSeries:    parsed.isSeries   || false,
            contentType: parsed.contentType || 'movie',
            season:      dl.season   ?? parsed.season  ?? null,
            episode:     dl.episode  ?? parsed.episode ?? null,
          });
        }
      }
    }

    const displayTitle = links.length ? links[0].title : q;
    res.json({ query: q, year, displayTitle, count: links.length, links, source: 'json' });
  } catch (err) {
    res.status(500).json({ error: err.message, links: [], source: 'json' });
  }
});

module.exports = router;
