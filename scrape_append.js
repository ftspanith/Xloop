/**
 * Single-channel incremental scraper.
 * Scrapes only the specified channel and MERGES its messages
 * into the existing telegram_export.json without touching others.
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram');
const fs                 = require('fs');
const path               = require('path');
require('dotenv').config();

// ─── Config ───────────────────────────────────────────────────────────────────
const NEW_CHANNEL_ID  = 3881216988;          // Channel to scrape
const EXPORT_FILE     = path.join(__dirname, 'telegram_export.json');

// ─── Telegram credentials ─────────────────────────────────────────────────────
const apiId      = parseInt(process.env.TG_API_ID);
const apiHash    = process.env.TG_API_HASH;
const sessionStr = process.env.TG_SESSION || '';

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

(async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   XLOOP — Single Channel Append Scraper      ║');
  console.log(`║   Channel: ${NEW_CHANNEL_ID}              ║`);
  console.log('╚══════════════════════════════════════════════╝\n');

  // ─── Load existing JSON ────────────────────────────────────────────────────
  let existingData = { exported_at: new Date().toISOString(), messages: [] };
  let existingMessages = [];
  if (fs.existsSync(EXPORT_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
      // Support both plain array and { messages: [...] } object formats
      if (Array.isArray(raw)) {
        existingMessages = raw;
        existingData = { exported_at: new Date().toISOString(), messages: existingMessages };
      } else {
        existingData    = raw;
        existingMessages = raw.messages || [];
      }
      console.log(` Loaded existing file: ${existingMessages.length} messages`);
    } catch (e) {
      console.log(`  Could not parse existing file, starting fresh.`);
    }
  } else {
    console.log('  No existing file found, will create new one.');
  }

  // Get existing message IDs for this channel to avoid duplicates
  const existingIds = new Set(
    existingMessages
      .filter(m => m.channel_id === NEW_CHANNEL_ID)
      .map(m => m.id)
  );
  console.log(`   Already have ${existingIds.size} messages from this channel\n`);

  // ─── Connect to Telegram ───────────────────────────────────────────────────
  const client = new TelegramClient(
    new StringSession(sessionStr),
    apiId,
    apiHash,
    { connectionRetries: 5, useWSS: false }
  );

  await client.connect();
  console.log(' Connected to Telegram!\n');

  const peer = new Api.InputPeerChannel({
    channelId: BigInt(NEW_CHANNEL_ID),
    accessHash: BigInt(0)
  });

  let channelName = `channel_${NEW_CHANNEL_ID}`;
  try {
    const entity = await client.getEntity(NEW_CHANNEL_ID);
    channelName = entity.title || entity.username || channelName;
    console.log(` Channel name: ${channelName}`);
  } catch (e) {
    console.log(`  Could not resolve channel name, using ID.`);
  }

  // ─── Scrape messages ───────────────────────────────────────────────────────
  const newMessages = [];
  let offsetId  = 0;
  let totalScan = 0;
  const batchSize = 100;

  while (true) {
    let result;
    try {
      result = await client.invoke(
        new Api.messages.GetHistory({
          peer,
          offsetId,
          offsetDate: 0,
          addOffset:  0,
          limit:      batchSize,
          maxId:      0,
          minId:      0,
          hash:       BigInt(0),
        })
      );
    } catch (e) {
      if (e.message && e.message.includes('FLOOD_WAIT')) {
        const wait = parseInt(e.message.match(/\d+/)?.[0] || '10');
        console.log(`   ⏳ Flood wait ${wait}s...`);
        await sleep(wait * 1000 + 1000);
        continue;
      }
      console.error('Error fetching:', e.message);
      break;
    }

    const msgs = result.messages;
    if (!msgs || msgs.length === 0) break;

    for (const msg of msgs) {
      totalScan++;
      let text = msg.message || '';

      // Extract hidden hyperlink URLs from entities
      if (msg.entities) {
        for (const ent of msg.entities) {
          if (ent.url) text += `\n${ent.url}`;
        }
      }

      if (text.trim().length < 10) continue;

      // Skip if we already have this message
      if (existingIds.has(msg.id)) continue;

      newMessages.push({
        id:           msg.id,
        type:         'message',
        channel_id:   NEW_CHANNEL_ID,
        channel_name: channelName,
        date:         new Date(msg.date * 1000).toISOString(),
        text:         text.trim()
      });
    }

    offsetId = msgs[msgs.length - 1].id;
    if (totalScan % 500 === 0) {
      process.stdout.write(`   Scanned ${totalScan} msgs, ${newMessages.length} new...\r`);
    }
    if (msgs.length < batchSize) break;
    await sleep(300);
  }

  await client.disconnect();

  console.log(`\n Done: scanned ${totalScan} msgs → ${newMessages.length} new to add\n`);

  if (newMessages.length === 0) {
    console.log('ℹ  Nothing new to add. telegram_export.json unchanged.');
    process.exit(0);
  }

  // ─── Merge and save ────────────────────────────────────────────────────────
  existingData.messages = [...existingMessages, ...newMessages];
  existingData.exported_at = new Date().toISOString();
  existingData.total_messages_collected = (existingData.total_messages_collected || 0) + newMessages.length;
  existingData.total_messages_scanned   = (existingData.total_messages_scanned   || 0) + totalScan;
  existingData.total_channels           = (existingData.total_channels           || 0);
  // Add this channel to the count only if new
  const wasAlreadyTracked = existingMessages.some(m => m.channel_id === NEW_CHANNEL_ID);
  if (!wasAlreadyTracked) existingData.total_channels += 1;

  fs.writeFileSync(EXPORT_FILE, JSON.stringify(existingData, null, 2), 'utf8');
  const sizeMB = (fs.statSync(EXPORT_FILE).size / 1024 / 1024).toFixed(2);
  const merged = existingData.messages;
  console.log(` Saved: ${merged.length} total messages → telegram_export.json (${sizeMB} MB)`);
  console.log(`   Added ${newMessages.length} new messages from "${channelName}"\n`);
  console.log(' NEXT STEP:');
  console.log('   Open: http://localhost:3000/admin/bulk-import.html');
  console.log('   Upload the updated telegram_export.json to import new content!\n');
})();
