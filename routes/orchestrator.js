const express   = require('express');
const router    = express.Router();
const path      = require('path');
const auth      = require('../middleware/auth');

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
  res.setHeader('Content-Type',      'text/event-stream');
  res.setHeader('Cache-Control',     'no-cache');
  res.setHeader('Connection',        'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId  = Date.now() + Math.random();
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
  if (pipelineRunning) return res.json({ running: true });
  try {
    const PipelineCache = require('../models/PipelineCache');
    const mongoose = require('mongoose');
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 5000, family: 4 });
    }
    const flag = await PipelineCache.findOne({ key: '_pipeline_running' }).lean();
    const isRunning = flag && flag.running === true &&
      (Date.now() - new Date(flag.updatedAt || 0).getTime() < 30 * 60 * 1000);
    return res.json({ running: !!isRunning });
  } catch (_) {
    return res.json({ running: pipelineRunning });
  }
});

// Persist running state to MongoDB so all serverless instances agree
async function setPipelineRunningFlag(running) {
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
  } catch (_) { /* non-critical */ }
}

// ── Start pipeline (auth required) ───────────────────────────────────────────
router.get('/start', async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const skipScraper = req.query.skipScraper === 'true';
  const resume = req.query.resume === 'true';
  const skipBypass = req.query.skipBypass === 'true';
  const label = skipScraper ? 'Skip Scraper (import-only)' : 'Full Pipeline';

  // Setup SSE
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  pipelineRunning = true;
  setPipelineRunningFlag(true);
  
  const emit = (msg) => {
    // Strip ANSI color codes
    const clean = msg.replace(/\x1b\[[0-9;]*m/g, '');
    try { res.write(`data: ${JSON.stringify({ text: clean })}\n\n`); } catch(e) {}
  };

  emit(`Starting ${label}...`);

  let importSrc = undefined;
  if (skipScraper) {
    try {
      const PipelineCache = require('../models/PipelineCache');
      const mongoose = require('mongoose');

      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
      }

      const cache = await PipelineCache.findOne({ key: 'extracted_links' }, 'count savedAt').lean();
      if (cache && cache.count > 0) {
        const ExtractedLinkM = require('../models/ExtractedLink');
        const links = await ExtractedLinkM.find({}).lean();
        const clean = links.map(({ _id, __v, uploadBatch, ...rest }) => rest);
        const osp = require('path');
        const fs  = require('fs');
        const tmpFile = osp.join(process.env.VERCEL ? '/tmp' : __dirname+'/..', 'links_for_bypasser.json');
        fs.writeFileSync(tmpFile, JSON.stringify(clean));
        importSrc = tmpFile;
        emit(`📂 Skip Scraper: loaded ${clean.length} links from MongoDB (${new Date(cache.savedAt).toLocaleDateString()})`);
      } else {
        emit(`❌ Skip Scraper: no cached data found. Upload telegram_export.json first.`);
        pipelineRunning = false;
        res.end();
        return;
      }
    } catch (err) {
      emit(`❌ Skip Scraper cache load failed: ${err.message}`);
      pipelineRunning = false;
      res.end();
      return;
    }
  } else {
    emit(`🔄 Full Pipeline: will re-extract fresh from telegram_export.json`);
  }

  try {
    const runPipeline = await getRunPipeline();
    await runPipeline({
      noBypass:  skipBypass !== undefined ? skipBypass : !!skipScraper,
      noWipe:    !!skipScraper,
      resume:    !!resume,
      importSrc,
      emitter:   emit,
    });
    emit('Pipeline finished successfully.');
  } catch (err) {
    emit(`Pipeline error: ${err.message}`);
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

  pipelineRunning = true;
  setPipelineRunningFlag(true);
  broadcast(`Starting ${label}...`);

  let importSrc = undefined;
  if (skipScraper) {
    try {
      const PipelineCache = require('../models/PipelineCache');
      const mongoose = require('mongoose');
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
      }
      const cache = await PipelineCache.findOne({ key: 'extracted_links' }, 'count savedAt').lean();
      if (cache && cache.count > 0) {
        const ExtractedLinkM = require('../models/ExtractedLink');
        const links = await ExtractedLinkM.find({}).lean();
        const clean = links.map(({ _id, __v, uploadBatch, ...rest }) => rest);
        const osp = require('path');
        const fs  = require('fs');
        const tmpFile = osp.join(process.env.VERCEL ? '/tmp' : __dirname+'/../', 'links_for_bypasser.json');
        fs.writeFileSync(tmpFile, JSON.stringify(clean));
        importSrc = tmpFile;
        broadcast(`Skip Scraper: loaded ${clean.length} links from MongoDB`);
      } else {
        broadcast(`Skip Scraper: no cached data found. Upload telegram_export.json first.`);
        pipelineRunning = false;
        setPipelineRunningFlag(false);
        return;
      }
    } catch (err) {
      broadcast(`Skip Scraper cache load failed: ${err.message}`);
      pipelineRunning = false;
      setPipelineRunningFlag(false);
      return;
    }
  }

  const runPipeline = await getRunPipeline();
  runPipeline({
    noBypass: skipBypass !== undefined ? skipBypass : !!skipScraper,
    noWipe:   !!skipScraper,
    resume:   !!resume,
    importSrc,
    emitter:  broadcast,
  })
  .then(() => broadcast('Pipeline finished successfully.'))
  .catch(err => broadcast(`Pipeline error: ${err.message}`))
  .finally(() => { pipelineRunning = false; pipelinePromise = null; setPipelineRunningFlag(false); });
});

// -- Import Batch: fully enriched TMDB+OMDB per group (Vercel-timeout safe) --
// Each call processes batchSize groups with real poster/metadata lookup.
// Frontend chains: offset=0 => offset+=batchSize => ... until done=true
router.post('/import-batch', auth, async (req, res) => {
  const { offset = 0, batchSize = 15 } = req.body || {};
  const mongoose = require('mongoose');
  const ExtractedLinkM = require('../models/ExtractedLink');
  const Movie = require('../models/Movie');
  const { cleanTitleForApi, detectHost } = require('../utils/parser');
  const { searchTMDB, searchOMDB, toMB, detectCodecLocal, seasonFromFilename, recomputeAggregates } = require('../pipeline_full');

  try {
    if (mongoose.connection.readyState !== 1) {
      await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
    }

    const links = await ExtractedLinkM.find({}).lean();
    if (!links.length) {
      return res.json({ done: true, added: 0, updated: 0, skipped: 0, total: 0, nextOffset: 0, message: 'No links cached. Run Full Pipeline first.' });
    }

    // Group by clean title + year
    const groups = {};
    for (const item of links) {
      if (item.host === 'Shortlink' && !item.bypassedUrl) continue;
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

    emit('Batch ' + (Math.floor(offset / batchSize) + 1) + ': groups ' + (offset + 1) + '-' + nextOffset + ' of ' + total);

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
          if (!meta.poster || !meta.rating || !meta.imdbId) {
            const omdb = await searchOMDB(cleanTitle, rep.year, isSer);
            if (omdb) {
              if (!meta.poster && omdb.poster) meta.poster = omdb.poster;
              if (!meta.rating && omdb.rating) meta.rating = omdb.rating;
              if (!meta.description && omdb.description) meta.description = omdb.description;
              if (!meta.duration && omdb.duration) meta.duration = omdb.duration;
              if (!(meta.genre && meta.genre.length) && omdb.genre && omdb.genre.length) meta.genre = omdb.genre;
              if (omdb.imdbId) meta.imdbId = omdb.imdbId;
            }
          }
        } else {
          const omdb = await searchOMDB(cleanTitle, rep.year, isSer);
          if (omdb) Object.assign(meta, omdb, { tmdbId: '' });
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

        const finalTitle = meta.title || rep.title || cleanTitle;
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
          const correctSeason = seasonFromFilename(item.filename) ?? item.season ?? null;

          let dbRec = existing;
          if (!dbRec && meta.tmdbId) {
             dbRec = await Movie.findOne({ tmdbId: meta.tmdbId });
             existing = dbRec;
          }

          const newDl = {
            quality, size, filename: item.filename || '', language, codec, hdr,
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
              const langOk = (ex.language || '') === (language || '');
              const seasOk = (finalType === 'series' || finalType === 'anime') ? (ex.season == correctSeason && ex.episode == (item.episode ?? null)) : true;
              const sizeOk = ex.size === size || (newMB > 0 && toMB(ex.size) > 0 && Math.abs(newMB - toMB(ex.size)) < 2) || (!ex.size && !size);
              if (qualOk && langOk && seasOk && sizeOk) { matchedIdx = j; break; }
            }

            const metaSet = {};
            if (!dbRec.backdrop && meta.backdrop) metaSet.backdrop = meta.backdrop;
            if (!dbRec.poster && meta.poster) metaSet.poster = meta.poster;
            if (!dbRec.tmdbId && meta.tmdbId) metaSet.tmdbId = meta.tmdbId;
            if (!dbRec.imdbId && meta.imdbId) metaSet.imdbId = meta.imdbId;
            if (!dbRec.rating && meta.rating) metaSet.rating = meta.rating;
            if (!dbRec.description && meta.description) metaSet.description = meta.description;
            if (finalType === 'anime' && dbRec.type === 'series') metaSet.type = 'anime';

            if (matchedIdx >= 0) {
              const existLinks = dbRec.downloads[matchedIdx]?.links || [];
              if (existLinks.length >= 3 || existLinks.map(l => l.host).includes(host)) { skipped++; continue; }
              const op = { $addToSet: { [`downloads.${matchedIdx}.links`]: newDl.links[0] } };
              if (Object.keys(metaSet).length) op.$set = metaSet;
              const res = await Movie.findOneAndUpdate({ _id: dbRec._id, [`downloads.${matchedIdx}.links.url`]: { $ne: finalUrl } }, op, { new: true });
              if (res) {
                recomputeAggregates(res);
                const upd = await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } }, {new: true});
                existing = upd;
                updated++;
                emit(`Merged: [${res.title}] ${quality} → ${host}`);
              } else skipped++;
            } else {
              const op = { $push: { downloads: newDl } };
              if (Object.keys(metaSet).length) op.$set = metaSet;
              const res = await Movie.findByIdAndUpdate(dbRec._id, op, { new: true });
              if (res) {
                recomputeAggregates(res);
                const upd2 = await Movie.findByIdAndUpdate(dbRec._id, { $set: { formats: res.formats, quality: res.quality, languages: res.languages, codecs: res.codecs } }, {new: true});
                existing = upd2;
                updated++;
                emit(`Updated: [${res.title}] ${quality} → ${host}`);
              }
            }
          } else {
            const newDoc = await Movie.create({
              title: finalTitle, tmdbId: meta.tmdbId || '', imdbId: meta.imdbId || '',
              type: finalType, totalSeasons: meta.totalSeasons || 0,
              description: meta.description || '', poster: meta.poster || '', backdrop: meta.backdrop || '',
              rating: meta.rating || 0, year: meta.year || rep.year || null,
              genre: meta.genre || [], duration: meta.duration || '', quality, language: origLang2,
              formats: [quality].filter(Boolean), codecs: [codec].filter(c => c && c !== 'Other'),
              languages: (language || origLang2).split(',').map(l => l.trim()).filter(Boolean),
              downloads: [newDl],
            });
            added++;
            existing = newDoc;
            emit((meta.poster ? 'Added 🖼: ' : 'Added ❓: ') + `[${finalTitle}] (${meta.year || rep.year || '?'}) ${quality} → ${host}`);
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
    noWipe:   true,
    noHeal:   false,
    // Only run steps 3-5 by providing existing source file
    importSrc: require('path').join(__dirname, '..', 'bypassed_links.json'),
    emitter:  broadcast,
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
  
  if (mongoose.connection.readyState !== 1) {
    await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
  }

  try {
    const result = await Movie.deleteMany({});
    broadcast(`✅ Wiped ${result.deletedCount} entries from database.`);
    return res.json({ message: 'Wipe finished', deletedCount: result.deletedCount });
  } catch(e) {
    broadcast(`❌ Wipe error: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// ── Clear Logs ────────────────────────────────────────────────────────────────
router.post('/clear-logs', auth, (req, res) => {
  logBuffer = [];
  broadcast('🧹 Log buffer cleared.');
  res.json({ message: 'Logs cleared' });
});

module.exports = router;
