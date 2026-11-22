'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTelegramMessageRecord,
  createExportArtifacts,
} = require('../utils/telegram-intelligence');

function baseContext() {
  return { channelId: 123456, channelName: 'Xloop test channel', account: 1 };
}

test('extracts visible, hidden entity and inline-button URLs with labels and positions', () => {
  const record = buildTelegramMessageRecord({
    id: 10,
    date: 1795305600,
    message: 'Download now',
    entities: [{
      className: 'MessageEntityTextUrl',
      offset: 0,
      length: 12,
      url: 'https://gdflix.dev/file/hidden-123',
    }],
    replyMarkup: {
      rows: [
        { buttons: [
          { className: 'KeyboardButtonUrl', text: '1080p Mirror', url: 'https://hubcloud.one/file/abc123' },
          { className: 'KeyboardButtonUrl', text: 'Backup Link', url: 'https://bit.ly/xloop-test' },
        ] },
      ],
    },
  }, baseContext());

  assert.equal(record.entities[0].text, 'Download now');
  assert.equal(record.links.length, 3);
  assert.ok(record.links.some(link => link.url === 'https://gdflix.dev/file/hidden-123' && link.sources.includes('message_entity')));
  assert.ok(record.links.some(link => link.url === 'https://hubcloud.one/file/abc123' && link.labels.includes('1080p Mirror')));
  const buttonLink = record.links.find(link => link.url === 'https://bit.ly/xloop-test');
  assert.equal(buttonLink.is_shortlink, true);
  assert.deepEqual(buttonLink.button_positions, [{ row: 0, column: 1 }]);
  assert.match(record.text, /https:\/\/bit\.ly\/xloop-test/);
  assert.equal(record.classification.is_download, true);
});

test('extracts Telegram auto-detected URL entities without a protocol in visible text', () => {
  const visible = 'gdflix.dev/file/visible123';
  const record = buildTelegramMessageRecord({
    id: 111,
    date: 1795305600,
    message: visible,
    entities: [{
      className: 'MessageEntityUrl',
      offset: 0,
      length: visible.length,
    }],
  }, baseContext());

  assert.equal(record.links.length, 1);
  assert.equal(record.links[0].url, 'https://' + visible);
  assert.ok(record.links[0].sources.includes('message_entity'));
  assert.equal(record.classification.is_download, true);
});

test('captures ordinary visible URLs even when no Telegram entity or button exists', () => {
  const record = buildTelegramMessageRecord({
    id: 11,
    date: 1795305600,
    message: 'Movie 2026 1080p\nhttps://example.net/a-file.mkv',
  }, baseContext());

  assert.equal(record.links.length, 1);
  assert.equal(record.links[0].sources[0], 'message_text');
  assert.equal(record.classification.is_download, true);
});

test('promotion-only Join/Subscribe post is retained and classified as promotion', () => {
  const record = buildTelegramMessageRecord({
    id: 12,
    date: 1795305600,
    message: 'JOIN OUR TELEGRAM CHANNEL for daily updates',
    replyMarkup: {
      rows: [{ buttons: [
        { className: 'KeyboardButtonUrl', text: 'Join', url: 'https://t.me/xloop_backup' },
        { className: 'KeyboardButtonUrl', text: 'Subscribe', url: 'https://t.me/xloop_updates' },
      ] }],
    },
  }, baseContext());

  assert.equal(record.raw_text, 'JOIN OUR TELEGRAM CHANNEL for daily updates');
  assert.equal(record.classification.type, 'promotion');
  assert.equal(record.classification.is_promotion, true);
  assert.equal(record.classification.is_download, false);
  assert.equal(record.links.length, 2);
  assert.ok(record.links.every(link => link.purpose === 'promotion'));
});

test('download plus channel promotion is classified as mixed, never discarded', () => {
  const record = buildTelegramMessageRecord({
    id: 13,
    date: 1795305600,
    message: 'Example Film (2026) 1080p WEB-DL [1.4GB]\nhttps://gdflix.dev/file/film-123\nJoin our Telegram channel',
    replyMarkup: {
      rows: [{ buttons: [
        { className: 'KeyboardButtonUrl', text: 'Join Channel', url: 'https://t.me/xloop_backup' },
      ] }],
    },
  }, baseContext());

  assert.equal(record.classification.type, 'mixed');
  assert.equal(record.classification.is_download, true);
  assert.equal(record.classification.is_promotion, true);
  assert.ok(record.links.some(link => link.purpose === 'download'));
  assert.ok(record.links.some(link => link.purpose === 'promotion'));
});

test('extracts Telegram document and video/audio metadata without BigInt JSON failures', () => {
  const record = buildTelegramMessageRecord({
    id: 14,
    date: 1795305600,
    groupedId: 998877665544n,
    message: 'Example Film 1080p',
    media: {
      document: {
        id: 887766554433n,
        size: 123456789n,
        mimeType: 'video/x-matroska',
        attributes: [
          { className: 'DocumentAttributeFilename', fileName: 'Example.Film.2026.1080p.WEB-DL.x265.mkv' },
          { className: 'DocumentAttributeVideo', duration: 7200, w: 1920, h: 1080 },
        ],
      },
    },
    fwdFrom: {
      date: 1795219200,
      fromName: 'Original uploader',
      fromId: { className: 'PeerChannel', channelId: 54321n },
      channelPost: 88,
    },
    replyTo: {
      replyToMsgId: 7,
      replyToPeerId: { className: 'PeerChannel', channelId: 54321n },
    },
  }, baseContext());

  assert.equal(record.media.media_type, 'video');
  assert.equal(record.media.file_name, 'Example.Film.2026.1080p.WEB-DL.x265.mkv');
  assert.equal(record.media.file_size, '123456789');
  assert.equal(record.media.width, 1920);
  assert.equal(record.media.height, 1080);
  assert.equal(record.media.duration, 7200);
  assert.equal(record.grouped_media_id, '998877665544');
  assert.equal(record.forwarded.from_id.id, '54321');
  assert.equal(record.reply_to.message_id, 7);
  assert.equal(record.classification.is_download, true);
  assert.ok(record.content_metadata);
  assert.equal(record.content_metadata.file.filename, 'Example.Film.2026.1080p.WEB-DL.x265.mkv');
  assert.doesNotThrow(() => JSON.stringify(record));
});

test('shortlinks are preserved verbatim and never resolved or bypassed', () => {
  const original = 'https://bit.ly/xloop-original-id';
  const record = buildTelegramMessageRecord({
    id: 15,
    date: 1795305600,
    message: 'Open this link: ' + original,
  }, baseContext());

  assert.equal(record.links[0].url, original);
  assert.equal(record.links[0].host_class, 'Shortlink');
  assert.equal(record.links[0].is_shortlink, true);
  assert.equal(record.links[0].purpose, 'review');
});

test('Join CTA with a shortener gate stays promotion-only, not a download', () => {
  const record = buildTelegramMessageRecord({
    id: 151,
    date: 1795305600,
    message: 'Join our Telegram channel for updates',
    replyMarkup: {
      rows: [{ buttons: [
        { className: 'KeyboardButtonUrl', text: 'Join', url: 'https://bit.ly/channel-invite' },
      ] }],
    },
  }, baseContext());

  assert.equal(record.classification.type, 'promotion');
  assert.equal(record.classification.is_download, false);
  assert.equal(record.links[0].is_shortlink, true);
  assert.equal(record.links[0].purpose, 'promotion');
});

test('ambiguous non-classified links enter review without disappearing from main export', () => {
  const record = buildTelegramMessageRecord({
    id: 16,
    date: 1795305600,
    message: 'Related information: https://example.org/article',
  }, baseContext());

  assert.equal(record.classification.type, 'review');
  assert.equal(record.classification.needs_review, true);
  const artifacts = createExportArtifacts([record], { account: 1, modeLabel: 'full' });
  assert.equal(artifacts.main.messages.length, 1);
  assert.equal(artifacts.review.messages.length, 1);
});

test('promotion data stays inside the main export; only shortlinks/review/report are sidecars', () => {
  const promotion = buildTelegramMessageRecord({
    id: 17, date: 1795305600, message: 'Subscribe to our channel for updates',
  }, baseContext());
  const mixed = buildTelegramMessageRecord({
    id: 18, date: 1795305600,
    message: 'Film 1080p WEB-DL https://gdflix.dev/file/abc\nJoin our channel',
  }, baseContext());

  const artifacts = createExportArtifacts([promotion, mixed], {
    account: 1,
    modeLabel: 'full',
    scanStats: { scanned: 2, captured: 2, skipped: 0, skippedReasons: [] },
  });

  assert.equal(artifacts.main.messages.length, 2);
  assert.equal(artifacts.report.promotions, 2);
  assert.equal(artifacts.report.mixed_download_and_promotion, 1);
  assert.ok(Array.isArray(artifacts.shortlinks.links));
  assert.ok(Array.isArray(artifacts.review.messages));
  assert.equal(Object.prototype.hasOwnProperty.call(artifacts, 'promotions'), false);
});
