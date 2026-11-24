const express = require('express');
const router = express.Router();
const path = require('path');
const auth = require('../middleware/auth');
// Cross-module: allow orchestrator to abort in-progress uploads
function abortUpload() {
  try { require('./scrape').setUploadAborted(true); } catch(_) {}
}

// pipeline_full is lazy-loaded inside the route handlers so it doesn't
// get bundled/required on every Vercel cold start (it pulls in ESM-only deps)
let _runPipeline = null;
async function getRunPipeline() {
  if (!_runPipeline) {
    _runPipeline = require('../pipeline_full').runPipeline;
  }
  return _runPipeline;
}

let pipelineRunning  = false;  // is a pipeline running?
let pipelinePromise  = null;   // the in-flight Promise
let clients          = [];     // active SSE connections
let logBuffer        = [];     // last 500 lines for replay
let pipelineProgress = { offset: 0, total: 0, label: '' }; // live progress
const MAX_LOG_HISTORY = 500;

// ── Log persistence (MongoDB) — survives Vercel instance restarts ────────────
let _logPersistTimer = null;
async function persistLogs() {
  if (!logBuffer.length) return;
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1)
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    await PipelineCache.findOneAndUpdate(
      { key: '_pipeline_logs' },
      { $set: { data: logBuffer.slice(-200), updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (_) { /* non-critical */ }
}

// ── Broadcast a log line to all SSE clients ───────────────────────────────────
function broadcast(message) {
  // Strip ANSI color codes
  const clean = message.replace(/\x1b\[[0-9;]*m/g, '');
  logBuffer.push(clean);
  if (logBuffer.length > MAX_LOG_HISTORY) logBuffer.shift();

  // Debounced persist — write to MongoDB at most every 3s
  if (!_logPersistTimer) {
    _logPersistTimer = setTimeout(() => { _logPersistTimer = null; persistLogs(); }, 3000);
  }

  const payload = `data: ${JSON.stringify({ text: clean })}\n\n`;
  clients = clients.filter(c => {
    try { c.res.write(payload); return true; }
    catch (_) { return false; }
  });
}

// ── SSE stream endpoint ───────────────────────────────────────────────────────
router.get('/stream', auth, async (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  clients.push({ id: clientId, res });

  // ── Replay logs to reconnecting client ──────────────────────────────────────
  // Priority: in-memory logBuffer (same Lambda) → MongoDB (different Lambda/phone)
  let replayLines = logBuffer.slice(-150);

  if (replayLines.length === 0) {
    // This Lambda has no logs — we're on a different instance (phone, new tab, etc.)
    // Load persisted logs from MongoDB so the client sees the live history
    try {
      const PipelineCache = require('../models/PipelineCache');
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1)
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
      const doc = await PipelineCache.findOne({ key: '_pipeline_logs' }).lean();
      if (doc?.data?.length) {
        replayLines = doc.data.slice(-150);
        // Also seed local logBuffer so subsequent broadcasts work correctly
        logBuffer = [...replayLines];
      }
    } catch (_) { /* non-critical — proceed without logs */ }
  }

  if (replayLines.length > 0) {
    for (const line of replayLines) {
      try { res.write(`data: ${JSON.stringify({ text: line })}\n\n`); } catch(_) { break; }
    }
  } else {
    res.write(`data: ${JSON.stringify({ text: '[INFO] Connected to live stream.' })}\n\n`);
    // Also load pipeline status from MongoDB so phone knows if it's still running
    try {
      const PipelineCache = require('../models/PipelineCache');
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1)
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
      const flag = await PipelineCache.findOne({ key: '_pipeline_running' }).lean();
      if (flag?.running) {
        res.write(`data: ${JSON.stringify({ text: '[INFO] Pipeline is currently running — logs will appear below.' })}\n\n`);
        pipelineRunning = true; // sync local flag
      }
    } catch (_) {}
  }

  // ── Poll MongoDB for new logs every 3s when this is a cross-instance client ──
  // This ensures the phone gets live updates even from a different Lambda.
  let lastLogCount = replayLines.length;
  const pollInterval = setInterval(async () => {
    // If we have local clients broadcasting, no need to poll
    if (clients.length > 1 || logBuffer.length > lastLogCount) {
      lastLogCount = logBuffer.length;
      return;
    }
    // No local pipeline running — poll MongoDB for new logs
    try {
      const PipelineCache = require('../models/PipelineCache');
      const doc = await PipelineCache.findOne({ key: '_pipeline_logs' }).lean();
      const dbLines = doc?.data || [];
      if (dbLines.length > lastLogCount) {
        // Send only the new lines
        const newLines = dbLines.slice(lastLogCount);
        for (const line of newLines) {
          try { res.write(`data: ${JSON.stringify({ text: line })}\n\n`); } catch(_) { break; }
        }
        lastLogCount = dbLines.length;
        // Sync into local buffer
        logBuffer = dbLines.slice(-500);
      }
    } catch (_) {}
  }, 3000);

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch (_) { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
    clearInterval(pollInterval);
    clients = clients.filter(c => c.id !== clientId);
  });
});


// ── Status ────────────────────────────────────────────────────────────────────
router.get('/status', async (req, res) => {
  if (pipelineRunning) return res.json({ running: true, ...pipelineProgress });
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    }
    const flag = await PipelineCache.findOne({ key: '_pipeline_running' }).lean();
    const isRunning = flag && flag.running === true &&
      (Date.now() - new Date(flag.updatedAt || 0).getTime() < 10 * 60 * 1000); // 10-min stale timeout
    const progress = await PipelineCache.findOne({ key: '_pipeline_progress' }).lean();
    return res.json({
      running: !!isRunning,
      offset: progress?.offset || 0,
      total:  progress?.total  || 0,
      label:  progress?.label  || '',
    });
  } catch (_) {
    return res.json({ running: pipelineRunning, ...pipelineProgress });
  }
});

// Persist running state + progress to MongoDB so all serverless instances agree
async function setPipelineRunningFlag(running, progressData = null) {
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    }
    await PipelineCache.findOneAndUpdate(
      { key: '_pipeline_running' },
      { $set: { running, updatedAt: new Date() } },
      { upsert: true }
    );
    if (progressData) {
      await PipelineCache.findOneAndUpdate(
        { key: '_pipeline_progress' },
        { $set: { ...progressData, updatedAt: new Date() } },
        { upsert: true }
      );
    }
  } catch (_) { /* non-critical */ }
}

// ── Start pipeline (auth via ?token= since EventSource cannot send headers) ──
router.get('/start', auth, async (req, res) => {
  // Check MongoDB flag first — catches stale flags from crashed/timed-out runs
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    }
    const flag = await PipelineCache.findOne({ key: '_pipeline_running' }).lean();
    const ageMs = Date.now() - new Date(flag?.updatedAt || 0).getTime();
    const STALE_MS = 10 * 60 * 1000;
    if (flag && flag.running === true) {
      if (ageMs < STALE_MS) {
        return res.status(400).json({ error: 'Pipeline is already running' });
      }
      pipelineRunning = false;
      await PipelineCache.findOneAndUpdate({ key: '_pipeline_running' }, { $set: { running: false, updatedAt: new Date() } });
    } else {
      pipelineRunning = false;
    }
  } catch (_) {}

  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const skipScraper = req.query.skipScraper === 'true';
  const resume = req.query.resume === 'true';
  const scope       = req.query.scope || 'all';          // 'all' | 'daily' | 'title'
  const titleFilter = (req.query.titleFilter || '').trim();
  // If skipBypass is explicitly passed, parse it. Otherwise default to skipScraper.
  const skipBypass = req.query.skipBypass ? req.query.skipBypass === 'true' : skipScraper;
  const scopeLabel  = scope === 'daily' ? ' [Today\'s New]' : scope === 'title' && titleFilter ? ` [Title: ${titleFilter}]` : '';
  const label = (skipScraper ? 'Skip Scraper (import-only)' : 'Full Pipeline') + scopeLabel;

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  _stopRequested = false;
  pipelineRunning = true;
  // On resume, preserve existing offset so UI shows correct resume point.
  // On fresh start, reset to 0.
  if (!resume) pipelineProgress = { offset: 0, total: 0, label };
  else pipelineProgress.label = label;
  setPipelineRunningFlag(true);

  const emit = (msg) => {
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    // Parse [PROGRESS] lines — update in-memory AND persist to MongoDB
    const progMatch = clean.match(/\[PROGRESS\]\s+(\d+)\s*\/\s*(\d+)/);
    if (progMatch) {
      pipelineProgress.offset = parseInt(progMatch[1]);
      pipelineProgress.total  = parseInt(progMatch[2]);
      setPipelineRunningFlag(true, {
        offset: pipelineProgress.offset,
        total:  pipelineProgress.total,
        label,
      }).catch(() => {});
    }
    // ALWAYS broadcast to ALL connected SSE clients (including /stream subscribers
    // on other devices/tabs). This also fills logBuffer so reconnecting clients
    // get full history even after the original tab that started the pipeline closes.
    broadcast(clean);
    // Also write directly to this SSE response while it's still alive
    // (broadcast above handles the general case; this ensures zero latency for
    // the starting tab before it's added to clients[] via /stream).
    try { res.write(`data: ${JSON.stringify({ text: clean })}\n\n`); } catch (_) { }
  };

  emit(`[START] ${label}...`);
  if (skipScraper) {
    emit(`[INFO] Skip Scraper: re-extracting from telegram_export.json (skipping Telegram API scrape)`);
  } else {
    emit(`[INFO] Full Pipeline: scraping Telegram → extracting → importing`);
  }
  if (scope === 'daily') emit(`[INFO] Scope: Today's new content only (filtering by today's date)`);
  if (scope === 'title' && titleFilter) emit(`[INFO] Scope: Searching for title matching "${titleFilter}"`);
  emit(`[INFO] Pipeline running in background — safe to close this tab. Check status anytime.`);

  let importSrc = undefined;

  // ── Fire pipeline detached from HTTP response ─────────────────────────────
  // Using setImmediate detaches the async work from the SSE response lifecycle.
  // The pipeline keeps running even if the browser closes the SSE connection.
  // Logs are written to SSE while connected; status is polled via /status when reconnected.
  setImmediate(async () => {
    try {
      const runPipeline = await getRunPipeline();
      await runPipeline({
        // skipBypass is always defined here (line 156), so just use it directly
        noBypass: !!skipBypass,
        noWipe: !!skipScraper,
        fromMongoDB: !!skipScraper,
        resume: !!resume,
        importSrc,
        scope,
        titleFilter: titleFilter || undefined,
        emitter: emit,
        isStopRequested: () => _stopRequested,
      });
      emit('[DONE] Pipeline finished successfully.');
    } catch (err) {
      emit(`[ERROR] Pipeline error: ${err.message}`);
    } finally {
      pipelineRunning = false;
      setPipelineRunningFlag(false);
      try { res.end(); } catch(_) {}
    }
  });

  // Keep SSE connection alive with heartbeats (client reconnects using /stream after refresh)
  const _hb = setInterval(() => {
    try { res.write(': ping\n\n'); }
    catch(_) { clearInterval(_hb); } // browser disconnected — pipeline still runs
  }, 20000);
  req.on('close', () => clearInterval(_hb));
});

// ── Start pipeline (POST — backward compat for dashboard.html) ────────────────
// dashboard.html uses POST; orchestrator.html uses GET EventSource.
// This POST version just kicks off via the shared broadcast channel.
router.post('/start', auth, async (req, res) => {
  // Check MongoDB flag first — catches stale flags from crashed/timed-out runs on ANY instance
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    }
    const flag = await PipelineCache.findOne({ key: '_pipeline_running' }).lean();
    const ageMs = Date.now() - new Date(flag?.updatedAt || 0).getTime();
    const STALE_MS = 10 * 60 * 1000; // 10 minutes — if older, treat as stale/crashed
    if (flag && flag.running === true) {
      if (ageMs < STALE_MS) {
        return res.status(400).json({ error: 'Pipeline is already running' });
      }
      // Stale flag (>10 min) — auto-clear it so we can start fresh
      pipelineRunning = false;
      await PipelineCache.findOneAndUpdate({ key: '_pipeline_running' }, { $set: { running: false, updatedAt: new Date() } });
    } else {
      pipelineRunning = false;
    }
  } catch (_) { /* non-critical — proceed */ }

  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const { skipScraper, resume, skipBypass, scope = 'all', titleFilter = '' } = req.body || {};
  const scopeLabel = scope === 'daily' ? ' [Today\'s New]' : (scope === 'title' && titleFilter ? ` [Title: ${titleFilter}]` : '');
  const label = (skipScraper ? 'Skip Scraper (import-only)' : 'Full Pipeline') + scopeLabel;

  // Respond immediately — pipeline runs fully detached via setImmediate
  res.json({ message: `${label} started` });

  _stopRequested = false;
  pipelineRunning = true;
  pipelineProgress = { offset: 0, total: 0, label };
  setPipelineRunningFlag(true);
  broadcast(`[START] ${label}...`);
  broadcast(`[INFO] Pipeline running in background — safe to close this tab.`);
  if (skipScraper) broadcast(`[INFO] Skip Scraper: importing approved links directly from MongoDB ExtractedLink (no scrape or upload)`);
  if (scope === 'daily') broadcast(`[INFO] Scope: Today's new content only`);
  if (scope === 'title' && titleFilter) broadcast(`[INFO] Scope: Searching for title matching "${titleFilter}"`);

  setImmediate(async () => {
    try {
      const runPipeline = await getRunPipeline();
      await runPipeline({
        // If skipBypass not explicitly set, default to skipScraper
        // (Skip Scraper = import-only = no bypass needed)
        noBypass: skipBypass !== undefined ? !!skipBypass : !!skipScraper,
        noWipe: !!skipScraper,
        fromMongoDB: !!skipScraper,
        resume: !!resume,
        scope,
        titleFilter: titleFilter || undefined,
        emitter: broadcast,
        isStopRequested: () => _stopRequested,
      });
      broadcast('[DONE] Pipeline finished successfully.');
    } catch (err) {
      broadcast(`[ERROR] Pipeline error: ${err.message}`);
    } finally {
      pipelineRunning = false;
      pipelinePromise = null;
      setPipelineRunningFlag(false);
    }
  });
});

// -- Import Batch: fully enriched TMDB+OMDB per group (Vercel-timeout safe) --
// Each call processes batchSize groups with real poster/metadata lookup.
// Frontend chains: offset=0 => offset+=batchSize => ... until done=true
router.post('/import-batch', auth, async (req, res) => {
  const body = req.body || {};
  const offset = Math.max(0, Number.parseInt(body.offset, 10) || 0);
  const requestedBatchSize = Number.parseInt(body.batchSize, 10) || 1;
  const batchSize = Math.min(5, Math.max(1, requestedBatchSize));
  const mongoose = require('mongoose');
  const ExtractedLinkM = require('../models/ExtractedLink');
  const Movie = require('../models/Movie');
  const { cleanTitleForApi, detectHost, classifyUrl, extractYear } = require('../utils/parser');
  const { normalizeTelegramUrl } = require('../utils/telegram-ingestion');
  const { searchTMDB, searchOMDB, toMB, detectCodecLocal, seasonFromFilename, recomputeAggregates, searchGoogleImage } = require('../pipeline_full');

  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
    }

    const links = await ExtractedLinkM.find({}).lean();
    if (!links.length) {
      return res.json({ done: true, added: 0, updated: 0, skipped: 0, total: 0, nextOffset: 0, message: 'No links cached. Run Full Pipeline first.' });
    }

    // Normalize and validate legacy/new records consistently before import.
    // This also repairs stale host labels when the URL itself identifies the real host.
    const groups = new Map();
    const seenImportUrls = new Set();
    for (const item of links) {
      const normalizedUrl = normalizeTelegramUrl(item.url);
      if (!normalizedUrl) continue;
      const actualHost = classifyUrl(normalizedUrl);
      if (actualHost === 'Ignore' || actualHost === 'Paste') continue;
      if (actualHost === 'Shortlink' && !item.bypassedUrl) continue;
      if (seenImportUrls.has(normalizedUrl)) continue;
      seenImportUrls.add(normalizedUrl);

      const cTitle = cleanTitleForApi(item.title || '', item.year);
      if (!cTitle || cTitle.length < 2) continue;
      const isSeriesEntry = !!(item.isSeries || item.contentType === 'series' || item.contentType === 'anime');
      const groupYear = isSeriesEntry ? (item.messageYear || '') : (item.messageYear || item.year || '');
      const key = cTitle.toLowerCase() + '__' + groupYear;
      if (!groups.has(key)) groups.set(key, { items: [], msgDate: item.date || null });
      groups.get(key).items.push({ ...item, url: normalizedUrl, host: detectHost(normalizedUrl) });
    }
    const groupEntries = [...groups.entries()];
    const total = groupEntries.length;
    if (!total) {
      return res.json({ done: true, added: 0, updated: 0, skipped: links.length, total: 0, nextOffset: 0, message: 'No valid importable Telegram links found.' });
    }
    const thisBatch = groupEntries.slice(offset, offset + batchSize);
    const nextOffset = offset + thisBatch.length;
    const done = nextOffset >= total;

    let added = 0, updated = 0, skipped = 0;
    const logs = [];
    const emit = (m) => {
      const c = m.replace(/\x1b\[[0-9;]*m/g, '');
      logs.push(c);
      broadcast(c);
    };

    const progressPercent = total ? Math.round(nextOffset / total * 100) : 100;
    emit('[PROGRESS] ' + nextOffset + ' / ' + total + ' (' + progressPercent + '%)');
    emit('Batch ' + (Math.floor(offset / batchSize) + 1) + ': groups ' + (offset + 1) + '-' + nextOffset + ' of ' + total);
    // Persist progress so /status and UI can show resume point
    pipelineProgress = { offset: nextOffset, total, label: 'Skip Scraper (import-only)' };
    setPipelineRunningFlag(pipelineRunning, { offset: nextOffset, total, label: 'Skip Scraper (import-only)' });

    for (const [, group] of thisBatch) {
      try {
        const rep = group.items[0];
        const isSer = !!(rep.isSeries || rep.contentType === 'series' || rep.contentType === 'anime');
        const cleanTitle = cleanTitleForApi(rep.title || '', rep.messageYear || rep.year);
        if (!cleanTitle || cleanTitle.length < 2) { skipped++; continue; }

        // Reuse the same show record even when an upload belongs to a later season.
        const escapedTitle = [...cleanTitle].map(char =>
          '$^.*+?()[]{}|'.includes(char) || char === String.fromCharCode(92)
            ? String.fromCharCode(92) + char : char
        ).join('');
        const titleRegex = new RegExp('^' + escapedTitle + '$', 'i');
        const expectedTypes = isSer ? { $in: ['series', 'anime'] } : 'movie';
        let existing = null;
        if (rep.tmdbIdHint) existing = await Movie.findOne({ tmdbId: String(rep.tmdbIdHint), type: expectedTypes });
        if (!existing && isSer && rep.messageYear) {
          existing = await Movie.findOne({ title: titleRegex, type: expectedTypes, year: Number(rep.messageYear) });
        }
        if (!existing && !isSer && rep.year) {
          existing = await Movie.findOne({ title: titleRegex, type: expectedTypes, year: Number(rep.year) });
        }
        if (!existing) existing = await Movie.findOne({ title: titleRegex, type: expectedTypes });

        // Full TMDB + OMDB enrichment
        let meta = {};
        const tmdbSeason = rep.season || null;
        const yearHints = [...new Set([rep.messageYear, rep.year, ...(rep.yearCandidates || []),
          ...group.items.map(file => file.fileYear || extractYear([file.filename]))].filter(Boolean).map(Number))];
        const seasonYearHints = group.items.filter(file => !tmdbSeason || Number(file.season) === Number(tmdbSeason))
          .map(file => file.fileYear || extractYear([file.filename])).filter(Boolean);
        const titleYearHint = isSer ? (rep.messageYear || null) : (rep.messageYear || rep.year);
        const tmdb = await searchTMDB(cleanTitle, titleYearHint, isSer, tmdbSeason, group.msgDate,
          rep.imdbId || null, rep.tmdbIdHint || null, yearHints, seasonYearHints);
        if (tmdb) {
          Object.assign(meta, tmdb);
          // Always fetch OMDB for rating, imdbId, and fallback poster
          const omdb = await searchOMDB(cleanTitle, titleYearHint, isSer, yearHints);
          if (omdb) {
            if (!meta.rating && omdb.rating)           meta.rating = omdb.rating;
            if (!meta.description && omdb.description) meta.description = omdb.description;
            if (!meta.duration && omdb.duration)       meta.duration = omdb.duration;
            if (!(meta.genre && meta.genre.length) && omdb.genre && omdb.genre.length) meta.genre = omdb.genre;
            if (omdb.imdbId)                           meta.imdbId = omdb.imdbId;
            // Store OMDB poster as posterFallback when TMDB poster differs
            if (omdb.poster && omdb.poster !== meta.poster) meta.posterFallback = omdb.poster;
          }
        } else {
          const omdb = await searchOMDB(cleanTitle, titleYearHint, isSer, yearHints);
          if (omdb) Object.assign(meta, omdb, { tmdbId: '' });
        }
        // Google Image fallback when poster still empty
        if (!meta.poster) {
          const gImg = await searchGoogleImage(rep.title, titleYearHint, isSer);
          if (gImg) { meta.poster = gImg; emit(`[IMG] Google image: ${rep.title}`); }
        }

        const genreLower = (meta.genre || []).map(g => (g || '').toLowerCase());
        const isAnim = genreLower.some(g => /animation|anime/.test(g));
        const origLang = (meta.originalLanguage || '').toLowerCase();
        const isEast = /^(japanese|korean|chinese|mandarin|cantonese|ja|ko|zh)$/.test(origLang);
        const isAnimeContent = rep.contentType === 'anime';
        let finalType;
        if ((isAnim && isEast) || (isAnimeContent && (isAnim || isEast)) || isAnimeContent) finalType = 'anime';
        else if (meta.type === 'series' || isSer) finalType = 'series';
        else finalType = 'movie';

        const finalTitle = meta.title || cleanTitle || rep.title;
        const origLang2 = meta.originalLanguage || meta.language || '';

        // Insert / Merge items
        for (const item of group.items) {
          let finalUrl = item.bypassedUrl || item.url;
          finalUrl = finalUrl.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');
          const host = detectHost(finalUrl);

          if (host === 'Shortlink' && !item.bypassedUrl) { skipped++; continue; }

          const quality = item.quality || 'HD';
          const size = item.size || '';
          const language = item.language || '';
          const codec = item.codec || detectCodecLocal(item.filename);
          const hdr = item.hdr || null;
          const audio = item.audio || null;
          const audioTracks = Array.isArray(item.audioTracks) && item.audioTracks.length >= 2 ? item.audioTracks.slice(0, 8) : [];
          const correctSeason = seasonFromFilename(item.filename) ?? item.season ?? null;

          let dbRec = existing;
          if (!dbRec && meta.tmdbId) {
            dbRec = await Movie.findOne({ tmdbId: meta.tmdbId, type: expectedTypes });
            existing = dbRec;
          }

          const newDl = {
            quality, size, filename: item.filename || '', language, codec, hdr, audio, audioTracks,
            season: correctSeason, episode: item.episode ?? null,
            fileYear: item.fileYear || extractYear([item.filename]) || null,
            links: [{ host, url: finalUrl, isFast: /gdflix|hubcloud|gdlink/i.test(finalUrl) }],
          };

          if (dbRec) {
            const duplicateDownloadIndex = dbRec.downloads?.findIndex(d => d.links?.some(l => l.url === finalUrl)) ?? -1;
            if (duplicateDownloadIndex >= 0) {
              const savedTracks = dbRec.downloads[duplicateDownloadIndex]?.audioTracks;
              if (audioTracks.length >= 2 && (!Array.isArray(savedTracks) || savedTracks.length < 2)) {
                await Movie.findByIdAndUpdate(dbRec._id, {
                  $set: { [`downloads.${duplicateDownloadIndex}.audioTracks`]: audioTracks }
                });
              }
              skipped++;
              continue;
            }
            const newMB = toMB(size);
            let matchedIdx = -1;
            for (let j = 0; j < dbRec.downloads.length; j++) {
              const ex = dbRec.downloads[j];
              const qualOk = ex.quality === quality;
              const seasOk = (finalType === 'series' || finalType === 'anime') ? (ex.season == correctSeason && ex.episode == (item.episode ?? null)) : true;

              const exactSizeMatch = (newMB > 0 && toMB(ex.size) > 0 && Math.abs(newMB - toMB(ex.size)) < 2);
              const langOk = (ex.language || '') === (language || '');
              const sizeOk = ex.size === size || exactSizeMatch || (!ex.size && !size);

              if (qualOk && seasOk && (exactSizeMatch || (sizeOk && langOk))) {
                matchedIdx = j;
                // If we merged based on exact size but language was missing in existing, let's capture the language
                if (language && language !== 'Multi' && (!ex.language || ex.language === 'Multi')) {
                  ex.language = language; // update in memory
                }
                break;
              }
            }

            const metaSet = {};
            if (!dbRec.releaseDate && meta.releaseDate) metaSet.releaseDate = meta.releaseDate;
            if (meta.year && meta.releaseDate && (!dbRec.tmdbId || String(dbRec.tmdbId) === String(meta.tmdbId))) {
              metaSet.year = meta.year;
            }
            const seasonYear = meta.seasonYear || newDl.fileYear;
            if (correctSeason && seasonYear) metaSet['seasonYears.s' + correctSeason] = Number(seasonYear);
            if (!dbRec.backdrop       && meta.backdrop)       metaSet.backdrop       = meta.backdrop;
            if (!dbRec.poster         && meta.poster)         metaSet.poster         = meta.poster;
            if (!dbRec.posterFallback && meta.posterFallback) metaSet.posterFallback = meta.posterFallback;
            if (!dbRec.tmdbId         && meta.tmdbId)         metaSet.tmdbId         = meta.tmdbId;
            if (!dbRec.imdbId         && meta.imdbId)         metaSet.imdbId         = meta.imdbId;
            if (!dbRec.rating         && meta.rating)         metaSet.rating         = meta.rating;
            if (!dbRec.description    && meta.description)    metaSet.description    = meta.description;
            if (finalType === 'anime' && dbRec.type === 'series') metaSet.type = 'anime';

            if (matchedIdx >= 0) {
              const matchedDownload = dbRec.downloads[matchedIdx] || {};
              if (audioTracks.length >= 2 && (!Array.isArray(matchedDownload.audioTracks) || matchedDownload.audioTracks.length < 2)) {
                metaSet[`downloads.${matchedIdx}.audioTracks`] = audioTracks;
              }
              if (dbRec.downloads[matchedIdx].language) {
                metaSet[`downloads.${matchedIdx}.language`] = dbRec.downloads[matchedIdx].language;
              }
              const existLinks = dbRec.downloads[matchedIdx]?.links || [];
              if (existLinks.length >= 3 || existLinks.map(l => l.host).includes(host)) { skipped++; continue; }
              const op = { $addToSet: { [`downloads.${matchedIdx}.links`]: newDl.links[0] } };
              if (Object.keys(metaSet).length) op.$set = metaSet;
              const res = await Movie.findOneAndUpdate({ _id: dbRec._id, [`downloads.${matchedIdx}.links.url`]: { $ne: finalUrl } }, op, { new: true });
              if (res) {
                recomputeAggregates(res);
                const upd = await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } }, { new: true });
                existing = upd;
                updated++;
                emit(`[MERGED] ${res.title} | ${quality} -> ${host}`);
              } else skipped++;
            } else {
              const op = { $push: { downloads: newDl } };
              if (Object.keys(metaSet).length) op.$set = metaSet;
              const res = await Movie.findByIdAndUpdate(dbRec._id, op, { new: true });
              if (res) {
                recomputeAggregates(res);
                const upd2 = await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } }, { new: true });
                existing = upd2;
                updated++;
                emit(`[UPDATED] ${res.title} | ${quality} -> ${host}`);
              }
            }
          } else {
            const newDoc = await Movie.create({
              title: finalTitle, tmdbId: meta.tmdbId || '', imdbId: meta.imdbId || '',
              type: finalType, totalSeasons: meta.totalSeasons || 0,
              description: meta.description || '',
              poster: meta.poster || '', posterFallback: meta.posterFallback || '',
              backdrop: meta.backdrop || '',
              releaseDate: meta.releaseDate || '',
              seasonYears: Object.fromEntries(group.items.filter(file => file.season && file.fileYear)
                .map(file => ['s' + file.season, Number(file.fileYear)])),
              rating: meta.rating || 0, year: meta.year || rep.messageYear || (isSer ? null : rep.year) || null,
              genre: meta.genre || [], duration: meta.duration || '', quality, language: origLang2,
              formats: [quality].filter(Boolean), codecs: [codec].filter(c => c && c !== 'Other'),
              languages: (language || origLang2).split(',').map(l => l.trim()).filter(Boolean),
              downloads: [newDl],
            });
            added++;
            existing = newDoc;
            emit(`[NEW] ${finalTitle} (${meta.year || rep.year || '?'}) | ${quality}${audio ? ' · '+audio : ''}${hdr ? ' · '+hdr : ''} -> ${host} | POSTER: ${meta.poster ? '' : ''}`);
          }
        }
      } catch (e) {
        emit('Error (' + ((group.items[0] && group.items[0].title) || '?') + '): ' + e.message);
        skipped++;
      }
    }

    emit('Batch done: Added ' + added + ' | Updated ' + updated + ' | Skipped ' + skipped + ' | Progress ' + nextOffset + '/' + total);
    if (done) {
      emit('All batches complete! Imported with TMDB/OMDB posters and full metadata.');
      setPipelineRunningFlag(false);
    }

    return res.json({ done, added, updated, skipped, total, nextOffset, logs });
  } catch (e) {
    setPipelineRunningFlag(false);
    return res.status(500).json({ error: e.message });
  }
});
// ── Heal Only ────────────────────────────────────────────────────────────────
router.post('/heal', auth, async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  res.json({ message: 'Healer started' });

  pipelineRunning = true;
  broadcast('Starting Database Healer (heal-only mode)...');

  const runPipeline = await getRunPipeline();
  pipelinePromise = runPipeline({
    noBypass: true,
    noWipe: true,
    noHeal: false,
    // Only run steps 3-5 by providing existing source file
    importSrc: require('path').join(__dirname, '..', 'bypassed_links.json'),
    emitter: broadcast,
    isStopRequested: () => _stopRequested,
  })
    .then(() => broadcast('Healer finished.'))
    .catch(err => broadcast(`Healer error: ${err.message}`))
    .finally(() => { pipelineRunning = false; pipelinePromise = null; setPipelineRunningFlag(false); });
});

// ── Stop ─────────────────────────────────────────────────────────────────────
// Note: with in-process execution we can't SIGTERM a promise.
// This marks it as stopped so the UI unlocks. The async code will naturally
// finish its current unit of work (one import group) then the flag is checked.
let _stopRequested = false;
router.post('/stop', auth, (req, res) => {
  // On Vercel serverless, in-memory pipelineRunning may be false across instances.
  // Still attempt to mark stop so pipeline can check it if it's running.
  _stopRequested = true;
  pipelineRunning = false;
  setPipelineRunningFlag(false);
  abortUpload(); // Also abort any in-progress chunked JSON upload
  broadcast('Stop requested by admin.');
  res.json({ message: 'Stop requested' });
});

// ── Force-reset stuck pipeline flag ──────────────────────────────────────────
// Use this when the pipeline crashed mid-run and the dashboard is stuck on
// "Pipeline is already running". Safe to call at any time.
router.post('/reset-flag', auth, async (req, res) => {
  _stopRequested = false;
  pipelineRunning = false;
  await setPipelineRunningFlag(false);
  broadcast('[INFO] Pipeline flag force-reset by admin.');
  res.json({ message: 'Pipeline flag reset. You can now start a new pipeline run.' });
});

// ── Wipe DB ───────────────────────────────────────────────────────────────────
router.post('/wipe', auth, async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  abortUpload(); // Cancel any in-progress chunked JSON upload before wiping

  const mongoose = require('mongoose');
  const Movie    = require('../models/Movie');
  const fs       = require('fs');
  const os       = require('os');
  const pathLib  = require('path');

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  }

  try {
    // Wipe all collections in PARALLEL — much faster than sequential
    const Series      = (() => { try { return require('../models/Series'); }  catch(_) { return null; } })();
    const Episode     = (() => { try { return require('../models/Episode'); } catch(_) { return null; } })();
    const PipelineCache = require('../models/PipelineCache');

    const [result] = await Promise.all([
      Movie.deleteMany({}),
      Series  ? Series.deleteMany({})  : Promise.resolve(),
      Episode ? Episode.deleteMany({}) : Promise.resolve(),
      // Reset pipeline state keys (preserve extracted_links & telegram_export)
      PipelineCache.deleteMany({ key: { $in: ['_pipeline_running', '_pipeline_progress', 'bypassed_links'] } }),
      PipelineCache.updateOne(
        { key: 'pipeline_progress' },
        { $set: { data: { offset: 0, total: 0, label: '' } } }
      ),
    ]);


    // 4. Clear checkpoint + tmp files so next run starts clean
    const TMP = os.tmpdir();
    const tmpFiles = [
      'import_checkpoint.json',
      'links_for_bypasser.json',
      'shortlinks_report.json',
      'pipeline_running.json',
    ];
    for (const fname of tmpFiles) {
      const fp = pathLib.join(TMP, fname);
      try { if (fs.existsSync(fp)) fs.unlinkSync(fp); } catch(_) {}
    }

    // 5. Reset progress explicitly
    pipelineProgress = { offset: 0, total: 0, label: '' };
    await setPipelineRunningFlag(false, { offset: 0, total: 0, label: '' });

    const msg = `[DONE] Wiped ${result.deletedCount} movies + series — DB fully clean. Uploaded JSON preserved for Skip Scraper.`;
    broadcast(msg);
    return res.json({ message: 'Wipe finished', deletedCount: result.deletedCount });
  } catch (e) {
    broadcast(`[ERROR] Wipe error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// ── Clear Logs ────────────────────────────────────────────────────────────────
router.post('/clear-logs', auth, async (req, res) => {
  logBuffer = [];
  // Also clear from MongoDB
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1)
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    await PipelineCache.findOneAndUpdate(
      { key: '_pipeline_logs' },
      { $set: { data: [], updatedAt: new Date() } },
      { upsert: true }
    );
  } catch (_) {}
  broadcast('[INFO] Log buffer cleared.');
  res.json({ message: 'Logs cleared' });
});

// ── GET /logs — return persisted log history (for phone/new-tab reconnect) ────
router.get('/logs', auth, async (req, res) => {
  try {
    // First try in-memory buffer (same Vercel instance)
    if (logBuffer.length > 0) {
      return res.json({ logs: logBuffer.slice(-200) });
    }
    // Fallback: read from MongoDB (different Vercel instance / phone)
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1)
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    const doc = await PipelineCache.findOne({ key: '_pipeline_logs' }).lean();
    res.json({ logs: (doc && doc.data) ? doc.data : [] });
  } catch (e) {
    res.json({ logs: [] });
  }
});


module.exports = router;
router.get('/start-local', async (req, res) => {
  if (pipelineRunning) return res.status(400).json({ error: 'Pipeline is already running' });

  const skipScraper = req.query.skipScraper === 'true';
  const label = skipScraper ? 'Skip Scraper (Local Mode)' : 'Full Pipeline (Local Mode)';

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  pipelineRunning = true;
  setPipelineRunningFlag(true);

  const emit = (msg) => {
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    try { res.write(`data: ${JSON.stringify({ text: clean })}\n\n`); } catch (e) { }
  };

  emit(`[START] ${label}...`);

  const { spawn } = require('child_process');
  const readline = require('readline');
  const path = require('path');

  const args = ['orchestrator.js'];
  if (skipScraper) args.push('--skip-scraper');

  const activeProcess = spawn('node', args, { cwd: path.join(__dirname, '..') });

  readline.createInterface({ input: activeProcess.stdout }).on('line', line => {
    if (line.trim()) emit(line);
  });
  readline.createInterface({ input: activeProcess.stderr }).on('line', line => {
    if (line.trim()) emit(`ERROR: ${line}`);
  });

  activeProcess.on('close', code => {
    emit(`[DONE] Pipeline finished with exit code ${code}`);
    pipelineRunning = false;
    setPipelineRunningFlag(false);
    res.end();
  });

  req.on('close', () => {
    if (pipelineRunning && activeProcess) {
      // if user closes browser, we let the process keep running locally
    }
  });
});
