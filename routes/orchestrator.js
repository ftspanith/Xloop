const express   = require('express');
const router    = express.Router();
const { spawn } = require('child_process');
const readline  = require('readline');
const path      = require('path');
const auth      = require('../middleware/auth');

// Force Vercel's Node File Trace (NFT) to bundle these scripts
// because they are spawned dynamically via child_process
try {
  require.resolve('../orchestrator.js');
  require.resolve('../extract_links.js');
  require.resolve('../scrape_api.js');
  require.resolve('../heal_db.js');
  require.resolve('../wipe_db.js');
  require.resolve('../pipeline.js');
  require.resolve('../pipeline_full.js');
} catch (e) {}

let clients       = [];   // active SSE connections
let activeProcess = null; // currently running child process
let logBuffer     = [];   // in-memory log history buffer (last 500 lines)
const MAX_LOG_HISTORY = 500;

// ── Broadcast to all SSE clients ─────────────────────────────────────────────
function broadcast(message) {
  logBuffer.push(message);
  if (logBuffer.length > MAX_LOG_HISTORY) logBuffer.shift();

  const payload = `data: ${JSON.stringify({ text: message })}\n\n`;
  clients = clients.filter(c => {
    try { c.res.write(payload); return true; }
    catch (_) { return false; }
  });
}

function isProcessAlive(proc) {
  if (!proc) return false;
  if (proc.killed || proc.exitCode !== null) return false;
  try {
    process.kill(proc.pid, 0);
    return true;
  } catch (e) {
    return false;
  }
}

function runScript(scriptCmd, scriptArgs, startMessage, finishMessage) {
  broadcast(startMessage);
  activeProcess = spawn(scriptCmd, scriptArgs, { cwd: path.join(__dirname, '..') });

  readline.createInterface({ input: activeProcess.stdout }).on('line', line => {
    if (line.trim()) broadcast(line);
  });
  readline.createInterface({ input: activeProcess.stderr }).on('line', line => {
    if (line.trim()) broadcast(`ERROR: ${line}`);
  });

  activeProcess.on('close', code => {
    broadcast(`\n🏁 ${finishMessage} exit code ${code}`);
    activeProcess = null;
  });
}

// ── SSE stream ────────────────────────────────────────────────────────────────
router.get('/stream', (req, res) => {
  res.setHeader('Content-Type',  'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection',    'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders();

  const clientId  = Date.now() + Math.random();
  const newClient = { id: clientId, res };
  clients.push(newClient);

  // Immediately replay past log buffer to new connection (so dashboard refresh keeps logs)
  res.write(`data: ${JSON.stringify({ text: '📡 Connected to Orchestrator Live Stream' })}\n\n`);
  for (const line of logBuffer) {
    res.write(`data: ${JSON.stringify({ text: line })}\n\n`);
  }
  if (activeProcess) {
    res.write(`data: ${JSON.stringify({ text: '⚠️ A pipeline process is currently running in background.' })}\n\n`);
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
  res.json({ running: !!activeProcess });
});

// ── Start (auth required) ────────────────────────────────────────────────────
router.post('/start', auth, (req, res) => {
  if (activeProcess && !isProcessAlive(activeProcess)) {
    activeProcess = null;
  }
  if (activeProcess) {
    return res.status(400).json({ error: 'Process is already running' });
  }

  const { skipScraper, resume } = req.body || {};

  // Always use pipeline_full.js — it handles extract + bypass + import + heal
  // skipScraper=true  → --no-bypass --no-wipe  (use existing links, skip shortlinks)
  // skipScraper=false → full pipeline (extract fresh, bypass shortlinks, import, heal)
  // resume=true       → --resume  (continue from checkpoint after a crash)
  const scriptPath = path.join(__dirname, '..', 'pipeline_full.js');
  const args = [scriptPath];
  if (skipScraper) {
    args.push('--no-bypass');  // skip dead shortlinks
    args.push('--no-wipe');    // keep existing DB entries
  }
  if (resume) args.push('--resume'); // continue from checkpoint

  const label = skipScraper ? 'Skip Scraper (no-bypass)' : 'Full Pipeline';
  runScript('node', args, `🚀 Starting ${label}...`, 'Pipeline finished with');
  res.json({ message: `${label} started` });
});

// ── Heal Only (auth required) ────────────────────────────────────────────────
router.post('/heal', auth, (req, res) => {
  if (activeProcess && !isProcessAlive(activeProcess)) {
    activeProcess = null;
  }
  if (activeProcess) {
    return res.status(400).json({ error: 'Process is already running' });
  }

  const scriptPath = path.join(__dirname, '..', 'heal_db.js');
  runScript('node', [scriptPath], '🩺 Starting Database Healer...', 'Database Healer finished with');
  res.json({ message: 'Healer started' });
});

// ── Stop (auth required) ─────────────────────────────────────────────────────
router.post('/stop', auth, (req, res) => {
  if (!activeProcess) {
    return res.status(400).json({ error: 'No process is currently running' });
  }

  try { activeProcess.kill('SIGTERM'); } catch (_) {}
  broadcast('🛑 Force stopped by admin.');
  activeProcess = null;

  res.json({ message: 'Pipeline stopped' });
});

// ── Wipe (auth required) ─────────────────────────────────────────────────────
router.post('/wipe', auth, (req, res) => {
  if (activeProcess && !isProcessAlive(activeProcess)) {
    activeProcess = null;
  }
  if (activeProcess) {
    return res.status(400).json({ error: 'Process is already running' });
  }

  const scriptPath = path.join(__dirname, '..', 'wipe_db.js');
  runScript('node', [scriptPath], '🧨 Wiping Database...', 'Wipe finished with');
  res.json({ message: 'Wipe started' });
});

// ── Clear Logs ───────────────────────────────────────────────────────────────
router.post('/clear-logs', auth, (req, res) => {
  logBuffer = [];
  broadcast('🧹 Terminal log buffer cleared.');
  res.json({ message: 'Logs cleared' });
});

module.exports = router;
