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
  if (!pipelineRunning) {
    return res.status(400).json({ error: 'No pipeline is running' });
  }
  _stopRequested = true;
  pipelineRunning = false;
  setPipelineRunningFlag(false);
  broadcast('Stop requested by admin. Pipeline will finish current task then exit.');
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
