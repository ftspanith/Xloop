// ============================================================
// Smart Bypasser using @Nick_Bypass_Bot on Telegram
// ============================================================

require('dotenv').config();
const { TelegramClient } = require('telegram');
const { StringSession } = require('telegram/sessions');
const { NewMessage } = require('telegram/events');
const fs = require('fs');

const LINKS_FILE  = './links_for_bypasser.json';
const OUTPUT_FILE = './bypassed_links.json';
const BOT_USERNAME = 'Nick_Bypass_Bot';
const BATCH_SIZE   = 5;   // Send 5 links at a time to avoid flooding
const TIMEOUT_MS   = 60000; // 60s per link max

const session = new StringSession(process.env.TG_SESSION);
const apiId   = parseInt(process.env.TG_API_ID);
const apiHash = process.env.TG_API_HASH;

// Map original URL -> Promise controls
const waitMap = new Map();

async function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

async function startBypasser() {
  console.log('🚀 Connecting to Telegram...');
  const client = new TelegramClient(session, apiId, apiHash, { connectionRetries: 5 });
  await client.start({});
  console.log('✅ Connected as User!');

  // Setup response listener
  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg || !msg.senderId) return;

    try {
      const sender = await msg.getSender();
      if (sender && sender.username === BOT_USERNAME) {
        const text = msg.message || '';
        if (!text.includes('Bypassed Link:')) return;

        // Extract original URL
        const originalMatch = text.match(/https?:\/\/softurl\.in\/[^\s\n"*]+/);
        // Extract bypassed URL (strip trailing *)
        const bypassedMatch = text.match(/https?:\/\/(?:(?:new3\.)?gdflix|hubcloud|drive\.google|gofile|terabox|mega\.nz|1fichier|filemoon)[^\s\n"*]+/i);

        if (originalMatch && bypassedMatch) {
          const origUrl = originalMatch[0].replace(/\*+$/, '').trim();
          const bypassedUrl = bypassedMatch[0].replace(/\*+$/, '').trim();
          
          const waiter = waitMap.get(origUrl);
          if (waiter) {
            waiter.resolve(bypassedUrl);
            waitMap.delete(origUrl);
          }
        } else if (originalMatch && text.includes('Expired')) {
          const origUrl = originalMatch[0].replace(/\*+$/, '').trim();
          const waiter = waitMap.get(origUrl);
          if (waiter) {
            waiter.resolve('EXPIRED');
            waitMap.delete(origUrl);
          }
        }
      }
    } catch(e) {}
  }, new NewMessage({ incoming: true }));

  // Read links
  let links = [];
  if (fs.existsSync(LINKS_FILE)) {
    links = JSON.parse(fs.readFileSync(LINKS_FILE, 'utf8'));
  }

  let existing = [];
  if (fs.existsSync(OUTPUT_FILE)) {
    existing = JSON.parse(fs.readFileSync(OUTPUT_FILE, 'utf8'));
  }

  // Filter out already processed
  const pending = links.filter(link => !existing.some(e => e.url === link.url));
  console.log(`📦 Loaded ${links.length} total links. ${pending.length} pending bypass.`);

  if (pending.length === 0) {
    console.log('🎉 All links bypassed! Run `npm run import-bypassed` to add to DB.');
    process.exit(0);
  }

  // Process in batches
  for (let i = 0; i < pending.length; i += BATCH_SIZE) {
    const batch = pending.slice(i, i + BATCH_SIZE);
    console.log(`\n🔄 Processing batch ${Math.floor(i/BATCH_SIZE)+1} of ${Math.ceil(pending.length/BATCH_SIZE)}...`);

    const promises = batch.map(async (item) => {
      return new Promise(async (resolve) => {
        waitMap.set(item.url, { resolve });

        // Set timeout
        setTimeout(() => {
          if (waitMap.has(item.url)) {
            console.log(`❌ Timeout for: ${item.url}`);
            waitMap.delete(item.url);
            resolve(null);
          }
        }, TIMEOUT_MS);

        try {
          await client.sendMessage(BOT_USERNAME, { message: item.url });
          console.log(`📨 Sent: ${item.url}`);
        } catch(e) {
          console.log(`⚠️ Send Error for ${item.url}: ${e.message}`);
          waitMap.delete(item.url);
          resolve(null);
        }
      });
    });

    const results = await Promise.all(promises);
    
    // Save successful ones
    let saved = 0;
    for (let j = 0; j < batch.length; j++) {
      if (results[j] && results[j] !== 'EXPIRED') {
        batch[j].bypassedUrl = results[j];
        existing.push(batch[j]);
        saved++;
        console.log(`✅ Success: ${batch[j].url} -> ${results[j]}`);
      }
    }

    if (saved > 0) {
      fs.writeFileSync(OUTPUT_FILE, JSON.stringify(existing, null, 2));
    }
    
    // Random delay between batches
    const waitTime = Math.floor(Math.random() * 3000) + 3000;
    console.log(`⏳ Waiting ${Math.round(waitTime/1000)}s before next batch...`);
    await delay(waitTime);
  }

  console.log('\n🎉 Finished processing pending links!');
  process.exit(0);
}

startBypasser().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
