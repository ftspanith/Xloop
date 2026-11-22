'use strict';

// Telegram message intelligence for Xloop.
// This module is deliberately pure: no Telegram connection, filesystem, or database writes.

const { classifyUrl, parseMessageBlock, parseManualInput } = require('./parser');

const URL_RE = /\bhttps?:\/\/[^\s<>"'`]+/giu;
const TRAILING_URL_PUNCTUATION = /[),.!?;:}\]]+$/;

const PROMOTION_PATTERNS = [
  { key: 'join_channel', re: /\bjoin\s+(?:(?:our|the|this|official|backup)\s+)?(?:telegram\s+)?(?:channel|group|community)\b/i },
  { key: 'join_now', re: /\bjoin\s+(?:now|here|us)\b/i },
  { key: 'subscribe', re: /\bsubscribe\s+(?:(?:to|for)\s+)?(?:(?:our|the|this|official)\s+)?(?:channel|group|updates?|notifications?)\b|\bsubscribe\s+(?:now|here)\b/i },
  { key: 'follow', re: /\bfollow\s+(?:(?:us|our|the)\s+)?(?:channel|group|page|account)\b/i },
  { key: 'backup_channel', re: /\bbackup\s+(?:telegram\s+)?(?:channel|group)\b/i },
  { key: 'share_promotion', re: /\bshare\s+(?:this|our|the)\s+(?:channel|group|page|invite)\b/i },
  { key: 'channel_promotion', re: /\b(?:official|new|second|alternative)\s+(?:telegram\s+)?channel\b/i },
];

const DOWNLOAD_HOSTS = new Set([
  'GDFlix', 'HubCloud', 'FilePress', 'TMBCloud', 'DriveNext',
  'DTFlix', 'FileBee', 'StreamTape', 'MixDrop', 'DoodStream', 'BuzzHeavier',
  'PixelDrain', '1Fichier', 'CatBox', 'Direct',
]);

const DOWNLOAD_CTA_RE = /\b(download|downloads|download\s+link|mirror\s+link|direct\s+link|cloud\s+link|drive\s+link|get\s+file|click\s+to\s+download)\b/i;
const MEDIA_TECH_RE = /\b(4320p|2160p|1440p|1080p|720p|576p|540p|480p|360p|4k|8k|uhd|web[- .]?dl|webrip|bluray|brrip|hdrip|remux|hevc|x265|x264|av1|mkv|mp4|avi|m2ts|eac3|aac|dts|dolby\s+vision|hdr10\+?)\b/i;
const FILE_NAME_RE = /(?:^|[\s"'`])[^\/\\\n]{2,180}\.(?:mkv|mp4|m4v|webm|avi|mov|m2ts|ts|wmv|zip|rar|7z|pdf|mp3|flac|wav)(?:$|[\s?#])/i;
const TELEGRAM_HOST_RE = /(^|\.)((t\.me)|(telegram\.me)|(telegram\.dog))$/i;

function asString(value) {
  if (value == null) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (typeof value.toString === 'function') {
    const rendered = value.toString();
    if (rendered && rendered !== '[object Object]') return rendered;
  }
  return '';
}

function entityType(entity) {
  if (!entity) return 'unknown';
  return entity.className || (entity.constructor && entity.constructor.name) || 'unknown';
}

function safeUrl(value) {
  let url = asString(value).trim();
  if (!url) return '';
  url = url.replace(TRAILING_URL_PUNCTUATION, '');
  if (/^www\./i.test(url) || (!/^[a-z][a-z0-9+.-]*:\/\//i.test(url) && /^(?:[a-z0-9-]+\.)+[a-z]{2,}(?::\d+)?(?:[/?#]|$)/i.test(url))) url = 'https://' + url;
  try {
    const parsed = new URL(url);
    if (!['http:', 'https:', 'tg:'].includes(parsed.protocol)) return '';
    return url;
  } catch (_) {
    return '';
  }
}

function getButtons(replyMarkup) {
  const rows = replyMarkup && Array.isArray(replyMarkup.rows) ? replyMarkup.rows : [];
  const result = [];
  rows.forEach((row, rowIndex) => {
    const buttons = row && Array.isArray(row.buttons) ? row.buttons : [];
    buttons.forEach((button, buttonIndex) => {
      if (!button) return;
      result.push({
        text: asString(button.text),
        url: safeUrl(button.url),
        type: entityType(button),
        row: rowIndex,
        column: buttonIndex,
        action: button.url ? 'url' : (button.data ? 'callback' : 'other'),
      });
    });
  });
  return result;
}

function getEntities(text, entities) {
  if (!Array.isArray(entities)) return [];
  return entities.map(entity => {
    const offset = Number.isFinite(entity.offset) ? entity.offset : null;
    const length = Number.isFinite(entity.length) ? entity.length : null;
    const displayText = offset != null && length != null
      ? text.slice(offset, offset + length)
      : '';
    const type = entityType(entity);
    const entityUrl = safeUrl(entity.url) || (/MessageEntityUrl|MessageEntityTextUrl/i.test(type) ? safeUrl(displayText) : '');
    return {
      type,
      offset,
      length,
      text: displayText,
      url: entityUrl,
    };
  });
}

function extractLinks(text, entities, buttons) {
  const map = new Map();
  function add(rawValue, source, label, row, column, type) {
    const url = safeUrl(rawValue);
    if (!url) return;
    const key = url;
    if (!map.has(key)) {
      let parsed = null;
      try { parsed = new URL(url); } catch (_) {}
      let hostClass = 'Unknown';
      try { hostClass = classifyUrl(url); } catch (_) {}
      map.set(key, {
        url,
        host: parsed ? parsed.hostname.toLowerCase() : '',
        host_class: hostClass,
        sources: [],
        labels: [],
        button_positions: [],
        entity_types: [],
        is_shortlink: hostClass === 'Shortlink',
        purpose: 'unknown',
      });
    }
    const item = map.get(key);
    if (!item.sources.includes(source)) item.sources.push(source);
    if (label && !item.labels.includes(label)) item.labels.push(label);
    if (row != null && column != null) {
      const pos = { row, column };
      if (!item.button_positions.some(p => p.row === row && p.column === column)) item.button_positions.push(pos);
    }
    if (type && !item.entity_types.includes(type)) item.entity_types.push(type);
  }

  let match;
  URL_RE.lastIndex = 0;
  while ((match = URL_RE.exec(text)) !== null) add(match[0], 'message_text', '', null, null, '');

  (Array.isArray(entities) ? entities : []).forEach(entity => {
    if (!entity) return;
    const type = entityType(entity);
    const displayText = Number.isFinite(entity.offset) && Number.isFinite(entity.length)
      ? text.slice(entity.offset, entity.offset + entity.length)
      : '';
    const entityUrl = safeUrl(entity.url) || (/MessageEntityUrl|MessageEntityTextUrl/i.test(type) ? safeUrl(displayText) : '');
    if (entityUrl) add(entityUrl, 'message_entity', displayText, null, null, type);
  });

  (Array.isArray(buttons) ? buttons : []).forEach(button => {
    if (button && button.url) add(button.url, 'inline_button', button.text, button.row, button.column, button.type);
  });

  return Array.from(map.values());
}

function getMediaMetadata(media) {
  if (!media) return null;
  const document = media.document || null;
  const photo = media.photo || null;
  const attrs = document && Array.isArray(document.attributes) ? document.attributes : [];
  const meta = {
    media_type: document ? 'document' : (photo ? 'photo' : entityType(media)),
    file_id: document && document.id != null ? asString(document.id) : (photo && photo.id != null ? asString(photo.id) : null),
    mime_type: document ? asString(document.mimeType) || null : null,
    file_size: document && document.size != null ? asString(document.size) : null,
    file_name: null,
    duration: null,
    width: null,
    height: null,
    title: null,
    performer: null,
    is_video: false,
    is_audio: false,
    is_voice: false,
    is_animation: false,
    is_sticker: false,
    grouped_media_id: media.groupedId != null ? asString(media.groupedId) : null,
  };

  attrs.forEach(attr => {
    const type = entityType(attr);
    if (/DocumentAttributeFilename/i.test(type)) meta.file_name = asString(attr.fileName) || null;
    if (/DocumentAttributeVideo/i.test(type)) {
      meta.is_video = true;
      if (attr.duration != null) meta.duration = Number(attr.duration);
      if (attr.w != null) meta.width = Number(attr.w);
      if (attr.h != null) meta.height = Number(attr.h);
    }
    if (/DocumentAttributeAudio/i.test(type)) {
      meta.is_audio = true;
      meta.is_voice = !!attr.voice;
      if (attr.duration != null) meta.duration = Number(attr.duration);
      meta.title = asString(attr.title) || null;
      meta.performer = asString(attr.performer) || null;
    }
    if (/DocumentAttributeAnimated/i.test(type)) meta.is_animation = true;
    if (/DocumentAttributeSticker/i.test(type)) meta.is_sticker = true;
    if (/DocumentAttributeImageSize/i.test(type)) {
      if (attr.w != null) meta.width = Number(attr.w);
      if (attr.h != null) meta.height = Number(attr.h);
    }
  });

  if (photo && Array.isArray(photo.sizes)) {
    const sizes = photo.sizes.filter(size => size && Number(size.w) > 0 && Number(size.h) > 0);
    sizes.sort((a, b) => (Number(b.w) * Number(b.h)) - (Number(a.w) * Number(a.h)));
    if (sizes[0]) {
      meta.width = Number(sizes[0].w);
      meta.height = Number(sizes[0].h);
    }
  }
  if (document && meta.is_video) meta.media_type = 'video';
  else if (document && meta.is_audio) meta.media_type = meta.is_voice ? 'voice' : 'audio';
  else if (document && meta.is_animation) meta.media_type = 'animation';
  else if (document && meta.is_sticker) meta.media_type = 'sticker';
  else if (photo) meta.media_type = 'photo';

  return meta;
}

function getPeerId(peer) {
  if (!peer) return null;
  const type = entityType(peer);
  if (/PeerChannel/i.test(type)) return { type: 'channel', id: asString(peer.channelId) };
  if (/PeerChat/i.test(type)) return { type: 'chat', id: asString(peer.chatId) };
  if (/PeerUser/i.test(type)) return { type: 'user', id: asString(peer.userId) };
  return { type, id: null };
}

function getForwardInfo(forward) {
  if (!forward) return null;
  return {
    date: forward.date != null ? safeIsoDate(forward.date) : null,
    from_name: asString(forward.fromName) || null,
    from_id: getPeerId(forward.fromId),
    channel_post: forward.channelPost != null ? Number(forward.channelPost) : null,
    post_author: asString(forward.postAuthor) || null,
  };
}

function getReplyInfo(reply) {
  if (!reply) return null;
  return {
    message_id: reply.replyToMsgId != null ? Number(reply.replyToMsgId) : null,
    top_message_id: reply.replyToTopId != null ? Number(reply.replyToTopId) : null,
    peer: getPeerId(reply.replyToPeerId),
  };
}

function detectPromotion(text, buttons, links) {
  const buttonText = (buttons || []).map(button => button.text || '').join('\n');
  const combined = [text || '', buttonText].join('\n');
  const matched = PROMOTION_PATTERNS.filter(pattern => pattern.re.test(combined)).map(pattern => pattern.key);
  const hasTelegramChannelLink = (links || []).some(link => TELEGRAM_HOST_RE.test(link.host || ''));
  const hasPromoButton = (buttons || []).some(button => /^(join|subscribe|follow)(?:\s|$)|join\s+(?:channel|group)|subscribe\s+(?:now|here)/i.test(button.text || ''));
  if (hasPromoButton) matched.push('promotion_button');
  if (hasTelegramChannelLink && matched.length) matched.push('telegram_invite_link');
  return { detected: matched.length > 0, matched_terms: Array.from(new Set(matched)) };
}

function classifyMessage(record) {
  const text = [record.raw_text || '', (record.buttons || []).map(button => button.text || '').join('\n')].join('\n');
  const links = record.links || [];
  const media = record.media;
  const promotion = detectPromotion(record.raw_text || '', record.buttons || [], links);
  const fileMedia = !!(media && ['document', 'video', 'audio', 'voice', 'animation'].includes(media.media_type));
  const knownDownloadHost = links.some(link => DOWNLOAD_HOSTS.has(link.host_class));
  const shortlinkWithDownloadLabel = links.some(link => link.host_class === 'Shortlink' &&
    (DOWNLOAD_CTA_RE.test((link.labels || []).join(' ')) || MEDIA_TECH_RE.test((link.labels || []).join(' '))));
  const downloadButton = (record.buttons || []).some(button => DOWNLOAD_CTA_RE.test(button.text || '') || MEDIA_TECH_RE.test(button.text || ''));
  const filenameEvidence = FILE_NAME_RE.test(text) || !!(media && media.file_name);
  const technicalEvidence = MEDIA_TECH_RE.test(text);
  const downloadCta = DOWNLOAD_CTA_RE.test(text);
  const hasDownloadEvidence = fileMedia || knownDownloadHost || shortlinkWithDownloadLabel || downloadButton || filenameEvidence || technicalEvidence || downloadCta;
  const isDownload = hasDownloadEvidence;
  const isPromotion = promotion.detected;
  const needsReview = !isDownload && !isPromotion && links.length > 0;
  let type = 'other';
  if (isDownload && isPromotion) type = 'mixed';
  else if (isDownload) type = 'download';
  else if (isPromotion) type = 'promotion';
  else if (needsReview) type = 'review';

  links.forEach(link => {
    const promoLabel = link.labels.some(label => /join|subscribe|follow|channel|group|backup/i.test(label));
    if (link.host_class === 'Ignore' && (promotion.detected || promoLabel)) link.purpose = 'promotion';
    else if (promoLabel) link.purpose = 'promotion';
    else if (DOWNLOAD_CTA_RE.test(link.labels.join(' ')) || (isDownload && link.host_class !== 'Ignore')) link.purpose = 'download';
    else if (promotion.detected && (TELEGRAM_HOST_RE.test(link.host || '') || !isDownload)) link.purpose = 'promotion';
    else if (needsReview) link.purpose = 'review';
  });

  return {
    type,
    is_download: isDownload,
    is_promotion: isPromotion,
    is_shortlink: links.some(link => link.is_shortlink),
    needs_review: needsReview,
    promotion,
    evidence: {
      file_media: fileMedia,
      known_download_host: knownDownloadHost,
      shortlink_with_download_label: shortlinkWithDownloadLabel,
      download_button: downloadButton,
      filename: filenameEvidence,
      technical_metadata: technicalEvidence,
      download_call_to_action: downloadCta,
    },
  };
}

function extractContentMetadata(text, links, media, classification, messageId) {
  if (!classification || !classification.is_download) return null;
  let parsed = null;
  try { parsed = parseMessageBlock(text || '', messageId); } catch (_) {}
  const filename = media && media.file_name ? media.file_name : '';
  let manual = null;
  const fallbackInput = filename || ((MEDIA_TECH_RE.test(text || '') || FILE_NAME_RE.test(text || '')) ? String(text).split('\n')[0] : '');
  if (fallbackInput) {
    try { manual = parseManualInput(fallbackInput); } catch (_) {}
  }

  const downloads = parsed && Array.isArray(parsed.downloads) ? parsed.downloads : [];
  const languages = parsed && Array.isArray(parsed.languages) && parsed.languages.length
    ? parsed.languages
    : (manual && manual.language ? [manual.language] : []);
  const metadata = {
    title: (parsed && parsed.title) || (manual && manual.title) || null,
    raw_title: (parsed && parsed.rawTitle) || (manual && manual.raw) || null,
    year: (parsed && parsed.year) || (manual && manual.year) || null,
    language: (parsed && parsed.language) || (manual && manual.language) || '',
    languages,
    quality: parsed && parsed.quality && parsed.quality !== 'HD'
      ? parsed.quality
      : (manual && manual.quality && manual.quality !== 'HD' ? manual.quality : null),
    content_type: (parsed && parsed.contentType) || (manual && manual.type) || null,
    is_series: parsed ? !!parsed.isSeries : !!(manual && manual.type === 'series'),
    season: parsed && parsed.season != null ? parsed.season : (manual ? manual.season : null),
    episode: parsed && parsed.episode != null ? parsed.episode : (manual ? manual.episode : null),
    imdb_id: (parsed && parsed.imdbId) || null,
    tmdb_id_hint: (parsed && parsed.tmdbIdHint) || null,
    downloads,
    file: {
      filename: filename || (manual && manual.raw) || null,
      codec: (manual && manual.codec) || null,
      container: (manual && manual.container) || null,
      hdr: (manual && manual.hdr) || null,
      audio: (manual && manual.audio) || null,
      size: (manual && manual.size) || null,
    },
  };
  const hasMetadata = metadata.title || metadata.year || metadata.language || metadata.quality ||
    metadata.season != null || metadata.episode != null || metadata.downloads.length ||
    metadata.file.filename;
  return hasMetadata ? metadata : null;
}

function safeIsoDate(value) {
  if (value == null) return null;
  const date = value instanceof Date ? value : new Date(Number(value) * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function buildTelegramMessageRecord(msg, context) {
  context = context || {};
  const rawText = asString(msg && msg.message) || asString(msg && msg.caption);
  const buttons = getButtons(msg && msg.replyMarkup);
  const entities = getEntities(rawText, msg && msg.entities);
  const links = extractLinks(rawText, msg && msg.entities, buttons);
  const media = getMediaMetadata(msg && msg.media);
  const uniqueUrls = links.map(link => link.url);
  const legacyText = rawText + (uniqueUrls.length ? '\n' + uniqueUrls.filter(url => !rawText.includes(url)).join('\n') : '');
  const record = {
    id: msg && msg.id != null ? Number(msg.id) : null,
    type: 'message',
    channel_id: context.channelId != null ? Number(context.channelId) : null,
    channel_name: context.channelName || null,
    date: safeIsoDate(msg && msg.date),
    text: legacyText.trim(),
    raw_text: rawText,
    caption: media ? rawText : null,
    entities,
    links,
    buttons,
    media,
    grouped_media_id: msg && msg.groupedId != null ? asString(msg.groupedId) : null,
    forwarded: getForwardInfo(msg && msg.fwdFrom),
    reply_to: getReplyInfo(msg && msg.replyTo),
    sender: getPeerId(msg && msg.fromId),
    views: msg && msg.views != null ? Number(msg.views) : null,
    forwards: msg && msg.forwards != null ? Number(msg.forwards) : null,
    post_author: asString(msg && msg.postAuthor) || null,
    edited_at: msg && msg.editDate != null ? safeIsoDate(msg.editDate) : null,
    account: String(context.account || '1'),
  };
  record.classification = classifyMessage(record);
  record.content_metadata = extractContentMetadata(legacyText, links, media, record.classification, record.id);
  return record;
}

function createExportArtifacts(messages, options) {
  options = options || {};
  const account = String(options.account || '1');
  const modeLabel = options.modeLabel || 'full';
  const exportedAt = options.exportedAt || new Date().toISOString();
  const scanStats = options.scanStats || {};
  const sourceMessages = Array.isArray(messages) ? messages : [];
  const promotions = sourceMessages.filter(message => message.classification && message.classification.is_promotion);
  const shortlinks = [];
  const review = [];
  let downloads = 0;
  let mixed = 0;
  let other = 0;
  let mediaCount = 0;
  const seenShortlinks = new Set();

  sourceMessages.forEach(message => {
    const classification = message.classification || {};
    if (classification.is_download) downloads++;
    if (classification.is_download && classification.is_promotion) mixed++;
    if (!classification.is_download && !classification.is_promotion && !classification.needs_review) other++;
    if (message.media) mediaCount++;
    if (classification.needs_review) review.push(message);
    (message.links || []).forEach(link => {
      if (!link.is_shortlink) return;
      const key = String(message.channel_id) + ':' + String(message.id) + ':' + link.url;
      if (seenShortlinks.has(key)) return;
      seenShortlinks.add(key);
      shortlinks.push({
        channel_id: message.channel_id,
        channel_name: message.channel_name,
        message_id: message.id,
        date: message.date,
        account: message.account || account,
        url: link.url,
        host: link.host,
        host_class: link.host_class,
        sources: link.sources,
        labels: link.labels,
        purpose: link.purpose,
      });
    });
  });

  const main = {
    exported_at: exportedAt,
    scrape_mode: modeLabel,
    account,
    total_messages_collected: sourceMessages.length,
    messages: sourceMessages,
  };
  const shortlinkExport = {
    exported_at: exportedAt,
    account,
    total_shortlinks: shortlinks.length,
    note: 'Original shortlinks only. No redirect resolution or bypass is performed.',
    links: shortlinks,
  };
  const reviewExport = {
    exported_at: exportedAt,
    account,
    total_review_messages: review.length,
    messages: review,
  };
  const report = {
    exported_at: exportedAt,
    account,
    scrape_mode: modeLabel,
    scanned_messages: Number(scanStats.scanned || sourceMessages.length),
    captured_messages: sourceMessages.length,
    skipped_messages: Number(scanStats.skipped || 0),
    skipped_reasons: Array.isArray(scanStats.skippedReasons) ? scanStats.skippedReasons : [],
    downloads,
    promotions: promotions.length,
    mixed_download_and_promotion: mixed,
    review: review.length,
    other,
    media_attachments: mediaCount,
    extracted_links: sourceMessages.reduce((sum, message) => sum + ((message.links || []).length), 0),
    shortlinks: shortlinks.length,
    channel_errors: Array.isArray(scanStats.channelErrors) ? scanStats.channelErrors : [],
    classification_note: 'Every Telegram message with a usable message ID is retained; classification never filters it out.',
  };

  return { main, shortlinks: shortlinkExport, review: reviewExport, report };
}

module.exports = {
  buildTelegramMessageRecord,
  getButtons,
  getEntities,
  extractLinks,
  getMediaMetadata,
  detectPromotion,
  classifyMessage,
  extractContentMetadata,
  createExportArtifacts,
};
