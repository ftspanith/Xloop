#!/usr/bin/env node
/**
 * scrape-both-accounts.js
 * ──────────────────────────────────────────────────────────────────
 * Runs the Telegram scraper with BOTH accounts sequentially,
 * then merges the two export files and uploads everything in one shot.
 *
 * Setup:
 *   1. Add account 2 credentials to .env:
 *      TG_API_ID_2=your_id
 *      TG_API_HASH_2=your_hash
 *      TG_SESSION_2=your_session_string
 *      TG_CHANNELS_2=id1,id2,...  (optional — channels only acc2 can access)
 *
 *   2. Authenticate account 2 first (one-time):
 *      node scrape.js --profile=2   (or your auth script)
 *
 *   3. Run:
 *      npm run scrape:both
 *
 * What it does:
 *   - Scrapes acc1 channels → xloop_*_acc1_*.json
 *   - Scrapes acc2 channels → xloop_*_acc2_*.json
 *   - Merges both (deduped by channel_id:message_id)
 *   - Uploads merged result to Vercel
 *   - Triggers Full Pipeline
 */
'use strict';
require('dotenv').config();
const { spawn }  = require('child_process');
const fs         = require('fs');
const path       = require('path');
const https      = require('https');
const http       = require('http');

const SITE_URL      = process.env.XLOOP_URL     || 'https://xloop-rose.vercel.app';
const ADMIN_USER    = process.env.ADMIN_USERNAME || 'admin';
const ADMIN_PASS    = process.env.ADMIN_PASSWORD || 'xloop@admin123';
const SCRAPE_SCRIPT = path.join(__dirname, 'scrape_api.js');

const rawArgs   = process.argv.slice(2);
const getArg    = (n) => { const a = rawArgs.find(a => a.startsWith(`--${n}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const hasFlag   = (n) => rawArgs.includes(`--${n}`);
const mode      = getArg('mode') || '4';
const noPipeline = hasFlag('no-pipeline');

// ── Colours ───────────────────────────────────────────────────────────────────
const C = { reset:'\x1b[0m', green:'\x1b[32m', red:'\x1b[31m', yellow:'\x1b[33m', cyan:'\x1b[36m', bold:'\x1b[1m', dim:'\x1b[2m' };
const log  = (m) => console.log(`${C.cyan}[xloop]${C.reset} ${m}`);
const ok   = (m) => console.log(`${C.green}✔ ${m}${C.reset}`);
const warn = (m) => console.log(`${C.yellow}⚠  ${m}${C.reset}`);
const fail = (m) => console.log(`${C.red}✖ ${m}${C.reset}`);
const sep  = ()  => console.log(`${C.dim}${'─'.repeat(60)}${C.reset}`);

// ── HTTP helper ───────────────────────────────────────────────────────────────
function apiRequest(method, urlPath, body, token) {
  return new Promise((resolve, reject) => {
    const fullUrl = new URL(urlPath, SITE_URL);
    const isHttps = fullUrl.protocol === 'https:';
    const data    = body ? JSON.stringify(body) : null;
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (data)  headers['Content-Length'] = Buffer.byteLength(data);
    const req = (isHttps ? https : http).request({
      hostname: fullUrl.hostname, port: fullUrl.port || (isHttps ? 443 : 80),
      path: fullUrl.pathname, method, headers, timeout: 300000,
    }, (res) => {
      let raw = '';
      res.on('data', c => raw += c);
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

// ── Run scraper for one account ───────────────────────────────────────────────
function runScraperProfile(profile) {
  return new Promise((resolve, reject) => {
    const label = `Account ${profile}`;
    sep();
    log(`Starting scraper — ${label} (mode ${mode})...`);
    const child = spawn('node', [SCRAPE_SCRIPT, `--mode=${mode}`, `--profile=${profile}`, '--channels=all'], {
      cwd: __dirname, stdio: 'inherit', env: { ...process.env },
    });
    child.on('close', code => {
      if (code === 0) { ok(`${label} scrape complete`); resolve(); }
      else reject(new Error(`${label} scraper exited with code ${code}`));
    });
    child.on('error', reject);
  });
}

// ── Find the latest output file for a given account ───────────────────────────
function findLatestFile(accountName) {
  const files = fs.readdirSync(__dirname)
    .filter(f => f.startsWith(`xloop_`) && f.includes(`_${accountName}_`) && f.endsWith('.json'))
    .map(f => ({ name: f, mtime: fs.statSync(path.join(__dirname, f)).mtimeMs }))
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? path.join(__dirname, files[0].name) : null;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}━━━ XLOOP ─ Dual Account Scrape ━━━${C.reset}\n`);
  console.log(`  Site:     ${SITE_URL}`);
  console.log(`  Mode:     ${mode}`);
  console.log(`  Pipeline: ${noPipeline ? 'Manual' : 'Auto-trigger'}\n`);

  const hasAcc2 = !!(process.env.TG_API_ID_2 && process.env.TG_API_HASH_2 && process.env.TG_SESSION_2);
  if (!hasAcc2) {
    warn('TG_API_ID_2 / TG_API_HASH_2 / TG_SESSION_2 not set in .env');
    warn('Running account 1 only. Add account 2 credentials to .env to enable dual-account mode.');
  }

  // ── Step 1: Scrape account 1 ─────────────────────────────────────────────
  await runScraperProfile(1);

  // ── Step 2: Scrape account 2 (if configured) ─────────────────────────────
  if (hasAcc2) {
    await runScraperProfile(2);
  }

  // ── Step 3: Find output files ─────────────────────────────────────────────
  sep();
  log('Finding output files...');

  const file1 = findLatestFile('acc1');
  const file2 = hasAcc2 ? findLatestFile('acc2') : null;

  if (!file1) throw new Error('Could not find acc1 output file');
  ok(`Account 1: ${path.basename(file1)}`);
  if (file2) ok(`Account 2: ${path.basename(file2)}`);

  // ── Step 4: Read + merge files ────────────────────────────────────────────
  sep();
  const files = [file1, file2].filter(Boolean);
  log(`Reading ${files.length} file(s)...`);

  const exports = files.map(f => {
    const raw = fs.readFileSync(f, 'utf8');
    const size = (raw.length / 1024 / 1024).toFixed(1);
    log(`  ${path.basename(f)} — ${size} MB`);
    return JSON.parse(raw);
  });

  // ── Step 5: Login ─────────────────────────────────────────────────────────
  sep();
  log(`Logging in to ${SITE_URL}...`);
  const loginRes = await apiRequest('POST', '/api/auth/login', { username: ADMIN_USER, password: ADMIN_PASS });
  if (loginRes.status !== 200 || !loginRes.body.token) throw new Error(`Login failed: ${JSON.stringify(loginRes.body)}`);
  const token = loginRes.body.token;
  ok('Logged in');

  // ── Step 6: Upload (single export or array of exports) ────────────────────
  sep();
  const payload = exports.length === 1 ? exports[0] : exports;
  const totalMsgs = exports.reduce((s, e) => s + ((e.messages || e).length || 0), 0);
  log(`Uploading ${totalMsgs.toLocaleString()} total messages from ${files.length} account(s)...`);
  log('Server will extract, merge, and dedup automatically...');

  const uploadRes = await apiRequest('POST', '/api/scrape/upload-export', payload, token);
  if (uploadRes.status !== 200) throw new Error(`Upload failed (${uploadRes.status}): ${JSON.stringify(uploadRes.body)}`);
  ok(uploadRes.body.message);

  // ── Step 7: Trigger pipeline ──────────────────────────────────────────────
  if (!noPipeline) {
    sep();
    log('Triggering Full Pipeline...');
    const pipeRes = await apiRequest('POST', '/api/orchestrator/start', { skipScraper: false }, token);
    if (pipeRes.status === 200) {
      ok(`Pipeline started! → ${SITE_URL}/admin/dashboard.html`);
    } else {
      warn(`Pipeline not triggered automatically. Go to Dashboard → Full Pipeline.`);
    }
  }

  sep();
  console.log(`\n${C.green}${C.bold}✔ Done!${C.reset} Both accounts scraped and uploaded.\n`);
}

main().catch(err => { fail(err.message); process.exit(1); });
