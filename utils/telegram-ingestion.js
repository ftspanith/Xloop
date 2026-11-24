'use strict';
const {
  parseMessageBlock, classifyUrl, isJunkTitle, isGenericTitleCandidate,
  cleanTitleForApi, normalizeGdflixUrl, isKnownProviderHost,
} = require('./parser');

const HOST_PRIORITY = ['GDFlix', 'HubCloud', 'TMBCloud'];

// Only the three approved provider families are retained. The parser resolves
// provider identity from the registrable host label, so new subdomains and TLD
// rotations do not need a code change while unrelated hosts remain rejected.
function isAllowedTelegramDownloadUrl(value) {
  let parsed;
  try { parsed = new URL(String(value || '').trim()); }
  catch (_) { return false; }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;
  const category = classifyUrl(parsed.toString());
  return ['GDFlix', 'HubCloud', 'TMBCloud'].includes(category) &&
    isKnownProviderHost(parsed.hostname);
}
const CDN_RE = [
  /\.(m3u8|ts|m4s)(\?|$)/i, /\/(image|img|thumbnail|poster|banner|cover)\//i,
  /\/(uploads?|wp-content|static|assets?)\//i, /cdn\.(hotstar|zee5|sonyliv)/i,
  /vod\d*\./i, /img\d*\./i, /thumbs?\./i, /akamaized\.net/i, /cloudfront\.net/i,
];

function normalizeTelegramUrl(value) {
  const raw = String(value || '').trim().replace(/^http:\/\//i, 'https://');
  if (!raw) return '';
  try {
    const parsed = new URL(raw);
    parsed.pathname = parsed.pathname.replace(/\/+$/, '');
    return normalizeGdflixUrl(parsed.toString());
  } catch (_) { return raw.replace(/\/$/, ''); }
}

function isJunkTelegramUrl(value) {
  const url = String(value || '');
  if (!url) return true;
  if (/workers\.dev/i.test(url)) return !/\.(mkv|mp4|avi|zip|rar)([?#]|$)/i.test(url);
  return CDN_RE.some((pattern) => pattern.test(url));
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

function slotKey(entry) {
  return [
    String(entry.quality || 'HD').toLowerCase(),
    String(entry.size || '').replace(/\s/g, '').toLowerCase(),
    String(entry.filename || '').toLowerCase().trim().slice(0, 120),
    String(entry.language || '').toLowerCase(),
    entry.season == null ? '' : entry.season,
    entry.episode == null ? '' : entry.episode,
  ].join('|');
}

function extractTelegramLinks(inputMessages, account = '1') {
  const rawMessages = Array.isArray(inputMessages) ? inputMessages : [];
  const messages = dedupeTelegramMessages(rawMessages);
  const seenUrls = new Set();
  const links = [];
  let skipped = 0;
  let parsedMessages = 0;
  let rejectedLinks = 0;

  for (const message of messages) {
    const rawText = telegramMessageText(message);
    if (!rawText) { skipped++; continue; }
    let parsed;
    try { parsed = parseMessageBlock(rawText, message.id, message.date || null); }
    catch (_) { skipped++; continue; }
    if (!parsed || !Array.isArray(parsed.downloads) || !parsed.downloads.length) {
      skipped++;
      continue;
    }

    // A channel title line can be absent or noisy while a clean release title
    // is still recoverable from the raw title / individual filenames.
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
    const recoveredTitle = recoveredTitleMatch.title;
    parsed.title = recoveredTitle;
    // When the original heading cleans down to a generic word such as "Movie",
    // retain the descriptive filename as the title/search source instead.
    const cleanedRawTitle = cleanTitleForApi(parsed.rawTitle, parsed.year);
    const resolvedRawTitle = isGenericTitleCandidate(cleanedRawTitle)
      ? recoveredTitleMatch.source
      : (parsed.rawTitle || recoveredTitle);
    parsedMessages++;
    const singleFileRelease = parsed.downloads.length === 1 ? parsed.releaseType : '';

    const slots = new Map();
    for (const download of parsed.downloads) {
      const language = download.language || parsed.language || '';
      for (const link of (download.links || [])) {
        const url = normalizeTelegramUrl(link && link.url);
        if (!url || isJunkTelegramUrl(url) || seenUrls.has(url)) continue;
        const host = classifyUrl(url);
        if (!isAllowedTelegramDownloadUrl(url)) {
          rejectedLinks++;
          continue;
        }
        const entry = {
          messageId: parsed.messageId, title: parsed.title, rawTitle: resolvedRawTitle,
          year: parsed.year == null ? null : parsed.year,
          type: parsed.type || (parsed.contentType === 'anime' ? 'anime' : parsed.isSeries ? 'series' : 'movie'),
          contentType: parsed.contentType || '', isSeries: !!parsed.isSeries,
          season: download.season == null ? parsed.season : download.season,
          episode: download.episode == null ? parsed.episode : download.episode,
          fileYear: download.fileYear || null,
          language, quality: download.quality || parsed.quality || 'HD',
          size: download.size || '', filename: download.filename || '',
          codec: download.codec || '', hdr: download.hdr || '', audio: download.audio || '',
          source: download.source || '', container: download.container || '',
          bitDepth: download.bitDepth || '', audioChannels: download.audioChannels || '',
          audioTracks: Array.isArray(download.audioTracks) && download.audioTracks.length >= 2 ? download.audioTracks : [],
          isRepack: !!download.isRepack || singleFileRelease === 'Repack',
          releaseType: download.releaseType || singleFileRelease || 'Original',
          isIMAX: !!download.isIMAX || !!parsed.isIMAX,
          aspectRatio: download.aspectRatio || parsed.aspectRatio || '',
          languageType: download.languageType || parsed.languageType || '',
          languageCount: download.languageCount ?? parsed.languageCount ?? 0,
          runtimeMinutes: parsed.runtimeMinutes ?? null, duration: parsed.duration || '',
          certification: parsed.certification || '',
          host, url, bypassedUrl: null,
          sourceAccount: String(message.sourceAccount || account || '1'),
          isFast: /gdflix|hubcloud|gdlink|tmbcloud|fpgo|filebee/i.test(url),
          imdbId: parsed.imdbId || null, tmdbIdHint: parsed.tmdbIdHint || null,
          date: message.date || message.date_unixtime || null,
        };
        const key = String(message.channel_id || '0') + ':' + String(message.id);
        if (!slots.has(key)) slots.set(key, []);
        slots.get(key).push(entry);
      }
    }
    for (const slot of slots.values()) {
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

  return {
    messages, links,
    stats: {
      rawMessages: rawMessages.length, uniqueMessages: messages.length,
      duplicateMessages: rawMessages.length - messages.length,
      parsedMessages, skippedMessages: skipped, extractedLinks: links.length, rejectedLinks,
    },
  };
}

module.exports = {
  extractTelegramLinks, dedupeTelegramMessages, normalizeTelegramUrl,
  isJunkTelegramUrl, telegramMessageText, isAllowedTelegramDownloadUrl,
};
