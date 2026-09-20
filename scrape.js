/**
 * Xloop — Universal Telegram Scraper
 * Run: node scrape.js
 *
 * Modes:
 *   1. Full Scrape       — Scrape entire history of ALL channels from day 1
 *   2. Select Channels   — Pick specific channel IDs to scrape fully
 *   3. Daily History     — Only last N days (select channels or all)
 *   4. New Messages Only — Only fetch messages newer than what's in telegram_export.json
 */

const { TelegramClient } = require('telegram');
const { StringSession }  = require('telegram/sessions');
const { Api }            = require('telegram');
const input              = require('input');
const fs                 = require('fs');
require('dotenv').config();

// ── ALL CHANNEL IDs ─────────────────────────────────────────
const ALL_CHANNEL_IDS = [
  2121685058,
  1460307412,
  3854487392,
  3649684713,
  2676653332,
  4234578006,
  3619204173,
  2785355990,
  3374719986,
  2271910467,
  3927502894,
  3354192797,
  3579217190,
  3952255152,
  2640824484,
  4355201143,
  2252012526,
  4372491493,
  3881216988,
  4430701213,
];

// ────────────────────────────────────────────────────────────

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function box(lines) {
  const width = 52;
  console.log('\n╔' + '═'.repeat(width) + '╗');
  for (const l of lines) {
    const pad = width - l.length;
    const lp  = Math.floor(pad / 2);
    const rp  = pad - lp;
    console.log('║' + ' '.repeat(lp) + l + ' '.repeat(rp) + '║');
  }
  console.log('╚' + '═'.repeat(width) + '╝\n');
}

// ── Interactive Channel Picker ───────────────────────────────
async function pickChannels() {
  console.log('\n Available Channels:\n');
  ALL_CHANNEL_IDS.forEach((id, i) => {
    console.log(`  ${String(i + 1).padStart(2, ' ')}. ${id}`);
  });
  console.log('\n  Enter numbers separated by commas (e.g. 1,3,5)');
  console.log('  Or type "all" to select everything\n');
  const raw = await input.text('Your selection: ');
  if (raw.trim().toLowerCase() === 'all') return [...ALL_CHANNEL_IDS];
  const chosen = raw.split(',').map(s => parseInt(s.trim()) - 1).filter(i => i >= 0 && i < ALL_CHANNEL_IDS.length);
  if (chosen.length === 0) { console.log('  No valid selection. Aborting.'); process.exit(1); }
  return chosen.map(i => ALL_CHANNEL_IDS[i]);
}

// ── Core message fetcher ─────────────────────────────────────
async function scrapeChannel(client, channelId, { minId = 0, minDate = 0 } = {}) {
  const peer      = `-100${channelId}`;
  const batchSize = 100;
  let channelName = `channel_${channelId}`;
  let count       = 0;
  let collected   = 0;
  let offsetId    = 0;
  const msgs_out  = [];

  try {
    try {
      const entity = await client.getEntity(peer);
      channelName  = entity.title || entity.username || channelName;
      console.log(`   Name: ${channelName}`);
    } catch (_) {
      console.log(`   Could not resolve name, using ID: ${channelId}`);
    }

    while (true) {
      const result = await client.invoke(
        new Api.messages.GetHistory({
          peer:       peer,
          offsetId:   offsetId,
          offsetDate: 0,
          addOffset:  0,
          limit:      batchSize,
          maxId:      0,
          minId:      minId,       // stop before already-seen messages
          hash:       BigInt(0),
        })
      );

      const msgs = result.messages;
      if (!msgs || msgs.length === 0) break;

      let hitOld = false;
      for (const msg of msgs) {
        // Date filter for daily mode
        if (minDate > 0 && msg.date < minDate) { hitOld = true; break; }

        count++;
        let text = msg.message || '';
        if (msg.entities) {
          for (const ent of msg.entities) {
            if (ent.url) text += `\n${ent.url}`;
          }
        }
        if (text.trim().length < 10) continue;

        msgs_out.push({
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
      process.stdout.write(`\r   Scanned ${count} msgs, collected ${collected} text entries...`);

      if (hitOld || msgs.length < batchSize) break;
      await sleep(400);
    }
  } catch (err) {
    console.log(`\n    Error: ${err.message}. Skipping channel.`);
  }

  console.log(`\n    Done: ${count} scanned → ${collected} collected`);
  return msgs_out;
}

// ── Save / Merge output ──────────────────────────────────────
function saveOutput(newMessages, mode) {
  const outputFile = 'telegram_export.json';

  let existing = { messages: [] };
  if (mode === 'new' && fs.existsSync(outputFile)) {
    try { existing = JSON.parse(fs.readFileSync(outputFile, 'utf8')); } catch (_) {}
  }

  const merged     = [...(existing.messages || []), ...newMessages];
  const exportData = {
    exported_at:              new Date().toISOString(),
    scrape_mode:              mode,
    total_messages_collected: merged.length,
    messages:                 merged,
  };

  fs.writeFileSync(outputFile, JSON.stringify(exportData, null, 2));
  const mb = (fs.statSync(outputFile).size / 1024 / 1024).toFixed(2);

  box(['SCRAPE COMPLETE! ']);
  console.log(`   Messages collected : ${newMessages.length}`);
  console.log(`   Total in file      : ${merged.length}`);
  console.log(`   File size          : ${mb} MB`);
  console.log(`   Saved to           : ${process.cwd()}/${outputFile}`);
  console.log(`\n NEXT STEP:`);
  console.log(`   Open: http://localhost:3000/admin/bulk-import.html`);
  console.log(`   Upload telegram_export.json → Start Import\n`);
}

// ── MAIN ─────────────────────────────────────────────────────
(async () => {
  box(['XLOOP — Universal Telegram Scraper', 'v2.0 — 4 Modes Available']);

  console.log('  Select scrape mode:\n');
  console.log('  [1] Full Scrape       — All channels, from the very beginning');
  console.log('  [2] Select Channels   — Choose specific channels to scrape fully');
  console.log('  [3] Daily History     — Last N days only (all or selected channels)');
  console.log('  [4] New Messages Only — Only fetch messages newer than existing export\n');

  const modeInput = await input.text('Enter mode (1-4): ');
  const mode      = parseInt(modeInput.trim());

  if (mode < 1 || mode > 4 || isNaN(mode)) {
    console.log(' Invalid mode. Please enter 1, 2, 3, or 4.'); process.exit(1);
  }

  // ── API Credentials ──────────────────────────────────────
  let apiId, apiHash;
  if (process.env.TG_API_ID && process.env.TG_API_HASH) {
    apiId   = parseInt(process.env.TG_API_ID);
    apiHash = process.env.TG_API_HASH;
    console.log('\n Loaded API credentials from .env\n');
  } else {
    console.log('\nGet API creds from: https://my.telegram.org → API Development Tools\n');
    apiId   = parseInt(await input.text('Enter your API ID: '));
    apiHash = await input.text('Enter your API Hash: ');
  }

  const session = new StringSession(process.env.TG_SESSION || '');
  const client  = new TelegramClient(session, apiId, apiHash, {
    connectionRetries: 5, retryDelay: 2000,
  });

  console.log('\n Connecting to Telegram...');
  await client.start({
    phoneNumber: async () => {
      console.log('\nEnter your phone number with country code (e.g. +919876543210)');
      return await input.text('Phone: ');
    },
    password:  async () => await input.text('2FA Password (press Enter if none): ') || '',
    phoneCode: async () => await input.text('OTP code sent to your Telegram: '),
    onError:   (err)  => console.error('Auth Error:', err.message),
  });

  console.log('\n Logged in successfully!');

  // ── Save session to .env ─────────────────────────────────
  const savedSession   = client.session.save();
  let envContent       = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
  const updateEnvVar   = (c, k, v) =>
    c.includes(`${k}=`) ? c.replace(new RegExp(`${k}=.*`), `${k}=${v}`) : c + `\n${k}=${v}`;

  envContent = updateEnvVar(envContent, 'TG_SESSION', savedSession);
  envContent = updateEnvVar(envContent, 'TG_API_ID',  apiId);
  envContent = updateEnvVar(envContent, 'TG_API_HASH', apiHash);
  fs.writeFileSync('.env', envContent.trim() + '\n');
  console.log(' Session saved to .env (no OTP needed next time)\n');

  // ── Determine channels and params based on mode ──────────
  let targetChannels = [];
  let minDate        = 0;
  let minIdMap       = {};  // channelId → minId for mode 4
  let modeLabel      = '';

  if (mode === 1) {
    // ─── MODE 1: Full Scrape — all channels from beginning ───
    modeLabel      = 'full';
    targetChannels = [...ALL_CHANNEL_IDS];
    console.log(`\n Mode 1: Full Scrape — ${targetChannels.length} channels from beginning\n`);

  } else if (mode === 2) {
    // ─── MODE 2: Select Channels ─────────────────────────────
    modeLabel      = 'selective';
    targetChannels = await pickChannels();
    console.log(`\n Mode 2: Selective Scrape — ${targetChannels.length} channels selected\n`);

  } else if (mode === 3) {
    // ─── MODE 3: Daily History (last N days) ─────────────────
    modeLabel = 'daily';
    const daysInput = await input.text('How many days back to scrape? (e.g. 1, 3, 7): ');
    const days      = parseInt(daysInput.trim()) || 1;
    minDate         = Math.floor(Date.now() / 1000) - days * 86400;

    const chanChoice = await input.text('Scrape [A]ll channels or [S]elect specific? (A/S): ');
    if (chanChoice.trim().toUpperCase() === 'S') {
      targetChannels = await pickChannels();
    } else {
      targetChannels = [...ALL_CHANNEL_IDS];
    }

    console.log(`\n Mode 3: Daily — last ${days} day(s), ${targetChannels.length} channels\n`);

  } else if (mode === 4) {
    // ─── MODE 4: New Messages Only ────────────────────────────
    modeLabel = 'new';
    const exportFile = 'telegram_export.json';

    if (!fs.existsSync(exportFile)) {
      console.log('  No existing telegram_export.json found. Running full scrape instead.\n');
      targetChannels = [...ALL_CHANNEL_IDS];
      modeLabel = 'full';
    } else {
      const existing = JSON.parse(fs.readFileSync(exportFile, 'utf8'));
      const msgs     = existing.messages || [];

      // Build a maxId map per channel
      for (const m of msgs) {
        if (!minIdMap[m.channel_id] || m.id > minIdMap[m.channel_id]) {
          minIdMap[m.channel_id] = m.id;
        }
      }

      const chanChoice = await input.text('Scrape [A]ll channels or [S]elect specific? (A/S): ');
      if (chanChoice.trim().toUpperCase() === 'S') {
        targetChannels = await pickChannels();
      } else {
        targetChannels = [...ALL_CHANNEL_IDS];
      }

      console.log(`\n Mode 4: New Messages Only — ${targetChannels.length} channels`);
      console.log('   Will only fetch messages newer than existing export\n');
    }
  }

  // ── Run the scrape ────────────────────────────────────────
  const allNewMessages = [];

  for (let ci = 0; ci < targetChannels.length; ci++) {
    const channelId = targetChannels[ci];
    console.log(`\n[${ci + 1}/${targetChannels.length}]  Scraping channel: ${channelId}`);

    const opts = {
      minDate: minDate,
      minId:   minIdMap[channelId] || 0,
    };

    const msgs = await scrapeChannel(client, channelId, opts);
    allNewMessages.push(...msgs);

    if (ci < targetChannels.length - 1) {
      console.log('   Waiting 2s before next channel...');
      await sleep(2000);
    }
  }

  saveOutput(allNewMessages, modeLabel);
  await client.disconnect();
  process.exit(0);
})();
