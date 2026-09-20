/**
 * Xloop — Resume Scraper (runs from last known message per channel)
 * Picks up only NEW messages posted AFTER the initial scrape.
 * Run: node scrape_resume.js
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram');
const fs                 = require('fs');
const path               = require('path');
require('dotenv').config();

const EXPORT_FILE  = path.join(__dirname, 'telegram_export.json');
const BATCH_SIZE   = 100;

const apiId      = parseInt(process.env.TG_API_ID);
const apiHash    = process.env.TG_API_HASH;
const sessionStr = process.env.TG_SESSION || '';

async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

(async () => {
  console.log('\n╔══════════════════════════════════════════════╗');
  console.log('║   XLOOP — Resume Scraper (New messages only) ║');
  console.log('╚══════════════════════════════════════════════╝\n');

  // ── Load existing JSON ──────────────────────────────────────────
  if (!fs.existsSync(EXPORT_FILE)) {
    console.error(' telegram_export.json not found. Run scrape.js first.');
    process.exit(1);
  }
  const raw  = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
  const existingMessages = Array.isArray(raw) ? raw : (raw.messages || []);
  console.log(` Loaded ${existingMessages.length} existing messages.`);

  // ── Find highest message ID per channel (we scrape ABOVE this) ─
  const maxIdByChannel = {};
  for (const m of existingMessages) {
    const cid = m.channel_id;
    if (!maxIdByChannel[cid] || m.id > maxIdByChannel[cid]) {
      maxIdByChannel[cid] = m.id;
    }
  }

  // All channels
  const CHANNEL_IDS = [
    2121685058, 1460307412, 3854487392, 3649684713, 2676653332, 4234578006,
    3619204173, 2785355990, 3374719986, 2271910467, 3927502894, 3354192797,
    3579217190, 3952255152, 2640824484, 4355201143, 2252012526, 4372491493, 3881216988
  ];

  console.log('\nMax message IDs found per channel:');
  CHANNEL_IDS.forEach(id => {
    console.log(`  Channel ${id}: maxId = ${maxIdByChannel[id] || 'NEW (not in export)'}`);
  });
  console.log('');

  // ── Connect to Telegram ────────────────────────────────────────
  const client = new TelegramClient(
    new StringSession(sessionStr),
    apiId, apiHash,
    { connectionRetries: 5 }
  );
  await client.start({ phoneNumber: async () => require('input').text('Phone: ') });
  console.log(' Connected to Telegram\n');

  const newMessages = [];
  let grandNew = 0;

  for (let ci = 0; ci < CHANNEL_IDS.length; ci++) {
    const channelId = CHANNEL_IDS[ci];
    const peer      = `-100${channelId}`;
    const minId     = maxIdByChannel[channelId] || 0; // Only fetch ABOVE this

    console.log(`\n[${ci + 1}/${CHANNEL_IDS.length}]  Channel ${channelId} — fetching messages above ID ${minId}`);

    let channelName = `channel_${channelId}`;
    let collected = 0;
    let offsetId  = 0; // Start from latest (newest first)

    try {
      try {
        const entity = await client.getEntity(peer);
        channelName  = entity.title || entity.username || channelName;
        console.log(`   Name: ${channelName}`);
      } catch (e) {
        console.log(`   Could not resolve name.`);
      }

      // Fetch newest messages first; stop when we hit an ID <= minId
      while (true) {
        const result = await client.invoke(
          new Api.messages.GetHistory({
            peer,
            offsetId,
            offsetDate: 0,
            addOffset: 0,
            limit: BATCH_SIZE,
            maxId: 0,
            minId,        // ← Telegram won't return anything at or below this
            hash: BigInt(0),
          })
        );

        const msgs = result.messages;
        if (!msgs || msgs.length === 0) break;

        for (const msg of msgs) {
          if (msg.id <= minId) continue; // Safety guard

          let text = msg.message || '';
          if (msg.entities) {
            for (const ent of msg.entities) {
              if (ent.url) text += `\n${ent.url}`;
            }
          }
          if (text.trim().length < 10) continue;

          newMessages.push({
            id:           msg.id,
            type:         'message',
            channel_id:   channelId,
            channel_name: channelName,
            date:         new Date(msg.date * 1000).toISOString(),
            text:         text.trim()
          });
          collected++;
        }

        offsetId = msgs[msgs.length - 1].id;
        process.stdout.write(`\r   Fetched ${collected} new messages...`);

        if (msgs.length < BATCH_SIZE) break;
        await sleep(350);
      }

      console.log(`\n    ${collected} new messages found`);
      grandNew += collected;

    } catch (err) {
      console.log(`\n    Error on channel ${channelId}: ${err.message}`);
    }

    if (ci < CHANNEL_IDS.length - 1) await sleep(1500);
  }

  await client.disconnect();

  if (newMessages.length === 0) {
    console.log('\n No new messages found. Your export is already up-to-date!');
    process.exit(0);
  }

  // ── Merge and save ─────────────────────────────────────────────
  console.log(`\n\n Merging ${newMessages.length} new messages into export...`);
  const merged = [...existingMessages, ...newMessages];
  // De-duplicate by channel_id + id
  const seen = new Set();
  const deduped = merged.filter(m => {
    const key = `${m.channel_id}:${m.id}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  const output = {
    exported_at:              new Date().toISOString(),
    total_messages_collected: deduped.length,
    messages:                 deduped
  };

  fs.writeFileSync(EXPORT_FILE, JSON.stringify(output, null, 2));
  console.log(` Saved! ${deduped.length} total messages (${newMessages.length} new added).`);
  console.log(`\nNext step: Upload telegram_export.json in the Bulk Import admin page.`);
})();
