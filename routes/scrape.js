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

const ROOT          = path.join(__dirname, '..');
const SCRAPE_SCRIPT = path.join(ROOT, 'scrape_api.js');
const EXPORT_FILE   = path.join(ROOT, 'telegram_export.json');

// ── GET /api/scrape/channels — return channel list ──────────
router.get('/channels', (req, res) => {
  res.json({
    channels: [
      2121685058, 1460307412, 3854487392, 3649684713,
      2676653332, 4234578006, 3619204173, 2785355990,
      3374719986, 2271910467, 3927502894, 3354192797,
      3579217190, 3952255152, 2640824484, 4355201143,
      2252012526, 4372491493, 3881216988, 4430701213,
    ]
  });
});

// ── POST /api/scrape/start — start scraping (SSE stream) ────
// Body: { mode: 1|2|3|4, channels?: number[], startDate?: string, endDate?: string }
router.post('/start', (req, res) => {
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

module.exports = router;
