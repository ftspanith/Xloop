'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  buildTelegramMessageRecord,
  enrichRelatedMessageMetadata,
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

test('recognizes direct file-path URLs as download evidence', () => {
  const record = buildTelegramMessageRecord({
    id: 112,
    date: 1795305600,
    message: 'https://files.example.org/file/abcd1234',
  }, baseContext());

  assert.equal(record.classification.is_download, true);
  assert.equal(record.classification.type, 'download');
  assert.equal(record.links[0].host_class, 'Direct');
  assert.equal(record.links[0].purpose, 'download');
});

test('does not promote unrelated unknown URLs to download links just because the message has download metadata', () => {
  const record = buildTelegramMessageRecord({
    id: 154,
    date: 1795305600,
    message: 'Example Film (2026) 1080p WEB-DL\\nhttps://unknown.example/redirect?id=abc',
  }, baseContext());

  assert.equal(record.classification.is_download, true);
  assert.equal(record.classification.needs_review, true);
  assert.equal(record.links[0].purpose, 'review');
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

test('captures Telegram webpage preview URL and metadata without treating preview as a file attachment', () => {
  const record = buildTelegramMessageRecord({
    id: 109,
    date: 1795305600,
    message: 'Open this article',
    media: {
      className: 'MessageMediaWebPage',
      webpage: {
        url: 'https://example.org/movie-page',
        displayUrl: 'example.org/movie-page',
        siteName: 'Example',
        title: 'Example Movie',
        description: 'Movie details and synopsis',
        author: 'Editorial',
        type: 'article',
        embedUrl: 'https://player.example.org/embed/123',
        duration: 120,
      },
    },
  }, baseContext());

  assert.equal(record.media.media_type, 'webpage');
  assert.equal(record.media.is_webpage_preview, true);
  assert.equal(record.media.webpage.title, 'Example Movie');
  assert.equal(record.media.webpage.site_name, 'Example');
  assert.equal(record.media.webpage.duration, 120);
  assert.ok(record.links.some(link => link.url === 'https://example.org/movie-page' && link.sources.includes('webpage_preview')));
  assert.equal(record.classification.evidence.file_media, false);
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

test('detects social, website and Telugu channel promotion language', () => {
  const cases = [
    'Follow us on Instagram for updates',
    'Visit our official website for more information',
    'మా టెలిగ్రామ్ ఛానల్‌లో జాయిన్ అవ్వండి',
    'Subscribe cheyandi for daily updates',
  ];

  for (let index = 0; index < cases.length; index++) {
    const record = buildTelegramMessageRecord({
      id: 130 + index,
      date: 1795305600,
      message: cases[index],
    }, baseContext());
    assert.equal(record.classification.is_promotion, true, cases[index]);
    assert.equal(record.classification.is_download, false, cases[index]);
    assert.equal(record.classification.type, 'promotion', cases[index]);
  }
});

test('download plus channel promotion is classified as mixed, never discarded', () => {
  const record = buildTelegramMessageRecord({
    id: 13,
    date: 1795305600,
    message: 'Example Film (2026) 1080p WEB-DL [1.4GB]\nhttps://gdflix.dev/file/film-123\nhttps://unknown.example/possible-mirror\nJoin our Telegram channel',
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
  assert.ok(record.links.some(link => link.url.includes('unknown.example') && link.purpose === 'review'));
  assert.equal(record.classification.needs_review, true);
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

test('related album metadata fills missing descriptive fields but keeps per-file quality', () => {
  const messages = [
    {
      id: 201,
      channel_id: 999,
      grouped_media_id: 'album-77',
      content_metadata: {
        title: 'Example Movie',
        raw_title: 'Example.Movie.2026',
        year: 2026,
        language: 'Telugu',
        languages: ['Telugu', 'Hindi'],
        quality: '1080p',
        content_type: 'movie',
        is_series: false,
        season: null,
        episode: null,
        imdb_id: 'tt1234567',
        tmdb_id_hint: null,
        downloads: [],
        file: { filename: 'Example.Movie.1080p.mkv' },
      },
    },
    {
      id: 202,
      channel_id: 999,
      grouped_media_id: 'album-77',
      content_metadata: {
        title: null,
        raw_title: null,
        year: null,
        language: '',
        languages: [],
        quality: '720p',
        content_type: null,
        is_series: false,
        season: null,
        episode: null,
        imdb_id: null,
        tmdb_id_hint: null,
        downloads: [],
        file: { filename: 'Example.Movie.720p.mkv' },
      },
    },
  ];

  const count = enrichRelatedMessageMetadata(messages);
  assert.equal(count, 1);
  assert.equal(messages[1].content_metadata.title, 'Example Movie');
  assert.equal(messages[1].content_metadata.year, 2026);
  assert.deepEqual(messages[1].content_metadata.languages, ['Telugu', 'Hindi']);
  assert.equal(messages[1].content_metadata.quality, '720p');
  assert.equal(messages[1].content_metadata.file.filename, 'Example.Movie.720p.mkv');
  assert.deepEqual(messages[1].content_metadata.related_sources, [{
    channel_id: 999,
    message_id: 201,
    relation: 'album',
  }]);
});

test('derives descriptive metadata from a linked parent post even when it has no download URL', () => {
  const parent = {
    id: 310,
    channel_id: 1001,
    raw_text: 'Example Movie (2026) 1080p WEB-DL',
    classification: { is_download: false, is_promotion: false },
  };
  const child = {
    id: 311,
    channel_id: 999,
    reply_to: { message_id: 310, peer: { type: 'channel', id: '1001' } },
    content_metadata: {
      title: null,
      raw_title: null,
      year: null,
      language: '',
      languages: [],
      quality: '720p',
      is_series: null,
    },
  };

  const count = enrichRelatedMessageMetadata([parent, child]);
  assert.equal(count, 1);
  assert.equal(child.content_metadata.title, 'Example Movie');
  assert.equal(child.content_metadata.year, 2026);
  assert.equal(child.content_metadata.quality, '720p');
  assert.equal(child.content_metadata.related_sources[0].channel_id, 1001);
  assert.equal(child.content_metadata.related_sources[0].message_id, 310);
});

test('related reply metadata is isolated to the same Telegram channel', () => {
  const parent = {
    id: 301, channel_id: 999,
    content_metadata: { title: 'Reply Parent', year: 2025, language: 'Telugu' },
  };
  const child = {
    id: 302, channel_id: 999,
    reply_to: { message_id: 301 },
    content_metadata: { title: null, year: null, language: '' },
  };
  const unrelated = {
    id: 303, channel_id: 1000,
    reply_to: { message_id: 301 },
    content_metadata: { title: null, year: null, language: '' },
  };

  const count = enrichRelatedMessageMetadata([parent, child, unrelated]);
  assert.equal(count, 1);
  assert.equal(child.content_metadata.title, 'Reply Parent');
  assert.equal(unrelated.content_metadata.title, null);
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

test('standalone Join button is detected as a promotion even with an external invite URL', () => {
  const record = buildTelegramMessageRecord({
    id: 152,
    date: 1795305600,
    message: '',
    replyMarkup: {
      rows: [{ buttons: [
        { className: 'KeyboardButtonUrl', text: 'Join', url: 'https://bit.ly/xloop-invite' },
      ] }],
    },
  }, baseContext());

  assert.equal(record.classification.type, 'promotion');
  assert.equal(record.classification.is_promotion, true);
  assert.equal(record.classification.is_download, false);
  assert.equal(record.links[0].purpose, 'promotion');
});

test('ambiguous shortlink beside a promotion is not treated as a download and is queued for review', () => {
  const record = buildTelegramMessageRecord({
    id: 153,
    date: 1795305600,
    message: 'Join our Telegram channel for updates\nhttps://bit.ly/possibly-a-download',
  }, baseContext());

  assert.equal(record.classification.type, 'promotion');
  assert.equal(record.classification.is_download, false);
  assert.equal(record.classification.is_promotion, true);
  assert.equal(record.classification.needs_review, true);
  assert.equal(record.links[0].purpose, 'review');

  const artifacts = createExportArtifacts([record], { account: 1, modeLabel: 'full' });
  assert.equal(artifacts.main.messages.length, 1);
  assert.equal(artifacts.shortlinks.total_shortlinks, 1);
  assert.equal(artifacts.review.total_review_messages, 1);
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


test('review sidecar is a compact index and leaves the complete main message untouched', () => {
  const record = buildTelegramMessageRecord({
    id: 1901,
    date: 1795305600,
    message: 'Read more: https://example.org/article',
    media: {
      photo: {
        id: 998877,
        sizes: [
          { w: 90, h: 90, size: 1200, type: 's' },
          { w: 1280, h: 720, size: 45678, type: 'x' },
        ],
      },
    },
  }, baseContext());

  const artifacts = createExportArtifacts([record], { account: 1, modeLabel: 'full' });
  const compactReview = artifacts.review.messages[0];

  assert.equal(artifacts.main.messages.length, 1);
  assert.deepEqual(artifacts.main.messages[0], record);
  assert.equal(artifacts.review.schema_version, 2);
  assert.equal(compactReview.id, record.id);
  assert.equal(compactReview.channel_id, record.channel_id);
  assert.equal(compactReview.text, record.text);
  assert.ok(compactReview.review_reasons.includes('classification_needs_review'));
  assert.ok(compactReview.links.some(link => link.url === 'https://example.org/article'));
  assert.ok(!Object.prototype.hasOwnProperty.call(compactReview, 'entities'));
  assert.ok(!Object.prototype.hasOwnProperty.call(compactReview, 'media'));
  assert.ok(!Object.prototype.hasOwnProperty.call(compactReview, 'content_metadata'));
  assert.ok(!Object.prototype.hasOwnProperty.call(compactReview, 'buttons'));
  assert.ok(!Object.prototype.hasOwnProperty.call(compactReview, 'raw_text'));
});

test('photo media export contains dimensions and thumbnail descriptors, not image bytes', () => {
  const record = buildTelegramMessageRecord({
    id: 1902,
    date: 1795305600,
    message: 'Photo attachment',
    media: {
      photo: {
        id: 112233,
        sizes: [
          { w: 100, h: 100, size: 2048, type: 's' },
          { w: 800, h: 600, size: 32768, type: 'x' },
        ],
      },
    },
  }, baseContext());

  assert.equal(record.media.media_type, 'photo');
  assert.equal(record.media.width, 800);
  assert.equal(record.media.height, 600);
  assert.deepEqual(record.media.thumbnails, [
    { width: 100, height: 100, size: '2048', type: 's' },
    { width: 800, height: 600, size: '32768', type: 'x' },
  ]);
  const serializedMedia = JSON.stringify(record.media);
  assert.doesNotMatch(serializedMedia, /base64|image_data|file_content|data:image/i);
  assert.equal(Object.prototype.hasOwnProperty.call(record.media, 'bytes'), false);
});
