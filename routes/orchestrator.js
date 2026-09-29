const express = require('express');
const router = express.Router();
const path = require('path');
const auth = require('../middleware/auth');

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

// ── Broadcast a log line to all SSE clients ───────────────────────────────────
function broadcast(message) {
  // Strip ANSI color codes (they look bad in the terminal UI)
  const clean = message.replace(/\x1b\[[0-9;]*m/g, '');
  logBuffer.push(clean);
  if (logBuffer.length > MAX_LOG_HISTORY) logBuffer.shift();

  const payload = `data: ${JSON.stringify({ text: clean })}\n\n`;
  clients = clients.filter(c => {
    try { c.res.write(payload); return true; }
    catch (_) { return false; }
  });
}

// ── SSE stream endpoint ───────────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId = Date.now() + Math.random();
  clients.push({ id: clientId, res });

  // Send connection confirmation only — do NOT replay log buffer
  // (replaying stale error lines caused confusion on page load)
  res.write(`data: ${JSON.stringify({ text: 'Connected to Orchestrator Live Stream' })}\n\n`);
  if (pipelineRunning) {
    res.write(`data: ${JSON.stringify({ text: 'Pipeline is currently running.' })}\n\n`);
  }

  const heartbeat = setInterval(() => {
    try { res.write(': heartbeat\n\n'); }
    catch (_) { clearInterval(heartbeat); }
  }, 15000);

  req.on('close', () => {
    clearInterval(heartbeat);
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
      (Date.now() - new Date(flag.updatedAt || 0).getTime() < 30 * 60 * 1000);
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

// ── Start pipeline (auth required) ───────────────────────────────────────────
router.get('/start', async (req, res) => {
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
    // so any device polling /status can see real-time % without SSE
    const progMatch = clean.match(/\[PROGRESS\]\s+(\d+)\s*\/\s*(\d+)/);
    if (progMatch) {
      pipelineProgress.offset = parseInt(progMatch[1]);
      pipelineProgress.total  = parseInt(progMatch[2]);
      // Persist to DB (fire-and-forget — don't block the emit)
      setPipelineRunningFlag(true, {
        offset: pipelineProgress.offset,
        total:  pipelineProgress.total,
        label,
      }).catch(() => {});
    }
    try { res.write(`data: ${JSON.stringify({ text: clean })}\n\n`); } catch (e) { }
  };

  emit(`[START] ${label}...`);
  if (skipScraper) {
    emit(`[INFO] Skip Scraper: re-extracting from telegram_export.json (skipping Telegram API scrape)`);
  } else {
    emit(`[INFO] Full Pipeline: scraping Telegram → extracting → importing`);
  }
  if (scope === 'daily') emit(`[INFO] Scope: Today's new content only (filtering by today's date)`);
  if (scope === 'title' && titleFilter) emit(`[INFO] Scope: Searching for title matching "${titleFilter}"`);

  let importSrc = undefined;

  try {
    const runPipeline = await getRunPipeline();
    await runPipeline({
      noBypass: skipBypass !== undefined ? skipBypass : !!skipScraper,
      noWipe: !!skipScraper,
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
    res.end();
  }
});

// ── Start pipeline (POST — backward compat for dashboard.html) ────────────────
// dashboard.html uses POST; orchestrator.html uses GET EventSource.
// This POST version just kicks off via the shared broadcast channel.
router.post('/start', auth, async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const { skipScraper, resume, skipBypass } = req.body || {};
  const label = skipScraper ? 'Skip Scraper (import-only)' : 'Full Pipeline';

  res.json({ message: `${label} started` });

  _stopRequested = false;
  pipelineRunning = true;
  pipelineProgress = { offset: 0, total: 0, label };
  setPipelineRunningFlag(true);
  broadcast(`[START] ${label}...`);

  let importSrc = undefined;
  if (skipScraper) broadcast(`[INFO] Skip Scraper: re-extracting from telegram_export.json`);

  try {
    const runPipeline = await getRunPipeline();
    await runPipeline({
      noBypass: skipBypass,
      noWipe: !!skipScraper,
      resume: !!resume,
      importSrc,
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

// -- Import Batch: fully enriched TMDB+OMDB per group (Vercel-timeout safe) --
// Each call processes batchSize groups with real poster/metadata lookup.
// Frontend chains: offset=0 => offset+=batchSize => ... until done=true
router.post('/import-batch', auth, async (req, res) => {
  const { offset = 0, batchSize = 1 } = req.body || {};
  const mongoose = require('mongoose');
  const ExtractedLinkM = require('../models/ExtractedLink');
  const Movie = require('../models/Movie');
  const { cleanTitleForApi, detectHost } = require('../utils/parser');
  const { searchTMDB, searchOMDB, toMB, detectCodecLocal, seasonFromFilename, recomputeAggregates, searchGoogleImage } = require('../pipeline_full');

  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
    }

    const links = await ExtractedLinkM.find({}).lean();
    if (!links.length) {
      return res.json({ done: true, added: 0, updated: 0, skipped: 0, total: 0, nextOffset: 0, message: 'No links cached. Run Full Pipeline first.' });
    }

    // Group by clean title + year — fix: also allow direct-URL-tagged-as-Shortlink
    const DIRECT_URL_RE = /gdflix|hubcloud|gdlink|drivehub|filepress|dtflix|dotflix|tmbcloud|pixeldrain|gofile|streamtape|buzzheavier|1fichier/i;
    const groups = {};
    for (const item of links) {
      // Skip genuine unresolved shortlinks but keep:
      // 1. Items that have a bypassed URL
      // 2. Items whose raw URL is actually a direct link (mis-tagged as Shortlink)
      if (item.host === 'Shortlink' && !item.bypassedUrl && !DIRECT_URL_RE.test(item.url)) continue;
      const cTitle = cleanTitleForApi(item.title || '', item.year);
      if (!cTitle) continue;
      const key = cTitle.toLowerCase() + '__' + (item.year || '');
      if (!groups[key]) groups[key] = { items: [], msgDate: item.date || null };
      groups[key].items.push(item);
    }
    const groupEntries = Object.entries(groups);
    const total = groupEntries.length;
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

    emit('[PROGRESS] ' + nextOffset + ' / ' + total + ' (' + Math.round(nextOffset / total * 100) + '%)');
    emit('Batch ' + (Math.floor(offset / batchSize) + 1) + ': groups ' + (offset + 1) + '-' + nextOffset + ' of ' + total);
    // Persist progress so /status and UI can show resume point
    pipelineProgress = { offset: nextOffset, total, label: 'Skip Scraper (import-only)' };
    setPipelineRunningFlag(pipelineRunning, { offset: nextOffset, total, label: 'Skip Scraper (import-only)' });

    for (const [, group] of thisBatch) {
      try {
        const rep = group.items[0];
        const isSer = !!(rep.isSeries || rep.contentType === 'series' || rep.contentType === 'anime');
        const cleanTitle = cleanTitleForApi(rep.title || '', rep.year);
        if (!cleanTitle || cleanTitle.length < 2) { skipped++; continue; }

        // Check duplicate
        const escapedTitle = cleanTitle.replace(/[-[\]{}()*+?.,\\^$|#\s]/g, '\\$&');
        let existing = rep.year
          ? await Movie.findOne({ title: { $regex: '^' + escapedTitle + '$', $options: 'i' }, year: Number(rep.year) })
          : await Movie.findOne({ title: { $regex: '^' + escapedTitle + '$', $options: 'i' } });

        // Full TMDB + OMDB enrichment
        let meta = {};
        const tmdbSeason = rep.season || null;
        const tmdb = await searchTMDB(cleanTitle, rep.year, isSer, tmdbSeason, group.msgDate, rep.imdbId || null, rep.tmdbIdHint || null);
        if (tmdb) {
          Object.assign(meta, tmdb);
          // Always fetch OMDB for rating, imdbId, and fallback poster
          const omdb = await searchOMDB(cleanTitle, rep.year, isSer);
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
          const omdb = await searchOMDB(cleanTitle, rep.year, isSer);
          if (omdb) Object.assign(meta, omdb, { tmdbId: '' });
        }
        // Google Image fallback when poster still empty
        if (!meta.poster) {
          const gImg = await searchGoogleImage(rep.title, rep.year, isSer);
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
          const correctSeason = seasonFromFilename(item.filename) ?? item.season ?? null;

          let dbRec = existing;
          if (!dbRec && meta.tmdbId) {
            dbRec = await Movie.findOne({ tmdbId: meta.tmdbId });
            existing = dbRec;
          }

          const newDl = {
            quality, size, filename: item.filename || '', language, codec, hdr, audio,
            season: correctSeason, episode: item.episode ?? null,
            links: [{ host, url: finalUrl, isFast: /gdflix|hubcloud|gdlink/i.test(finalUrl) }],
          };

          if (dbRec) {
            if (dbRec.downloads?.some(d => d.links?.some(l => l.url === finalUrl))) { skipped++; continue; }
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
            if (!dbRec.backdrop       && meta.backdrop)       metaSet.backdrop       = meta.backdrop;
            if (!dbRec.poster         && meta.poster)         metaSet.poster         = meta.poster;
            if (!dbRec.posterFallback && meta.posterFallback) metaSet.posterFallback = meta.posterFallback;
            if (!dbRec.tmdbId         && meta.tmdbId)         metaSet.tmdbId         = meta.tmdbId;
            if (!dbRec.imdbId         && meta.imdbId)         metaSet.imdbId         = meta.imdbId;
            if (!dbRec.rating         && meta.rating)         metaSet.rating         = meta.rating;
            if (!dbRec.description    && meta.description)    metaSet.description    = meta.description;
            if (finalType === 'anime' && dbRec.type === 'series') metaSet.type = 'anime';

            if (matchedIdx >= 0) {
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
              rating: meta.rating || 0, year: meta.year || rep.year || null,
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
  broadcast('Stop requested by admin.');
  res.json({ message: 'Stop requested' });
});

// ── Wipe DB ───────────────────────────────────────────────────────────────────
router.post('/wipe', auth, async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const mongoose = require('mongoose');
  const Movie    = require('../models/Movie');
  const fs       = require('fs');
  const os       = require('os');
  const pathLib  = require('path');

  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  }

  try {
    // 1. Wipe Movie collection
    const result = await Movie.deleteMany({});

    // 2. Wipe Series, Episode collections (NOT ExtractedLink — Skip Scraper still needs those!)
    try {
      const Series = require('../models/Series');
      await Series.deleteMany({});
    } catch (_) {}
    try {
      const Episode = require('../models/Episode');
      await Episode.deleteMany({});
    } catch (_) {}

    // 3. Wipe pipeline state from PipelineCache (preserve extracted_links & telegram_export — Skip Scraper needs them!)
    try {
      const PipelineCache = require('../models/PipelineCache');
      await PipelineCache.deleteMany({ key: { $in: ['_pipeline_running', '_pipeline_progress', 'bypassed_links'] } });
      // Reset progress fields but keep extracted_links and telegram_export
      await PipelineCache.updateOne(
        { key: 'pipeline_progress' },
        { $set: { data: { offset: 0, total: 0, label: '' } } }
      );
    } catch (_) {}

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
router.post('/clear-logs', auth, (req, res) => {
  logBuffer = [];
  broadcast('[INFO] Log buffer cleared.');
  res.json({ message: 'Logs cleared' });
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
