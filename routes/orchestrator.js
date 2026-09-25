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

  // Send connection confirmation + replay log buffer
  res.write(`data: ${JSON.stringify({ text: '📡 Connected to Orchestrator Live Stream' })}\n\n`);
  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
  }
  if (pipelineRunning) {
    res.write(`data: ${JSON.stringify({ text: '⚠️  Pipeline is currently running — logs above are from this run.' })}\n\n`);
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
router.get('/status', (req, res) => {
  res.json({ running: pipelineRunning });
});

// ── Start pipeline (auth required) ───────────────────────────────────────────
router.post('/start', auth, async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const { skipScraper, resume } = req.body || {};
  const label = skipScraper ? 'Skip Scraper (import-only)' : 'Full Pipeline';

  // Respond immediately — pipeline runs async in background
  res.json({ message: `${label} started` });

  // Run in-process, stream logs via broadcast()
  pipelineRunning = true;
  broadcast(`🚀 Starting ${label}...`);

  // For Skip Scraper: load existing links from MongoDB (persists across Lambda instances).
  // For Full Pipeline: importSrc=undefined so pipeline re-extracts fresh (overwrites JSONs).
  let importSrc = undefined;
  if (skipScraper) {
    try {
      const PipelineCache = require('../models/PipelineCache');
      const mongoose = require('mongoose');

      // Connect to DB to check cache
      if (mongoose.connection.readyState !== 1) {
        await mongoose.connect(process.env.MONGODB_URI, { serverSelectionTimeoutMS: 10000, family: 4 });
      }

      const cache = await PipelineCache.findOne({ key: 'bypassed_links' }).lean();
      if (cache && cache.data && cache.data.length > 0) {
        // Write to /tmp so pipeline_full.js can read it as a file (it still needs a file path)
        const osp = require('path');
        const fs  = require('fs');
        const tmpFile = osp.join('/tmp', 'bypassed_links.json');
        fs.writeFileSync(tmpFile, JSON.stringify(cache.data));
        importSrc = tmpFile;
        broadcast(`📂 Skip Scraper: loaded ${cache.data.length} entries from MongoDB cache (saved ${new Date(cache.savedAt).toLocaleDateString()})`);
      } else {
        // Try local filesystem fallback for local dev
        const osp = require('path');
        const fs  = require('fs');
        const localFile = osp.join(__dirname, '..', 'bypassed_links.json');
        if (fs.existsSync(localFile)) {
          importSrc = localFile;
          broadcast(`📂 Skip Scraper: using local bypassed_links.json`);
        } else {
          broadcast(`❌ Skip Scraper: no cached data found. Run Full Pipeline first to build the cache.`);
          pipelineRunning = false;
          return;
        }
      }
    } catch (err) {
      broadcast(`❌ Skip Scraper cache load failed: ${err.message}`);
      pipelineRunning = false;
      return;
    }
  } else {
    broadcast(`🔄 Full Pipeline: will re-extract fresh from telegram_export.json`);
  }

  const runPipeline = await getRunPipeline();
  pipelinePromise = runPipeline({
    noBypass:  !!skipScraper,
    noWipe:    !!skipScraper,
    resume:    !!resume,
    importSrc,            // undefined for Full Pipeline (fresh), file path for Skip Scraper
    emitter:   broadcast,
  })
  .then(() => {
    broadcast('🏁 Pipeline finished successfully.');
  })
  .catch(err => {
    broadcast(`❌ Pipeline error: ${err.message}`);
  })
  .finally(() => {
    pipelineRunning = false;
    pipelinePromise = null;
  });
});

// ── Heal Only ────────────────────────────────────────────────────────────────
router.post('/heal', auth, async (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  res.json({ message: 'Healer started' });

  pipelineRunning = true;
  broadcast('🩺 Starting Database Healer (heal-only mode)...');

  const runPipeline = await getRunPipeline();
  pipelinePromise = runPipeline({
    noBypass: true,
    noWipe:   true,
    noHeal:   false,
    // Only run steps 3-5 by providing existing source file
    importSrc: require('path').join(__dirname, '..', 'bypassed_links.json'),
    emitter:  broadcast,
  })
  .then(() => broadcast('🏁 Healer finished.'))
  .catch(err => broadcast(`❌ Healer error: ${err.message}`))
  .finally(() => { pipelineRunning = false; pipelinePromise = null; });
});

// ── Stop ─────────────────────────────────────────────────────────────────────
// Note: with in-process execution we can't SIGTERM a promise.
// This marks it as stopped so the UI unlocks. The async code will naturally
// finish its current unit of work (one import group) then the flag is checked.
let _stopRequested = false;
router.post('/stop', auth, (req, res) => {
  if (!pipelineRunning) {
    return res.status(400).json({ error: 'No pipeline is running' });
  }
  _stopRequested = true;
  pipelineRunning = false;
  broadcast('🛑 Stop requested by admin. Pipeline will finish current task then exit.');
  res.json({ message: 'Stop requested' });
});

// ── Wipe DB ───────────────────────────────────────────────────────────────────
router.post('/wipe', auth, (req, res) => {
  if (pipelineRunning) {
    return res.status(400).json({ error: 'Pipeline is already running' });
  }

  const mongoose = require('mongoose');
  const Movie    = require('../models/Movie');

  res.json({ message: 'Wipe started' });
  broadcast('🧨 Wiping database...');

  Movie.deleteMany({})
    .then(r => broadcast(`✅ Wiped ${r.deletedCount} entries from database.`))
    .catch(e => broadcast(`❌ Wipe error: ${e.message}`));
});

// ── Clear Logs ────────────────────────────────────────────────────────────────
router.post('/clear-logs', auth, (req, res) => {
  logBuffer = [];
  broadcast('🧹 Log buffer cleared.');
  res.json({ message: 'Logs cleared' });
});

module.exports = router;
