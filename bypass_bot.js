// ============================================================
// Your Own Telegram Bypass Bot - softurl.in / gdflix / etc.
// Just like @Nick_Bypass_Bot but yours!
// ============================================================

require('dotenv').config();
const axios = require('axios');
const { wrapper } = require('axios-cookiejar-support');
const { CookieJar } = require('tough-cookie');

const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_NAME  = '@Xloop_bypass_bot';

// Known download host pattern - ONLY accept these as valid bypassed URLs
const DIRECT_HOST = /gdflix|hubcloud|drive\.google|gofile|terabox|mega\.nz|1fichier|filemoon|streamtape|pixeldrain|krakenfiles/i;

const TG_API = `https://api.telegram.org/bot${BOT_TOKEN}`;

// ── Telegram API helpers ──────────────────────────────────────
async function sendMessage(chatId, text, opts = {}) {
  return axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
    ...opts
  }).catch(() => {});
}

async function editMessage(chatId, msgId, text) {
  return axios.post(`${TG_API}/editMessageText`, {
    chat_id: chatId,
    message_id: msgId,
    text,
    parse_mode: 'HTML',
    disable_web_page_preview: true,
  }).catch(() => {});
}

// ── softurl.in bypass chain (with cookie jar for session tracking) ────
async function bypassSofturl(url) {
  // Each bypass attempt gets its own cookie jar to simulate a real browser session
  const jar = new CookieJar();
  const client = wrapper(axios.create({ jar, withCredentials: true }));

  const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';
  const hdrs = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.5',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Upgrade-Insecure-Requests': '1',
  };

  const post = (u, body, ref) => client.post(u, body, {
    headers: { ...hdrs, 'Content-Type': 'application/x-www-form-urlencoded', 'Referer': ref || u },
    timeout: 25000, maxRedirects: 3
  });
  const get = (u, ref) => client.get(u, {
    headers: { ...hdrs, 'Referer': ref || u },
    timeout: 25000, maxRedirects: 5
  });
  const ex = (html, re) => html.match(re)?.[1] || null;

  // Step 1
  const r1  = await get(url);
  const go1 = ex(r1.data, /name="go"\s+value="([^"]+)"/);
  const a1  = ex(r1.data, /action="([^"]+)"/);
  if (!go1 || !a1) throw new Error('Step 1 failed: no go/action found');

  // Step 2
  const r2  = await post(a1, `go=${encodeURIComponent(go1)}`, url);
  const wp2 = ex(r2.data, /name="newwpsafelink"\s+value="([^"]+)"/);
  const a2  = ex(r2.data, /id="landing"[^>]*action="([^"]+)"/) || a1;
  if (!wp2) throw new Error('Step 2 failed: no newwpsafelink found');

  // Step 3
  const r3  = await post(a2, `humanverification=1&newwpsafelink=${encodeURIComponent(wp2)}`, a1);
  const wp3 = ex(r3.data, /name="newwpsafelink"\s+value="([^"]+)"/) || wp2;
  const j3  = JSON.parse(Buffer.from(wp3, 'base64').toString());
  if (!j3.linkr) throw new Error('Step 3 failed: no linkr in JSON');

  // Step 4
  const r4  = await get(j3.linkr, a2);
  const go4 = ex(r4.data, /name="go"\s+value="([^"]+)"/);
  const a4  = ex(r4.data, /action="([^"]+)"/);
  if (!go4 || !a4) throw new Error('Step 4 failed: no go/action found');

  // Step 5
  const r5  = await post(a4, `go=${encodeURIComponent(go4)}`, j3.linkr);
  const wp5 = ex(r5.data, /name="newwpsafelink"\s+value="([^"]+)"/);
  const a5  = ex(r5.data, /id="landing"[^>]*action="([^"]+)"/) || a4;
  if (!wp5) throw new Error('Step 5 failed: no newwpsafelink found');

  // Step 6
  const r6  = await post(a5, `humanverification=1&newwpsafelink=${encodeURIComponent(wp5)}`, a4);
  const wp6 = ex(r6.data, /name="newwpsafelink"\s+value="([^"]+)"/) || wp5;
  const j6  = JSON.parse(Buffer.from(wp6, 'base64').toString());
  const delay = parseInt(j6.delay || '25', 10);
  if (!j6.linkr) throw new Error('Step 6 failed: no linkr in JSON');

  // Server-enforced timer (wait required by softurl)
  await new Promise(r => setTimeout(r, (delay + 3) * 1000));

  // Step 7 - after timer, get the final ad page
  const r7  = await get(j6.linkr, a5);

  let ad, csrf, tf, ga, refForFinal;

  ad   = ex(r7.data, /name="ad_form_data"\s+value="([^"]+)"/);
  csrf = ex(r7.data, /name="_csrfToken"[^>]+value="([^"]+)"/);
  tf   = ex(r7.data, /name="_Token\[fields\]"[^>]*value="([^"]+)"/);
  ga   = ex(r7.data, /id="go-link"[^>]*action="([^"]+)"/) || '/links/go';
  refForFinal = j6.linkr;

  // If ad_form_data not in step 7, there's another intermediate step
  if (!ad) {
    const go7 = ex(r7.data, /name="go"\s+value="([^"]+)"/);
    const a7  = ex(r7.data, /action="([^"]+)"/);
    if (!go7 || !a7) throw new Error('Step 7 failed: no go/action and no ad_form_data');
    const r8 = await post(a7, `go=${encodeURIComponent(go7)}`, j6.linkr);
    ad   = ex(r8.data, /name="ad_form_data"\s+value="([^"]+)"/);
    csrf = ex(r8.data, /name="_csrfToken"[^>]+value="([^"]+)"/);
    tf   = ex(r8.data, /name="_Token\[fields\]"[^>]*value="([^"]+)"/);
    ga   = ex(r8.data, /id="go-link"[^>]*action="([^"]+)"/) || '/links/go';
    refForFinal = a7;
    if (!ad) throw new Error('Step 8 failed: no ad_form_data');
  }

  // Final step - POST to get the download link
  const base = new URL(url).origin;
  const finalAction = ga.startsWith('http') ? ga : base + ga;
  const parts = ['_method=POST'];
  if (csrf) parts.push(`_csrfToken=${encodeURIComponent(csrf)}`);
  parts.push(`ad_form_data=${encodeURIComponent(ad)}`);
  if (tf) parts.push(`_Token[fields]=${encodeURIComponent(decodeURIComponent(tf))}`);

  const rFinal = await client.post(finalAction, parts.join('&'), {
    headers: {
      ...hdrs,
      'Content-Type': 'application/x-www-form-urlencoded',
      'Referer': refForFinal,
      'X-Requested-With': 'XMLHttpRequest',
    },
    timeout: 25000,
    maxRedirects: 5,  // Follow redirects this time!
    validateStatus: s => s < 500
  });

  // Check redirect location
  const loc = rFinal.headers?.location || rFinal.request?.res?.responseUrl;
  if (loc && DIRECT_HOST.test(loc)) return loc;

  // Check final URL after redirects
  const finalUrl = rFinal.request?.res?.responseUrl;
  if (finalUrl && DIRECT_HOST.test(finalUrl)) return finalUrl;

  // Scan body for download links
  const allHrefs = [...(rFinal.data?.matchAll?.(/href="(https?:\/\/[^"]+)"/g) || [])].map(m => m[1]);
  const directUrl = allHrefs.find(u => DIRECT_HOST.test(u));
  if (directUrl) return directUrl;

  // Check for JSON response with URL
  try {
    const json = typeof rFinal.data === 'string' ? JSON.parse(rFinal.data) : rFinal.data;
    if (json?.url && DIRECT_HOST.test(json.url)) return json.url;
    if (json?.link && DIRECT_HOST.test(json.link)) return json.link;
  } catch(e) {}

  throw new Error(`Could not find download link. Status=${rFinal.status}, URL=${finalUrl || finalAction}`);
}

// ── Generic URL bypass (follow redirects) ────────────────────
async function bypassGeneric(url) {
  const r = await axios.get(url, {
    maxRedirects: 15,
    timeout: 15000,
    headers: { 'User-Agent': 'Mozilla/5.0' }
  });
  return r.request?.res?.responseUrl || url;
}

// ── Main bypass router ────────────────────────────────────────
async function bypass(url) {
  const host = new URL(url).hostname;
  if (host.includes('softurl.in')) return await bypassSofturl(url);
  return await bypassGeneric(url);
}

// ── URL detection ─────────────────────────────────────────────
function extractUrl(text) {
  const match = text.match(/https?:\/\/[^\s]+/);
  return match ? match[0] : null;
}

// ── Long polling bot ──────────────────────────────────────────
let offset = 0;
const activeTasks = new Map(); // chatId → count of active tasks

async function pollUpdates() {
  try {
    const res = await axios.get(`${TG_API}/getUpdates`, {
      params: { offset, timeout: 30, allowed_updates: ['message'] },
      timeout: 35000
    });

    const updates = res.data?.result || [];
    for (const update of updates) {
      offset = update.update_id + 1;
      handleUpdate(update).catch(() => {});
    }
  } catch (e) {
    // Network hiccup — just retry
  }
  setTimeout(pollUpdates, 500);
}

async function handleUpdate(update) {
  const msg = update.message;
  if (!msg?.text) return;

  const chatId = msg.chat.id;
  const text   = msg.text.trim();
  const from   = msg.from?.first_name || 'User';

  // /start command
  if (text === '/start') {
    await sendMessage(chatId,
      `👋 <b>Welcome ${from}!</b>\n\n` +
      `🔗 Send me any <b>shortener link</b> and I'll bypass it for you!\n\n` +
      `<b>Supported:</b>\n` +
      `• softurl.in\n` +
      `• Any redirect shortener\n\n` +
      `<i>Just paste the link below ↓</i>`
    );
    return;
  }

  const url = extractUrl(text);
  if (!url) {
    await sendMessage(chatId, '❌ Please send a valid URL (starting with http:// or https://)');
    return;
  }

  // Limit concurrent tasks per chat
  const active = activeTasks.get(chatId) || 0;
  if (active >= 3) {
    await sendMessage(chatId, '⚠️ You already have 3 links processing. Please wait for them to finish!');
    return;
  }
  activeTasks.set(chatId, active + 1);

  const start = Date.now();
  const processingMsg = await axios.post(`${TG_API}/sendMessage`, {
    chat_id: chatId,
    text: `⏳ <b>Bypassing...</b>\n\n🔗 <code>${url}</code>\n\n<i>Please wait ~30 seconds (ad timer)...</i>`,
    parse_mode: 'HTML',
    disable_web_page_preview: true
  });
  const processingMsgId = processingMsg.data?.result?.message_id;

  try {
    const bypassedUrl = await bypass(url);
    const timeTaken = Math.round((Date.now() - start) / 1000);

    const successText =
      `✅ <b>Bypassed Successfully!</b>\n\n` +
      `📎 <b>Original Link :</b>\n` +
      `<code>${url}</code>\n\n` +
      `🔗 <b>Bypassed Link:</b>\n` +
      `<code>${bypassedUrl}</code>\n\n` +
      `⏱ <b>Time Taken :</b> ${timeTaken} seconds\n\n` +
      `<i>Powered by ${BOT_NAME} 🤖</i>`;

    if (processingMsgId) {
      await editMessage(chatId, processingMsgId, successText);
    } else {
      await sendMessage(chatId, successText);
    }
  } catch (err) {
    const errText =
      `❌ <b>Bypass Failed!</b>\n\n` +
      `🔗 <code>${url}</code>\n\n` +
      `<b>Reason:</b> ${err.message}\n\n` +
      `<i>The link may be expired or protected.</i>`;

    if (processingMsgId) {
      await editMessage(chatId, processingMsgId, errText);
    } else {
      await sendMessage(chatId, errText);
    }
  } finally {
    activeTasks.set(chatId, (activeTasks.get(chatId) || 1) - 1);
  }
}

// ── Start ─────────────────────────────────────────────────────
async function main() {
  const me = await axios.get(`${TG_API}/getMe`);
  const botName = me.data?.result?.username;
  console.log(`\n🤖 Bot started: @${botName}`);
  console.log(`📡 Listening for messages...\n`);
  pollUpdates();
}

main().catch(console.error);
