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
// Parse CLI args (need to parse account early to set EXPORT_FILE)
const rawArgs    = process.argv.slice(2);
const getArg     = (name) => { const a = rawArgs.find(a => a.startsWith(`--${name}=`)); return a ? a.split('=').slice(1).join('=') : null; };
const hasFlag    = (name) => rawArgs.includes(`--${name}`);

const account       = getArg('account') || '1';
const EXPORT_FILE   = path.join(__dirname, account === '2' ? 'telegram_export_2.json' : 'telegram_export.json');
const SCRAPE_SCRIPT = path.join(__dirname, 'scrape_api.js');

const uploadOnly  = hasFlag('upload-only');
const noPipeline  = hasFlag('no-pipeline');
const showHelp    = hasFlag('help') || hasFlag('h');
const mode        = getArg('mode')       || '4';   // default: new-only (fastest)
const days        = getArg('days')       || '1';
const channels    = getArg('channels')   || 'all';
const startDate   = getArg('start-date') || '';
const endDate     = getArg('end-date')   || '';
const mergeMode   = hasFlag('merge') || account === '2'; // account 2 always merges

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
  --account=2             Use second Telegram account (auto-uses TG_CHANNELS_2, merges with acc1 data)
  --merge                 Upload in merge mode (don't wipe existing links)

NPM shortcuts:
  npm run scrape           Daily update (mode 4)
  npm run scrape:full      Full scrape (mode 1)
  npm run scrape:upload-only
  npm run scrape:acc2      Full scrape with account 2 (merge mode)
`);
  process.exit(0);
}

// ── Utils ─────────────────────────────────────────────────────────────────────
const c = {
  reset: '\x1b[0m', green: '\x1b[32m', red: '\x1b[31m',
  yellow: '\x1b[33m', cyan: '\x1b[36m', bold: '\x1b[1m',
};
const log  = (msg) => console.log(`${c.cyan}[xloop]${c.reset} ${msg}`);
const ok   = (msg) => console.log(`${c.green}[OK] ${msg}${c.reset}`);
const fail = (msg) => console.log(`${c.red}[ERR] ${msg}${c.reset}`);
const warn = (msg) => console.log(`${c.yellow}[WARN] ${msg}${c.reset}`);

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

  // Account 2: use TG_CHANNELS_2 from .env unless --channels was explicitly set
  const acc2Channels = process.env.TG_CHANNELS_2 || '';
  const effectiveChannels = (account === '2' && acc2Channels && channels === 'all')
    ? acc2Channels   // account 2 dedicated channel list
    : channels;      // --channels arg or 'all' for account 1

  const label = MODE_LABELS[mode] || `Mode ${mode}`;
  log(`Starting Telegram scraper: ${label}`);
  if (account === '2') log(`Account 2 — ${acc2Channels ? acc2Channels.split(',').length : 0} dedicated channels`);
  if (mode === '1') log('Full scrape may take 1-3 hours depending on channel sizes.');
  if (mode === '4') log('Mode 4: Only fetching new messages since last export (fast).');

  // Build args for scrape_api.js — pass --account=2 so scraper uses TG_SESSION_2 credentials
  const scrapeArgs = [
    `--mode=${mode}`,
    `--channels=${effectiveChannels}`,
    ...(account === '2' ? ['--account=2'] : []),
  ];
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

// ── Step 3: Upload telegram_export.json (chunked to avoid 413) ────────────────
// Instead of sending the raw 17MB JSON (hits Vercel's 4.5MB limit),
// we parse it locally and upload extracted links in 400-item chunks.
async function uploadExport(token, mergeMode = false) {
  if (!fs.existsSync(EXPORT_FILE)) {
    throw new Error(`telegram_export.json not found at ${EXPORT_FILE}`);
  }

  const sizeMB = (fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(1);
  log(`Reading telegram_export.json (${sizeMB} MB)...`);
  const raw  = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
  const msgs = raw.messages || raw;
  log(`Parsing ${msgs.length} messages locally (avoids 413 upload limit)...`);

  // ── Local extraction (mirrors server-side upload-export logic) ──────────────
  const { parseMessageBlock, isJunkTitle, classifyUrl } = (() => {
    try { return require('./utils/parser'); } catch { return require('./utils/parser.js'); }
  })();

  const HOST_PRIORITY = ['GDFlix','HubCloud','FilePress','DTFlix','TMBCloud','Direct','Download'];
  const hostRank = h => { const i = HOST_PRIORITY.indexOf(h); return i === -1 ? 99 : i; };
  const CDN_RE = [/\.(m3u8|ts|m4s)(\?|$)/i, /\/(image|img|thumbnail|poster|banner|cover)\//i,
    /\/(uploads?|wp-content|static|assets?)\//i, /cdn\.(hotstar|zee5|sonyliv)/i,
    /vod\d*\./i, /img\d*\./i, /thumbs?\./i, /akamaized\.net/i, /cloudfront\.net/i];
  const isJunkUrl = u => { if (!u) return true;
    if (/workers\.dev/i.test(u)) return !/\.(mkv|mp4|avi|zip|rar)([?#]|$)/i.test(u);
    return CDN_RE.some(r => r.test(u)); };

  // Dedup messages by channel:msgId
  const msgMap = new Map();
  for (const m of msgs) { const k = `${m.channel_id||'0'}:${m.id}`; if (!msgMap.has(k)) msgMap.set(k, m); }
  const dedupedMsgs = [...msgMap.values()];
  log(`After message dedup: ${dedupedMsgs.length} unique messages (${msgs.length - dedupedMsgs.length} duplicates removed)`);

  const extracted = []; const shortlinks = [];
  const seenUrls  = new Set();
  let   skipped   = 0;

  for (const msg of dedupedMsgs) {
    let rawText = '';
    if (typeof msg.text === 'string') rawText = msg.text;
    else if (Array.isArray(msg.text)) rawText = msg.text.map(p => {
      if (typeof p === 'string') return p;
      if (p.type === 'text_link' && p.href) return `${p.text}\n${p.href}\n`;
      return p.text || '';
    }).join('');
    if (msg.reply_markup?.inline_keyboard) {
      for (const row of msg.reply_markup.inline_keyboard)
        for (const btn of (row||[])) if (btn.url) rawText += `\n${btn.url}`;
    }
    if (!rawText.trim()) { skipped++; continue; }
    let parsed;
    try { parsed = parseMessageBlock(rawText, msg.id); } catch { skipped++; continue; }
    if (!parsed || !parsed.downloads?.length || !parsed.title || isJunkTitle(parsed.title)) { skipped++; continue; }

    const msgSlots = new Map();
    for (const dl of parsed.downloads) {
      const lang = dl.language || parsed.language || '';
      for (const link of dl.links) {
        const url = link.url.replace(/^http:\/\//i,'https://').replace(/\/$/,'');
        if (isJunkUrl(url) || seenUrls.has(url)) continue;
        const urlType = typeof classifyUrl === 'function' ? classifyUrl(url) : (/gdflix|hubcloud|gdlink|fpgo/i.test(url) ? 'GDFlix' : 'Direct');
        if (urlType === 'Ignore' || urlType === 'Paste') continue;
        const entry = { messageId: parsed.messageId, title: parsed.title, year: parsed.year,
          contentType: parsed.contentType, isSeries: parsed.isSeries,
          season: dl.season??parsed.season, episode: dl.episode??parsed.episode,
          language: lang, quality: dl.quality, size: dl.size, filename: dl.filename,
          codec: dl.codec || '', hdr: dl.hdr || '', audio: dl.audio || '', bitDepth: dl.bitDepth || '', audioChannels: dl.audioChannels || '',
          host: urlType, url, bypassedUrl: null, sourceAccount: account,
          isFast: /gdflix|hubcloud|gdlink|tmbcloud|fpgo|filebee/i.test(url),
          imdbId: parsed.imdbId||null, tmdbIdHint: parsed.tmdbIdHint||null };
        const sk = `${dl.quality||''}|${(dl.size||'').replace(/\s/g,'')}|${(dl.filename||'').slice(0,80)}|${lang}`;
        if (urlType === 'Shortlink') { shortlinks.push(entry); seenUrls.add(url); continue; }
        if (msgSlots.has(sk)) msgSlots.get(sk).push(entry);
        else msgSlots.set(sk, [entry]);
      }
    }
    for (const sl of msgSlots.values()) {
      sl.sort((a,b)=>hostRank(a.host)-hostRank(b.host));
      for (const e of sl) { seenUrls.add(e.url); extracted.push(e); }
    }
  }
  const allLinks = [...extracted, ...shortlinks];
  log(`Extracted ${allLinks.length} links (${skipped} messages skipped)`);

  // ── Upload in chunks of 400 links (~150-250KB each, well under 4.5MB limit) ──
  const CHUNK = 400;
  const MAX_RETRIES = 4;   // retry up to 4× on 503/timeout
  const RETRY_DELAY_MS = 4000;
  const modeQs = mergeMode ? '&merge=true' : '';
  let batchId   = null;
  let totalSent = 0;

  for (let i = 0; i < allLinks.length; i += CHUNK) {
    const chunk   = allLinks.slice(i, i + CHUNK);
    const isFinal = i + CHUNK >= allLinks.length;
    const body    = { links: chunk, batchId, isFinal,
      messageCount: dedupedMsgs.length, skipped };

    let res = null;
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        res = await apiRequest('POST', `/api/scrape/save-extracted?${modeQs}`, body, token);
        if (res.status === 200) break;   // success
        if (res.status === 503 || res.status === 504 || res.status === 502) {
          warn(`\nChunk ${Math.floor(i/CHUNK)+1}: Server busy (${res.status}), retry ${attempt}/${MAX_RETRIES} in ${RETRY_DELAY_MS/1000}s...`);
          await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
        } else {
          throw new Error(`Chunk upload failed (${res.status}): ${JSON.stringify(res.body)}`);
        }
      } catch (networkErr) {
        if (attempt === MAX_RETRIES) throw networkErr;
        warn(`\nChunk ${Math.floor(i/CHUNK)+1}: Network error, retry ${attempt}/${MAX_RETRIES}...`);
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS * attempt));
      }
    }
    if (!res || res.status !== 200) throw new Error(`Chunk upload failed after ${MAX_RETRIES} retries: ${JSON.stringify(res && res.body)}`);

    if (!batchId && res.body.batchId) batchId = res.body.batchId;
    totalSent += chunk.length;
    process.stdout.write(`\r${c.cyan}[xloop]${c.reset} Uploaded ${totalSent}/${allLinks.length} links...`);
    if (isFinal) {
      console.log(''); // newline after progress
      ok(res.body.message || `Upload complete: ${totalSent} links sent`);
    }
  }

  // ── Also upload the raw JSON export so json-search-links endpoint can use it ──
  // Send just the messages array compressed to a dedicated endpoint
  log('Uploading raw messages for search index...');
  try {
    const exportRes = await apiRequest('POST',
      `/api/scrape/upload-export${mergeMode ? '?merge=true' : ''}`,
      { messages: dedupedMsgs }, token);
    if (exportRes.status === 200) {
      log('Search index updated.');
    } else if (exportRes.status === 413) {
      warn('Raw export too large for search index upload (OK — DB links still work).');
    }
  } catch(e) { warn(`Search index upload skipped: ${e.message}`); }

  return { count: totalSent, batchId };
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

// ── Sync history helpers ──────────────────────────────────────────────────────
const SYNC_FILE = path.join(__dirname, 'scrape_sync.json');

function loadSyncHistory() {
  try { return JSON.parse(fs.readFileSync(SYNC_FILE, 'utf8')); } catch { return {}; }
}

function saveSyncHistory(acc, extra = {}) {
  const history = loadSyncHistory();
  const now = new Date();
  history[`acc${acc}`] = {
    date: now.toISOString(),
    dateHuman: now.toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', dateStyle: 'medium', timeStyle: 'short' }),
    ...extra,
  };
  fs.writeFileSync(SYNC_FILE, JSON.stringify(history, null, 2));
}

function printSyncSummary() {
  const history = loadSyncHistory();
  console.log(`\n${c.bold}${c.cyan}━━━ SYNC STATUS ━━━${c.reset}`);
  const acc1 = history.acc1;
  const acc2 = history.acc2;
  if (acc1) console.log(`  ${c.green}Acc 1 (Main):${c.reset}      Last synced ${c.bold}${acc1.dateHuman}${c.reset}  — ${acc1.links || '?'} links`);
  else       console.log(`  ${c.yellow}Acc 1 (Main):${c.reset}      Never synced`);
  if (acc2)  console.log(`  ${c.green}Acc 2 (Secondary):${c.reset} Last synced ${c.bold}${acc2.dateHuman}${c.reset}  — ${acc2.links || '?'} links`);
  else       console.log(`  ${c.yellow}Acc 2 (Secondary):${c.reset} Never synced`);
  console.log(`${c.cyan}━━━━━━━━━━━━━━━━━━━━━${c.reset}\n`);
}

// Run both Telegram accounts sequentially. Acc 1 replaces its own batch first;
// Acc 2 then merges unique links. The full pipeline runs once after both uploads.
function runAccountChild(profile) {
  const childArgs = [
    __filename,
    `--mode=${mode}`,
    `--account=${profile}`,
    '--no-pipeline',
  ];
  if (channels !== 'all') childArgs.push(`--channels=${channels}`);
  if (mode === '3') {
    if (startDate) {
      childArgs.push(`--start-date=${startDate}`);
      if (endDate) childArgs.push(`--end-date=${endDate}`);
    } else childArgs.push(`--days=${days}`);
  }
  if (uploadOnly) childArgs.push('--upload-only');
  return new Promise((resolve, reject) => {
    log(`Starting Account ${profile} child workflow...`);
    const child = spawn(process.execPath, childArgs, { cwd: __dirname, stdio: 'inherit', env: { ...process.env } });
    child.on('close', code => code === 0 ? resolve() : reject(new Error(`Account ${profile} workflow exited with code ${code}`)));
    child.on('error', reject);
  });
}

async function runBothAccounts() {
  await runAccountChild('1');
  await runAccountChild('2');
  if (!noPipeline) {
    const token = await login();
    await triggerPipeline(token);
  } else {
    warn('Both account uploads completed; pipeline trigger skipped by --no-pipeline.');
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${c.bold}${c.cyan}━━━ XLOOP ─ Scrape & Upload ━━━${c.reset}\n`);
  console.log(`  Site:     ${SITE_URL}`);
  console.log(`  Account:  ${account === 'both' ? 'Both accounts (Acc 1 replace, then Acc 2 merge)' : account === '2' ? 'Account 2 (rare channels, merge mode)' : 'Account 1 (primary)'}`);
  console.log(`  Mode:     ${uploadOnly ? 'Upload Only (skip scraper)' : MODE_LABELS[mode] || `Mode ${mode}`}`);
  console.log(`  Upload:   ${mergeMode ? 'MERGE (keeps existing account 1 data)' : 'REPLACE (wipes old data)'}`);
  console.log(`  Pipeline: ${noPipeline ? 'Manual (go to dashboard)' : 'Auto-trigger after upload'}\n`);

  // Show previous sync history at the start
  printSyncSummary();

  if (mergeMode && account === '2') {
    log('Merge mode: account 2 links will be ADDED to existing account 1 links.');
    log('Duplicate URLs will be skipped. Unique rare links will be kept.');
  }

  try {
    if (account === 'both') {
      await runBothAccounts();
      console.log(`\n${c.green}${c.bold}━━━ BOTH ACCOUNTS DONE ━━━${c.reset}\n`);
      printSyncSummary();
      return;
    }
    // Step 1: Scrape
    await runScraper();

    // Step 2: Login
    const token = await login();

    // Step 3: Upload (merge mode for account 2 — don't wipe account 1 data)
    const { count: uploadedCount } = await uploadExport(token, mergeMode);

    // Step 4: Save sync history — locally AND on Vercel (so dashboard badges update)
    saveSyncHistory(account, { links: uploadedCount, mode, source: 'auto' });
    try {
      const syncRes = await apiRequest('POST', '/api/scrape/mark-sync', {
        account,
        source: 'auto',
        links: uploadedCount,
      }, token);
      if (syncRes.status === 200) ok(`Sync status saved to dashboard (Acc ${account}: ${uploadedCount} links)`);
    } catch (e) { warn(`Could not update dashboard sync status: ${e.message}`); }

    // Step 5: Pipeline
    await triggerPipeline(token);

    // Final summary
    console.log(`\n${c.green}${c.bold}━━━ DONE ━━━${c.reset}`);
    printSyncSummary();
    if (!noPipeline) {
      console.log(`Watch the pipeline at: ${SITE_URL}/admin/dashboard.html\n`);
    }
  } catch (err) {
    fail(err.message);
    process.exit(1);
  }
}

main();
