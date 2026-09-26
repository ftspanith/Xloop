const fs = require('fs');

// 1. Fix backend route to stream instead of returning early
let routeFile = fs.readFileSync('routes/orchestrator.js', 'utf8');

// Replace the /start logic to stream SSE directly
const startRegex = /router\.post\('\/start', auth, async \(req, res\) => \{[\s\S]*?\/\/\s*── Heal Only ──/g;

const newStartRoute = `router.get('/start', async (req, res) => {
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
    const clean = msg.replace(/\\x1b\\[[0-9;]*m/g, '');
    try { res.write(\`data: \${JSON.stringify({ text: clean })}\\n\\n\`); } catch(e) {}
  };

  emit(\`Starting \${label}...\`);

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
        emit(\`📂 Skip Scraper: loaded \${clean.length} links from MongoDB (\${new Date(cache.savedAt).toLocaleDateString()})\`);
      } else {
        emit(\`❌ Skip Scraper: no cached data found. Upload telegram_export.json first.\`);
        pipelineRunning = false;
        res.end();
        return;
      }
    } catch (err) {
      emit(\`❌ Skip Scraper cache load failed: \${err.message}\`);
      pipelineRunning = false;
      res.end();
      return;
    }
  } else {
    emit(\`🔄 Full Pipeline: will re-extract fresh from telegram_export.json\`);
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
    emit(\`Pipeline error: \${err.message}\`);
  } finally {
    pipelineRunning = false;
    setPipelineRunningFlag(false);
    res.end();
  }
});

// ── Heal Only ──`;

routeFile = routeFile.replace(startRegex, newStartRoute);
fs.writeFileSync('routes/orchestrator.js', routeFile);

console.log('Backend fixed');
