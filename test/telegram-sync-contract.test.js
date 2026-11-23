'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const routes = fs.readFileSync(path.join(root, 'routes/scrape.js'), 'utf8');
const dashboard = fs.readFileSync(path.join(root, 'public/admin/dashboard.html'), 'utf8');
const uploader = fs.readFileSync(path.join(root, 'scripts/telegram-sync-upload.js'), 'utf8');

test('Termux Telegram sync exposes authenticated staged upload endpoints', () => {
  assert.match(routes, /router\.post\('\/telegram-sync\/start', auth,/);
  assert.match(routes, /router\.post\('\/telegram-sync\/chunk', auth,/);
  assert.match(routes, /router\.post\('\/telegram-sync\/finalize', auth,/);
  assert.match(routes, /router\.get\('\/telegram-sync\/status'/);
});

test('Telegram sync stages and verifies account-tagged records before atomic swap', () => {
  const start = routes.indexOf('// ── Termux Telegram sync:');
  const end = routes.indexOf("// ── POST /api/scrape/save-extracted", start);
  assert.ok(start >= 0 && end > start, 'sync route block exists');
  const block = routes.slice(start, end);
  assert.match(block, /createIndex\(\{ url: 1 \}, \{ unique: true \}\)/);
  assert.match(block, /sourceAccount: String\(item\.sourceAccount\)/);
  assert.match(block, /total !== expected\.total \|\| a1 !== expected\.account1 \|\| a2 !== expected\.account2/);
  assert.match(block, /renameCollection:/);
  assert.match(block, /dropTarget: true/);
  assert.doesNotMatch(block, /deleteMany\s*\(/, 'staging sync must not delete live records directly');
});

test('Admin dashboard shows MongoDB link status without the removed Termux sync monitor', () => {
  assert.match(dashboard, /MongoDB Link Status/);
  assert.match(dashboard, /id="syncStatusRow"/);
  assert.doesNotMatch(dashboard, /telegramSyncMonitor|telegramSyncLabel|telegramSyncPercent|telegramSyncBar|telegramSyncCounts/);
  assert.doesNotMatch(dashboard, /loadTelegramSyncStatus|copyTelegramSyncToken|telegram-sync\/status/);
  assert.doesNotMatch(dashboard, /Waiting for Termux sync|Copy Termux Token|Live status refreshes every 3 seconds/);
});

test('Termux uploader enforces expected export counts and uses small retryable chunks', () => {
  assert.match(uploader, /account1: 37455, account2: 32216, total: 69671/);
  assert.match(uploader, /CHUNK_SIZE = 300/);
  assert.match(uploader, /telegram-sync\/start/);
  assert.match(uploader, /telegram-sync\/chunk/);
  assert.match(uploader, /telegram-sync\/finalize/);
  assert.match(uploader, /Rerun this script to resume safely/);
  assert.doesNotMatch(uploader, /MONGODB_URI|mongoose\.connect/);
});
