#!/usr/bin/env node
/**
 * scrape-and-upload.js
 * ─────────────────────────────────────────────────────────────────────────────
 * ONE-COMMAND workflow for Xloop on Vercel:
 *   1. Runs scrape_api.js locally to generate telegram_export.json
 *   2. Reads the generated file
 *   3. Uploads to your live Vercel site via /api/scrape/upload-export
 *   4. Triggers Full Pipeline automatically (optional)
 *
 * Usage:
 *   node scrape-and-upload.js               → scrape all channels + upload
 *   node scrape-and-upload.js --upload-only → skip scraping, just upload existing file
 *   node scrape-and-upload.js --mode=2      → scrape mode 2 + upload
 *   node scrape-and-upload.js --no-pipeline → upload only, don't trigger pipeline
 *
 * Set XLOOP_URL in .env or pass as env var:
 *   XLOOP_URL=https://xloop-rose.vercel.app
 */
'use strict';

require('dotenv').config();
const { spawn }   = require('child_process');
const fs          = require('fs');
const path        = require('path');
const https       = require('https');
const http        = require('http');

// ── Config ────────────────────────────────────────────────────────────────────
const SITE_URL     = process.env.XLOOP_URL || 'https://xloop-rose.vercel.app';
const ADMIN_USER   = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS   = process.env.ADMIN_PASSWORD || 'xloop@admin123';
const EXPORT_FILE  = path.join(__dirname, 'telegram_export.json');
const SCRAPE_SCRIPT = path.join(__dirname, 'scrape_api.js');

const args         = process.argv.slice(2);
const uploadOnly   = args.includes('--upload-only');
const noPipeline   = args.includes('--no-pipeline');
const mode         = (args.find(a => a.startsWith('--mode=')) || '--mode=1').split('=')[1];

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

  log(`Starting Telegram scraper (Mode ${mode})...`);
  log('This may take 10-30 minutes depending on channel size.');

  return new Promise((resolve, reject) => {
    const child = spawn('node', [SCRAPE_SCRIPT, `--mode=${mode}`, '--channels=all'], {
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
  console.log(`\n${c.bold}${c.cyan}━━━ XLOOP ─ Scrape & Upload ━━━${c.reset}\n`);
  console.log(`  Site:  ${SITE_URL}`);
  console.log(`  Mode:  ${uploadOnly ? 'Upload Only' : `Scrape Mode ${mode} + Upload`}`);
  console.log(`  Pipeline: ${noPipeline ? 'Manual' : 'Auto-trigger'}\n`);

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
