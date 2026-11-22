/**
 * scrape_api.js — Intelligent Telegram Scraper Engine v3.0
 *
 * Intelligence features:
 *   - FloodWait auto-handling (waits exactly as long as Telegram says)
 *   - Crash recovery (saves per-channel progress to .scrape_progress.json)
 *   - Smart message filtering (only keeps messages with actual download content)
 *   - Link extraction from hyperlink entities AND reply-markup buttons
 *   - Message grouping (consecutive messages from same post are merged)
 *   - Exponential backoff on connection errors
 *   - Global deduplication by (channel_id + message_id) before writing
 *   - Parallel channel scraping (up to 3 at once, with rate-limit awareness)
 *   - Periodic auto-save every 5 channels so nothing is lost on crash
 *   - Relevance scoring — low-quality messages are flagged and skipped
 *
 * Args:
 *   --mode=1|2|3|4
 *   --channels=all | --channels=2121685058,1460307412,...
 *   --days=N
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram');
const fs                 = require('fs');
const path               = require('path');
const { buildTelegramMessageRecord, createExportArtifacts } = require('./utils/telegram-intelligence');
require('dotenv').config();

// ── Config ───────────────────────────────────────────────────
const os = require('os');
const accountArg     = process.argv.find(a => a.startsWith('--account='));
const account        = accountArg ? accountArg.split('=')[1] : '1';
if (!['1', '2'].includes(account)) throw new Error('Invalid --account. Use 1 or 2.');
const exportFileName = account === '2' ? 'telegram_export_2.json' : 'telegram_export.json';
const EXPORT_FILE    = process.env.VERCEL ? path.join(os.tmpdir(), exportFileName) : path.join(__dirname, exportFileName);
const PROGRESS_FILE  = process.env.VERCEL ? path.join(os.tmpdir(), `.scrape_progress_acc${account}.json`) : path.join(__dirname, `.scrape_progress_acc${account}.json`);
let BASE_EXPORT_SIGNATURE = 'missing';
try { const st = fs.statSync(EXPORT_FILE); BASE_EXPORT_SIGNATURE = `${st.size}:${st.mtimeMs}`; } catch (_) {}
const BATCH_SIZE     = 100;
const PARALLEL_LIMIT = 3;      // max concurrent channels
const INTER_BATCH_DELAY  = 300;   // ms between batches in same channel
const INTER_CHAN_DELAY   = 1500;  // ms between parallel groups
const AUTOSAVE_EVERY     = 5;     // save to disk every N channels

// Keep the CLI primary-account defaults aligned with /api/scrape/channels.
const ALL_CHANNEL_IDS = [
  2121685058, 1460307412, 3854487392, 3649684713,
  2676653332, 4234578006, 3619204173, 2785355990,
  3374719986, 2271910467, 3927502894, 3354192797,
  3579217190, 3952255152, 2640824484, 4355201143,
  2252012526, 4372491493, 3881216988, 4430701213
];

// ── Helpers ──────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=')];
  })
);

const MODE         = args.mode === undefined ? 4 : Number(args.mode);
const DAYS         = args.days === undefined ? 1 : Number(args.days);
const START_DATE   = args['start-date'];
const END_DATE     = args['end-date'];
if (!Number.isInteger(MODE) || MODE < 1 || MODE > 4) throw new Error('--mode must be 1, 2, 3, or 4.');
if (!Number.isInteger(DAYS) || DAYS < 1 || DAYS > 3650) throw new Error('--days must be an integer between 1 and 3650.');
if (START_DATE && Number.isNaN(Date.parse(START_DATE))) throw new Error('Invalid --start-date. Use YYYY-MM-DD.');
if (END_DATE && Number.isNaN(Date.parse(END_DATE))) throw new Error('Invalid --end-date. Use YYYY-MM-DD.');
if (START_DATE && END_DATE && Date.parse(END_DATE) < Date.parse(START_DATE)) throw new Error('--end-date must be on or after --start-date.')

// ── Pick credentials based on profile ────────────────────────────────────────
// Accept --account=2 (from scrape-and-upload.js) OR --profile=2 (legacy)
const _accountArg  = parseInt(args.account) || parseInt(args.profile) || 1;
const PROFILE      = _accountArg;  // 1 = primary, 2 = secondary
if (![1, 2].includes(PROFILE)) throw new Error('Invalid account profile. Use 1 or 2.');
const ACCOUNT_NAME = args['account-name'] || `acc${PROFILE}`;
const TG_API_ID   = PROFILE === 2 ? process.env.TG_API_ID_2   : process.env.TG_API_ID;
const TG_API_HASH = PROFILE === 2 ? process.env.TG_API_HASH_2 : process.env.TG_API_HASH;
const TG_SESSION  = PROFILE === 2 ? process.env.TG_SESSION_2  : process.env.TG_SESSION;



// Both accounts must have an explicit allowlist. Never silently scrape
// the built-in/default channel set: only IDs configured for this account run.
const CHANNELS_ENV_NAME = PROFILE === 2 ? 'TG_CHANNELS_2' : 'TG_CHANNELS_1';
const ACCOUNT_CHANNELS_ENV = process.env[CHANNELS_ENV_NAME];
if (!ACCOUNT_CHANNELS_ENV || !ACCOUNT_CHANNELS_ENV.trim()) {
  throw new Error(`${CHANNELS_ENV_NAME} is required. Add the specific channel/group IDs for Account ${PROFILE}; refusing to scrape an implicit/default list.`);
}
const ACCOUNT_CHANNEL_IDS = ACCOUNT_CHANNELS_ENV.split(',').map(v => Number(v.trim()));
if (!ACCOUNT_CHANNEL_IDS.length || ACCOUNT_CHANNEL_IDS.some(id => !Number.isSafeInteger(id) || id <= 0)) {
  throw new Error(`Invalid ${CHANNELS_ENV_NAME}. Use comma-separated positive numeric Telegram channel IDs only.`);
}
const RAW_CHANNELS = args.channels || 'all';
const TARGET_CHANNELS = [...new Set(RAW_CHANNELS === 'all' ? [...ACCOUNT_CHANNEL_IDS] : RAW_CHANNELS.split(',').map(v => Number(v.trim())))];
if (!TARGET_CHANNELS.length || TARGET_CHANNELS.some(id => !Number.isSafeInteger(id) || id <= 0)) throw new Error('No valid channels selected.')

let logFn = (msg) => process.stdout.write(msg + '\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Load / save crash-recovery progress ──────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE)) {
      const saved = JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
      const sameRun = saved.profile === PROFILE && saved.mode === MODE && saved.baseExportSignature === BASE_EXPORT_SIGNATURE && JSON.stringify(saved.targetChannels) === JSON.stringify(TARGET_CHANNELS);
      if (sameRun && Array.isArray(saved.completedChannels) && Array.isArray(saved.partialMessages)) return saved;
      logFn('[Recovery] Ignoring stale progress from a different account, mode, export, or channel selection.');
    }
  } catch(_) { logFn('[Recovery] Progress file is invalid; starting clean.'); }
  return { completedChannels: [], partialMessages: [] };
}
function saveProgress(completedChannels, partialMessages, scanStats) {
  const tmp = `${PROGRESS_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ savedAt: new Date().toISOString(), profile: PROFILE, mode: MODE, baseExportSignature: BASE_EXPORT_SIGNATURE, targetChannels: TARGET_CHANNELS, completedChannels, partialMessages, scanStats }, null, 2));
  fs.renameSync(tmp, PROGRESS_FILE);
}

function mergeScanStats(target, source) {
  target.scanned += Number(source && source.scanned || 0);
  target.captured += Number(source && source.captured || 0);
  target.skipped += Number(source && source.skipped || 0);
  if (Array.isArray(source && source.skippedReasons)) target.skippedReasons.push(...source.skippedReasons);
  if (Array.isArray(source && source.channelErrors)) target.channelErrors.push(...source.channelErrors);
  return target;
}

function clearProgress() {
  try { fs.unlinkSync(PROGRESS_FILE); } catch(_) {}
}

// ── Exponential backoff wrapper ───────────────────────────────
async function withRetry(fn, maxRetries = 4) {
  let delay = 1000;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      const msg = err.message || err.errorMessage || '';
      // FloodWait: always wait exactly as told
      if (msg.includes('FLOOD_WAIT') || (err.errorMessage && err.errorMessage.includes('FLOOD_WAIT'))) {
        const waitSec = parseInt(msg.match(/\d+/)?.[0]) || 30;
        logFn(`   [FloodWait] Telegram rate limit — waiting ${waitSec}s...`);
        await sleep(waitSec * 1000 + 2000);
        continue;
      }
      // Fatal: channel inaccessible — skip immediately, no retries
      const isFatal = msg.includes('CHANNEL_INVALID') || msg.includes('CHANNEL_PRIVATE') ||
        msg.includes('USERNAME_INVALID') || msg.includes('input entity') ||
        (err.errorMessage && (
          err.errorMessage.includes('CHANNEL_INVALID') ||
          err.errorMessage.includes('CHANNEL_PRIVATE') ||
          err.errorMessage.includes('USERNAME_INVALID')
        ));
      if (isFatal) throw err;
      if (attempt === maxRetries) throw err;
      logFn(`   [Retry ${attempt + 1}/${maxRetries}] ${msg.slice(0,80)} — retrying in ${delay/1000}s`);
      await sleep(delay);
      delay = Math.min(delay * 2, 30000);
    }
  }
}

// ── Core channel scraper ──────────────────────────────────────
async function scrapeChannel(client, channelId, { minId = 0, minDate = 0, maxDate = 0 } = {}) {
  const peer = `-100${channelId}`;
  let channelName = `channel_${channelId}`;
  let scanned = 0, collected = 0, skipped = 0, offsetId = 0;
  const msgs_out = [];
  const scanStats = { scanned: 0, captured: 0, skipped: 0, skippedReasons: [], channelErrors: [] };

  try {
    const entity = await withRetry(() => client.getEntity(peer));
    channelName = entity.title || entity.username || channelName;
    logFn(`   Name: ${channelName}`);
  } catch(_) {
    logFn(`   Could not resolve name, using ID: ${channelId}`);
  }

  while (true) {
    let batch;
    try {
      batch = await withRetry(() => client.invoke(
        new Api.messages.GetHistory({
          peer, offsetId,
          offsetDate: 0, addOffset: 0,
          limit: BATCH_SIZE, maxId: 0,
          minId, hash: BigInt(0),
        })
      ));
    } catch(err) {
      throw new Error(`Channel ${channelId} fetch failed: ${err.message}`);
    }

    const msgs = batch.messages;
    if (!msgs || msgs.length === 0) break;
    let hitBoundary = false;

    for (const msg of msgs) {
      if (!msg || msg.id == null) {
        scanned++;
        scanStats.scanned++;
        skipped++;
        scanStats.skipped++;
        scanStats.skippedReasons.push({ channel_id: channelId, reason: 'message_without_id' });
        continue;
      }

      if (minDate > 0 && msg.date < minDate) { hitBoundary = true; break; }
      if (maxDate > 0 && msg.date > maxDate) { scanned++; scanStats.scanned++; continue; }
      scanned++;
      scanStats.scanned++;

      // Capture first and classify second: promotion words never discard a message.
      try {
        const record = buildTelegramMessageRecord(msg, {
          channelId,
          channelName,
          account: PROFILE,
        });
        msgs_out.push(record);
        collected++;
        scanStats.captured++;
      } catch (error) {
        skipped++;
        scanStats.skipped++;
        scanStats.skippedReasons.push({
          channel_id: channelId,
          message_id: msg.id,
          reason: 'message_serialization_error',
          error: String(error && error.message || error).slice(0, 240),
        });
        logFn(`   [WARN] Could not serialize message ${msg.id}: ${error.message || error}`);
      }
    }
    offsetId = msgs[msgs.length - 1].id;
    logFn(`   Scanned ${scanned} | Captured ${collected} | Skipped ${skipped}`);

    if (hitBoundary || msgs.length < BATCH_SIZE) break;
    await sleep(INTER_BATCH_DELAY);
  }

  logFn(`   Done: ${scanned} scanned → ${collected} captured (${skipped} unsupported records)`);
  return { messages: msgs_out, stats: scanStats };
}
// ── Parallel pool executor ────────────────────────────────────
async function runInParallel(tasks, concurrency) {
  const results = new Array(tasks.length);
  let idx = 0;

  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      results[i] = await tasks[i]();
    }
  }

  const workers = Array.from({ length: Math.min(concurrency, tasks.length) }, worker);
  const settled = await Promise.allSettled(workers);
  const failed = settled.find(x => x.status === 'rejected');
  if (failed) throw failed.reason;
  return results;
}

// ── Global dedup by channel_id + message_id ──────────────────
function deduplicateMessages(messages) {
  const seen = new Set();
  return messages.filter(m => {
    const key = `${m.channel_id}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ── Save output ───────────────────────────────────────────────
function writeJsonAtomic(filePath, value) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, filePath);
}

function saveOutput(newMessages, modeLabel, existingMessages = [], scanStats = {}) {
  const merged = deduplicateMessages([...existingMessages, ...newMessages]);
  merged.sort((a, b) => new Date(b.date || 0) - new Date(a.date || 0));

  const exportedAt = new Date().toISOString();
  const artifacts = createExportArtifacts(merged, {
    account: PROFILE,
    modeLabel,
    exportedAt,
    scanStats,
  });
  const suffix = PROFILE === 2 ? '_2' : '';
  const sidecars = [
    [`telegram_shortlinks${suffix}.json`, artifacts.shortlinks],
    [`telegram_review${suffix}.json`, artifacts.review],
    [`telegram_scan_report${suffix}.json`, artifacts.report],
  ];

  // Preserve the canonical import file and add derived sidecars without a promotions file.
  writeJsonAtomic(EXPORT_FILE, artifacts.main);
  sidecars.forEach(([name, data]) => writeJsonAtomic(path.join(__dirname, name), data));

  const downloadsDir = path.join(os.homedir(), 'storage', 'downloads');
  const dateStr = exportedAt.slice(0, 10);
  const fileName = `xloop_${modeLabel}_${ACCOUNT_NAME}_${dateStr}_${merged.length}msgs.json`;
  try {
    if (!fs.existsSync(downloadsDir)) {
      throw new Error('Android shared Downloads is unavailable; run termux-setup-storage first.');
    }
    writeJsonAtomic(path.join(downloadsDir, fileName), artifacts.main);
    sidecars.forEach(([name, data]) => writeJsonAtomic(path.join(downloadsDir, name), data));
    logFn(`   Android Downloads: ${fileName} + ${sidecars.length} sidecar exports`);
  } catch(error) {
    logFn(`   Android Downloads unavailable (${error.message}); canonical exports remain in Xloop folder.`);
  }

  logFn(`   Main export      : ${EXPORT_FILE}`);
  sidecars.forEach(([name]) => logFn(`   Sidecar export   : ${path.join(__dirname, name)}`));
  return merged.length;
}
// ── MAIN ─────────────────────────────────────────────────────
let client;
(async () => {
 try {
  const apiId   = Number(TG_API_ID);
  const apiHash = TG_API_HASH;

  if (!apiId || !apiHash) {
    logFn(`TG_API_ID${PROFILE>1?'_'+PROFILE:''} or TG_API_HASH${PROFILE>1?'_'+PROFILE:''} missing from .env.`);
    throw new Error(`TG_API_ID${PROFILE>1?'_'+PROFILE:''} or TG_API_HASH${PROFILE>1?'_'+PROFILE:''} missing from .env.`);
  }
  if (!TG_SESSION) {
    logFn(`TG_SESSION${PROFILE>1?'_'+PROFILE:''} missing from .env. Authenticate first.`);
    throw new Error(`TG_SESSION${PROFILE>1?'_'+PROFILE:''} missing from .env. Authenticate first.`);
  }

  logFn(`\n▶  Account: ${ACCOUNT_NAME} (Profile ${PROFILE}) | Channels: ${TARGET_CHANNELS.length}`);

  client = new TelegramClient(
    new StringSession(TG_SESSION),
    apiId, apiHash,
    { connectionRetries: 8, retryDelay: 2000 }
  );
  client.setLogLevel('none');

  logFn('Connecting to Telegram...');
  await withRetry(() => client.connect());
  logFn('Connected!\n');

  // ── Mode setup ──────────────────────────────────────────
  let minDate = 0;
  let maxDate = 0;
  let modeLabel = ['full', 'selective', 'daily', 'new'][MODE - 1];
  let existingMessages = [];
  const minIdMap = {};

  if (MODE === 3) {
    if (START_DATE) {
      minDate = Math.floor(new Date(START_DATE).getTime() / 1000);
      if (END_DATE) {
        maxDate = Math.floor(new Date(END_DATE).getTime() / 1000);
        // Ensure maxDate includes the end of the day by adding 24 hours
        maxDate += 86400; 
      }
      logFn(`Mode 3: Fetching date range ${START_DATE} to ${END_DATE || 'Now'}\n`);
    } else {
      minDate = Math.floor(Date.now() / 1000) - DAYS * 86400;
      logFn(`Mode 3: Fetching last ${DAYS} day(s)\n`);
    }
  }

  if (MODE === 4) {
    if (fs.existsSync(EXPORT_FILE)) {
      const existing = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
      if (!existing || !Array.isArray(existing.messages)) throw new Error(`Existing export ${EXPORT_FILE} has an invalid format; refusing to overwrite it.`);
      existingMessages = existing.messages;
      for (const m of existingMessages) {
        if (!minIdMap[m.channel_id] || m.id > minIdMap[m.channel_id]) {
          minIdMap[m.channel_id] = m.id;
        }
      }
      logFn(`Mode 4: Found ${existingMessages.length} existing messages. Will only fetch newer ones.\n`);
    } else {
      logFn('No existing export found. Running full scrape.\n');
      modeLabel = 'full';
    }
  }

  // ── Check for crash recovery ─────────────────────────────
  const progress = loadProgress();
  const alreadyDone = new Set(progress.completedChannels || []);
  const survivedMessages = progress.partialMessages || [];
  const scanStats = progress.scanStats || { scanned: 0, captured: survivedMessages.length, skipped: 0, skippedReasons: [], channelErrors: [] };

  if (alreadyDone.size > 0) {
    logFn(`[Recovery] Found interrupted session. ${alreadyDone.size} channels already scraped.`);
    logFn(`[Recovery] ${survivedMessages.length} messages already collected. Resuming...\n`);
  }

  logFn(`Starting ${modeLabel.toUpperCase()} scrape`);
  logFn(`Channels: ${TARGET_CHANNELS.length} | Parallel: ${PARALLEL_LIMIT} at a time`);
  logFn(`Deep capture: ON | Non-destructive classification: ON | FloodWait handling: ON | Crash recovery: ON\n`);

  // ── Split channels into parallel groups ──────────────────
  const allNew = [...survivedMessages];
  const completedChannels = [...alreadyDone];

  const channelsToRun = TARGET_CHANNELS.filter(id => !alreadyDone.has(id));
  const totalChannels = TARGET_CHANNELS.length;
  let globalIdx = alreadyDone.size;

  // Process in groups of PARALLEL_LIMIT
  for (let i = 0; i < channelsToRun.length; i += PARALLEL_LIMIT) {
    const group = channelsToRun.slice(i, i + PARALLEL_LIMIT);

    const tasks = group.map((channelId) => async () => {
      globalIdx++;
      logFn(`\n[${globalIdx}/${totalChannels}] Channel: ${channelId}`);
      try {
        const result = await scrapeChannel(client, channelId, {
          minId: minIdMap[channelId] || 0,
          minDate, maxDate,
        });
        return { channelId, ok: true, messages: result.messages, stats: result.stats };
      } catch (error) {
        return {
          channelId,
          ok: false,
          error: String(error && error.message || error).slice(0, 500),
        };
      }
    });

    const results = await runInParallel(tasks, PARALLEL_LIMIT);

    for (const result of results) {
      if (!result) continue;
      if (!result.ok) {
        scanStats.channelErrors.push({ channel_id: result.channelId, error: result.error });
        logFn(`   [CHANNEL ERROR] ${result.channelId}: ${result.error}`);
        continue;
      }
      allNew.push(...result.messages);
      mergeScanStats(scanStats, result.stats);
      completedChannels.push(result.channelId);
    }

    // Auto-save progress after every group
    saveProgress(completedChannels, allNew, scanStats);
    logFn(`\n[AutoSave] Progress saved. ${allNew.length} messages collected so far.`);

    // Delay between groups to respect rate limits
    if (i + PARALLEL_LIMIT < channelsToRun.length) {
      logFn(`[Throttle] Waiting ${INTER_CHAN_DELAY}ms before next group...`);
      await sleep(INTER_CHAN_DELAY);
    }
  }

  // ── Final save ───────────────────────────────────────────
  const totalInFile = saveOutput(allNew, modeLabel, existingMessages, scanStats);
  clearProgress(); // remove crash recovery file since we're done

  const mb = (fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(2);

  logFn(`\nSCRAPE COMPLETE`);
  logFn(`   Mode           : ${modeLabel.toUpperCase()}`);
  logFn(`   New messages   : ${allNew.length}`);
  logFn(`   Total in file  : ${totalInFile}`);
  logFn(`   File size      : ${mb} MB`);
  logFn(`   Saved to       : ${EXPORT_FILE}`);

 } finally {
  if (client) {
    try { await client.disconnect(); } catch (disconnectErr) { logFn(`[WARN] Telegram disconnect issue: ${disconnectErr.message}`); }
  }
 }
})().catch(err => {
  logFn(`[FATAL] ${err.stack || err.message || err}`);
  process.exitCode = 1;
});
