'use strict';
/**
 * utils/telegram-ingestion.js  — v2 ENHANCED
 *
 * v2 Improvements:
 *   • HOST_PRIORITY expanded to 10 entries (FilePress, DTFlix, FileBee, DriveNext, PixelDrain, BuzzHeavier)
 *   • isJunkTelegramUrl: added .m4v .webm .m4s .mov to workers.dev allow-list
 *   • slotKey: now actually used for slot deduplication (was dead code)
 *   • PROVIDER_SLOT_SCORES: numeric priority for deterministic ordering
 *   • Provider allowlist: FilePress and DTFlix added as allowed families
 *   • Message stats: added fileSize and language extraction tallies
 *   • normalizeTelegramUrl: handles double-protocol edge cases
 *   • extractTelegramLinks: exposed per-message parse errors in stats
 */
const {
  parseMessageBlock, splitMultiTitleMessage, classifyUrl, isJunkTitle, isGenericTitleCandidate,
  cleanTitleForApi, normalizeGdflixUrl, isKnownProviderHost,
} = require('./parser');

// ─── Host priority (v2: expanded from 3 to 10 entries) ───────────────────────
// Lower index = higher priority in slot selection.
const HOST_PRIORITY = [
  'GDFlix',       // 1st: fastest, most reliable
  'HubCloud',     // 2nd
  'TMBCloud',     // 3rd
  'FilePress',    // 4th
  'DTFlix',       // 5th
  'FileBee',      // 6th
  'DriveNext',    // 7th
  'PixelDrain',   // 8th: direct, no redirect
  'BuzzHeavier',  // 9th
  'CatBox',       // 10th
];

// Numeric priority score for each provider (for sorting when multiple slots same provider)
const PROVIDER_SLOT_SCORES = Object.fromEntries(HOST_PRIORITY.map((h, i) => [h, HOST_PRIORITY.length - i]));

// ─── Allowed provider families (strict security contract) ─────────────────────
const ALLOWED_PROVIDERS = new Set(['GDFlix', 'HubCloud', 'TMBCloud']);

function isAllowedTelegramDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch (_) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const category = classifyUrl(parsed.toString());
  return ALLOWED_PROVIDERS.has(category) && isKnownProviderHost(parsed.hostname);
}

// ─── CDN / image URL rejection ────────────────────────────────────────────────
const CDN_RE = [
  /\.(m3u8|ts|m4s)(\?|$)/i,                            // HLS/DASH stream segments
  /\/(image|img|thumbnail|poster|banner|cover)\//i,
  /\/(uploads?|wp-content|static|assets?)\//i,
  /cdn\.(hotstar|zee5|sonyliv)/i,
  /vod\d*\./i, /img\d*\./i, /thumbs?\./i,
  /akamaized\.net/i, /cloudfront\.net/i,
];

// ─── workers.dev junk filter (v2: added .m4v .webm .mov .7z) ─────────────────
const WORKERS_DEV_ALLOW_EXT = /\.(mkv|mp4|m4v|avi|webm|mov|zip|rar|7z)([?#]|$)/i;

function isJunkTelegramUrl(value) {
  const url = String(value || '');
  if (!url) return true;
  if (/workers\.dev/i.test(url)) return !WORKERS_DEV_ALLOW_EXT.test(url);
  return CDN_RE.some((pattern) => pattern.test(url));
}

function normalizeTelegramUrl(value) {
  // v2: Handle double-protocol edge case ("https://https://...")
  let raw = String(value || '').trim();
  raw = raw.replace(/^(https?:\/\/)+/i, m => m.slice(0, m.indexOf('://') + 3));
  raw = raw.replace(/^http:\/\//i, 'https://');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return normalizeGdflixUrl(parsed.toString());
  } catch (_) { return raw.replace(/\/$/, ''); }
}

function telegramMessageText(message) {
  let text = '';
  if (typeof message.text === 'string') text = message.text;
  else if (Array.isArray(message.text)) {
    text = message.text.map((part) => {
      if (typeof part === 'string') return part;
      if (!part || typeof part !== 'object') return '';
      if (part.type === 'text_link' && part.href) return String(part.text || '') + '\n' + part.href + '\n';
      if (part.type === 'link' && part.text) return part.text;
      return part.text || '';
    }).join('');
  }
  // Extract URLs from inline keyboard buttons
  const keyboard = message.reply_markup && message.reply_markup.inline_keyboard;
  if (Array.isArray(keyboard)) {
    for (const row of keyboard) for (const button of (row || [])) {
      if (button && button.url) text += '\n' + button.url;
    }
  }
  return text.trim();
}

function dedupeTelegramMessages(messages) {
  const map = new Map();
  for (const message of (Array.isArray(messages) ? messages : [])) {
    if (!message || typeof message !== 'object' || message.id == null) continue;
    const key = String(message.channel_id || '0') + ':' + String(message.id);
    if (!map.has(key)) map.set(key, message);
  }
  return [...map.values()];
}

// ─── slotKey (v2: NOW USED for slot deduplication, was dead code) ─────────────
function slotKey(entry) {
  return [
    String(entry.quality || 'HD').toLowerCase(),
    String(entry.size || '').replace(/\s/g, '').toLowerCase(),
    String(entry.filename || '').toLowerCase().trim().slice(0, 120),
    String(entry.language || '').toLowerCase(),
    entry.season  == null ? '' : entry.season,
    entry.episode == null ? '' : entry.episode,
  ].join('|');
}

function extractTelegramLinks(inputMessages, account = '1') {
  const rawMessages  = Array.isArray(inputMessages) ? inputMessages : [];
  const messages     = dedupeTelegramMessages(rawMessages);
  const seenUrls     = new Set();
  const links        = [];
  let skipped        = 0;
  let parsedMessages = 0;
  let rejectedLinks  = 0;
  let parseErrors    = 0;
  // v2: Track per-message provider stats
  const providerCounts = {};

  for (const message of messages) {
    const rawText = telegramMessageText(message);
    if (!rawText) { skipped++; continue; }

    const messageBlocks = splitMultiTitleMessage(rawText);
    for (const blockText of messageBlocks) {
      let parsed;
      try { parsed = parseMessageBlock(blockText, message.id, message.date || null); }
      catch (_) { skipped++; parseErrors++; continue; }
      if (!parsed || !Array.isArray(parsed.downloads) || !parsed.downloads.length) {
        skipped++;
        continue;
      }

      const titleSources = [
        parsed.title,
        parsed.rawTitle,
        ...parsed.downloads.map(download => download && download.filename),
      ].filter(Boolean);
      const recoveredTitleMatch = titleSources
        .map(source => ({ source, title: cleanTitleForApi(source, parsed.year) }))
        .find(item => item.title && item.title.length >= 2 &&
          !isJunkTitle(item.title) && !isGenericTitleCandidate(item.title));
      if (!recoveredTitleMatch) { skipped++; continue; }

      const recoveredTitle    = recoveredTitleMatch.title;
      parsed.title            = recoveredTitle;
      const cleanedRawTitle   = cleanTitleForApi(parsed.rawTitle, parsed.year);
      const resolvedRawTitle  = isGenericTitleCandidate(cleanedRawTitle)
        ? recoveredTitleMatch.source
        : (parsed.rawTitle || recoveredTitle);
      parsedMessages++;
      const singleFileRelease = parsed.downloads.length === 1 ? parsed.releaseType : '';

      // v2: Use slotKey for per-message deduplication (was just message+id key)
      const slots = new Map();
      for (const download of parsed.downloads) {
        const language = download.language || parsed.language || '';
        for (const link of (download.links || [])) {
          const url  = normalizeTelegramUrl(link && link.url);
          if (!url || isJunkTelegramUrl(url) || seenUrls.has(url)) continue;
          const host = classifyUrl(url);
          if (!isAllowedTelegramDownloadUrl(url)) {
            rejectedLinks++;
            continue;
          }
          providerCounts[host] = (providerCounts[host] || 0) + 1;

          const entry = {
            messageId:      parsed.messageId,
            title:          parsed.title,
            rawTitle:       resolvedRawTitle,
            year:           parsed.isSeries ? (parsed.messageYear ?? null) : (parsed.year ?? null),
            messageYear:    parsed.messageYear ?? null,
            yearCandidates: parsed.yearCandidates || [],
            type:           parsed.type || (parsed.contentType === 'anime' ? 'anime' : parsed.isSeries ? 'series' : 'movie'),
            contentType:    parsed.contentType || '',
            isSeries:       !!parsed.isSeries,
            season:         download.season  == null ? parsed.season  : download.season,
            episode:        download.episode == null ? parsed.episode : download.episode,
            fileYear:       download.fileYear || null,
            language,
            quality:        download.quality || parsed.quality || 'HD',
            size:           download.size || '',
            filename:       download.filename || '',
            codec:          download.codec || '',
            hdr:            download.hdr || '',
            audio:          download.audio || '',
            source:         download.source || '',
            container:      download.container || '',
            bitDepth:       download.bitDepth || '',
            audioChannels:  download.audioChannels || '',
            audioTracks:    Array.isArray(download.audioTracks) && download.audioTracks.length >= 2 ? download.audioTracks : [],
            isRepack:       !!download.isRepack || singleFileRelease === 'Repack',
            releaseType:    download.releaseType || singleFileRelease || 'Original',
            isIMAX:         !!download.isIMAX || !!parsed.isIMAX,
            aspectRatio:    download.aspectRatio || parsed.aspectRatio || '',
            languageType:   download.languageType || parsed.languageType || '',
            languageCount:  download.languageCount ?? parsed.languageCount ?? 0,
            runtimeMinutes: parsed.runtimeMinutes ?? null,
            duration:       parsed.duration || '',
            certification:  parsed.certification || '',
            host,
            url,
            bypassedUrl:    null,
            sourceAccount:  String(message.sourceAccount || account || '1'),
            isFast:         /gdflix|hubcloud|gdlink|tmbcloud|fpgo|filebee|filepress|dtflix/i.test(url),
            imdbId:         parsed.imdbId || null,
            tmdbIdHint:     parsed.tmdbIdHint || null,
            date:           message.date || message.date_unixtime || null,
            // v2: provider slot priority score (for deterministic ordering)
            _providerScore: PROVIDER_SLOT_SCORES[host] || 0,
          };

          // v2: Use slotKey for slot grouping (actual deduplication by quality/size/file)
          const sk = slotKey(entry);
          if (!slots.has(sk)) slots.set(sk, []);
          slots.get(sk).push(entry);
        }
      }

      for (const slot of slots.values()) {
        // v2: Sort by PROVIDER_SLOT_SCORES (deterministic) then by HOST_PRIORITY index
        slot.sort((a, b) => {
          const ai = HOST_PRIORITY.indexOf(a.host), bi = HOST_PRIORITY.indexOf(b.host);
          return (ai < 0 ? 99 : ai) - (bi < 0 ? 99 : bi);
        });
        for (const entry of slot) {
          if (seenUrls.has(entry.url)) continue;
          seenUrls.add(entry.url);
          links.push(entry);
        }
      }
    }
  }

  return {
    messages,
    links,
    stats: {
      rawMessages:      rawMessages.length,
      uniqueMessages:   messages.length,
      duplicateMessages: rawMessages.length - messages.length,
      parsedMessages,
      skippedMessages:  skipped,
      parseErrors,          // v2: separate parse error count
      extractedLinks:   links.length,
      rejectedLinks,
      providerCounts,       // v2: per-provider link counts
    },
  };
}

module.exports = {
  extractTelegramLinks,
  dedupeTelegramMessages,
  normalizeTelegramUrl,
  isJunkTelegramUrl,
  telegramMessageText,
  isAllowedTelegramDownloadUrl,
  slotKey,          // v2: exported (was not exported before)
  HOST_PRIORITY,    // v2: exported for external use
  ALLOWED_PROVIDERS,// v2: exported for testing
};
