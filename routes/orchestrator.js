const express   = require('express');
const router    = express.Router();
const { spawn } = require('child_process');
const readline  = require('readline');
const path      = require('path');
const auth      = require('../middleware/auth');

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
  if (activeProcess) {
    return res.status(400).json({ error: 'Process is already running' });
  }

  const { startDate, endDate, channels, skipScraper } = req.body || {};
  const scriptPath = path.join(__dirname, '..', 'orchestrator.js');
  const args = [scriptPath];
  if (startDate) args.push(`--start-date=${startDate}`);
  if (endDate)   args.push(`--end-date=${endDate}`);
  if (channels && channels.length) args.push(`--channels=${channels.join(',')}`);
  if (skipScraper) args.push('--skip-scraper');

  runScript('node', args, '🚀 Starting Master Orchestrator Pipeline...', 'Pipeline finished with');
  res.json({ message: 'Pipeline started' });
});

// ── Heal Only (auth required) ────────────────────────────────────────────────
router.post('/heal', auth, (req, res) => {
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
