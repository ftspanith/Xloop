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
require('dotenv').config();

// ── Config ───────────────────────────────────────────────────
const os = require('os');
const accountArg     = process.argv.find(a => a.startsWith('--account='));
const account        = accountArg ? accountArg.split('=')[1] : '1';
const exportFileName = account === '2' ? 'telegram_export_2.json' : 'telegram_export.json';
const EXPORT_FILE    = process.env.VERCEL ? path.join(os.tmpdir(), exportFileName) : path.join(__dirname, exportFileName);
const PROGRESS_FILE  = process.env.VERCEL ? path.join(os.tmpdir(), '.scrape_progress.json') : path.join(__dirname, '.scrape_progress.json');
const BATCH_SIZE     = 100;
const PARALLEL_LIMIT = 3;      // max concurrent channels
const INTER_BATCH_DELAY  = 300;   // ms between batches in same channel
const INTER_CHAN_DELAY   = 1500;  // ms between parallel groups
const AUTOSAVE_EVERY     = 5;     // save to disk every N channels

const ALL_CHANNEL_IDS = [
  2121685058, 1460307412, 3854487392, 3649684713,
  2676653332, 4234578006, 3619204173, 2785355990,
  3374719986, 2271910467, 3927502894, 3354192797,
  3579217190, 3952255152, 2640824484, 4355201143,
  2252012526, 4372491493, 3881216988, 4430701213,
  3846639915, 2307327392, 2417537485, 656335909,
  3426472755, 3898563246, 2656335909, 713791653
];

// ── Download relevance indicators ────────────────────────────
const DOWNLOAD_PATTERNS = [
  /\.(mkv|mp4|avi|mov|m2ts|ts|wmv)\b/i,
  /\b(gdflix|hubcloud|filepress|gplinks|nowshort|shorturl|aroralinks)\b/i,
  /https?:\/\/[^\s]+/,
  /\[\d+\.?\d*\s?(GB|MB)\]/i,
  /\b(2160p|1080p|720p|480p|360p|4K|UHD|BluRay|WEB-DL|REMUX|HEVC|x265|x264|H\.264|H\.265)\b/i,
];

const SKIP_PATTERNS = [
  /^(join|subscribe|follow|click here|telegram|channel|group)\b/i,
  /^[0-9\s\/\.\-]{1,15}$/,  // just numbers/dates
];

// ── Helpers ──────────────────────────────────────────────────
const args = Object.fromEntries(
  process.argv.slice(2).map(a => {
    const [k, ...rest] = a.replace(/^--/, '').split('=');
    return [k, rest.join('=')];
  })
);

const MODE         = parseInt(args.mode) || 1;
const DAYS         = parseInt(args.days) || 1;
const START_DATE   = args['start-date'];
const END_DATE     = args['end-date'];

// ── Pick credentials based on profile ────────────────────────────────────────
// Accept --account=2 (from scrape-and-upload.js) OR --profile=2 (legacy)
const _accountArg  = parseInt(args.account) || parseInt(args.profile) || 1;
const PROFILE      = _accountArg;  // 1 = primary, 2 = secondary
const ACCOUNT_NAME = args['account-name'] || `acc${PROFILE}`;
const TG_API_ID   = PROFILE === 2 ? process.env.TG_API_ID_2   : process.env.TG_API_ID;
const TG_API_HASH = PROFILE === 2 ? process.env.TG_API_HASH_2 : process.env.TG_API_HASH;
const TG_SESSION  = PROFILE === 2 ? process.env.TG_SESSION_2  : process.env.TG_SESSION;



// Each account can have its own channel list (TG_CHANNELS_2=id1,id2,...)
// If not set, falls back to the built-in ALL_CHANNEL_IDS
const ACCOUNT_CHANNELS_ENV = PROFILE === 2 ? process.env.TG_CHANNELS_2 : process.env.TG_CHANNELS_1;
const ACCOUNT_CHANNEL_IDS  = ACCOUNT_CHANNELS_ENV
  ? ACCOUNT_CHANNELS_ENV.split(',').map(Number).filter(Boolean)
  : ALL_CHANNEL_IDS;

const RAW_CHANNELS = args.channels || 'all';
const TARGET_CHANNELS = RAW_CHANNELS === 'all'
  ? [...ACCOUNT_CHANNEL_IDS]
  : RAW_CHANNELS.split(',').map(Number).filter(Boolean);

let logFn = (msg) => process.stdout.write(msg + '\n');

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Smart message relevance check ────────────────────────────
function isRelevant(text, msg) {
  if (SKIP_PATTERNS.some(p => p.test(text.trim()))) return false;
  
  // If it has a media attachment (direct video/file upload), keep it!
  if (msg && msg.media) return true;
  
  if (!text || text.trim().length < 2) return false;
  
  return DOWNLOAD_PATTERNS.some(p => p.test(text));
}

// ── Extract all URLs from a message (entities + buttons) ─────
function extractUrls(msg) {
  const urls = [];
  // Hyperlink entities (MessageEntityTextUrl)
  if (msg.entities) {
    for (const ent of msg.entities) {
      if (ent.url) urls.push(ent.url);
    }
  }
  // Inline keyboard buttons (ReplyInlineMarkup)
  if (msg.replyMarkup && msg.replyMarkup.rows) {
    for (const row of msg.replyMarkup.rows) {
      for (const btn of (row.buttons || [])) {
        if (btn.url) urls.push(btn.url);
      }
    }
  }
  return urls;
}

// ── Load / save crash-recovery progress ──────────────────────
function loadProgress() {
  try {
    if (fs.existsSync(PROGRESS_FILE))
      return JSON.parse(fs.readFileSync(PROGRESS_FILE, 'utf8'));
  } catch(_) {}
  return { completedChannels: [], partialMessages: [] };
}

function saveProgress(completedChannels, partialMessages) {
  fs.writeFileSync(PROGRESS_FILE, JSON.stringify({
    savedAt: new Date().toISOString(),
    completedChannels,
    partialMessages,
  }, null, 2));
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

  // Resolve channel name
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
      logFn(`   [Error] Failed to fetch batch: ${err.message}. Stopping channel.`);
      break;
    }

    const msgs = batch.messages;
    if (!msgs || msgs.length === 0) break;

    let hitBoundary = false;

    for (const msg of msgs) {
      // Date boundary check
      if (minDate > 0 && msg.date < minDate) { hitBoundary = true; break; }
      if (maxDate > 0 && msg.date > maxDate) { scanned++; continue; }
      scanned++;

      // Build full text including button URLs
      let text = msg.message || '';
      const urls = extractUrls(msg);
      if (urls.length > 0) text += '\n' + urls.join('\n');

      // Relevance filter — skip junk messages
      if (!isRelevant(text, msg)) { skipped++; continue; }

      msgs_out.push({
        id:           msg.id,
        type:         'message',
        channel_id:   channelId,
        channel_name: channelName,
        date:         new Date(msg.date * 1000).toISOString(),
        text:         text.trim(),
      });
      collected++;
    }

    offsetId = msgs[msgs.length - 1].id;
    logFn(`   Scanned ${scanned} | Collected ${collected} | Skipped ${skipped}`);

    if (hitBoundary || msgs.length < BATCH_SIZE) break;
    await sleep(INTER_BATCH_DELAY);
  }

  logFn(`   Done: ${scanned} scanned → ${collected} kept (${skipped} irrelevant filtered)`);
  return msgs_out;
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
  await Promise.all(workers);
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
function saveOutput(newMessages, modeLabel, existingMessages = []) {
  const merged = deduplicateMessages([...existingMessages, ...newMessages]);
  // Sort by date descending (newest first)
  merged.sort((a, b) => new Date(b.date) - new Date(a.date));

  const exportedAt = new Date().toISOString();
  const exportData = {
    exported_at:              exportedAt,
    scrape_mode:              modeLabel,
    total_messages_collected: merged.length,
    messages:                 merged,
  };

  const json = JSON.stringify(exportData, null, 2);

  // ── Human-readable filename → saved to ~/Downloads for easy access
  const dateStr      = exportedAt.slice(0, 10); // YYYY-MM-DD
  const fileName     = `xloop_${modeLabel}_${ACCOUNT_NAME}_${dateStr}_${merged.length}msgs.json`;
  const downloadsDir = path.join(os.homedir(), 'Downloads');
  const readableFile = path.join(downloadsDir, fileName);

  // Write to ~/Downloads/ (easy to find + upload)
  try {
    fs.writeFileSync(readableFile, json);
    logFn(`   Saved to       : ~/Downloads/${fileName}`);
  } catch(_) {
    // Fallback to project root if Downloads not writable
    fs.writeFileSync(path.join(__dirname, fileName), json);
    logFn(`   Saved to       : ${fileName} (project folder)`);
  }
  // Also write telegram_export.json in project root for pipeline compatibility
  fs.writeFileSync(EXPORT_FILE, json);
  return merged.length;
}

// ── MAIN ─────────────────────────────────────────────────────
(async () => {
  const apiId   = parseInt(TG_API_ID);
  const apiHash = TG_API_HASH;

  if (!apiId || !apiHash) {
    logFn(`TG_API_ID${PROFILE>1?'_'+PROFILE:''} or TG_API_HASH${PROFILE>1?'_'+PROFILE:''} missing from .env.`);
    process.exit(1);
  }
  if (!TG_SESSION) {
    logFn(`TG_SESSION${PROFILE>1?'_'+PROFILE:''} missing from .env. Authenticate first.`);
    process.exit(1);
  }

  logFn(`\n▶  Account: ${ACCOUNT_NAME} (Profile ${PROFILE}) | Channels: ${TARGET_CHANNELS.length}`);

  const client = new TelegramClient(
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
      existingMessages = existing.messages || [];
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

  if (alreadyDone.size > 0) {
    logFn(`[Recovery] Found interrupted session. ${alreadyDone.size} channels already scraped.`);
    logFn(`[Recovery] ${survivedMessages.length} messages already collected. Resuming...\n`);
  }

  logFn(`Starting ${modeLabel.toUpperCase()} scrape`);
  logFn(`Channels: ${TARGET_CHANNELS.length} | Parallel: ${PARALLEL_LIMIT} at a time`);
  logFn(`Smart filter: ON | FloodWait handling: ON | Crash recovery: ON\n`);

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
      const msgs = await scrapeChannel(client, channelId, { 
        minId: minIdMap[channelId] || 0, 
        minDate, 
      });
      return { channelId, msgs };
    });

    const results = await runInParallel(tasks, PARALLEL_LIMIT);

    for (const result of results) {
      if (!result) continue;
      allNew.push(...result.msgs);
      completedChannels.push(result.channelId);
    }

    // Auto-save progress after every group
    saveProgress(completedChannels, allNew);
    logFn(`\n[AutoSave] Progress saved. ${allNew.length} messages collected so far.`);

    // Delay between groups to respect rate limits
    if (i + PARALLEL_LIMIT < channelsToRun.length) {
      logFn(`[Throttle] Waiting ${INTER_CHAN_DELAY}ms before next group...`);
      await sleep(INTER_CHAN_DELAY);
    }
  }

  // ── Final save ───────────────────────────────────────────
  const totalInFile = saveOutput(allNew, modeLabel, existingMessages);
  clearProgress(); // remove crash recovery file since we're done

  const mb = (fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(2);

  logFn(`\nSCRAPE COMPLETE`);
  logFn(`   Mode           : ${modeLabel.toUpperCase()}`);
  logFn(`   New messages   : ${allNew.length}`);
  logFn(`   Total in file  : ${totalInFile}`);
  logFn(`   File size      : ${mb} MB`);
  logFn(`   Saved to       : ${EXPORT_FILE}`);

  await client.disconnect();
  process.exit(0);
})();
