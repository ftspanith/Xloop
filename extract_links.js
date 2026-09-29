// ═══════════════════════════════════════════════════════════════════════════
// extract_links.js  ─ v6 MULTI-HOST SLOTS
// Reads telegram_export.json → produces links_for_bypasser.json
//
// Key intelligence:
//  • Per-message slot dedup: same file = same slot, keep ALL good hosts
//    (GDFlix + DTFlix/FilePress for same file are BOTH stored)
//  • Host priority: GDFlix > HubCloud > FilePress > DTFlix > TMBCloud > Direct
//  • URL quality check: rejects CDN paths, image paths, HLS streams
//  • Global URL dedup: same URL across channels → keep first
//  • Junk title guard: messages with bad/empty titles are skipped
// ═══════════════════════════════════════════════════════════════════════════
'use strict';

const fs   = require('fs');
const path = require('path');
const { parseMessageBlock, classifyUrl, isJunkTitle } = require('./utils/parser');

const isVercel = !!process.env.VERCEL;
const getPath = (file) => isVercel ? path.join('/tmp', file) : path.join(__dirname, file);

const EXPORT_FILE       = isVercel ? path.join('/tmp', 'telegram_export.json') : path.join(__dirname, 'telegram_export.json');
const OUTPUT_FILE       = getPath('links_for_bypasser.json');
const MISSING_LANG_FILE = getPath('missing_languages_report.json');
const SHORTLINKS_FILE   = getPath('shortlinks_report.json');
const UNKNOWN_FILE      = getPath('unknown_links_report.json');

if (!fs.existsSync(EXPORT_FILE)) {
  console.error('[ERR]  No telegram_export.json found!');
  process.exit(1);
}

const data     = JSON.parse(fs.readFileSync(EXPORT_FILE, 'utf8'));
const messages = data.messages || [];

console.log(`\n[DIR] Total messages in export: ${messages.length}`);

const extracted    = [];  // direct/known download links
const shortlinks   = [];  // URL shorteners — quarantined
const unknownLinks = [];  // Unknown hosts — flagged
const missingLangs = [];  // Links missing language

let skippedEmpty   = 0;
let skippedJunk    = 0;
let skippedNoUrl   = 0;
let skippedDupSlot = 0;
let skippedCdn     = 0;

// ── Global URL dedup: same URL from multiple channels → keep first ────────────
const seenUrls = new Set();

// ── Host priority for slot ordering (lower index = better / faster) ──────────
// When the same file appears with multiple links, sort by priority; keep ALL.
const HOST_PRIORITY = ['GDFlix','HubCloud','FilePress','DTFlix','TMBCloud','Direct','Download'];
const MAX_HOSTS_PER_SLOT = 3; // store up to 3 different hosts for the same file
function hostRank(h) {
  const i = HOST_PRIORITY.indexOf(h);
  return i === -1 ? 99 : i;
}

// ── CDN / non-file URL filter ─────────────────────────────────────────────────
// Reject URLs that look like CDN assets, preview images, HLS streams,
// or hosting pages — NOT actual downloadable file links.
const CDN_JUNK_RE = [
  /\.(m3u8|ts|m4s)(\?|$)/i,           // HLS/DASH stream segments
  /\/index_\d+\.(m3u8|ts)$/i,         // HLS playlist segments
  /\/(image|img|thumbnail|poster|banner|cover|still|screenshot|photos?|pictures?|artwork)\//i,
  /\/(uploads?|wp-content|static|assets?)\//i,  // CMS asset paths
  /cdn\.(hotstar|zee5|sonyliv|etvwin|jiohotstar)/i,
  /vod\d*\./i,                          // VOD CDN subdomain
  /img\d*\./i,                          // image CDN subdomains
  /thumbs?\./i,                         // thumbnail CDN
  /preview\./i,                         // preview CDN
  /akamaized\.net/i,
  /cloudfront\.net/i,
];

// Cloudflare workers ONLY allowed if path ends with a proper file extension
function isJunkUrl(url) {
  if (!url) return true;
  if (/workers\.dev/i.test(url)) {
    return !/\.(mkv|mp4|avi|mov|zip|rar|m2ts|iso|bdmv)([?#]|$)/i.test(url);
  }
  return CDN_JUNK_RE.some(r => r.test(url));
}

// ── Slot key: identifies the same "file variant" regardless of hosting ────────
// Two links with the same slot key = same file; keep only the best host.
// IMPORTANT: Season packs often have NO file size. In that case, use the
// filename as the primary differentiator instead of falling back to blank.
function slotKey(entry) {
  const q  = (entry.quality  || 'HD').toLowerCase();
  const sz = (entry.size     || '').replace(/\s/g,'').toLowerCase();
  const fn = (entry.filename || '').toLowerCase().trim().slice(0, 80);
  const lg = (entry.language || '').toLowerCase();
  const sn = entry.season  ?? '';
  const ep = entry.episode ?? '';

  // If no size AND no filename → use the URL domain to keep them separate
  // (different pack URLs from different channels should NOT collapse)
  let disambig = '';
  if (!sz && !fn) {
    try {
      disambig = new URL(entry.url).hostname.replace('www.', '');
    } catch {
      disambig = entry.url.slice(0, 40);
    }
  }

  // Season packs with no size but same filename = same pack, keep best host
  // Season packs with no size AND no filename = treat as separate (don't merge)
  return `${q}|${sz}|${fn}|${lg}|${sn}|${ep}|${disambig}`;
}


for (const msg of messages) {
  // ── Reconstruct raw text from Telegram's mixed format ────────────────────
  let rawText = '';
  if (typeof msg.text === 'string') {
    rawText = msg.text;
  } else if (Array.isArray(msg.text)) {
    rawText = msg.text.map(part => {
      if (typeof part === 'string') return part;
      if (part.type === 'text_link' && part.href) return `${part.text}\n${part.href}\n`;
      return part.text || '';
    }).join('');
  }

  // Capture URLs from inline keyboard buttons too (often hidden links)
  if (msg.reply_markup?.inline_keyboard) {
    for (const row of msg.reply_markup.inline_keyboard) {
      for (const btn of (row || [])) {
        if (btn.url) rawText += `\n${btn.url}`;
      }
    }
  }

  if (!rawText.trim()) { skippedEmpty++; continue; }

  const parsed = parseMessageBlock(rawText, msg.id);
  if (!parsed)                                          { skippedJunk++;  continue; }
  if (!parsed.downloads || parsed.downloads.length === 0) { skippedNoUrl++; continue; }

  // Hard guard: if the extracted title looks like metadata, skip the whole message
  if (!parsed.title || isJunkTitle(parsed.title)) { skippedJunk++; continue; }

  // ── Per-message slot map: slotKey → array of entries (one per host) ─────
  // For the same file, we keep entries from DIFFERENT hosts (GDFlix + DTFlix).
  // Within the same host-type, only the first seen is kept (URL-level dedup).
  const msgSlots = new Map(); // slotKey → [ entry, ... ]

  for (const dl of parsed.downloads) {
    const finalLanguage = dl.language || parsed.language || '';

    const hasMetadata = dl.size || dl.filename || finalLanguage || dl.season !== null || parsed.title;
    if (!hasMetadata) continue;

    for (const link of dl.links) {
      const normalizedUrl = link.url.replace(/^http:\/\//i, 'https://').replace(/\/$/, '');

      // ── CDN / junk URL filter ──────────────────────────────────────────
      if (isJunkUrl(normalizedUrl)) { skippedCdn++; continue; }

      // ── Global URL dedup ──────────────────────────────────────────────
      if (seenUrls.has(normalizedUrl)) continue;

      const urlType = classifyUrl(normalizedUrl);
      if (urlType === 'Ignore') continue;
      if (urlType === 'Paste')  continue;

      const entry = {
        messageId:   parsed.messageId,
        channelId:   msg.channel_id || msg.peer_id?.channel_id || null,
        title:       parsed.title,
        year:        parsed.year,
        contentType: parsed.contentType,
        isSeries:    parsed.isSeries,
        season:      dl.season   ?? parsed.season,
        episode:     dl.episode  ?? parsed.episode,
        language:    finalLanguage,
        quality:     dl.quality,
        size:        dl.size,
        filename:    dl.filename,
        hdr:         dl.hdr   || null,
        codec:       dl.codec || null,
        host:        urlType,
        url:         normalizedUrl,
        bypassedUrl: null,
        isFast:      /gdflix|hubcloud|gdlink|tmbcloud|fpgo|filebee|extralink|neolinks/i.test(normalizedUrl),
        // [OK] ID hints for direct TMDB/IMDB lookup — avoids fuzzy search misses
        imdbId:      parsed.imdbId      || null,
        tmdbIdHint:  parsed.tmdbIdHint  || null,
        date:        msg.date || null,
      };

      // ── Route shortlinks to quarantine ──────────────────────────────────
      if (urlType === 'Shortlink') {
        shortlinks.push(entry);
        seenUrls.add(normalizedUrl);
        continue;
      }

      // ── Per-message multi-host slot dedup ────────────────────────────────
      // For the same file slot (quality+size+filename), keep up to MAX_HOSTS_PER_SLOT
      // entries from DIFFERENT host types. Same host → keep only first (URL dedup).
      const sk = slotKey(entry);
      if (msgSlots.has(sk)) {
        const slotEntries = msgSlots.get(sk);
        const alreadyHasHost = slotEntries.some(e => e.host === urlType);
        if (alreadyHasHost) {
          skippedDupSlot++; // same host type already stored
        } else if (slotEntries.length < MAX_HOSTS_PER_SLOT) {
          slotEntries.push(entry); // add as alternate host
        } else {
          skippedDupSlot++; // cap reached
        }
      } else {
        msgSlots.set(sk, [entry]);
      }
    }
  }

  // ── Commit slot entries to extracted ─────────────────────────────────────
  for (const slotEntries of msgSlots.values()) {
    // Sort slot entries by host priority so GDFlix comes first
    slotEntries.sort((a, b) => hostRank(a.host) - hostRank(b.host));
    for (const entry of slotEntries) {
      seenUrls.add(entry.url);

      if (entry.host === 'Download') {
        unknownLinks.push(entry);
      }

      extracted.push(entry);

      if (!entry.language) {
        missingLangs.push({
          messageId: entry.messageId,
          title:     entry.title,
          filename:  entry.filename,
          url:       entry.url,
          host:      entry.host,
        });
      }
    }
  }
}

// ── Write all output files ────────────────────────────────────────────────────
fs.writeFileSync(OUTPUT_FILE,       JSON.stringify(extracted,    null, 2));
fs.writeFileSync(MISSING_LANG_FILE, JSON.stringify(missingLangs, null, 2));
fs.writeFileSync(SHORTLINKS_FILE,   JSON.stringify(shortlinks,   null, 2));
fs.writeFileSync(UNKNOWN_FILE,      JSON.stringify(unknownLinks,  null, 2));

// ── Stats breakdown by host ───────────────────────────────────────────────────
const byHost = {};
for (const e of extracted) {
  byHost[e.host] = (byHost[e.host] || 0) + 1;
}

const movies = extracted.filter(e => !e.isSeries);
const packs  = extracted.filter(e =>  e.isSeries && !e.episode);
const eps    = extracted.filter(e =>  e.isSeries &&  e.episode);

console.log(`\n[OK]  Extracted ${extracted.length} direct download links`);
console.log(`    [MOVIE] Movies       : ${movies.length}`);
console.log(`    [PACK] Season Packs : ${packs.length}`);
console.log(`    [FILM]  Episodes     : ${eps.length}`);
console.log(`\n[SCRAPE] By host:`);
Object.entries(byHost).sort((a,b)=>b[1]-a[1]).forEach(([h,c]) => console.log(`    ${h.padEnd(12)}: ${c}`));
console.log(`\n[SKIP]  Skipped: ${skippedEmpty} empty | ${skippedJunk} junk | ${skippedNoUrl} no-url`);
console.log(`[SKIP] CDN/junk URLs  : ${skippedCdn}`);
console.log(`[SORT] Slot deduped   : ${skippedDupSlot} (same file, kept best host)`);
console.log(`[WARN]  Missing language  : ${missingLangs.length}`);
console.log(`[LINK] Shortlinks (bypass): ${shortlinks.length}`);
console.log(`[?] Unknown hosts      : ${unknownLinks.length} → unknown_links_report.json`);
console.log(`\n[FILE] Output → links_for_bypasser.json\n`);
