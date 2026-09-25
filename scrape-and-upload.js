#!/usr/bin/env node
/**
 * scrape-and-upload.js — Xloop Scrape & Upload Automation
 * ─────────────────────────────────────────────────────────
 * Runs the Telegram scraper locally then auto-uploads to your live Vercel site.
 *
 * MODES:
 *   --mode=1   Full scrape     → ALL messages from ALL channels (takes hours)
 *   --mode=2   Specific        → Only channels you list with --channels=ID1,ID2
 *   --mode=3   Date range      → Last N days OR specific date range
 *   --mode=4   New only        → Only messages newer than last export (fastest)
 *
 * EXAMPLES:
 *   node scrape-and-upload.js --mode=4
 *     → Daily update: fetch only new messages since last scrape
 *
 *   node scrape-and-upload.js --mode=3 --days=7
 *     → Last 7 days from all channels
 *
 *   node scrape-and-upload.js --mode=3 --start-date=2024-01-01 --end-date=2024-03-01
 *     → Specific date range
 *
 *   node scrape-and-upload.js --mode=2 --channels=2121685058,1460307412
 *     → Only specific channels (full scrape of those channels)
 *
 *   node scrape-and-upload.js --mode=1
 *     → Full total scrape of all channels
 *
 *   node scrape-and-upload.js --upload-only
 *     → Skip scraping, just upload existing telegram_export.json
 *
 * NPM SHORTCUTS:
 *   npm run scrape               → mode 4 (daily new-only, recommended)
 *   npm run scrape:full          → mode 1 (full total scrape)
 *   npm run scrape:upload-only   → just upload existing file
 */
'use strict';

require('dotenv').config();
const { spawn }   = require('child_process');
const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const http        = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const SITE_URL      = process.env.XLOOP_URL      || 'https://xloop-rose.vercel.app';
const ADMIN_USER    = process.env.ADMIN_USERNAME  || 'admin';
const ADMIN_PASS    = process.env.ADMIN_PASSWORD  || 'xloop@admin123';
const EXPORT_FILE   = path.join(__dirname, 'telegram_export.json');
const SCRAPE_SCRIPT = path.join(__dirname, 'scrape_api.js');

// Parse CLI args
const rawArgs    = process.argv.slice(2);
const getArg     = (name) => { const a = rawArgs.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const hasFlag    = (name) => rawArgs.includes(`--${name}`);

const uploadOnly  = hasFlag('upload-only');
const noPipeline  = hasFlag('no-pipeline');
const showHelp    = hasFlag('help') || hasFlag('h');
const mode        = getArg('mode')       || '4';   // default: new-only (fastest)
const days        = getArg('days')       || '1';
const channels    = getArg('channels')   || 'all';
const startDate   = getArg('start-date') || '';
const endDate     = getArg('end-date')   || '';

const MODE_LABELS = {
  '1': 'Full scrape — ALL messages from ALL channels',
  '2': `Specific channels — ${channels}`,
  '3': startDate ? `Date range ${startDate} → ${endDate || 'now'}` : `Last ${days} day(s)`,
  '4': 'New only — messages newer than last export',
};

if (showHelp) {
  console.log(`
Usage: node scrape-and-upload.js [options]

Modes:
  --mode=1                Full scrape (all channels, all history)
  --mode=2 --channels=ID  Specific channels only
  --mode=3 --days=N       Last N days
  --mode=3 --start-date=YYYY-MM-DD [--end-date=YYYY-MM-DD]
  --mode=4                New messages only since last export (default)

Options:
  --upload-only           Skip scraping, upload existing telegram_export.json
  --no-pipeline           Upload only, don't trigger Full Pipeline
  --channels=ID1,ID2      Channel IDs for mode 2
  --days=N                Number of days back for mode 3

NPM shortcuts:
  npm run scrape           Daily update (mode 4)
  npm run scrape:full      Full scrape (mode 1)
  npm run scrape:upload-only
`);
  process.exit(0);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};
const log  = (msg) => console.log(`${c.cyan}[xloop]${c.reset} ${msg}`);
const ok   = (msg) => console.log(`${c.green}✅ ${msg}${c.reset}`);
const fail = (msg) => console.log(`${c.red}❌ ${msg}${c.reset}`);
const warn = (msg) => console.log(`${c.yellow}⚠️  ${msg}${c.reset}`);

function apiRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, SITE_URL);
    const isHttps = fullUrl.protocol === 'https:';
    const reqLib  = isHttps ? https : http;
    const data    = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data)  headers['Content-Length'] = Buffer.byteLength(data);

    const options = {
      hostname: fullUrl.hostname,
      port:     fullUrl.port || (isHttps ? 443 : 80),
      path:     fullUrl.pathname + fullUrl.search,
      method,
      headers,
      timeout: 300000, // 5 minute timeout for large uploads
    };

    const req = reqLib.request(options, (res) => {
      let raw = '';
      res.on('data', c => { raw += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(raw) }); }
        catch { resolve({ status: res.statusCode, body: raw }); }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Request timed out')));
    if (data) req.write(data);
    req.end();
  });
}

// ── Step 1: Run scraper locally ───────────────────────────────────────────────
async function runScraper() {
  if (uploadOnly) {
    warn('--upload-only flag set, skipping scraper');
    return;
  }

  const label = MODE_LABELS[mode] || `Mode ${mode}`;
  log(`Starting Telegram scraper: ${label}`);
  if (mode === '1') log('⚠️  Full scrape may take 1-3 hours depending on channel sizes.');
  if (mode === '4') log('Mode 4: Only fetching new messages since last export (fast).');

  // Build args for scrape_api.js
  const scrapeArgs = [`--mode=${mode}`, `--channels=${channels}`];
  if (mode === '3') {
    if (startDate) {
      scrapeArgs.push(`--start-date=${startDate}`);
      if (endDate) scrapeArgs.push(`--end-date=${endDate}`);
    } else {
      scrapeArgs.push(`--days=${days}`);
    }
  }

  log(`Running: node scrape_api.js ${scrapeArgs.join(' ')}`);

  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRAPE_SCRIPT, ...scrapeArgs], {
      cwd: __dirname,
      stdio: 'inherit',
      env: { ...process.env },
    });
    child.on('close', (code) => {
      if (code === 0) { ok('Scraper finished → telegram_export.json created'); resolve(); }
      else reject(new Error(`Scraper exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Step 2: Login to get token ────────────────────────────────────────────────
async function login() {
  log(`Logging in to ${SITE_URL}...`);
  const res = await apiRequest('POST', '/api/auth/login', {
    username: ADMIN_USER,
    password: ADMIN_PASS,
  });
  if (res.status !== 200 || !res.body.token) {
    throw new Error(`Login failed: ${JSON.stringify(res.body)}`);
  }
  ok('Logged in successfully');
  return res.body.token;
}

// ── Step 3: Upload telegram_export.json ───────────────────────────────────────
async function uploadExport(token) {
  if (!fs.existsSync(EXPORT_FILE)) {
    throw new Error(`telegram_export.json not found at ${EXPORT_FILE}`);
  }

  const sizeMB = (fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(1);
  log(`Reading telegram_export.json (${sizeMB} MB)...`);
  const data = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
  const msgCount = (data.messages || data).length;
  log(`Uploading ${msgCount} messages to ${SITE_URL}...`);
  log('Extraction runs server-side, this may take 30-60 seconds...');

  const res = await apiRequest('POST', '/api/scrape/upload-export', data, token);
  if (res.status !== 200) {
    throw new Error(`Upload failed (${res.status}): ${JSON.stringify(res.body)}`);
  }
  ok(res.body.message);
  return res.body;
}

// ── Step 4: Trigger Full Pipeline ─────────────────────────────────────────────
async function triggerPipeline(token) {
  if (noPipeline) {
    warn('--no-pipeline flag set, skipping pipeline trigger');
    log(`\n→ Go to ${SITE_URL}/admin/dashboard.html and click Full Pipeline`);
    return;
  }

  log('Triggering Full Pipeline on Vercel...');
  const res = await apiRequest('POST', '/api/orchestrator/start', { skipScraper: false }, token);
  if (res.status === 200) {
    ok('Full Pipeline started! Watch progress at:');
    log(`  → ${SITE_URL}/admin/dashboard.html`);
  } else {
    warn(`Pipeline trigger response: ${JSON.stringify(res.body)}`);
    log(`  → Go to ${SITE_URL}/admin/dashboard.html and click Full Pipeline manually`);
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`
${c.bold}${c.cyan}━━━ XLOOP ─ Scrape & Upload ━━━${c.reset}
`);
  console.log(`  Site:     ${SITE_URL}`);
  console.log(`  Mode:     ${uploadOnly ? 'Upload Only (skip scraper)' : MODE_LABELS[mode] || `Mode ${mode}`}`);
  console.log(`  Pipeline: ${noPipeline ? 'Manual (go to dashboard)' : 'Auto-trigger after upload'}\n`);

  try {
    // Step 1: Scrape
    await runScraper();

    // Step 2: Login
    const token = await login();

    // Step 3: Upload
    await uploadExport(token);

    // Step 4: Pipeline
    await triggerPipeline(token);

    console.log(`\n${c.green}${c.bold}✅ All done!${c.reset}`);
    if (!noPipeline) {
      console.log(`\nWatch the pipeline at: ${SITE_URL}/admin/dashboard.html\n`);
    }
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

main();
